import { Buffer } from 'node:buffer'
import { deflateRawSync, deflateSync, gzipSync, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertGeneratedPngData } from '../../src/main/agent/png-validation'
import { makeStaticPng } from '../fixtures/static-png'

// Real, in-memory zlib except the one explicit large-budget observation below.
// The wrapper lets us inspect limits without allocating a 128 MB test raster.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return { ...actual, inflateSync: vi.fn(actual.inflateSync) }
})
afterEach(() => vi.mocked(inflateSync).mockClear())

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const RGB_ROW = Buffer.from([0, 0x12, 0x34, 0x56])
interface HeaderOptions {
  width?: number
  height?: number
  bitDepth?: number
  colorType?: number
  compression?: number
  filter?: number
  interlace?: number
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length, 0)
  bytes.write(type, 4, 4, 'ascii')
  data.copy(bytes, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4)
  return bytes
}
function ihdr(options: HeaderOptions = {}): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(options.width ?? 1, 0)
  data.writeUInt32BE(options.height ?? 1, 4)
  data.set([options.bitDepth ?? 8, options.colorType ?? 2, options.compression ?? 0, options.filter ?? 0, options.interlace ?? 0], 8)
  return chunk('IHDR', data)
}
function png(options: HeaderOptions = {}, chunks = [chunk('IDAT', deflateSync(RGB_ROW)), chunk('IEND')]): Buffer {
  return Buffer.concat([SIGNATURE, ihdr(options), ...chunks])
}
function encoded(raw: Buffer, options: HeaderOptions = {}, before: Buffer[] = [], after: Buffer[] = []): Buffer {
  return png(options, [...before, chunk('IDAT', deflateSync(raw)), ...after, chunk('IEND')])
}
function assertPng(bytes: Uint8Array, width = 1, height = 1): void {
  assertGeneratedPngData(bytes, { width, height })
}
function badCrc(type: string, data = Buffer.alloc(0)): Buffer {
  const bytes = chunk(type, data)
  bytes[bytes.length - 1] ^= 1
  return bytes
}
function compressedText(type: 'iCCP' | 'zTXt', compressed = deflateSync(Buffer.from('bounded text'))): Buffer {
  return chunk(type, Buffer.concat([Buffer.from('Name\0'), Buffer.of(0), compressed]))
}
function internationalText(text: Buffer, flag = 1, method = 0): Buffer {
  return chunk('iTXt', Buffer.concat([Buffer.from('Name\0'), Buffer.of(flag, method), Buffer.from('zh-CN\0标题\0'), flag === 1 ? deflateSync(text) : text]))
}
const PALETTE = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0]))

