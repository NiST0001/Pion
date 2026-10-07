import { dirname, relative, resolve, sep } from 'node:path'
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import { resizeImage, type ExtensionToolContext, type withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { createImageGenerationTool, type ImageGenerationFileHandle, type ImageGenerationFileSystem, type ImageGenerationParameters, type ImageGenerationToolOptions } from '../../src/main/agent/image-generation'
import { MAX_IMAGE_PROMPT_LENGTH, type CodexImageGenerator } from '../../src/main/agent/codex-image-transport'
import { CODEX_IMAGE_MODEL_OPTIONS, CODEX_IMAGE_REQUEST_ALIAS, CODEX_IMAGE_QUALITIES, type CodexImageRequestModel, type CodexImageRequestQuality } from '../../src/shared/image-generation'
import { ImageInputError, readImageReferences } from '../../src/main/agent/image-inputs'
import { MAX_TOOL_IMAGE_BASE64_LENGTH, MAX_TOOL_IMAGE_BYTES } from '../../src/shared/tool-images'
import { makeStaticPng } from '../fixtures/static-png'

const png = makeStaticPng()
const image = () => ({ bytes: new Uint8Array(png), width: 1, height: 1 })
const preview = () => ({ data: png.toString('base64'), mimeType: 'image/png', width: 1, height: 1, originalWidth: 1, originalHeight: 1, wasResized: false })
const cwd = resolve('/pion-image-project')
const context = { cwd: resolve('/unrelated-project'), tools: [],
  executeTool: vi.fn(async () => { throw new Error('Unexpected tool delegation') }) } as unknown as ExtensionToolContext
const parameters = { prompt: 'A red boat', path: 'images/boat.png' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const fileError = (code: string) => Object.assign(new Error(code), { code })
interface Entry { kind: 'directory' | 'file' | 'link'; ino: number; bytes: Uint8Array; target?: string }
function fakeDisk() {
  let nextInode = 1
  const entries = new Map<string, Entry>()
  const put = (path: string, kind: Entry['kind'], bytes = new Uint8Array(), target?: string) => {
    const entry = { kind, ino: nextInode++, bytes, target }
    entries.set(resolve(cwd, path), entry)
    return entry
  }
  put(cwd, 'directory')
  const stat = (entry: Entry) => ({ dev: 1, ino: entry.ino, isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'link' })
  const handles: (ImageGenerationFileHandle & { write: ReturnType<typeof vi.fn<ImageGenerationFileHandle['write']>>; close: ReturnType<typeof vi.fn<ImageGenerationFileHandle['close']>> })[] = []
  const state: { onOpen?: (handle: typeof handles[number], node: Entry, path: string) => void } = {}
  const files = {
    realpath: vi.fn<ImageGenerationFileSystem['realpath']>(async (path) => {
      const entry = entries.get(path)
      if (!entry) throw fileError('ENOENT')
      return entry.kind === 'link' ? entry.target! : path
    }),
    lstat: vi.fn<ImageGenerationFileSystem['lstat']>(async (path) => {
      const entry = entries.get(path)
      if (!entry) throw fileError('ENOENT')
      return stat(entry)
    }),
    mkdir: vi.fn<ImageGenerationFileSystem['mkdir']>(async (path) => {
      if (entries.has(path)) throw fileError('EEXIST')
      if (entries.get(dirname(path))?.kind !== 'directory') throw fileError('ENOTDIR')
      put(path, 'directory')
    }),
    open: vi.fn<ImageGenerationFileSystem['open']>(async (path, flags) => {
      if (flags !== 'wx') throw new Error('exclusive creation required')
      if (entries.has(path)) throw fileError('EEXIST')
      if (entries.get(dirname(path))?.kind !== 'directory') throw fileError('ENOTDIR')
      const node = put(path, 'file')
      const handle = {
        stat: async () => stat(node),
        write: vi.fn<ImageGenerationFileHandle['write']>(async (bytes, offset, length, position) => {
          const next = new Uint8Array(Math.max(node.bytes.byteLength, position + length))
          next.set(node.bytes)
          next.set(bytes.subarray(offset, offset + length), position)
          node.bytes = next
          return { bytesWritten: length }
        }),
        sync: vi.fn(async () => {}),
        close: vi.fn<ImageGenerationFileHandle['close']>(async () => {})
      }
      handles.push(handle)
      state.onOpen?.(handle, node, path)
      return handle
    }),
    link: vi.fn<ImageGenerationFileSystem['link']>(async (source, target) => {
      if (entries.has(target)) throw fileError('EEXIST')
      const node = entries.get(source)
      if (!node || node.kind !== 'file') throw fileError('ENOENT')
      entries.set(target, node)
    }),
    unlink: vi.fn<ImageGenerationFileSystem['unlink']>(async (path) => {
      if (!entries.delete(path)) throw fileError('ENOENT')
    })
  }
  return { files, entries, put, handles, state }
}
function setup(overrides: Partial<ImageGenerationToolOptions> = {}) {
  const disk = fakeDisk()
  const generate = vi.fn<CodexImageGenerator>().mockResolvedValue(image())
  const resize = vi.fn<typeof resizeImage>().mockResolvedValue(preview())
  const getAuth = vi.fn<ImageGenerationToolOptions['getAuth']>().mockResolvedValue(undefined)
  const readReferences = vi.fn<typeof readImageReferences>().mockResolvedValue([])
  const queue = vi.fn<(path: string, task: () => Promise<unknown>) => void>()
  const mutationQueue: typeof withFileMutationQueue = async (path, task) => { queue(path, task); return task() }
  const tool = createImageGenerationTool({ cwd, getAuth, files: disk.files, generate, resize, mutationQueue, readReferences, ...overrides })
  const execute = (params: Parameters<typeof tool.execute>[1] = parameters, signal?: AbortSignal, update?: Parameters<typeof tool.execute>[3]) => tool.execute('image-call', params, signal, update, context)
  return { disk, tool, execute, getAuth, generate, resize, queue, readReferences }
}
/** Exercise the real transport with only synthetic OAuth and mocked fetch. */
function setupTransport(response: Response) {
  const token = ['test-header', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url'), 'test-signature'].join('.')
  const getAuth = vi.fn<ImageGenerationToolOptions['getAuth']>().mockResolvedValue({ source: 'OAuth', auth: { apiKey: token } })
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
  return { ...setup({ generate: undefined, getAuth, fetch }), getAuth, fetch }
}
afterEach(() => vi.useRealTimers())

it.each(CODEX_IMAGE_QUALITIES)('forwards size and requested quality %s without pretending output has that resolution', async (quality) => {
  const h = setup()
  const result = await h.execute({ ...parameters, size: '2048x3072', quality })
  expect(h.generate).toHaveBeenCalledExactlyOnceWith({ prompt: parameters.prompt,
    model: CODEX_IMAGE_REQUEST_ALIAS, size: '2048x3072', quality }, expect.any(AbortSignal))
  expect(result.details?.imageGeneration).toMatchObject({ requestedSize: '2048x3072', requestedQuality: quality,
    operation: 'generate', referenceCount: 0, width: 1, height: 1 })
  expect(h.readReferences).not.toHaveBeenCalled()
})

it('reads ordered project references against the captured output root and saves only a new edited PNG', async () => {
  const h = setup()
  const referenceBytes = new Uint8Array(makeStaticPng(2, 2))
  const reference = { bytes: referenceBytes, mimeType: 'image/png' as const, width: 2, height: 2 }
  h.readReferences.mockResolvedValue([reference, reference])
  const result = await h.execute({ ...parameters, path: 'images/edited.png',
    referenced_image_paths: ['./images/source.png', 'images/source-2.png'], size: '2048x3072', quality: 'high' })
  expect(h.readReferences).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, root: cwd,
    rootIdentity: expect.objectContaining({ dev: 1, ino: 1 }) }), ['images/source.png', 'images/source-2.png'], expect.any(AbortSignal))
  expect(h.generate).toHaveBeenCalledExactlyOnceWith({ prompt: parameters.prompt, model: CODEX_IMAGE_REQUEST_ALIAS,
    size: '2048x3072', quality: 'high', images: [reference, reference] }, expect.any(AbortSignal))
  expect(result.details?.imageGeneration).toMatchObject({ path: 'images/edited.png', operation: 'edit', referenceCount: 2,
    requestedSize: '2048x3072', requestedQuality: 'high', width: 1, height: 1 })
  expect(h.disk.files.link).toHaveBeenCalledWith(expect.any(String), resolve(cwd, 'images/edited.png'))
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, 'images/edited.png'))
  expect(JSON.stringify(result)).not.toContain('images/source.png')
  expect(JSON.stringify(result)).not.toContain(Buffer.from(referenceBytes).toString('base64'))
  expect(result.details?.imageGeneration).not.toHaveProperty('images')
})

