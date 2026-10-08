import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { entriesToTimeline } from '../../src/renderer/src/agent/timeline'
import { toWireEntry } from '../../src/main/agent/wire'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { LiveSessionState, WireEventInput } from '../../src/shared/types'

function applyEvent(state: AgentState, event: WireEventInput): AgentState {
  return reducer(state, { type: 'event', event })
}

describe('scoped live-session display snapshots', () => {
  const cwd = '/workspace'
  const path = '/sessions/a'
  const timestamp = 1780000000000
  const start: WireEventInput = { type: 'message_start', message: { role: 'assistant', timestamp, content: [] } }
  const delta = (text: string): WireEventInput => ({ type: 'message_update', usage: null,
    assistantMessageEvent: { type: 'text_delta', delta: text } })
  const snapshot = (state: AgentState, revision: number, events: WireEventInput[], extra: Partial<LiveSessionState> = {}, streaming = true) => reducer(state, {
    type: 'session', session: { sessionId: 'a', sessionFile: path, messageCount: 1, isStreaming: streaming,
      liveState: { backendId: 'backend-a', revision, cwd, sessionPath: path, events, ...extra } }
  })
  const seed: AgentState = { ...initialState, status: { phase: 'running', cwd },
    timeline: [{ kind: 'user', id: -1, entryId: 'old-page', text: 'retained history' }] }

  it('replaces compacted deltas rather than concatenating on the first revisit, preserving row keys and paged history', () => {
    let state = snapshot(seed, 3, [start, delta('first')])
    const key = state.timeline[1].id
    state = snapshot(state, 5, [start, delta('first plus background output'), {
      type: 'tool_execution_start', toolCallId: 'background-call', toolName: 'read', args: { path: 'file.ts' }
    }])
    expect(state.timeline).toHaveLength(3)
    expect(state.timeline[0]).toBe(seed.timeline[0])
    expect(state.timeline[1]).toMatchObject({ id: key, text: 'first plus background output', streaming: true })
    expect(state.timeline[2]).toMatchObject({ kind: 'tool', tool: { id: 'background-call' } })
    const again = snapshot(state, 5, [start, delta('first plus background output')])
    expect(again.timeline).toBe(state.timeline)
  })

  it('reveals background rows only at the first selection restore boundary', () => {
    const selected = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    const restored = snapshot(selected, 4, [start, delta('background'), {
      type: 'tool_execution_start', toolCallId: 'background-read', toolName: 'read', args: { path: 'a.ts' }
    }])
    expect(restored.timeline).toHaveLength(2)
    for (const row of restored.timeline) expect(row).toMatchObject({ historical: true, noReveal: false })
    expect(restored.historyRevealRestorePending).toBe(false)
    const assistantId = restored.timeline[0].id
    const refreshed = snapshot(restored, 5, [start, delta('background plus suffix'), {
      type: 'tool_execution_start', toolCallId: 'background-read', toolName: 'read', args: { path: 'a.ts' }
    }, { type: 'tool_execution_start', toolCallId: 'later-read', toolName: 'read', args: { path: 'b.ts' } }])
    expect(refreshed.timeline[0]).toMatchObject({ id: assistantId, historical: true, noReveal: false })
    expect(refreshed.timeline[2].historical).not.toBe(true)
    expect(refreshed.timeline[2].noReveal).not.toBe(true)
  })

  it('keeps the boundary across metadata-only STATE and an earlier forwarded revision', () => {
    let selected = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    selected = snapshot(selected, 1, [])
    expect(selected.historyRevealRestorePending).toBe(true)
    selected = applyEvent(selected, { ...start,
      _pionLive: { backendId: 'backend-a', revision: 2, cwd, sessionPath: path } })
    const id = selected.timeline[0].id
    const restored = snapshot(selected, 3, [start, delta('accepted background')])
    expect(restored.timeline[0]).toMatchObject({ id, historical: true, noReveal: false })
    expect(restored.historyRevealRestorePending).toBe(false)
  })

  it('explicit cache restore overrides retained flags without changing row identity', () => {
    let selected = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    selected = snapshot(selected, 3, [start, delta('background')])
    selected = { ...selected, timeline: selected.timeline.map((row) => ({ ...row, noReveal: true })) }
    const restored = reducer(selected, { type: 'loadEntries', replayHistory: true,
      items: selected.timeline, preserveToolState: { revision: selected.timelineScopeRevision, cwd, sessionPath: path } })
    expect(restored.timeline[0]).toMatchObject({ id: selected.timeline[0].id, historical: true, noReveal: false })
    const ordinary = reducer(selected, { type: 'loadEntries', items: selected.timeline,
      preserveToolState: { revision: selected.timelineScopeRevision, cwd, sessionPath: path } })
    expect(ordinary.timeline[0].noReveal).toBe(true)
    const revalidated = snapshot(restored, 4, [start, delta('background')])
    expect(revalidated.timeline[0]).toBe(restored.timeline[0])
    const continued = applyEvent(revalidated, delta(' live suffix'))
    expect(continued.timeline[0]).toMatchObject({ id: restored.timeline[0].id, text: 'background live suffix', live: true, streaming: true })
  })

  it('does not arm a fresh empty session or change paged reveal flags', () => {
    const fresh = reducer(seed, { type: 'clearTimeline' })
    expect(fresh.historyRevealRestorePending).toBe(false)
    expect(snapshot(fresh, 2, [start, delta('new output')]).timeline[0].historical).not.toBe(true)
    const paged = reducer(fresh, { type: 'prependEntries', items: [
      { kind: 'user', id: -20, entryId: 'older', text: 'older page', historical: true, noReveal: true }
    ] })
    expect(paged.timeline[0]).toMatchObject({ historical: true, noReveal: true })
  })

  it('hydrates a first token whose assistant did not exist when the session was left', () => {
    const state = snapshot(seed, 4, [start, delta('first background token')])
    expect(state.timeline[1]).toMatchObject({ text: 'first background token' })
  })

  it.each([true, false])('honors a background empty final (SDK timestamp present: %s)', (hasTimestamp) => {
    const message = { role: 'assistant', content: [], ...(hasTimestamp ? { timestamp } : {}) }
    const events: WireEventInput[] = [{ type: 'message_start', message }, delta('removed'), { type: 'message_end', message }]
    const draft = snapshot(seed, 2, events.slice(0, 2))
    const ended = snapshot(draft, 4, events, {}, false)
    expect(ended.timeline).toEqual(seed.timeline)
    expect(ended.busy).toBe(false)
  })

  it('does not let old revisions rewind a newer final or newer lifecycle busy authority', () => {
    let state = snapshot(seed, 2, [start, delta('draft')])
    state = applyEvent(state, { type: 'message_end', message: { role: 'assistant', timestamp, content: 'final' },
      _pionLive: { backendId: 'backend-a', revision: 6, cwd, sessionPath: path } })
    state = applyEvent(state, { type: 'agent_settled', _pionLive: { backendId: 'backend-a', revision: 7, cwd, sessionPath: path } })
    const stale = snapshot(state, 3, [start, delta('old draft')])
    expect(stale.busy).toBe(false)
    expect(stale.timeline).toBe(state.timeline)
    expect(stale.timeline[1]).toMatchObject({ text: 'final', streaming: false })
  })

  it('drops old backend drafts when the same file gets a replacement backend', () => {
    const state = snapshot(seed, 2, [start, delta('old backend')])
    const replaced = snapshot(state, 1, [], { backendId: 'replacement' }, false)
    expect(replaced.timeline).toEqual(seed.timeline)
  })

  it('rejects both cross-workspace and cross-session forwarded events', () => {
    const state = snapshot(seed, 2, [start, delta('safe')])
    for (const scope of [{ cwd: '/other', sessionPath: path }, { cwd, sessionPath: '/sessions/b' }]) {
      const event = { ...delta('foreign'), _pionLive: { backendId: 'backend-a', revision: 8, ...scope } }
      expect(applyEvent(state, event)).toBe(state)
    }
    expect(snapshot(state, 8, [start, delta('foreign')], { cwd: '/other' }).timeline).toBe(state.timeline)
  })

  it('accepts a late SDK session path within the selected fresh logical scope', () => {
    const fresh = reducer(seed, { type: 'clearTimeline' })
    const state = snapshot(fresh, 2, [start, delta('late identity')])
    expect(state.timeline[0]).toMatchObject({ text: 'late identity' })
    expect(state.liveSessionOwnerPath).toBe(path)
  })

  it('updates complete assistant fields despite unrelated image/argument truncation', () => {
    const user: WireEventInput = { type: 'message_start', message: { role: 'user', timestamp: timestamp - 1,
      content: [{ type: 'text', text: 'long request' }, { type: 'image', mimeType: 'image/png', data: 'attachment' }] } }
    const state = snapshot(seed, 2, [user, start, delta('first')])
    const updated = snapshot(state, 4, [
      { type: 'message_start', message: { role: 'user', timestamp: timestamp - 1, content: 'long', _pionLiveTruncatedFields: ['text'] } },
      start, delta('first with exact background suffix'),
      { type: 'tool_execution_start', toolCallId: 'secret-args', toolName: 'read', args: {} }
    ], { truncated: true })
    expect(updated.timeline[1]).toMatchObject({ text: 'long request', images: [{ data: 'attachment' }] })
    expect(updated.timeline[2]).toMatchObject({ text: 'first with exact background suffix', streaming: true })
    expect(updated.timeline[2].id).toBe(state.timeline[2].id)
  })

  it('preserves a shortened final field without leaving the final streaming', () => {
    const state = snapshot(seed, 2, [start, delta('complete active output')])
    const ended = snapshot(state, 4, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, content: 'bounded', _pionLiveTruncatedFields: ['text'] } }], { truncated: true }, false)
    expect(ended.timeline[1]).toMatchObject({ text: 'complete active output', streaming: false })
    expect(ended.busy).toBe(false)
  })

  it.each([{ fields: [] }, { fields: ['text'] }])('keeps unmarked short final thinking authoritative (marked fields: %j)', ({ fields }) => {
    const state = snapshot(seed, 2, [start, delta('long text draft'), {
      type: 'message_update', usage: null, assistantMessageEvent: { type: 'thinking_delta', delta: 'long thinking draft' }
    }])
    const ended = snapshot(state, 4, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, _pionLiveTruncatedFields: fields, content: [
        { type: 'text', text: 'short' }, { type: 'thinking', thinking: 'brief' }
      ] } }], { truncated: true }, false)
    expect(ended.timeline[1]).toMatchObject({ text: fields.length ? 'long text draft' : 'short',
      thinking: 'brief', streaming: false })
  })

  it.each([{ fields: ['thinking'] }, { fields: ['text', 'thinking'] }])('retains budget-emptied marked fields and ends the stream: %j', ({ fields }) => {
    const state = snapshot(seed, 2, [start, delta('text draft'), {
      type: 'message_update', usage: null, assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking draft' }
    }])
    const ended = snapshot(state, 4, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, content: [], _pionLiveTruncatedFields: fields
    } }], { truncated: true }, false)
    expect(ended.timeline[1]).toMatchObject({ text: fields.includes('text') ? 'text draft' : '',
      thinking: 'thinking draft', streaming: false })
    expect(ended.busy).toBe(false)
    const empty = snapshot(seed, 4, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, content: [], _pionLiveTruncatedFields: fields
    } }], { truncated: true }, false)
    expect(empty.timeline).toEqual(seed.timeline)
  })

  it('preserves omitted user attachments without any global truncation flag', () => {
    const user: WireEventInput = { type: 'message_start', message: { role: 'user', timestamp,
      content: [{ type: 'text', text: 'long request' }, { type: 'image', mimeType: 'image/png', data: 'attachment' }] } }
    const state = snapshot(seed, 2, [user])
    const updated = snapshot(state, 3, [{ type: 'message_start', message: { role: 'user', timestamp, content: 'short' } }])
    expect(updated.timeline[1]).toMatchObject({ text: 'short', images: [{ data: 'attachment' }] })
  })

  it('honors a truly empty final even when an unrelated projection field was truncated', () => {
    const state = snapshot(seed, 2, [start, delta('draft')])
    const ended = snapshot(state, 4, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, content: [] } }], { truncated: true }, false)
    expect(ended.timeline).toEqual(seed.timeline)
  })

  it('does not resurrect a cached pre-final draft loaded after an empty-final snapshot', () => {
    const draft = snapshot(seed, 2, [start, delta('cached draft')])
    const ended = snapshot(draft, 4, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, content: [] } }], {}, false)
    const restored = reducer(ended, { type: 'loadEntries', items: draft.timeline,
      preserveToolState: { revision: ended.timelineScopeRevision, cwd, sessionPath: path } })
    expect(restored.timeline).toEqual(seed.timeline)
    expect(restored.busy).toBe(false)
  })

  it('retains an accepted live snapshot while the first persisted page is empty', () => {
    const current = snapshot(seed, 2, [start, delta('not yet persisted')])
    const loaded = reducer(current, { type: 'loadEntries', items: [], preserveToolState: {
      revision: current.timelineScopeRevision, cwd, sessionPath: path } })
    expect(loaded.timeline).toHaveLength(1)
    expect(loaded.timeline[0]).toMatchObject({ text: 'not yet persisted', streaming: true })
  })

  it('protects newer live lifecycle authority from old and equal revision busy flags', () => {
    const current = applyEvent(snapshot(seed, 2, [start, delta('output')]), {
      type: 'agent_start', _pionLive: { backendId: 'backend-a', revision: 5, cwd, sessionPath: path } })
    for (const revision of [4, 5]) expect(snapshot(current, revision, [], {}, false).busy).toBe(true)
  })

  it('rejects a late same-cwd history replacement from a previous selection', () => {
    const current = snapshot(seed, 2, [start, delta('safe')])
    expect(reducer(current, { type: 'loadEntries', items: [], preserveToolState: {
      revision: current.timelineScopeRevision - 1, cwd, sessionPath: path } })).toBe(current)
  })

  it('retains a hydrated same-cwd backend across its repeated ready descriptor', () => {
    const current = snapshot(seed, 2, [start, delta('safe')])
    const ready = reducer(current, { type: 'status', status: { phase: 'ready', cwd } })
    expect(ready.timeline).toBe(current.timeline)
    expect(ready.liveSessionBackendId).toBe(current.liveSessionBackendId)
    expect(ready.busy).toBe(true)
  })

  it('does not shrink a complete active row from a truncated bounded snapshot', () => {
    const state = snapshot(seed, 2, [start, delta('complete active output')])
    const truncated = snapshot(state, 4, [{ type: 'message_start', message: {
      role: 'assistant', timestamp, content: [], _pionLiveTruncatedFields: ['text'] } }, delta('suffix only')], { truncated: true })
    expect(truncated.timeline[1]).toBe(state.timeline[1])
  })
})

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
