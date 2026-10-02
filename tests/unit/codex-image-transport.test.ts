import { afterEach, expect, it, vi } from 'vitest'
import {
  CODEX_IMAGES_ENDPOINT, CODEX_IMAGE_EDITS_ENDPOINT, CODEX_IMAGE_TIMEOUT_MS, CodexImageError, createCodexImageGenerator,
  MAX_CODEX_IMAGE_JSON_BYTES, MAX_GENERATED_IMAGE_BYTES, MAX_IMAGE_PROMPT_LENGTH,
  inspectReferenceImage, sanitizeImageDiagnostic,
  type CodexImageReference, type CodexImageRequest, type ResolveCodexImageAuth
} from '../../src/main/agent/codex-image-transport'
import {
  CODEX_IMAGE_MODEL_OPTIONS, CODEX_IMAGE_REQUEST_ALIAS, CODEX_IMAGE_QUALITIES,
  MAX_IMAGE_REFERENCES, MAX_IMAGE_REFERENCE_BYTES, MAX_IMAGE_REFERENCE_TOTAL_BYTES
} from '../../src/shared/image-generation'
import { makeStaticPng } from '../fixtures/static-png'

const png = makeStaticPng()
const accountId = 'test-codex-account'
const token = [Buffer.from('{"alg":"RS256"}').toString('base64url'), Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url'), 'test-signature'].join('.')
const auth: NonNullable<Awaited<ReturnType<ResolveCodexImageAuth>>> = { source: 'OAuth', auth: { apiKey: token } }
const signal = () => new AbortController().signal
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const imageResponse = (bytes = png) => json({ created: 123, data: [{ b64_json: bytes.toString('base64') }], usage: { total_tokens: 999 }, unknown: 'not returned' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(imageResponse())) {
  const getAuth = vi.fn<ResolveCodexImageAuth>().mockResolvedValue(auth)
  const generate = createCodexImageGenerator({ getAuth, fetch })
  return { generate, getAuth, fetch }
}
function pngReference(bytes: Uint8Array = png, width = 1, height = 1): CodexImageReference {
  return { bytes, mimeType: 'image/png', width, height }
}
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(payload.length + 4)
  bytes.set([0xff, marker])
  bytes.writeUInt16BE(payload.length + 2, 2)
  payload.copy(bytes, 4)
  return bytes
}
/** Bounded JPEG framing fixture only, not a claim of decoder-valid entropy. */
function structuralJpeg(width = 1, height = 1, metadata: readonly Buffer[] = []): Buffer {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), ...metadata,
    jpegSegment(0xc0, frame), jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x11, 0xff, 0, 0x22, 0xff, 0xd9])
  ])
}
function paddedStructuralJpeg(byteLength: number): Buffer {
  let remaining = byteLength - structuralJpeg().length
  const count = Math.ceil(remaining / 65_537)
  const metadata: Buffer[] = []
  for (let index = 0; index < count; index++) {
    const size = Math.min(65_537, remaining - 4 * (count - index - 1))
    metadata.push(jpegSegment(0xe1, Buffer.alloc(size - 4, 0x41)))
    remaining -= size
  }
  return structuralJpeg(1, 1, metadata)
}
function jpegReference(bytes = structuralJpeg(), width = 1, height = 1): CodexImageReference {
  return { bytes, mimeType: 'image/jpeg', width, height }
}
afterEach(() => vi.useRealTimers())

it('uses the independent fixed Codex Images protocol, honest headers and runtime OAuth on execution only', async () => {
  const h = setup()
  expect(h.getAuth).not.toHaveBeenCalled()
  const result = await h.generate({ prompt: 'A small red boat' }, signal())
  expect(h.getAuth).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), minOAuthValidityMs: CODEX_IMAGE_TIMEOUT_MS })
  expect(h.fetch).toHaveBeenCalledTimes(1)
  const [endpoint, init] = h.fetch.mock.calls[0]
  expect(endpoint).toBe(CODEX_IMAGES_ENDPOINT)
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) })
  expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId, originator: 'pion', 'Content-Type': 'application/json' })
  expect((init?.headers as Record<string, string>)['x-codex-image-turn-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-image-2', prompt: 'A small red boat', n: 1, quality: 'auto', size: 'auto' })
  expect(result).toEqual({ bytes: new Uint8Array(png), width: 1, height: 1 })
  expect(result).not.toHaveProperty('usage')
  expect(JSON.stringify(result)).not.toContain(token)
  expect(JSON.stringify(result)).not.toContain('unknown')
})

it.each(CODEX_IMAGE_MODEL_OPTIONS)('sends exactly $id to the same subscription endpoint without treating response echoes as actual-version evidence', async ({ id }) => {
  const response = new Response(JSON.stringify({
    model: 'gpt-image-2.5', data: [{ b64_json: png.toString('base64'), model: 'provider-echo' }]
  }), { headers: { 'Content-Type': 'application/json', 'x-image-model': 'gpt-image-2.5' } })
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))
  const result = await h.generate({ prompt: 'boat', model: id }, signal())
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  expect(h.fetch.mock.calls[0][0]).toBe(CODEX_IMAGES_ENDPOINT)
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body))).toEqual({ model: id, prompt: 'boat', n: 1, quality: 'auto', size: 'auto' })
  expect(result).toEqual({ bytes: new Uint8Array(png), width: 1, height: 1 })
  expect(result).not.toHaveProperty('model')
  expect(result).not.toHaveProperty('resolvedModel')
})

