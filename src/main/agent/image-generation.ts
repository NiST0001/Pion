import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { defineTool, resizeImage, withFileMutationQueue, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import {
  CODEX_IMAGE_MODEL_OPTIONS, CODEX_IMAGE_QUALITIES, IMAGE_GENERATION_TOOL_NAME,
  MAX_IMAGE_REFERENCES, MAX_IMAGE_REFERENCE_PATH_LENGTH, resolveCodexImageRequestModel,
  resolveCodexImageRequestQuality, resolveCodexImageRequestSize, validateImageReferencePaths,
  type GeneratedImageDetails
} from '../../shared/image-generation'
import { decodeImageBase64, inspectRasterImage, MAX_TOOL_IMAGE_BASE64_LENGTH, MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGE_DIMENSION } from '../../shared/tool-images'
import {
  checkedImageTimeout, checkImageAbort, CodexImageError, createCodexImageGenerator,
  createImageAbortScope, inspectGeneratedPng, MAX_IMAGE_PROMPT_LENGTH, validateImagePrompt,
  waitForImageOperation, type CodexImageGenerator, type CodexImageTransportOptions, type GeneratedCodexImage
} from './codex-image-transport'
import { ImageInputError, readImageReferences } from './image-inputs'

interface ImageFileStat {
  dev: number | bigint
  ino: number | bigint
  isDirectory(): boolean
  isSymbolicLink(): boolean
}
export interface ImageGenerationFileHandle {
  stat(): Promise<ImageFileStat>
  write(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}
/** Small injectable boundary for deterministic filesystem/race tests. */
export interface ImageGenerationFileSystem {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<ImageFileStat>
  mkdir(path: string, options: { mode: number }): Promise<unknown>
  open(path: string, flags: 'wx', mode: number): Promise<ImageGenerationFileHandle>
  link(existingPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}
const localFiles: ImageGenerationFileSystem = {
  realpath: (path) => fs.realpath(path),
  lstat: (path) => fs.lstat(path, { bigint: true }),
  mkdir: (path, options) => fs.mkdir(path, options),
  open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode)
    return {
      stat: () => handle.stat({ bigint: true }),
      write: (bytes, offset, length, position) => handle.write(bytes, offset, length, position),
      sync: () => handle.sync(),
      close: () => handle.close()
    }
  },
  link: (existingPath, newPath) => fs.link(existingPath, newPath),
  unlink: (path) => fs.unlink(path)
}
export interface ImageGenerationToolOptions extends CodexImageTransportOptions {
  /** Captured runtime cwd; never supplied by the model or another session. */
  cwd: string
  generate?: CodexImageGenerator
  resize?: typeof resizeImage
  files?: ImageGenerationFileSystem
  mutationQueue?: typeof withFileMutationQueue
  previewTimeoutMs?: number
  /** Execution-private reference reader, never supplied in tool parameters. */
  readReferences?: typeof readImageReferences
}
interface ImageGenerationToolDetails { imageGeneration: GeneratedImageDetails }
const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: MAX_IMAGE_PROMPT_LENGTH, description: 'Image generation or edit instruction. References must be explicit project-relative files, never inline image data or remote URLs.' }),
  path: Type.String({ minLength: 1, maxLength: 1024, description: 'Required workspace-relative .png output path, using / separators. Creates controlled parent directories; never overwrites an existing file.' }),
  model: Type.Optional(Type.Union([
    Type.Literal(CODEX_IMAGE_MODEL_OPTIONS[0].id),
    Type.Literal(CODEX_IMAGE_MODEL_OPTIONS[1].id),
    Type.Literal(CODEX_IMAGE_MODEL_OPTIONS[2].id)
  ], {
    description: 'Request ID only, not the actual model version. Defaults to the official Codex alias gpt-image-2. Select experimental 2.5 Flare/Sunburst only at the user’s request; Codex subscription compatibility and entitlement are unverified. No automatic model fallback.'
  })),
  size: Type.Optional(Type.String({ maxLength: 9, pattern: '^(?:auto|[1-9][0-9]{0,3}x[1-9][0-9]{0,3})$',
    description: 'Requested size: auto (default) or WxH using lowercase x, e.g. 2048x3072. Each side must be a multiple of 16, at most 4096; at most 16 million pixels and aspect ratio at most 3:1. Local admission is not service compatibility or an exact-output guarantee.' })),
  quality: Type.Optional(Type.Union([
    Type.Literal(CODEX_IMAGE_QUALITIES[0]), Type.Literal(CODEX_IMAGE_QUALITIES[1]),
    Type.Literal(CODEX_IMAGE_QUALITIES[2]), Type.Literal(CODEX_IMAGE_QUALITIES[3])
  ], { description: 'Requested quality: auto (default), low, medium or high. Not an actual-quality measurement; no silent fallback.' })),
  referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_IMAGE_REFERENCE_PATH_LENGTH }), {
    maxItems: MAX_IMAGE_REFERENCES,
    description: 'Optional ordered list of at most 5 explicit workspace-relative PNG/JPEG source files. Nonempty references request image editing; empty or omitted requests generation. Reads and uploads complete images including metadata; each at most 8 MiB, total 16 MiB and 16 million pixels. Do not pass base64, URLs, masks or an input path as output.'
  }))
}, { additionalProperties: false })
/** Preserve the original schema's static union before SDK return-type erasure. */
export type ImageGenerationParameters = Static<typeof parameters>

