import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  collectToolImages,
  decodeImageBase64,
  inspectRasterImage,
  MAX_TOOL_IMAGE_BASE64_LENGTH,
  MAX_TOOL_IMAGE_BYTES,
  MAX_TOOL_IMAGE_DIMENSION,
  MAX_TOOL_IMAGES
} from '../../src/shared/tool-images'

// Synthetic metadata fixtures, not decoder-valid images: CRCs are deliberately
// zero and IDAT/JPEG entropy data is not encoded. The helper checks base64,
// bounded structure and dimensions, not CRCs or successful raster decoding.
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const JPEG_SOI = Uint8Array.of(0xff, 0xd8)
const JPEG_EOI = Uint8Array.of(0xff, 0xd9)
const REJECTION_NOTICE = '部分图片因格式或大小限制未显示。'

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

function pngChunk(type: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(payload.length + 12)
  new DataView(bytes.buffer).setUint32(0, payload.length)
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index)
  bytes.set(payload, 8)
  return bytes // Last four bytes are a placeholder CRC, not a computed checksum.
}

function pngHeader(width = 1, height = 1): Uint8Array {
  const payload = new Uint8Array(13)
  const view = new DataView(payload.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  payload.set([8, 2, 0, 0, 0], 8)
  return pngChunk('IHDR', payload)
}

function png(
  width = 1,
  height = 1,
  chunks = [pngChunk('IDAT', Uint8Array.of(0)), pngChunk('IEND')]
): Uint8Array {
  return concatBytes(PNG_SIGNATURE, pngHeader(width, height), ...chunks)
}

function pngWithByteLength(byteLength: number): Uint8Array {
  // Signature + IHDR + IDAT framing + IEND occupy 57 bytes; no raster allocated.
  return png(1, 1, [pngChunk('IDAT', new Uint8Array(byteLength - 57)), pngChunk('IEND')])
}

function jpegSegment(marker: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(payload.length + 4)
  bytes.set([0xff, marker])
  new DataView(bytes.buffer).setUint16(2, payload.length + 2)
  bytes.set(payload, 4)
  return bytes
}

function jpegFrame(marker = 0xc0, width = 1, height = 1): Uint8Array {
  const payload = Uint8Array.of(8, 0, 0, 0, 0, 1, 1, 0x11, 0)
  const view = new DataView(payload.buffer)
  view.setUint16(1, height)
  view.setUint16(3, width)
  return jpegSegment(marker, payload)
}

function jpeg(width = 1, height = 1, marker = 0xc0, prefix: Uint8Array[] = []): Uint8Array {
  return concatBytes(JPEG_SOI, ...prefix, jpegFrame(marker, width, height), JPEG_EOI)
}

function withUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice()
  new DataView(copy.buffer).setUint32(offset, value)
  return copy
}

function withUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice()
  new DataView(copy.buffer).setUint16(offset, value)
  return copy
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const imagePart = (bytes = png(), mimeType: unknown = 'image/png') => ({
  type: 'image', data: base64(bytes), mimeType
})

function raster(mimeType: string, width = 1, height = 1): Uint8Array {
  return mimeType === 'image/png' ? png(width, height) : jpeg(width, height)
}