it('treats an explicitly empty reference list as generation without any input read', async () => {
  const h = setup()
  const result = await h.execute({ ...parameters, referenced_image_paths: [] })
  expect(h.readReferences).not.toHaveBeenCalled()
  expect(h.generate.mock.calls[0][0]).not.toHaveProperty('images')
  expect(result.details?.imageGeneration).toMatchObject({ operation: 'generate', referenceCount: 0 })
})

it.each([
  { size: '4096x4096' }, { size: '1024X1536' }, { size: null }, { quality: 'max' }, { quality: null },
  { referenced_image_paths: ['../private.png'] }, { referenced_image_paths: ['https://private.invalid/reference.png'] },
  { referenced_image_paths: ['reference.webp'] }, { referenced_image_paths: [null] },
  { referenced_image_paths: Array.from({ length: 6 }, () => 'reference.png') },
  { mask: 'mask.png' }, { input_fidelity: 'high' }, { images: ['PRIVATE_BASE64'] }
])('rejects unsupported controls/references before file preflight, upload or authentication: %j', async (extra) => {
  const h = setup()
  await expect(h.execute({ ...parameters, ...extra } as Parameters<typeof h.tool.execute>[1])).rejects.toThrow()
  expect(h.disk.files.realpath).not.toHaveBeenCalled()
  expect(h.readReferences).not.toHaveBeenCalled()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
})

it.each(['images/boat.png', './images/boat.png'])('refuses editing an input in place (%s) before any FS or network operation', async (input) => {
  const h = setup()
  await expect(h.execute({ ...parameters, referenced_image_paths: [input] })).rejects.toThrow('不能原地编辑')
  expect(h.disk.files.realpath).not.toHaveBeenCalled()
  expect(h.readReferences).not.toHaveBeenCalled()
  expect(h.generate).not.toHaveBeenCalled()
})

it.each([new ImageInputError('changed'), new Error('PRIVATE_INPUT_DIAGNOSTIC')])('keeps reference failures before upload and hides arbitrary reader diagnostics', async (failure) => {
  const h = setup()
  h.readReferences.mockRejectedValue(failure)
  const error: unknown = await h.execute({ ...parameters, referenced_image_paths: ['images/source.png'] }).catch((value: unknown) => value)
  expect(String(error)).toMatch(/尚未上传|未上传/)
  expect(String(error)).not.toContain('PRIVATE_INPUT_DIAGNOSTIC')
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
})