// Independent test geometry, with hard-coded pass origins/strides and a known
// 8x8 RGB byte count below. No browser, filesystem, service or network requests.
function adam7Rows(width: number, height: number, bitsPerPixel: number): Buffer {
  const rows: Buffer[] = []
  for (const [x, y, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    let columns = 0
    for (let column = x; column < width; column += dx) columns++
    if (!columns) continue
    for (let row = y; row < height; row += dy) rows.push(Buffer.alloc(1 + Math.ceil(columns * bitsPerPixel / 8)))
  }
  return Buffer.concat(rows)
}

describe('static PNG fixture and supported raster formats', () => {
  it('creates a deterministic, valid default 1x1 RGB fixture with independent known CRCs', () => {
    const bytes = makeStaticPng()
    expect(bytes).toEqual(makeStaticPng(1, 1))
    expect(bytes.subarray(24, 29)).toEqual(Buffer.from([8, 2, 0, 0, 0]))
    expect(bytes.readUInt32BE(29)).toBe(0x907753de)
    expect(bytes.readUInt32BE(bytes.length - 4)).toBe(0xae426082)
    expect(() => assertPng(bytes)).not.toThrow()
  })

  it.each([[23, 17], [512, 512], [4096, 1]])('validates a %i x %i fixture without changing caller bytes', (width, height) => {
    const bytes = makeStaticPng(width, height)
    const original = Buffer.from(bytes)
    expect(() => assertPng(bytes, width, height)).not.toThrow()
    expect(bytes).toEqual(original)
  })

  it('respects a Uint8Array view with a nonzero offset', () => {
    const bytes = makeStaticPng(3, 2)
    const backing = Buffer.concat([Buffer.of(1, 2, 3), bytes, Buffer.of(4, 5)])
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 3, bytes.length)
    expect(() => assertPng(view, 3, 2)).not.toThrow()
  })

  it.each([
    [0, 1, 1], [0, 2, 1], [0, 4, 1], [0, 8, 1], [0, 16, 1],
    [2, 8, 3], [2, 16, 3], [3, 1, 1], [3, 2, 1], [3, 4, 1], [3, 8, 1],
    [4, 8, 2], [4, 16, 2], [6, 8, 4], [6, 16, 4]
  ])('accepts color type %i / bit depth %i, including packed rows', (colorType, bitDepth, channels) => {
    const raw = Buffer.alloc(1 + Math.ceil(3 * channels * bitDepth / 8))
    const before = colorType === 3 ? [PALETTE] : []
    expect(() => assertPng(encoded(raw, { width: 3, colorType, bitDepth }, before), 3, 1)).not.toThrow()
  })

  it.each([0, 1, 2, 3, 4])('accepts scanline filter %i', (filter) => {
    expect(() => assertPng(encoded(Buffer.of(filter, 0, 0, 0)))).not.toThrow()
  })

  it('accepts consecutive split IDAT, including empty fragments', () => {
    const compressed = deflateSync(RGB_ROW)
    const bytes = png({}, [chunk('IDAT'), chunk('IDAT', compressed.subarray(0, 2)), chunk('IDAT'), chunk('IDAT', compressed.subarray(2)), chunk('IDAT'), chunk('IEND')])
    expect(() => assertPng(bytes)).not.toThrow()
  })

  it.each([[1, 1], [1, 2], [2, 1], [3, 5], [8, 8], [9, 10]])('accepts Adam7 %i x %i with empty passes omitted', (width, height) => {
    const raw = adam7Rows(width, height, 24)
    if (width === 8 && height === 8) expect(raw.length).toBe(207)
    expect(() => assertPng(encoded(raw, { width, height, interlace: 1 }), width, height)).not.toThrow()
  })

  it('validates packed indexed Adam7 and resets predictor state between passes', () => {
    const raw = adam7Rows(9, 7, 2)
    // Each pass starts with Up-filtered packed index-one pixels; later rows
    // encode zero differences. Reusing the preceding pass would produce index
    // two (outside this palette), so this detects a missing predictor reset.
    let offset = 0
    for (const [width, height] of [[2, 1], [1, 1], [3, 1], [2, 2], [5, 2], [4, 4], [9, 3]]) {
      const rowBytes = Math.ceil(width * 2 / 8)
      for (let row = 0; row < height; row++) {
        raw[offset] = 2
        if (row === 0) raw.fill(0x55, offset + 1, offset + rowBytes + 1)
        offset += rowBytes + 1
      }
    }
    expect(offset).toBe(raw.length)
    expect(() => assertPng(encoded(raw, { width: 9, height: 7, interlace: 1, colorType: 3, bitDepth: 2 }, [PALETTE]), 9, 7)).not.toThrow()
  })

  it('ignores bounded unknown ancillary chunks after checking their CRCs', () => {
    expect(() => assertPng(encoded(RGB_ROW, {}, [chunk('vpAg', Buffer.of(1, 2, 3))]))).not.toThrow()
  })
})

