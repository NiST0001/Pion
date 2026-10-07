// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  applyToolResult,
  assistantErrorText,
  deriveAgentTodos,
  deriveLatestRunChanges,
  diffStats,
  entriesToTimeline,
  getViewportHistoryPageSize,
  parseToolArgs,
  reconcileNewerTimelineItems,
  uniqueTimelineItems
} from '../../src/renderer/src/agent/timeline'
import type { TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'
import type { WireEntry } from '../../src/shared/types'
import { CODEX_IMAGE_REQUEST_ALIAS, IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import { MAX_TOOL_IMAGE_BASE64_LENGTH, MAX_TOOL_IMAGES } from '../../src/shared/tool-images'

const previewPart = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const imageTool: ToolItem = {
  id: 'image-call', name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true
}

describe('timeline derivation', () => {
  it('projects native argument schemas without serializing MCP image payloads', () => {
    expect(parseToolArgs('codemode', { code: 'return await tools.read({ path: "README.md" })' })).toEqual({ command: 'return await tools.read({ path: "README.md" })' })
    expect(parseToolArgs('tool_search', { query: 'find browser tools', limit: 5 })).toEqual({ command: 'find browser tools' })
    expect(parseToolArgs('mcp__server__image', { data: previewPart.data, metadata: { secret: 'not-for-display' } })).toEqual({})
  })

  it('does not invent nested history rows or roots from execution-like parts', () => {
    const entries: WireEntry[] = [{ type: 'message', id: 'script-entry', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: {
      role: 'assistant', content: [
        { type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: 'return "done"' } },
        { type: 'toolCall', id: 'child', name: 'read', parentToolCallId: 'script', arguments: { path: 'file' } }
      ]
    } }, { type: 'message', id: 'child-result', parentId: 'script-entry', timestamp: '2026-01-01T00:00:01Z', message: {
      role: 'toolResult', toolCallId: 'child', toolName: 'read', parentToolCallId: 'script', content: [previewPart]
    } }]
    const rows = entriesToTimeline(entries)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tool', tool: { id: 'script', name: 'codemode' } })
    expect(entriesToTimeline(entries)[0].id).toBe(rows[0].id)
  })

  it('scales the initial history window to the available viewport', () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 })
    expect(getViewportHistoryPageSize()).toBe(8)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1_600 })
    expect(getViewportHistoryPageSize()).toBe(19)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 2_400 })
    expect(getViewportHistoryPageSize()).toBe(24)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('deduplicates paged items against live transcript entries', () => {
    const existing = [
      { kind: 'user' as const, id: 1, entryId: 'entry-1', text: '已有' },
      { kind: 'tool' as const, id: 2, tool: { id: 'tool-1', name: 'read', status: 'done' as const, isError: false } }
    ]
    const incoming = [
      { kind: 'user' as const, id: 3, entryId: 'entry-1', text: '重复' },
      { kind: 'assistant' as const, id: 4, entryId: 'entry-2', text: '新增', thinking: '', streaming: false }
    ]

    expect(uniqueTimelineItems(existing, incoming)).toEqual([incoming[1]])
  })

  it('places a persisted final assistant after messages that preceded its live row', () => {
    const liveError: TimelineItem = {
      kind: 'assistant',
      id: 5,
      messageTimestamp: 1_780_000_000_000,
      text: '',
      thinking: '',
      streaming: false,
      live: true,
      error: 'provider unavailable'
    }
    const persistedError: TimelineItem = {
      kind: 'assistant',
      id: 8,
      entryId: 'persisted-error',
      messageTimestamp: 1_780_000_000_000,
      text: '',
      thinking: '',
      streaming: false,
      error: 'provider unavailable'
    }
    const existing: TimelineItem[] = [
      { kind: 'user', id: 4, entryId: 'old', text: 'old page' },
      liveError
    ]
    const incoming: TimelineItem[] = [
      { kind: 'user', id: 6, entryId: 'middle', text: 'middle page' },
      { kind: 'user', id: 7, entryId: 'latest', text: 'latest page' },
      persistedError
    ]

    const reconciledError: TimelineItem = {
      ...liveError, entryId: persistedError.entryId, historyReconciled: true
    }
    expect(reconcileNewerTimelineItems(existing, incoming)).toEqual({
      items: [existing[0], incoming[0], incoming[1], reconciledError],
      appended: [incoming[0], incoming[1], reconciledError]
    })
  })

  it('matches same-timestamp live assistants one-to-one by final content', () => {
    const timestamp = 1_780_000_000_000
    const liveFirst: TimelineItem = {
      kind: 'assistant', id: 9, messageTimestamp: timestamp,
      text: 'first', thinking: '', streaming: false, live: true
    }
    const liveSecond: TimelineItem = {
      kind: 'assistant', id: 10, messageTimestamp: timestamp,
      text: 'second', thinking: '', streaming: false, live: true
    }
    const persistedSecond: TimelineItem = {
      kind: 'assistant', id: 11, entryId: 'second', messageTimestamp: timestamp,
      text: 'second', thinking: '', streaming: false
    }

    const reconciledSecond: TimelineItem = {
      ...liveSecond, entryId: persistedSecond.entryId, historyReconciled: true
    }
    expect(reconcileNewerTimelineItems([liveFirst, liveSecond], [persistedSecond])).toEqual({
      items: [reconciledSecond, liveFirst],
      appended: [reconciledSecond]
    })
  })

  it('reconciles a persisted final snapshot seen before message_end without changing its key', () => {
    const streaming: TimelineItem = {
      kind: 'assistant', id: 23, messageTimestamp: 1_780_000_000_002,
      text: 'partial', thinking: '', streaming: true, live: true, error: 'provisional error'
    }
    const persisted: TimelineItem = {
      kind: 'assistant', id: 24, entryId: 'stored-before-event', messageTimestamp: streaming.messageTimestamp,
      text: 'final response', thinking: 'final thinking', streaming: false
    }
    const reconciled = reconcileNewerTimelineItems([streaming], [persisted])

    expect(reconciled.items).toHaveLength(1)
    expect(reconciled.items[0]).toMatchObject({
      id: streaming.id, entryId: persisted.entryId, text: 'final response', thinking: 'final thinking',
      streaming: false, historyReconciled: true
    })
    expect(reconciled.items[0]).not.toHaveProperty('error')
  })

  it('keeps an unmatched streaming assistant pinned after appended history', () => {
    const live: TimelineItem = {
      kind: 'assistant', id: 12, messageTimestamp: 1_780_000_000_001,
      text: 'streaming', thinking: '', streaming: true, live: true
    }
    const existing: TimelineItem[] = [{ kind: 'user', id: 11, entryId: 'old', text: 'old' }, live]
    const incoming: TimelineItem[] = [{ kind: 'user', id: 13, entryId: 'newer', text: 'newer' }]

    expect(reconcileNewerTimelineItems(existing, incoming)).toEqual({
      items: [existing[0], incoming[0], live],
      appended: incoming
    })
  })

  it('moves live user, tool, and compaction rows behind newly loaded history', () => {
    const liveUser: TimelineItem = {
      kind: 'user', id: 14, entryId: 'live-user', text: 'live user', live: true
    }
    const liveTool: TimelineItem = {
      kind: 'tool', id: 15,
      tool: { id: 'tool-call', name: 'read', status: 'done', isError: false, live: true }
    }
    const liveCompaction: TimelineItem = {
      kind: 'compaction', id: 16, entryId: 'live-compaction', summary: '上下文已压缩', live: true
    }
    const existing: TimelineItem[] = [
      { kind: 'user', id: 13, entryId: 'old', text: 'old' },
      liveUser,
      liveTool,
      liveCompaction
    ]
    const middle: TimelineItem = { kind: 'user', id: 17, entryId: 'middle', text: 'middle' }
    const afterLive: TimelineItem = { kind: 'user', id: 21, entryId: 'after-live', text: 'after live' }
    const incoming: TimelineItem[] = [
      middle,
      { ...liveUser, id: 18, live: undefined },
      { ...liveTool, id: 19, tool: { ...liveTool.tool, live: undefined } },
      { ...liveCompaction, id: 20, live: undefined },
      afterLive
    ]

    const placedUser = { ...liveUser, timestamp: undefined, historyReconciled: true }
    const placedTool = { ...liveTool, historyReconciled: true }
    const placedCompaction = { ...liveCompaction, historyReconciled: true }
    const reconciled = reconcileNewerTimelineItems(existing, incoming)
    expect(reconciled).toEqual({
      items: [existing[0], middle, placedUser, placedTool, placedCompaction, afterLive],
      appended: [middle, placedUser, placedTool, placedCompaction, afterLive]
    })
    const next: TimelineItem = { kind: 'user', id: 22, entryId: 'next', text: 'next page' }
    expect(reconcileNewerTimelineItems(reconciled.items, [afterLive, next])).toEqual({
      items: [...reconciled.items, next],
      appended: [next]
    })
  })

  it('projects pure and mixed final image results without treating image data as text', () => {
    const pure = applyToolResult(imageTool, { content: [previewPart] }, false)
    expect(pure).toMatchObject({
      status: 'done', resultReceived: true, outputText: '',
      images: [{ ...previewPart, width: 1, height: 1, partIndex: 0 }]
    })
    expect(pure.imageNotice).toBeUndefined()

    const mixed = applyToolResult(imageTool, {
      content: [{ type: 'text', text: '已保存 images/result.png' }, previewPart, { type: 'text', text: '小图预览' }],
      details: { imageGeneration: { path: 'images/result.png', width: 1024, height: 1024, byteLength: 100_000 } }
    }, false)
    expect(mixed.outputText).toBe('已保存 images/result.png\n小图预览')
    expect(mixed.images).toEqual([{ ...previewPart, width: 1, height: 1, partIndex: 1 }])
    expect(mixed.path).toBe('images/result.png')
    expect(mixed).not.toHaveProperty('details')
  })

  it.each([
    { model: undefined, requestedModel: CODEX_IMAGE_REQUEST_ALIAS, label: 'Codex 自动（官方别名）', experimental: false },
    { model: 'gpt-image-2.5-flare', requestedModel: 'gpt-image-2.5-flare', label: 'Images 2.5 Flare（实验性）', experimental: true },
    { model: 'gpt-image-2.5-sunburst', requestedModel: 'gpt-image-2.5-sunburst', label: 'Images 2.5 Sunburst（实验性）', experimental: true },
    { model: 'unknown-sensitive-string', requestedModel: null, label: '未知请求型号', experimental: false },
    { model: null, requestedModel: null, label: '未知请求型号', experimental: false }
  ])('previews only allowlisted request models from tool arguments: $model', ({ model, requestedModel, label, experimental }) => {
    expect(parseToolArgs(IMAGE_GENERATION_TOOL_NAME, { path: 'images/request.png', model })).toEqual({
      path: 'images/request.png', imageModelInfo: { requestedModel, requestLabel: label, experimental, resolvedModel: null }
    })
    expect(parseToolArgs('read', { model, path: 'images/request.png' })).toEqual({ path: 'images/request.png' })
  })

  it.each([
    { args: {}, expected: undefined },
    { args: { size: '2048x3072', quality: 'high' }, expected: { requestedSize: '2048x3072', requestedQuality: 'high' } },
    { args: { size: 'auto', quality: 'auto', referenced_image_paths: [] },
      expected: { requestedSize: 'auto', requestedQuality: 'auto', referenceCount: 0, operation: 'generate' } },
    { args: { referenced_image_paths: ['images/source.png', 'images/other.jpeg'] },
      expected: { referenceCount: 2, operation: 'edit' } },
    { args: { size: 'bad-size-sensitive', quality: 'medium', referenced_image_paths: ['images/source.png'] },
      expected: { requestedQuality: 'medium', referenceCount: 1, operation: 'edit' } },
    { args: { size: '1024x1536', quality: 'bad-quality-sensitive', referenced_image_paths: ['../private.png'] },
      expected: { requestedSize: '1024x1536' } },
    { args: { referenced_image_paths: Array.from({ length: 5 }, (_, index) => `images/source-${index}.jpg`) },
      expected: { referenceCount: 5, operation: 'edit' } },
    { args: { referenced_image_paths: Array(6).fill('images/source.png') }, expected: undefined },
    { args: { referenced_image_paths: 'images/source.png' }, expected: undefined },
    { args: { referenced_image_paths: null }, expected: undefined },
    { args: { requestedSize: '2048x3072', requestedQuality: 'high', operation: 'edit', referenceCount: 5,
        width: 4096, height: 4096, byteLength: 100_000, mask: 'images/source.png' }, expected: undefined }
  ])('projects only explicit valid image arguments, with no absent defaults or original metadata: %j', ({ args, expected }) => {
    const result = parseToolArgs(IMAGE_GENERATION_TOOL_NAME, args)
    expect(result.imageSettingsInfo).toEqual(expected)
    expect(result.imageSettingsInfo ?? {}).not.toHaveProperty('savedWidth')
    expect(result.imageSettingsInfo ?? {}).not.toHaveProperty('savedHeight')
    expect(result.imageSettingsInfo ?? {}).not.toHaveProperty('savedByteLength')
    expect(JSON.stringify(result)).not.toContain('images/source')
    expect(JSON.stringify(result)).not.toContain('private.png')
    expect(JSON.stringify(result)).not.toContain('sensitive')
    expect(parseToolArgs('read', args).imageSettingsInfo).toBeUndefined()
  })

  it.each([1, 2])('replays v%s original dimensions without backfilling missing settings from call arguments', (version) => {
    const metadata = Object.freeze({ version, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
      requestedModel: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/saved.png', width: 1024, height: 1536,
      byteLength: 100_000, actualSize: '4096x4096', quality: 'untrusted-quality-echo',
      referenced_image_paths: ['images/private-source.png'], referenceBytes: 'original-sensitive-bytes' })
    const entries: WireEntry[] = [
      { type: 'message', id: 'settings-call', parentId: null, timestamp: '', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: imageTool.id, name: imageTool.name,
          arguments: { path: 'images/argument.png', size: '2048x3072', quality: 'high',
            referenced_image_paths: ['images/argument-source.png'], width: 2048, height: 3072 } }]
      } },
      { type: 'message', id: 'settings-result', parentId: 'settings-call', timestamp: '', message: {
        role: 'toolResult', toolCallId: imageTool.id, toolName: imageTool.name, isError: false,
        content: [previewPart], details: { imageGeneration: metadata }
      } }
    ]
    const before = JSON.stringify(entries)
    const replay = entriesToTimeline(entries)
    if (replay[0]?.kind !== 'tool') throw new Error('Missing tool')
    expect(replay[0].tool.imageSettingsInfo).toEqual({ savedWidth: 1024, savedHeight: 1536, savedByteLength: 100_000 })
    expect(replay[0].tool.images?.[0]).toMatchObject({ width: 1, height: 1 })
    expect(JSON.stringify(replay)).not.toContain('private-source')
    expect(JSON.stringify(replay)).not.toContain('argument-source')
    expect(JSON.stringify(replay)).not.toContain('original-sensitive-bytes')
    expect(JSON.stringify(replay)).not.toContain('untrusted-quality-echo')
    expect(JSON.stringify(entries)).toBe(before)
  })

  it('keeps request settings separate from saved PNG dimensions and ignores damaged fields independently', () => {
    const result = applyToolResult({ ...imageTool, ...parseToolArgs(imageTool.name, {
      size: '1024x1024', quality: 'low', referenced_image_paths: []
    }) }, {
      content: [previewPart], details: { imageGeneration: {
        version: 2, provider: 'openai-codex', operation: 'edit', requestedSize: '2048x3072',
        requestedQuality: 'high', referenceCount: 2, width: 1024, height: 1536, byteLength: 100_000,
        actualQuality: 'untrusted-quality-echo', actualWidth: 4096, actualHeight: 4096,
        referenced_image_paths: ['images/private-source.png'], referenceBytes: 'original-sensitive-bytes'
      } }
    }, false)
    expect(result.imageSettingsInfo).toEqual({ operation: 'edit', requestedSize: '2048x3072',
      requestedQuality: 'high', referenceCount: 2, savedWidth: 1024, savedHeight: 1536, savedByteLength: 100_000 })
    expect(result.images?.[0]).toMatchObject({ width: 1, height: 1 })
    expect(JSON.stringify(result)).not.toContain('untrusted-quality-echo')
    expect(JSON.stringify(result)).not.toContain('private-source')
    expect(JSON.stringify(result)).not.toContain('original-sensitive-bytes')
    const damaged = applyToolResult(result, { content: [previewPart], details: { imageGeneration: {
      version: 2, provider: 'openai-codex', operation: 'unknown-sensitive-operation',
      requestedSize: '2048X3072', requestedQuality: 'medium', referenceCount: 6,
      width: 1024, height: 1536, byteLength: 'unknown-sensitive-bytes'
    } } }, false, 'message')
    expect(damaged.imageSettingsInfo).toEqual({ requestedQuality: 'medium', savedWidth: 1024, savedHeight: 1536 })
    expect(damaged.images).toBe(result.images)
    expect(JSON.stringify(damaged)).not.toContain('unknown-sensitive')
  })

  it.each([
    undefined,
    {},
    { version: 99, provider: 'openai-codex' },
    { version: 2, provider: 'other-provider' }
  ])('clears argument settings for missing or unsupported final metadata: %j', (metadata) => {
    const requested = { ...imageTool, ...parseToolArgs(imageTool.name, {
      size: '2048x3072', quality: 'high', referenced_image_paths: ['images/source.png']
    }) }
    const result = applyToolResult(requested, { content: [previewPart], details: {
      imageGeneration: metadata && { ...metadata, operation: 'edit', requestedSize: '2048x3072',
        requestedQuality: 'high', referenceCount: 1, width: 1024, height: 1536 }
    } }, false, 'history')
    expect(result.imageSettingsInfo).toBeUndefined()
    expect(result.images).toHaveLength(1)
  })

  it.each([
    { metadata: { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
        requestedModel: 'gpt-image-2.5-flare' },
      requestedModel: CODEX_IMAGE_REQUEST_ALIAS, label: 'Codex 自动（官方别名）', experimental: false },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare',
        model: CODEX_IMAGE_REQUEST_ALIAS },
      requestedModel: 'gpt-image-2.5-flare', label: 'Images 2.5 Flare（实验性）', experimental: true },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-sunburst' },
      requestedModel: 'gpt-image-2.5-sunburst', label: 'Images 2.5 Sunburst（实验性）', experimental: true },
    { metadata: { version: 1, provider: 'openai-codex', model: 'unknown-sensitive-string' },
      requestedModel: null, label: '未知请求型号', experimental: false },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'unknown-sensitive-string' },
      requestedModel: null, label: '未知请求型号', experimental: false }
  ])('replays v$metadata.version request metadata without trusting an actual-model echo: $label', ({ metadata, requestedModel, label, experimental }) => {
    const generated = Object.freeze({ ...metadata, resolvedModel: 'gpt-image-2.5-sunburst',
      actualModel: 'untrusted-provider-echo', path: 'images/saved.png', mimeType: 'image/png',
      byteLength: 100_000, width: 1024, height: 1024, previewAvailable: true })
    const entries: WireEntry[] = [
      { type: 'message', id: 'model-call', parentId: null, timestamp: '', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: imageTool.id, name: imageTool.name,
          arguments: { path: 'images/argument.png', model: 'gpt-image-2.5-sunburst' } }]
      } },
      { type: 'message', id: 'model-result', parentId: 'model-call', timestamp: '', message: {
        role: 'toolResult', toolCallId: imageTool.id, toolName: imageTool.name, isError: false,
        content: [previewPart], details: { imageGeneration: generated }
      } }
    ]
    const original = JSON.stringify(entries)
    const replay = entriesToTimeline(entries)
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({ kind: 'tool', historical: true, tool: {
      path: 'images/saved.png', resultSource: 'history',
      images: [{ partIndex: 0, width: 1, height: 1 }],
      imageModelInfo: { requestedModel, requestLabel: label, experimental, resolvedModel: null }
    } })
    if (replay[0].kind !== 'tool') throw new Error('Missing historical tool')
    expect(replay[0].tool.imageModelInfo).not.toHaveProperty('actualModel')
    expect(replay[0].tool).not.toHaveProperty('details')
    expect(JSON.stringify(entries)).toBe(original)
    expect(entriesToTimeline(entries)[0].id).toBe(replay[0].id)
  })

  it.each([
    {},
    { version: 99, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' },
    { version: 2, provider: 'other-provider', requestedModel: 'gpt-image-2.5-flare' }
  ])('keeps paths and valid previews when saved model metadata is missing or damaged: %j', (metadata) => {
    const result = applyToolResult({ ...imageTool, ...parseToolArgs(imageTool.name, {}) }, {
      content: [previewPart], details: { imageGeneration: { ...metadata,
        path: 'images/saved.png', resolvedModel: 'unknown-sensitive-string' } }
    }, false, 'history')
    expect(result.path).toBe('images/saved.png')
    expect(result.images).toEqual([{ ...previewPart, width: 1, height: 1, partIndex: 0 }])
    expect(result.imageModelInfo).toBeUndefined()
  })

  it('keeps valid bounded previews and reports invalid or over-limit image parts', () => {
    const rejected = applyToolResult(imageTool, {
      content: [
        { type: 'text', text: '保留文字' },
        { ...previewPart, data: 'not-base64!' },
        { ...previewPart, mimeType: 'image/svg+xml' },
        { ...previewPart, data: 'A'.repeat(MAX_TOOL_IMAGE_BASE64_LENGTH + 4) },
        previewPart
      ]
    }, false)
    expect(rejected.outputText).toBe('保留文字')
    expect(rejected.images).toEqual([{ ...previewPart, width: 1, height: 1, partIndex: 4 }])
    expect(rejected.imageNotice).toBe('部分图片因格式或大小限制未显示。')

    const overCount = applyToolResult(imageTool, { content: Array.from({ length: MAX_TOOL_IMAGES + 1 }, () => previewPart) }, false)
    expect(overCount.images?.map(({ partIndex }) => partIndex)).toEqual([0, 1, 2, 3])
    expect(overCount.imageNotice).toBe(rejected.imageNotice)
    const replaced = applyToolResult(rejected, { content: [{ type: 'text', text: 'new final' }] }, false)
    expect(replaced.images).toEqual([])
    expect(replaced.imageNotice).toBeUndefined()
  })

  it('replays final previews through the same projection with stable tool and part identities', () => {
    const payload = { content: [{ type: 'text', text: '已保存' }, previewPart] }
    const entries: WireEntry[] = [
      {
        type: 'message', id: 'image-assistant', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: imageTool.id, name: imageTool.name, arguments: {} }] }
      },
      {
        type: 'message', id: 'image-result', parentId: 'image-assistant', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'toolResult', toolCallId: imageTool.id, toolName: imageTool.name, isError: false, ...payload }
      }
    ]
    const first = entriesToTimeline(entries)
    const second = entriesToTimeline(entries)
    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first[0]).toMatchObject({
      kind: 'tool', historical: true,
      tool: applyToolResult({ id: imageTool.id, name: imageTool.name, status: 'running', isError: false }, payload, false, 'history')
    })
    expect(first[0].kind === 'tool' && first[0].tool.live).toBeUndefined()
  })

  it('finishes a running live tool from its persisted page while retaining its key and live tail order', () => {
    const live: TimelineItem = { kind: 'tool', id: 40, tool: { ...imageTool, outputText: '生成中' }, noReveal: true }
    const tail: TimelineItem[] = [
      { kind: 'tool', id: 41, tool: { id: 'tail-tool', name: 'read', status: 'running', isError: false, live: true } },
      { kind: 'assistant', id: 42, text: 'live tail', thinking: '', streaming: true, live: true }
    ]
    const finalTool = applyToolResult({ ...imageTool, live: undefined }, { content: [previewPart] }, false)
    const page: TimelineItem[] = [
      { kind: 'user', id: 43, entryId: 'middle-image', text: 'middle' },
      { kind: 'tool', id: 44, tool: finalTool, historical: true },
      { kind: 'user', id: 45, entryId: 'after-image', text: 'after' }
    ]
    const merged = reconcileNewerTimelineItems([live, ...tail], page)
    expect(merged.items.map(({ id }) => id)).toEqual([43, live.id, 45, 41, 42])
    expect(merged.items[1]).toMatchObject({
      noReveal: true, historyReconciled: true,
      tool: { status: 'done', outputText: '', live: true, images: finalTool.images }
    })
    expect(merged.items[1].kind === 'tool' && merged.items[1].tool.images).toBe(finalTool.images)
  })

  it('does not overwrite an already final live tool with an older page result', () => {
    const live: TimelineItem = {
      kind: 'tool', id: 46,
      tool: applyToolResult(imageTool, { content: [previewPart, { type: 'text', text: 'new final' }] }, false)
    }
    const persisted: TimelineItem = {
      kind: 'tool', id: 47,
      tool: applyToolResult({ ...imageTool, live: undefined }, { content: [{ type: 'text', text: 'old final' }] }, true)
    }
    const merged = reconcileNewerTimelineItems([live], [persisted])
    expect(merged.items).toEqual([{ ...live, historyReconciled: true }])
    expect(merged.items[0].kind === 'tool' && merged.items[0].tool).toBe(live.tool)
  })

  it('does not finish a call-only page but accepts a later overlapping final without moving the prefix', () => {
    const live: TimelineItem = { kind: 'tool', id: 48, tool: imageTool }
    const callOnly: TimelineItem = {
      kind: 'tool', id: 49, tool: { ...imageTool, live: undefined, status: 'done' }
    }
    const first = reconcileNewerTimelineItems([live], [callOnly])
    expect(first.items[0]).toMatchObject({ id: live.id, tool: { status: 'running' }, historyReconciled: true })
    const after: TimelineItem = { kind: 'user', id: 50, entryId: 'after-call', text: 'after' }
    const final: TimelineItem = {
      ...callOnly, tool: applyToolResult(callOnly.tool, { content: [previewPart] }, false)
    }
    const completed = reconcileNewerTimelineItems([...first.items, after], [final])
    expect(completed.appended).toEqual([])
    expect(completed.items.map(({ id }) => id)).toEqual([live.id, after.id])
    expect(completed.items[0]).toMatchObject({ tool: { status: 'done', images: final.tool.images } })
  })

  it('fills a call-only historical done row from a later result without moving its key', () => {
    const callOnly: TimelineItem = {
      kind: 'tool', id: 151, historical: true,
      tool: { ...imageTool, live: undefined, status: 'done', resultReceived: undefined }
    }
    const after: TimelineItem = { kind: 'user', id: 152, entryId: 'after-image', text: 'after' }
    const final: TimelineItem = {
      kind: 'tool', id: 153,
      tool: applyToolResult({ ...imageTool, live: undefined }, { content: [previewPart] }, false, 'history')
    }
    const reconciled = reconcileNewerTimelineItems([callOnly, after], [final])
    expect(reconciled.items.map(({ id }) => id)).toEqual([callOnly.id, after.id])
    expect(reconciled.appended).toEqual([])
    expect(reconciled.items[0]).toMatchObject({
      historical: true, tool: { images: final.tool.images, resultReceived: true, resultSource: 'history' }
    })
  })

  it('counts display-diff additions and deletions', () => {
    expect(diffStats(' 4 context\n-5 old\n+5 new\n+6 next')).toEqual({ additions: 2, deletions: 1 })
  })

  it('keeps the latest tool result and task snapshot', () => {
    const tool: ToolItem = { id: 't1', name: 'pion_task', status: 'running', isError: false }
    const result = applyToolResult(tool, {
      content: [{ type: 'text', text: 'updated' }],
      details: { tasks: [{ id: 1, subject: 'Validate', status: 'in_progress' }] }
    }, false)

    expect(result).toMatchObject({ status: 'done', outputText: 'updated' })
    expect(result.todos).toEqual([
      expect.objectContaining({ id: 1, title: 'Validate', status: 'in_progress' })
    ])
  })

  it('derives changes only after the latest user turn', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'old' },
      { kind: 'tool', id: 2, tool: { id: 'a', name: 'write', status: 'done', isError: false, path: 'old.ts', writeContent: 'old' } },
      { kind: 'user', id: 3, text: 'new' },
      { kind: 'tool', id: 4, tool: { id: 'b', name: 'edit', status: 'done', isError: false, path: 'new.ts', diff: '-1 old\n+1 new' } }
    ]

    expect(deriveLatestRunChanges(timeline)).toEqual([
      { path: 'new.ts', kind: 'edit', diff: '-1 old\n+1 new', additions: 1, deletions: 1 }
    ])
  })

  it('retains every captured edit for the same file in the current turn', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'update twice' },
      { kind: 'tool', id: 2, tool: { id: 'a', name: 'edit', status: 'done', isError: false, path: 'src/a.ts', diff: '-1 old\n+1 middle' } },
      { kind: 'tool', id: 3, tool: { id: 'b', name: 'edit', status: 'done', isError: false, path: 'src/a.ts', diff: '-3 before\n+3 after' } }
    ]

    expect(deriveLatestRunChanges(timeline)).toEqual([
      {
        path: 'src/a.ts',
        kind: 'edit',
        diff: '-1 old\n+1 middle\n  ...\n-3 before\n+3 after',
        additions: 2,
        deletions: 2
      }
    ])
  })

  it('replays persisted task snapshots into the current plan', () => {
    const timeline = entriesToTimeline([
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Implement tests' }
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'pion_task', arguments: {} }] }
      },
      {
        type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'toolResult', toolCallId: 't1', toolName: 'pion_task', isError: false,
          content: [{ type: 'text', text: 'ok' }],
          details: { tasks: [{ id: 1, subject: 'Implement tests', status: 'pending' }] }
        }
      }
    ])

    expect(deriveAgentTodos(timeline)).toEqual([
      expect.objectContaining({ title: 'Implement tests', status: 'pending' })
    ])
  })

  it('keeps a completed plan until the next turn starts planning', () => {
    const completedPlan: TimelineItem[] = [
      { kind: 'user', id: 1, entryId: 'u1', text: 'First turn' },
      {
        kind: 'tool',
        id: 2,
        tool: {
          id: 'tasks-1',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: [{ id: 1, title: 'Finish first turn', status: 'completed' }]
        }
      },
      { kind: 'user', id: 3, entryId: 'u2', text: 'Second turn' }
    ]

    expect(deriveAgentTodos(completedPlan)).toEqual([
      { id: 1, title: 'Finish first turn', status: 'completed' }
    ])

    const clearedPlan: TimelineItem[] = [
      ...completedPlan,
      {
        kind: 'tool',
        id: 4,
        tool: {
          id: 'tasks-2',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: []
        }
      }
    ]
    expect(deriveAgentTodos(clearedPlan)).toBeNull()

    expect(deriveAgentTodos([
      ...clearedPlan,
      {
        kind: 'tool',
        id: 5,
        tool: {
          id: 'tasks-3',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: [{ id: 1, title: 'Start second turn', status: 'pending' }]
        }
      }
    ])).toEqual([{ id: 1, title: 'Start second turn', status: 'pending' }])
  })

  it('produces stable ids across rebuilds of the same entries', () => {
    const entries = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: '问题' }] }
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }
          ]
        }
      }
    ] as never[]
    const first = entriesToTimeline(entries).map((item) => item.id)
    const second = entriesToTimeline(entries).map((item) => item.id)
    expect(second).toEqual(first)
    expect(new Set(first).size).toBe(first.length)
  })

  it('extracts real assistant diagnostics but suppresses aborted messages by stop reason', () => {
    expect(assistantErrorText({ role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable' }))
      .toBe('provider unavailable')
    expect(assistantErrorText({ role: 'assistant', stopReason: 'error', errorMessage: 'Request was aborted' }))
      .toBe('Request was aborted')
    expect(assistantErrorText({ role: 'assistant', stopReason: 'error', content: [] }))
      .toBe('模型请求失败，但提供商未返回技术详情。')
    expect(assistantErrorText({ role: 'assistant', stopReason: 'stop', errorMessage: 'stale diagnostic' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', stopReason: 'aborted', errorMessage: 'This operation was aborted' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', errorMessage: 'Request was aborted' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', errorMessage: 'request aborted.' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', content: 'not an errorMessage' }))
      .toBeUndefined()
  })

  it('replays pure and partial assistant errors with stable historical identity', () => {
    const entries = [
      {
        type: 'message', id: 'error-only', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant', content: [], timestamp: 1_780_000_000_000,
          stopReason: 'error', errorMessage: 'provider unavailable'
        }
      },
      {
        type: 'message', id: 'partial-error', parentId: 'error-only', timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '正在检查' },
            { type: 'text', text: '部分回答' }
          ],
          stopReason: 'error',
          errorMessage: 'connection lost'
        }
      },
      {
        type: 'message', id: 'aborted', parentId: 'partial-error', timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'assistant', content: [], stopReason: 'aborted',
          errorMessage: 'This operation was aborted by the provider SDK'
        }
      }
    ] as never[]

    const first = entriesToTimeline(entries)
    const second = entriesToTimeline(entries)

    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({
      kind: 'assistant',
      entryId: 'error-only',
      messageTimestamp: 1_780_000_000_000,
      text: '',
      thinking: '',
      streaming: false,
      error: 'provider unavailable',
      historical: true
    })
    expect(first[1]).toMatchObject({
      kind: 'assistant',
      entryId: 'partial-error',
      text: '部分回答',
      thinking: '正在检查',
      streaming: false,
      error: 'connection lost',
      historical: true
    })
    expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id))
    expect(second.map((item) => item.kind === 'assistant' ? item.entryId : undefined))
      .toEqual(['error-only', 'partial-error'])
    expect(second.every((item) => item.historical)).toBe(true)
  })
})