class ImageSaveError extends Error {}
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
const isExists = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
function safeFileError(error: unknown): string {
  if (error instanceof ImageSaveError) return error.message
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return '没有目标目录的写入权限。'
  if (code === 'ENOSPC' || code === 'EDQUOT') return '磁盘空间或文件系统配额不足。'
  if (code === 'EEXIST') return '目标文件已经存在，未覆盖它。'
  return '文件操作失败或已中止，请检查目标路径和目录权限。'
}
function pathParts(value: unknown): string[] {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.trim()
    || isAbsolute(value) || win32.isAbsolute(value) || /[\\\x00-\x1f\x7f:<>"|?*]/.test(value)) {
    throw new ImageSaveError('必须提供项目内的相对 PNG 路径，不能使用绝对路径、网址或特殊路径。')
  }
  const path = value.startsWith('./') ? value.slice(2) : value
  const parts = path.split('/')
  if (parts.length > 32 || parts.some((part) => !part || part === '.' || part === '..'
    || Buffer.byteLength(part, 'utf8') > 255 || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !/\.png$/i.test(parts.at(-1) ?? '')) {
    throw new ImageSaveError('目标必须是 .png 文件，路径不得穿越目录、包含不安全的文件名或超过 32 层。')
  }
  return parts
}
interface Destination { cwd: string; root: string; rootIdentity: ImageFileStat; target: string; parts: string[]; displayPath: string }
function withinRoot(root: string, path: string) {
  const difference = relative(root, path)
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

async function maybeStat(files: ImageGenerationFileSystem, path: string): Promise<ImageFileStat | undefined> {
  try { return await files.lstat(path) }
  catch (error) { if (isMissing(error)) return undefined; throw error }
}
const samePath = (left: string, right: string) => relative(left, right) === ''
async function checkRoot(files: ImageGenerationFileSystem, destination: Destination) {
  if (!samePath(resolve(await files.realpath(destination.cwd)), destination.root)
    || !samePath(resolve(await files.realpath(destination.root)), destination.root)) throw new ImageSaveError('项目真实目录发生变化，已拒绝保存。')
  const stat = await files.lstat(destination.root)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== destination.rootIdentity.dev || stat.ino !== destination.rootIdentity.ino) throw new ImageSaveError('项目目录不可用、发生替换或已变为符号链接。')
}
async function checkParent(files: ImageGenerationFileSystem, path: string, stat: ImageFileStat) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(resolve(await files.realpath(path)), path)) throw new ImageSaveError('目标父目录包含符号链接或不是普通目录。')
}

