// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, within } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { entriesToTimeline, messageTurnTiming, reconcileNewerTimelineItems, reconcileOlderTimelineItems } from '../../src/renderer/src/agent/timeline'
import { initialState, type AgentState, type TimelineItem } from '../../src/renderer/src/agent/types'
import { ChatMessage } from '../../src/renderer/src/features/chat/ChatMessage'
import { ChatTimeline, type ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import { formatMessageTime, formatTurnDuration } from '../../src/renderer/src/utils/conversationTime'
import { PION_TURN_TIMING_TYPE, type TurnTiming } from '../../src/shared/conversation-timing'
import type { WireEntry, WireEventInput, WireMessage } from '../../src/shared/types'

const clock = 1_780_000_000_000
const cwd = '/project'
const path = '/sessions/timing.jsonl'
type User = Extract<TimelineItem, { kind: 'user' }>
const timing = (offset = 0, outcome: TurnTiming['outcome'] = 'completed'): TurnTiming => ({
  startedAt: clock, finishedAt: clock + 2_000 + offset, durationMs: 2_000 + offset, outcome
})
const message = (live = 'live-a', extra: Partial<WireMessage> = {}): WireMessage => ({
  role: 'user', content: '相同输入', timestamp: clock, _pionLiveMessageId: live, ...extra
})
const user = (id = 1, extra: Partial<User> = {}): User => ({
  kind: 'user', id, text: '相同输入', messageTimestamp: clock, noReveal: true, ...extra
})
const entry = (id: string, msg: WireMessage): WireEntry => ({
  type: 'message', id, parentId: null, timestamp: new Date(clock + 86_400_000).toISOString(), message: msg
})
const receipt = (live: string | undefined, userEntryId = 'user-a', time = timing()): WireEventInput => ({
  type: 'entry_appended', entry: { type: 'custom', id: `receipt-${userEntryId}`, parentId: null,
    timestamp: new Date(clock + 9_000).toISOString(), customType: PION_TURN_TIMING_TYPE,
    ...(live === undefined ? {} : { _pionLiveMessageId: live }),
    data: { version: 1, userEntryId, inputId: `input-${userEntryId}`, ...time } }
})
const rejected = (live?: string): WireEventInput => ({ type: 'entry_appended', entry: {
  ...(receipt(live, 'user-b', { ...timing(), startedAt: clock + 1, durationMs: 1_999 }) as { entry: WireEntry }).entry,
  _pionTurnTimingRejected: true
} })
const seed = (timeline: TimelineItem[] = []): AgentState => ({
  ...initialState, status: { phase: 'running', cwd }, timeline
})
const emit = (state: AgentState, event: WireEventInput) => reducer(state, { type: 'event', event })
const staticItems = (items: TimelineItem[]) => items.map(item => ({ ...item, noReveal: true }))
function props(timeline: TimelineItem[]): ChatTimelineProps {
  return { scrollRef: createRef<HTMLDivElement>(), onScroll: vi.fn(), timeline: staticItems(timeline),
    timelineLoading: false, busy: false, starting: false, cwd, hasSessions: true,
    canFork: false, onFork: vi.fn(), agentActivity: false, workingStatus: { label: '' } }
}
function snapshot(state: AgentState, revision: number, events: WireEventInput[]): AgentState {
  return reducer(state, { type: 'session', session: {
    sessionId: 'timing', sessionFile: path, messageCount: 1, isStreaming: false,
    liveState: { backendId: 'backend-timing', revision, cwd, sessionPath: path, events }
  } })
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('conversation timing evidence and placement', () => {
  it('shows the SDK send clock below the user bubble, ignoring the append clock', () => {
    const items = entriesToTimeline([entry('user-a', message())])
    const item = items[0] as User
    const view = render(<ChatMessage item={{ ...item, noReveal: true }} canFork={false} />)
    const time = view.container.querySelector('time.message-time')!
    expect(time).toHaveTextContent(formatMessageTime(clock)!)
    expect(time).toHaveAttribute('datetime', new Date(clock).toISOString())
    expect(view.container.querySelector('.bubble-user')!.contains(time)).toBe(false)
    expect(view.container.querySelector('.row-user')!.contains(time)).toBe(true)
    view.rerender(<ChatMessage item={{ ...item, messageTimestamp: undefined, noReveal: true }} canFork={false} />)
    expect(view.container.querySelector('time')).toBeNull()
    expect(messageTurnTiming(message('live-a', { _pionTurnTiming: timing() }))).toEqual(timing())
    expect(messageTurnTiming(message('live-a', { _pionTurnTiming: null }))).toBeNull()
    expect(messageTurnTiming(message('live-a', { timestamp: clock + 1, _pionTurnTiming: timing() }))).toBeUndefined()
  })

  it('places distinct receipts under their own equal-text user turns and labels non-completion', () => {
    const first = timing()
    const second = timing(5_000, 'aborted')
    const items = entriesToTimeline([
      entry('user-a', message('live-a', { _pionTurnTiming: first })),
      entry('answer-a', { role: 'assistant', timestamp: clock + 100, content: '第一轮回答' }),
      entry('user-b', message('live-b', { _pionTurnTiming: second })),
      entry('answer-b', { role: 'assistant', timestamp: clock + 500, content: '第二轮回答' })
    ])
    const view = render(<ChatTimeline {...props(items)} />)
    const footers = view.container.querySelectorAll('.turn-time')
    expect(footers).toHaveLength(2)
    const rows = view.container.querySelectorAll('.row')
    for (const [index, time] of [first, second].entries()) {
      expect(footers[index]).toHaveTextContent(formatMessageTime(time.finishedAt)!)
      expect(footers[index]).toHaveTextContent(`耗时 ${formatTurnDuration(time.durationMs!)}`)
      expect(rows[index * 2 + 1].compareDocumentPosition(footers[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(footers[0].compareDocumentPosition(rows[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(footers[0]).toHaveTextContent('完成时间')
    expect(footers[1]).toHaveTextContent('结束时间')
    expect(footers[1]).not.toHaveTextContent('完成时间')
  })

  it('leaves legacy history without a completion footer despite assistant or current clocks', () => {
    const items = entriesToTimeline([
      entry('legacy-user', { role: 'user', content: '旧历史' }),
      entry('legacy-answer', { role: 'assistant', timestamp: clock + 8_000, content: '旧回答' })
    ])
    const view = render(<ChatTimeline {...props(items)} />)
    expect(view.container.querySelector('.message-time')).toBeNull()
    expect(view.container.querySelector('.turn-time')).toBeNull()
    expect((items[0] as User).turnTiming).toBeUndefined()
  })

  it('suppresses only the truncated trailing turn and keeps earlier complete footers', () => {
    const items = [user(1, { turnTiming: timing() }), user(2, { turnTiming: timing(1_000) })]
    const p = props(items)
    const view = render(<ChatTimeline {...p} hasNewerHistory />)
    const footers = view.container.querySelectorAll('.turn-time')
    expect(footers).toHaveLength(1)
    expect(footers[0]).toHaveTextContent(formatMessageTime(timing().finishedAt)!)
    view.rerender(<ChatTimeline {...p} hasNewerHistory={false} />)
    expect(view.container.querySelectorAll('.turn-time')).toHaveLength(2)
    view.rerender(<ChatTimeline {...props([user(3)])} readOnly scopeKey="child" />)
    expect(view.container.querySelector('.turn-time')).toBeNull()
  })
})

describe('conversation timing reducer identity', () => {
  it('attaches a custom receipt by exact live identity, backfills entry ID and preserves mounted rows', () => {
    let state = emit(seed(), { type: 'message_start', message: message() })
    state = emit(state, { type: 'message_start', message: message('live-b') })
    const ids = state.timeline.map(row => row.id)
    const view = render(<ChatTimeline {...props(state.timeline)} />)
    const bubbles = [...view.container.querySelectorAll('.bubble-user')]
    state = emit(state, receipt('live-b', 'user-b', timing(5_000)))
    expect(state.timeline).toHaveLength(2)
    expect((state.timeline[0] as User).turnTiming).toBeUndefined()
    expect(state.timeline[1]).toMatchObject({ id: ids[1], entryId: 'user-b', turnTiming: timing(5_000) })
    view.rerender(<ChatTimeline {...props(state.timeline)} />)
    const retained = view.container.querySelectorAll('.bubble-user')
    bubbles.forEach((bubble, index) => expect(retained[index]).toBe(bubble))
    state = emit(state, receipt('live-b', 'user-b', timing(5_000)))
    expect(state.timeline.map(row => row.id)).toEqual(ids)
    const known = emit(seed([user(7, { entryId: 'known' })]), receipt(undefined, 'known'))
    expect(known.timeline[0]).toMatchObject({ id: 7, entryId: 'known', turnTiming: timing() })
  })

  it('recovers timing from a user message_end without replacing its start row', () => {
    const started = emit(seed(), { type: 'message_start', message: message() })
    const ended = emit(started, { type: 'message_end', message: message('live-a', { _pionTurnTiming: timing() }) })
    expect(ended.timeline).toHaveLength(1)
    expect(ended.timeline[0]).toMatchObject({ id: started.timeline[0].id, turnTiming: timing() })
  })

  it.each([
    ['clock mismatch', [user(1, { liveMessageId: 'live-a', messageTimestamp: clock + 1 })], 'live-a', 'user-a'],
    ['entry conflict', [user(1, { liveMessageId: 'live-a', entryId: 'other' })], 'live-a', 'user-a'],
    ['live conflict', [user(1, { liveMessageId: 'other', entryId: 'user-a' })], 'live-a', 'user-a'],
    ['unknown identity', [user(1)], 'unknown', 'user-a'],
    ['no identity', [user(1)], undefined, 'user-a'],
    ['split live and entry identity', [user(1, { liveMessageId: 'live-a' }), user(2, { entryId: 'user-a' })], 'live-a', 'user-a'],
    ['duplicate live identity', [user(1, { liveMessageId: 'live-a' }), user(2, { liveMessageId: 'live-a' })], 'live-a', 'user-a'],
    ['duplicate entry identity', [user(1, { entryId: 'user-a' }), user(2, { entryId: 'user-a' })], undefined, 'user-a']
  ] as const)('rejects %s without guessing by text or clock', (_name, rows, live, entryId) => {
    const before = seed([...rows])
    const after = emit(before, receipt(live, entryId))
    expect(after.timeline).toEqual(before.timeline)
    expect(after.timeline.every(row => row.kind !== 'user' || row.turnTiming === undefined)).toBe(true)
  })

  it('retires the real live source despite conflicting payload identity and never revives its footer', () => {
    let state = snapshot(seed(), 1, [{ type: 'message_start', message: message('live-a', {
      _pionLiveEntryId: 'user-a', _pionTurnTiming: timing() }) }])
    const key = state.timeline[0].id
    const view = render(<ChatTimeline {...props(state.timeline)} />)
    expect(view.container.querySelector('.turn-time')).toBeInTheDocument()
    state = emit(state, rejected('live-a'))
    expect(state.timeline[0]).toMatchObject({ id: key, entryId: 'user-a', turnTiming: null })
    state = emit(state, receipt('live-a'))
    state = emit(state, { type: 'message_end', message: message('live-a', { _pionTurnTiming: timing() }) })
    state = reducer(state, { type: 'loadEntries', replayHistory: true, cachedBackendId: 'backend-timing',
      items: entriesToTimeline([entry('user-a', message('live-a', { _pionTurnTiming: timing() }))]),
      preserveToolState: { revision: state.timelineScopeRevision, cwd, sessionId: 'timing', sessionPath: path } })
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key, turnTiming: null })
    view.rerender(<ChatTimeline {...props(state.timeline)} />)
    expect(view.container.querySelector('.turn-time')).toBeNull()
  })

  it('requires a unique real live source and leaves the payload-named row alone', () => {
    const before = seed([user(1, { entryId: 'user-a', liveMessageId: 'live-a', turnTiming: timing() }),
      user(2, { entryId: 'user-b', liveMessageId: 'live-b', turnTiming: timing() })])
    for (const live of [undefined, 'wrong-live']) expect(emit(before, rejected(live)).timeline).toEqual(before.timeline)
    const after = emit(before, rejected('live-a'))
    expect((after.timeline[0] as User).turnTiming).toBeNull()
    expect(after.timeline[1]).toBe(before.timeline[1])
  })

  it('honors snapshot null withdrawals across later positive snapshots', () => {
    const events = (turnTiming: TurnTiming | null): WireEventInput[] => [{ type: 'message_start',
      message: message('live-a', { _pionLiveEntryId: 'user-a', _pionTurnTiming: turnTiming }) }]
    let state = snapshot(seed(), 1, events(timing()))
    const key = state.timeline[0].id
    state = snapshot(state, 2, events(null))
    expect(state.timeline[0]).toMatchObject({ id: key, turnTiming: null })
    state = snapshot(state, 3, events(timing()))
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key, turnTiming: null })
    const view = render(<ChatTimeline {...props(state.timeline)} />)
    expect(view.container.querySelector('.turn-time')).toBeNull()
  })

  it('merges known-entry page overlaps without changing mounted IDs or order in either direction', () => {
    for (const reconcile of [reconcileOlderTimelineItems, reconcileNewerTimelineItems]) {
      for (const incomingTiming of [timing(), null]) {
        const existing = [user(11, { entryId: 'before' }), user(12, { entryId: 'user-a' }), user(13, { entryId: 'after' })]
        const incoming = [user(99, { entryId: 'user-a', turnTiming: incomingTiming })]
        const merged = reconcile(existing, incoming).items
        expect(merged.map(row => row.id)).toEqual([11, 12, 13])
        expect((merged[1] as User).turnTiming).toEqual(incomingTiming)
        const reread = reconcile(merged, [user(100, { entryId: 'user-a', turnTiming: timing() })]).items
        expect(reread.map(row => row.id)).toEqual([11, 12, 13])
        expect((reread[1] as User).turnTiming).toEqual(incomingTiming)
      }
    }
  })

  it('fills an unknown mounted receipt from a same-scope replayHistory cache', () => {
    const state = snapshot(seed(), 1, [{ type: 'message_start', message: message('live-a', { _pionLiveEntryId: 'user-a' }) }])
    const restored = reducer(state, { type: 'loadEntries', replayHistory: true, cachedBackendId: 'backend-timing',
      items: entriesToTimeline([entry('user-a', message('live-a', { _pionTurnTiming: timing() }))]),
      preserveToolState: { revision: state.timelineScopeRevision, cwd, sessionId: 'timing', sessionPath: path } })
    expect(restored.timeline).toHaveLength(1)
    expect(restored.timeline[0]).toMatchObject({ id: state.timeline[0].id, entryId: 'user-a', turnTiming: timing() })
  })

  it('keeps agent_end retry and busy-to-idle transitions free of invented timing', () => {
    let state = emit(seed(), { type: 'agent_start' })
    state = emit(state, { type: 'message_start', message: message() })
    for (const willRetry of [true, false]) {
      state = emit(state, { type: 'agent_end', messages: [], willRetry })
      expect((state.timeline[0] as User).turnTiming).toBeUndefined()
    }
    state = emit(state, { type: 'agent_settled' })
    state = reducer(state, { type: 'session', session: {
      sessionId: 'timing', sessionFile: path, messageCount: 1, isStreaming: false
    } })
    expect(state.busy).toBe(false)
    expect((state.timeline[0] as User).turnTiming).toBeUndefined()
    const view = render(<ChatTimeline {...props(state.timeline)} />)
    expect(view.container.querySelector('.turn-time')).toBeNull()
  })

  it('restores annotated live snapshots once and retains timing through older display data', () => {
    const annotated = message('live-a', { _pionLiveEntryId: 'user-a', _pionTurnTiming: timing() })
    const events: WireEventInput[] = [
      { type: 'message_start', message: annotated }, { type: 'message_end', message: annotated }
    ]
    let state = snapshot(seed(), 2, events)
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ entryId: 'user-a', turnTiming: timing() })
    const key = state.timeline[0].id
    const view = render(<ChatTimeline {...props(state.timeline)} />)
    const bubble = view.container.querySelector('.bubble-user')
    expect(view.container.querySelector('.turn-time')).toHaveTextContent(formatMessageTime(timing().finishedAt)!)
    state = snapshot(state, 2, events)
    const legacy = message('live-a', { _pionLiveEntryId: 'user-a' })
    state = snapshot(state, 3, [{ type: 'message_start', message: legacy }, { type: 'message_end', message: legacy }])
    state = reducer(state, { type: 'loadEntries', items: entriesToTimeline([entry('user-a', legacy)]),
      preserveToolState: { revision: state.timelineScopeRevision, cwd, sessionId: 'timing', sessionPath: path } })
    expect(state.timeline).toHaveLength(1)
    expect(state.timeline[0]).toMatchObject({ id: key, turnTiming: timing() })
    view.rerender(<ChatTimeline {...props(state.timeline)} />)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect(within(view.container).getByLabelText(`完成时间：${formatMessageTime(timing().finishedAt)}`)).toBeInTheDocument()
  })
})
