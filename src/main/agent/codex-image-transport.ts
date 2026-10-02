import { randomUUID } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  CODEX_IMAGE_MODEL_OPTIONS, MAX_IMAGE_REFERENCES, MAX_IMAGE_REFERENCE_BYTES,
  MAX_IMAGE_REFERENCE_TOTAL_BYTES, MAX_IMAGE_REFERENCE_TOTAL_PIXELS,
  MAX_IMAGE_REQUEST_DIMENSION, MAX_IMAGE_REQUEST_PIXELS,
  resolveCodexImageRequestModel, resolveCodexImageRequestQuality, resolveCodexImageRequestSize,
  type CodexImageRequestModel, type CodexImageRequestQuality, type CodexImageRequestSize
} from '../../shared/image-generation'
import { decodeImageBase64, inspectRasterImage } from '../../shared/tool-images'
import { assertGeneratedPngData } from './png-validation'

/** Codex's independent Images API, not Responses tools or API-key Images.
 * Protocol: github.com/openai/codex/blob/31519549/codex-rs/codex-api/src/images.rs
 * and codex-rs/codex-api/src/endpoint/images.rs (JSON image_url references).
 */
export const CODEX_IMAGES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations'
export const CODEX_IMAGE_EDITS_ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/edits'
export const CODEX_IMAGE_TIMEOUT_MS = 5 * 60_000
export const MAX_CODEX_IMAGE_JSON_BYTES = 24 * 1024 * 1024
export const MAX_GENERATED_IMAGE_BYTES = 16 * 1024 * 1024
export const MAX_GENERATED_IMAGE_DIMENSION = 4096
export const MAX_GENERATED_IMAGE_PIXELS = 16_000_000
export const MAX_IMAGE_PROMPT_LENGTH = 16_000
const MAX_ERROR_BODY_BYTES = 16 * 1024
const UNCERTAIN_USAGE = '请求未自动重试；失败或中止仍可能消耗图片额度，请先确认状态，不要自动再次生成。'

type ImageErrorKind = 'login' | 'entitlement' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'aborted' | 'protocol'
export class CodexImageError extends Error {
  constructor(readonly kind: ImageErrorKind, message: string) {
    super(message)
    this.name = 'CodexImageError'
  }
}
export interface CodexImageReference {
  readonly bytes: Uint8Array
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
}
export interface CodexImageRequest {
  prompt: string
  model?: CodexImageRequestModel
  size?: CodexImageRequestSize
  quality?: CodexImageRequestQuality
  images?: readonly CodexImageReference[]
}
export interface GeneratedCodexImage { bytes: Uint8Array; width: number; height: number }
export type ResolveCodexImageAuth = (options: { signal: AbortSignal; minOAuthValidityMs: number }) => ReturnType<ModelRuntime['getAuth']>
export type CodexImageGenerator = (request: CodexImageRequest, signal: AbortSignal) => Promise<GeneratedCodexImage>
export interface CodexImageTransportOptions {
  getAuth: ResolveCodexImageAuth
  fetch?: typeof globalThis.fetch
  /** Injectable for mocks; callers may shorten, never extend, the deadline. */
  timeoutMs?: number
}

export function checkedImageTimeout(value = CODEX_IMAGE_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > CODEX_IMAGE_TIMEOUT_MS) throw new Error('图片请求超时必须在 1 毫秒至 5 分钟之间。')
  return value
}

export function imageAbortError(signal: AbortSignal): CodexImageError {
  return (signal.reason instanceof CodexImageError && signal.reason.kind === 'timeout')
    || (signal.reason instanceof Error && signal.reason.name === 'TimeoutError')
    ? new CodexImageError('timeout', '图片生成请求超时。')
    : new CodexImageError('aborted', '图片生成已中止。')
}
export function checkImageAbort(signal: AbortSignal): void {
  if (signal.aborted) throw imageAbortError(signal)
}

export interface ImageAbortScope { signal: AbortSignal; dispose(): void }

/** Remove listeners/timers even on validation, authentication or body failures. */
export function createImageAbortScope(parent: AbortSignal | undefined, timeoutMs: number): ImageAbortScope {
  const deadline = checkedImageTimeout(timeoutMs)
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new CodexImageError('timeout', '图片生成请求超时。')), deadline)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort) }
  }
}

/** Also bounds injected operations which accidentally ignore the signal. */
export function waitForImageOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(imageAbortError(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => { signal.removeEventListener('abort', abort); signal.aborted ? abort() : resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); signal.aborted ? abort() : reject(error) }
    )
    if (signal.aborted) abort()
  })
}