describe('PNG chunk integrity and ordering', () => {
  it.each(['IHDR', 'IDAT', 'tEXt', 'IEND'])('checks the %s CRC, not just structure', (type) => {
    const header = ihdr()
    if (type === 'IHDR') header[header.length - 1] ^= 1
    const idat = type === 'IDAT' ? badCrc('IDAT', deflateSync(RGB_ROW)) : chunk('IDAT', deflateSync(RGB_ROW))
    const text = type === 'tEXt' ? badCrc('tEXt', Buffer.from('Name\0text')) : chunk('tEXt', Buffer.from('Name\0text'))
    const end = type === 'IEND' ? badCrc('IEND') : chunk('IEND')
    expect(() => assertPng(Buffer.concat([SIGNATURE, header, text, idat, end]))).toThrow(/CRC/)
  })

  it('checks unknown ancillary CRCs rather than skipping their data', () => {
    expect(() => assertPng(encoded(RGB_ROW, {}, [badCrc('vpAg', Buffer.of(7))]))).toThrow(/CRC/)
  })

  it.each(['ABCD', 'CgBI'])('rejects unknown critical chunk %s', (type) => {
    expect(() => assertPng(encoded(RGB_ROW, {}, [chunk(type)]))).toThrow(/critical/)
  })

  it.each(['ID0T', 'vpag'])('rejects malformed/reserved chunk type %s even with a correct CRC', (type) => {
    expect(() => assertPng(encoded(RGB_ROW, {}, [chunk(type)]))).toThrow(/chunk type/)
  })

  it.each(['acTL', 'fcTL', 'fdAT'])('rejects animated PNG %s before or after IDAT', (type) => {
    for (const bytes of [encoded(RGB_ROW, {}, [chunk(type, Buffer.alloc(26))]), encoded(RGB_ROW, {}, [], [chunk(type, Buffer.alloc(26))])]) {
      expect(() => assertPng(bytes)).toThrow(/animated/)
    }
  })

  it('requires IHDR first, exactly once and with length 13', () => {
    for (const bytes of [
      Buffer.concat([SIGNATURE, chunk('tEXt', Buffer.from('Name\0text')), ihdr(), chunk('IDAT', deflateSync(RGB_ROW)), chunk('IEND')]),
      png({}, [ihdr(), chunk('IDAT', deflateSync(RGB_ROW)), chunk('IEND')]),
      Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(12)), chunk('IDAT', deflateSync(RGB_ROW)), chunk('IEND')]),
      Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(14)), chunk('IDAT', deflateSync(RGB_ROW)), chunk('IEND')])
    ]) expect(() => assertPng(bytes)).toThrow(/IHDR/)
  })

  it('rejects nonconsecutive IDAT even when concatenating its data would inflate correctly', () => {
    const compressed = deflateSync(RGB_ROW)
    const bytes = png({}, [chunk('IDAT', compressed.subarray(0, 2)), chunk('tEXt', Buffer.from('Name\0text')), chunk('IDAT', compressed.subarray(2)), chunk('IEND')])
    expect(() => assertPng(bytes)).toThrow(/consecutive/)
  })

  it('rejects invalid signature, truncation, oversized lengths, missing/nonempty IEND and trailing data', () => {
    const valid = makeStaticPng()
    const signature = Buffer.from(valid)
    signature[0] ^= 1
    const oversized = Buffer.from(valid)
    oversized.writeUInt32BE(0xffffffff, 33)
    const overrun = Buffer.from(valid)
    overrun.writeUInt32BE(valid.length, 33)
    for (const bytes of [
      signature, valid.subarray(0, 7), valid.subarray(0, 39), valid.subarray(0, -1), valid.subarray(0, -12),
      oversized, overrun, png({}, [chunk('IEND')]),
      png({}, [chunk('IDAT', deflateSync(RGB_ROW)), chunk('IEND', Buffer.of(0))]),
      Buffer.concat([valid, Buffer.of(0)]), Buffer.concat([valid, chunk('IEND')])
    ]) expect(() => assertPng(bytes)).toThrow()
  })
})

