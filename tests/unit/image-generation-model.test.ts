import { describe, expect, it } from 'vitest'
import {
  CODEX_IMAGE_MODEL_OPTIONS, CODEX_IMAGE_REQUEST_ALIAS, generatedImageModelInfo,
  isCodexImageRequestModel, resolveCodexImageRequestModel
} from '../../src/shared/image-generation'

describe('Codex image request IDs and version metadata', () => {
  it('keeps the official alias as default, not a resolved-version claim', () => {
    expect(resolveCodexImageRequestModel(undefined)).toBe('gpt-image-2')
    expect(CODEX_IMAGE_REQUEST_ALIAS).toBe('gpt-image-2')
    expect(CODEX_IMAGE_MODEL_OPTIONS.filter(({ experimental }) => experimental).map(({ id }) => id)).toEqual([
      'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'
    ])
  })

  it.each(CODEX_IMAGE_MODEL_OPTIONS)('accepts the exact request ID $id', ({ id }) => {
    expect(isCodexImageRequestModel(id)).toBe(true)
    expect(resolveCodexImageRequestModel(id)).toBe(id)
  })

  it.each([null, '', 'auto', 'gpt-image-2.5', ' gpt-image-2.5-flare', 'gpt-image-2.5-sunburst ',
    'GPT-IMAGE-2.5-FLARE', 'https://example.com/model', [], {}, 2.5].map((value) => ({ value })))('does not repair or downgrade $value', ({ value }) => {
    expect(isCodexImageRequestModel(value)).toBe(false)
    expect(() => resolveCodexImageRequestModel(value)).toThrow('不支持的图片请求型号')
  })

  it('never echoes an unrecognized input in validation diagnostics', () => {
    expect(() => resolveCodexImageRequestModel('PRIVATE_TOKEN')).toThrow(/不支持的图片请求型号/)
    try { resolveCodexImageRequestModel('PRIVATE_TOKEN') }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_TOKEN') }
  })

  it('reads legacy v1 model as the request alias, without claiming the actual version', () => {
    expect(generatedImageModelInfo({ version: 1, provider: 'openai-codex', model: 'gpt-image-2' })).toEqual({
      requestedModel: 'gpt-image-2', requestLabel: 'Codex 自动（官方别名）', experimental: false, resolvedModel: null
    })
  })

  it.each(CODEX_IMAGE_MODEL_OPTIONS)('projects v2 $id independently of untrusted version echoes', ({ id, label, experimental }) => {
    expect(generatedImageModelInfo({
      version: 2, provider: 'openai-codex', requestedModel: id,
      model: 'gpt-image-2.5-sunburst', resolvedModel: 'gpt-image-2.5-sunburst'
    })).toEqual({ requestedModel: id, requestLabel: label, experimental, resolvedModel: null })
  })

  it.each([
    { version: 1, provider: 'openai-codex', model: 'PRIVATE_TOKEN' },
    { version: 2, provider: 'openai-codex', requestedModel: 'PRIVATE_TOKEN' },
    { version: 2, provider: 'openai-codex', model: 'gpt-image-2.5-flare' }
  ])('keeps malformed metadata bounded and unconfirmed', (value) => {
    const info = generatedImageModelInfo(value)
    expect(info).toEqual({ requestedModel: null, requestLabel: '未知请求型号', experimental: false, resolvedModel: null })
    expect(JSON.stringify(info)).not.toContain('PRIVATE_TOKEN')
  })

  it.each([undefined, null, [], 'text', { path: 'images/old.png' },
    { version: 3, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' },
    { version: 2, provider: 'other', requestedModel: 'gpt-image-2.5-flare' }
  ].map((value) => ({ value })))('does not reinterpret unrelated or path-only metadata: $value', ({ value }) => {
    expect(generatedImageModelInfo(value)).toBeUndefined()
  })

  it('does not rewrite the persisted record', () => {
    const record = Object.freeze({ version: 1, provider: 'openai-codex', model: 'gpt-image-2', path: 'images/old.png' })
    generatedImageModelInfo(record)
    expect(record).toEqual({ version: 1, provider: 'openai-codex', model: 'gpt-image-2', path: 'images/old.png' })
  })
})
