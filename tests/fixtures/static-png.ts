import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_000_000
const MAX_SCANLINE_BYTES = 48 * 1024 * 1024
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// Deliberately independent of the production validator's table-based CRC.
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length, 0)
  bytes.write(type, 4, 4, 'ascii')
  data.copy(bytes, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4)
  return bytes
}

/** Deterministic decoder-valid 8-bit RGB, non-interlaced, static PNG. No I/O. */
export function makeStaticPng(width = 1, height = 1): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('Static PNG fixture dimensions exceed their budget')
  const stride = width * 3 + 1
  const byteLength = stride * height
  if (byteLength > MAX_SCANLINE_BYTES) throw new Error('Static PNG fixture raster exceeds its budget')
  const scanlines = Buffer.alloc(byteLength, 0x40)
  for (let row = 0; row < height; row++) scanlines[row * stride] = 0 // Filter None; solid RGB (64, 64, 64).
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  // 57 bytes are signature + IHDR/IDAT/IEND framing; bound the deflate result
  // before making either the IDAT chunk or the final concatenated PNG buffer.
  const compressed = deflateSync(scanlines, { level: 9, maxOutputLength: MAX_BYTES - 57 })
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND')])
}
