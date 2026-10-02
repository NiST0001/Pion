import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_IMAGE_QUALITIES, generatedImageSettingsInfo, isCodexImageRequestQuality,
  isCodexImageRequestSize, resolveCodexImageRequestQuality, resolveCodexImageRequestSize,
  validateImageReferencePaths
} from '../../src/shared/image-generation'

describe('image request settings and reference admission', () => {
  it('defaults only omitted settings; preserves explicitly selected values', () => {
    expect(resolveCodexImageRequestSize(undefined)).toBe('auto')
    expect(resolveCodexImageRequestQuality(undefined)).toBe('auto')
    expect(resolveCodexImageRequestSize('2048x3072')).toBe('2048x3072')
  })
  it.each(CODEX_IMAGE_QUALITIES)('accepts request quality %s without an actual-quality claim', (quality) => {
    expect(resolveCodexImageRequestQuality(quality)).toBe(quality)
    expect(isCodexImageRequestQuality(quality)).toBe(true)
  })
  it.each(['auto', '16x16', '1024x1536', '2048x3072', '4096x3840', '4000x4000'])('admits bounded request size %s', (size) => {
    expect(isCodexImageRequestSize(size)).toBe(true)
    expect(resolveCodexImageRequestSize(size)).toBe(size)
  })
  it.each([null, '', 'AUTO', '1024X1536', '1024×1536', '1024x1024 ', '1023x1024', '16x64',
    '4096x4096', '4097x1024', '0x1024', '01024x1024', 2048, [], {}].map((value) => ({ value })))('never repairs or lowers an invalid size: $value', ({ value }) => {
    expect(isCodexImageRequestSize(value)).toBe(false)
    expect(() => resolveCodexImageRequestSize(value)).toThrow('图片尺寸必须')
  })
  it.each([null, '', 'HIGH', 'xhigh', 'max', 1, [], {}].map((value) => ({ value })))('never repairs or lowers invalid quality: $value', ({ value }) => {
    expect(isCodexImageRequestQuality(value)).toBe(false)
    expect(() => resolveCodexImageRequestQuality(value)).toThrow('图片质量必须')
  })
  it('normalizes only optional ./, preserving reference order, duplicates and literal @', () => {
    const source = Object.freeze(['./images/source.PNG', '@.git/source.jpg', 'images/source.PNG'])
    expect(validateImageReferencePaths(source)).toEqual(['images/source.PNG', '@.git/source.jpg', 'images/source.PNG'])
    expect(source[0]).toBe('./images/source.PNG')
    expect(validateImageReferencePaths(undefined)).toEqual([])
    expect(validateImageReferencePaths([])).toEqual([])
  })
  it('does not invoke custom reference iterators and rejects sparse arrays', () => {
    const paths = ['images/source.png']
    const iterator = vi.fn(() => { throw new Error('PRIVATE_ITERATOR') })
    Object.defineProperty(paths, Symbol.iterator, { value: iterator })
    expect(validateImageReferencePaths(paths)).toEqual(['images/source.png'])
    expect(iterator).not.toHaveBeenCalled()
    expect(() => validateImageReferencePaths(new Array(1))).toThrow('参考图片')
  })
  it.each([null, 'source.png', {}, [null], ['../source.png'], ['/source.png'], ['C:/source.png'],
    ['https://private.invalid/source.png'], ['folder\\source.png'], ['source.gif'], ['source.svg'],
    ['source.png '], ['CON.png'], ['source/../input.png'], ['source//input.png'],
    [`${'中'.repeat(84)}.png`], ['\ud800.png'], Array.from({ length: 6 }, () => 'source.png'),
    Array.from({ length: 5 }, () => `${'a'.repeat(200)}/${'b'.repeat(130)}.png`)
  ].map((value) => ({ value })))('rejects unsafe/unbounded reference list: $value', ({ value }) => {
    expect(() => validateImageReferencePaths(value)).toThrow('参考图片')
  })
  it('never echoes an invalid path/control in admission diagnostics', () => {
    for (const validate of [resolveCodexImageRequestQuality, resolveCodexImageRequestSize]) {
      try { validate('PRIVATE_CONTENT') } catch (error) { expect(String(error)).not.toContain('PRIVATE_CONTENT') }
    }
    try { validateImageReferencePaths(['https://PRIVATE_CONTENT/source.png']) }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_CONTENT') }
  })
})

describe('image request/result metadata is independently normalized', () => {
  it('separates a requested resolution/quality from the actual saved PNG metadata', () => {
    expect(generatedImageSettingsInfo({ version: 2, provider: 'openai-codex', operation: 'edit',
      requestedSize: '2048x3072', requestedQuality: 'high', referenceCount: 2,
      width: 1024, height: 1536, byteLength: 12345, actualQuality: 'high' })).toEqual({
      operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high', referenceCount: 2,
      savedWidth: 1024, savedHeight: 1536, savedByteLength: 12345
    })
  })
  it('keeps legacy settings unknown but can project valid saved dimensions', () => {
    expect(generatedImageSettingsInfo({ version: 1, provider: 'openai-codex', model: 'gpt-image-2',
      width: 1, height: 1, byteLength: 69 })).toEqual({ savedWidth: 1, savedHeight: 1, savedByteLength: 69 })
    expect(generatedImageSettingsInfo({ version: 2, provider: 'openai-codex' })).toBeUndefined()
  })
  it('ignores one invalid setting independently of valid fields, paths and saved dimensions', () => {
    const source = Object.freeze({ version: 2, provider: 'openai-codex', path: 'images/output.png',
      requestedSize: 'PRIVATE_SIZE', requestedQuality: 'high', operation: 'PRIVATE_OPERATION', referenceCount: 999,
      width: 2048, height: 3072, byteLength: 200 })
    expect(generatedImageSettingsInfo(source)).toEqual({ requestedQuality: 'high',
      savedWidth: 2048, savedHeight: 3072, savedByteLength: 200 })
    expect(source.requestedSize).toBe('PRIVATE_SIZE')
  })
  it.each([null, [], {}, { version: 3, provider: 'openai-codex', requestedSize: 'auto' },
    { version: 2, provider: 'external', requestedQuality: 'high' }].map((value) => ({ value })))('does not interpret unknown metadata: $value', ({ value }) => {
    expect(generatedImageSettingsInfo(value)).toBeUndefined()
  })
  it('rejects oversized/fractional/partial saved dimensions and counters', () => {
    expect(generatedImageSettingsInfo({ version: 2, provider: 'openai-codex',
      width: 4096, height: 4096, byteLength: 17 * 1024 * 1024, referenceCount: -1 })).toBeUndefined()
    expect(generatedImageSettingsInfo({ version: 2, provider: 'openai-codex',
      width: 2048, referenceCount: 1.5 })).toBeUndefined()
  })
})
