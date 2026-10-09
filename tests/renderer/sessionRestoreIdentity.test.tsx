// @vitest-environment jsdom
import { useCallback, useReducer, useRef, createRef } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveSessionProjection } from '../../src/main/agent/live-session-state'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { getViewportHistoryPageSize } from '../../src/renderer/src/agent/timeline'
import { initialState, type Action, type TimelineItem } from '../../src/renderer/src/agent/types'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { useAgentSubscriptions } from '../../src/renderer/src/hooks/agent/useAgentSubscriptions'
import { ChatTimeline, type ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import { messageTimestamp } from '../../src/shared/types'
import type {
  AgentStatus, PionApi, SessionEntriesPage, SessionHistoryIndex, SessionInfo,
  WireEntry, WireEvent, WireEventInput, WireMessage
} from '../../src/shared/types'

const cwd = '/fixture/project'
const aPath = '/fixture/sessions/a.jsonl'
const bPath = '/fixture/sessions/b.jsonl'
const clock = 1_780_000_000_000
const prompt = '安装这个吧'
const answer = '已经处理好了。'
type MessageRow = Extract<TimelineItem, { kind: 'user' | 'assistant' }>
type MessageEvent = Extract<WireEvent, { type: 'message_start' | 'message_end' }>
type RestoreOrder = 'STATE before cache' | 'cache before STATE'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function messageOf(event: WireEventInput): WireMessage {
  if (event.type !== 'message_start' && event.type !== 'message_end') throw new Error('Not a message event')
  return (event as MessageEvent).message
}

// Independent RPC JSON parses and independent manager entries: ordinary SDK
// message_end is followed by an append, NOT by an entry_appended notification.
class MemoryBackend {
  readonly projection = new LiveSessionProjection()
  readonly entries: WireEntry[] = []
  readonly parsed: WireEventInput[] = []
  readonly forwarded: WireEventInput[] = []
  streaming = false

  constructor(readonly path: string, readonly sessionId: string) {}

  append(id: string, message: WireMessage): WireEntry {
    if (typeof message.timestamp !== 'number') throw new Error('An actual SDK message clock is required')
    if ('_pionLiveMessageId' in message || '_pionLiveEntryId' in message) throw new Error('RPC annotations are not persisted')
    const entry: WireEntry = { type: 'message', id, parentId: this.entries.at(-1)?.id ?? null,
      timestamp: new Date(message.timestamp + 27).toISOString(), message: clone(message) }
    this.entries.push(entry)
    return entry
  }

  emit(event: WireEvent, api?: MemoryApi): WireEventInput {
    const parsed: WireEventInput = clone(event)
    this.parsed.push(parsed)
    this.projection.record(parsed)
    if (event.type === 'agent_start') this.streaming = true
    if (event.type === 'agent_settled') this.streaming = false
    const forwarded = clone({ ...this.projection.annotateEvent(parsed),
      _pionLive: this.projection.metadata(cwd, this.path) })
    this.forwarded.push(forwarded)
    if (api?.selected === this) api.publishEvent(forwarded)
    return forwarded
  }

  turn(id: string, at = clock, api?: MemoryApi) {
    const user: WireMessage = { role: 'user', timestamp: at, content: [{ type: 'text', text: prompt }] }
    const assistant: WireMessage = { role: 'assistant', timestamp: at + 1_000,
      content: [{ type: 'text', text: answer }], stopReason: 'stop' }
    this.emit({ type: 'agent_start' }, api)
    const userStart = this.emit({ type: 'message_start', message: user }, api)
    this.emit({ type: 'message_end', message: user }, api)
    const userEntry = this.append(`${id}-user`, user)
    const assistantStart = this.emit({ type: 'message_start', message: { ...assistant, content: [] } }, api)
    this.emit({ type: 'message_update', usage: null,
      assistantMessageEvent: { type: 'text_delta', delta: '准备回复。' } }, api)
    this.emit({ type: 'message_end', message: assistant }, api)
    const assistantEntry = this.append(`${id}-assistant`, assistant)
    this.emit({ type: 'agent_end', messages: [user, assistant], willRetry: false }, api)
    this.emit({ type: 'agent_settled' }, api)
    return { user, assistant, userEntry, assistantEntry,
      userLiveId: messageOf(userStart)._pionLiveMessageId as string,
      assistantLiveId: messageOf(assistantStart)._pionLiveMessageId as string }
  }

  // A real landmark plus invisible metadata makes an actual middle window.
  // Cursor completeness/ownership are produced by jumpToHistoryLandmark, not
  // handwritten cache flags or manually assigned hook refs.
  seedMiddleWindow() {
    this.append('anchor-user', { role: 'user', timestamp: clock - 20_000, content: '历史定位' })
    for (let i = 0; i < getViewportHistoryPageSize() + 4; i++) {
      this.entries.push({ type: 'model_change', id: `metadata-${i}`,
        parentId: this.entries.at(-1)?.id ?? null,
        timestamp: new Date(clock - 19_000 + i * 13).toISOString(), provider: 'fixture', modelId: 'fixture' })
    }
  }

  session(): SessionInfo {
    return clone({ sessionId: this.sessionId, sessionFile: this.path, isStreaming: this.streaming,
      isCompacting: false, messageCount: this.entries.filter((entry) => entry.type === 'message').length,
      pendingMessageCount: 0, liveState: this.projection.snapshot(cwd, this.path) })
  }

  page(before?: number, limit = getViewportHistoryPageSize()): SessionEntriesPage {
    const total = this.entries.length
    const end = Math.min(before ?? total, total)
    const start = Math.max(0, end - limit)
    return clone({ entries: this.entries.slice(start, end), toolResults: [], taskSnapshot: [],
      start, end, total, leafId: this.entries.at(-1)?.id ?? null, mode: 'build' })
  }

  index(): SessionHistoryIndex {
    return clone({ sessionPath: this.path, totalEntries: this.entries.length,
      leafId: this.entries.at(-1)?.id ?? null,
      landmarks: this.entries.flatMap((entry, entryIndex) => entry.message?.role === 'user'
        ? [{ entryId: entry.id, entryIndex, ordinal: 0, snippet: '', timestamp: entry.timestamp,
          messageTimestamp: messageTimestamp(entry.message) }] : []).map((landmark, i) => ({ ...landmark, ordinal: i + 1 })) })
  }
}

class MemoryApi {
  selected: MemoryBackend
  readonly stateListeners = new Set<Parameters<PionApi['onState']>[0]>()
  readonly eventListeners = new Set<Parameters<PionApi['onEvent']>[0]>()
  readonly statusListeners = new Set<Parameters<PionApi['onStatus']>[0]>()
  readonly pages: { path: string; before?: number; limit?: number; page: SessionEntriesPage;
    gate: ReturnType<typeof deferred<SessionEntriesPage | null>>; resolved: boolean }[] = []
  readonly switches: { path: string; gate: ReturnType<typeof deferred<{ cancelled: boolean }>>; resolved: boolean }[] = []
  readonly states: SessionInfo[] = []
  readonly api: PionApi

  constructor(readonly a: MemoryBackend, readonly b: MemoryBackend) {
    this.selected = a
    const noopSubscription = () => () => undefined
    this.api = {
      getState: vi.fn<PionApi['getState']>(async () => this.selected.session()),
      getEntriesPage: vi.fn<PionApi['getEntriesPage']>((before, limit, path = this.selected.path) => {
        const request = { path, before, limit, page: this.backend(path).page(before, limit),
          gate: deferred<SessionEntriesPage | null>(), resolved: false }
        this.pages.push(request)
        return request.gate.promise
      }),
      getHistoryIndex: vi.fn<PionApi['getHistoryIndex']>(async (path = this.selected.path) => this.backend(path).index()),
      switchSession: vi.fn<PionApi['switchSession']>((path) => {
        this.selected = this.backend(path)
        const request = { path, gate: deferred<{ cancelled: boolean }>(), resolved: false }
        this.switches.push(request)
        return request.gate.promise
      }),
      onState: (listener) => { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener) } },
      onEvent: (listener) => { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener) } },
      onStatus: (listener) => { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } },
      onRunCheckpoint: noopSubscription, onSessions: noopSubscription, onUnreadSessions: noopSubscription,
      onRunningSessionPaths: noopSubscription, onTree: noopSubscription, onProjects: noopSubscription,
      getRunningSessionPaths: async () => [], getUnreadSessionPaths: async () => []
    } satisfies Partial<PionApi> as unknown as PionApi
  }

  backend(path: string) {
    if (path === this.a.path) return this.a
    if (path === this.b.path) return this.b
    throw new Error(`Unknown simulated session: ${path}`)
  }
  publishState(backend = this.selected) {
    const session = backend.session()
    this.states.push(session)
    for (const listener of this.stateListeners) listener(clone(session))
  }
  publishEvent(event: WireEventInput) {
    for (const listener of this.eventListeners) listener(clone(event))
  }
  finishSwitch(publishState = true) {
    const request = this.switches.find((read) => !read.resolved)
    if (!request) throw new Error('No pending switch')
    const status: AgentStatus = { phase: 'running', cwd }
    for (const listener of this.statusListeners) listener(clone(status))
    if (publishState) this.publishState()
    request.resolved = true
    request.gate.resolve({ cancelled: false })
  }
}