/** Inspect before generation, then repeat inside the mutation queue before wx. */
async function inspectDestination(files: ImageGenerationFileSystem, destination: Destination, signal: AbortSignal, createParents: boolean) {
  checkImageAbort(signal)
  await checkRoot(files, destination)
  checkImageAbort(signal)
  let path = destination.root
  for (const part of destination.parts.slice(0, -1)) {
    path = resolve(path, part)
    let stat = await maybeStat(files, path)
    checkImageAbort(signal)
    if (!stat && createParents) {
      // No recursive mkdir: each parent is checked separately, including an
      // EEXIST race with another writer. These directories are intentionally
      // retained on failure; recursively removing them could remove others' work.
      try { await files.mkdir(path, { mode: 0o700 }) }
      catch (error) { if (!isExists(error)) throw error }
      checkImageAbort(signal)
      stat = await files.lstat(path)
    }
    if (stat) await checkParent(files, path, stat)
    checkImageAbort(signal)
  }
  const target = await maybeStat(files, destination.target)
  checkImageAbort(signal)
  if (target) throw new ImageSaveError('目标文件已经存在（包括符号链接），未覆盖它；请在生成前选择新路径。')
}

async function prepareDestination(files: ImageGenerationFileSystem, cwd: string, value: unknown, signal: AbortSignal): Promise<Destination> {
  const parts = pathParts(value)
  checkImageAbort(signal)
  const root = resolve(await files.realpath(cwd))
  checkImageAbort(signal)
  const target = resolve(root, ...parts)
  if (!withinRoot(root, target)) throw new ImageSaveError('目标路径不在项目真实目录内。')
  const rootIdentity = await files.lstat(root)
  checkImageAbort(signal)
  const destination = { cwd, root, rootIdentity, target, parts, displayPath: parts.join('/') }
  await inspectDestination(files, destination, signal, false)
  return destination
}

/** Best-effort cleanup of a private, random staging name only. Never call this
 * on the user-selected destination: no portable check-then-unlink is atomic. */
async function removeOwnedPartial(files: ImageGenerationFileSystem, destination: Destination, identity: ImageFileStat | undefined): Promise<boolean> {
  if (!identity || identity.ino === 0 || identity.ino === 0n) return false
  try {
    await checkRoot(files, destination)
    let path = destination.root
    for (const part of destination.parts.slice(0, -1)) {
      path = resolve(path, part)
      await checkParent(files, path, await files.lstat(path))
    }
    const current = await maybeStat(files, destination.target)
    if (!current) return true
    if (current.isSymbolicLink() || current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) return false
    await files.unlink(destination.target)
    return true
  } catch { return false }
}