it.each([
  { kind: 'aborted', message: '参考图片读取等待已中止；底层操作仍须收尾。 尚未上传任何参考图片。' },
  { kind: 'timeout', message: '参考图片读取等待超时；底层操作仍须收尾。 尚未上传任何参考图片。' },
  { kind: 'close', message: '参考图片文件句柄关闭未能确认，本进程参考图片读取已隔离，请重建后端后再试。 尚未上传任何参考图片。' }
] as const)('preserves the fixed reference-reader $kind diagnostic before upload, auth or save', async ({ kind, message }) => {
  const h = setup()
  // Reject only the injected reader: constructing this error cannot latch the
  // production reader's process-wide quarantine or leave an operation pending.
  h.readReferences.mockRejectedValue(new ImageInputError(kind))
  const error: unknown = await h.execute({ ...parameters, referenced_image_paths: ['images/source.png'] }).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(message)
  expect(h.readReferences).toHaveBeenCalledTimes(1)
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.queue).not.toHaveBeenCalled()
  expect(h.disk.files.mkdir).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.disk.files.link).not.toHaveBeenCalled()
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.resize).not.toHaveBeenCalled()
})

it('fails closed if the private reader returns the wrong reference count', async () => {
  const h = setup()
  await expect(h.execute({ ...parameters, referenced_image_paths: ['images/source.png'] })).rejects.toThrow('未上传')
  expect(h.generate).not.toHaveBeenCalled()
})

it('captures every caller parameter before the first output realpath await', async () => {
  const h = setup()
  const entered = deferred<void>()
  const release = deferred<void>()
  const realpath = h.disk.files.realpath.getMockImplementation()!
  h.disk.files.realpath.mockImplementationOnce(async (path) => {
    entered.resolve()
    await release.promise
    return realpath(path)
  })
  const reference = { bytes: image().bytes, mimeType: 'image/png' as const, width: 1, height: 1 }
  h.readReferences.mockResolvedValue([reference, reference])
  const callerPaths = ['./images/source.png', 'images/source-2.png']
  const args: ImageGenerationParameters = { prompt: parameters.prompt, path: './images/captured.png',
    model: 'gpt-image-2.5-flare', size: '2048x3072', quality: 'high', referenced_image_paths: callerPaths }
  const running = h.execute(args)
  try {
    await entered.promise
    expect(h.disk.files.realpath).toHaveBeenCalledExactlyOnceWith(cwd)
    expect(h.readReferences).not.toHaveBeenCalled()
    expect(h.generate).not.toHaveBeenCalled()
    args.prompt = 'PRIVATE_MUTATED_PROMPT'
    args.path = 'changed/mutated.png'
    args.model = 'gpt-image-2.5-sunburst'
    args.size = '1024x1024'
    args.quality = 'low'
    callerPaths[0] = '../private.png'
    callerPaths.push('images/mutated-extra.png')
    args.referenced_image_paths = ['images/mutated-reference.png']
    release.resolve()
    const result = await running
    expect(h.readReferences).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, root: cwd,
      rootIdentity: expect.objectContaining({ dev: 1, ino: 1 }) }), ['images/source.png', 'images/source-2.png'], expect.any(AbortSignal))
    expect(h.generate).toHaveBeenCalledExactlyOnceWith({ prompt: parameters.prompt, model: 'gpt-image-2.5-flare',
      size: '2048x3072', quality: 'high', images: [reference, reference] }, expect.any(AbortSignal))
    expect(result.details?.imageGeneration).toMatchObject({ path: 'images/captured.png', requestedModel: 'gpt-image-2.5-flare',
      requestedSize: '2048x3072', requestedQuality: 'high', operation: 'edit', referenceCount: 2 })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('原图已保存：images/captured.png') })
    expect(h.queue).toHaveBeenCalledExactlyOnceWith(resolve(cwd, 'images/captured.png'), expect.any(Function))
    expect(h.disk.files.link).toHaveBeenCalledExactlyOnceWith(expect.any(String), resolve(cwd, 'images/captured.png'))
    expect(h.disk.entries.get(resolve(cwd, 'images/captured.png'))?.bytes).toEqual(image().bytes)
    expect(h.disk.entries.has(resolve(cwd, 'changed/mutated.png'))).toBe(false)
  } finally {
    release.resolve()
    await running
  }
})

it('captures prompt and settings before reference-read awaits, without using later caller mutations', async () => {
  const h = setup()
  const entered = deferred<void>()
  const released = deferred<void>()
  const reference = { bytes: image().bytes, mimeType: 'image/png' as const, width: 1, height: 1 }
  h.readReferences.mockImplementation(async () => { entered.resolve(); await released.promise; return [reference] })
  const args = { ...parameters, size: '2048x3072', quality: 'high', referenced_image_paths: ['images/source.png'] }
  const running = h.execute(args)
  await entered.promise
  args.prompt = 'PRIVATE_MUTATED_PROMPT'
  args.size = '1024x1024'
  args.quality = 'low'
  args.referenced_image_paths[0] = '../private.png'
  released.resolve()
  await running
  expect(h.generate.mock.calls[0][0]).toMatchObject({ prompt: parameters.prompt, size: '2048x3072', quality: 'high' })
  expect(h.readReferences.mock.calls[0][1]).toEqual(['images/source.png'])
})

