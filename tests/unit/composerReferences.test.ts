import { describe, expect, it } from 'vitest'
import {
  attachmentReferenceToken, buildReferenceMessage, numberImageReferences,
  rebaseImageReferenceTokens, remapImageReferenceTokens
} from '../../src/renderer/src/features/chat/composerReferences'
import type { ImageReferenceToken, ReferenceAttachment } from '../../src/renderer/src/features/chat/composerReferences'

function image(id: string, name = 'same.png'): ReferenceAttachment {
  return { id, kind: 'image', name, mimeType: 'image/png', size: 1,
    image: { type: 'image', mimeType: 'image/png', data: 'same-bytes' } }
}

describe('composer image reference identity', () => {
  it('numbers duplicate names and bytes by payload position, without changing filenames', () => {
    const references = numberImageReferences([image('a'), image('b'), image('c', '剪贴板图像')])
    expect(references.map(attachmentReferenceToken)).toEqual(['@"图像 1"', '@"图像 2"', '@"图像 3"'])
    expect(references.map((reference) => reference.name)).toEqual(['same.png', 'same.png', '剪贴板图像'])
    expect(buildReferenceMessage('', references)).toBe('[图像 1: same.png]\n\n[图像 2: same.png]\n\n[图像 3: 剪贴板图像]')
  })

  it('rewrites only owned token spans using ids on reorder, never ordinary prose or unowned tokens', () => {
    const text = '图像 1 是文字 @"图像 1" / @"图像 2" / @"图像 1"'
    const owned = ['@"图像 1"', '@"图像 2"'].map((token, index) => {
      const start = text.indexOf(token)
      return { id: index === 0 ? 'a' : 'b', start, end: start + token.length, token }
    })
    const result = remapImageReferenceTokens(text, owned, numberImageReferences([image('b'), image('a')]))
    expect(result.text).toBe('图像 1 是文字 @"图像 2" / @"图像 1" / @"图像 1"')
    expect(result.tokens.map((binding) => binding.id)).toEqual(['a', 'b'])
    const removed = remapImageReferenceTokens(result.text, result.tokens, numberImageReferences([image('b')]))
    expect(removed.text).toBe('图像 1 是文字  / @"图像 1" / @"图像 1"')
    expect(removed.tokens.map((binding) => binding.id)).toEqual(['b'])
  })

  it('removes the deleted id even when another image has the same name and bytes', () => {
    const token = '@"图像 2"'
    const binding: ImageReferenceToken = { id: 'b', start: 0, end: token.length, token }
    expect(remapImageReferenceTokens(token, [binding], numberImageReferences([image('a')]))).toEqual({ text: '', tokens: [] })
  })

  it('moves spans only through an exact programmatic replacement range', () => {
    const token = '@"图像 1"'
    const binding: ImageReferenceToken = { id: 'a', start: 0, end: token.length, token }
    const rebased = rebaseImageReferenceTokens([binding], 0, 0, 3)
    expect(rebased).toEqual([{ ...binding, start: 3, end: token.length + 3 }])
    expect(rebaseImageReferenceTokens(rebased, 3, token.length + 3, token.length)).toEqual([])
  })

  it('does not transfer ownership to a repeated token when its exact first span is replaced', () => {
    const token = '@"图像 1"'
    const binding: ImageReferenceToken = { id: 'a', start: 0, end: token.length, token }
    expect(rebaseImageReferenceTokens([binding], 0, token.length + 1, 0)).toEqual([])
    // Same-value replacement is still a replacement, not an identity proof.
    expect(rebaseImageReferenceTokens([binding], 0, token.length, token.length)).toEqual([])
  })
})