it('keeps an explicitly undefined model compatible with the official request alias default', async () => {
  const h = setup()
  await h.generate({ prompt: 'boat', model: undefined }, signal())
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).model).toBe(CODEX_IMAGE_REQUEST_ALIAS)
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it.each([null, '', ' ', ' gpt-image-2', 'gpt-image-2 ', 'gpt-image-2.5', 'gpt-image-unknown', 2.5, {}, []].map((model) => ({ model })))('rejects explicit unsupported model $model before OAuth or network instead of silently using the default', async ({ model }) => {
  const h = setup()
  await expect(h.generate({ prompt: 'boat', model } as unknown as CodexImageRequest, signal())).rejects.toThrow('不支持的图片请求型号')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it.each([undefined, { source: 'API key', auth: { apiKey: 'sk-not-an-oauth-token' } }, { source: 'OAuth', auth: { apiKey: 'invalid' } }])('fails closed without valid Codex subscription OAuth: %j', async (value) => {
  const h = setup()
  h.getAuth.mockResolvedValue(value)
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toMatchObject({ kind: 'login' })
  expect(h.fetch).not.toHaveBeenCalled()
})

it('does not expose refresh errors, JWTs, secrets or injected account headers', async () => {
  const h = setup()
  h.getAuth.mockRejectedValue(new Error(`refresh failed access_token=${token}`))
  const failure = await h.generate({ prompt: 'boat' }, signal()).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(CodexImageError)
  expect(String(failure)).toContain('重新登录')
  expect(String(failure)).not.toContain(token)
  const badToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'bad\r\nHeader: injected' } })).toString('base64url')}.signature`
  h.getAuth.mockResolvedValue({ source: 'OAuth', auth: { apiKey: badToken } })
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toMatchObject({ kind: 'login' })
  expect(h.fetch).not.toHaveBeenCalled()
})

it.each([
  [401, 'expired token', 'login', /重新登录/],
  [403, 'not entitled', 'entitlement', /权益|访问权限/],
  [402, 'insufficient_quota', 'quota', /额度不足/],
  [429, 'insufficient_quota', 'quota', /额度不足/],
  [429, 'rate_limit_exceeded', 'rate_limit', /过于频繁/],
  [503, 'unavailable', 'network', /暂时不可用/]
])('classifies HTTP %s / %s without retries', async (status, code, kind, message) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message: 'short diagnostic' } }, status as number))
  const h = setup(fetch)
  const error = await h.generate({ prompt: 'boat' }, signal()).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ kind })
  expect(String(error)).toMatch(message as RegExp)
  expect(String(error)).toContain('可能消耗')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(CODEX_IMAGE_MODEL_OPTIONS.filter(({ experimental }) => experimental).flatMap(({ id }) => [
  { model: id, status: 400, code: 'unsupported_model' },
  { model: id, status: 404, code: 'model_not_found' }
]))('reports explicit HTTP $status / $code for $model without making a downgraded request', async ({ model, status, code }) => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message: 'Selected request ID is unavailable' } }, status)))
  const error = await h.generate({ prompt: 'boat', model }, signal()).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ kind: 'protocol' })
  expect(String(error)).toContain('所选实验性请求型号')
  expect(String(error)).toContain('订阅兼容性及权益未验证')
  expect(String(error)).toContain('不会自动改用其他型号')
  expect(String(error)).toContain('可能消耗')
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).model).toBe(model)
})

it('also recognizes an explicit unsupported_model error type without retrying', async () => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { type: 'unsupported_model' } }, 400)))
  await expect(h.generate({ prompt: 'boat', model: 'gpt-image-2.5-flare' }, signal())).rejects.toThrow('所选实验性请求型号')
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it.each([
  new Response('', { status: 404 }),
  json({ error: { message: 'Not found' } }, 404),
  json({ error: { code: 'route_not_found', message: 'Not found' } }, 404)
])('does not treat a bare or unrelated 404 as proof that an experimental model is missing: %#', async (response) => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))
  const error = await h.generate({ prompt: 'boat', model: 'gpt-image-2.5-flare' }, signal()).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ kind: 'protocol' })
  expect(String(error)).toContain('HTTP 404')
  expect(String(error)).not.toContain('所选实验性请求型号')
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it('does not apply an experimental-model hint to the default alias or to service errors', async () => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: 'model_not_found' } }, 404)))
  const aliasError = await h.generate({ prompt: 'boat' }, signal()).catch((failure: unknown) => failure)
  expect(String(aliasError)).toContain('HTTP 404')
  expect(String(aliasError)).not.toContain('所选实验性请求型号')
  h.fetch.mockResolvedValue(json({ error: { code: 'unsupported_model' } }, 503))
  const serviceError = await h.generate({ prompt: 'boat', model: 'gpt-image-2.5-sunburst' }, signal()).catch((failure: unknown) => failure)
  expect(serviceError).toMatchObject({ kind: 'network' })
  expect(String(serviceError)).not.toContain('所选实验性请求型号')
  expect(h.fetch).toHaveBeenCalledTimes(2) // two user-initiated calls, no fallback
})

it('redacts and truncates error diagnostics, including body echoes of credentials and asset URLs', async () => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { message: `Bearer ${token}; chatgpt-account-id=${accountId}; sk-private-secret https://untrusted.invalid/asset.png ${'x'.repeat(1000)}` } }, 400)))
  const error = await h.generate({ prompt: 'boat' }, signal()).catch((failure: unknown) => failure)
  const message = String(error)
  expect(message.length).toBeLessThan(650)
  for (const secret of [token, accountId, 'sk-private-secret', 'https://untrusted.invalid']) expect(message).not.toContain(secret)
  expect(sanitizeImageDiagnostic('access_token=abc refresh_token=def api_key=ghi')).not.toMatch(/=abc|=def|=ghi/)
})