it('defines a bounded generation/edit tool with requested settings and an explicit new output path', () => {
  const h = setup()
  expect(h.tool.name).toBe('pion_generate_image')
  expectTypeOf<ImageGenerationParameters['model']>().toEqualTypeOf<CodexImageRequestModel | undefined>()
  expectTypeOf<ImageGenerationParameters['quality']>().toEqualTypeOf<CodexImageRequestQuality | undefined>()
  expectTypeOf<ImageGenerationParameters['referenced_image_paths']>().toEqualTypeOf<string[] | undefined>()
  expect(h.tool.parameters.required).toEqual(['prompt', 'path'])
  expect(h.tool.parameters.properties.prompt.maxLength).toBe(MAX_IMAGE_PROMPT_LENGTH)
  expect(h.tool.parameters.properties.model.anyOf.map(({ const: id }: { const: CodexImageRequestModel }) => id)).toEqual(CODEX_IMAGE_MODEL_OPTIONS.map(({ id }) => id))
  expect(h.tool.parameters.additionalProperties).toBe(false)
  expect(h.tool.parameters.properties.referenced_image_paths.maxItems).toBe(5)
  expect(h.tool.parameters.properties.quality.anyOf.map(({ const: id }: { const: string }) => id)).toEqual(CODEX_IMAGE_QUALITIES)
  expect(h.tool.description).toContain('Mask, input_fidelity and reference URLs are unsupported')
  expect(h.tool.description).toContain('official Codex alias, not proof of the actual version')
  expect(h.tool.description).toContain('experimental request IDs')
  expect(h.tool.description).toContain('subscription compatibility and entitlement are unverified')
  const guidelines = h.tool.promptGuidelines?.join(' ')
  expect(guidelines).toContain('do not automatically retry')
  expect(guidelines).toContain('when the user explicitly requests 2.5')
  expect(guidelines).toContain('no named variant, select gpt-image-2.5-flare')
  expect(guidelines).toContain('Sunburst in natural language, select gpt-image-2.5-sunburst')
  expect(guidelines).toContain('do not claim that an actual 2.5 engine generated the image')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.disk.files.realpath).not.toHaveBeenCalled()
})

it('saves complete source bytes at captured runtime cwd, with wx and a bounded preview only', async () => {
  const h = setup()
  const updates = vi.fn()
  const result = await h.execute(parameters, undefined, updates)
  const target = resolve(cwd, parameters.path)
  const temporary = h.disk.files.open.mock.calls[0][0]
  expect(temporary).toMatch(/\.pion-image-[0-9a-f-]+\.png$/)
  expect(h.disk.files.open).toHaveBeenCalledWith(temporary, 'wx', 0o600)
  expect(h.disk.files.link).toHaveBeenCalledWith(temporary, target)
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(target)
  expect(h.disk.files.mkdir).toHaveBeenCalledWith(resolve(cwd, 'images'), { mode: 0o700 })
  expect(h.disk.entries.get(target)?.bytes).toEqual(image().bytes)
  expect(h.queue).toHaveBeenCalledWith(target, expect.any(Function))
  expect(h.disk.handles[0].close).toHaveBeenCalledTimes(1)
  expect(h.generate).toHaveBeenCalledWith({ prompt: parameters.prompt, model: CODEX_IMAGE_REQUEST_ALIAS, size: 'auto', quality: 'auto' }, expect.any(AbortSignal))
  expect(h.readReferences).not.toHaveBeenCalled()
  expect(h.resize).toHaveBeenCalledWith(image().bytes, 'image/png', { maxWidth: 512, maxHeight: 512, maxBytes: MAX_TOOL_IMAGE_BASE64_LENGTH })
  expect(result.details?.imageGeneration).toEqual({ version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS, resolvedModel: null, path: parameters.path, mimeType: 'image/png', byteLength: png.length, width: 1, height: 1, previewAvailable: true, operation: 'generate', requestedSize: 'auto', requestedQuality: 'auto', referenceCount: 0 })
  expect(result.details?.imageGeneration).not.toHaveProperty('model')
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(parameters.path) })
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('请求型号：Codex 自动（官方别名）；实际版本未报告') })
  expect(result.content[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
  expect(result).not.toHaveProperty('usage')
  expect(JSON.stringify(result)).not.toContain('originalWidth')
  expect(updates.mock.calls.every(([update]) => update.content.length === 1 && update.content[0].type === 'text' && update.content[0].text.length < 80)).toBe(true)
})

it.each(CODEX_IMAGE_MODEL_OPTIONS)('persists v2 requestedModel $id with a label and unknown actual version, without trusting provider model echoes or headers', async ({ id, label }) => {
  const response = new Response(JSON.stringify({
    model: 'gpt-image-2.5', data: [{ b64_json: png.toString('base64'), model: 'provider-echo' }]
  }), { headers: { 'Content-Type': 'application/json', 'x-image-model': 'gpt-image-2.5' } })
  const h = setupTransport(response)
  const result = await h.execute({ ...parameters, model: id })
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).model).toBe(id)
  expect(h.generate).not.toHaveBeenCalled() // real transport, not the injected generator
  expect(result.details?.imageGeneration).toEqual({
    version: 2, provider: 'openai-codex', requestedModel: id, resolvedModel: null,
    path: parameters.path, mimeType: 'image/png', byteLength: png.length, width: 1, height: 1, previewAvailable: true,
    operation: 'generate', requestedSize: 'auto', requestedQuality: 'auto', referenceCount: 0
  })
  expect(result.details?.imageGeneration).not.toHaveProperty('model')
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`请求型号：${label}；实际版本未报告`) })
  expect(JSON.stringify(result)).not.toContain('provider-echo')
  expect(h.disk.entries.get(resolve(cwd, parameters.path))?.bytes).toEqual(image().bytes)
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
})