// Manual RAF batches let STATE paint after the hook's real clear but before
// phase-2 cache replay; fake timers never race the 100ms paint fallback.
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
async function paintFrames() {
  for (let paint = 0; paint < 2; paint++) await act(async () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(performance.now()))
  })
}
async function finishPages(api: MemoryApi) {
  for (let n = 0; n < 16; n++) {
    const request = api.pages.find((read) => !read.resolved)
    if (!request) return
    await act(async () => { request.resolved = true; request.gate.resolve(clone(request.page)) })
  }
  throw new Error('Unexpected unbounded history read')
}

async function setup(middle = false) {
  const a = new MemoryBackend(aPath, 'a')
  const b = new MemoryBackend(bPath, 'b')
  if (middle) a.seedMiddleWindow()
  b.turn('b', clock - 10_000)
  const api = new MemoryApi(a, b)
  const actions: Action[] = []
  const hook = renderHook(() => {
    const [state, reduce] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd } })
    const dispatch = useCallback((action: Action) => { actions.push(action); reduce(action) }, [])
    const optimisticSessionTimers = useRef(new Map<string, number>())
    useAgentSubscriptions({ api: api.api, dispatch, projects: state.projects,
      branchesByProject: state.branchesByProject, sessionsByProject: state.sessionsByProject, optimisticSessionTimers })
    const history = useAgentHistory({ api: api.api, state, dispatch })
    return { state, history }
  })
  await act(async () => { api.publishState() })
  if (middle) {
    let jumping!: Promise<void>
    act(() => { jumping = hook.result.current.history.jumpToHistoryLandmark(a.index().landmarks[0]) })
    await finishPages(api)
    await act(async () => { await jumping })
    expect(hook.result.current.history.historyCursor.current).toMatchObject({ newerComplete: false })
  }
  let turn!: ReturnType<MemoryBackend['turn']>
  act(() => { turn = a.turn('first', clock, api) })
  const h = { ...hook, api, a, b, turn, actions }
  expectTurn(h, turn, false)
  expect(h.result.current.history.timelineOwnerPath.current).toBe(aPath)
  expect(h.result.current.history.timelineCache.current.get(aPath)?.items.filter(isMessage)
    .filter((row) => row.liveMessageId === turn.userLiveId || row.liveMessageId === turn.assistantLiveId)
    .map((row) => row.entryId)).toEqual([undefined, undefined])
  return h
}
type Harness = Awaited<ReturnType<typeof setup>>
type Turn = ReturnType<MemoryBackend['turn']>
function isMessage(row: TimelineItem): row is MessageRow { return row.kind === 'user' || row.kind === 'assistant' }
function turnRows(h: Harness, turn: Turn) {
  return h.result.current.state.timeline.filter(isMessage)
    .filter((row) => row.liveMessageId === turn.userLiveId || row.liveMessageId === turn.assistantLiveId)
}
function expectTurn(h: Harness, turn: Turn, persisted: boolean) {
  expect(turnRows(h, turn)).toEqual([
    expect.objectContaining({ kind: 'user', text: prompt, liveMessageId: turn.userLiveId,
      messageTimestamp: turn.user.timestamp, ...(persisted ? { entryId: turn.userEntry.id } : {}) }),
    expect.objectContaining({ kind: 'assistant', text: answer, streaming: false,
      liveMessageId: turn.assistantLiveId, messageTimestamp: turn.assistant.timestamp,
      ...(persisted ? { entryId: turn.assistantEntry.id } : {}) })
  ])
}
function mountedKeys(h: Harness, turn: Turn) { return turnRows(h, turn).map((row) => ({ kind: row.kind, id: row.id })) }
function expectSameNodes(actual: HTMLElement[], expected: HTMLElement[]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((node, i) => { expect(node).toBe(expected[i]) })
}