/** No raw refresh exception is propagated: it can contain credential material. */
function accountIdFromToken(token: string): string | undefined {
  if (token.length > 32 * 1024 || /[\s\x00-\x1f\x7f]/.test(token)) return undefined
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return undefined
  try {
    // Same claim as pi's Codex adapter. This is extraction, not JWT verification;
    // only ModelRuntime's resolved OAuth token is ever used for authentication.
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object') return undefined
    const claim: unknown = (payload as Record<string, unknown>)['https://api.openai.com/auth']
    if (!claim || typeof claim !== 'object') return undefined
    const id = (claim as Record<string, unknown>).chatgpt_account_id
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : undefined
  } catch { return undefined }
}

/** Diagnostics are short, non-secret, and never contain provider asset URLs. */
export function sanitizeImageDiagnostic(value: string, secrets: readonly string[] = []): string {
  let text = value
  for (const secret of secrets) if (secret) text = text.split(secret).join('[已移除凭证]')
  return text
    .replace(/Bearer\s+[^\s"',;<>]+/gi, 'Bearer [已移除凭证]')
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[已移除凭证]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已移除凭证]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|chatgpt[_-]?account[_-]?id)\s*["']?\s*[:=]\s*["']?)[^\s"',;<>]+/gi, '$1[已移除凭证]')
    .replace(/data:[^\s"'<>]+/gi, '[已移除内嵌数据]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[已移除网址]')
    .replace(/[A-Za-z0-9+/=_-]{128,}/g, '[已移除长数据]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 400)
}

async function readBoundedBody(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new CodexImageError('protocol', '图片服务响应超过安全大小限制。')
  }
  if (!response.body) throw new CodexImageError('protocol', '图片服务返回了空响应。')
  const reader = response.body.getReader()
  // One bounded allocation, rather than an unbounded number of tiny chunks.
  const bytes = Buffer.allocUnsafe(maxBytes)
  let used = 0
  let complete = false
  let reads = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      checkImageAbort(signal)
      if (++reads > 65_536) throw new CodexImageError('protocol', '图片服务响应分片过多，已停止读取。')
      const chunk = await waitForImageOperation(reader.read(), signal)
      if (chunk.done) { complete = true; break }
      if (chunk.value.byteLength > maxBytes - used) throw new CodexImageError('protocol', '图片服务响应超过安全大小限制。')
      bytes.set(chunk.value, used)
      used += chunk.value.byteLength
    }
    checkImageAbort(signal)
    return bytes.subarray(0, used).toString('utf8')
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    try { reader.releaseLock() } catch { /* a cancelled read may still be settling */ }
  }
}

const QUOTA_CODES = new Set(['insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'usage_limit', 'usage_limit_reached', 'usage_limit_exceeded', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active'])
const ENTITLEMENT_CODES = new Set(['not_entitled', 'insufficient_entitlement', 'missing_entitlement', 'entitlement_required', 'access_denied', 'permission_denied', 'insufficient_permissions'])
const RATE_LIMIT_CODES = new Set(['rate_limit', 'rate_limit_error', 'rate_limit_exceeded'])
const UNSUPPORTED_MODEL_CODES = new Set(['model_not_found', 'unsupported_model'])
const SAFE_EDIT_ERROR_CODES = new Set([...QUOTA_CODES, ...ENTITLEMENT_CODES, ...RATE_LIMIT_CODES, ...UNSUPPORTED_MODEL_CODES])