it.each([null, '', ' ', ' gpt-image-2', 'gpt-image-2 ', 'gpt-image-2.5', 'gpt-image-unknown', 2.5, {}, []].map((model) => ({ model })))('rejects explicit unsupported model $model before file preflight, OAuth or network', async ({ model }) => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const h = setup({ generate: undefined, fetch })
  await expect(h.execute({ ...parameters, model } as unknown as Parameters<typeof h.tool.execute>[1])).rejects.toThrow('不支持的图片请求型号')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(h.disk.files.realpath).not.toHaveBeenCalled()
  expect(h.disk.files.lstat).not.toHaveBeenCalled()
  expect(h.disk.files.mkdir).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.disk.files.link).not.toHaveBeenCalled()
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.queue).not.toHaveBeenCalled()
  expect(h.resize).not.toHaveBeenCalled()
})

it.each(CODEX_IMAGE_MODEL_OPTIONS.filter(({ experimental }) => experimental))('does not retry or downgrade $id after an explicit subscription service rejection', async ({ id }) => {
  const h = setupTransport(new Response(JSON.stringify({ error: { code: 'unsupported_model', message: 'Selected request ID is unavailable' } }), {
    status: 400, headers: { 'Content-Type': 'application/json' }
  }))
  await expect(h.execute({ ...parameters, model: id })).rejects.toThrow(/所选实验性请求型号.*不会自动改用其他型号/)
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).model).toBe(id)
  expect(h.queue).not.toHaveBeenCalled()
  expect(h.disk.files.mkdir).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.disk.files.link).not.toHaveBeenCalled()
  expect(h.resize).not.toHaveBeenCalled()
})

it.each(['EACCES', 'EPERM'])('keeps verified publication and preview successful while reporting private staging cleanup failure: %s', async (code) => {
  const h = setup()
  h.disk.files.unlink.mockRejectedValue(fileError(code))
  const result = await h.execute()
  const target = resolve(cwd, parameters.path)
  const temporary = h.disk.files.open.mock.calls[0][0]
  const recoveryPath = relative(cwd, temporary).split(sep).join('/')
  expect(h.disk.entries.get(target)?.bytes).toEqual(image().bytes)
  expect(h.disk.entries.get(temporary)).toBe(h.disk.entries.get(target))
  expect(h.disk.files.link).toHaveBeenCalledTimes(1)
  expect(h.disk.files.link).toHaveBeenCalledWith(temporary, target)
  expect(h.disk.files.unlink).toHaveBeenCalledTimes(1)
  expect(h.disk.files.unlink).toHaveBeenCalledWith(temporary)
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(target)
  expect(result.details?.imageGeneration).toMatchObject({ path: parameters.path, previewAvailable: true })
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('私有暂存清理失败') })
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`项目相对残留路径 ${recoveryPath}`) })
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('不要重复生成') })
  expect(result.content[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
  expect(JSON.stringify(result)).not.toContain(cwd)
  expect(h.generate).toHaveBeenCalledTimes(1)
  expect(h.resize).toHaveBeenCalledTimes(1)
})

it.each(['', '../outside.png', 'images/../boat.png', '/outside.png', 'C:\\outside.png', 'images\\boat.png', 'https://unknown.invalid/boat.png', 'boat.jpg', 'CON.png', 'images//boat.png', `images/${'folder/'.repeat(32)}boat.png`])('rejects unsafe/non-PNG output path %s before generation', async (path) => {
  const h = setup()
  await expect(h.execute({ ...parameters, path })).rejects.toThrow(/路径|目标/)
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
})

it('requires path, rejects empty/overlong prompts and unknown reference/edit parameters before execution', async () => {
  const h = setup()
  await expect(h.execute({ prompt: 'boat' } as typeof parameters)).rejects.toThrow('路径')
  for (const prompt of [' ', 'x'.repeat(MAX_IMAGE_PROMPT_LENGTH + 1)]) await expect(h.execute({ ...parameters, prompt })).rejects.toThrow('提示词')
  await expect(h.execute({ ...parameters, images: ['reference'] } as typeof parameters)).rejects.toThrow('不支持的图片参数')
  expect(h.generate).not.toHaveBeenCalled()
})

it('refuses existing files and known parent/target symlinks without consuming image quota', async () => {
  const h = setup()
  h.disk.put('images', 'directory')
  const original = h.disk.put(parameters.path, 'file', new Uint8Array([1, 2, 3]))
  await expect(h.execute()).rejects.toThrow('已经存在')
  expect(h.disk.entries.get(resolve(cwd, parameters.path))).toBe(original)
  h.disk.entries.delete(resolve(cwd, parameters.path))
  h.disk.put('images', 'link', undefined, resolve('/outside'))
  await expect(h.execute()).rejects.toThrow('符号链接')
  h.disk.put('images', 'directory')
  h.disk.put(parameters.path, 'link', undefined, resolve('/outside/boat.png'))
  await expect(h.execute()).rejects.toThrow('已经存在')
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
})

it('resolves the true project root while rejecting aliased/symlinked output parents', async () => {
  const disk = fakeDisk()
  const alias = resolve('/pion-project-alias')
  disk.put(alias, 'link', undefined, cwd)
  const h = setup({ cwd: alias, files: disk.files })
  const result = await h.execute()
  expect(result.details?.imageGeneration.path).toBe(parameters.path)
  expect(disk.files.link).toHaveBeenCalledWith(expect.stringContaining('.pion-image-'), resolve(cwd, parameters.path))
})