async function verifyOwnedDestination(files: ImageGenerationFileSystem, destination: Destination, identity: ImageFileStat) {
  await checkRoot(files, destination)
  let path = destination.root
  for (const part of destination.parts.slice(0, -1)) {
    path = resolve(path, part)
    await checkParent(files, path, await files.lstat(path))
  }
  const current = await files.lstat(destination.target)
  if (current.isSymbolicLink() || current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new ImageSaveError('保存期间目标文件被替换，未删除其他进程的文件。')
}

interface ImageSaveResult { warning?: string }
async function savePng(files: ImageGenerationFileSystem, destination: Destination, bytes: Uint8Array, signal: AbortSignal): Promise<ImageSaveResult> {
  const name = `.pion-image-${randomUUID()}.png`
  const temporary: Destination = {
    ...destination,
    target: join(dirname(destination.target), name),
    parts: [...destination.parts.slice(0, -1), name],
    displayPath: [...destination.parts.slice(0, -1), name].join('/')
  }
  let handle: ImageGenerationFileHandle | undefined
  let identity: ImageFileStat | undefined
  let closed = false
  let complete = false
  let published = false
  try {
    await inspectDestination(files, destination, signal, true)
    await inspectDestination(files, destination, signal, false)
    checkImageAbort(signal)
    // Stage in the same directory so hard-link publication is atomic and
    // no-replace on supported filesystems. Never write/delete the final name.
    handle = await files.open(temporary.target, 'wx', 0o600)
    identity = await handle.stat()
    if (identity.ino === 0 || identity.ino === 0n) throw new ImageSaveError('文件系统无法识别临时文件身份，已拒绝发布。')
    checkImageAbort(signal)
    await verifyOwnedDestination(files, temporary, identity)
    checkImageAbort(signal)
    let position = 0
    while (position < bytes.byteLength) {
      checkImageAbort(signal)
      const length = Math.min(64 * 1024, bytes.byteLength - position)
      const written = await handle.write(bytes, position, length, position)
      if (!Number.isSafeInteger(written.bytesWritten) || written.bytesWritten < 1 || written.bytesWritten > length) throw new ImageSaveError('写入图片时未能完成文件内容。')
      position += written.bytesWritten
      checkImageAbort(signal)
    }
    await handle.sync()
    checkImageAbort(signal)
    await verifyOwnedDestination(files, temporary, identity)
    await handle.close()
    closed = true
    complete = true
    checkImageAbort(signal)
    await inspectDestination(files, destination, signal, false)
    await verifyOwnedDestination(files, temporary, identity)
    checkImageAbort(signal)
    // link fails with EEXIST instead of overwriting a competing writer. Do not
    // fall back to rename/copy, which would lose atomic no-replace semantics.
    await files.link(temporary.target, destination.target)
    published = true
    // Publication is the commit point: abort during link cannot erase success.
    await verifyOwnedDestination(files, destination, identity)
    const cleaned = await removeOwnedPartial(files, temporary, identity)
    return cleaned ? {} : { warning: `私有暂存清理失败，请检查项目相对残留路径 ${temporary.displayPath}。` }
  } catch (error) {
    if (handle && !closed) {
      try { await handle.close(); closed = true } catch { /* report the original failure */ }
    }
    if (published) {
      throw new ImageSaveError(`目标文件已发布，但其位置或内容无法确认：${safeFileError(error)} 未删除最终文件；请检查 ${destination.displayPath} 与临时路径 ${temporary.displayPath}。`)
    }
    if (complete) {
      // Preserve already-generated bytes when publication fails; do not spend
      // quota again to recover a destination collision or unsupported link.
      throw new ImageSaveError(`${safeFileError(error)} 完整数据曾写入临时路径 ${temporary.displayPath}，未自动清除；请检查该恢复文件，不要重新生成。`)
    }
    const cleaned = !handle || await removeOwnedPartial(files, temporary, identity)
    throw new ImageSaveError(`${safeFileError(error)}${cleaned ? '' : ` 无法确认私有临时文件已清理，请检查 ${temporary.displayPath}。`}`)
  } finally {
    if (handle && !closed) {
      try { await handle.close() } catch { /* preserve the original save/cleanup error */ }
    }
  }
}

/** Abort queued admission promptly, but await a started file transaction so
 * cleanup/publication cannot silently continue after the tool has settled. */
function waitForSaveAdmission<T>(operation: Promise<T>, signal: AbortSignal, started: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!started()) {
        signal.removeEventListener('abort', abort)
        reject(signal.reason instanceof CodexImageError ? signal.reason : new CodexImageError('aborted', '保存等待已中止。'))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) }
    )
    if (signal.aborted) abort()
  })
}