it('rejects redirects and provider URLs without following or downloading them', async () => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid/a.png' } })))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow('重定向')
  expect(h.fetch).toHaveBeenCalledTimes(1)
  h.fetch.mockResolvedValue(json({ data: [{ url: 'https://untrusted.invalid/a.png' }] }))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow(/base64/)
  expect(h.fetch).toHaveBeenCalledTimes(2)
  expect(h.fetch.mock.calls.every(([url]) => url === CODEX_IMAGES_ENDPOINT)).toBe(true)
})

it.each([
  new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }),
  new Response('<html>proxy</html>', { headers: { 'Content-Type': 'text/html' } }),
  json({ data: [] }),
  json({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] }),
  json({ data: [{ b64_json: `${png.toString('base64')}\n` }] }),
  json({ data: [{ b64_json: 'YQ==' }] })
])('rejects malformed JSON, unexpected format/cardinality and noncanonical/non-PNG bytes', async (response) => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toMatchObject({ kind: 'protocol' })
})

it('rejects declared and streamed JSON over 24 MiB and cancels the body', async () => {
  const declaredCancel = vi.fn()
  const declared = new Response(new ReadableStream<Uint8Array>({ cancel: declaredCancel }), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_CODEX_IMAGE_JSON_BYTES + 1) } })
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(declared))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow('大小限制')
  expect(declaredCancel).toHaveBeenCalledTimes(1)
  const streamedCancel = vi.fn()
  h.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_CODEX_IMAGE_JSON_BYTES + 1)) }, cancel: streamedCancel }), { headers: { 'Content-Type': 'application/json' } }))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow('大小限制')
  expect(streamedCancel).toHaveBeenCalled()
})

it('rejects single originals over 16 MiB before raster decoding', async () => {
  const bytes = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES + 1)
  png.copy(bytes)
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(imageResponse(bytes)))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow('16 MiB')
})

it('rejects excessive edges/pixels and APNG chunks before thumbnail raster decoding', async () => {
  const edge = Buffer.from(png)
  edge.writeUInt32BE(4097, 16)
  const pixels = Buffer.from(png)
  pixels.writeUInt32BE(4096, 16)
  pixels.writeUInt32BE(4096, 20)
  const animationChunk = Buffer.alloc(20)
  animationChunk.writeUInt32BE(8, 0)
  animationChunk.write('acTL', 4, 'ascii')
  const animated = Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)])
  const h = setup()
  for (const invalid of [edge, pixels, animated]) {
    h.fetch.mockResolvedValue(imageResponse(invalid))
    await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow('静态 PNG')
  }
})

it('honours an already-aborted parent without resolving OAuth or sending a request', async () => {
  const h = setup()
  const controller = new AbortController()
  controller.abort()
  await expect(h.generate({ prompt: 'boat' }, controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('aborts pending auth, discards late refresh results and never dispatches', async () => {
  const pending = deferred<typeof auth>()
  const h = setup()
  h.getAuth.mockReturnValue(pending.promise)
  const controller = new AbortController()
  const result = h.generate({ prompt: 'boat' }, controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ kind: 'aborted' })
  controller.abort()
  await rejected
  pending.resolve(auth)
  await Promise.resolve()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('bounds an unresponsive request to five minutes and rejects longer timeout settings', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise(() => {}))
  const h = setup(fetch)
  const result = h.generate({ prompt: 'boat' }, signal())
  const rejected = expect(result).rejects.toMatchObject({ kind: 'timeout' })
  await vi.advanceTimersByTimeAsync(CODEX_IMAGE_TIMEOUT_MS)
  await rejected
  expect((fetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(() => createCodexImageGenerator({ getAuth: h.getAuth, timeoutMs: CODEX_IMAGE_TIMEOUT_MS + 1 })).toThrow('5 分钟')
})

it('cancels a blocked response body on parent abort and does not emit a late image', async () => {
  const controller = new AbortController()
  const reading = deferred<void>()
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel }), { headers: { 'Content-Type': 'application/json' } })
  const getReader = response.body!.getReader.bind(response.body!)
  vi.spyOn(response.body!, 'getReader').mockImplementation(() => { reading.resolve(); return getReader() })
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))
  const result = h.generate({ prompt: 'boat' }, controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ kind: 'aborted' })
  await reading.promise
  controller.abort()
  await rejected
  expect(cancel).toHaveBeenCalled()
})