it('rechecks after generation and preserves another writer’s destination without retrying or changing paths', async () => {
  const h = setup()
  let other!: Entry
  h.generate.mockImplementation(async () => {
    h.disk.put('images', 'directory')
    other = h.disk.put(parameters.path, 'file', new Uint8Array([7, 8, 9]))
    return image()
  })
  await expect(h.execute()).rejects.toThrow(/服务已完成.*可能已消耗.*禁止自动重新生成/)
  expect(h.disk.entries.get(resolve(cwd, parameters.path))).toBe(other)
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.generate).toHaveBeenCalledTimes(1)
  expect(h.resize).not.toHaveBeenCalled()
})

it('refuses a parent symlink or changed real project root that appears during the request', async () => {
  const h = setup()
  h.generate.mockImplementation(async () => {
    h.disk.put('images', 'link', undefined, resolve('/outside'))
    return image()
  })
  await expect(h.execute()).rejects.toThrow('符号链接')
  expect(h.disk.files.open).not.toHaveBeenCalled()
  h.disk.entries.delete(resolve(cwd, 'images'))
  h.generate.mockImplementation(async () => {
    h.disk.files.realpath.mockImplementation(async () => resolve('/replaced-project'))
    return image()
  })
  await expect(h.execute()).rejects.toThrow('真实目录发生变化')
  expect(h.disk.files.open).not.toHaveBeenCalled()
})

it('detects replacement of the project root inode even when its real pathname is unchanged', async () => {
  const h = setup()
  h.generate.mockImplementation(async () => { h.disk.put(cwd, 'directory'); return image() })
  await expect(h.execute()).rejects.toThrow('发生替换')
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.generate).toHaveBeenCalledTimes(1)
})

it('publishes no-replace and preserves the original recovery file on a destination race', async () => {
  const h = setup()
  let other!: Entry
  h.disk.files.link.mockImplementation(async (_source, target) => {
    other = h.disk.put(target, 'file', new Uint8Array([42]))
    throw fileError('EEXIST')
  })
  await expect(h.execute()).rejects.toThrow('临时路径')
  expect(h.disk.entries.get(resolve(cwd, parameters.path))).toBe(other)
  expect(h.disk.entries.get(h.disk.files.open.mock.calls[0][0])?.bytes).toEqual(image().bytes)
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.generate).toHaveBeenCalledTimes(1)
})

it('does not occupy the file mutation queue while generation is waiting', async () => {
  const h = setup()
  const entered = deferred<void>()
  const pending = deferred<ReturnType<typeof image>>()
  h.generate.mockImplementation(async () => { entered.resolve(); return pending.promise })
  const result = h.execute()
  await entered.promise
  expect(h.queue).not.toHaveBeenCalled()
  expect(h.disk.files.mkdir).not.toHaveBeenCalled()
  pending.resolve(image())
  await result
  expect(h.queue).toHaveBeenCalledTimes(1)
})

it('gates one in-flight call per tool instance without sending duplicate requests', async () => {
  const h = setup()
  const entered = deferred<void>()
  const pending = deferred<ReturnType<typeof image>>()
  h.generate.mockImplementation(async () => { entered.resolve(); return pending.promise })
  const first = h.execute()
  await entered.promise
  await expect(h.execute({ ...parameters, path: 'second.png' })).rejects.toThrow('正在执行')
  expect(h.generate).toHaveBeenCalledTimes(1)
  pending.resolve(image())
  await first
  h.generate.mockResolvedValue(image())
  await h.execute({ ...parameters, path: 'second.png' })
  expect(h.generate).toHaveBeenCalledTimes(2)
})

it('checks abort before auth, and discards late generated bytes without writing files', async () => {
  const h = setup()
  const controller = new AbortController()
  controller.abort()
  await expect(h.execute(parameters, controller.signal)).rejects.toThrow('中止')
  expect(h.generate).not.toHaveBeenCalled()
  const pending = deferred<ReturnType<typeof image>>()
  const entered = deferred<void>()
  h.generate.mockImplementation(async () => { entered.resolve(); return pending.promise })
  const active = new AbortController()
  const result = h.execute(parameters, active.signal)
  const rejected = expect(result).rejects.toThrow('中止')
  await entered.promise
  active.abort()
  await rejected
  pending.resolve(image())
  await Promise.resolve()
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.disk.files.mkdir).not.toHaveBeenCalled()
  expect(h.queue).not.toHaveBeenCalled()
})

it('guards the actual queued callback after cancellation rather than permitting a late write', async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const queue: typeof withFileMutationQueue = async (_path, task) => { entered.resolve(); await release.promise; return task() }
  const h = setup({ mutationQueue: queue })
  const controller = new AbortController()
  const result = h.execute(parameters, controller.signal)
  const rejected = expect(result).rejects.toThrow('可能已消耗')
  await entered.promise
  controller.abort()
  await rejected // finish before the blocked queue is released
  expect(h.disk.files.open).not.toHaveBeenCalled()
  release.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.disk.files.mkdir).not.toHaveBeenCalled()
})

it('cleans only its own partial file on a write error or cancellation', async () => {
  for (const cancel of [false, true]) {
    const h = setup()
    const controller = new AbortController()
    h.disk.state.onOpen = (handle, node) => {
      handle.write.mockImplementationOnce(async (bytes) => {
        node.bytes = bytes.slice(0, 3)
        if (cancel) { controller.abort(); return { bytesWritten: 3 } }
        throw fileError('ENOSPC')
      })
    }
    await expect(h.execute(parameters, controller.signal)).rejects.toThrow('原图保存未能确认')
    expect(h.disk.files.unlink).toHaveBeenCalledWith(h.disk.files.open.mock.calls[0][0])
    expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
    expect(h.disk.entries.has(resolve(cwd, parameters.path))).toBe(false)
    expect(h.disk.handles[0].write).toHaveBeenCalledTimes(1)
    expect(h.disk.handles[0].close).toHaveBeenCalledTimes(1)
    expect(h.generate).toHaveBeenCalledTimes(1)
    // Controlled empty parent directories stay; deleting them recursively is unsafe.
    expect(h.disk.entries.get(resolve(cwd, 'images'))?.kind).toBe('directory')
  }
})