function checkedPreview(result: Awaited<ReturnType<typeof resizeImage>>): AgentToolResult<unknown>['content'][number] | undefined {
  if (!result || (result.mimeType !== 'image/png' && result.mimeType !== 'image/jpeg')
    || typeof result.data !== 'string' || result.data.length > MAX_TOOL_IMAGE_BASE64_LENGTH) return undefined
  const bytes = decodeImageBase64(result.data, MAX_TOOL_IMAGE_BYTES)
  const dimensions = bytes && inspectRasterImage(bytes, result.mimeType)
  if (!dimensions || dimensions.width !== result.width || dimensions.height !== result.height) return undefined
  return { type: 'image', data: result.data, mimeType: result.mimeType }
}

/** Shared by all tool instances in this runtime process, including replacements.
 * Abort/timeout only stops waiting: the SDK decoder has no cancellation contract.
 * Keep the single slot until the actual resize promise settles; never queue more. */
let previewResizeInFlight = false
function tryResizePreview(resize: typeof resizeImage, bytes: Uint8Array): ReturnType<typeof resizeImage> | undefined {
  if (previewResizeInFlight) return undefined
  previewResizeInFlight = true
  const release = () => { previewResizeInFlight = false }
  try {
    const operation = resize(bytes, 'image/png', {
      maxWidth: MAX_TOOL_IMAGE_DIMENSION, maxHeight: MAX_TOOL_IMAGE_DIMENSION,
      // SDK's maxBytes limit is BASE64 ENCODED length, not raw bytes.
      maxBytes: MAX_TOOL_IMAGE_BASE64_LENGTH
    })
    // Both branches handle late settlement even after the caller stops waiting.
    // Unlike a finally on the abort race, this cannot release a hung decoder.
    void operation.then(release, release)
    return operation
  } catch (error) {
    release()
    throw error
  }
}