describe('decodeImageBase64', () => {
  it.each([
    { data: 'AQID', bytes: [1, 2, 3] },
    { data: 'AQI=', bytes: [1, 2] },
    { data: 'AQ==', bytes: [1] },
    { data: 'AA==', bytes: [0] },
    { data: '+/8=', bytes: [251, 255] }
  ])('accepts canonical base64 $data with the required padding', ({ data, bytes }) => {
    expect(decodeImageBase64(data)).toEqual(Uint8Array.from(bytes))
  })

  it.each([
    '', 'Zg', 'Zg=', 'Zg===', 'AAAA====', 'A===', '====', 'AA=A', 'Zg==AAAA',
    ' Zg== ', 'Z g=', 'Zg==\n', 'Zg==\r\n', 'Zg==\t', '_w==', '-w==', 'AA*=', 'éQ==',
    'data:image/png;base64,Zg=='
  ])('rejects malformed, nonstandard or unpadded base64 %j', (data) => {
    expect(decodeImageBase64(data)).toBeUndefined()
  })

  it.each(['Zh==', 'Zm9=', 'AR==', 'AQJ='])('rejects nonzero unused pad bits in %s', (data) => {
    expect(decodeImageBase64(data)).toBeUndefined()
  })

  it('rejects non-string data and invalid byte budgets', () => {
    for (const data of [undefined, null, false, 42, {}, [], Uint8Array.of(1)]) {
      expect(decodeImageBase64(data)).toBeUndefined()
    }
    for (const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decodeImageBase64('AQ==', maxBytes)).toBeUndefined()
    }
  })

  it.each([1, 2, 3, 4])('enforces the decoded byte budget of %i despite base64 rounding', (maxBytes) => {
    const exact = Uint8Array.from({ length: maxBytes }, (_, index) => index)
    const over = Uint8Array.from({ length: maxBytes + 1 }, (_, index) => index)
    expect(decodeImageBase64(base64(exact), maxBytes)).toEqual(exact)
    expect(decodeImageBase64(base64(over), maxBytes)).toBeUndefined()
    // For these budgets an extra byte still fits the same base64 length ceiling.
    if (maxBytes % 3 !== 0) expect(base64(over).length).toBe(base64(exact).length)
  })

  it('accepts exactly 96 KiB decoded / 128 KiB base64, but not the next quartet', () => {
    expect(MAX_TOOL_IMAGE_BYTES).toBe(96 * 1024)
    expect(MAX_TOOL_IMAGE_BASE64_LENGTH).toBe(128 * 1024)
    const exact = base64(new Uint8Array(MAX_TOOL_IMAGE_BYTES))
    expect(exact).toHaveLength(MAX_TOOL_IMAGE_BASE64_LENGTH)
    expect(decodeImageBase64(exact)?.length).toBe(MAX_TOOL_IMAGE_BYTES)
    expect(decodeImageBase64(`${exact}AAAA`)).toBeUndefined()
  })
})