it('does not delete a replacement inode during partial-write cleanup', async () => {
  const h = setup()
  let replacement!: Entry
  let temporary = ''
  h.disk.state.onOpen = (handle, _node, path) => {
    temporary = path
    handle.write.mockImplementationOnce(async () => {
      replacement = h.disk.put(path, 'file', new Uint8Array([99]))
      throw fileError('ENOSPC')
    })
  }
  await expect(h.execute()).rejects.toThrow('无法确认私有临时文件已清理')
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.disk.entries.get(temporary)).toBe(replacement)
  expect(h.disk.entries.has(resolve(cwd, parameters.path))).toBe(false)
})

it('reports completed generation plus save permission failure without claiming a free failure or falling back', async () => {
  const h = setup()
  h.disk.files.open.mockRejectedValue(fileError('EACCES'))
  await expect(h.execute()).rejects.toThrow(/服务已完成.*写入权限.*可能已消耗.*禁止自动重新生成/)
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.generate).toHaveBeenCalledTimes(1)
})

it.each(['null', 'throw', 'syncThrow', 'oversize', 'mime', 'dimensions'])('keeps the saved original successful when preview fails: %s', async (failure) => {
  const h = setup()
  if (failure === 'throw') h.resize.mockRejectedValue(new Error('decoder unavailable'))
  else if (failure === 'syncThrow') h.resize.mockImplementation(() => { throw new Error('decoder unavailable') })
  else if (failure === 'null') h.resize.mockResolvedValue(null)
  else if (failure === 'oversize') h.resize.mockResolvedValue({ ...preview(), data: 'a'.repeat(MAX_TOOL_IMAGE_BASE64_LENGTH + 1) })
  else if (failure === 'mime') h.resize.mockResolvedValue({ ...preview(), mimeType: 'image/svg+xml' })
  else h.resize.mockResolvedValue({ ...preview(), width: 9000 })
  const result = await h.execute()
  expect(result.details?.imageGeneration).toMatchObject({ path: parameters.path, previewAvailable: false })
  expect(result.content).toHaveLength(1)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('保存成功') })
  expect(h.disk.entries.get(resolve(cwd, parameters.path))?.bytes).toEqual(image().bytes)
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
  expect(h.generate).toHaveBeenCalledTimes(1)
  h.resize.mockResolvedValue(preview())
  const recovered = await h.execute({ ...parameters, path: 'images/after-preview-failure.png' })
  expect(recovered.details?.imageGeneration.previewAvailable).toBe(true)
  expect(h.resize).toHaveBeenCalledTimes(2)
})

it('bounds preview bytes independently of the resize implementation', async () => {
  const h = setup()
  const bytes = Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 1)
  png.copy(bytes)
  h.resize.mockResolvedValue({ ...preview(), data: bytes.toString('base64') })
  const result = await h.execute()
  expect(result.details?.imageGeneration.previewAvailable).toBe(false)
  expect(result.content).toHaveLength(1)
})

it('retains one process-wide preview slot after abort, across same/replacement tool instances, until the decoder really settles', async () => {
  const h = setup()
  const pending = deferred<ReturnType<typeof preview>>()
  const entered = deferred<void>()
  h.resize.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
  const controller = new AbortController()
  const result = h.execute(parameters, controller.signal)
  try {
    await entered.promise
    expect(h.disk.entries.get(resolve(cwd, parameters.path))?.bytes).toEqual(image().bytes)
    controller.abort()
    const saved = await result
    expect(saved.details?.imageGeneration).toMatchObject({ path: parameters.path, previewAvailable: false })
    expect(saved.content).toHaveLength(1)

    const secondPath = 'images/second.png'
    const second = await h.execute({ ...parameters, path: secondPath })
    expect(second.details?.imageGeneration).toMatchObject({ path: secondPath, previewAvailable: false })
    expect(second.content).toHaveLength(1)
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining('未结束的解码任务') })
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining('不要重复生成') })
    expect(h.disk.entries.get(resolve(cwd, secondPath))?.bytes).toEqual(image().bytes)
    expect(h.resize).toHaveBeenCalledTimes(1)

    const replacement = setup({ files: h.disk.files })
    const replacementPath = 'images/replacement.png'
    const skipped = await replacement.execute({ ...parameters, path: replacementPath })
    expect(skipped.details?.imageGeneration).toMatchObject({ path: replacementPath, previewAvailable: false })
    expect(skipped.content).toHaveLength(1)
    expect(skipped.content[0]).toMatchObject({ text: expect.stringContaining('未结束的解码任务') })
    expect(h.disk.entries.get(resolve(cwd, replacementPath))?.bytes).toEqual(image().bytes)
    expect(replacement.resize).not.toHaveBeenCalled()

    pending.resolve(preview())
    await pending.promise
    const recovered = await replacement.execute({ ...parameters, path: 'images/recovered.png' })
    expect(recovered.details?.imageGeneration.previewAvailable).toBe(true)
    expect(replacement.resize).toHaveBeenCalledTimes(1)
    const resumed = await h.execute({ ...parameters, path: 'images/resumed.png' })
    expect(resumed.details?.imageGeneration.previewAvailable).toBe(true)
    expect(h.resize).toHaveBeenCalledTimes(2)
    expect(saved.content).toHaveLength(1) // a late decode cannot mutate an earlier result
    expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
  } finally {
    controller.abort()
    pending.resolve(preview())
    await pending.promise
    await result
  }
})

