import { Buffer, isUtf8 } from 'node:buffer'
import { inflateSync } from 'node:zlib'

// Repeat the caller's original-image limits so every allocation also has a
// bound when this helper is used directly. This is not a browser/image loader.
const MAX_PNG_BYTES = 16 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_000_000
const MAX_INFLATED_BYTES = 128 * 1024 * 1024
const MAX_METADATA_STREAM_BYTES = 1024 * 1024
const MAX_METADATA_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_METADATA_CHUNKS = 64
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]
] as const
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function invalid(reason: string): never {
  throw new Error(`Invalid generated PNG: ${reason}`)
}
function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
interface Header {
  width: number
  height: number
  bitDepth: number
  colorType: number
  bitsPerPixel: number
  interlaced: boolean
}
interface Pass { width: number; height: number; rowBytes: number }
interface MetadataBudget { bytes: number; chunks: number }

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) invalid('dimensions exceed the original-image limits')
}
function readHeader(data: Buffer, dimensions: { width: number; height: number }): Header {
  if (data.length !== 13) invalid('IHDR must contain exactly 13 bytes')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  assertDimensions(width, height)
  if (width !== dimensions.width || height !== dimensions.height) invalid('IHDR dimensions do not match the inspected dimensions')
  const bitDepth = data[8]
  const colorType = data[9]
  let channels: number
  switch (colorType) {
    case 0:
      if (![1, 2, 4, 8, 16].includes(bitDepth)) invalid('illegal grayscale bit depth')
      channels = 1
      break
    case 2:
      if (bitDepth !== 8 && bitDepth !== 16) invalid('illegal RGB bit depth')
      channels = 3
      break
    case 3:
      if (![1, 2, 4, 8].includes(bitDepth)) invalid('illegal indexed bit depth')
      channels = 1
      break
    case 4:
    case 6:
      if (bitDepth !== 8 && bitDepth !== 16) invalid('illegal alpha bit depth')
      channels = colorType === 4 ? 2 : 4
      break
    default: invalid('unknown IHDR color type')
  }
  if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) invalid('unsupported IHDR compression, filter or interlace method')
  return { width, height, bitDepth, colorType, bitsPerPixel: bitDepth * channels, interlaced: data[12] === 1 }
}
function scanlinePasses(header: Header): Pass[] {
  const passes: Pass[] = [] // At most seven fixed-size records; no pixel arrays.
  for (const [x, y, dx, dy] of header.interlaced ? ADAM7 : [[0, 0, 1, 1]]) {
    const width = Math.max(0, Math.ceil((header.width - x) / dx))
    const height = Math.max(0, Math.ceil((header.height - y) / dy))
    if (width && height) passes.push({ width, height, rowBytes: Math.ceil(width * header.bitsPerPixel / 8) })
  }
  return passes
}

/** Default finishFlush is intentionally unchanged: truncated streams must fail.
 * Node's info result exposes consumed input, so a second stream/trailing junk
 * cannot be silently ignored. @types/node types this overload as Buffer only. */
