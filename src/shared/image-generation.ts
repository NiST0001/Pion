/** First-party tool identity and non-secret persisted result metadata. */
export const IMAGE_GENERATION_TOOL_NAME = 'pion_generate_image'
/** Official Codex request alias, not proof of the resolved image-model version. */
export const CODEX_IMAGE_REQUEST_ALIAS = 'gpt-image-2'
export const CODEX_IMAGE_MODEL_OPTIONS = [
  { id: CODEX_IMAGE_REQUEST_ALIAS, label: 'Codex 自动（官方别名）', experimental: false },
  { id: 'gpt-image-2.5-flare', label: 'Images 2.5 Flare（实验性）', experimental: true },
  { id: 'gpt-image-2.5-sunburst', label: 'Images 2.5 Sunburst（实验性）', experimental: true }
] as const
export type CodexImageRequestModel = typeof CODEX_IMAGE_MODEL_OPTIONS[number]['id']

export function isCodexImageRequestModel(value: unknown): value is CodexImageRequestModel {
  return typeof value === 'string' && CODEX_IMAGE_MODEL_OPTIONS.some(({ id }) => id === value)
}

/** No aliases, whitespace repair or fallback for an explicit unsupported ID. */
export function resolveCodexImageRequestModel(value: unknown): CodexImageRequestModel {
  if (value === undefined) return CODEX_IMAGE_REQUEST_ALIAS
  if (isCodexImageRequestModel(value)) return value
  throw new Error('不支持的图片请求型号：请选择 Codex 官方别名、gpt-image-2.5-flare 或 gpt-image-2.5-sunburst；2.5 订阅兼容性未验证，不会自动降级。')
}

/** Local safety limits, not claims about the service's accepted resolutions. */
export const MAX_IMAGE_REQUEST_DIMENSION = 4096
export const MAX_IMAGE_REQUEST_PIXELS = 16_000_000
export const CODEX_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
export type CodexImageRequestQuality = typeof CODEX_IMAGE_QUALITIES[number]
export type CodexImageRequestSize = 'auto' | `${number}x${number}`
export const MAX_IMAGE_REFERENCES = 5
export const MAX_IMAGE_REFERENCE_PATH_LENGTH = 512
export const MAX_IMAGE_REFERENCE_PATHS_LENGTH = 1600
export const MAX_IMAGE_REFERENCE_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_REFERENCE_TOTAL_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_REFERENCE_TOTAL_PIXELS = 16_000_000

export function isCodexImageRequestQuality(value: unknown): value is CodexImageRequestQuality {
  return typeof value === 'string' && CODEX_IMAGE_QUALITIES.some((quality) => quality === value)
}
export function resolveCodexImageRequestQuality(value: unknown): CodexImageRequestQuality {
  if (value === undefined) return 'auto'
  if (isCodexImageRequestQuality(value)) return value
  throw new Error('图片质量必须是 auto、low、medium 或 high；不会自动改用其他质量。')
}
export function isCodexImageRequestSize(value: unknown): value is CodexImageRequestSize {
  if (value === 'auto') return true
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(value)) return false
  const [width, height] = value.split('x').map(Number)
  return width % 16 === 0 && height % 16 === 0
    && width <= MAX_IMAGE_REQUEST_DIMENSION && height <= MAX_IMAGE_REQUEST_DIMENSION
    && width * height <= MAX_IMAGE_REQUEST_PIXELS && Math.max(width, height) <= 3 * Math.min(width, height)
}
export function resolveCodexImageRequestSize(value: unknown): CodexImageRequestSize {
  if (value === undefined) return 'auto'
  if (isCodexImageRequestSize(value)) return value
  throw new Error('图片尺寸必须是 auto 或 宽x高（小写 x）；两边为 16 的倍数、每边不超过 4096、总计不超过 1600 万像素且长宽比不超过 3:1。请求尺寸不保证服务接受或精确输出。')
}

