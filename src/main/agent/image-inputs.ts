import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  MAX_IMAGE_REFERENCE_BYTES, MAX_IMAGE_REFERENCE_TOTAL_BYTES, MAX_IMAGE_REFERENCE_TOTAL_PIXELS,
  MAX_IMAGE_REQUEST_DIMENSION, validateImageReferencePaths
} from '../../shared/image-generation'
import { inspectRasterImage } from '../../shared/tool-images'
import {
  checkImageAbort, CodexImageError, inspectReferenceImage, waitForImageOperation,
  type CodexImageReference
} from './codex-image-transport'

/** Supplied by the tool's captured destination, never by model parameters. */
export interface ImageReferenceRoot {
  cwd: string
  root: string
  rootIdentity: { dev: number | bigint; ino: number | bigint }
}
export interface ImageInputFileStat {
  dev: number | bigint
  ino: number | bigint
  size: number | bigint
  mtimeNs: number | bigint
  ctimeNs: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}
export interface ImageInputFileHandle {
  stat(): Promise<ImageInputFileStat>
  read(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
/** Deliberately no mkdir, writes, path repair, or unsafe-open fallback. */
export interface ImageInputFileSystem {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<ImageInputFileStat>
  open(path: string, flags: number): Promise<ImageInputFileHandle>
}
const localFiles: ImageInputFileSystem = {
  realpath: (path) => fs.realpath(path),
  lstat: (path) => fs.lstat(path, { bigint: true }),
  open: async (path, flags) => {
    const handle = await fs.open(path, flags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (bytes, offset, length, position) => handle.read(bytes, offset, length, position),
      close: () => handle.close()
    }
  }
}

const ERRORS = {
  paths: '参考图片必须是至多 5 个安全的项目相对 PNG/JPEG 路径。',
  root: '项目真实目录映射或身份发生变化，已拒绝读取参考图片。',
  directory: '参考图片父目录包含符号链接、不是普通目录或身份发生变化。',
  file: '参考图片不是普通文件、包含符号链接或身份无法确认。',
  changed: '参考图片路径或文件快照在读取期间发生变化，已拒绝使用。',
  bytes: '参考图片不能为空，每张最多 8 MiB、合计最多 16 MiB。',
  raster: '参考图片格式、完整性、尺寸或累计像素超过安全限制。',
  read: '参考图片读取结果异常、增长或截断，已拒绝使用。',
  flags: '当前平台或文件系统不支持安全的只读参考图片打开方式，已拒绝读取。',
  close: '参考图片文件句柄关闭未能确认，本进程参考图片读取已隔离，请重建后端后再试。',
  busy: '本进程仍有未结束的参考图片读取或关闭操作，已拒绝启动新读取。',
  aborted: '参考图片读取等待已中止；底层操作仍须收尾。',
  timeout: '参考图片读取等待超时；底层操作仍须收尾。',
  io: '无法安全读取参考图片，请检查项目文件和读取权限。'
} as const
export class ImageInputError extends Error {
  constructor(kind: keyof typeof ERRORS) {
    super(`${ERRORS[kind]} 尚未上传任何参考图片。`)
    this.name = 'ImageInputError'
  }
}
function safeError(error: unknown, signal: AbortSignal): ImageInputError {
  if (readerQuarantined) return new ImageInputError('close')
  if (signal.aborted) {
    try { checkImageAbort(signal) }
    catch (abort) { return new ImageInputError(abort instanceof CodexImageError && abort.kind === 'timeout' ? 'timeout' : 'aborted') }
  }
  return error instanceof ImageInputError ? error : new ImageInputError('io')
}
function readFlags(): number {
  // Missing/zero strict flags fail closed, including platforms which lack the
  // no-follow or nonblocking contract. Never retry with 'r' or weaker flags.
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isSafeInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0) throw new ImageInputError('flags')
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
}

interface Identity { dev: bigint; ino: bigint }
interface FileSnapshot extends Identity { size: number; mtimeNs: bigint; ctimeNs: bigint }
interface CapturedRoot { cwd: string; root: string; identity: Identity }
interface InputSnapshot { path: string; parents: Identity[]; file: FileSnapshot }
function integer(value: number | bigint): bigint | undefined {
  return typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined
}
function identity(value: { dev: number | bigint; ino: number | bigint }, kind: 'root' | 'directory' | 'file'): Identity {
  const dev = integer(value.dev)
  const ino = integer(value.ino)
  if (dev === undefined || ino === undefined || dev <= 0n || ino <= 0n) throw new ImageInputError(kind)
  return { dev, ino }
}
const sameIdentity = (left: Identity, right: Identity) => left.dev === right.dev && left.ino === right.ino
const samePath = (left: string, right: string) => relative(left, right) === ''
function withinRoot(root: string, path: string): boolean {
  const difference = relative(root, path)
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}
function captureRoot(value: ImageReferenceRoot): CapturedRoot {
  if (!value || typeof value.cwd !== 'string' || typeof value.root !== 'string'
    || !isAbsolute(value.cwd) || !isAbsolute(value.root) || /\x00/.test(value.cwd + value.root) || !value.rootIdentity) throw new ImageInputError('root')
  return { cwd: resolve(value.cwd), root: resolve(value.root), identity: identity(value.rootIdentity, 'root') }
}
function snapshotFile(stat: ImageInputFileStat): FileSnapshot {
  if (!stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) throw new ImageInputError('file')
  const fileIdentity = identity(stat, 'file')
  const size = integer(stat.size)
  const mtimeNs = integer(stat.mtimeNs)
  const ctimeNs = integer(stat.ctimeNs)
  if (size === undefined || size < 1n || size > BigInt(MAX_IMAGE_REFERENCE_BYTES)) throw new ImageInputError('bytes')
  if (mtimeNs === undefined || ctimeNs === undefined) throw new ImageInputError('file')
  return { ...fileIdentity, size: Number(size), mtimeNs, ctimeNs }
}
function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}
function assertFile(stat: ImageInputFileStat, expected?: FileSnapshot): FileSnapshot {
  const snapshot = snapshotFile(stat)
  if (expected && !sameFile(snapshot, expected)) throw new ImageInputError('changed')
  return snapshot
}
async function inspectDirectory(
  files: ImageInputFileSystem, path: string, signal: AbortSignal,
  kind: 'root' | 'directory', expected?: Identity
): Promise<Identity> {
  const snapshot = (stat: ImageInputFileStat) => {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ImageInputError(kind)
    const current = identity(stat, kind)
    if (expected && !sameIdentity(current, expected)) throw new ImageInputError(kind)
    return current
  }
  checkImageAbort(signal)
  const before = snapshot(await files.lstat(path))
  checkImageAbort(signal)
  if (!samePath(resolve(await files.realpath(path)), path)) throw new ImageInputError(kind)
  checkImageAbort(signal)
  const after = snapshot(await files.lstat(path))
  checkImageAbort(signal)
  if (!sameIdentity(before, after)) throw new ImageInputError(kind)
  return before
}
async function checkRoot(files: ImageInputFileSystem, root: CapturedRoot, signal: AbortSignal): Promise<void> {
  checkImageAbort(signal)
  // A captured cwd alias is allowed only while it still maps to this worktree.
  if (!samePath(resolve(await files.realpath(root.cwd)), root.root)) throw new ImageInputError('root')
  checkImageAbort(signal)
  await inspectDirectory(files, root.root, signal, 'root', root.identity)
}
async function inspectInput(
  files: ImageInputFileSystem, root: CapturedRoot, parts: readonly string[],
  signal: AbortSignal, expected?: InputSnapshot
): Promise<InputSnapshot> {
  await checkRoot(files, root, signal)
  const parents: Identity[] = []
  let path = root.root
  for (const [index, part] of parts.slice(0, -1).entries()) {
    path = resolve(path, part)
    parents.push(await inspectDirectory(files, path, signal, 'directory', expected?.parents[index]))
  }
  path = resolve(path, parts[parts.length - 1])
  if (!withinRoot(root.root, path)) throw new ImageInputError('paths')
  checkImageAbort(signal)
  const file = assertFile(await files.lstat(path), expected?.file)
  checkImageAbort(signal)
  if (!samePath(resolve(await files.realpath(path)), path)) throw new ImageInputError('file')
  checkImageAbort(signal)
  assertFile(await files.lstat(path), file)
  checkImageAbort(signal)
  await checkRoot(files, root, signal)
  return { path, parents, file }
}