function timelineView(h: Harness) {
  const props: ChatTimelineProps = {
    scrollRef: createRef<HTMLDivElement>(), onScroll: () => undefined, timeline: [], timelineLoading: false,
    busy: false, starting: false, cwd, hasSessions: true, canFork: false, onFork: () => undefined,
    agentActivity: false, workingStatus: { label: '' }, latestRunChanges: [], runCheckpoint: null,
    rollbackBusy: false, rollbackError: '', onUndo: () => undefined, onReview: () => undefined,
    onSelectChange: () => undefined
  }
  const view = render(<ChatTimeline {...props} />)
  const paint = () => {
    const state = h.result.current.state
    view.rerender(<ChatTimeline {...props} timeline={state.timeline} timelineReady={state.timelineReady}
      timelineLoading={state.timelineLoading} busy={state.busy} />)
  }
  paint()
  const targetNodes = () => [...view.container.querySelectorAll<HTMLElement>('.row-user, .row-assistant')]
    .filter((row) => row.textContent === prompt || row.textContent === answer)
  const expectCount = (turns: number) => {
    expect(view.container.querySelectorAll('.row-user').length).toBe(
      h.result.current.state.timeline.filter((row) => row.kind === 'user').length)
    expect(view.container.querySelectorAll('.row-assistant').length).toBe(
      h.result.current.state.timeline.filter((row) => row.kind === 'assistant').length)
    expect(targetNodes().filter((row) => row.classList.contains('row-user'))).toHaveLength(turns)
    expect(targetNodes().filter((row) => row.classList.contains('row-assistant'))).toHaveLength(turns)
  }
  return { paint, targetNodes, expectCount }
}

