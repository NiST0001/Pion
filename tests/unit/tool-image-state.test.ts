import { afterEach, describe, expect, it, vi } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { applyToolResult, collectToolResults, entriesToTimeline, toolResultMatches } from '../../src/renderer/src/agent/timeline'
import { initialState, type AgentState, type TimelineItem, type ToolItem } from '../../src/renderer/src/agent/types'
import { CODEX_IMAGE_REQUEST_ALIAS, IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import type { WireEntry, WireEventInput, WireMessage } from '../../src/shared/types'
import * as toolImages from '../../src/shared/tool-images'

const previewPart = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const tool: ToolItem = {
  id: 'image-call', name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true
}
const finalMessage: WireMessage = {
  role: 'toolResult', toolCallId: tool.id, toolName: tool.name, isError: false,
  content: [{ type: 'text', text: '已保存 images/generated.png' }, previewPart],
  details: { imageGeneration: { path: 'images/generated.png' } }
}
function event(state: AgentState, input: WireEventInput): AgentState {
  return reducer(state, { type: 'event', event: input })
}
function toolRow(state: AgentState) {
  const row = state.timeline.find((item) => item.kind === 'tool')
  if (row?.kind !== 'tool') throw new Error('Missing tool row')
  return row
}

afterEach(() => vi.restoreAllMocks())

describe('tool image state', () => {
  it('does not project nested executions as orphan transcript roots or decode their images', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    let state = event(initialState, {
      type: 'tool_execution_start', toolCallId: 'script', toolName: 'codemode', args: { code: 'await tools.read({ path: "file" })' }
    })
    const parent = toolRow(state)
    for (const input of [
      { type: 'tool_execution_start', toolCallId: 'nested', parentToolCallId: 'script', toolName: 'read', args: { path: 'file' } },
      { type: 'tool_execution_update', toolCallId: 'nested', parentToolCallId: 'script', toolName: 'read', partialResult: finalMessage },
      { type: 'tool_execution_end', toolCallId: 'nested', parentToolCallId: 'script', toolName: 'read', result: finalMessage, isError: false },
      // A missed parent/start must not make the child an independent root either.
      { type: 'tool_execution_start', toolCallId: 'orphan', parentToolCallId: 'missing-parent', toolName: 'read', args: {} }
    ]) state = event(state, input as WireEventInput)
    expect(state.timeline).toEqual([parent])
    expect(collect).not.toHaveBeenCalled()
    state = event(state, {
      type: 'tool_execution_end', toolCallId: 'script', toolName: 'codemode',
      result: { content: [{ type: 'text', text: 'Script completed' }] }, isError: false
    })
    expect(toolRow(state)).toMatchObject({ id: parent.id, tool: { id: 'script', outputText: 'Script completed', status: 'done' } })
  })

  it.each(['codemode', 'mcp__server__image'])('keeps %s previews bounded and never projects raw result metadata', (name) => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const payload = {
      content: [{ type: 'text', text: 'output' }, previewPart],
      structuredContent: { data: 'raw-secret-image', metadata: 'private-input-metadata' },
      details: { rawImage: 'raw-secret-image', metadata: 'private-input-metadata' }
    }
    const first = applyToolResult({ ...tool, name }, payload, false)
    const second = applyToolResult(first, { ...payload, content: [{ type: 'text', text: 'final output' }, previewPart] }, false, 'message')
    expect(second.images).toBe(first.images)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(second.outputText).toBe('final output')
    expect(JSON.stringify(second)).not.toContain('raw-secret-image')
    expect(JSON.stringify(second)).not.toContain('private-input-metadata')
    const rejected = applyToolResult(second, {
      content: [{ ...previewPart, data: previewPart.data + '!'.repeat(toolImages.MAX_TOOL_IMAGE_BASE64_LENGTH) }]
    }, false)
    expect(rejected.images).toEqual([])
    expect(rejected.imageNotice).toBeTruthy()
  })

  it('keeps partial updates text-only and validates previews once at the final result', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    let state = event(initialState, { type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: {} })
    const id = toolRow(state).id
    for (const text of ['生成中', '生成中…']) {
      state = event(state, {
        type: 'tool_execution_update', toolCallId: tool.id, toolName: tool.name,
        partialResult: { content: [{ type: 'text', text }, previewPart] }
      })
      expect(toolRow(state).tool).toMatchObject({ status: 'running', outputText: text })
      expect(toolRow(state).tool.images).toBeUndefined()
    }
    expect(collect).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()

    state = event(state, {
      type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: finalMessage, isError: false
    })
    expect(toolRow(state)).toMatchObject({
      id, tool: { status: 'done', path: 'images/generated.png', images: [{ width: 1, height: 1, partIndex: 1 }] }
    })
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
    const images = toolRow(state).tool.images
    const ended = event(state, { type: 'message_end', message: finalMessage })
    expect(toolRow(ended).tool.resultSource).toBe('message')
    expect(toolRow(ended).tool.images).toBe(images)
    const duplicate = event(ended, { type: 'message_end', message: finalMessage })
    expect(duplicate.timeline).toBe(ended.timeline)
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it.each(['execution', 'message', 'history'] as const)('accepts model-only final changes after %s without decoding or replacing previews', (source) => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const savedAlias: WireMessage = {
      ...finalMessage,
      details: { imageGeneration: { version: 1, provider: 'openai-codex',
        model: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/generated.png' } }
    }
    const row: TimelineItem = { kind: 'tool', id: 180, tool: applyToolResult(tool, savedAlias, false, source) }
    const images = row.tool.images
    const replacement: WireMessage = {
      ...savedAlias,
      details: { imageGeneration: { version: 2, provider: 'openai-codex',
        requestedModel: 'gpt-image-2.5-flare', resolvedModel: 'untrusted-actual-echo',
        path: 'images/generated.png' } }
    }
    expect(toolResultMatches(row.tool, replacement, false)).toBe(false)
    const final = event({ ...initialState, timeline: [row] }, { type: 'message_end', message: replacement })
    expect(toolRow(final)).toMatchObject({ id: row.id, tool: {
      resultSource: 'message', imageModelInfo: {
        requestedModel: 'gpt-image-2.5-flare', requestLabel: 'Images 2.5 Flare（实验性）',
        experimental: true, resolvedModel: null
      }
    } })
    expect(toolRow(final).tool.images).toBe(images)
    expect(toolRow(final).tool.images?.[0]).toBe(images?.[0])
    expect(event(final, { type: 'message_end', message: replacement }).timeline).toBe(final.timeline)
    expect(event(final, { type: 'tool_execution_end', toolCallId: tool.id,
      toolName: tool.name, result: savedAlias, isError: false }).timeline).toBe(final.timeline)
    const echoChanged: WireMessage = { ...replacement, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare',
      resolvedModel: 'another-untrusted-echo', path: 'images/generated.png'
    } } }
    expect(toolResultMatches(toolRow(final).tool, echoChanged, false)).toBe(true)
    expect(event(final, { type: 'message_end', message: echoChanged }).timeline).toBe(final.timeline)
    const oldPage: TimelineItem = { ...row, id: 181, historical: true }
    const paged = reducer(final, { type: 'appendEntries', items: [oldPage] })
    expect(toolRow(paged).id).toBe(row.id)
    expect(toolRow(paged).tool).toBe(toolRow(final).tool)
    const replaced = reducer(final, { type: 'loadEntries', items: [oldPage],
      preserveToolState: { revision: final.timelineScopeRevision } })
    expect(toolRow(replaced).tool).toBe(toolRow(final).tool)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it.each(['execution', 'message', 'history'] as const)('accepts settings-only message_end after %s without replacing previews or weakening final priority', (source) => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const saved: WireMessage = { ...finalMessage, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      path: 'images/generated.png', operation: 'generate', requestedSize: 'auto',
      requestedQuality: 'auto', referenceCount: 0, width: 1024, height: 1024, byteLength: 100_000
    } } }
    const row: TimelineItem = { kind: 'tool', id: 184, noReveal: true,
      tool: applyToolResult(tool, saved, false, source) }
    const replacement: WireMessage = { ...saved, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      path: 'images/generated.png', operation: 'edit', requestedSize: '2048x3072',
      requestedQuality: 'high', referenceCount: 2, width: 1024, height: 1536, byteLength: 120_000,
      actualQuality: 'untrusted-quality-echo', resolvedModel: 'untrusted-engine-echo'
    } } }
    expect(toolResultMatches(row.tool, replacement, false)).toBe(false)
    const final = event({ ...initialState, timeline: [row] }, { type: 'message_end', message: replacement })
    expect(toolRow(final)).toMatchObject({ id: row.id, noReveal: true, tool: {
      resultSource: 'message', imageSettingsInfo: { operation: 'edit', requestedSize: '2048x3072',
        requestedQuality: 'high', referenceCount: 2, savedWidth: 1024, savedHeight: 1536, savedByteLength: 120_000 }
    } })
    expect(toolRow(final).tool.images).toBe(row.tool.images)
    expect(toolRow(final).tool.images?.[0]).toBe(row.tool.images?.[0])
    expect(toolRow(final).tool.outputText).toBe(row.tool.outputText)
    expect(toolRow(final).tool.imageModelInfo).toEqual(row.tool.imageModelInfo)
    expect(event(final, { type: 'message_end', message: replacement }).timeline).toBe(final.timeline)
    expect(event(final, { type: 'tool_execution_end', toolCallId: tool.id,
      toolName: tool.name, result: saved, isError: false }).timeline).toBe(final.timeline)
    const oldPage: TimelineItem = { ...row, id: 185, historical: true }
    expect(toolRow(reducer(final, { type: 'appendEntries', items: [oldPage] })).tool).toBe(toolRow(final).tool)
    expect(toolRow(reducer(final, { type: 'loadEntries', items: [oldPage],
      preserveToolState: { revision: final.timelineScopeRevision } })).tool).toBe(toolRow(final).tool)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it.each([
    { field: 'operation', value: 'edit', projected: 'operation', expected: 'edit' },
    { field: 'requestedSize', value: '2048x3072', projected: 'requestedSize', expected: '2048x3072' },
    { field: 'requestedQuality', value: 'high', projected: 'requestedQuality', expected: 'high' },
    { field: 'referenceCount', value: 5, projected: 'referenceCount', expected: 5 },
    { field: 'width', value: 2048, projected: 'savedWidth', expected: 2048 },
    { field: 'height', value: 1536, projected: 'savedHeight', expected: 1536 },
    { field: 'byteLength', value: 120_000, projected: 'savedByteLength', expected: 120_000 },
    { field: 'operation', value: undefined, projected: 'operation', expected: undefined },
    { field: 'requestedSize', value: undefined, projected: 'requestedSize', expected: undefined },
    { field: 'requestedQuality', value: undefined, projected: 'requestedQuality', expected: undefined },
    { field: 'referenceCount', value: undefined, projected: 'referenceCount', expected: undefined },
    { field: 'width', value: undefined, projected: 'savedWidth', expected: undefined },
    { field: 'height', value: undefined, projected: 'savedHeight', expected: undefined },
    { field: 'byteLength', value: undefined, projected: 'savedByteLength', expected: undefined }
  ])('compares an independently changed/removed final field: $field → $value', ({ field, value, projected, expected }) => {
    const decode = vi.spyOn(globalThis, 'atob')
    const metadata: Record<string, unknown> = { version: 2, provider: 'openai-codex',
      requestedModel: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/generated.png', operation: 'generate',
      requestedSize: 'auto', requestedQuality: 'auto', referenceCount: 0,
      width: 1024, height: 1024, byteLength: 100_000 }
    const row: TimelineItem = { kind: 'tool', id: 186,
      tool: applyToolResult(tool, { ...finalMessage, details: { imageGeneration: metadata } }, false, 'message') }
    const changed = { ...metadata }
    if (value === undefined) delete changed[field]
    else changed[field] = value
    const replacement: WireMessage = { ...finalMessage, details: { imageGeneration: changed } }
    expect(toolResultMatches(row.tool, replacement, false)).toBe(false)
    const final = event({ ...initialState, timeline: [row] }, { type: 'message_end', message: replacement })
    expect(toolRow(final).id).toBe(row.id)
    // Removed fields are absent from the bounded projection, not unknown strings.
    if (expected === undefined) expect(toolRow(final).tool.imageSettingsInfo).not.toHaveProperty(projected)
    else expect(toolRow(final).tool.imageSettingsInfo).toHaveProperty(projected, expected)
    expect(toolRow(final).tool.images).toBe(row.tool.images)
    expect(event(final, { type: 'message_end', message: replacement }).timeline).toBe(final.timeline)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it.each(['execution', 'message', 'history'] as const)('removes all old settings after %s without backfilling arguments or swallowing the final', (source) => {
    const decode = vi.spyOn(globalThis, 'atob')
    const saved: WireMessage = { ...finalMessage, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      path: 'images/generated.png', operation: 'edit', requestedSize: '2048x3072',
      requestedQuality: 'high', referenceCount: 1, width: 1024, height: 1536, byteLength: 100_000
    } } }
    const row: TimelineItem = { kind: 'tool', id: 187, tool: applyToolResult(tool, saved, false, source) }
    const replacement: WireMessage = { ...finalMessage, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      path: 'images/generated.png'
    } } }
    expect(toolResultMatches(row.tool, replacement, false)).toBe(false)
    const final = event({ ...initialState, timeline: [row] }, { type: 'message_end', message: replacement })
    expect(toolRow(final).tool.imageSettingsInfo).toBeUndefined()
    expect(toolRow(final).tool.imageModelInfo).toEqual(row.tool.imageModelInfo)
    expect(toolRow(final).tool.images).toBe(row.tool.images)
    expect(event(final, { type: 'message_end', message: replacement }).timeline).toBe(final.timeline)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('conservatively reprojects mixed rejected-image payloads even for settings-only changes', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const payload = { ...finalMessage, content: [previewPart, { ...previewPart, mimeType: 'image/svg+xml' }],
      details: { imageGeneration: { version: 2, provider: 'openai-codex', requestedQuality: 'low' } } }
    const first = applyToolResult(tool, payload, false)
    const replacement: WireMessage = { ...payload,
      details: { imageGeneration: { version: 2, provider: 'openai-codex', requestedQuality: 'high' } } }
    const final = event({ ...initialState, timeline: [{ kind: 'tool', id: 188, tool: first }] },
      { type: 'message_end', message: replacement })
    expect(toolRow(final).tool.imageSettingsInfo).toEqual({ requestedQuality: 'high' })
    expect(toolRow(final).tool.imageNotice).toBe(first.imageNotice)
    expect(toolRow(final).tool.images).not.toBe(first.images)
    expect(collect).toHaveBeenCalledTimes(2)
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('reuses previews independently of changed final text, path, status, diff and model', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const executed = applyToolResult(tool, { ...finalMessage, details: {
      diff: '-1 old\n+1 new', imageGeneration: { version: 1, provider: 'openai-codex',
        model: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/generated.png' }
    } }, false)
    const replacement: WireMessage = {
      ...finalMessage, isError: true,
      content: [{ type: 'text', text: 'final transformed warning' }, previewPart],
      details: { imageGeneration: { version: 2, provider: 'openai-codex',
        requestedModel: 'gpt-image-2.5-sunburst', path: 'images/final.png' } }
    }
    const final = event({ ...initialState, timeline: [{ kind: 'tool', id: 182, tool: executed }] },
      { type: 'message_end', message: replacement })
    expect(toolRow(final)).toMatchObject({ id: 182, tool: {
      status: 'error', isError: true, outputText: 'final transformed warning',
      path: 'images/final.png', resultSource: 'message',
      imageModelInfo: { requestedModel: 'gpt-image-2.5-sunburst', resolvedModel: null }
    } })
    expect(toolRow(final).tool.diff).toBeUndefined()
    expect(toolRow(final).tool.images).toBe(executed.images)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('clears unsupported model metadata without losing the path or re-decoding valid previews', () => {
    const decode = vi.spyOn(globalThis, 'atob')
    const first = applyToolResult(tool, { ...finalMessage, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare',
      path: 'images/generated.png'
    } } }, false)
    const invalid = { ...finalMessage, details: { imageGeneration: {
      version: 99, provider: 'openai-codex', requestedModel: 'arbitrary-string',
      resolvedModel: 'gpt-image-2.5-sunburst', path: 'images/generated.png'
    } } }
    expect(toolResultMatches(first, invalid, false)).toBe(false)
    const second = applyToolResult(first, invalid, false, 'message')
    expect(second.imageModelInfo).toBeUndefined()
    expect(second.path).toBe(first.path)
    expect(second.images).toBe(first.images)
    expect(toolResultMatches(second, invalid, false)).toBe(true)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('lets a transformed final message replace execution output and rejects late lower-level results', () => {
    const initial = { ...initialState, timeline: [{ kind: 'tool' as const, id: 120, tool }] }
    const executed = event(initial, {
      type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: finalMessage, isError: false
    })
    const replacement = {
      ...finalMessage, isError: true,
      content: [{ type: 'text', text: 'final transformed failure' }],
      details: { imageGeneration: { path: 'images/final.png' } }
    }
    const final = event(executed, { type: 'message_end', message: replacement })
    expect(toolRow(final)).toMatchObject({
      id: 120, tool: { status: 'error', outputText: 'final transformed failure', path: 'images/final.png', images: [], resultSource: 'message' }
    })
    const late = event(final, {
      type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: finalMessage, isError: false
    })
    expect(late.timeline).toBe(final.timeline)
    const messageFirst = event(initial, { type: 'message_end', message: replacement })
    expect(event(messageFirst, {
      type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: finalMessage, isError: false
    }).timeline).toBe(messageFirst.timeline)
  })

  it('recovers a missed execution_end through message_end without adding or resetting a row', () => {
    const row: TimelineItem = { kind: 'tool', id: 100, tool: { ...tool, live: undefined, status: 'done' }, historical: true, noReveal: true }
    const assistant: TimelineItem = { kind: 'assistant', id: 101, text: 'stream', thinking: '', streaming: true, live: true }
    const state = event({ ...initialState, timeline: [row, assistant] }, { type: 'message_end', message: finalMessage })
    expect(state.timeline).toHaveLength(2)
    expect(toolRow(state)).toMatchObject({
      id: row.id, historical: true, noReveal: true,
      tool: { status: 'done', resultReceived: true, images: [{ partIndex: 1 }], outputText: '已保存 images/generated.png' }
    })
    expect(state.timeline[1]).toBe(assistant)
    const duplicate = event(state, { type: 'message_end', message: finalMessage })
    expect(duplicate.timeline).toBe(state.timeline)
  })

  it('does not make an isolated tool row when a final result is outside the window or lacks an id', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const state = { ...initialState, timeline: [{ kind: 'user' as const, id: 102, text: 'history page' }] }
    expect(event(state, { type: 'message_end', message: finalMessage })).toBe(state)
    expect(event(state, { type: 'message_end', message: { role: 'toolResult', content: [previewPart] } })).toBe(state)
    expect(event(state, { type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: finalMessage, isError: false })).toBe(state)
    expect(collect).not.toHaveBeenCalled()
  })

  it('recovers pure image and rejected-image final messages with the final error status', () => {
    const initial = { ...initialState, timeline: [{ kind: 'tool' as const, id: 103, tool }] }
    const pure = event(initial, { type: 'message_end', message: { ...finalMessage, content: [previewPart] } })
    expect(toolRow(pure).tool).toMatchObject({ status: 'done', outputText: '', images: [{ partIndex: 0 }] })
    const rejected = event(initial, {
      type: 'message_end',
      message: { ...finalMessage, isError: true, content: [{ ...previewPart, data: 'invalid-base64' }] }
    })
    expect(toolRow(rejected).tool).toMatchObject({
      status: 'error', isError: true, images: [], imageNotice: '部分图片因格式或大小限制未显示。'
    })
  })

  it('ignores late partial output after a paged final snapshot has finished a running live row', () => {
    const running: TimelineItem = { kind: 'tool', id: 104, tool: { ...tool, outputText: 'partial' } }
    const final = applyToolResult({ ...tool, live: undefined }, finalMessage, false)
    const page = reducer({ ...initialState, timeline: [running] }, {
      type: 'appendEntries', items: [{ kind: 'tool', id: 105, tool: final, historical: true }]
    })
    expect(page.timelineMutation).toBe('history-append')
    expect(toolRow(page)).toMatchObject({ id: running.id, tool: { status: 'done', images: final.images } })
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const late = event(page, {
      type: 'tool_execution_update', toolCallId: tool.id, toolName: tool.name,
      partialResult: { content: [{ type: 'text', text: 'old partial' }, previewPart] }
    })
    expect(late.timeline).toBe(page.timeline)
    expect(late.timelineMutation).toBe('history-append')
    expect(toolRow(late)).toBe(toolRow(page))
    expect(toolRow(late).tool.images).toBe(final.images)
    expect(collect).not.toHaveBeenCalled()
  })

  it('keeps an existing replay key when execution_start arrives after the call page', () => {
    const row: TimelineItem = {
      kind: 'tool', id: 106, tool: { ...tool, live: undefined, status: 'done' }, historical: true
    }
    const started = event({ ...initialState, timeline: [row] }, {
      type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: {}
    })
    expect(started.timeline).toHaveLength(1)
    expect(toolRow(started)).toMatchObject({ id: row.id, historyReconciled: true, tool: { status: 'running', live: true } })
    const duplicate = event(started, { type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: {} })
    expect(duplicate.timeline).toBe(started.timeline)
    const ended = event(started, { type: 'message_end', message: finalMessage })
    expect(toolRow(ended)).toMatchObject({ id: row.id, tool: { status: 'done', images: [{ partIndex: 1 }] } })
  })

  it.each(['executed text', 'transformed text'])('clears a replaced result diff even when final text is %s', (text) => {
    const edit: ToolItem = {
      id: 'edit-call', name: 'edit', status: 'running', isError: false, live: true,
      path: 'src/file.ts', command: 'old → new', writeContent: 'argument content'
    }
    const initial = { ...initialState, timeline: [{ kind: 'tool' as const, id: 130, tool: edit }] }
    const executed = event(initial, {
      type: 'tool_execution_end', toolCallId: edit.id, toolName: edit.name, isError: false,
      result: { content: [{ type: 'text', text: 'executed text' }, previewPart,
        { ...previewPart, mimeType: 'image/svg+xml' }], details: { diff: '-1 old\n+1 new' } }
    })
    const replacement: WireMessage = {
      role: 'toolResult', toolCallId: edit.id, toolName: edit.name, isError: false,
      content: [{ type: 'text', text }]
    }
    expect(toolResultMatches(toolRow(executed).tool, replacement, false)).toBe(false)
    // With previews already equal, the same-text case must still notice that
    // diff was deleted; image replacement cannot mask a broken comparator.
    expect(toolResultMatches({ ...toolRow(executed).tool, images: [], imageNotice: undefined }, replacement, false)).toBe(false)
    const final = event(executed, { type: 'message_end', message: replacement })
    expect(final.timeline).not.toBe(executed.timeline)
    expect(toolRow(final)).toMatchObject({
      id: 130, tool: { status: 'done', resultSource: 'message', outputText: text,
        path: edit.path, command: edit.command, writeContent: edit.writeContent, images: [] }
    })
    expect(toolRow(final).tool.diff).toBeUndefined()
    expect(toolRow(final).tool.imageNotice).toBeUndefined()
    expect(event(final, { type: 'message_end', message: replacement }).timeline).toBe(final.timeline)
  })

  it.each(['execution', 'message', 'history'] as const)('preserves completed %s tools and their mounted identity on a same-scope replacement', (source) => {
    const row: TimelineItem = {
      kind: 'tool', id: 140, noReveal: true, historical: false, historyReconciled: true,
      tool: applyToolResult({ ...tool, live: source === 'history' ? undefined : true }, finalMessage, false, source)
    }
    const offWindow: TimelineItem = { kind: 'tool', id: 141, tool: { ...tool, id: 'off-window' } }
    const stale: TimelineItem = {
      kind: 'tool', id: 142, historical: true,
      tool: applyToolResult({ ...tool, live: undefined }, { content: [{ type: 'text', text: 'old history' }] }, true, 'history')
    }
    const after: TimelineItem = { kind: 'user', id: 143, entryId: 'after', text: 'page order' }
    const state = { ...initialState, timeline: [row, offWindow] }
    const replaced = reducer(state, {
      type: 'loadEntries', items: [after, stale], loadId: 17,
      preserveToolState: { revision: state.timelineScopeRevision }
    })
    expect(replaced.timeline.map(({ id }) => id)).toEqual([after.id, row.id])
    expect(toolRow(replaced).tool).toBe(row.tool)
    expect(toolRow(replaced).tool.images).toBe(row.tool.images)
    expect(toolRow(replaced)).toMatchObject({ noReveal: true, historical: false })
    expect(replaced.timelineMutation).toBe('replace')
    expect(replaced.timelineLoadId).toBe(17)
    expect(reducer(state, { type: 'loadEntries', items: [stale] }).timeline).toEqual([stale])
  })

  it.each(['running', 'done'] as const)('fills only a missing result on a same-scope %s replacement', (status) => {
    const row: TimelineItem = { kind: 'tool', id: 145, noReveal: true, tool: { ...tool, status } }
    const persisted: TimelineItem = {
      kind: 'tool', id: 146, tool: applyToolResult({ ...tool, live: undefined }, finalMessage, false, 'history')
    }
    const final = reducer({ ...initialState, timeline: [row] }, {
      type: 'loadEntries', items: [persisted], preserveToolState: { revision: initialState.timelineScopeRevision }
    })
    expect(toolRow(final)).toMatchObject({ id: row.id, noReveal: true, tool: { resultReceived: true, resultSource: 'history', live: true } })
    expect(toolRow(final).tool.images).toBe(persisted.tool.images)
  })

  it.each(['clear', 'cwd', 'sessionId', 'sessionPath'] as const)('rejects an obsolete page after a queued %s change; a fresh scope cannot inherit its preview', (change) => {
    const row: TimelineItem = { kind: 'tool', id: 150, tool: applyToolResult(tool, finalMessage, false) }
    const original: AgentState = {
      ...initialState, status: { phase: 'running', cwd: '/a' },
      session: { sessionId: 'a', sessionFile: '/a.jsonl', messageCount: 1, isStreaming: false },
      timeline: [row]
    }
    const scope = { revision: original.timelineScopeRevision, cwd: '/a', sessionId: 'a', sessionPath: '/a.jsonl' }
    const changed = change === 'clear' ? reducer(original, { type: 'clearTimeline' })
      : change === 'cwd' ? reducer(original, { type: 'status', status: { phase: 'running', cwd: '/b' } })
        : reducer(original, { type: 'session', session: { ...original.session!,
            ...(change === 'sessionId' ? { sessionId: 'b' } : { sessionFile: '/b.jsonl' }) } })
    const incoming: TimelineItem = { kind: 'tool', id: 151, historical: true, tool: { ...tool, status: 'done', live: undefined } }
    const obsolete = reducer(changed, { type: 'loadEntries', items: [incoming], preserveToolState: scope })
    expect(obsolete).toBe(changed)
    // The real selection pipeline clears the old projection before accepting
    // the new window. Only that selection's fresh scope may paint the page.
    const selected = reducer(changed, { type: 'clearTimeline', sessionPath: changed.session?.sessionFile })
    const currentScope = { revision: selected.timelineScopeRevision, cwd: selected.status.cwd,
      sessionId: selected.session?.sessionId, sessionPath: selected.liveSessionOwnerPath }
    const final = reducer(selected, { type: 'loadEntries', items: [incoming], preserveToolState: currentScope })
    expect(final.timeline).toEqual([incoming])
    expect(toolRow(final).tool.resultReceived).toBeUndefined()
    expect(toolRow(final).tool.images).toBeUndefined()
  })

  it.each(['prependEntries', 'appendEntries'] as const)('uses %s raw result-only pages to finish existing calls, without orphan rows or stale final replacements', (type) => {
    const row: TimelineItem = { kind: 'tool', id: 160, historical: true, noReveal: true, tool: { ...tool, live: undefined, status: 'done' } }
    const after: TimelineItem = { kind: 'user', id: 161, text: 'keep prefix order' }
    const result: WireEntry = { type: 'message', id: 'result-only', parentId: null, timestamp: '', message: finalMessage }
    const orphan: WireEntry = { ...result, id: 'orphan', message: { ...finalMessage, toolCallId: 'missing-call' } }
    const toolResults = [result, orphan]
    expect(entriesToTimeline(toolResults)).toEqual([])
    const completed = reducer({ ...initialState, timeline: [row, after] }, { type, items: [], toolResults })
    expect(completed.timeline.map(({ id }) => id)).toEqual([row.id, after.id])
    expect(toolRow(completed)).toMatchObject({ historical: true, noReveal: true, tool: { resultSource: 'history', resultReceived: true } })
    expect(completed.timelineMutation).toBe(type === 'prependEntries' ? 'prepend' : 'history-append')
    expect(reducer(completed, { type, items: [], toolResults }).timeline).toBe(completed.timeline)
    const final = event({ ...initialState, timeline: [row, after] }, { type: 'message_end', message: { ...finalMessage, content: [{ type: 'text', text: 'latest final' }] } })
    expect(reducer(final, { type, items: [], toolResults }).timeline).toBe(final.timeline)
  })

  it('reuses previews during changed-model replay while preserving fresh call arguments and final fields', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const current = applyToolResult(tool, { ...finalMessage, details: { imageGeneration: {
      version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
      path: 'images/generated.png'
    } } }, false)
    const entries: WireEntry[] = [
      { type: 'message', id: 'changed-call', parentId: null, timestamp: '', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: tool.id, name: tool.name,
          arguments: { command: 'fresh argument' } }]
      } },
      { type: 'message', id: 'changed-result', parentId: 'changed-call', timestamp: '', message: {
        ...finalMessage, isError: true, content: [{ type: 'text', text: 'replayed final text' }, previewPart],
        details: { imageGeneration: { version: 2, provider: 'openai-codex',
          requestedModel: 'gpt-image-2.5-sunburst', path: 'images/replayed.png' } }
      } }
    ]
    const replay = entriesToTimeline(entries, collectToolResults(entries), {
      existingTimeline: [{ kind: 'tool', id: 183, tool: current }]
    })
    const replayed = toolRow({ ...initialState, timeline: replay }).tool
    expect(replayed.images).toBe(current.images)
    expect(replayed).toMatchObject({ command: 'fresh argument', status: 'error',
      outputText: 'replayed final text', path: 'images/replayed.png', resultSource: 'history',
      imageModelInfo: { requestedModel: 'gpt-image-2.5-sunburst', resolvedModel: null } })
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('reuses valid preview arrays for settings-only history revalidation without keeping old settings or reference paths', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const saved: WireMessage = { ...finalMessage, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      path: 'images/generated.png', operation: 'generate', requestedSize: 'auto',
      requestedQuality: 'auto', referenceCount: 0, width: 1024, height: 1024, byteLength: 100_000
    } } }
    const current = applyToolResult(tool, saved, false)
    const entries: WireEntry[] = [
      { type: 'message', id: 'settings-replay-call', parentId: null, timestamp: '', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: tool.id, name: tool.name,
          arguments: { command: 'fresh argument', size: '1024x1024', quality: 'low',
            referenced_image_paths: ['images/private-source.png'] } }]
      } },
      { type: 'message', id: 'settings-replay-result', parentId: 'settings-replay-call', timestamp: '', message: {
        ...saved, details: { imageGeneration: {
          version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
          path: 'images/generated.png', operation: 'edit', requestedSize: '2048x3072',
          requestedQuality: 'high', referenceCount: 1, width: 1024, height: 1536, byteLength: 120_000
        } }
      } }
    ]
    const replay = entriesToTimeline(entries, collectToolResults(entries), {
      existingTimeline: [{ kind: 'tool', id: 189, tool: current }]
    })
    const row = toolRow({ ...initialState, timeline: replay })
    expect(row.tool.images).toBe(current.images)
    expect(row.tool).toMatchObject({ command: 'fresh argument', resultSource: 'history',
      imageSettingsInfo: { operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high',
        referenceCount: 1, savedWidth: 1024, savedHeight: 1536, savedByteLength: 120_000 } })
    expect(JSON.stringify(row)).not.toContain('private-source')
    const removed = entries.map((entry): WireEntry => entry.id !== 'settings-replay-result' ? entry : {
      ...entry, message: { ...saved, details: { imageGeneration: {
        version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
        path: 'images/generated.png'
      } } }
    })
    const revalidated = entriesToTimeline(removed, collectToolResults(removed), { existingTimeline: replay })
    const next = toolRow({ ...initialState, timeline: revalidated })
    expect(next.id).toBe(row.id)
    expect(next.tool.imageSettingsInfo).toBeUndefined()
    expect(next.tool.images).toBe(current.images)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('reuses identical valid preview arrays during replay without retaining old call arguments', () => {
    const collect = vi.spyOn(toolImages, 'collectToolImages')
    const decode = vi.spyOn(globalThis, 'atob')
    const current = applyToolResult({ ...tool, path: 'old-argument.png' }, finalMessage, false)
    const entries: WireEntry[] = [{ type: 'message', id: 'call', parentId: null, timestamp: '',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: tool.id, name: tool.name,
        arguments: { command: 'fresh argument' } }] } }]
    const result: WireEntry = { type: 'message', id: 'result', parentId: 'call', timestamp: '', message: finalMessage }
    const replay = entriesToTimeline(entries, collectToolResults([result]), {
      existingTimeline: [{ kind: 'tool', id: 170, tool: current }]
    })
    expect(toolRow({ ...initialState, timeline: replay }).tool.images).toBe(current.images)
    expect(toolRow({ ...initialState, timeline: replay }).tool.command).toBe('fresh argument')
    expect(collect).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })
})