describe('inspectRasterImage PNG structure', () => {
  it('reads static dimensions through complete chunks, without decoding payloads or checking CRCs', () => {
    const bytes = png(23, 17, [
      pngChunk('tEXt', Uint8Array.of(65, 0, 66)),
      pngChunk('IDAT', Uint8Array.of(0)),
      pngChunk('IDAT', Uint8Array.of(1)),
      pngChunk('IEND')
    ])
    expect(inspectRasterImage(bytes, 'image/png')).toEqual({ width: 23, height: 17 })
  })

  it.each(['iCCP', 'zTXt'])('rejects compressed %s metadata in previews before browser decode', (type) => {
    const bytes = png(1, 1, [pngChunk(type, Uint8Array.of(65, 0, 0, 0x78, 0x9c)), pngChunk('IDAT'), pngChunk('IEND')])
    expect(inspectRasterImage(bytes, 'image/png')).toBeUndefined()
    expect(collectToolImages([imagePart(bytes)])).toEqual({ images: [], notice: REJECTION_NOTICE })
    // Opt-in is metadata inspection only; the original caller must validate
    // the zlib stream separately before allowing any real image decoder.
    expect(inspectRasterImage(bytes, 'image/png', {
      maxDimension: 512, maxPixels: 512 ** 2, allowCompressedPngMetadata: true
    })).toEqual({ width: 1, height: 1 })
  })

  it('accepts uncompressed iTXt but rejects compressed or malformed preview envelopes', () => {
    const uncompressed = Uint8Array.of(65, 0, 0, 0, 0, 0, 66)
    const build = (payload: Uint8Array) => png(1, 1, [pngChunk('iTXt', payload), pngChunk('IDAT'), pngChunk('IEND')])
    expect(inspectRasterImage(build(uncompressed), 'image/png')).toEqual({ width: 1, height: 1 })
    for (const payload of [Uint8Array.of(65, 0, 1, 0, 0, 0, 66), Uint8Array.of(65, 0, 0, 1), Uint8Array.of(65, 0), Uint8Array.of(65), new Uint8Array(81).fill(65)]) {
      expect(inspectRasterImage(build(payload), 'image/png')).toBeUndefined()
    }
  })

  it('walks chunk boundaries rather than treating nested payload bytes as chunk headers', () => {
    const bytes = png(3, 2, [
      pngChunk('tEXt', concatBytes(pngChunk('acTL'), pngHeader(), pngChunk('IEND'))),
      pngChunk('IDAT', Uint8Array.of(0)),
      pngChunk('IEND')
    ])
    expect(inspectRasterImage(bytes, 'image/png')).toEqual({ width: 3, height: 2 })
  })

  it.each(['acTL', 'fcTL', 'fdAT'])('rejects APNG %s both before and after the first IDAT', (type) => {
    const idat = pngChunk('IDAT', Uint8Array.of(0))
    const animation = pngChunk(type, new Uint8Array(8))
    for (const chunks of [[animation, idat], [idat, animation]]) {
      expect(inspectRasterImage(png(1, 1, [...chunks, pngChunk('IEND')]), 'image/png')).toBeUndefined()
    }
  })

  it('requires the exact signature and an initial 13-byte IHDR', () => {
    for (const bytes of [
      png().slice(0, 44),
      concatBytes(Uint8Array.of(0), png().subarray(1)),
      withUint32(png(), 8, 12),
      withUint32(png(), 8, 14),
      withUint32(png(), 12, 0x74455874)
    ]) expect(inspectRasterImage(bytes, 'image/png')).toBeUndefined()
  })

  it.each([
    { name: 'missing IEND', bytes: png(1, 1, [pngChunk('IDAT', Uint8Array.of(0))]) },
    { name: 'truncated IDAT payload', bytes: concatBytes(PNG_SIGNATURE, pngHeader(), pngChunk('IDAT', new Uint8Array(8)).slice(0, -5)) },
    { name: 'missing IDAT CRC', bytes: concatBytes(PNG_SIGNATURE, pngHeader(), pngChunk('IDAT', new Uint8Array(8)).slice(0, -4)) },
    { name: 'partial IDAT CRC', bytes: concatBytes(PNG_SIGNATURE, pngHeader(), pngChunk('IDAT', new Uint8Array(8)).slice(0, -1)) },
    { name: 'incomplete IEND header', bytes: png().slice(0, -8) },
    { name: 'partial IEND CRC', bytes: png().slice(0, -1) },
    { name: 'no IDAT before IEND', bytes: png(1, 1, [pngChunk('IEND')]) },
    { name: 'nonempty IEND', bytes: png(1, 1, [pngChunk('IDAT'), pngChunk('IEND', Uint8Array.of(0))]) },
    { name: 'trailing bytes after IEND', bytes: concatBytes(png(), Uint8Array.of(0)) },
    { name: 'second IEND', bytes: concatBytes(png(), pngChunk('IEND')) },
    { name: 'duplicate IHDR before IDAT', bytes: png(1, 1, [pngHeader(), pngChunk('IDAT'), pngChunk('IEND')]) },
    { name: 'duplicate IHDR after IDAT', bytes: png(1, 1, [pngChunk('IDAT'), pngHeader(), pngChunk('IEND')]) },
    { name: '32-bit chunk length overrun', bytes: withUint32(png(), 33, 0xffffffff) }
  ])('rejects $name without reading beyond the complete chunk range', ({ bytes }) => {
    expect(inspectRasterImage(bytes, 'image/png')).toBeUndefined()
  })

  it('rejects large unsigned IHDR dimensions instead of treating them as signed values', () => {
    expect(inspectRasterImage(png(0x80000000, 1), 'image/png')).toBeUndefined()
    expect(inspectRasterImage(png(1, 0xffffffff), 'image/png')).toBeUndefined()
  })
})