it('preserves committed success if cancellation happens during atomic publication', async () => {
  const h = setup()
  const controller = new AbortController()
  const publish = h.disk.files.link.getMockImplementation()!
  h.disk.files.link.mockImplementation(async (source, target) => { await publish(source, target); controller.abort() })
  const result = await h.execute(parameters, controller.signal)
  expect(result.details?.imageGeneration).toMatchObject({ path: parameters.path, previewAvailable: false })
  expect(h.resize).not.toHaveBeenCalled()
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
  expect(h.disk.entries.get(resolve(cwd, parameters.path))?.bytes).toEqual(image().bytes)
})

it('bounds waiting for a hung thumbnail without releasing its decoder slot on timeout', async () => {
  vi.useFakeTimers()
  const h = setup({ previewTimeoutMs: 25 })
  const pending = deferred<ReturnType<typeof preview>>()
  const entered = deferred<void>()
  h.resize.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
  const result = h.execute()
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(25)
    const saved = await result
    expect(saved.details?.imageGeneration.previewAvailable).toBe(false)
    expect(h.disk.entries.get(resolve(cwd, parameters.path))?.bytes).toEqual(image().bytes)
    expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
    const nextPath = 'images/after-timeout.png'
    const next = await h.execute({ ...parameters, path: nextPath })
    expect(next.details?.imageGeneration).toMatchObject({ path: nextPath, previewAvailable: false })
    expect(next.content[0]).toMatchObject({ text: expect.stringContaining('未结束的解码任务') })
    expect(h.disk.entries.get(resolve(cwd, nextPath))?.bytes).toEqual(image().bytes)
    expect(h.resize).toHaveBeenCalledTimes(1)

    pending.resolve(preview())
    await pending.promise
    const recovered = await h.execute({ ...parameters, path: 'images/resolved-timeout.png' })
    expect(recovered.details?.imageGeneration.previewAvailable).toBe(true)
    expect(h.resize).toHaveBeenCalledTimes(2)
    expect(saved.content).toHaveLength(1)
  } finally {
    pending.resolve(preview())
    await pending.promise
    await result
  }
})

it('cancels a stalled read-only preflight without waiting or sending a request', async () => {
  const h = setup()
  h.disk.files.realpath.mockReturnValueOnce(new Promise(() => {}))
  const controller = new AbortController()
  const result = h.execute(parameters, controller.signal)
  const rejected = expect(result).rejects.toThrow('中止')
  controller.abort()
  await rejected
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.disk.files.open).not.toHaveBeenCalled()
})

it('never deletes the selected destination when another writer appears during failed staging cleanup', async () => {
  const h = setup()
  let other!: Entry
  h.disk.state.onOpen = (handle) => {
    handle.write.mockImplementationOnce(async () => {
      other = h.disk.put(parameters.path, 'file', new Uint8Array([99]))
      throw fileError('ENOSPC')
    })
  }
  await expect(h.execute()).rejects.toThrow('原图保存未能确认')
  expect(h.disk.entries.get(resolve(cwd, parameters.path))).toBe(other)
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
  expect(h.disk.files.link).not.toHaveBeenCalled()
})

it('keeps a complete recovery PNG when safe publication is unsupported, without fallback', async () => {
  const h = setup()
  h.disk.files.link.mockRejectedValue(fileError('ENOTSUP'))
  await expect(h.execute()).rejects.toThrow('恢复文件')
  const temporary = h.disk.files.open.mock.calls[0][0]
  expect(h.disk.entries.get(temporary)?.bytes).toEqual(image().bytes)
  expect(h.disk.entries.has(resolve(cwd, parameters.path))).toBe(false)
  expect(h.disk.files.unlink).not.toHaveBeenCalled()
  expect(h.generate).toHaveBeenCalledTimes(1)
})

it('does not remove a competing final inode after publication verification fails', async () => {
  const h = setup()
  const publish = h.disk.files.link.getMockImplementation()!
  let other!: Entry
  h.disk.files.link.mockImplementation(async (source, target) => {
    await publish(source, target)
    other = h.disk.put(target, 'file', new Uint8Array([99]))
  })
  await expect(h.execute()).rejects.toThrow('目标文件已发布')
  expect(h.disk.entries.get(resolve(cwd, parameters.path))).toBe(other)
  expect(h.disk.files.unlink).not.toHaveBeenCalledWith(resolve(cwd, parameters.path))
})

it('refuses malformed original PNG data before staging or thumbnail decode', async () => {
  const h = setup()
  const invalid = Uint8Array.from(png)
  invalid[invalid.length - 1] ^= 1
  h.generate.mockResolvedValue({ bytes: invalid, width: 1, height: 1 })
  await expect(h.execute()).rejects.toThrow('原图不可用')
  expect(h.disk.files.open).not.toHaveBeenCalled()
  expect(h.resize).not.toHaveBeenCalled()
})

it('checks portable component byte limits before consuming quota', async () => {
  const h = setup()
  await expect(h.execute({ ...parameters, path: `${'图'.repeat(86)}.png` })).rejects.toThrow('文件名')
  expect(h.generate).not.toHaveBeenCalled()
})

it('contains progress callback failures so they cannot erase committed success', async () => {
  const h = setup()
  const result = await h.execute(parameters, undefined, () => { throw new Error('UI unavailable') })
  expect(result.details?.imageGeneration.previewAvailable).toBe(true)
  expect(h.disk.entries.get(resolve(cwd, parameters.path))?.bytes).toEqual(image().bytes)
})