function providerFailure(status: number, body: string, secrets: string[], requestedModel: CodexImageRequestModel, editing: boolean): CodexImageError {
  let diagnostic = ''
  let codes: string[] = []
  try {
    const parsed: unknown = JSON.parse(body)
    const error = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).error : undefined
    if (typeof error === 'string') { diagnostic = error; codes = [error] }
    else if (error && typeof error === 'object') {
      const fields = error as Record<string, unknown>
      diagnostic = [fields.code, fields.message].filter((field): field is string => typeof field === 'string').join(': ')
      codes = [fields.code, fields.type].filter((field): field is string => typeof field === 'string')
    }
  } catch { /* HTML/proxy bodies are not safe or useful model diagnostics */ }
  // With private references, arbitrary messages/codes may echo short image
  // fragments, metadata, filenames or the prompt. Redaction cannot prove such
  // text safe: retain only exact, public error codes and our fixed HTTP hints.
  diagnostic = editing ? codes.filter((code) => SAFE_EDIT_ERROR_CODES.has(code)).join(': ')
    : sanitizeImageDiagnostic(diagnostic, secrets)
  const unsupportedModel = codes.some((code) => UNSUPPORTED_MODEL_CODES.has(code))
  const suffix = diagnostic ? ` 诊断：${diagnostic}` : ''
  if (status === 401) return new CodexImageError('login', `Codex 登录已失效，请在设置中重新登录 OpenAI Codex。${suffix}`)
  if (status === 402 || codes.some((code) => QUOTA_CODES.has(code))
    || (!editing && /insufficient[_ -]?quota|quota[_ -]?(?:exceeded|exhausted)|usage[_ -]?limit|credit|billing|额度/i.test(diagnostic))) {
    return new CodexImageError('quota', `Codex 图片额度不足，请检查订阅额度或等待恢复。${suffix}`)
  }
  // Only explicit provider codes justify this hint; a bare 404 may be routing.
  if (status >= 400 && status < 500 && unsupportedModel
    && CODEX_IMAGE_MODEL_OPTIONS.some(({ id, experimental }) => id === requestedModel && experimental)) {
    return new CodexImageError('protocol', `Codex 拒绝了所选实验性请求型号；订阅兼容性及权益未验证，不会自动改用其他型号。${suffix}`)
  }
  if (status === 403 || (status < 500 && codes.some((code) => ENTITLEMENT_CODES.has(code)))) return new CodexImageError('entitlement', `当前 Codex 账号没有图片生成权益或访问权限，请检查订阅。${suffix}`)
  if (status === 429 || (status < 500 && codes.some((code) => RATE_LIMIT_CODES.has(code)))) return new CodexImageError('rate_limit', `Codex 图片生成请求过于频繁，请稍后由用户决定是否重试。${suffix}`)
  if (status >= 500) return new CodexImageError('network', `Codex 图片服务暂时不可用，请稍后检查服务状态。${suffix}`)
  return new CodexImageError('protocol', `Codex 图片服务拒绝了请求（HTTP ${status}）。${suffix}`)
}

export function inspectGeneratedPng(bytes: Uint8Array): { width: number; height: number } {
  if (!bytes.byteLength || bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) throw new CodexImageError('protocol', '生成的原图超过 16 MiB 安全限制。')
  // Before any raster decoder (including thumbnail resize) sees the bytes.
  const dimensions = inspectRasterImage(bytes, 'image/png', {
    maxDimension: MAX_GENERATED_IMAGE_DIMENSION, maxPixels: MAX_GENERATED_IMAGE_PIXELS,
    // Originals immediately go through the separate metadata inflate budget.
    allowCompressedPngMetadata: true
  })
  if (!dimensions) throw new CodexImageError('protocol', '图片服务未返回有效静态 PNG，或原图尺寸超过 4096 像素/边、1600 万像素限制。')
  try { assertGeneratedPngData(bytes, dimensions) }
  catch { throw new CodexImageError('protocol', '图片服务返回的 PNG 数据不完整、损坏或超过解码安全限制。') }
  return dimensions
}

export function validateImagePrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_IMAGE_PROMPT_LENGTH) throw new Error(`图片提示词不能为空，且不得超过 ${MAX_IMAGE_PROMPT_LENGTH} 个字符。`)
}

