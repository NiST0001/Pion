import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { entriesToTimeline } from '../../src/renderer/src/agent/timeline'
import { toWireEntry } from '../../src/main/agent/wire'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { WireEventInput } from '../../src/shared/types'

function applyEvent(state: AgentState, event: WireEventInput): AgentState {
  return reducer(state, { type: 'event', event })
}

describe('assistant error state', () => {
  it('drops a nonempty streamed draft when the authoritative final message is empty', () => {
    const streaming: AgentState = { ...initialState, timeline: [{
      kind: 'assistant', id: 1, text: 'removed draft', thinking: 'removed reasoning', streaming: true
    }] }
    const ended = applyEvent(streaming, { type: 'message_end', message: {
      role: 'assistant', stopReason: 'stop', content: []
    } })
    expect(ended.timeline).toEqual([])
  })

  it('clears removed thinking rather than retaining a nonempty streamed draft', () => {
    const streaming: AgentState = { ...initialState, timeline: [{
      kind: 'assistant', id: 2, text: 'draft text', thinking: 'removed reasoning', streaming: true
    }] }
    const ended = applyEvent(streaming, { type: 'message_end', message: {
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final text' }]
    } })
    expect(ended.timeline).toEqual([expect.objectContaining({ text: 'final text', thinking: '', streaming: false })])
  })

  it('retains only the final diagnostic when an error removes the streamed contents', () => {
    const streaming: AgentState = { ...initialState, timeline: [{
      kind: 'assistant', id: 3, text: 'removed text', thinking: 'removed reasoning', streaming: true
    }] }
    const ended = applyEvent(streaming, { type: 'message_end', message: {
      role: 'assistant', stopReason: 'error', errorMessage: 'final error', content: []
    } })
    expect(ended.timeline).toEqual([expect.objectContaining({ text: '', thinking: '', error: 'final error', streaming: false })])
  })

  it('keeps error updates streaming and lets message_end replace the provisional diagnostic', () => {
    let state = applyEvent(initialState, {
      type: 'message_start',
      message: { role: 'assistant', content: [] }
    })
    state = applyEvent(state, {
      type: 'message_update',
      usage: {},
      assistantMessageEvent: {
        type: 'error',
        error: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary provider diagnostic' }
      }
    })

    expect(state.timeline[0]).toMatchObject({
      kind: 'assistant',
      text: '',
      thinking: '',
      streaming: true,
      error: 'temporary provider diagnostic'
    })

    state = applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp: 1_780_000_000_000,
        stopReason: 'error',
        errorMessage: 'provider unavailable',
        content: [
          { type: 'thinking', thinking: '最后的思考' },
          { type: 'text', text: '最后的回答' }
        ]
      }
    })

    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({
      kind: 'assistant',
      messageTimestamp: 1_780_000_000_000,
      text: '最后的回答',
      thinking: '最后的思考',
      streaming: false,
      error: 'provider unavailable'
    })
  })

  it('clears a provisional error when the final assistant message succeeds', () => {
    let state = applyEvent(initialState, {
      type: 'message_start',
      message: { role: 'assistant', content: [] }
    })
    state = applyEvent(state, {
      type: 'message_update',
      usage: {},
      assistantMessageEvent: {
        type: 'error',
        error: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary provider diagnostic' }
      }
    })
    state = applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: '最终成功回复' }]
      }
    })

    expect(state.timeline).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: '最终成功回复',
        streaming: false
      })
    ])
    expect(state.timeline[0]).not.toHaveProperty('error')
  })

  it('retains a pure final error and does not duplicate it from agent_end', () => {
    let state = applyEvent(initialState, {
      type: 'message_start',
      message: { role: 'assistant', content: [] }
    })
    const finalMessage = {
      role: 'assistant' as const,
      content: [],
      stopReason: 'error',
      errorMessage: 'authentication failed'
    }
    state = applyEvent(state, { type: 'message_end', message: finalMessage })

    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({
      kind: 'assistant',
      text: '',
      thinking: '',
      streaming: false,
      error: 'authentication failed'
    })

    const ended = applyEvent(state, {
      type: 'agent_end',
      messages: [finalMessage],
      willRetry: false
    })
    expect(ended.timeline).toEqual(state.timeline)
  })

  it('does not finalize an assistant when a steering user message ends', () => {
    const started = applyEvent(initialState, {
      type: 'message_start', message: { role: 'assistant', content: [] }
    })
    const endedUser = applyEvent(started, {
      type: 'message_end', message: { role: 'user', content: 'steering input' }
    })

    expect(endedUser.timeline).toBe(started.timeline)
    expect(endedUser.timeline[0]).toMatchObject({ kind: 'assistant', text: '', streaming: true })
  })

  it('keeps an explicit error even when the provider omits diagnostic text', () => {
    let state = applyEvent(initialState, {
      type: 'message_start',
      message: { role: 'assistant', content: [] }
    })
    state = applyEvent(state, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error' }
    })

    expect(state.timeline[0]).toMatchObject({
      kind: 'assistant',
      streaming: false,
      error: '模型请求失败，但提供商未返回技术详情。'
    })
  })

  it('uses the final stop reason to suppress provider-specific abort diagnostics', () => {
    let state = applyEvent(initialState, {
      type: 'message_start',
      message: { role: 'assistant', content: [] }
    })
    state = applyEvent(state, {
      type: 'message_update',
      usage: {},
      assistantMessageEvent: {
        type: 'error',
        error: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary provider diagnostic' }
      }
    })

    expect(state.timeline[0]).toMatchObject({
      kind: 'assistant',
      streaming: true,
      error: 'temporary provider diagnostic'
    })

    state = applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: 'This operation was aborted by the provider SDK'
      }
    })
    expect(state.timeline).toEqual([])
  })

  it('resolves a same-timestamp page collision after the final message arrives', () => {
    const timestamp = 1_780_000_000_200
    let state = applyEvent(initialState, {
      type: 'message_start', message: { role: 'assistant', content: [], timestamp }
    })
    const liveId = state.timeline[0].id
    const finalMessage = {
      role: 'assistant' as const, content: [], timestamp,
      stopReason: 'error', errorMessage: 'connection lost'
    }
    const page = entriesToTimeline([
      {
        type: 'message', id: 'distinct-same-timestamp', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'assistant', content: 'another answer', timestamp, stopReason: 'stop' }
      },
      {
        type: 'message', id: 'stored-final', parentId: 'distinct-same-timestamp', timestamp: '2026-01-01T00:00:01Z',
        message: finalMessage
      }
    ])
    state = reducer(state, { type: 'appendEntries', items: page })
    expect(state.timeline).toHaveLength(3)
    state = applyEvent(state, { type: 'message_end', message: finalMessage })

    expect(state.timeline).toHaveLength(2)
    expect(state.timeline[0]).toMatchObject({ entryId: 'distinct-same-timestamp', text: 'another answer' })
    expect(state.timeline[1]).toMatchObject({
      id: liveId, entryId: 'stored-final', streaming: false,
      error: 'connection lost', historyReconciled: true
    })
  })

  it.each([false, true])('matches a real compaction result to its paged entry without remounting (retain-none: %s)', (retainNone) => {
    const result = {
      summary: 'Actual SDK summary',
      firstKeptEntryId: retainNone ? undefined : 'kept-message',
      tokensBefore: 100_000
    }
    const live = applyEvent(initialState, {
      type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false
    })
    const wire = toWireEntry({
      type: 'compaction', id: 'persisted-compaction', parentId: null, timestamp: '2026-01-01T00:00:00Z',
      ...result,
      firstKeptEntryId: result.firstKeptEntryId ?? 'persisted-compaction'
    })
    expect(wire).toMatchObject({
      summary: result.summary, tokensBefore: result.tokensBefore,
      firstKeptEntryId: result.firstKeptEntryId ?? 'persisted-compaction'
    })
    const page = entriesToTimeline([wire])
    const merged = reducer(live, { type: 'appendEntries', items: page })

    expect(merged.timeline).toHaveLength(1)
    expect(merged.timeline[0]).toMatchObject({
      id: live.timeline[0].id, entryId: 'persisted-compaction',
      summary: '上下文已压缩', historyReconciled: true
    })
    expect(reducer(merged, { type: 'appendEntries', items: page })).toBe(merged)
  })

  it('does not attach a persisted assistant identity to a compaction failure', () => {
    let state = applyEvent(initialState, {
      type: 'message_start',
      message: { role: 'assistant', timestamp: 1_780_000_000_000, content: [] }
    })
    state = applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant', timestamp: 1_780_000_000_000,
        stopReason: 'error', errorMessage: 'context_length_exceeded', content: []
      }
    })
    state = applyEvent(state, {
      type: 'compaction_end', reason: 'overflow', result: {},
      aborted: false, willRetry: false, errorMessage: 'compaction failed'
    })
    state = applyEvent(state, {
      type: 'entry_appended',
      entry: {
        type: 'message', id: 'persisted-error', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'assistant', timestamp: 1_780_000_000_000, stopReason: 'error' }
      }
    })

    expect(state.timeline[0]).toMatchObject({ entryId: 'persisted-error', error: 'context_length_exceeded' })
    expect(state.timeline[1]).toMatchObject({ errorContext: 'compaction', error: 'compaction failed' })
    expect(state.timeline[1]).not.toHaveProperty('entryId')
  })

  it('surfaces compaction diagnostics while keeping abort and success behavior distinct', () => {
    const failed = applyEvent(initialState, {
      type: 'compaction_end',
      reason: 'threshold',
      result: {},
      aborted: false,
      willRetry: false,
      errorMessage: 'summarizer unavailable'
    })
    expect(failed.timeline).toHaveLength(1)
    expect(failed.timeline[0]).toMatchObject({
      kind: 'assistant',
      text: '',
      thinking: '',
      streaming: false,
      live: true,
      error: 'summarizer unavailable',
      errorContext: 'compaction'
    })

    const aborted = applyEvent(initialState, {
      type: 'compaction_end',
      reason: 'manual',
      result: {},
      aborted: true,
      willRetry: false,
      errorMessage: 'Request was aborted'
    })
    expect(aborted.timeline).toEqual([])

    const succeeded = applyEvent(initialState, {
      type: 'compaction_end',
      reason: 'manual',
      result: {},
      aborted: false,
      willRetry: false
    })
    expect(succeeded.timeline).toEqual([
      expect.objectContaining({ kind: 'compaction', summary: '上下文已压缩' })
    ])
  })
})