function inflateComplete(data: Buffer, maxOutputLength: number, label: string): Buffer {
  if (!data.length || maxOutputLength < 1 || maxOutputLength > MAX_INFLATED_BYTES) invalid(`${label} has an invalid inflate budget`)
  let result: { buffer: Buffer; engine: { bytesWritten: number } }
  try {
    result = inflateSync(data, { maxOutputLength, info: true }) as unknown as typeof result
  } catch {
    invalid(`${label} has invalid zlib data or exceeds its inflate budget`)
  }
  if (!Buffer.isBuffer(result.buffer) || result.buffer.length > maxOutputLength
    || result.engine.bytesWritten !== data.length) invalid(`${label} has trailing or incomplete zlib data`)
  return result.buffer
}
function keywordEnd(data: Buffer): number {
  const end = data.indexOf(0)
  if (end < 1 || end > 79 || data[0] === 32 || data[end - 1] === 32) invalid('invalid metadata keyword')
  for (let index = 0; index < end; index++) {
    const value = data[index]
    if (!((value >= 32 && value <= 126) || value >= 161) || (value === 32 && data[index - 1] === 32)) invalid('invalid metadata keyword')
  }
  return end
}
function metadataPayload(data: Buffer, compressed: boolean, label: string, budget: MetadataBudget): Buffer {
  const remaining = Math.min(MAX_METADATA_STREAM_BYTES, MAX_METADATA_TOTAL_BYTES - budget.bytes)
  const output = compressed ? inflateComplete(data, Math.max(1, remaining), label) : data
  if (output.length > remaining) invalid('metadata exceeds its decoded byte budget')
  budget.bytes += output.length
  return output
}
function assertMetadata(type: string, data: Buffer, budget: MetadataBudget): void {
  if (++budget.chunks > MAX_METADATA_CHUNKS) invalid('too many text/profile metadata chunks')
  const end = keywordEnd(data)
  if (type === 'tEXt') {
    const text = metadataPayload(data.subarray(end + 1), false, type, budget)
    if (text.includes(0)) invalid('tEXt contains a null character')
    return
  }
  if (type === 'iCCP' || type === 'zTXt') {
    if (data[end + 1] !== 0) invalid(`${type} has an invalid compression method`)
    const output = metadataPayload(data.subarray(end + 2), true, type, budget)
    if (type === 'iCCP' && !output.length) invalid('iCCP contains an empty profile')
    if (type === 'zTXt' && output.includes(0)) invalid('zTXt contains a null character')
    return
  }
  const flag = data[end + 1]
  if ((flag !== 0 && flag !== 1) || data[end + 2] !== 0) invalid('iTXt has an invalid compression flag/method')
  const languageStart = end + 3
  const languageEnd = data.indexOf(0, languageStart)
  const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1)
  if (languageEnd < 0 || translatedEnd < 0 || translatedEnd - languageStart > MAX_METADATA_STREAM_BYTES) invalid('invalid iTXt header')
  for (let index = languageStart; index < languageEnd; index++) {
    const value = data[index]
    if (!(value === 45 || (value >= 48 && value <= 57) || (value >= 65 && value <= 90) || (value >= 97 && value <= 122))) invalid('invalid iTXt language tag')
  }
  if (!isUtf8(data.subarray(languageEnd + 1, translatedEnd))) invalid('invalid iTXt translated keyword UTF-8')
  const text = metadataPayload(data.subarray(translatedEnd + 1), flag === 1, type, budget)
  if (text.includes(0) || !isUtf8(text)) invalid('invalid iTXt text UTF-8')
}
function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft
  const dl = Math.abs(prediction - left)
  const da = Math.abs(prediction - above)
  const du = Math.abs(prediction - upperLeft)
  return dl <= da && dl <= du ? left : da <= du ? above : upperLeft
}
function assertScanlines(data: Buffer, passes: Pass[], header: Header, paletteEntries: number): void {
  let offset = 0
  // Any filtered byte sequence is reconstructible for non-indexed colors. For
  // a short indexed palette, unfilter in the already-bounded inflate buffer to
  // check actual indices (including packed pixels), not the filtered bytes.
  const checkIndices = header.colorType === 3 && paletteEntries < 2 ** header.bitDepth
  for (const pass of passes) {
    let previous = -1 // Adam7 resets the previous scanline for each pass.
    for (let row = 0; row < pass.height; row++) {
      const filter = data[offset]
      if (filter > 4) invalid('scanline has an invalid filter type')
      const start = offset + 1
      if (checkIndices) {
        for (let column = 0; column < pass.rowBytes; column++) {
          const left = column ? data[start + column - 1] : 0
          const above = previous < 0 ? 0 : data[previous + column]
          const upperLeft = previous < 0 || !column ? 0 : data[previous + column - 1]
          const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft)
          data[start + column] = (data[start + column] + predictor) & 0xff
        }
        const mask = (1 << header.bitDepth) - 1
        for (let pixel = 0; pixel < pass.width; pixel++) {
          const bit = pixel * header.bitDepth
          const index = (data[start + Math.floor(bit / 8)] >>> (8 - header.bitDepth - bit % 8)) & mask
          if (index >= paletteEntries) invalid('scanline references an absent palette entry')
        }
      }
      previous = start
      offset += pass.rowBytes + 1
    }
  }
  if (offset !== data.length) invalid('incorrect scanline byte count')
}
function assertSampleValues(data: Buffer, maxValue: number): void {
  for (let offset = 0; offset < data.length; offset += 2) {
    if (data.readUInt16BE(offset) > maxValue) invalid('ancillary sample exceeds the IHDR bit depth')
  }
}