it('does not expose network exception secrets or automatically retry', async () => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`connection failed ${token} https://untrusted.invalid/`)))
  const result = await h.generate({ prompt: 'boat' }, signal()).catch((error: unknown) => error)
  expect(result).toMatchObject({ kind: 'network' })
  expect(String(result)).not.toContain(token)
  expect(String(result)).not.toContain('https://')
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it('checks bounded, nonempty prompts before auth', async () => {
  const h = setup()
  for (const prompt of ['', '   ', 'x'.repeat(MAX_IMAGE_PROMPT_LENGTH + 1)]) await expect(h.generate({ prompt }, signal())).rejects.toThrow('提示词')
  expect(h.getAuth).not.toHaveBeenCalled()
})

it.each(CODEX_IMAGE_QUALITIES.flatMap((quality) => [
  'auto', '1024x1024', '1536x1024', '1024x1536', '2048x3072', '3072x2048', '4096x3072', '16x16'
].map((size) => ({ quality, size: size as CodexImageRequest['size'] }))))('forwards quality $quality / size $size unchanged, without promising exact output dimensions', async ({ quality, size }) => {
  const h = setup()
  const result = await h.generate({ prompt: 'boat', quality, size }, signal())
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body))).toEqual({ model: CODEX_IMAGE_REQUEST_ALIAS, prompt: 'boat', n: 1, quality, size })
  expect(h.fetch.mock.calls[0][0]).toBe(CODEX_IMAGES_ENDPOINT)
  expect(result).toEqual({ bytes: new Uint8Array(png), width: 1, height: 1 })
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it.each([undefined, []].map((images) => ({ images })))('keeps absent/empty references on generations with no guessed edit fields: %#', async ({ images }) => {
  const h = setup()
  await h.generate({ prompt: 'boat', quality: undefined, size: undefined, images }, signal())
  expect(h.fetch.mock.calls[0][0]).toBe(CODEX_IMAGES_ENDPOINT)
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body))).toEqual({ model: CODEX_IMAGE_REQUEST_ALIAS, prompt: 'boat', n: 1, quality: 'auto', size: 'auto' })
})

it('sends mixed PNG/JPEG references as inline Images JSON to the fixed edits endpoint with the same runtime OAuth', async () => {
  const jpeg = structuralJpeg(3, 2, [jpegSegment(0xe1, Buffer.from('Exif private metadata'))])
  const response = imageResponse()
  Object.defineProperty(response, 'url', { value: CODEX_IMAGE_EDITS_ENDPOINT })
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))
  const result = await h.generate({ prompt: 'Change the boat', model: 'gpt-image-2.5-sunburst', size: '2048x3072', quality: 'high', images: [pngReference(), jpegReference(jpeg, 3, 2)] }, signal())
  expect(h.getAuth).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), minOAuthValidityMs: CODEX_IMAGE_TIMEOUT_MS })
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  const [endpoint, init] = h.fetch.mock.calls[0]
  expect(endpoint).toBe(CODEX_IMAGE_EDITS_ENDPOINT)
  expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
  expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId, 'Content-Type': 'application/json' })
  expect(JSON.parse(String(init?.body))).toEqual({
    model: 'gpt-image-2.5-sunburst', prompt: 'Change the boat', n: 1, quality: 'high', size: '2048x3072',
    images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }, { image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }]
  })
  expect(Buffer.byteLength(String(init?.body), 'utf8')).toBeLessThanOrEqual(MAX_CODEX_IMAGE_JSON_BYTES)
  expect(result).toEqual({ bytes: new Uint8Array(png), width: 1, height: 1 })
  for (const key of ['usage', 'model', 'resolvedModel', 'images', 'prompt', 'requestedSize']) expect(result).not.toHaveProperty(key)
})

it('copies the exact nonzero-offset snapshot before awaiting auth, even if the caller mutates bytes, request and references', async () => {
  const pending = deferred<typeof auth>()
  const backing = Buffer.alloc(png.length + 16)
  png.copy(backing, 7)
  const bytes = new Uint8Array(backing.buffer, backing.byteOffset + 7, png.length)
  const reference = { bytes, mimeType: 'image/png' as const, width: 1, height: 1 }
  const request: CodexImageRequest = { prompt: 'Original prompt', model: 'gpt-image-2.5-flare', quality: 'medium', size: '2048x3072', images: [reference] }
  const h = setup()
  h.getAuth.mockReturnValue(pending.promise)
  const result = h.generate(request, signal())
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).not.toHaveBeenCalled()
  backing.fill(0)
  reference.bytes = Uint8Array.of(0xff)
  reference.width = 4096
  reference.height = 4096
  request.prompt = 'Mutated prompt'
  request.model = 'gpt-image-2'
  request.size = 'auto'
  request.quality = 'low'
  request.images = []
  pending.resolve(auth)
  await result
  expect(h.fetch.mock.calls[0][0]).toBe(CODEX_IMAGE_EDITS_ENDPOINT)
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body))).toEqual({
    model: 'gpt-image-2.5-flare', prompt: 'Original prompt', n: 1, quality: 'medium', size: '2048x3072',
    images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }]
  })
})