function beginSelect(h: Harness, path: string) {
  let selecting!: Promise<{ cancelled: boolean }>
  act(() => { selecting = h.result.current.history.switchSession(path, cwd) })
  expect(h.result.current.state.timeline).toEqual([])
  return selecting
}
async function finishSelection(h: Harness, selecting: Promise<{ cancelled: boolean }>, publishState = true) {
  await act(async () => { h.api.finishSwitch(publishState) })
  await finishPages(h.api)
  await paintFrames()
  await act(async () => { expect(await selecting).toEqual({ cancelled: false }) })
}
async function selectB(h: Harness) {
  const selecting = beginSelect(h, bPath)
  await paintFrames()
  await finishSelection(h, selecting)
  expect(h.result.current.state.session?.sessionFile).toBe(bPath)
}

// These schedules use only switchSession/jump/loadNewer/reloadTimeline and the
// normal IPC subscriptions. To check an older implementation, run this same
// file against that source revision. In particular, the middle-window test
// produces STATE -> replayHistory loadEntries -> appendEntries, unlike the
// switch's newest-window reload which produces a replacement loadEntries.
// A passing current-source run alone is not evidence of an old-source failure.
describe('actual A -> B -> A history hook identity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map(); nextFrame = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrame, callback); return nextFrame
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

  it.each<RestoreOrder>(['STATE before cache', 'cache before STATE'])('restores one turn with disk revalidation and repeat STATE/page: %s', async (order) => {
    const h = await setup()
    const view = timelineView(h)
    await selectB(h)
    const cached = h.result.current.history.timelineCache.current.get(aPath)!
    expect(cached.items.filter(isMessage).map((row) => row.entryId)).toEqual([undefined, undefined])
    const diskBefore = JSON.stringify(h.a.entries)
    const parsed = h.a.parsed.filter((event) => event.type === 'message_start' || event.type === 'message_end')
    expect(messageOf(parsed[0])).not.toBe(messageOf(parsed[1]))
    expect(messageOf(parsed[2])).not.toBe(messageOf(parsed[3]))
    expect(h.a.parsed.some((event) => event.type === 'entry_appended')).toBe(false)
    for (const entry of h.a.entries) {
      expect(entry.message).not.toHaveProperty('_pionLiveMessageId')
      expect(entry.message).not.toHaveProperty('_pionLiveEntryId')
      expect(Date.parse(entry.timestamp)).toBe(Number(entry.message?.timestamp) + 27)
    }
    const offset = h.actions.length
    const selecting = beginSelect(h, aPath)
    if (order === 'STATE before cache') act(() => { h.api.publishState(h.a) })
    if (order === 'cache before STATE') await paintFrames()
    view.paint(); view.expectCount(1)
    const keys = mountedKeys(h, h.turn)
    const nodes = view.targetNodes()
    if (order === 'STATE before cache') await paintFrames()
    else act(() => { h.api.publishState(h.a) })
    view.paint(); view.expectCount(1)
    expect(mountedKeys(h, h.turn)).toEqual(keys)
    expectSameNodes(view.targetNodes(), nodes)
    expectTurn(h, h.turn, false)
    const restore = h.actions.slice(offset).findIndex((action) => action.type === 'loadEntries' && action.replayHistory)
    const hydration = h.actions.slice(offset).findIndex((action) => action.type === 'session')
    expect(restore >= 0 && hydration >= 0).toBe(true)
    expect(order === 'STATE before cache' ? hydration < restore : restore < hydration).toBe(true)
    await finishSelection(h, selecting, false)
    view.paint(); view.expectCount(1)
    expectTurn(h, h.turn, true)
    expect(mountedKeys(h, h.turn)).toEqual(keys)
    expectSameNodes(view.targetNodes(), nodes)
    await act(async () => { h.api.publishState(h.a) })
    let reread!: Promise<void>
    act(() => { reread = h.result.current.history.reloadTimeline(aPath) })
    await finishPages(h.api)
    await act(async () => { await reread })
    view.paint(); view.expectCount(1)
    expectTurn(h, h.turn, true)
    expect(mountedKeys(h, h.turn)).toEqual(keys)
    expectSameNodes(view.targetNodes(), nodes)
    expect(h.result.current.state.timeline).toHaveLength(2)
    expect(JSON.stringify(h.a.entries)).toBe(diskBefore)
    expect(h.api.states.at(-1)).not.toBe(h.api.states.at(-2))
  })

  it.each<RestoreOrder>(['STATE before cache', 'cache before STATE'])('restores the real jumped cursor, then loadNewer attaches disk IDs without extra bubbles: %s', async (order) => {
    const h = await setup(true)
    const view = timelineView(h)
    await selectB(h)
    const cached = h.result.current.history.timelineCache.current.get(aPath)!
    expect(cached.newerComplete).toBe(false)
    expect(cached.apiAfter).toBeLessThan(cached.total)
    const offset = h.actions.length
    const selecting = beginSelect(h, aPath)
    if (order === 'STATE before cache') act(() => { h.api.publishState(h.a) })
    else await paintFrames()
    view.paint(); view.expectCount(1)
    const keys = mountedKeys(h, h.turn)
    const nodes = view.targetNodes()
    if (order === 'STATE before cache') await paintFrames()
    else act(() => { h.api.publishState(h.a) })
    view.paint(); view.expectCount(1)
    expect(mountedKeys(h, h.turn)).toEqual(keys)
    expectSameNodes(view.targetNodes(), nodes)
    expect(h.result.current.history.hasNewerHistory()).toBe(true)
    // Cache is paintable while switch RPC is pending. Outward paging can run
    // here before reloadTimeline resets the cursor for newest-page validation.
    let newer!: Promise<void>
    act(() => { newer = h.result.current.history.loadNewer({ viaScroll: true }) })
    await finishPages(h.api)
    await act(async () => { await newer })
    const schedule = h.actions.slice(offset)
    const stateAt = schedule.findIndex((action) => action.type === 'session')
    const cacheAt = schedule.findIndex((action) => action.type === 'loadEntries' && action.replayHistory)
    const diskAt = schedule.findIndex((action) => action.type === 'appendEntries')
    expect(stateAt).toBeGreaterThanOrEqual(0)
    expect(cacheAt).toBeGreaterThanOrEqual(0)
    expect(order === 'STATE before cache' ? stateAt < cacheAt : cacheAt < stateAt).toBe(true)
    expect(diskAt).toBeGreaterThan(Math.max(stateAt, cacheAt))
    expectTurn(h, h.turn, true)
    view.paint(); view.expectCount(1)
    expect(mountedKeys(h, h.turn)).toEqual(keys)
    expectSameNodes(view.targetNodes(), nodes)
    expect(h.result.current.state.timeline).toHaveLength(3) // anchor + one real turn, never anchor + four copies
    await act(async () => { h.api.publishState(h.a) })
    await finishSelection(h, selecting, false) // newest page repeats the same disk messages
    view.paint(); view.expectCount(1)
    expectTurn(h, h.turn, true)
    expect(mountedKeys(h, h.turn)).toEqual(keys)
    expectSameNodes(view.targetNodes(), nodes)
    // Same-leaf/count validation intentionally keeps the already painted
    // anchor rather than replacing the accepted window a second time.
    expect(h.result.current.state.timeline).toHaveLength(3)
    expect(h.result.current.history.hasNewerHistory()).toBe(false)
    expect(h.a.forwarded.some((event) => event.type === 'entry_appended')).toBe(false)
  })

  it.each([0, 10_000])('keeps a background resend distinct from the already-persisted equal-text turn (SDK clock offset %s)', async (offset) => {
    const h = await setup()
    let read!: Promise<void>
    act(() => { read = h.result.current.history.reloadTimeline(aPath) })
    await finishPages(h.api)
    await act(async () => { await read })
    expectTurn(h, h.turn, true)
    await selectB(h)
    const savedFirstKeys = h.result.current.history.timelineCache.current.get(aPath)!.items.map((row) => row.id)
    const second = h.a.turn('second', clock + offset, h.api) // background: projection records, selected B receives no events
    expect(h.result.current.state.session?.sessionFile).toBe(bPath)
    const selecting = beginSelect(h, aPath)
    act(() => { h.api.publishState(h.a) })
    const secondKeys = mountedKeys(h, second)
    await paintFrames()
    const view = timelineView(h)
    view.expectCount(2)
    const nodes = view.targetNodes()
    expect(mountedKeys(h, h.turn).map((key) => key.id)).toEqual(savedFirstKeys)
    expect(mountedKeys(h, second)).toEqual(secondKeys)
    await finishSelection(h, selecting, false)
    await act(async () => { h.api.publishState(h.a) })
    view.paint(); view.expectCount(2)
    expectTurn(h, h.turn, true)
    expectTurn(h, second, true)
    expect(mountedKeys(h, second)).toEqual(secondKeys)
    expect(mountedKeys(h, h.turn).map((key) => key.id)).toEqual(savedFirstKeys)
    expectSameNodes(view.targetNodes(), nodes)
    expect(h.result.current.state.timeline).toHaveLength(4)
    expect(new Set(h.result.current.state.timeline.filter(isMessage).map((row) => row.entryId)).size).toBe(4)
    expect(second.userLiveId).not.toBe(h.turn.userLiveId)
    expect(second.assistantLiveId).not.toBe(h.turn.assistantLiveId)
  })
})