describe('inspectRasterImage JPEG structure', () => {
  it.each([
    { mode: 'baseline', marker: 0xc0 },
    { mode: 'progressive', marker: 0xc2 }
  ])('reads $mode SOF dimensions after bounded metadata segments', ({ marker }) => {
    const bytes = jpeg(341, 127, marker, [
      jpegSegment(0xe0, Uint8Array.of(0xff, 0xda, 0xff, 0xc0)),
      jpegSegment(0xfe, Uint8Array.of(65, 66))
    ])
    // A complete SOF and terminal EOI suffice for metadata inspection, not decoding.
    expect(inspectRasterImage(bytes, 'image/jpeg')).toEqual({ width: 341, height: 127 })
  })

  it.each([
    { name: 'missing SOI', bytes: jpeg().slice(2) },
    { name: 'missing EOI', bytes: jpeg().slice(0, -2) },
    { name: 'wrong EOI', bytes: concatBytes(jpeg().slice(0, -1), Uint8Array.of(0)) },
    { name: 'non-marker segment prefix', bytes: jpeg(1, 1, 0xc0, [Uint8Array.of(0, 0, 0, 0)]) },
    { name: 'zero segment length', bytes: jpeg(1, 1, 0xc0, [Uint8Array.of(0xff, 0xe0, 0, 0)]) },
    { name: 'one-byte segment length', bytes: jpeg(1, 1, 0xc0, [Uint8Array.of(0xff, 0xe0, 0, 1)]) },
    { name: 'metadata segment overrun', bytes: jpeg(1, 1, 0xc0, [Uint8Array.of(0xff, 0xe0, 0xff, 0xff)]) },
    { name: 'truncated metadata segment', bytes: concatBytes(JPEG_SOI, jpegSegment(0xe0, new Uint8Array(8)).slice(0, -3), JPEG_EOI) },
    { name: 'too-short SOF', bytes: concatBytes(JPEG_SOI, jpegSegment(0xc0, new Uint8Array(5)), JPEG_EOI) },
    { name: 'truncated baseline SOF', bytes: concatBytes(JPEG_SOI, jpegFrame(0xc0).slice(0, -3), JPEG_EOI) },
    { name: 'truncated progressive SOF', bytes: concatBytes(JPEG_SOI, jpegFrame(0xc2).slice(0, -3), JPEG_EOI) },
    { name: 'SOF segment overrun', bytes: withUint16(jpeg(), 4, 0xffff) },
    { name: 'SOS before SOF', bytes: jpeg(1, 1, 0xc0, [jpegSegment(0xda, new Uint8Array(6))]) },
    { name: 'EOI before SOF', bytes: jpeg(1, 1, 0xc0, [JPEG_EOI]) },
    { name: 'unsupported SOF marker', bytes: jpeg(1, 1, 0xc3) }
  ])('rejects $name during bounded header inspection', ({ bytes }) => {
    expect(inspectRasterImage(bytes, 'image/jpeg')).toBeUndefined()
  })
})

describe('inspectRasterImage limits', () => {
  it.each(['image/png', 'image/jpeg'])('enforces dimensions and pixel budgets for %s', (mimeType) => {
    expect(MAX_TOOL_IMAGE_DIMENSION).toBe(512)
    expect(inspectRasterImage(raster(mimeType, 512, 512), mimeType)).toEqual({ width: 512, height: 512 })
    for (const [width, height] of [[0, 1], [1, 0], [513, 1], [1, 513]]) {
      expect(inspectRasterImage(raster(mimeType, width, height), mimeType)).toBeUndefined()
    }
    const limits = { maxDimension: 16, maxPixels: 63 }
    expect(inspectRasterImage(raster(mimeType, 9, 7), mimeType, limits)).toEqual({ width: 9, height: 7 })
    expect(inspectRasterImage(raster(mimeType, 8, 8), mimeType, limits)).toBeUndefined()
    expect(inspectRasterImage(raster(mimeType, 17, 1), mimeType, limits)).toBeUndefined()
  })

  it('rejects invalid dimension and pixel budgets', () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(inspectRasterImage(png(), 'image/png', { maxDimension: invalid, maxPixels: 1 })).toBeUndefined()
      expect(inspectRasterImage(png(), 'image/png', { maxDimension: 1, maxPixels: invalid })).toBeUndefined()
    }
  })

  it.each(['image/png', 'image/jpeg'])('respects nonzero Uint8Array offsets for %s', (mimeType) => {
    const bytes = raster(mimeType, 13, 7)
    const backing = concatBytes(Uint8Array.of(1, 2, 3), bytes, Uint8Array.of(4, 5))
    const view = backing.subarray(3, 3 + bytes.length)
    expect(inspectRasterImage(view, mimeType)).toEqual({ width: 13, height: 7 })
  })

  it('does not sniff another format when MIME is absent, unsupported or mismatched', () => {
    for (const mimeType of ['', 'image/gif', 'image/webp', 'image/svg+xml', 'image/jpg', 'IMAGE/PNG', 'image/png; charset=utf-8']) {
      expect(inspectRasterImage(png(), mimeType)).toBeUndefined()
    }
    expect(inspectRasterImage(png(), 'image/jpeg')).toBeUndefined()
    expect(inspectRasterImage(jpeg(), 'image/png')).toBeUndefined()
  })
})