/** Structural JPEG walk only: no entropy/color/ICC decoding or repair. */
function hasBoundedJpegStructure(bytes: Uint8Array, dimensions: { width: number; height: number }): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2 // SOI and final EOI were checked by inspectRasterImage.
  let frame = 0
  let components = new Set<number>()
  let hasScan = false
  let inScan = false
  for (let markers = 0; markers < 4096; markers++) {
    if (inScan) {
      let entropyBytes = 0
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropyBytes++; continue }
        const start = offset++
        while (offset < bytes.length && bytes[offset] === 0xff) offset++
        if (offset >= bytes.length) return false
        const marker = bytes[offset]
        if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
          // Stuffed entropy bytes and restart markers remain inside this scan.
          if (marker === 0) entropyBytes++
          offset++
          continue
        }
        offset = start
        break
      }
      if (!entropyBytes) return false
      inScan = false
    }
    if (offset + 2 > bytes.length || bytes[offset++] !== 0xff) return false
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return false
    const marker = bytes[offset++]
    if (marker === 0xd9) return hasScan && offset === bytes.length
    // Nested SOI, stuffed bytes, restarts outside scans and unsupported frame
    // families are rejected, rather than treating the remainder as opaque.
    if (marker === 0xd8 || marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false
    if (offset + 2 > bytes.length) return false
    const length = view.getUint16(offset)
    if (length < 2 || length > bytes.length - offset) return false
    const end = offset + length
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame || hasScan || length < 8) return false
      const count = bytes[offset + 7]
      const precision = bytes[offset + 2]
      if (count < 1 || count > 4 || length !== 8 + 3 * count
        || (precision !== 8 && (marker === 0xc0 || precision !== 12))
        || view.getUint16(offset + 3) !== dimensions.height
        || view.getUint16(offset + 5) !== dimensions.width) return false
      components = new Set<number>()
      for (let index = 0; index < count; index++) {
        const start = offset + 8 + 3 * index
        const id = bytes[start]
        const sampling = bytes[start + 1]
        if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4
          || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[start + 2] > 3) return false
        components.add(id)
      }
      frame = marker
    } else if (marker === 0xda) {
      if (!frame || length < 6) return false
      const count = bytes[offset + 2]
      if (count < 1 || count > components.size || length !== 6 + 2 * count) return false
      const selected = new Set<number>()
      for (let index = 0; index < count; index++) {
        const id = bytes[offset + 3 + 2 * index]
        const tables = bytes[offset + 4 + 2 * index]
        if (!components.has(id) || selected.has(id) || (tables >> 4) > 3 || (tables & 15) > 3) return false
        selected.add(id)
      }
      const start = bytes[end - 3]
      const stop = bytes[end - 2]
      const approximation = bytes[end - 1]
      if (start > stop || stop > 63 || (approximation >> 4) > 13 || (approximation & 15) > 13) return false
      if (frame !== 0xc2 && (start !== 0 || stop !== 63 || approximation !== 0)) return false
      if (frame === 0xc2 && ((start === 0 && stop !== 0) || (start > 0 && count !== 1)
        || ((approximation >> 4) !== 0 && (approximation >> 4) !== (approximation & 15) + 1))) return false
      hasScan = true
      inScan = true
    } else if (marker === 0xdd) {
      if (length !== 4) return false // DRI
    } else if (!(marker === 0xc4 || marker === 0xdb || marker === 0xfe || (marker >= 0xe0 && marker <= 0xef))) {
      return false // DHT, DQT, COM and APPn have bounded segment envelopes.
    }
    offset = end
  }
  return false
}

/** Access native typed-array slots, not caller-overridden length/buffer getters. */
function boundedReferenceBytes(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) throw new Error('参考图片快照必须包含 Uint8Array 字节。')
  let bytes: Uint8Array
  try {
    const prototype = Object.getPrototypeOf(Uint8Array.prototype)
    bytes = new Uint8Array(Reflect.get(prototype, 'buffer', value), Reflect.get(prototype, 'byteOffset', value), Reflect.get(prototype, 'byteLength', value))
  } catch { throw new Error('参考图片快照字节不可读取。') }
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_REFERENCE_BYTES) throw new Error('每张参考图片必须非空且不超过 8 MiB。')
  return bytes
}

/** Reader/transport admission; metadata is retained and uploaded, not stripped.
 * PNG has bounded CRC/zlib/scanline/metadata checks; JPEG has bounded framing
 * and a complete final EOI only. Neither promises full color/ICC semantics or
 * full JPEG decoding. Callers must disclose metadata upload to the user.
 */
export function inspectReferenceImage(bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg'): { width: number; height: number } {
  const view = boundedReferenceBytes(bytes)
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') throw new Error('参考图片仅支持 PNG/JPEG。')
  const dimensions = inspectRasterImage(view, mimeType, {
    maxDimension: MAX_IMAGE_REQUEST_DIMENSION, maxPixels: MAX_IMAGE_REQUEST_PIXELS,
    allowCompressedPngMetadata: true
  })
  if (!dimensions) throw new Error('参考图片格式无效、MIME 不符或超过 4096 像素/边、1600 万像素限制。')
  if (mimeType === 'image/png') {
    try { assertGeneratedPngData(view, dimensions) }
    catch { throw new Error('参考 PNG 数据不完整、损坏或超过解码安全限制。') }
  } else if (!hasBoundedJpegStructure(view, dimensions)) {
    throw new Error('参考 JPEG 结构不完整或不受支持；必须以完整 EOI 结束。')
  }
  return dimensions
}

