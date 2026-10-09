import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { deriveWorkingStatus } from '../../src/renderer/src/agent/workingStatus'
import { entriesToTimeline } from '../../src/renderer/src/agent/timeline'
import { toWireEntry } from '../../src/main/agent/wire'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { LiveSessionState, WireEventInput } from '../../src/shared/types'

function applyEvent(state: AgentState, event: WireEventInput): AgentState {
  return reducer(state, { type: 'event', event })
}

describe('selected history acceptance state', () => {
  const cwd = '/workspace'
  const path = '/sessions/selected.jsonl'
  const timestamp = 1780000000000
  const item: AgentState['timeline'][number] = Object.freeze({
    kind: 'user', id: 810, entryId: 'accepted-history', messageTimestamp: timestamp,
    text: 'history fixture', historical: true, noReveal: true
  })
  const selected = (): AgentState => reducer({ ...initialState, status: { phase: 'running', cwd } }, {
    type: 'clearTimeline', sessionPath: path
  })
  const scope = (state: AgentState) => ({ revision: state.timelineScopeRevision, cwd, sessionPath: path })

  it('reports an unaccepted history read after queued STATUS changes cwd without weakening the scope guard', () => {
    let reading = applyEvent(selected(), { type: 'queue_update', steering: ['steer'], followUp: ['follow-up'], nativeFollowUpCount: 1 })
    reading = { ...reading, tasks: [], taskRevision: 4, taskResultIds: ['retained-task'] }
    reading = reducer(reading, { type: 'timelineLoading', loading: true })
    const capturedScope = scope(reading)
    const changed = reducer(reading, { type: 'status', status: { phase: 'running', cwd: '/other-workspace' } })
    const rejected = reducer(changed, { type: 'loadEntries', items: [item], loadId: 17, preserveToolState: capturedScope })
    expect(rejected).toBe(changed)
    expect(rejected.timelineLoadId).toBe(reading.timelineLoadId)
    expect(rejected).toMatchObject({ timelineReady: false, timelineLoading: true, timeline: [] })

    const closed = reducer(rejected, { type: 'timelineLoading', loading: false })
    expect(closed).toMatchObject({ timelineReady: false, timelineLoading: false,
      timelineError: '会话历史未载入，请重新加载。', historyRevealRestorePending: true })
    expect(closed.queued).toBe(reading.queued)
    expect(closed.queuedMessages).toBe(reading.queuedMessages)
    expect(closed.tasks).toBe(reading.tasks)
    expect(closed.taskRevision).toBe(4)
    expect(closed.taskResultIds).toBe(reading.taskResultIds)
    expect(closed.timelineMutation).toBe(reading.timelineMutation)
    expect(item).toMatchObject({ messageTimestamp: timestamp, noReveal: true })
  })

  it('marks an accepted nonempty history page ready and retains readiness during same-scope loading', () => {
    const reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    const loaded = reducer(reading, { type: 'loadEntries', items: [item], loadId: 18, preserveToolState: scope(reading) })
    expect(loaded).toMatchObject({ timelineReady: true, timelineLoading: false, timelineLoadId: 18 })
    expect(loaded.timelineError).toBeUndefined()
    expect(loaded.timeline[0]).toBe(item)
    expect(loaded.timeline[0]).toMatchObject({ messageTimestamp: timestamp, historical: true, noReveal: true })
    expect(loaded.historyRevealRestorePending).toBe(reading.historyRevealRestorePending)
    const reloading = reducer(loaded, { type: 'timelineLoading', loading: true })
    expect(reloading.timelineReady).toBe(true)
    expect(reloading.timeline).toBe(loaded.timeline)
    const closed = reducer(reloading, { type: 'timelineLoading', loading: false })
    expect(closed.timelineReady).toBe(true)
    expect(closed.timelineError).toBeUndefined()
  })

  it('marks a scoped nonempty cache restore ready without mutating cached timestamps or reveal flags', () => {
    const reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    const restored = reducer(reading, { type: 'loadEntries', items: [item], replayHistory: true,
      loadId: 19, preserveToolState: scope(reading) })
    expect(restored).toMatchObject({ timelineReady: true, timelineLoading: false, timelineLoadId: 19 })
    expect(restored.timeline[0]).toMatchObject({ id: item.id, messageTimestamp: timestamp, historical: true, noReveal: false })
    expect(item).toMatchObject({ messageTimestamp: timestamp, historical: true, noReveal: true })
  })

  it('accepts a genuinely empty branch even when SDK metadata counts other physical messages', () => {
    let reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    reading = reducer(reading, { type: 'session', session: {
      sessionId: 'selected', sessionFile: path, messageCount: 2090, isStreaming: false
    } })
    const loaded = reducer(reading, { type: 'loadEntries', items: [], loadId: 20, preserveToolState: scope(reading) })
    expect(loaded).toMatchObject({ timeline: [], timelineReady: true, timelineLoading: false, timelineLoadId: 20 })
    expect(reducer(loaded, { type: 'timelineLoading', loading: false }).timelineError).toBeUndefined()
    expect(loaded.historyRevealRestorePending).toBe(reading.historyRevealRestorePending)
  })

  it('does not treat an empty cache projection as an accepted empty branch or clear its read failure', () => {
    const reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    const restore = { type: 'loadEntries' as const, items: [], replayHistory: true, preserveToolState: scope(reading) }
    const restored = reducer(reading, restore)
    expect(restored).toMatchObject({ timelineReady: false, timelineLoading: true, timeline: [] })
    expect(reducer(restored, { type: 'timelineLoading', loading: false }).timelineError).toBe('会话历史未载入，请重新加载。')
    const failed = reducer(reading, { type: 'timelineError', error: '保留读取诊断' })
    expect(reducer(failed, restore)).toMatchObject({ timelineReady: false, timelineError: '保留读取诊断' })
  })

  it('resets acceptance on clear and leaves a fresh conversation without an owner free of history errors', () => {
    expect(initialState.timelineReady).toBe(false)
    const loaded = reducer(selected(), { type: 'loadEntries', items: [] })
    expect(reducer(loaded, { type: 'clearTimeline', sessionPath: '/sessions/next.jsonl' }).timelineReady).toBe(false)
    const fresh = reducer(loaded, { type: 'clearTimeline' })
    expect(fresh).toMatchObject({ timelineReady: false, timeline: [] })
    expect(fresh.liveSessionOwnerPath).toBeUndefined()
    const reading = reducer(fresh, { type: 'timelineLoading', loading: true })
    const closed = reducer(reading, { type: 'timelineLoading', loading: false })
    expect(closed.timelineReady).toBe(false)
    expect(closed.timelineError).toBeUndefined()
  })

  it('preserves the original history diagnostic when the loading shell closes', () => {
    const reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    const failed = reducer(reading, { type: 'timelineError', error: '保留读取诊断' })
    expect(reducer(failed, { type: 'timelineLoading', loading: false }).timelineError).toBe('保留读取诊断')
    const withDiagnostic = { ...reading, timelineError: '原始读取诊断' }
    expect(reducer(withDiagnostic, { type: 'timelineLoading', loading: false }).timelineError).toBe('原始读取诊断')
  })

  it.each([0, 2090])('does not infer history acceptance from empty STATE metadata or runtime lifecycle (messageCount: %s)', (messageCount) => {
    const reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    let state = reducer(reading, { type: 'session', session: {
      sessionId: 'selected', sessionFile: path, messageCount, isStreaming: false,
      liveState: { backendId: 'selected-backend', revision: 1, cwd, sessionPath: path, events: [] }
    } })
    expect(state).toMatchObject({ timelineReady: false, timelineLoading: true, timeline: [] })
    state = applyEvent(state, { type: 'agent_start', _pionLive: {
      backendId: 'selected-backend', revision: 2, cwd, sessionPath: path
    } })
    expect(state).toMatchObject({ timelineReady: false, busy: true })
    state = applyEvent(state, { type: 'agent_settled', _pionLive: {
      backendId: 'selected-backend', revision: 3, cwd, sessionPath: path
    } })
    expect(state).toMatchObject({ timelineReady: false, busy: false })
    expect(reducer(state, { type: 'timelineLoading', loading: false }).timelineError).toBe('会话历史未载入，请重新加载。')
  })

  it('keeps partial live output and working status without using it as historical acceptance', () => {
    let state = reducer(selected(), { type: 'timelineLoading', loading: true })
    state = applyEvent(state, { type: 'agent_start' })
    state = applyEvent(state, { type: 'message_start', message: { role: 'assistant', timestamp, content: [] } })
    state = applyEvent(state, { type: 'message_update', usage: null, assistantMessageEvent: { type: 'text_delta', delta: 'live fixture' } })
    const closed = reducer(state, { type: 'timelineLoading', loading: false })
    expect(closed).toMatchObject({ timelineReady: false, busy: true, timelineError: '会话历史未载入，请重新加载。' })
    expect(closed.timeline).toBe(state.timeline)
    expect(closed.timeline[0]).toMatchObject({ text: 'live fixture', streaming: true, messageTimestamp: timestamp })
    expect(deriveWorkingStatus(closed).label).toBe('组织回复中...')
  })

  it('rejects stale history after a clear without acknowledging its load ID or closing another scope', () => {
    const reading = reducer(selected(), { type: 'timelineLoading', loading: true })
    const next = reducer(reading, { type: 'clearTimeline', sessionPath: '/sessions/next.jsonl' })
    expect(reducer(next, { type: 'loadEntries', items: [item], loadId: 21, preserveToolState: scope(reading) })).toBe(next)
    const unchanged = reducer(next, { type: 'timelineLoading', loading: false })
    expect(unchanged).toMatchObject({ timelineReady: false, timelineLoading: false, timeline: [] })
    expect(unchanged.timelineLoadId).toBe(next.timelineLoadId)
    expect(unchanged.timelineError).toBeUndefined()
  })
})