describe('collectToolImages', () => {
  it('returns only an empty list for non-array content and ignored non-image parts', () => {
    for (const content of [undefined, null, false, 1, 'text', {}, imagePart()]) {
      expect(collectToolImages(content)).toEqual({ images: [] })
    }
    expect(collectToolImages([
      undefined, null, false, 1, 'text', {}, [],
      { type: 'text', data: base64(png()), mimeType: 'image/png' },
      { type: 'image_url', url: 'https://example.invalid/image.png' },
      { type: 'Image', data: base64(png()), mimeType: 'image/png' }
    ])).toEqual({ images: [] })
  })

  it.each([
    { name: 'missing data', part: { type: 'image', mimeType: 'image/png' } },
    { name: 'wrong data field', part: { type: 'image', mimeType: 'image/png', base64: base64(png()) } },
    { name: 'missing MIME', part: { type: 'image', data: base64(png()) } },
    { name: 'wrong MIME field', part: { type: 'image', data: base64(png()), mime: 'image/png' } },
    { name: 'invalid base64', part: { ...imagePart(), data: 'not-base64' } },
    // The last pad bits are changed, while the decoded PNG bytes stay identical.
    { name: 'noncanonical base64', part: { ...imagePart(), data: `${base64(png()).slice(0, -3)}B==` } },
    { name: 'data URL instead of base64', part: { ...imagePart(), data: `data:image/png;base64,${base64(png())}` } },
    { name: 'truncated PNG', part: imagePart(png().slice(0, -1)) },
    { name: 'APNG', part: imagePart(png(1, 1, [pngChunk('IDAT'), pngChunk('acTL'), pngChunk('IEND')])) },
    { name: 'PNG labeled JPEG', part: imagePart(png(), 'image/jpeg') },
    { name: 'JPEG labeled PNG', part: imagePart(jpeg(), 'image/png') }
  ])('reports rejected image parts with $name', ({ part }) => {
    expect(collectToolImages([part])).toEqual({ images: [], notice: REJECTION_NOTICE })
  })

  it('rejects non-string data fields instead of accepting binary or coerced data', () => {
    for (const data of [undefined, null, 1, false, png(), {}, [base64(png())]]) {
      expect(collectToolImages([{ type: 'image', data, mimeType: 'image/png' }]))
        .toEqual({ images: [], notice: REJECTION_NOTICE })
    }
  })

  it.each([
    'image/gif', 'image/webp', 'image/svg+xml', 'image/apng', 'image/jpg',
    'IMAGE/PNG', 'image/png; charset=utf-8', 'application/octet-stream', '', null, 1
  ])('rejects unsupported or non-exact MIME %j', (mimeType) => {
    expect(collectToolImages([imagePart(png(), mimeType)])).toEqual({ images: [], notice: REJECTION_NOTICE })
  })

  it('derives dimensions and partIndex from bytes/content, not caller metadata', () => {
    const part = { ...imagePart(png(7, 3)), width: 9999, height: -1, partIndex: 100, extra: 'not copied' }
    expect(collectToolImages([{ type: 'text', text: 'before' }, part])).toEqual({
      images: [{ type: 'image', data: part.data, mimeType: 'image/png', width: 7, height: 3, partIndex: 1 }]
    })
    const oversized = { ...imagePart(png(513, 1)), width: 1, height: 1 }
    expect(collectToolImages([oversized])).toEqual({ images: [], notice: REJECTION_NOTICE })
  })

  it('keeps original partIndex values and image order across mixed valid, ignored and rejected parts', () => {
    const first = imagePart(png(12, 7))
    const second = imagePart(jpeg(9, 5, 0xc2), 'image/jpeg')
    const third = imagePart(png(2, 3))
    const content = [
      { type: 'text', text: 'before' }, first, null, { ...first, data: 'Zh==' },
      { type: 'text', text: 'between' }, second, imagePart(png(), 'image/svg+xml'), 0, third
    ]
    const expected = {
      images: [
        { ...first, width: 12, height: 7, partIndex: 1 },
        { ...second, width: 9, height: 5, partIndex: 5 },
        { ...third, width: 2, height: 3, partIndex: 8 }
      ],
      notice: REJECTION_NOTICE
    }
    expect(collectToolImages(content)).toEqual(expected)
    expect(collectToolImages(content)).toEqual(expected)
  })

  it('preserves distinct positions for identical image parts and omits notice when all images fit', () => {
    const part = imagePart()
    expect(collectToolImages([{}, part, { type: 'text', text: 'gap' }, part])).toEqual({
      images: [
        { ...part, width: 1, height: 1, partIndex: 1 },
        { ...part, width: 1, height: 1, partIndex: 3 }
      ]
    })
  })

  it('accepts the exact 128 KiB base64 / 96 KiB byte boundary and rejects one extra byte', () => {
    const exactBytes = pngWithByteLength(96 * 1024)
    const exact = imagePart(exactBytes)
    expect(exactBytes).toHaveLength(MAX_TOOL_IMAGE_BYTES)
    expect(exact.data).toHaveLength(128 * 1024)
    expect(collectToolImages([exact])).toEqual({ images: [{ ...exact, width: 1, height: 1, partIndex: 0 }] })
    const over = imagePart(pngWithByteLength(96 * 1024 + 1))
    expect(over.data).toHaveLength(MAX_TOOL_IMAGE_BASE64_LENGTH + 4)
    expect(collectToolImages([over])).toEqual({ images: [], notice: REJECTION_NOTICE })
  })

  it.each(['image/png', 'image/jpeg'])('applies the 512px preview limit to %s', (mimeType) => {
    const exact = imagePart(raster(mimeType, 512, 512), mimeType)
    expect(collectToolImages([exact])).toEqual({ images: [{ ...exact, width: 512, height: 512, partIndex: 0 }] })
    for (const [width, height] of [[513, 1], [1, 513]]) {
      expect(collectToolImages([imagePart(raster(mimeType, width, height), mimeType)]))
        .toEqual({ images: [], notice: REJECTION_NOTICE })
    }
  })

  it('keeps four accepted images in order and reports, rather than replacing them with, a fifth', () => {
    expect(MAX_TOOL_IMAGES).toBe(4)
    const parts = Array.from({ length: 5 }, (_, index) => imagePart(png(index + 1, 1)))
    const expected = parts.slice(0, 4).map((part, partIndex) => ({ ...part, width: partIndex + 1, height: 1, partIndex }))
    expect(collectToolImages(parts.slice(0, 4))).toEqual({ images: expected })
    expect(collectToolImages(parts)).toEqual({ images: expected, notice: REJECTION_NOTICE })
  })

  it('does not count a rejected image or ignored text against the four accepted-image slots', () => {
    const part = imagePart()
    const content = [imagePart(png(), 'image/gif'), { type: 'text', text: 'gap' }, part, part, part, part]
    expect(collectToolImages(content)).toEqual({
      images: [2, 3, 4, 5].map((partIndex) => ({ ...part, width: 1, height: 1, partIndex })),
      notice: REJECTION_NOTICE
    })
  })

  it('bounds content scanning at 128 parts while retaining the last permitted original index', () => {
    const content: unknown[] = Array.from({ length: 128 }, () => ({ type: 'text', text: 'gap' }))
    const part = imagePart()
    content[127] = part
    const images = [{ ...part, width: 1, height: 1, partIndex: 127 }]
    expect(collectToolImages(content)).toEqual({ images })
    expect(collectToolImages([...content, imagePart(jpeg(), 'image/jpeg')]))
      .toEqual({ images, notice: REJECTION_NOTICE })
  })
})