/** Pure, shared path admission; no disk reads, no repair of invalid inputs. */
export function validateImageReferencePaths(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('参考图片必须是至多 5 个项目内相对 PNG/JPEG 路径。')
  const count = value.length
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_IMAGE_REFERENCES) throw new Error('参考图片必须是至多 5 个项目内相对 PNG/JPEG 路径。')
  const paths: string[] = []
  let totalLength = 0
  // Indexed admission is bounded and never invokes a custom array iterator.
  for (let index = 0; index < count; index++) {
    const path: unknown = value[index]
    if (typeof path !== 'string' || !path || path !== path.trim()
      || path.length > MAX_IMAGE_REFERENCE_PATH_LENGTH || /[\\\x00-\x1f\x7f:<>"|?*]/.test(path)) {
      throw new Error('参考图片必须使用项目相对 PNG/JPEG 路径，不能使用网址、绝对路径或特殊路径。')
    }
    totalLength += path.length
    if (totalLength > MAX_IMAGE_REFERENCE_PATHS_LENGTH) throw new Error('参考图片路径总长度不能超过 1600 字符。')
    const normalized = path.startsWith('./') ? path.slice(2) : path
    const parts = normalized.split('/')
    if (parts.length > 32 || !/\.(?:png|jpe?g)$/i.test(parts.at(-1) ?? '') || parts.some((part) => {
      if (!part || part === '.' || part === '..' || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return true
      let bytes = 0
      for (const character of part) {
        const code = character.codePointAt(0)!
        if (code >= 0xd800 && code <= 0xdfff) return true
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
      }
      return bytes > 255
    })) throw new Error('参考图片路径不得穿越目录或包含不安全文件名；仅支持 PNG/JPEG。')
    paths.push(parts.join('/'))
  }
  return paths
}

export interface GeneratedImageDetails {
  version: 2
  provider: 'openai-codex'
  requestedModel: CodexImageRequestModel
  /** Current Codex response has no reliable resolved-version contract. */
  resolvedModel: null
  /** Workspace-relative original PNG path; never a provider asset URL. */
  path: string
  mimeType: 'image/png'
  byteLength: number
  width: number
  height: number
  previewAvailable: boolean
  /** Request settings, never claims about actual quality or exact resolution. */
  operation: 'generate' | 'edit'
  requestedSize: CodexImageRequestSize
  requestedQuality: CodexImageRequestQuality
  referenceCount: number
}

export interface GeneratedImageModelInfo {
  requestedModel: CodexImageRequestModel | null
  requestLabel: string
  experimental: boolean
  resolvedModel: null
}

/** Read v1/v2 metadata without rewriting history or trusting an echoed model.
 * v1.model was written from the request constant, never the actual engine.
 * Malformed/unknown IDs must not echo arbitrary data or hide saved previews. */
export function generatedImageModelInfo(value: unknown): GeneratedImageModelInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.provider !== 'openai-codex' || (record.version !== 1 && record.version !== 2)) return undefined
  const candidate = record.version === 1 ? record.model : record.requestedModel
  const option = CODEX_IMAGE_MODEL_OPTIONS.find(({ id }) => id === candidate)
  return {
    requestedModel: option?.id ?? null,
    requestLabel: option?.label ?? '未知请求型号',
    experimental: option?.experimental ?? false,
    // Neither a request alias nor an undocumented response echo verifies it.
    resolvedModel: null
  }
}

export interface GeneratedImageSettingsInfo {
  operation?: 'generate' | 'edit'
  requestedSize?: CodexImageRequestSize
  requestedQuality?: CodexImageRequestQuality
  referenceCount?: number
  savedWidth?: number
  savedHeight?: number
  savedByteLength?: number
}

/** Missing old settings stay unknown. One damaged field cannot hide others. */
export function generatedImageSettingsInfo(value: unknown): GeneratedImageSettingsInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.provider !== 'openai-codex' || (record.version !== 1 && record.version !== 2)) return undefined
  const info: GeneratedImageSettingsInfo = {}
  if (record.operation === 'generate' || record.operation === 'edit') info.operation = record.operation
  if (isCodexImageRequestSize(record.requestedSize)) info.requestedSize = record.requestedSize
  if (isCodexImageRequestQuality(record.requestedQuality)) info.requestedQuality = record.requestedQuality
  if (typeof record.referenceCount === 'number' && Number.isSafeInteger(record.referenceCount)
    && record.referenceCount >= 0 && record.referenceCount <= MAX_IMAGE_REFERENCES) info.referenceCount = record.referenceCount
  if (typeof record.width === 'number' && Number.isSafeInteger(record.width) && record.width > 0
    && record.width <= MAX_IMAGE_REQUEST_DIMENSION && typeof record.height === 'number'
    && Number.isSafeInteger(record.height) && record.height > 0 && record.height <= MAX_IMAGE_REQUEST_DIMENSION
    && record.width * record.height <= MAX_IMAGE_REQUEST_PIXELS) {
    info.savedWidth = record.width
    info.savedHeight = record.height
  }
  if (typeof record.byteLength === 'number' && Number.isSafeInteger(record.byteLength)
    && record.byteLength > 0 && record.byteLength <= 16 * 1024 * 1024) info.savedByteLength = record.byteLength
  return Object.keys(info).length ? info : undefined
}