/** Fail closed on unknown fields/accessors instead of guessing request data. */
function imageRequestFields(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(message)
  const fields = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error(message)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw new Error(message)
    fields[key] = descriptor.value
  }
  return fields
}

function prepareImageRequest(request: CodexImageRequest): {
  requestedModel: CodexImageRequestModel; endpoint: string; body: string; prompt: string; editing: boolean
} {
  const fields = imageRequestFields(request, ['prompt', 'model', 'size', 'quality', 'images'], '图片请求包含不支持的字段或快照类型；不支持 mask 等额外参数。')
  const requestedModel = resolveCodexImageRequestModel(fields.model)
  const quality = resolveCodexImageRequestQuality(fields.quality)
  const size = resolveCodexImageRequestSize(fields.size)
  const prompt = fields.prompt
  validateImagePrompt(prompt)
  const images: { image_url: string }[] = []
  let totalBytes = 0
  let totalPixels = 0
  if (fields.images !== undefined) {
    const references = fields.images
    if (!Array.isArray(references) || Object.getPrototypeOf(references) !== Array.prototype
      || references.length > MAX_IMAGE_REFERENCES) throw new Error('参考图片快照必须是至多 5 张图片的数组。')
    for (const key of Reflect.ownKeys(references)) {
      if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= references.length)) throw new Error('参考图片数组包含不支持的字段。')
    }
    for (let index = 0; index < references.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(references, String(index))
      if (!descriptor || !('value' in descriptor)) throw new Error('参考图片快照数组不得为空位或访问器。')
      const reference = imageRequestFields(descriptor.value, ['bytes', 'mimeType', 'width', 'height'], '参考图片快照类型或字段无效。')
      if (reference.mimeType !== 'image/png' && reference.mimeType !== 'image/jpeg') throw new Error('参考图片仅支持 PNG/JPEG。')
      if (typeof reference.width !== 'number' || typeof reference.height !== 'number'
        || !Number.isSafeInteger(reference.width) || !Number.isSafeInteger(reference.height)
        || reference.width < 1 || reference.height < 1 || reference.width > MAX_IMAGE_REQUEST_DIMENSION
        || reference.height > MAX_IMAGE_REQUEST_DIMENSION || reference.width * reference.height > MAX_IMAGE_REQUEST_PIXELS) throw new Error('参考图片快照尺寸无效或超过安全限制。')
      const source = boundedReferenceBytes(reference.bytes)
      totalBytes += source.byteLength
      if (totalBytes > MAX_IMAGE_REFERENCE_TOTAL_BYTES) throw new Error('参考图片总字节数不能超过 16 MiB。')
      // An actual private copy, not Buffer.from(buffer)/a shared subarray. All
      // inspection and upload encoding use only this copy, even during OAuth.
      const snapshot = new Uint8Array(source)
      // Framing-only admission uses the original per-image limits, not caller
      // metadata or the remaining budget. Reject aggregate pixels before any
      // PNG CRC/metadata/raster validation can inflate another image. Invalid
      // framing still goes through inspectReferenceImage for its format error.
      const headerDimensions = inspectRasterImage(snapshot, reference.mimeType, {
        maxDimension: MAX_IMAGE_REQUEST_DIMENSION, maxPixels: MAX_IMAGE_REQUEST_PIXELS,
        allowCompressedPngMetadata: true
      })
      if (headerDimensions && headerDimensions.width * headerDimensions.height > MAX_IMAGE_REFERENCE_TOTAL_PIXELS - totalPixels) {
        throw new Error('参考图片总像素不能超过 1600 万。')
      }
      const dimensions = inspectReferenceImage(snapshot, reference.mimeType)
      if (dimensions.width !== reference.width || dimensions.height !== reference.height) throw new Error('参考图片快照尺寸与实际字节不符。')
      totalPixels += dimensions.width * dimensions.height
      if (totalPixels > MAX_IMAGE_REFERENCE_TOTAL_PIXELS) throw new Error('参考图片总像素不能超过 1600 万。')
      const encoded = Buffer.from(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength).toString('base64')
      images.push({ image_url: `data:${reference.mimeType};base64,${encoded}` })
    }
  }
  const editing = images.length > 0
  const body = JSON.stringify({ model: requestedModel, prompt, n: 1, quality, size, ...(editing ? { images } : {}) })
  if (Buffer.byteLength(body, 'utf8') > MAX_CODEX_IMAGE_JSON_BYTES) throw new Error('图片请求 JSON 超过 24 MiB 安全限制。')
  return { requestedModel, endpoint: editing ? CODEX_IMAGE_EDITS_ENDPOINT : CODEX_IMAGES_ENDPOINT, body, prompt, editing }
}