describe('user message identity reconciliation', () => {
  const cwd = '/workspace'
  const path = '/sessions/a'
  const timestamp = 1780000000000
  const start = (content: string, identity = 'row-a', entryId?: string, time: unknown = timestamp): WireEventInput => ({
    type: 'message_start', message: { role: 'user', content, timestamp: time,
      _pionLiveMessageId: identity, ...(entryId ? { _pionLiveEntryId: entryId } : {}) }
  })
  const entry = (id: string, content?: string, time: unknown = timestamp): WireEventInput => ({
    type: 'entry_appended', entry: { type: 'message', id, parentId: null, timestamp: '',
      message: { role: 'user', ...(content === undefined ? {} : { content }), ...(time === undefined ? {} : { timestamp: time }) } }
  })
  const snapshot = (state: AgentState, revision: number, events: WireEventInput[]) => reducer(state, {
    type: 'session', session: { sessionId: 'a', sessionFile: path, messageCount: 1, isStreaming: false,
      liveState: { backendId: 'backend-a', revision, cwd, sessionPath: path, events } }
  })
  const seed: AgentState = { ...initialState, status: { phase: 'running', cwd } }

  it('keeps the persistent ID and React key when STATE resumes a user already on disk', () => {
    const page = entriesToTimeline([{ type: 'message', id: 'user-a', parentId: null, timestamp: '',
      message: { role: 'user', timestamp, content: '安装这个吧' } }])
    let state = { ...seed, timeline: page }
    state = snapshot(state, 2, [start('安装这个吧', 'row-a', 'user-a'), entry('user-a')])
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: page[0].id, entryId: 'user-a' })
    state = applyEvent(state, start('安装这个吧', 'row-a', 'user-a'))
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: page[0].id, entryId: 'user-a' })
  })

  it('accepts an entry-before-start identity and does not append another bubble on revisit', () => {
    let state = applyEvent(seed, entry('user-a', 'install'))
    state = applyEvent(state, start('install', 'row-a', 'user-a'))
    const key = state.timeline[0].id
    expect(state.timeline[0]).toMatchObject({ entryId: 'user-a' })
    state = snapshot(state, 2, [start('install', 'row-a', 'user-a')])
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key, entryId: 'user-a' })
  })

  it('merges STATE-before-live-start without manufacturing a timestamp or an entry ID', () => {
    const event = start('install', 'row-a', undefined, undefined)
    // Explicitly delete timestamp: default parameters otherwise supply it.
    delete (event as { message: Record<string, unknown> }).message.timestamp
    let state = snapshot(seed, 2, [event])
    const key = state.timeline[0].id
    state = applyEvent(state, event)
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key })
    expect(state.timeline[0]).not.toHaveProperty('entryId')
    expect(state.timeline[0].kind === 'user' && state.timeline[0].messageTimestamp).toBeUndefined()
  })

  it('reconciles a delayed history page with the live user without losing its mounted identity', () => {
    let state = applyEvent(seed, start('install'))
    const key = state.timeline[0].id
    const items = entriesToTimeline([{ type: 'message', id: 'user-a', parentId: null, timestamp: '',
      message: { role: 'user', timestamp, content: 'install' } }])
    state = reducer(state, { type: 'loadEntries', items,
      preserveToolState: { revision: state.timelineScopeRevision, cwd } })
    state = snapshot(state, 3, [start('install', 'row-a', 'user-a')])
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key, entryId: 'user-a' })
  })

  it('retains a reconciled user key and undo ID across repeated same-scope history replacement', () => {
    const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'original' }]
    let state = applyEvent(seed, { type: 'message_start', message: { role: 'user', timestamp,
      _pionLiveMessageId: 'row-a', content: [{ type: 'text', text: 'install' }, ...images] } })
    const key = state.timeline[0].id
    const page = entriesToTimeline([{ type: 'message', id: 'user-a', parentId: null, timestamp: '',
      message: { role: 'user', timestamp, content: [{ type: 'text', text: 'install' }, ...images] } }])
    for (let i = 0; i < 3; i++) {
      state = reducer(state, { type: 'loadEntries', items: page,
        preserveToolState: { revision: state.timelineScopeRevision, cwd } })
      expect(state.timeline).toHaveLength(1)
      expect(state.timeline[0]).toMatchObject({ id: key, entryId: 'user-a', liveMessageId: 'row-a', images,
        historyReconciled: true })
      expect(state.timelineMutation).toBe('replace')
    }
    const changed = page.map((row) => row.kind === 'user' ? { ...row, text: 'authoritative history' } : row)
    state = reducer(state, { type: 'loadEntries', items: changed,
      preserveToolState: { revision: state.timelineScopeRevision, cwd } })
    expect(state.timeline[0]).toMatchObject({ id: key, entryId: 'user-a', text: 'authoritative history' })
    expect(reducer(state, { type: 'loadEntries', items: [] }).timeline).toEqual([])
  })

  it('preserves two real equal-text sends, including equal timestamps and different persisted IDs', () => {
    let state = applyEvent(seed, start('install', 'row-a', 'user-a'))
    state = applyEvent(state, start('install', 'row-b', 'user-b'))
    state = snapshot(state, 3, [start('install', 'row-a', 'user-a'), start('install', 'row-b', 'user-b')])
    expect(state.timeline.filter((row) => row.kind === 'user').map((row) => row.entryId)).toEqual(['user-a', 'user-b'])
    const unpersisted = applyEvent(applyEvent(seed, start('install', 'row-a')), start('install', 'row-b'))
    expect(snapshot(unpersisted, 3, [start('install', 'row-a'), start('install', 'row-b')]).timeline).toHaveLength(2)
  })

  it('allows genuinely repeated raw starts without treating equal text/timestamp as retransmission proof', () => {
    const raw: WireEventInput = { type: 'message_start', message: { role: 'user', timestamp, content: 'same' } }
    const state = applyEvent(applyEvent(seed, raw), raw)
    expect(state.timeline).toHaveLength(2)
    const later = applyEvent(applyEvent(seed, start('same', 'row-a')), start('same', 'row-b', undefined, timestamp + 1))
    expect(later.timeline).toHaveLength(2)
  })

  it('does not collapse equal timestamps with changed text or attachments without stable proof', () => {
    const raw: WireEventInput = { type: 'message_start', message: { role: 'user', timestamp, content: 'first' } }
    let state = applyEvent(seed, raw)
    state = snapshot(state, 2, [{ type: 'message_start', message: { role: 'user', timestamp, content: 'second' } }])
    expect(state.timeline).toHaveLength(2)
    state = applyEvent(state, { type: 'message_start', message: { role: 'user', timestamp,
      content: [{ type: 'text', text: 'first' }, { type: 'image', mimeType: 'image/png', data: 'new-image' }] } })
    expect(state.timeline).toHaveLength(3)
  })

  it('links an image-free projection to a unique persisted user, preserving its key and original images', () => {
    const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'cached-original' }]
    const page: AgentState['timeline'] = [{ kind: 'user', id: 401, entryId: 'user-a',
      messageTimestamp: timestamp, text: 'install', images }]
    let state = snapshot({ ...seed, timeline: page }, 2, [start('install', 'row-a', undefined, String(timestamp))])
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: 401, entryId: 'user-a', liveMessageId: 'row-a', images })
    state = applyEvent(state, { ...start('install'), _pionLive: {
      backendId: 'backend-a', revision: 2, cwd, sessionPath: path } })
    expect(state.timeline).toHaveLength(1)
    state = applyEvent(state, { ...start('install'), _pionLive: {
      backendId: 'backend-a', revision: 3, cwd, sessionPath: path } })
    expect(snapshot(state, 4, [start('install')]).timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: 401, entryId: 'user-a', images })
  })

  it('keeps image originals when an image-free snapshot precedes cache restoration', () => {
    const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'cached-original' }]
    let state = snapshot(seed, 2, [start('install')])
    const key = state.timeline[0].id
    state = reducer(state, { type: 'loadEntries', replayHistory: true,
      preserveToolState: { revision: state.timelineScopeRevision, cwd, sessionPath: path },
      items: [{ kind: 'user', id: 402, entryId: 'user-a', messageTimestamp: timestamp,
        text: 'install', images }] })
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key, entryId: 'user-a', liveMessageId: 'row-a', images })
  })

  it('does not guess between equal-time persisted users or two snapshot identities', () => {
    const row = { kind: 'user' as const, messageTimestamp: timestamp, text: 'install' }
    const page = [{ ...row, id: 403, entryId: 'user-a' }, { ...row, id: 404, entryId: 'user-b' }]
    expect(snapshot({ ...seed, timeline: page }, 2, [start('install')]).timeline).toHaveLength(3)
    const state = snapshot({ ...seed, timeline: page.slice(0, 1) }, 2,
      [start('install', 'row-a'), start('install', 'row-b')])
    expect(state.timeline).toHaveLength(3)
  })

  it('rejects conflicting live and persisted identities, even with identical time/text', () => {
    let state = applyEvent(seed, start('install', 'row-a', 'user-a'))
    state = applyEvent(state, start('install', 'row-b', 'user-a'))
    state = applyEvent(state, start('install', 'row-a', 'user-b'))
    expect(state.timeline).toHaveLength(3)
  })

  it('supplements a user end timestamp and entry only with stable identity proof', () => {
    const event = start('install')
    delete (event as { message: Record<string, unknown> }).message.timestamp
    let state = applyEvent(seed, event)
    const key = state.timeline[0].id
    state = applyEvent(state, { type: 'message_end', message: { role: 'user', content: 'install',
      timestamp: new Date(timestamp).toISOString(), _pionLiveMessageId: 'row-a', _pionLiveEntryId: 'user-a' } })
    expect(state.timeline).toEqual([expect.objectContaining({ id: key, messageTimestamp: timestamp, entryId: 'user-a' })])
    expect(applyEvent(seed, { type: 'message_end', message: { role: 'user', content: '', timestamp } }).timeline).toEqual([])
  })

  it('attaches a late entry to the matching user, not the latest equal-time different message', () => {
    let state = applyEvent(applyEvent(seed, start('first', 'row-a')), start('second', 'row-b'))
    state = applyEvent(state, entry('user-a', 'first'))
    expect(state.timeline[0]).toMatchObject({ entryId: 'user-a' })
    expect(state.timeline[1]).not.toHaveProperty('entryId')
    const unknown = entry('unknown') as Extract<WireEventInput, { type: 'entry_appended' }>
    delete unknown.entry.message!.timestamp
    state = applyEvent(state, unknown)
    expect(state.timeline[1]).not.toHaveProperty('entryId')
  })
})

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

  it('bridges unique legacy cache assistants only at the explicit same-backend restore boundary', () => {
    const end: WireEventInput = { type: 'message_end', message: { role: 'assistant', timestamp,
      content: [{ type: 'text', text: 'fresh final' }] } }
    const selected = snapshot({ ...seed, timeline: [] }, 3, [start, end], {}, false)
    const key = selected.timeline[0].id
    const cached = { kind: 'assistant' as const, id: 990, messageTimestamp: timestamp,
      text: 'cached final', thinking: '', streaming: false, historical: true, noReveal: true }
    const scope = { revision: selected.timelineScopeRevision, cwd, sessionPath: path }
    const restored = reducer(selected, { type: 'loadEntries', replayHistory: true,
      preserveToolState: scope, items: [cached] })
    expect(restored.timeline).toHaveLength(1)
    expect(restored.timeline[0]).toMatchObject({ id: key, text: 'fresh final', noReveal: false })
    const ordinary = reducer(selected, { type: 'loadEntries', preserveToolState: scope, items: [cached] })
    expect(ordinary.timeline).toHaveLength(2)
    const oldBackend = reducer(selected, { type: 'loadEntries', replayHistory: true,
      preserveToolState: scope, cachedBackendId: 'older-backend', items: [cached] })
    expect(oldBackend.timeline).toHaveLength(2)
    const ambiguous = reducer(selected, { type: 'loadEntries', replayHistory: true,
      preserveToolState: scope, items: [cached, { ...cached, id: 991, text: 'other cached final' }] })
    expect(ambiguous.timeline).toHaveLength(3)
    const native = snapshot({ ...seed, timeline: [] }, 3, [{ ...start, message: { ...(start.message as Record<string, unknown>), _pionLiveMessageId: 'native-a' } },
      { ...end, message: { ...(end.message as Record<string, unknown>), _pionLiveMessageId: 'native-a' } }], {}, false)
    const conflict = reducer(native, { type: 'loadEntries', replayHistory: true,
      preserveToolState: scope, items: [{ ...cached, liveMessageId: 'native-b' }] })
    expect(conflict.timeline).toHaveLength(2)
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

  it('restores call-only history immediately and keeps running status across another same-scope read', () => {
    const toolStart: WireEventInput = { type: 'tool_execution_start', toolCallId: 'active-call', toolName: 'read', args: { path: 'a.ts' } }
    const callPage = entriesToTimeline([{ type: 'message', id: 'assistant-call', parentId: null, timestamp: '',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'active-call', name: 'read', arguments: { path: 'a.ts' } }] } }])
    let state = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    const scope = { revision: state.timelineScopeRevision, cwd, sessionPath: path }
    state = reducer(state, { type: 'loadEntries', items: callPage, preserveToolState: scope })
    const key = state.timeline[0].id
    state = snapshot(state, 4, [toolStart])
    expect(state.timeline[0]).toMatchObject({ id: key, tool: { status: 'running', live: true } })
    state = reducer(state, { type: 'loadEntries', items: callPage, preserveToolState: scope })
    expect(state.timeline[0]).toMatchObject({ id: key, tool: { status: 'running' } })
    state = reducer(state, { type: 'loadEntries', items: [], preserveToolState: scope })
    expect(state.timeline[0]).toMatchObject({ id: key, tool: { status: 'running' } })
  })

  it('restores a live-marked call placeholder on execution_start without requiring a second STATE', () => {
    const state: AgentState = { ...seed, busy: true, timeline: [{ kind: 'tool', id: 999,
      tool: { id: 'cached-call', name: 'read', status: 'done', live: true, resultReceived: false, isError: false } }] }
    const restored = applyEvent(state, { type: 'tool_execution_start', toolCallId: 'cached-call', toolName: 'read', args: { path: 'a.ts' } })
    expect(restored.timeline).toHaveLength(1)
    expect(restored.timeline[0]).toMatchObject({ id: 999, tool: { status: 'running', path: 'a.ts' } })
  })

  it('hydrates display at the forwarded event revision without replaying lifecycle or task accounting', () => {
    let state = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    state = applyEvent(state, { type: 'agent_start', _pionLive: { backendId: 'backend-a', revision: 4, cwd, sessionPath: path } })
    const restored = snapshot(state, 4, [start, delta('background text'), {
      type: 'tool_execution_start', toolCallId: 'active-call', toolName: 'read', args: { path: 'a.ts' }
    }])
    expect(restored.timeline).toHaveLength(2)
    expect(restored.timeline[0]).toMatchObject({ text: 'background text', streaming: true })
    expect(restored.timeline[1]).toMatchObject({ tool: { status: 'running' } })
    expect(restored.taskRevision).toBe(state.taskRevision)
    expect(restored.taskResultIds).toBe(state.taskResultIds)
    expect(snapshot(restored, 4, [start, delta('background text'), {
      type: 'tool_execution_start', toolCallId: 'active-call', toolName: 'read', args: { path: 'a.ts' }
    }]).timeline).toBe(restored.timeline)
    const missing = { ...restored, timeline: [], liveSessionTurnIds: [] }
    expect(snapshot(missing, 4, [start, delta('background text')]).timeline[0]).toMatchObject({ text: 'background text' })
  })

  it.each(['tool_execution_start', 'tool_execution_update'] as const)(
    'hydrates lifecycle from the first equal-revision STATE after metadata-only %s', (type) => {
      const toolStart: WireEventInput = { type: 'tool_execution_start', toolCallId: 'active-call', toolName: 'read', args: { path: 'a.ts' } }
      const toolUpdate: WireEventInput = { type: 'tool_execution_update', toolCallId: 'active-call', toolName: 'read',
        partialResult: { content: [{ type: 'text', text: 'reading' }] } }
      let state = reducer(seed, { type: 'clearTimeline', sessionPath: path })
      state = applyEvent(state, { ...(type === 'tool_execution_start' ? toolStart : toolUpdate),
        _pionLive: { backendId: 'backend-a', revision: 10, cwd, sessionPath: path } })
      expect(state.busy).toBe(false)
      expect(state.liveSessionRevision).toBe(10)
      expect(state.liveSessionLifecycleRevision).toBeUndefined()
      const events = [start, delta('partial assistant'), toolStart, toolUpdate]
      const restored = snapshot(state, 10, events)
      expect(restored).toMatchObject({ busy: true, liveSessionLifecycleRevision: 10 })
      expect(restored.timeline.find((row) => row.kind === 'assistant')).toMatchObject({ text: 'partial assistant', streaming: true })
      expect(restored.timeline.find((row) => row.kind === 'tool')).toMatchObject({ tool: { status: 'running', outputText: 'reading' } })
      const tool = restored.timeline.find((row) => row.kind === 'tool')
      if (tool?.kind === 'tool') {
        expect(tool.tool.resultReceived).not.toBe(true)
        expect(tool.tool.resultSource).not.toBe('history')
      }
      expect(deriveWorkingStatus(restored).label).toBe('读取项目中...')
      expect(restored.taskRevision).toBe(state.taskRevision)
      expect(restored.taskResultIds).toBe(state.taskResultIds)
      // An already accepted STATE can restore rows after cache replacement,
      // but must not replace the known lifecycle with conflicting equal flags.
      const missing = { ...restored, timeline: [], liveSessionTurnIds: [] }
      const reprojected = snapshot(missing, 10, events, {}, false)
      expect(reprojected.busy).toBe(true)
      expect(deriveWorkingStatus(reprojected).label).toBe('读取项目中...')
      const loaded = reducer(restored, { type: 'loadEntries', items: [], preserveToolState: {
        revision: restored.timelineScopeRevision, cwd, sessionPath: path } })
      expect(loaded.busy).toBe(true)
      expect(deriveWorkingStatus(loaded).label).toBe('读取项目中...')
    }
  )

  it('hydrates a metadata-first assistant delta at equal revision, even after older lifecycle proof', () => {
    let state = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    state = applyEvent(state, { type: 'agent_settled', _pionLive: { backendId: 'backend-a', revision: 9, cwd, sessionPath: path } })
    state = applyEvent(state, { ...delta('suffix'), _pionLive: { backendId: 'backend-a', revision: 10, cwd, sessionPath: path } })
    expect(state).toMatchObject({ busy: false, liveSessionRevision: 10, liveSessionLifecycleRevision: 9 })
    const restored = snapshot(state, 10, [start, delta('complete partial body')])
    expect(restored).toMatchObject({ busy: true, compacting: false, liveSessionLifecycleRevision: 10 })
    expect(restored.timeline[0]).toMatchObject({ text: 'complete partial body', streaming: true })
    expect(deriveWorkingStatus(restored).label).toBe('组织回复中...')
    const older = snapshot(restored, 9, [], {}, false)
    expect(older.busy).toBe(true)
    expect(older.timeline).toBe(restored.timeline)
  })

  it('keeps a known root settled revision idle when equal STATE still says streaming', () => {
    const toolStart: WireEventInput = { type: 'tool_execution_start', toolCallId: 'active-call', toolName: 'read', args: {} }
    let state = snapshot(reducer(seed, { type: 'clearTimeline', sessionPath: path }), 10, [start, delta('partial'), toolStart])
    state = applyEvent(state, { type: 'agent_settled', _pionLive: { backendId: 'backend-a', revision: 20, cwd, sessionPath: path } })
    const restored = snapshot(state, 20, [start, delta('partial'), toolStart])
    expect(restored).toMatchObject({ busy: false, compacting: false, liveSessionLifecycleRevision: 20 })
    expect(restored.timeline.find((row) => row.kind === 'assistant')).toMatchObject({ streaming: false })
    const tool = restored.timeline.find((row) => row.kind === 'tool')
    expect(tool).toMatchObject({ tool: { status: 'done' } })
    if (tool?.kind === 'tool') {
      expect(tool.tool.resultReceived).not.toBe(true)
      expect(tool.tool.resultSource).not.toBe('history')
    }
    expect(deriveWorkingStatus(restored).label).not.toBe('读取项目中...')
  })

  it('accepts higher idle STATE with full cached prefix and releases its active display tails', () => {
    const toolStart: WireEventInput = { type: 'tool_execution_start', toolCallId: 'active-call', toolName: 'read', args: {} }
    const current = snapshot(reducer(seed, { type: 'clearTimeline', sessionPath: path }), 10,
      [start, delta('complete cached prefix'), toolStart])
    const ended = snapshot(current, 11, [start, { type: 'message_end', message: {
      role: 'assistant', timestamp, content: '', _pionLiveTruncatedFields: ['text'] } }, toolStart], { truncated: true }, false)
    expect(ended).toMatchObject({ busy: false, liveSessionLifecycleRevision: 11 })
    expect(ended.timeline[0]).toMatchObject({ id: current.timeline[0].id, text: 'complete cached prefix', streaming: false })
    expect(ended.timeline[1]).toMatchObject({ tool: { status: 'done' } })
    const loaded = reducer(ended, { type: 'loadEntries', items: current.timeline, preserveToolState: {
      revision: ended.timelineScopeRevision, cwd, sessionPath: path } })
    expect(loaded.timeline[0]).toMatchObject({ text: 'complete cached prefix', streaming: false })
    expect(loaded.busy).toBe(false)
  })

  it('records root compaction lifecycle proof and preserves it against equal STATE flags', () => {
    let state = reducer(seed, { type: 'clearTimeline', sessionPath: path })
    state = applyEvent(state, { type: 'compaction_start', reason: 'manual',
      _pionLive: { backendId: 'backend-a', revision: 10, cwd, sessionPath: path } })
    state = snapshot(state, 10, [], {}, false)
    expect(state).toMatchObject({ busy: true, compacting: true, liveSessionLifecycleRevision: 10 })
    state = applyEvent(state, { type: 'compaction_end', reason: 'manual', result: {}, aborted: false, willRetry: false,
      _pionLive: { backendId: 'backend-a', revision: 11, cwd, sessionPath: path } })
    expect(snapshot(state, 11, [])).toMatchObject({ busy: false, compacting: false, liveSessionLifecycleRevision: 11 })
  })

  it('resets lifecycle proof on scope clear, ready reset, dead status and backend replacement', () => {
    const current = snapshot(seed, 10, [start, delta('partial')])
    expect(reducer(current, { type: 'clearTimeline', sessionPath: path }).liveSessionLifecycleRevision).toBeUndefined()
    for (const phase of ['stopped', 'error', 'ready'] as const) {
      const resettable = { ...current, status: { ...current.status, phase: 'starting' as const } }
      expect(reducer(resettable, { type: 'status', status: { phase, cwd } }).liveSessionLifecycleRevision).toBeUndefined()
    }
    const replacement = applyEvent(current, { ...delta('other backend'),
      _pionLive: { backendId: 'replacement', revision: 1, cwd, sessionPath: path } })
    expect(replacement.liveSessionLifecycleRevision).toBeUndefined()
  })

  it('does not let timestampless snapshot fallback overwrite a different stable assistant', () => {
    const nativeStart = (identity: string): WireEventInput => ({ type: 'message_start', message: {
      role: 'assistant', content: [], _pionLiveMessageId: identity } })
    const first = snapshot({ ...seed, timeline: [] }, 2, [nativeStart('first'), delta('first text')])
    const second = snapshot(first, 3, [nativeStart('second'), delta('second text')])
    expect(second.timeline).toHaveLength(2)
    expect(second.timeline[0]).toMatchObject({ liveMessageId: 'first', text: 'first text' })
    expect(second.timeline[1]).toMatchObject({ liveMessageId: 'second', text: 'second text' })
    const emptySecond = snapshot(first, 4, [nativeStart('second'), { type: 'message_end', message: {
      role: 'assistant', content: [], _pionLiveMessageId: 'second' } }])
    expect(emptySecond.timeline).toEqual(first.timeline)
  })

  it('restores a cache-only assistant marked reconciled but never replaces a persisted final with a partial', () => {
    const nativeStart: WireEventInput = { type: 'message_start', message: { role: 'assistant',
      content: [], _pionLiveMessageId: 'active-assistant' } }
    const cached = { kind: 'assistant' as const, id: 998, liveMessageId: 'active-assistant',
      text: 'cache text', thinking: '', streaming: false, historyReconciled: true }
    const restored = snapshot({ ...seed, timeline: [cached] }, 4, [nativeStart, delta('fresh text')])
    expect(restored.timeline[0]).toMatchObject({ id: 998, text: 'fresh text', streaming: true })
    const persisted = snapshot({ ...seed, timeline: [{ ...cached, entryId: 'final-entry' }] }, 4, [nativeStart, delta('partial')])
    expect(persisted.timeline[0]).toMatchObject({ id: 998, text: 'cache text', streaming: false })
    const different = snapshot({ ...seed, timeline: [{ ...cached, entryId: 'final-entry' }] }, 4,
      [{ type: 'message_start', message: { role: 'assistant', content: [], _pionLiveMessageId: 'different-assistant', _pionLiveEntryId: 'different-entry' } }, delta('other text')])
    expect(different.timeline).toHaveLength(2)
  })

  it('does not revive a completed tool from a partial snapshot, or finish other tools while the backend is busy', () => {
    const toolStart = (id: string): WireEventInput => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: {} })
    let state = snapshot({ ...seed, timeline: [] }, 2, [toolStart('first'), toolStart('second')])
    state = applyEvent(state, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'first', content: [{ type: 'text', text: 'final' }] } })
    state = snapshot(state, 3, [toolStart('first'), toolStart('second')])
    expect(state.timeline[0]).toMatchObject({ tool: { status: 'done', resultReceived: true, outputText: 'final' } })
    expect(state.timeline[1]).toMatchObject({ tool: { status: 'running' } })
    const idle = snapshot(state, 4, [toolStart('first'), toolStart('second')], {}, false)
    expect(idle.busy).toBe(false)
    expect(idle.timeline[1]).toMatchObject({ tool: { status: 'done' } })
    const settled = applyEvent(state, { type: 'agent_settled' })
    expect(settled.busy).toBe(false)
    expect(settled.timeline[1]).toMatchObject({ tool: { status: 'done' } })
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
    const user: WireEventInput = { type: 'message_start', message: { role: 'user', timestamp: timestamp - 1, _pionLiveMessageId: 'user-request',
      content: [{ type: 'text', text: 'long request' }, { type: 'image', mimeType: 'image/png', data: 'attachment' }] } }
    const state = snapshot(seed, 2, [user, start, delta('first')])
    const updated = snapshot(state, 4, [
      { type: 'message_start', message: { role: 'user', timestamp: timestamp - 1, _pionLiveMessageId: 'user-request', content: 'long', _pionLiveTruncatedFields: ['text'] } },
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
    const user: WireEventInput = { type: 'message_start', message: { role: 'user', timestamp, _pionLiveMessageId: 'user-with-image',
      content: [{ type: 'text', text: 'long request' }, { type: 'image', mimeType: 'image/png', data: 'attachment' }] } }
    const state = snapshot(seed, 2, [user])
    const updated = snapshot(state, 3, [{ type: 'message_start', message: { role: 'user', timestamp, _pionLiveMessageId: 'user-with-image', content: 'short' } }])
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