it.each([
  { quality: null }, { quality: '' }, { quality: 'HIGH' }, { quality: ' high' }, { quality: 'ultra' }, { quality: 1 },
  { size: null }, { size: '' }, { size: '2048X3072' }, { size: '2048x3072 ' }, { size: '02048x3072' },
  { size: '1025x1024' }, { size: '4112x1024' }, { size: '4096x4096' }, { size: '64x256' }, { size: [1024, 1024] },
  { mask: 'private-mask.png' }, { mask: undefined }, { background: 'transparent' }, { input_fidelity: 'high' },
  { n: 2 }, { data: 'do not guess' }, { image_url: 'https://private.invalid/reference.png' }, { toJSON: () => ({ prompt: 'boat' }) }
])('rejects invalid settings/unknown fields before auth, timers or dispatch: %#', async (fields) => {
  vi.useFakeTimers()
  const timer = vi.spyOn(globalThis, 'setTimeout')
  try {
    const h = setup()
    timer.mockClear()
    await expect(h.generate({ prompt: 'boat', ...fields } as unknown as CodexImageRequest, signal())).rejects.toThrow()
    expect(h.getAuth).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
  } finally { timer.mockRestore() }
})

it.each([
  null, undefined, [], 'boat', Object.assign(Object.create({ mask: 'inherited' }), { prompt: 'boat' }),
  { prompt: 'boat', [Symbol('extra')]: 'private' },
  { get prompt() { throw new Error('must not evaluate accessor') } }
].map((request) => ({ request })))('rejects unknown request snapshot types and accessors without auth: %#', async ({ request }) => {
  const h = setup()
  await expect(h.generate(request as unknown as CodexImageRequest, signal())).rejects.toThrow('不支持')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it.each([
  null, 'private.png', { image_url: 'data:image/png;base64,YQ==' }, [null], [png],
  [undefined], new Array(1), Array.from({ length: MAX_IMAGE_REFERENCES + 1 }, () => pngReference()),
  [{ ...pngReference(), bytes: [1, 2, 3] }], [{ ...pngReference(), bytes: new DataView(new ArrayBuffer(4)) }],
  [{ ...pngReference(), bytes: new Uint16Array(4) }], [{ ...pngReference(), bytes: new Uint8Array(0) }],
  [{ ...pngReference(), mimeType: 'image/webp' }], [{ ...pngReference(), mimeType: 'image/PNG' }],
  [{ ...pngReference(), width: 2 }], [{ ...pngReference(), width: '1' }], [{ ...pngReference(), height: NaN }],
  [{ ...pngReference(), width: 0 }], [{ ...pngReference(), height: 0.5 }], [{ ...pngReference(), width: 4097 }],
  [{ ...pngReference(), width: 4096, height: 4096 }], [{ ...pngReference(), filename: 'private.png' }],
  [{ ...pngReference(), mask: 'private.png' }], [Object.assign(Object.create({ bytes: png }), { mimeType: 'image/png', width: 1, height: 1 })],
  [{ ...pngReference(), get bytes() { throw new Error('must not evaluate accessor') } }]
].map((images) => ({ images })))('rejects malformed reference snapshots/metadata and limits before auth or dispatch: %#', async ({ images }) => {
  const h = setup()
  await expect(h.generate({ prompt: 'boat', images } as unknown as CodexImageRequest, signal())).rejects.toThrow()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('accepts five references and rejects image-array accessors or extra request fields without invoking them', async () => {
  const h = setup()
  await h.generate({ prompt: 'boat', images: Array.from({ length: MAX_IMAGE_REFERENCES }, () => pngReference()) }, signal())
  expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).images).toHaveLength(MAX_IMAGE_REFERENCES)
  h.getAuth.mockClear()
  h.fetch.mockClear()
  const accessor = new Array<CodexImageReference>(1)
  const getter = vi.fn(() => pngReference())
  Object.defineProperty(accessor, '0', { get: getter })
  const extra = Object.assign([pngReference()], { mask: 'private.png' })
  for (const images of [accessor, extra]) await expect(h.generate({ prompt: 'boat', images }, signal())).rejects.toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('validates reference MIME, static PNG integrity and actual byte dimensions independently of declared dimensions', async () => {
  expect(inspectReferenceImage(png, 'image/png')).toEqual({ width: 1, height: 1 })
  const jpeg = structuralJpeg(3, 2)
  expect(inspectReferenceImage(jpeg, 'image/jpeg')).toEqual({ width: 3, height: 2 })
  const corruptPng = Buffer.from(png)
  corruptPng[corruptPng.length - 1] ^= 1 // Correct framing, invalid IEND CRC.
  const edge = Buffer.from(png)
  edge.writeUInt32BE(4097, 16)
  const pixels = Buffer.from(png)
  pixels.writeUInt32BE(4096, 16)
  pixels.writeUInt32BE(4096, 20)
  const animationChunk = Buffer.alloc(20)
  animationChunk.writeUInt32BE(8, 0)
  animationChunk.write('acTL', 4, 'ascii')
  const animated = Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)])
  const h = setup()
  for (const reference of [
    pngReference(corruptPng), pngReference(edge), pngReference(pixels), pngReference(animated),
    { ...pngReference(), mimeType: 'image/jpeg' as const },
    { ...jpegReference(jpeg, 3, 2), mimeType: 'image/png' as const },
    jpegReference(jpeg, 1, 1), jpegReference(structuralJpeg(4097, 1)), jpegReference(structuralJpeg(4096, 4096))
  ]) await expect(h.generate({ prompt: 'boat', images: [reference] }, signal())).rejects.toThrow()
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('checks the entire JPEG structure, terminal EOI, segment framing and scans without partial decoding', () => {
  const jpeg = structuralJpeg()
  const sofOnly = Buffer.concat([jpeg.subarray(0, 15), Buffer.from([0xff, 0xd9])])
  const brokenAfterFrame = Buffer.concat([jpeg.subarray(0, 15), Buffer.from([0xff, 0xe1, 0xff, 0xff]), jpeg.subarray(15)])
  const truncatedEntropy = Buffer.concat([jpeg.subarray(0, -2), Buffer.from([0xff, 0xe1, 0, 20, 0xff, 0xd9])])
  const earlyEoi = Buffer.concat([jpeg.subarray(0, -2), Buffer.from([0xff, 0xd9, 0x42, 0xff, 0xd9])])
  const missingScan = Buffer.concat([jpeg.subarray(0, 25), Buffer.from([0xff, 0xd9])])
  for (const bytes of [jpeg.subarray(0, -2), Buffer.concat([jpeg, Buffer.of(0)]), sofOnly, brokenAfterFrame, truncatedEntropy, earlyEoi, missingScan]) {
    expect(() => inspectReferenceImage(bytes, 'image/jpeg')).toThrow()
  }
  const manyMetadata = structuralJpeg(1, 1, Array.from({ length: 4096 }, () => jpegSegment(0xe1, Buffer.alloc(0))))
  expect(() => inspectReferenceImage(manyMetadata, 'image/jpeg')).toThrow()
})

it('bounds each reference at 8 MiB using native byte length, not caller-overridden properties', async () => {
  const h = setup()
  const oversized = Buffer.alloc(MAX_IMAGE_REFERENCE_BYTES + 1)
  Object.defineProperty(oversized, 'byteLength', { value: 1 })
  await expect(h.generate({ prompt: 'boat', images: [pngReference(oversized)] }, signal())).rejects.toThrow('8 MiB')
  expect(() => inspectReferenceImage(oversized, 'image/png')).toThrow('8 MiB')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('accepts exactly 16 MiB of reference bytes, keeps serialized JSON within 24 MiB, and rejects a larger total before auth', async () => {
  const jpeg = paddedStructuralJpeg(MAX_IMAGE_REFERENCE_BYTES)
  expect(jpeg.byteLength).toBe(MAX_IMAGE_REFERENCE_BYTES)
  const h = setup()
  await h.generate({ prompt: '\u0000'.repeat(MAX_IMAGE_PROMPT_LENGTH), images: [jpegReference(jpeg), jpegReference(jpeg)] }, signal())
  expect(MAX_IMAGE_REFERENCE_TOTAL_BYTES).toBe(2 * jpeg.byteLength)
  const body = String(h.fetch.mock.calls[0][1]?.body)
  expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_CODEX_IMAGE_JSON_BYTES)
  expect(JSON.parse(body).images).toHaveLength(2)
  h.getAuth.mockClear()
  h.fetch.mockClear()
  await expect(h.generate({ prompt: 'boat', images: [jpegReference(jpeg), jpegReference(jpeg), pngReference()] }, signal())).rejects.toThrow('总字节数')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('bounds aggregate actual reference pixels at 16 million, even when each image fits its individual limits', async () => {
  const jpeg = structuralJpeg(4096, 2048)
  const h = setup()
  await expect(h.generate({ prompt: 'boat', images: [jpegReference(jpeg, 4096, 2048), jpegReference(jpeg, 4096, 2048)] }, signal())).rejects.toThrow('总像素')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
  const halfBudget = structuralJpeg(4000, 2000)
  expect(inspectReferenceImage(structuralJpeg(4000, 4000), 'image/jpeg')).toEqual({ width: 4000, height: 4000 })
  await h.generate({ prompt: 'boat', images: [jpegReference(halfBudget, 4000, 2000), jpegReference(halfBudget, 4000, 2000)] }, signal())
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it.each([
  { width: 4000, height: 2000 }, // Accurate caller metadata.
  { width: 1, height: 1 } // Underreported metadata must not bypass the gate.
])('rejects a framing-only 8M PNG after a 12M JPEG before PNG integrity/auth, with declared $width x $height', async ({ width, height }) => {
  const jpeg = structuralJpeg(4000, 3000)
  const corruptPng = Buffer.from(png)
  corruptPng.writeUInt32BE(4000, 16)
  corruptPng.writeUInt32BE(2000, 20)
  corruptPng[corruptPng.length - 1] ^= 1 // Intact framing, deliberately invalid IEND CRC; no large raster fixture.
  const h = setup()
  const error = await h.generate({ prompt: 'boat', images: [jpegReference(jpeg, 4000, 3000), pngReference(corruptPng, width, height)] }, signal()).catch((failure: unknown) => failure)
  expect(String(error)).toContain('参考图片总像素不能超过 1600 万。')
  expect(String(error)).not.toContain('参考 PNG 数据')
  expect(String(error)).not.toContain('快照尺寸与实际字节不符')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('preserves original MIME/framing and per-image limit errors when the header is invalid even with no aggregate pixels left', async () => {
  const jpeg = structuralJpeg(4000, 4000)
  const edge = Buffer.from(png)
  edge.writeUInt32BE(4097, 16)
  const pixels = Buffer.from(png)
  pixels.writeUInt32BE(4096, 16)
  pixels.writeUInt32BE(4096, 20)
  const h = setup()
  for (const reference of [
    pngReference(structuralJpeg(4000, 2000), 4000, 2000),
    pngReference(png.subarray(0, -1), 4000, 2000),
    pngReference(edge, 4000, 2000), pngReference(pixels, 4000, 2000)
  ]) {
    await expect(h.generate({ prompt: 'boat', images: [jpegReference(jpeg, 4000, 4000), reference] }, signal())).rejects.toThrow('参考图片格式无效、MIME 不符或超过 4096 像素/边、1600 万像素限制。')
  }
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('still runs PNG integrity checks when actual header pixels fit the remaining aggregate budget exactly', async () => {
  const jpeg = structuralJpeg(4000, 2000)
  const corruptPng = Buffer.from(png)
  corruptPng.writeUInt32BE(4000, 16)
  corruptPng.writeUInt32BE(2000, 20)
  corruptPng[corruptPng.length - 1] ^= 1
  const h = setup()
  await expect(h.generate({ prompt: 'boat', images: [jpegReference(jpeg, 4000, 2000), pngReference(corruptPng, 4000, 2000)] }, signal())).rejects.toThrow('参考 PNG 数据不完整、损坏或超过解码安全限制。')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('does not use overstated caller dimensions for aggregate rejection when actual pixels fit', async () => {
  const jpeg = structuralJpeg(4000, 3000)
  const h = setup()
  await expect(h.generate({ prompt: 'boat', images: [jpegReference(jpeg, 4000, 3000), pngReference(png, 4000, 2000)] }, signal())).rejects.toThrow('参考图片快照尺寸与实际字节不符。')
  expect(h.getAuth).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it.each([
  { status: 400, code: 'unsupported_model', kind: 'protocol', model: 'gpt-image-2.5-flare' as const },
  { status: 429, code: 'insufficient_quota', kind: 'quota', model: CODEX_IMAGE_REQUEST_ALIAS },
  { status: 400, code: 'not_entitled', kind: 'entitlement', model: CODEX_IMAGE_REQUEST_ALIAS },
  { status: 400, code: 'rate_limit_exceeded', kind: 'rate_limit', model: CODEX_IMAGE_REQUEST_ALIAS },
  { status: 403, code: 'unknown-private-code', kind: 'entitlement', model: CODEX_IMAGE_REQUEST_ALIAS },
  { status: 503, code: 'unknown-private-code', kind: 'network', model: CODEX_IMAGE_REQUEST_ALIAS }
] as const)('uses only fixed edit errors/safe $code classification for HTTP $status; no retries/fallback or private diagnostics', async ({ status, code, kind, model }) => {
  const tinyBase64 = 'YQ=='
  const prompt = 'Private edit prompt'
  const filename = 'private-family-photo.jpg'
  const url = 'https://private.invalid/provider/photo.jpg'
  const bytes = structuralJpeg(1, 1, [jpegSegment(0xe1, Buffer.from(filename))])
  const message = `${tinyBase64} ${prompt} ${filename} ${url} data:image/jpeg;base64,${bytes.toString('base64')} ${png.toString('base64').slice(0, 12)}`
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message } }, status)))
  const error = await h.generate({ prompt, model, size: '2048x3072', quality: 'high', images: [jpegReference(bytes)] }, signal()).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ kind })
  for (const secret of [tinyBase64, prompt, filename, url, bytes.toString('base64'), png.toString('base64').slice(0, 12), 'unknown-private-code']) expect(String(error)).not.toContain(secret)
  expect(String(error)).toContain('可能消耗')
  expect(h.getAuth).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  expect(h.fetch.mock.calls[0][0]).toBe(CODEX_IMAGE_EDITS_ENDPOINT)
  expect(h.fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId })
  const request = JSON.parse(String(h.fetch.mock.calls[0][1]?.body))
  expect(request).toMatchObject({ model, size: '2048x3072', quality: 'high' })
})

it.each([
  { code: 'YQ==', message: 'short private prompt' },
  { code: 'data:image/png;base64,YQ==', message: 'private.jpg' },
  { type: 'data:image/png;base64,YQ==', message: 'private.jpg' },
  'YQ== private.jpg short private prompt',
  { code: 'credit_private_YQ==', message: 'insufficient_quota private.jpg' },
  'insufficient_quota YQ== private.jpg short private prompt',
  { code: 'unknown_code', type: 'unsupported_model', message: 'YQ==' }
])('does not pass any unknown edit code/string/message through diagnostic sanitization: %#', async (errorBody) => {
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: errorBody }, 400)))
  const error = await h.generate({ prompt: 'short private prompt', model: 'gpt-image-2.5-flare', images: [pngReference()] }, signal()).catch((failure: unknown) => failure)
  for (const privateText of ['YQ==', 'private.jpg', 'short private prompt', 'unknown_code', 'data:image']) expect(String(error)).not.toContain(privateText)
  if (typeof errorBody === 'object' && 'type' in errorBody && errorBody.type === 'unsupported_model') expect(String(error)).toContain('所选实验性请求型号')
  else expect(String(error)).toContain('HTTP 400')
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it('removes even short inline data URIs from text-generation diagnostics while retaining harmless legacy diagnostic text', async () => {
  expect(sanitizeImageDiagnostic('bad data:image/png;base64,YQ== on https://private.invalid/image')).not.toContain('YQ==')
  const h = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { message: 'safe diagnostic text' } }, 400)))
  await expect(h.generate({ prompt: 'boat' }, signal())).rejects.toThrow('safe diagnostic text')
})

it('rejects edit redirects and mismatched response endpoints without following generations or another host', async () => {
  const h = setup()
  const cancel = vi.fn()
  const wrongEndpoint = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'application/json' } })
  Object.defineProperty(wrongEndpoint, 'url', { value: CODEX_IMAGES_ENDPOINT })
  const redirected = imageResponse()
  Object.defineProperty(redirected, 'redirected', { value: true })
  for (const response of [
    new Response('', { status: 307, headers: { Location: CODEX_IMAGES_ENDPOINT } }), wrongEndpoint, redirected
  ]) {
    h.fetch.mockResolvedValue(response)
    await expect(h.generate({ prompt: 'boat', images: [pngReference()] }, signal())).rejects.toThrow('重定向')
  }
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(3) // three explicit calls, no automatic fallback
  expect(h.fetch.mock.calls.every(([url, init]) => url === CODEX_IMAGE_EDITS_ENDPOINT && init?.redirect === 'error')).toBe(true)
})