/** Validate bounded, static PNG data before committing the original file.
 * Supports every standard color/bit-depth combination and Adam7. Checks chunk
 * CRCs, raster zlib integrity, exact scanline geometry, filters and palette
 * indices. Text/ICC inflate streams are capped at 1 MiB each / 4 MiB total and
 * 64 chunks. Unknown ancillary chunks are ignored after framing/CRC checks.
 * This is NOT a complete color-rendering/ICC-profile semantic validation and
 * does not claim equivalence to a particular image decoder's rendered output.
 */
export function assertGeneratedPngData(bytes: Uint8Array, dimensions: { width: number; height: number }): void {
  assertDimensions(dimensions.width, dimensions.height)
  if (bytes.byteLength < 57 || bytes.byteLength > MAX_PNG_BYTES) invalid('invalid original-image byte size')
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) // Zero-copy, including nonzero byte offsets.
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) invalid('incorrect PNG signature')
  let header: Header | undefined
  let paletteEntries = 0
  let idatStart = -1
  let idatEnd = -1
  let idatBytes = 0
  let idatClosed = false
  let ended = false
  const seen = new Set<string>() // Only fixed known singleton names are added.
  const metadataBudget: MetadataBudget = { bytes: 0, chunks: 0 }
  const singleton = (type: string) => {
    if (seen.has(type)) invalid(`duplicate ${type}`)
    seen.add(type)
  }
  const beforeData = (type: string, beforePalette = false) => {
    if (idatStart !== -1 || (beforePalette && paletteEntries)) invalid(`${type} is out of order`)
  }
  let offset = 8
  while (offset < png.length) {
    if (png.length - offset < 12) invalid('truncated chunk framing')
    const length = png.readUInt32BE(offset)
    if (length > 0x7fffffff || length > png.length - offset - 12) invalid('truncated or oversized chunk payload')
    for (let index = offset + 4; index < offset + 8; index++) {
      const value = png[index]
      if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) invalid('invalid chunk type')
    }
    if (png[offset + 6] & 32) invalid('chunk type uses the reserved lowercase bit')
    const type = png.toString('ascii', offset + 4, offset + 8)
    const end = offset + length + 12
    if (crc32(png, offset + 4, end - 4) !== png.readUInt32BE(end - 4)) invalid(`${type} CRC mismatch`)
    const data = png.subarray(offset + 8, end - 4)
    if (offset === 8) {
      if (type !== 'IHDR') invalid('IHDR must be the first chunk')
      header = readHeader(data, dimensions)
      offset = end
      continue
    }
    if (!header) invalid('missing IHDR')
    if (type !== 'IDAT' && idatStart !== -1) idatClosed = true
    switch (type) {
      case 'IHDR': invalid('duplicate IHDR')
      case 'PLTE':
        beforeData(type)
        if (paletteEntries || seen.has('tRNS') || seen.has('bKGD') || header.colorType === 0 || header.colorType === 4
          || !length || length % 3 !== 0 || length > 768) invalid('invalid PLTE or palette ordering')
        paletteEntries = length / 3
        if (header.colorType === 3 && paletteEntries > 2 ** header.bitDepth) invalid('PLTE exceeds the indexed bit depth')
        break
      case 'IDAT':
        if (idatClosed) invalid('IDAT chunks must be consecutive')
        if (header.colorType === 3 && !paletteEntries) invalid('indexed PNG is missing PLTE before IDAT')
        if (idatStart === -1) idatStart = offset
        idatEnd = end
        idatBytes += length // Bounded by the 16 MiB input, including empty fragments.
        break
      case 'IEND':
        if (length || idatStart === -1 || !idatBytes) invalid('invalid IEND or missing nonempty IDAT stream')
        if (end !== png.length) invalid('trailing data after IEND')
        ended = true
        break
      case 'acTL': case 'fcTL': case 'fdAT': invalid('animated PNG is unsupported')
      case 'tRNS':
        beforeData(type)
        singleton(type)
        if (header.colorType === 3) {
          if (!paletteEntries || !length || length > paletteEntries) invalid('invalid indexed tRNS')
        } else if (header.colorType === 0 || header.colorType === 2) {
          if (length !== (header.colorType === 0 ? 2 : 6)) invalid('invalid tRNS length')
          assertSampleValues(data, 2 ** header.bitDepth - 1)
        } else invalid('tRNS is forbidden for alpha color types')
        break
      case 'bKGD':
        beforeData(type)
        singleton(type)
        if (header.colorType === 3) {
          if (length !== 1 || !paletteEntries || data[0] >= paletteEntries) invalid('invalid indexed bKGD')
        } else {
          if (length !== (header.colorType === 0 || header.colorType === 4 ? 2 : 6)) invalid('invalid bKGD length')
          assertSampleValues(data, 2 ** header.bitDepth - 1)
        }
        break
      case 'hIST':
        beforeData(type)
        singleton(type)
        if (!paletteEntries || length !== paletteEntries * 2) invalid('invalid hIST')
        break
      case 'sBIT': {
        beforeData(type, true)
        singleton(type)
        const samples = header.colorType === 0 ? 1 : header.colorType === 4 ? 2 : header.colorType === 6 ? 4 : 3
        const maxBits = header.colorType === 3 ? 8 : header.bitDepth
        if (length !== samples || data.some((value) => value < 1 || value > maxBits)) invalid('invalid sBIT')
        break
      }
      case 'gAMA': case 'cHRM': case 'sRGB':
        beforeData(type, true)
        singleton(type)
        if ((type === 'gAMA' && (length !== 4 || !data.readUInt32BE(0)))
          || (type === 'cHRM' && length !== 32)
          || (type === 'sRGB' && (length !== 1 || data[0] > 3 || seen.has('iCCP')))) invalid(`invalid ${type}`)
        break
      case 'iCCP':
        beforeData(type, true)
        singleton(type)
        if (seen.has('sRGB')) invalid('iCCP and sRGB are mutually exclusive')
        assertMetadata(type, data, metadataBudget)
        break
      case 'tEXt': case 'zTXt': case 'iTXt':
        assertMetadata(type, data, metadataBudget)
        break
      default:
        if (!(png[offset + 4] & 32)) invalid('unknown critical chunk')
    }
    offset = end
    if (ended) break
  }
  if (!ended || !header) invalid('missing IEND')
  const passes = scanlinePasses(header)
  const expectedBytes = passes.reduce((sum, pass) => sum + (pass.rowBytes + 1) * pass.height, 0)
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_INFLATED_BYTES) invalid('raster exceeds the 128 MiB inflate budget')
  // No per-chunk array: a malicious file cannot create unbounded chunk records.
  // The only compressed-data allocation is <= the already-bounded input size.
  const compressed = Buffer.allocUnsafe(idatBytes)
  let written = 0
  for (let position = idatStart; position < idatEnd;) {
    const length = png.readUInt32BE(position)
    png.copy(compressed, written, position + 8, position + 8 + length)
    written += length
    position += length + 12
  }
  const scanlines = inflateComplete(compressed, expectedBytes, 'IDAT')
  if (scanlines.length !== expectedBytes) invalid('incorrect scanline byte count')
  assertScanlines(scanlines, passes, header, paletteEntries)
}