describe('IHDR and allocation limits', () => {
  it.each([
    { bitDepth: 0 }, { bitDepth: 3 }, { bitDepth: 32 }, { colorType: 1 }, { colorType: 5 }, { colorType: 7 },
    { colorType: 2, bitDepth: 4 }, { colorType: 3, bitDepth: 16 }, { colorType: 4, bitDepth: 1 }, { colorType: 6, bitDepth: 4 },
    { compression: 1 }, { filter: 1 }, { interlace: 2 }
  ])('rejects an invalid but CRC-correct IHDR %j', (options) => {
    expect(() => assertPng(png(options))).toThrow(/bit depth|color type|method/)
  })

  it('rejects dimensions that disagree with the preflight inspection', () => {
    expect(() => assertPng(makeStaticPng(2, 1))).toThrow(/match/)
    expect(() => assertPng(makeStaticPng(), 2, 1)).toThrow(/match/)
  })

  it.each([[0, 1], [1, 0], [4097, 1], [1, 4097], [4001, 4000], [0x80000000, 1], [1, 0xffffffff]])('bounds unsigned IHDR dimensions %i x %i before allocating raster data', (width, height) => {
    expect(() => assertPng(png({ width, height }))).toThrow(/dimensions/)
    expect(inflateSync).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid caller dimensions and fixture dimensions %j', (value) => {
    expect(() => assertPng(makeStaticPng(), value, 1)).toThrow(/dimensions/)
    expect(() => makeStaticPng(value, 1)).toThrow(/dimensions/)
  })

  it('rejects oversized input before walking chunks or inflating', () => {
    expect(() => assertPng(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(/byte size/)
    expect(inflateSync).not.toHaveBeenCalled()
  })

  it('uses the exact raster byte budget, always below 128 MiB, at the 16-million-pixel limit', () => {
    vi.mocked(inflateSync).mockImplementationOnce(() => { throw new Error('stop before allocating a large raster') })
    expect(() => assertPng(png({ width: 4000, height: 4000, colorType: 6, bitDepth: 16 }), 4000, 4000)).toThrow(/inflate budget/)
    expect(inflateSync).toHaveBeenCalledTimes(1)
    expect(vi.mocked(inflateSync).mock.calls[0][1]).toEqual({ info: true, maxOutputLength: 128_004_000 })
    expect(128_004_000).toBeLessThan(128 * 1024 * 1024)
  })
})

describe('IDAT zlib and scanlines', () => {
  it('rejects empty IDAT chunks even when all framing and CRCs are correct', () => {
    expect(() => assertPng(png({}, [chunk('IDAT'), chunk('IDAT'), chunk('IEND')]))).toThrow(/nonempty IDAT/)
  })

  it('rejects corrupted/truncated streams, wrong wrappers and preset dictionaries', () => {
    const compressed = deflateSync(RGB_ROW)
    const wrongAdler = Buffer.from(compressed)
    wrongAdler[wrongAdler.length - 1] ^= 1
    for (const payload of [
      Buffer.of(0), Buffer.of(0, 1, 2, 3, 4, 5), compressed.subarray(0, -1), wrongAdler,
      deflateRawSync(RGB_ROW), gzipSync(RGB_ROW), deflateSync(RGB_ROW, { dictionary: Buffer.from('dictionary') })
    ]) expect(() => assertPng(png({}, [chunk('IDAT', payload), chunk('IEND')]))).toThrow(/zlib/)
  })

  it('rejects trailing junk and concatenated zlib streams which inflateSync alone would ignore', () => {
    const compressed = deflateSync(RGB_ROW)
    for (const suffix of [Buffer.of(0), compressed, deflateSync(Buffer.alloc(0))]) {
      expect(() => assertPng(png({}, [chunk('IDAT', Buffer.concat([compressed, suffix])), chunk('IEND')]))).toThrow(/trailing/)
    }
  })

  it('requires exactly the expected raster size, not just a successful inflate', () => {
    for (const raw of [Buffer.alloc(0), RGB_ROW.subarray(0, 3), Buffer.concat([RGB_ROW, Buffer.of(0)])]) {
      expect(() => assertPng(encoded(raw))).toThrow(/scanline|inflate budget/)
    }
  })

  it.each([5, 255])('rejects illegal scanline filter %i', (filter) => {
    expect(() => assertPng(encoded(Buffer.of(filter, 1, 2, 3)))).toThrow(/filter/)
  })

  it('rejects a later-row illegal filter and an Adam7 later-pass illegal filter', () => {
    expect(() => assertPng(encoded(Buffer.of(0, 0, 0, 0, 5, 0, 0, 0), { height: 2 }), 1, 2)).toThrow(/filter/)
    const raw = adam7Rows(8, 8, 24)
    raw[4] = 5 // First scanline of pass 2, not a byte in pass 1's RGB payload.
    expect(() => assertPng(encoded(raw, { width: 8, height: 8, interlace: 1 }), 8, 8)).toThrow(/filter/)
  })

  it('rejects incorrect Adam7 raster geometry and unexpected empty-pass bytes', () => {
    const raw = adam7Rows(8, 8, 24)
    for (const broken of [raw.subarray(0, -1), Buffer.concat([raw, Buffer.of(0)]), Buffer.alloc(8 * (8 * 3 + 1))]) {
      expect(() => assertPng(encoded(broken, { width: 8, height: 8, interlace: 1 }), 8, 8)).toThrow(/scanline|inflate budget/)
    }
    expect(() => assertPng(encoded(Buffer.alloc(8), { interlace: 1 }))).toThrow(/inflate budget/)
  })

  it('bounds highly compressed expansion to the declared scanlines rather than the input byte size', () => {
    const payload = deflateSync(Buffer.alloc(1024 * 1024))
    expect(payload.length).toBeLessThan(2048)
    expect(() => assertPng(png({}, [chunk('IDAT', payload), chunk('IEND')]))).toThrow(/inflate budget/)
    expect(vi.mocked(inflateSync).mock.calls[0][1]?.maxOutputLength).toBe(4)
  })
})

describe('PLTE and indexed sample correctness', () => {
  it('requires a palette before indexed IDAT and forbids palettes for grayscale', () => {
    expect(() => assertPng(encoded(Buffer.of(0, 0), { colorType: 3 }))).toThrow(/PLTE/)
    for (const [colorType, bytes] of [[0, 1], [4, 2]]) {
      expect(() => assertPng(encoded(Buffer.alloc(bytes + 1), { colorType }, [PALETTE]))).toThrow(/PLTE/)
    }
  })

  it('rejects empty, misaligned, oversized, duplicate or late palettes', () => {
    for (const before of [[chunk('PLTE')], [chunk('PLTE', Buffer.of(1, 2))], [chunk('PLTE', Buffer.alloc(257 * 3))], [PALETTE, PALETTE]]) {
      expect(() => assertPng(encoded(RGB_ROW, {}, before))).toThrow(/PLTE/)
    }
    expect(() => assertPng(encoded(RGB_ROW, {}, [], [PALETTE]))).toThrow(/order/)
    expect(() => assertPng(encoded(Buffer.of(0, 0), { colorType: 3, bitDepth: 1 }, [chunk('PLTE', Buffer.alloc(9))]))).toThrow(/bit depth/)
  })

  it('permits optional truecolor palettes', () => {
    expect(() => assertPng(encoded(RGB_ROW, {}, [PALETTE]))).not.toThrow()
    expect(() => assertPng(encoded(Buffer.alloc(5), { colorType: 6 }, [PALETTE]))).not.toThrow()
  })

  it('checks reconstructed indices, not filtered bytes, across scanlines', () => {
    const raw = Buffer.of(1, 1, 255, 2, 255, 1) // Sub => [1,0]; Up => [0,1].
    const bytes = encoded(raw, { width: 2, height: 2, colorType: 3 }, [PALETTE])
    const original = Buffer.from(bytes)
    expect(() => assertPng(bytes, 2, 2)).not.toThrow()
    expect(bytes).toEqual(original)
    expect(() => assertPng(encoded(Buffer.of(1, 1, 1), { width: 2, colorType: 3 }, [PALETTE]), 2, 1)).toThrow(/palette entry/)
  })

  it('reconstructs indexed Paeth rows with wrapping bytes and all predictor choices', () => {
    // Reconstructed rows: [1,2,3,0], [3,2,1,0], [0,1,2,3].
    const raw = Buffer.of(4, 1, 1, 1, 253, 4, 2, 255, 254, 0, 4, 253, 1, 1, 2)
    expect(() => assertPng(encoded(raw, { width: 4, height: 3, colorType: 3 }, [chunk('PLTE', Buffer.alloc(12))]), 4, 3)).not.toThrow()
  })

  it.each([[1, 1, 0x80], [2, 2, 0x80], [4, 2, 0x20], [8, 2, 2]])('checks actual packed depth-%i indices against %i palette entries', (bitDepth, entries, pixel) => {
    expect(() => assertPng(encoded(Buffer.of(0, pixel), { bitDepth, colorType: 3 }, [chunk('PLTE', Buffer.alloc(entries * 3))]))).toThrow(/palette entry/)
  })

  it('ignores unused low padding bits in packed indexed rows', () => {
    expect(() => assertPng(encoded(Buffer.of(0, 0x7f), { bitDepth: 1, colorType: 3 }, [chunk('PLTE', Buffer.alloc(3))]))).not.toThrow()
  })

  it('checks tRNS/bKGD/hIST basic lengths, ordering and sample ranges', () => {
    expect(() => assertPng(encoded(Buffer.of(0, 0), { colorType: 3 }, [PALETTE, chunk('tRNS', Buffer.of(255)), chunk('bKGD', Buffer.of(1)), chunk('hIST', Buffer.alloc(4))]))).not.toThrow()
    for (const metadata of [chunk('tRNS', Buffer.alloc(3)), chunk('bKGD', Buffer.of(2)), chunk('hIST', Buffer.alloc(2))]) {
      expect(() => assertPng(encoded(Buffer.of(0, 0), { colorType: 3 }, [PALETTE, metadata]))).toThrow()
    }
    expect(() => assertPng(encoded(RGB_ROW, {}, [chunk('tRNS', Buffer.alloc(6)), PALETTE]))).toThrow(/ordering/)
    expect(() => assertPng(encoded(RGB_ROW, {}, [chunk('tRNS', Buffer.of(1, 0, 0, 0, 0, 0))]))).toThrow(/sample/)
    expect(() => assertPng(encoded(Buffer.alloc(5), { colorType: 6 }, [chunk('tRNS', Buffer.alloc(6))]))).toThrow(/forbidden/)
  })
})

describe('bounded ancillary metadata', () => {
  it('accepts text, bounded compressed text/ICC streams, and UTF-8 international text', () => {
    const before = [compressedText('iCCP', deflateSync(Buffer.alloc(128, 1))), chunk('tEXt', Buffer.from('Name\0plain text'))]
    const after = [compressedText('zTXt'), internationalText(Buffer.from('你好 🌍')), internationalText(Buffer.from('未压缩'), 0)]
    expect(() => assertPng(encoded(RGB_ROW, {}, before, after))).not.toThrow()
    // Only compression envelope/budgets are asserted for ICC here, not profile
    // semantics or the colors an image decoder would render from this profile.
    expect(vi.mocked(inflateSync).mock.calls.slice(0, 3).every(([, options]) => (options?.maxOutputLength ?? Infinity) <= 1024 * 1024)).toBe(true)
  })

  it.each(['iCCP', 'zTXt'] as const)('rejects %s bombs, broken streams and compressed trailing bytes', (type) => {
    const compressed = deflateSync(Buffer.from('valid'))
    for (const payload of [deflateSync(Buffer.alloc(1024 * 1024 + 1)), compressed.subarray(0, -1), Buffer.concat([compressed, Buffer.of(0)])]) {
      expect(() => assertPng(encoded(RGB_ROW, {}, [compressedText(type, payload)]))).toThrow(/budget|zlib/)
    }
  })

  it('bounds compressed and uncompressed iTXt and validates UTF-8', () => {
    const over = Buffer.alloc(1024 * 1024 + 1, 65)
    for (const metadata of [internationalText(over), internationalText(over, 0), internationalText(Buffer.of(0xff)), internationalText(Buffer.of(0xff), 0)]) {
      expect(() => assertPng(encoded(RGB_ROW, {}, [metadata]))).toThrow(/budget|UTF-8/)
    }
  })

  it('accepts exactly 1 MiB per stream / 4 MiB total, rejects the next decoded byte', () => {
    const stream = deflateSync(Buffer.alloc(1024 * 1024, 65))
    const four = Array.from({ length: 4 }, () => compressedText('zTXt', stream))
    expect(() => assertPng(encoded(RGB_ROW, {}, four))).not.toThrow()
    expect(() => assertPng(encoded(RGB_ROW, {}, [...four, compressedText('zTXt', deflateSync(Buffer.from('x')))]))).toThrow(/budget/)
  })

  it('bounds metadata chunk count, even for empty decoded text', () => {
    const empty = deflateSync(Buffer.alloc(0))
    const sixtyFour = Array.from({ length: 64 }, () => compressedText('zTXt', empty))
    expect(() => assertPng(encoded(RGB_ROW, {}, sixtyFour))).not.toThrow()
    expect(() => assertPng(encoded(RGB_ROW, {}, [...sixtyFour, compressedText('zTXt', empty)]))).toThrow(/too many/)
  })

  it('rejects malformed keyword/compression/iTXt envelopes despite correct CRCs', () => {
    for (const metadata of [
      chunk('zTXt', Buffer.from('unterminated')), chunk('zTXt', Buffer.from('\0\0')),
      chunk('zTXt', Buffer.from(`${'x'.repeat(80)}\0\0`)), chunk('zTXt', Buffer.from('bad  name\0\0')),
      chunk('zTXt', Buffer.from(' trailing\0\0')), chunk('zTXt', Buffer.from('trailing \0\0')),
      chunk('zTXt', Buffer.of(0x80, 0, 0)), chunk('zTXt', Buffer.from('Name\0\x01')),
      chunk('iCCP', Buffer.from('Name\0\x01')), compressedText('iCCP', deflateSync(Buffer.alloc(0))),
      internationalText(Buffer.from('text'), 2), internationalText(Buffer.from('text'), 0, 1),
      chunk('iTXt', Buffer.from('Name\0\x01\0unterminated')), chunk('iTXt', Buffer.from('Name\0\0\0\0\xff\0text', 'latin1')),
      chunk('tEXt', Buffer.from('Name\0text\0')), compressedText('zTXt', deflateSync(Buffer.from('text\0')))
    ]) expect(() => assertPng(encoded(RGB_ROW, {}, [metadata]))).toThrow()
  })

  it('requires ICC/color metadata before PLTE/IDAT and rejects duplicate/conflicting profiles', () => {
    const profile = compressedText('iCCP')
    const srgb = chunk('sRGB', Buffer.of(0))
    for (const bytes of [encoded(RGB_ROW, {}, [profile, profile]), encoded(RGB_ROW, {}, [PALETTE, profile]), encoded(RGB_ROW, {}, [], [profile]), encoded(RGB_ROW, {}, [profile, srgb]), encoded(RGB_ROW, {}, [srgb, profile])]) {
      expect(() => assertPng(bytes)).toThrow()
    }
    for (const metadata of [chunk('sRGB', Buffer.of(4)), chunk('gAMA', Buffer.alloc(4)), chunk('cHRM', Buffer.alloc(31)), chunk('sBIT', Buffer.of(8, 9, 8))]) {
      expect(() => assertPng(encoded(RGB_ROW, {}, [metadata]))).toThrow()
    }
  })
})