it('applies the same complete PNG response checks to edits, without returning/downloads of provider URLs or JPEG', async () => {
  const badPng = Buffer.from(png)
  badPng[badPng.length - 1] ^= 1
  const h = setup()
  for (const response of [imageResponse(badPng), imageResponse(structuralJpeg()), json({ data: [{ url: 'https://private.invalid/result.png' }] })]) {
    h.fetch.mockResolvedValue(response)
    await expect(h.generate({ prompt: 'boat', images: [pngReference()] }, signal())).rejects.toMatchObject({ kind: 'protocol' })
  }
  expect(h.fetch).toHaveBeenCalledTimes(3)
  expect(h.fetch.mock.calls.every(([url]) => url === CODEX_IMAGE_EDITS_ENDPOINT)).toBe(true)
})

it('preserves auth cancellation boundaries for edits and cancels a fetch body that arrives after abort', async () => {
  const pendingAuth = deferred<typeof auth>()
  const h = setup()
  h.getAuth.mockReturnValue(pendingAuth.promise)
  const authController = new AbortController()
  const authResult = h.generate({ prompt: 'boat', images: [pngReference()] }, authController.signal)
  const authRejected = expect(authResult).rejects.toMatchObject({ kind: 'aborted' })
  authController.abort()
  await authRejected
  pendingAuth.resolve(auth)
  await Promise.resolve()
  expect(h.fetch).not.toHaveBeenCalled()

  h.getAuth.mockResolvedValue(auth)
  const pendingFetch = deferred<Response>()
  const dispatched = deferred<void>()
  h.fetch.mockImplementation(() => { dispatched.resolve(); return pendingFetch.promise })
  const controller = new AbortController()
  const result = h.generate({ prompt: 'boat', images: [pngReference()] }, controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ kind: 'aborted' })
  await dispatched.promise
  controller.abort()
  await rejected
  const cancel = vi.fn()
  pendingFetch.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })))
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(h.fetch).toHaveBeenCalledTimes(1)
  expect(h.fetch.mock.calls[0][0]).toBe(CODEX_IMAGE_EDITS_ENDPOINT)
})