const READ_CHUNK_BYTES = 64 * 1024
const MAX_READ_OPERATIONS = 65_536
async function readSnapshot(
  files: ImageInputFileSystem, root: CapturedRoot, parts: readonly string[],
  before: InputSnapshot, flags: number, signal: AbortSignal
): Promise<Uint8Array> {
  let handle: ImageInputFileHandle | undefined
  try {
    checkImageAbort(signal)
    try { handle = await files.open(before.path, flags) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') throw new ImageInputError('flags')
      throw error
    }
    // Do NOT race open/stat/read against abort here. A late open still assigns
    // its FD before this check, so the real operation's finally always closes it.
    checkImageAbort(signal)
    const opened = assertFile(await handle.stat(), before.file)
    checkImageAbort(signal)
    await inspectInput(files, root, parts, signal, before)
    const bytes = new Uint8Array(opened.size) // One private, zero-initialized bounded snapshot.
    let position = 0
    let reads = 0
    while (position < bytes.byteLength) {
      checkImageAbort(signal)
      if (++reads > MAX_READ_OPERATIONS) throw new ImageInputError('read')
      const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - position)
      const result = await handle.read(bytes, position, length, position)
      checkImageAbort(signal)
      if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > length) throw new ImageInputError('read')
      position += result.bytesRead
    }
    // A one-byte positional EOF probe catches growth without allocating or
    // accepting an extra chunk outside either the file or aggregate budget.
    const end = await handle.read(new Uint8Array(1), 0, 1, position)
    checkImageAbort(signal)
    if (!end || end.bytesRead !== 0) throw new ImageInputError('read')
    assertFile(await handle.stat(), opened)
    checkImageAbort(signal)
    await inspectInput(files, root, parts, signal, before)
    assertFile(await handle.stat(), opened)
    checkImageAbort(signal)
    return bytes
  } finally {
    if (handle) {
      // Await even after cancellation; a pending close keeps the real slot.
      // Rejection settles the operation but cannot confirm FD closure. Latch
      // before propagating even if the consumer has already stopped waiting;
      // never retry the uncertain FD or retain it/buffers in the quarantine.
      try { await handle.close() }
      catch {
        readerQuarantined = true
        throw new ImageInputError('close')
      }
    }
  }
}