/** Created per backend, but auth is resolved only inside an approved execute. */
export function createCodexImageGenerator(options: CodexImageTransportOptions): CodexImageGenerator {
  const fetchImage = options.fetch ?? globalThis.fetch
  const timeoutMs = checkedImageTimeout(options.timeoutMs)
  return async (request, parentSignal) => {
    // Validate and serialize a private snapshot before OAuth, timers or network.
    // No caller-held object/bytes is read again after the first await.
    const { requestedModel, endpoint, body: requestBody, prompt, editing } = prepareImageRequest(request)
    const scope = createImageAbortScope(parentSignal, timeoutMs)
    const signal = scope.signal
    let dispatched = false
    try {
      checkImageAbort(signal)
      let resolved: Awaited<ReturnType<ResolveCodexImageAuth>>
      try {
        resolved = await waitForImageOperation(options.getAuth({ signal, minOAuthValidityMs: CODEX_IMAGE_TIMEOUT_MS }), signal)
      } catch {
        checkImageAbort(signal)
        throw new CodexImageError('login', '无法刷新 Codex 登录，请在设置中重新登录 OpenAI Codex。')
      }
      checkImageAbort(signal)
      const token = resolved?.source === 'OAuth' ? resolved.auth.apiKey : undefined
      const accountId = typeof token === 'string' ? accountIdFromToken(token) : undefined
      if (!token || !accountId) throw new CodexImageError('login', '请先在设置中登录 OpenAI Codex 订阅账号；此工具不使用 API key 或付费 API 回退。')
      dispatched = true
      const pending = fetchImage(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'chatgpt-account-id': accountId,
          'x-codex-image-turn-id': randomUUID(),
          originator: 'pion',
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        // Official/experimental request IDs are not actual-version evidence.
        // Reference data is inline JSON per Codex Images, never a URL download.
        body: requestBody
      })
      // If a mock/adapter resolves after cancellation, discard its body as well.
      void pending.then((response) => { if (signal.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
      const response = await waitForImageOperation(pending, signal)
      checkImageAbort(signal)
      if (response.redirected || (response.status >= 300 && response.status < 400)
        || (response.url && response.url !== endpoint)) {
        void response.body?.cancel().catch(() => {})
        throw new CodexImageError('protocol', '图片服务返回了重定向，已拒绝跟随其他地址。')
      }
      if (!response.ok) {
        let body = ''
        try { body = await readBoundedBody(response, signal, MAX_ERROR_BODY_BYTES) }
        catch { checkImageAbort(signal) }
        throw providerFailure(response.status, body, [token, accountId, prompt], requestedModel, editing)
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        void response.body?.cancel().catch(() => {})
        throw new CodexImageError('protocol', '图片服务未返回 JSON 图片响应。')
      }
      const body = await readBoundedBody(response, signal, MAX_CODEX_IMAGE_JSON_BYTES)
      let parsed: unknown
      try { parsed = JSON.parse(body) }
      catch { throw new CodexImageError('protocol', '图片服务返回了无效 JSON。') }
      const data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).data : undefined
      if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') throw new CodexImageError('protocol', '图片服务没有返回单张 PNG；不会下载外部图片地址。')
      const encoded: unknown = (data[0] as Record<string, unknown>).b64_json
      const bytes = decodeImageBase64(encoded, MAX_GENERATED_IMAGE_BYTES)
      if (!bytes) throw new CodexImageError('protocol', '图片服务返回了无效 base64，或原图超过 16 MiB 安全限制。')
      const dimensions = inspectGeneratedPng(bytes)
      checkImageAbort(signal)
      // Undocumented model echoes/headers are not actual-version evidence.
      // Image usage is not chat-token usage; do not estimate or forward it.
      return { bytes, ...dimensions }
    } catch (error) {
      const safe = signal.aborted ? imageAbortError(signal)
        : error instanceof CodexImageError ? error
          : new CodexImageError('network', '无法连接 Codex 图片服务，请检查网络。')
      throw new CodexImageError(safe.kind, `${safe.message}${dispatched ? ` ${UNCERTAIN_USAGE}` : ''}`)
    } finally { scope.dispose() }
  }
}
