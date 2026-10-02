/** Small static tool-result previews. Originals stay in the project, not IPC. */
export const MAX_TOOL_IMAGES = 4
export const MAX_TOOL_IMAGE_BYTES = 96 * 1024
export const MAX_TOOL_IMAGE_BASE64_LENGTH = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4
export const MAX_TOOL_IMAGE_DIMENSION = 512

export interface ToolResultImage {
  type: 'image'
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** Stable position in the original content array, not a generated identity. */
  partIndex: number
}

export interface ImageDimensions {
  width: number
  height: number
}

export interface RasterImageLimits {
  maxDimension: number
  maxPixels: number
  /** Only callers with their own bounded PNG inflate validator may opt in. */
  allowCompressedPngMetadata?: boolean
}

const PREVIEW_LIMITS: RasterImageLimits = {
  maxDimension: MAX_TOOL_IMAGE_DIMENSION,
  maxPixels: MAX_TOOL_IMAGE_DIMENSION ** 2
}

/** Strict, bounded base64 decoding, usable in both Node and the renderer. */
export function decodeImageBase64(data: unknown, maxBytes = MAX_TOOL_IMAGE_BYTES): Uint8Array | undefined {
  if (typeof data !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return undefined
  if (!data.length || data.length > Math.ceil(maxBytes / 3) * 4 || data.length % 4 !== 0) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  try {
    const binary = atob(data)
    if (binary.length > maxBytes || btoa(binary) !== data) return undefined
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** Inspect dimensions before any raster decoding; reject animation and SVG. */
export function inspectRasterImage(
  bytes: Uint8Array,
  mimeType: string,
  limits: RasterImageLimits = PREVIEW_LIMITS
): ImageDimensions | undefined {
  if (!Number.isSafeInteger(limits.maxDimension) || limits.maxDimension < 1
    || !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels < 1) return undefined
  const valid = (width: number, height: number): ImageDimensions | undefined => (
    width > 0 && height > 0 && width <= limits.maxDimension && height <= limits.maxDimension
      && width * height <= limits.maxPixels ? { width, height } : undefined
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mimeType === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    if (bytes.length < 45 || signature.some((byte, index) => bytes[index] !== byte)) return undefined
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return undefined
    const dimensions = valid(view.getUint32(16), view.getUint32(20))
    if (!dimensions) return undefined
    let offset = 8
    let hasImageData = false
    for (let chunks = 0; chunks < 4096 && offset + 12 <= bytes.length; chunks++) {
      const length = view.getUint32(offset)
      const type = view.getUint32(offset + 4)
      const next = offset + length + 12
      if (next > bytes.length) return undefined
      // acTL / fcTL / fdAT are APNG chunks, even if the first frame is static.
      if (type === 0x6163544c || type === 0x6663544c || type === 0x66644154) return undefined
      if (!limits.allowCompressedPngMetadata) {
        // Encoded-byte/dimension bounds alone do not bound ancillary inflate.
        // Previews never pass compressed text/profile streams to the browser.
        if (type === 0x69434350 || type === 0x7a545874) return undefined // iCCP / zTXt
        if (type === 0x69545874) { // iTXt: accept only a bounded uncompressed envelope.
          const start = offset + 8
          let keywordEnd = start
          while (keywordEnd < start + Math.min(length, 80) && bytes[keywordEnd] !== 0) keywordEnd++
          if (keywordEnd === start || keywordEnd - start > 79 || keywordEnd + 3 > start + length
            || bytes[keywordEnd] !== 0 || bytes[keywordEnd + 1] !== 0 || bytes[keywordEnd + 2] !== 0) return undefined
        }
      }
      if (offset !== 8 && type === 0x49484452) return undefined
      if (type === 0x49444154) hasImageData = true
      if (type === 0x49454e44) return length === 0 && hasImageData && next === bytes.length ? dimensions : undefined
      offset = next
    }
    return undefined
  }
  if (mimeType !== 'image/jpeg' || bytes.length < 12
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return undefined
  let offset = 2
  for (let segments = 0; segments < 4096 && offset + 4 <= bytes.length; segments++) {
    if (bytes[offset++] !== 0xff) return undefined
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return undefined
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return undefined
      return valid(view.getUint16(offset + 5), view.getUint16(offset + 3))
    }
    offset += length
  }
  return undefined
}

/** Do not let arbitrary extension results create unbounded browser decodes. */
export function collectToolImages(content: unknown): { images: ToolResultImage[]; notice?: string } {
  const images: ToolResultImage[] = []
  if (!Array.isArray(content)) return { images }
  let rejected = content.length > 128
  for (let partIndex = 0; partIndex < Math.min(content.length, 128); partIndex++) {
    const part: unknown = content[partIndex]
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'image') continue
    const { data, mimeType } = part as { data?: unknown; mimeType?: unknown }
    if (images.length >= MAX_TOOL_IMAGES || (mimeType !== 'image/png' && mimeType !== 'image/jpeg')) {
      rejected = true
      continue
    }
    const bytes = decodeImageBase64(data)
    const dimensions = bytes && inspectRasterImage(bytes, mimeType)
    if (!dimensions || typeof data !== 'string') {
      rejected = true
      continue
    }
    images.push({ type: 'image', data, mimeType, ...dimensions, partIndex })
  }
  return { images, ...(rejected ? { notice: '部分图片因格式或大小限制未显示。' } : {}) }
}