async function readOperation(
  root: CapturedRoot, paths: readonly string[], files: ImageInputFileSystem, flags: number, signal: AbortSignal
): Promise<CodexImageReference[]> {
  const images: CodexImageReference[] = []
  let totalBytes = 0
  let totalPixels = 0
  for (const path of paths) {
    checkImageAbort(signal)
    const parts = path.split('/')
    const before = await inspectInput(files, root, parts, signal)
    if (before.file.size > MAX_IMAGE_REFERENCE_TOTAL_BYTES - totalBytes) throw new ImageInputError('bytes')
    const bytes = await readSnapshot(files, root, parts, before, flags, signal)
    checkImageAbort(signal)
    totalBytes += bytes.byteLength
    const mimeType = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg'
    // Admission uses the REMAINING aggregate pixel budget BEFORE the PNG
    // helper can inflate raster/metadata. Never decode an over-budget image.
    const remainingPixels = MAX_IMAGE_REFERENCE_TOTAL_PIXELS - totalPixels
    const dimensions = remainingPixels > 0 && inspectRasterImage(bytes, mimeType, {
      maxDimension: MAX_IMAGE_REQUEST_DIMENSION, maxPixels: remainingPixels,
      allowCompressedPngMetadata: true
    })
    if (!dimensions) throw new ImageInputError('raster')
    checkImageAbort(signal)
    let checked: { width: number; height: number }
    try { checked = inspectReferenceImage(bytes, mimeType) }
    catch { throw new ImageInputError('raster') }
    if (checked.width !== dimensions.width || checked.height !== dimensions.height) throw new ImageInputError('raster')
    checkImageAbort(signal)
    totalPixels += checked.width * checked.height
    images.push(Object.freeze({ bytes, mimeType, width: checked.width, height: checked.height }))
  }
  checkImageAbort(signal)
  return images
}

/** One real operation in this process, across tool/backend replacements. No
 * queue: abort only stops the consumer waiting; late stat/open/read/close keeps
 * the slot until the underlying promise actually settles. A permanently hung
 * operation continues to block new reads, bounding retained private buffers.
 * A rejected close instead settles and releases the slot, but permanently
 * quarantines new reference reads in this process; only backend process
 * reconstruction can recover. The latch holds no handles, errors or buffers. */
let readerOperationInFlight = false
let readerQuarantined = false
export async function readImageReferences(
  root: ImageReferenceRoot, paths: readonly string[], signal: AbortSignal,
  options: { files?: ImageInputFileSystem } = {}
): Promise<CodexImageReference[]> {
  let normalized: string[]
  try { normalized = validateImageReferencePaths(paths) }
  catch { throw new ImageInputError('paths') }
  if (!normalized.length) return [] // No slot, disk access, or image operation.
  if (readerQuarantined) throw new ImageInputError('close') // Before any FS or slot acquisition.
  try {
    checkImageAbort(signal)
    if (readerOperationInFlight) throw new ImageInputError('busy')
    const captured = captureRoot(root)
    const flags = readFlags()
    const files = options.files ?? localFiles
    readerOperationInFlight = true
    const operation = readOperation(captured, normalized, files, flags, signal)
      .catch((error: unknown) => { throw safeError(error, signal) })
    const release = () => { readerOperationInFlight = false }
    void operation.then(release, release)
    return await waitForImageOperation(operation, signal)
  } catch (error) { throw safeError(error, signal) }
}

// Node path checks and no-follow final opens are defense in depth, not openat
// traversal or an OS sandbox. They cannot eliminate every concurrent directory
// replacement, prove a hard link's provenance, or replace tool read permission.
// PNG validation is bounded integrity checking; JPEG is bounded structure/EOI,
// not a claim that either format has undergone a complete image decode.