/** First-party compiled tool. SDK beforeToolCall gates run before execute. */
export function createImageGenerationTool(options: ImageGenerationToolOptions) {
  const cwd = resolve(options.cwd)
  const generate = options.generate ?? createCodexImageGenerator(options)
  const resize = options.resize ?? resizeImage
  const readReferences = options.readReferences ?? readImageReferences
  const files = options.files ?? localFiles
  const mutationQueue = options.mutationQueue ?? withFileMutationQueue
  const timeoutMs = checkedImageTimeout(options.timeoutMs)
  const previewTimeoutMs = Math.min(15_000, checkedImageTimeout(options.previewTimeoutMs ?? 10_000))
  let inFlight = false
  return defineTool<typeof parameters, ImageGenerationToolDetails | undefined>({
    name: IMAGE_GENERATION_TOOL_NAME,
    label: '生成图片',
    description: 'Generate or edit one static PNG using your OpenAI Codex subscription. Optional size and quality are requests, not guarantees of exact output or measured quality; both default to auto. Optional referenced_image_paths reads and uploads at most 5 explicit project-relative PNG/JPEG files including metadata and requests editing through the same subscription, not a paid API. Mask, input_fidelity and reference URLs are unsupported. Default request model gpt-image-2 is the official Codex alias, not proof of the actual version; the actual version is not reported. Optional gpt-image-2.5-flare / gpt-image-2.5-sunburst are experimental request IDs, only when the user requests 2.5; Codex subscription compatibility and entitlement are unverified. Public API model availability does not prove subscription access. Requires an explicit new project-relative .png output path; never overwrites files or edits an input in place. No API-key/paid fallback, automatic retry, model downgrade or silent settings change. Login/entitlement and image quota apply; failure or cancellation can still consume quota. Saves the complete output in the project and returns only a small preview; use read on the saved path for the output. Reference originals are not returned in history. Image charges are not estimated as chat token usage.',
    promptSnippet: 'Generate or edit one image with Codex and save a new PNG in the project',
    promptGuidelines: [
      'Call pion_generate_image only when image generation or editing is requested; provide the intended new output path before making the request.',
      'Default to gpt-image-2, the official Codex request alias, not an actual-version report. Actual model version is not reported.',
      'Only select experimental gpt-image-2.5-flare or gpt-image-2.5-sunburst when the user explicitly requests 2.5. Codex subscription compatibility and entitlement are unverified; public API availability does not prove subscription access.',
      'For a user request for 2.5 with no named variant, select gpt-image-2.5-flare. If the user names Sunburst in natural language, select gpt-image-2.5-sunburst. Never pass the generic ID gpt-image-2.5.',
      'If generation fails, is cancelled, or cannot be saved, do not automatically retry, change the request model, silently downgrade or change the path: quota may already have been consumed.',
      'Report only the requested model label and that the actual version is not reported; do not claim that an actual 2.5 engine generated the image.',
      'Size and quality default to auto. You may request explicit sizes such as 2048x3072 and quality auto/low/medium/high; these are requests, not compatibility, exact-resolution or actual-quality guarantees. Never silently lower settings after rejection.',
      'Use referenced_image_paths only when the user requests image editing or references. Inputs must be explicit project-relative PNG/JPEG paths; complete files and metadata are uploaded. Never overwrite an input; select and disclose a different new PNG output path.',
      'Mask and input_fidelity have no confirmed Codex subscription contract here and are unsupported. Do not invent these parameters, turn a mask into an ordinary reference while claiming mask support, or use an API-key/paid fallback.',
      'A saved image remains successful even without a preview. Use read on its path instead of generating it again.'
    ],
    parameters,
    executionMode: 'sequential',
    async execute(_id, params, parentSignal, onUpdate) {
      if (inFlight) throw new Error('已有图片生成正在执行，请等待完成；不要重复请求。')
      const requestedModel = resolveCodexImageRequestModel(params.model)
      const requestedSize = resolveCodexImageRequestSize(params.size)
      const requestedQuality = resolveCodexImageRequestQuality(params.quality)
      const referencePaths = validateImageReferencePaths(params.referenced_image_paths)
      const prompt = params.prompt
      validateImagePrompt(prompt)
      if (Object.keys(params).some((key) => !['prompt', 'path', 'model', 'size', 'quality', 'referenced_image_paths'].includes(key))) {
        throw new Error('不支持的图片参数；仅接受 prompt、path、model、size、quality 和 referenced_image_paths，不支持 mask、input_fidelity 或参考图片网址。')
      }
      const outputPath = pathParts(params.path).join('/')
      if (referencePaths.some((path) => process.platform === 'win32' ? path.toLowerCase() === outputPath.toLowerCase() : path === outputPath)) {
        throw new Error('输出必须是不同于所有参考输入的新 PNG 路径，不能原地编辑或覆盖输入图片。')
      }
      inFlight = true
      const scope = createImageAbortScope(parentSignal, timeoutMs)
      const signal = scope.signal
      const progress = (text: string) => {
        try { onUpdate?.({ content: [{ type: 'text', text }], details: undefined }) }
        catch { /* progress cannot change whether a file was saved */ }
      }
      try {
        checkImageAbort(signal)
        let destination: Destination
        try { destination = await waitForImageOperation(prepareDestination(files, cwd, outputPath, signal), signal) }
        catch (error) { checkImageAbort(signal); throw new Error(safeFileError(error)) }
        checkImageAbort(signal)
        let references: Awaited<ReturnType<typeof readImageReferences>> = []
        if (referencePaths.length) {
          progress('正在安全读取参考图片；完整图片及元数据将上传…')
          try {
            references = await readReferences(destination, referencePaths, signal)
            checkImageAbort(signal)
            if (references.length !== referencePaths.length) throw new Error('Reference count mismatch')
          } catch (error) {
            throw new Error(error instanceof ImageInputError ? error.message : '无法安全完成参考图片读取；尚未请求图片服务，未上传参考图片。')
          }
        }
        checkImageAbort(signal)
        progress(referencePaths.length ? '正在请求 Codex 编辑图片…' : '正在请求 Codex 生成图片…')
        let image: GeneratedCodexImage
        try { image = await waitForImageOperation(generate({
          prompt, model: requestedModel, size: requestedSize, quality: requestedQuality,
          ...(referencePaths.length ? { images: references } : {})
        }, signal), signal) }
        catch (error) {
          // The outer abort race may settle before the transport has produced
          // its own diagnostic. Never imply that cancellation means no quota.
          const message = error instanceof CodexImageError ? error.message : '图片生成失败，请检查 Codex 登录及网络状态。'
          throw new Error(`${message} 失败或中止仍可能消耗图片额度；不要自动再次生成。`)
        }
        let dimensions: { width: number; height: number }
        try { checkImageAbort(signal); dimensions = inspectGeneratedPng(image.bytes) }
        catch { throw new Error('图片服务返回的原图不可用或请求已中止，未保存文件；可能已消耗图片额度，请勿自动再次生成。') }
        progress('正在保存原图…')
        let saved: ImageSaveResult
        try {
          // Only actual file operations occupy the SDK's per-file queue, not
          // OAuth refresh, the network request, or thumbnail raster decoding.
          let started = false
          const operation = mutationQueue(destination.target, () => {
            checkImageAbort(signal)
            started = true
            return savePng(files, destination, image.bytes, signal)
          })
          saved = await waitForSaveAdmission(operation, signal, () => started)
        } catch (error) {
          throw new Error(`图片服务已完成，但原图保存未能确认到 ${destination.displayPath}：${safeFileError(error)} 可能已消耗图片额度；禁止自动重新生成或静默更换路径，请先由用户检查。`)
        }
        let preview: AgentToolResult<unknown>['content'][number] | undefined
        let previewBusy = false
        if (!signal.aborted) {
          progress('原图已保存，正在生成缩略图…')
          const previewScope = createImageAbortScope(signal, previewTimeoutMs)
          try {
            checkImageAbort(previewScope.signal)
            const operation = tryResizePreview(resize, image.bytes)
            if (operation) {
              const resized = await waitForImageOperation(operation, previewScope.signal)
              checkImageAbort(previewScope.signal)
              preview = checkedPreview(resized)
            } else previewBusy = true
          } catch { /* the complete original is already committed */ }
          finally { previewScope.dispose() }
        }
        if (signal.aborted) preview = undefined
        const details: GeneratedImageDetails = {
          version: 2, provider: 'openai-codex', requestedModel, resolvedModel: null,
          path: destination.displayPath, mimeType: 'image/png', byteLength: image.bytes.byteLength,
          ...dimensions, previewAvailable: !!preview,
          operation: referencePaths.length ? 'edit' : 'generate', requestedSize, requestedQuality,
          referenceCount: referencePaths.length
        }
        const previewStatus = preview ? '' : signal.aborted ? ' 缩略图等待已中止，但原图保留。'
          : previewBusy ? ' 缩略图不可用：本进程仍有未结束的解码任务，但原图保存成功。'
          : ' 缩略图不可用，但原图保存成功。'
        const requestLabel = CODEX_IMAGE_MODEL_OPTIONS.find(({ id }) => id === requestedModel)?.label ?? requestedModel
        const content: AgentToolResult<ImageGenerationToolDetails>['content'] = [{
          type: 'text',
          text: `原图已保存：${details.path}（PNG，${details.width} × ${details.height}，${details.byteLength} 字节）。请求型号：${requestLabel}；实际版本未报告。请求尺寸：${requestedSize}；请求质量：${requestedQuality}；${referencePaths.length ? `编辑请求，参考图 ${referencePaths.length} 张` : '文字生图请求'}。请求设置不保证服务接受或精确输出。${saved.warning ? ` ${saved.warning}` : ''}${previewStatus} 可用 read 读取原图，不要重复生成。`
        }]
        if (preview) content.push(preview)
        return { content, details: { imageGeneration: details } }
      } finally { scope.dispose(); inFlight = false }
    }
  })
}
