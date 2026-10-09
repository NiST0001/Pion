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
import { useHistoryPaging } from '../../src/renderer/src/hooks/useHistoryPaging'
import { ChatTimeline, type ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import { messageText, messageTimestamp, messageToolCalls } from '../../src/shared/types'
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
const completedFinalText = '本轮最终回复已完整结束。已经完成全部九项工具操作，并整理了修改范围、处理结果和后续注意事项。这里是不能在切换会话后丢失的完整最终说明，不是开场白，也不是流式草稿。末尾确认：所有说明到此结束。'
type CompletedCacheCursor = 'live-only cache' | 'pre-final disk cursor' | 'final disk cursor'
type CompletedCacheSize = 'restorable cache' | 'oversized cache'
type MessageRow = Extract<TimelineItem, { kind: 'user' | 'assistant' }>
type MessageEvent = Extract<WireEvent, { type: 'message_start' | 'message_end' }>
type RestoreOrder = 'STATE before cache' | 'cache before STATE'
type LongRestoreOrder = 'STATE before newest page' | 'newest page before STATE'

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

  longTurn(api: MemoryApi) {
    const user: WireMessage = { role: 'user', timestamp: clock, content: [{ type: 'text', text: prompt }] }
    const firstCalls = Array.from({ length: 6 }, (_, i) => ({
      type: 'toolCall', id: `read-${i}`, name: 'read', arguments: { path: `fixture-${i}.ts` }
    }))
    const laterCalls = Array.from({ length: 3 }, (_, i) => ({
      type: 'toolCall', id: `task-${i}`, name: 'pion_task',
      arguments: { action: 'update', id: String(i + 1), status: 'completed' }
    }))
    const assistant: WireMessage = { role: 'assistant', timestamp: clock + 1_000,
      content: [{ type: 'text', text: answer }, ...firstCalls], stopReason: 'toolUse' }
    this.emit({ type: 'agent_start' }, api)
    const userStart = this.emit({ type: 'message_start', message: user }, api)
    this.emit({ type: 'message_end', message: user }, api)
    const userEntry = this.append('long-user', user)
    const assistantStart = this.emit({ type: 'message_start', message: { ...assistant, content: [] } }, api)
    this.emit({ type: 'message_update', usage: null,
      assistantMessageEvent: { type: 'text_delta', delta: answer } }, api)
    this.emit({ type: 'message_end', message: assistant }, api)
    const assistantEntry = this.append('long-opening', assistant)

    const execute = (calls: typeof firstCalls | typeof laterCalls, batch: number) => {
      // One assistant message owns the whole batch. Results and custom SDK
      // metadata consume physical entries, not additional assistant messages.
      for (const call of calls) this.emit({ type: 'tool_execution_start', toolCallId: call.id,
        toolName: call.name, args: call.arguments }, api)
      for (const [i, call] of calls.entries()) {
        const result = { content: [{ type: 'text', text: `synthetic result ${call.id}` }] }
        const isError = call.id === 'read-4' || call.id === 'task-1'
        this.emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name,
          result, isError }, api)
        // Synthetic extension metadata: never smuggle a message entry ID into
        // an RPC event, nor pretend a normal message emitted entry_appended.
        this.entries.push({ type: 'custom', id: `custom-${call.id}`,
          parentId: this.entries.at(-1)?.id ?? null,
          timestamp: new Date(clock + batch * 10_000 + i * 100).toISOString(),
          customType: 'fixture-display-metadata', data: { batch, call: call.id } })
        const message: WireMessage = { role: 'toolResult', toolCallId: call.id,
          toolName: call.name, timestamp: clock + batch * 10_000 + i * 100 + 1,
          ...result, isError }
        this.emit({ type: 'message_start', message }, api)
        this.emit({ type: 'message_end', message }, api)
        this.append(`result-${call.id}`, message)
      }
    }
    execute(firstCalls, 1)
    const later: WireMessage = { role: 'assistant', timestamp: clock + 20_000,
      content: laterCalls, stopReason: 'toolUse' }
    this.emit({ type: 'message_start', message: { ...later, content: [] } }, api)
    this.emit({ type: 'message_end', message: later }, api)
    this.append('long-later-calls', later)
    execute(laterCalls, 3)
    const tail = this.emit({ type: 'message_start', message: {
      role: 'assistant', timestamp: clock + 40_000, content: []
    } }, api)
    this.emit({ type: 'message_update', usage: null,
      assistantMessageEvent: { type: 'text_delta', delta: '仍在继续' } }, api)
    // No agent_end/settled: A remains active while B is selected.
    return { user, assistant, userEntry, assistantEntry,
      userLiveId: messageOf(userStart)._pionLiveMessageId as string,
      assistantLiveId: messageOf(assistantStart)._pionLiveMessageId as string,
      tailLiveId: messageOf(tail)._pionLiveMessageId as string,
      toolCallIds: [...firstCalls, ...laterCalls].map((call) => call.id) }
  }

  finishLongTurn(api: MemoryApi) {
    const message: WireMessage = { role: 'assistant', timestamp: clock + 40_000,
      content: [{ type: 'text', text: completedFinalText }], stopReason: 'stop' }
    // Finish only the actual streaming tail. A normal message_end is parsed
    // independently from its disk append; no synthetic entry_appended or
    // duplicate opening message_end is used to attach a persistent identity.
    const end = this.emit({ type: 'message_end', message }, api)
    const entry = this.append('long-final', message)
    this.emit({ type: 'agent_end', messages: this.entries.flatMap((row) => row.message ? [row.message] : []),
      willRetry: false }, api)
    this.emit({ type: 'agent_settled' }, api)
    return { message, entry, liveId: messageOf(end)._pionLiveMessageId as string }
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
    // Match the bridge's implicit-newest semantics: skip invisible trailing
    // tool results/custom metadata, but retain their physical cursor coverage.
    let sliceEnd = end
    if (before === undefined) {
      while (sliceEnd > 0) {
        const entry = this.entries[sliceEnd - 1]
        const message = entry.message
        if (entry.type === 'message' && (message?.role === 'user'
          || (message?.role === 'assistant' && (messageText(message) !== ''
            || messageToolCalls(message).length > 0)))) break
        sliceEnd--
      }
    }
    const start = Math.max(0, sliceEnd - limit)
    const entries = this.entries.slice(start, sliceEnd)
    const calls = new Set(entries.flatMap((entry) => messageToolCalls(entry.message).map((call) => call.id)))
    const toolResults = this.entries.filter((entry) => entry.message?.role === 'toolResult'
      && calls.has(String(entry.message.toolCallId)))
    return clone({ entries, toolResults, taskSnapshot: [],
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
  deferStateReads = false
  readonly stateReads: { session: SessionInfo; gate: ReturnType<typeof deferred<SessionInfo>> }[] = []
  readonly api: PionApi

  constructor(readonly a: MemoryBackend, readonly b: MemoryBackend) {
    this.selected = a
    const noopSubscription = () => () => undefined
    this.api = {
      getState: vi.fn<PionApi['getState']>(async () => {
        const session = this.selected.session()
        if (!this.deferStateReads) return session
        const request = { session, gate: deferred<SessionInfo>() }
        this.stateReads.push(request)
        return request.gate.promise
      }),
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

async function mountHistory(a: MemoryBackend, b: MemoryBackend) {
  const api = new MemoryApi(a, b)
  const actions: Action[] = []
  const hook = renderHook(() => {
    const [state, reduce] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd } })
    const dispatch = useCallback((action: Action) => { actions.push(action); reduce(action) }, [])
    const optimisticSessionTimers = useRef(new Map<string, number>())
    useAgentSubscriptions({ api: api.api, dispatch, projects: state.projects,
      branchesByProject: state.branchesByProject, sessionsByProject: state.sessionsByProject, optimisticSessionTimers })
    const history = useAgentHistory({ api: api.api, state, dispatch })
    return { state, history, dispatch }
  })
  await act(async () => { api.publishState() })
  return { ...hook, api, a, b, actions }
}

async function setup(middle = false) {
  const a = new MemoryBackend(aPath, 'a')
  const b = new MemoryBackend(bPath, 'b')
  if (middle) a.seedMiddleWindow()
  b.turn('b', clock - 10_000)
  const hook = await mountHistory(a, b)
  const { api, actions } = hook
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
async function setupLongTurn() {
  const a = new MemoryBackend(aPath, 'a')
  const b = new MemoryBackend(bPath, 'b')
  b.turn('b', clock - 10_000)
  const hook = await mountHistory(a, b)
  let turn!: ReturnType<MemoryBackend['longTurn']>
  act(() => { turn = a.longTurn(hook.api) })
  const h = { ...hook, turn }
  expectTurn(h, turn, false)
  expect(h.result.current.state.timeline).toHaveLength(12) // user + opening + 9 tools + streaming tail
  expect(h.result.current.state.busy).toBe(true)
  return h
}

type Harness = Awaited<ReturnType<typeof setup>>
type LongHarness = Awaited<ReturnType<typeof setupLongTurn>>
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
function expectLongTurn(h: LongHarness, tailText: string, persisted: boolean, suffix: string[] = []) {
  const rows = h.result.current.state.timeline
  expect.soft(rows, 'complete long turn, never just the newest page').toHaveLength(12 + suffix.length)
  expect.soft(rows.map((row) => row.kind === 'tool' ? row.tool.id : row.kind === 'compaction' ? row.summary : row.text),
    'whole long turn stays chronological').toEqual([prompt, answer, ...h.turn.toolCallIds, tailText, ...suffix])
  expect.soft(new Set(rows.map((row) => row.id)).size, 'unique mounted React keys').toBe(rows.length)
  expect.soft(turnRows(h, h.turn).map((row) => row.entryId), 'only older paging can attach the missing opening entry IDs')
    .toEqual(persisted ? [h.turn.userEntry.id, h.turn.assistantEntry.id] : [undefined, undefined])
  for (const callId of h.turn.toolCallIds) {
    const isError = callId === 'read-4' || callId === 'task-1'
    expect.soft(rows.filter((row) => row.kind === 'tool' && row.tool.id === callId), `authoritative final for ${callId}`)
      .toEqual([expect.objectContaining({ kind: 'tool', tool: expect.objectContaining({
        id: callId, status: isError ? 'error' : 'done', isError, resultReceived: true,
        outputText: `synthetic result ${callId}`
      }) })])
  }
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
  const keyedNodes = () => {
    const rows = h.result.current.state.timeline
    const nodes = [...view.container.querySelectorAll<HTMLElement>('.timeline > *')]
    expect(nodes, 'one actual DOM row for every timeline row').toHaveLength(rows.length)
    expect(new Set(rows.map((row) => row.id)).size, 'keys cannot collapse in the lookup map').toBe(rows.length)
    const keyed = new Map(rows.map((row, index) => {
      const node = nodes[index]
      expect(node, `mounted row ${row.id}`).toBeDefined()
      expect(node).toBeInstanceOf(HTMLElement)
      expect(node.isConnected, `connected row ${row.id}`).toBe(true)
      return [row.id, node] as const
    }))
    expect(keyed.size).toBe(rows.length)
    expect(new Set(keyed.values()).size).toBe(rows.length)
    return keyed
  }
  const expectPreservedNodes = (previous: Map<number, HTMLElement>) => {
    const current = keyedNodes()
    for (const [id, node] of previous) {
      expect.soft(current.get(id), `mounted row ${id} survives reconciliation`).toBe(node)
      expect.soft(node.isConnected, `previous row ${id} remains connected`).toBe(true)
    }
    return current
  }
  return { paint, targetNodes, expectCount, keyedNodes, expectPreservedNodes, scrollRef: props.scrollRef }
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

  it.each<LongRestoreOrder>(['STATE before newest page', 'newest page before STATE'])(
    'long active turn older paging preserves one opening, full tool order and mounted identity: %s', async (order) => {
      const h = await setupLongTurn()
      const view = timelineView(h)
      const diskBefore = JSON.stringify(h.a.entries)
      const pageSize = getViewportHistoryPageSize()
      expect(h.a.entries.length).toBeGreaterThan(pageSize)
      expect(messageToolCalls(h.turn.assistant)).toHaveLength(6)
      expect(messageToolCalls(h.a.entries.find((entry) => entry.id === 'long-later-calls')?.message)).toHaveLength(3)
      expect(h.a.entries.filter((entry) => entry.type === 'custom')).toHaveLength(9)
      expect(h.a.parsed.some((event) => event.type === 'entry_appended')).toBe(false)
      const starts = h.a.parsed.filter((event) => event.type === 'message_start')
      const ends = h.a.parsed.filter((event) => event.type === 'message_end')
      expect(messageOf(starts[0])).not.toBe(messageOf(ends[0]))
      expect(messageOf(starts[1])).not.toBe(messageOf(ends[1]))
      for (const entry of h.a.entries.filter((entry) => entry.type === 'message')) {
        expect(entry.message).not.toHaveProperty('_pionLiveMessageId')
        expect(entry.message).not.toHaveProperty('_pionLiveEntryId')
        expect(Date.parse(entry.timestamp)).toBe(Number(entry.message?.timestamp) + 27)
      }
      await selectB(h)
      view.paint()
      // There really is a long live cache. The production switch decides if
      // it can replay it; this fixture never edits cache/cursor ownership.
      const cachedLong = h.result.current.history.timelineCache.current.get(aPath)!
      expect(cachedLong.items).toHaveLength(12)
      expect(cachedLong.items.length).toBeGreaterThan(pageSize)
      act(() => { h.a.emit({ type: 'message_update', usage: null,
        assistantMessageEvent: { type: 'text_delta', delta: '，后台更新' } }, h.api) })
      expect(h.result.current.state.session?.sessionFile).toBe(bPath)

      h.api.deferStateReads = true
      const switchOffset = h.actions.length
      const selecting = beginSelect(h, aPath)
      // The real switch discards oversized cache; no fixture-side deletion or
      // replayHistory action may make this a small-cache restoration test.
      expect(h.result.current.history.timelineCache.current.has(aPath)).toBe(false)
      view.paint()
      await paintFrames()
      expect(h.result.current.state.timeline).toEqual([])
      expect(h.actions.slice(switchOffset).filter((action) => action.type === 'loadEntries' && action.replayHistory)).toEqual([])
      await act(async () => { h.api.finishSwitch(false) })
      const read = h.api.pages.find((request) => request.path === aPath && !request.resolved)!
      const stateRead = h.api.stateReads.at(-1)!
      expect(read).toBeDefined()
      expect(stateRead).toBeDefined()
      expect(read.before).toBeUndefined()
      expect(read.limit).toBe(pageSize)
      expect(read.page.entries).toHaveLength(pageSize)
      expect(read.page.start).toBeGreaterThan(1)
      expect(read.page.end).toBe(h.a.entries.length)
      expect(read.page.entries.map((entry) => entry.id)).not.toContain(h.turn.userEntry.id)
      expect(read.page.entries.map((entry) => entry.id)).not.toContain(h.turn.assistantEntry.id)
      const actionOffset = h.actions.length
      const deliverState = async () => {
        await act(async () => {
          h.api.publishState(h.a)
          stateRead.gate.resolve(clone(stateRead.session))
        })
      }
      if (order === 'STATE before newest page') {
        await deliverState()
      } else {
        await finishPages(h.api)
        view.paint() // Paint the disk page BEFORE STATE, not just after both.
        expect(h.result.current.state.timeline.map((row) => row.kind === 'tool' ? row.tool.id : row.kind))
          .toEqual(['task-0', 'task-1', 'task-2'])
        const newestPageNodes = view.keyedNodes()
        expect(newestPageNodes.size).toBe(3)
        await deliverState()
        view.paint()
        view.expectPreservedNodes(newestPageNodes)
      }
      view.paint()
      expectLongTurn(h, '仍在继续，后台更新', false)
      const mounted = view.keyedNodes()
      expect(mounted.size).toBe(12)
      const openingKeys = mountedKeys(h, h.turn)
      const openingNodes = view.targetNodes()
      const toolKeys = new Map(h.result.current.state.timeline.flatMap((row) => row.kind === 'tool'
        ? [[row.tool.id, row.id] as const] : []))
      expect(openingNodes).toHaveLength(2)
      if (order === 'STATE before newest page') await finishPages(h.api)
      await paintFrames()
      await act(async () => { expect(await selecting).toEqual({ cancelled: false }) })
      view.paint()
      // Both STATE -> page and page -> STATE must already be complete and
      // ordered before older paging has any opportunity to repair the rows.
      expectLongTurn(h, '仍在继续，后台更新', false)
      view.expectPreservedNodes(mounted)
      const switchActions = h.actions.slice(switchOffset)
      expect(switchActions.filter((action) => action.type === 'loadEntries' && action.replayHistory)).toEqual([])
      expect(switchActions.some((action) => action.type === 'loadEntries' && action.items === cachedLong.items)).toBe(false)
      expect(h.result.current.history.timelineCache.current.get(aPath)).not.toBe(cachedLong)
      const schedule = h.actions.slice(actionOffset)
      const stateAt = schedule.findIndex((action) => action.type === 'session')
      const pageAt = schedule.findIndex((action) => action.type === 'loadEntries' && !action.replayHistory)
      expect(stateAt).toBeGreaterThanOrEqual(0)
      expect(pageAt).toBeGreaterThanOrEqual(0)
      expect(order === 'STATE before newest page' ? stateAt < pageAt : pageAt < stateAt).toBe(true)
      expect(h.result.current.history.historyCursor.current?.apiBefore).toBe(read.page.start)
      expect(h.result.current.history.historyCursor.current?.complete).toBe(false)

      const pageOffset = h.api.pages.length
      const olderOffset = h.actions.length
      let older!: Promise<void>
      act(() => { older = h.result.current.history.loadOlder({ viaScroll: true }) })
      await finishPages(h.api)
      await act(async () => { await older })
      view.paint()
      expect(h.api.pages[pageOffset]).toMatchObject({ path: aPath, before: read.page.start, limit: pageSize })
      expect(h.api.pages[pageOffset].page.entries.map((entry) => entry.id)).toContain(h.turn.userEntry.id)
      expect(h.api.pages[pageOffset].page.entries.map((entry) => entry.id)).toContain(h.turn.assistantEntry.id)
      const prepends = h.actions.slice(olderOffset).filter((action): action is Extract<Action, { type: 'prependEntries' }> => action.type === 'prependEntries')
      expect(prepends).toHaveLength(1)
      expect(prepends[0].items.filter(isMessage).map((row) => row.entryId))
        .toEqual([h.turn.userEntry.id, h.turn.assistantEntry.id])
      expect(h.result.current.history.historyCursor.current).toBeNull()

      // Soft assertions collect independent failures without dropping any
      // requirements; structural DOM/key guards remain hard assertions.
      expectLongTurn(h, '仍在继续，后台更新', true)
      const rows = h.result.current.state.timeline
      expect.soft(rows.filter((row) => row.kind === 'user' && row.text === prompt), 'one user opening after loadOlder').toHaveLength(1)
      expect.soft(rows.filter((row) => row.kind === 'assistant' && row.text === answer), 'one assistant opening after loadOlder').toHaveLength(1)
      expect.soft(turnRows(h, h.turn).map((row) => row.entryId), 'older disk page attaches IDs to the mounted live opening')
        .toEqual([h.turn.userEntry.id, h.turn.assistantEntry.id])
      expect.soft(rows.filter((row) => row.kind === 'tool').map((row) => row.tool.id), 'all nine tool calls retain physical batch order')
        .toEqual(h.turn.toolCallIds)
      expect.soft(rows.map((row) => row.kind === 'tool' ? row.tool.id : row.kind === 'compaction' ? row.summary : row.text), 'whole turn remains in chronological order')
        .toEqual([prompt, answer, ...h.turn.toolCallIds, '仍在继续，后台更新'])
      expect.soft(mountedKeys(h, h.turn)).toEqual(openingKeys)
      const currentNodes = view.expectPreservedNodes(mounted)
      for (const [callId, id] of toolKeys) {
        const isError = callId === 'read-4' || callId === 'task-1'
        const matches = rows.filter((row) => row.kind === 'tool' && row.tool.id === callId)
        expect.soft(matches, `call ID ${callId} has exactly one row`).toHaveLength(1)
        expect.soft(matches[0]).toMatchObject({ id, kind: 'tool', tool: { id: callId,
          status: isError ? 'error' : 'done', isError, resultReceived: true, outputText: `synthetic result ${callId}` } })
      }
      for (const [index, entryId] of [h.turn.userEntry.id, h.turn.assistantEntry.id].entries()) {
        const persisted = rows.find((row) => isMessage(row) && row.entryId === entryId)
        expect.soft(persisted && currentNodes.get(persisted.id), `persisted ${entryId} owns the already mounted DOM`).toBe(openingNodes[index])
      }
      expect.soft(view.targetNodes().filter((node) => node.classList.contains('row-user')), 'one mounted user bubble').toHaveLength(1)
      expect.soft(view.targetNodes().filter((node) => node.classList.contains('row-assistant')), 'one mounted opening assistant bubble').toHaveLength(1)

      // Replay the actual hook-produced action at the reducer boundary. This
      // is action idempotence, NOT another page fetch via an already-null cursor.
      const beforeReplay = clone(h.result.current.state.timeline)
      const readsBeforeReplay = h.api.pages.length
      for (let replay = 0; replay < 2; replay++) {
        act(() => { h.result.current.dispatch(clone(prepends[0])) })
        view.paint()
        expect.soft(h.result.current.state.timeline, 'captured prependEntries action replay is idempotent').toEqual(beforeReplay)
        expectLongTurn(h, '仍在继续，后台更新', true)
        view.expectPreservedNodes(currentNodes)
      }
      expect(h.api.pages).toHaveLength(readsBeforeReplay)
      expect(h.result.current.history.historyCursor.current).toBeNull()

      for (let repeat = 0; repeat < 2; repeat++) {
        act(() => { h.api.publishState(h.a) })
        view.paint()
        expectLongTurn(h, '仍在继续，后台更新', true)
        expect.soft(mountedKeys(h, h.turn)).toEqual(openingKeys)
        view.expectPreservedNodes(currentNodes)
      }
      expect(h.api.states.at(-1)).not.toBe(h.api.states.at(-2))
      expect(h.api.states.at(-1)?.liveState?.revision).toBe(h.api.states.at(-2)?.liveState?.revision)
      const tailBefore = rows.find((row) => row.kind === 'assistant' && row.liveMessageId === h.turn.tailLiveId)!
      expect(tailBefore).toMatchObject({ kind: 'assistant', streaming: true, text: '仍在继续，后台更新' })
      act(() => { h.a.emit({ type: 'message_update', usage: null,
        assistantMessageEvent: { type: 'text_delta', delta: '，切回继续' } }, h.api) })
      view.paint()
      const tailAfter = h.result.current.state.timeline.filter((row) => row.kind === 'assistant'
        && row.liveMessageId === h.turn.tailLiveId)
      expect(tailAfter).toEqual([expect.objectContaining({ id: tailBefore.id,
        streaming: true, text: '仍在继续，后台更新，切回继续' })])
      expect(view.keyedNodes().get(tailBefore.id)).toBe(currentNodes.get(tailBefore.id))
      expectLongTurn(h, '仍在继续，后台更新，切回继续', true)
      expect(JSON.stringify(h.a.entries)).toBe(diskBefore)

      // Simulate missed IPC deliveries while the backend continues normally.
      // STATE must insert new rows, not merely refresh the existing tail. Only
      // the current tail ends here; the opening's original end is NEVER resent.
      const tailText = '仍在继续，后台更新，切回继续'
      const nextCall = { type: 'toolCall', id: 'next-read', name: 'read', arguments: { path: 'next.ts' } }
      const completedTail: WireMessage = { role: 'assistant', timestamp: clock + 40_000,
        content: [{ type: 'text', text: tailText }, nextCall], stopReason: 'toolUse' }
      h.a.emit({ type: 'message_end', message: completedTail })
      h.a.append('long-tail', completedTail)
      h.a.emit({ type: 'tool_execution_start', toolCallId: nextCall.id, toolName: nextCall.name, args: nextCall.arguments })
      const nextResult = { content: [{ type: 'text', text: 'synthetic result next-read' }] }
      h.a.emit({ type: 'tool_execution_end', toolCallId: nextCall.id, toolName: nextCall.name, result: nextResult, isError: true })
      const resultMessage: WireMessage = { role: 'toolResult', timestamp: clock + 50_000,
        toolCallId: nextCall.id, toolName: nextCall.name, ...nextResult, isError: true }
      h.a.emit({ type: 'message_start', message: resultMessage })
      h.a.emit({ type: 'message_end', message: resultMessage })
      h.a.append('result-next-read', resultMessage)
      const beforeGrowthRevision = h.api.states.at(-1)?.liveState?.revision
      act(() => { h.api.publishState(h.a) })
      view.paint()
      expect(h.api.states.at(-1)?.liveState?.revision).toBeGreaterThan(beforeGrowthRevision!)
      expectLongTurn(h, tailText, true, ['next-read'])
      const withNewTool = view.expectPreservedNodes(currentNodes)
      expect(withNewTool.size).toBe(13)
      const nextTool = h.result.current.state.timeline.find((row) => row.kind === 'tool' && row.tool.id === nextCall.id)!
      expect(nextTool).toMatchObject({ kind: 'tool', tool: { id: nextCall.id, resultReceived: true,
        status: 'error', isError: true, outputText: 'synthetic result next-read' } })

      const nextAssistant = h.a.emit({ type: 'message_start', message: {
        role: 'assistant', timestamp: clock + 60_000, content: []
      } })
      h.a.emit({ type: 'message_update', usage: null,
        assistantMessageEvent: { type: 'text_delta', delta: '下一条助手消息' } })
      act(() => { h.api.publishState(h.a) })
      view.paint()
      expectLongTurn(h, tailText, true, ['next-read', '下一条助手消息'])
      const withNewAssistant = view.expectPreservedNodes(withNewTool)
      expect(withNewAssistant.size).toBe(14)
      expect(h.result.current.state.timeline.at(-1)).toMatchObject({ kind: 'assistant', streaming: true,
        text: '下一条助手消息', liveMessageId: messageOf(nextAssistant)._pionLiveMessageId })
      expect(h.result.current.state.timeline.find((row) => row.id === tailBefore.id))
        .toMatchObject({ kind: 'assistant', text: tailText, streaming: false })
      for (let repeat = 0; repeat < 2; repeat++) {
        act(() => { h.api.publishState(h.a) })
        // Replaying the old physical page must also retain subsequently added
        // snapshot rows, their chronological positions, and final tool output.
        act(() => { h.result.current.dispatch(clone(prepends[0])) })
        view.paint()
        expectLongTurn(h, tailText, true, ['next-read', '下一条助手消息'])
        view.expectPreservedNodes(withNewAssistant)
        expect(h.result.current.state.timeline.find((row) => row.id === nextTool.id)).toEqual(nextTool)
      }
      expect(h.api.pages).toHaveLength(readsBeforeReplay)
      expect(h.a.parsed.some((event) => event.type === 'entry_appended')).toBe(false)
      expect(h.a.parsed.filter((event) => event.type === 'message_end'
        && messageOf(event).role === 'assistant' && messageOf(event).timestamp === h.turn.assistant.timestamp)).toHaveLength(1)
      expect(JSON.stringify(h.a.entries.slice(0, -2))).toBe(diskBefore)
    }
  )

  it.each<{
    cacheSize: CompletedCacheSize; cursor: CompletedCacheCursor; order: LongRestoreOrder
  }>(['restorable cache', 'oversized cache'].flatMap((cacheSize) =>
    ['live-only cache', 'pre-final disk cursor', 'final disk cursor'].flatMap((cursor) =>
      ['STATE before newest page', 'newest page before STATE'].map((order) => ({
        cacheSize: cacheSize as CompletedCacheSize, cursor: cursor as CompletedCacheCursor,
        order: order as LongRestoreOrder
      })))))('completed long final survives A -> B -> A: $cacheSize / $cursor / $order', async ({ cacheSize, cursor, order }) => {
    // A real viewport-sized policy decides whether twelve visible rows fit in
    // cache. Both sizes still require a bounded physical disk page (22 entries).
    // No cache deletion, hand-edited cursor, or artificial loadEntries action.
    const height = Object.getOwnPropertyDescriptor(window, 'innerHeight')!
    Object.defineProperty(window, 'innerHeight', { configurable: true,
      value: cacheSize === 'restorable cache' ? 960 : 768 })
    try {
      const h = await setupLongTurn()
      const pageSize = getViewportHistoryPageSize()
      expect(pageSize).toBe(cacheSize === 'restorable cache' ? 12 : 10)
      const readLatest = async () => {
        let reading!: Promise<void>
        act(() => { reading = h.result.current.history.reloadTimeline(aPath) })
        await finishPages(h.api)
        await act(async () => { await reading })
      }
      // This is a legitimately stale *cursor*: a disk request made and accepted
      // while the final is still streaming. Completion later updates cached
      // rows normally, but cannot retroactively change that page's leaf/count.
      if (cursor === 'pre-final disk cursor') await readLatest()
      let final!: ReturnType<MemoryBackend['finishLongTurn']>
      act(() => { final = h.a.finishLongTurn(h.api) })
      expect(final.liveId).toBe(h.turn.tailLiveId)
      expect(h.a.parsed.slice(-3).map((event) => event.type))
        .toEqual(['message_end', 'agent_end', 'agent_settled'])
      expect(h.a.streaming).toBe(false)
      expect(h.result.current.state.busy).toBe(false)
      expect(h.result.current.state.timeline.filter((row) => row.kind === 'assistant' && row.streaming)).toEqual([])
      if (cursor === 'final disk cursor') await readLatest()
      const view = timelineView(h)
      const finalRow = () => h.result.current.state.timeline.filter((row): row is Extract<TimelineItem, { kind: 'assistant' }> =>
        row.kind === 'assistant' && (row.liveMessageId === final.liveId || row.entryId === final.entry.id
          || row.text === completedFinalText))
      const expectFinal = (persisted: boolean) => {
        view.paint()
        const rows = finalRow()
        expect(rows, 'exactly one complete final reply, not merely its opening or a suffix').toHaveLength(1)
        expect(rows[0]).toMatchObject({ kind: 'assistant', text: completedFinalText, streaming: false,
          messageTimestamp: final.message.timestamp, ...(persisted ? { entryId: final.entry.id } : {}) })
        const keyed = view.keyedNodes()
        const node = keyed.get(rows[0].id)!
        expect(node.textContent, 'the mounted final bubble contains every character').toBe(completedFinalText)
        expect(node).toHaveClass('row-assistant')
        expect(node.isConnected).toBe(true)
        // Presence alone misses a reply moved above restored early tools:
        // an otherwise idle completed turn must still END with its final.
        expect(h.result.current.state.timeline.at(-1)?.id, 'completed final remains at the end of the display order').toBe(rows[0].id)
        expect(node.parentElement?.lastElementChild, 'completed final remains the last mounted timeline row').toBe(node)
        return { row: rows[0], node }
      }
      const beforeSwitch = expectFinal(cursor === 'final disk cursor')
      expect(h.a.entries).toHaveLength(22)
      expect(h.a.entries.at(-1)).toEqual(final.entry)
      const diskBefore = JSON.stringify(h.a.entries)
      await selectB(h) // The entire final reply was already visible and settled before leaving A.
      view.paint()
      expect(beforeSwitch.node.isConnected).toBe(false)
      const cached = h.result.current.history.timelineCache.current.get(aPath)!
      expect(cached.items).toHaveLength(12)
      expect(cached.items.filter((row) => row.kind === 'assistant' && row.liveMessageId === final.liveId))
        .toEqual([expect.objectContaining({ text: completedFinalText, streaming: false })])
      expect(cached.total).toBe(cursor === 'live-only cache' ? 0 : cursor === 'pre-final disk cursor' ? 21 : 22)
      expect(cached.leafId).toBe(cursor === 'live-only cache' ? null
        : cursor === 'pre-final disk cursor' ? 'result-task-2' : final.entry.id)
      expect(cached.items.length <= pageSize).toBe(cacheSize === 'restorable cache')

      h.api.deferStateReads = true
      const switchOffset = h.actions.length
      const pagesBefore = h.api.pages.length
      const stateCallsBefore = vi.mocked(h.api.api.getState).mock.calls.length
      const selecting = beginSelect(h, aPath)
      expect(h.result.current.history.timelineCache.current.has(aPath)).toBe(cacheSize === 'restorable cache')
      await paintFrames()
      let mounted: ReturnType<typeof expectFinal> | undefined
      if (cacheSize === 'restorable cache') {
        mounted = expectFinal(cursor === 'final disk cursor')
        expect(mounted.row.id, 'bounded cache keeps its original React key').toBe(beforeSwitch.row.id)
      } else {
        expect(h.result.current.state.timeline).toEqual([])
      }
      expect(h.api.switches.at(-1)).toMatchObject({ path: aPath, resolved: false })
      // Let the actual switch await finish, then observe the hook's parallel
      // getState and newest-page RPCs, rather than injecting reducer actions.
      await act(async () => { h.api.finishSwitch(false) })
      expect(h.api.switches.at(-1)).toMatchObject({ path: aPath, resolved: true })
      expect(vi.mocked(h.api.api.getState).mock.calls.length).toBe(stateCallsBefore + 1)
      expect(h.api.pages).toHaveLength(pagesBefore + 1)
      const read = h.api.pages[pagesBefore]
      const stateRead = h.api.stateReads.at(-1)!
      expect(read).toMatchObject({ path: aPath, before: undefined, limit: pageSize,
        page: { start: 22 - pageSize, end: 22, total: 22, leafId: final.entry.id } })
      expect(read.page.entries).toEqual(h.a.entries.slice(22 - pageSize, 22))
      expect(read.page.entries.at(-1)).toEqual(final.entry)
      expect(read.page.entries.at(-1)).not.toBe(final.entry)
      expect(read.page.entries.at(-1)?.message).not.toBe(final.message)
      expect(stateRead.session).toMatchObject({ sessionFile: aPath, isStreaming: false,
        liveState: { backendId: h.a.projection.backendId, revision: h.a.projection.revision } })
      expect(stateRead.session.liveState?.events.filter((event) => event.type === 'message_end'
        && messageText(messageOf(event)) === completedFinalText)).toHaveLength(1)
      const assertPreserved = (persisted: boolean) => {
        const current = expectFinal(persisted)
        if (mounted) {
          expect(current.row.id, 'the next data source cannot replace the final React key').toBe(mounted.row.id)
          expect(current.node, 'the next data source cannot unmount the final bubble').toBe(mounted.node)
          expect(mounted.node.isConnected).toBe(true)
        }
        mounted = current
      }
      const deliverState = async () => {
        await act(async () => {
          h.api.publishState(h.a)
          stateRead.gate.resolve(clone(stateRead.session))
        })
      }
      const dataOffset = h.actions.length
      if (order === 'STATE before newest page') {
        await deliverState()
        assertPreserved(cacheSize === 'restorable cache' && cursor === 'final disk cursor')
        await finishPages(h.api)
        assertPreserved(true)
      } else {
        await finishPages(h.api)
        assertPreserved(true)
        // refreshLive is intentionally fire-and-forget. A slow getState/STATE
        // may arrive only after the switch itself has resolved and painted.
        await paintFrames()
        await act(async () => { expect(await selecting).toEqual({ cancelled: false }) })
        assertPreserved(true)
        await deliverState()
        assertPreserved(true)
      }
      await paintFrames()
      await act(async () => { expect(await selecting).toEqual({ cancelled: false }) })
      assertPreserved(true)
      expect(mounted!.row.liveMessageId).toBe(final.liveId)
      expect(h.result.current.state.busy).toBe(false)
      expect(h.result.current.state.session?.isStreaming).toBe(false)
      expect(h.result.current.state.timelineLoading).toBe(false)
      expect(h.result.current.history.historyCursor.current).toMatchObject({
        path: aPath, apiBefore: 22 - pageSize, apiAfter: 22, total: 22, newerComplete: true })
      const switched = h.actions.slice(switchOffset)
      expect(switched.filter((action) => action.type === 'loadEntries' && action.replayHistory))
        .toHaveLength(cacheSize === 'restorable cache' ? 1 : 0)
      const data = h.actions.slice(dataOffset)
      const stateAt = data.findIndex((action) => action.type === 'session')
      const pageAt = data.findIndex((action) => action.type === 'loadEntries' && !action.replayHistory)
      expect(stateAt).toBeGreaterThanOrEqual(0)
      if (cacheSize === 'restorable cache' && cursor === 'final disk cursor') {
        // Same disk leaf/count is a real no-op revalidation, not a fabricated
        // replacement snapshot. Both RPCs still completed above.
        expect(pageAt).toBe(-1)
      } else {
        expect(pageAt).toBeGreaterThanOrEqual(0)
        expect(order === 'STATE before newest page' ? stateAt < pageAt : pageAt < stateAt).toBe(true)
      }
      expect(h.api.pages.slice(pagesBefore).every((request) => request.resolved)).toBe(true)
      for (let repeat = 0; repeat < 2; repeat++) {
        await act(async () => { h.api.publishState(h.a) })
        assertPreserved(true)
        await readLatest()
        assertPreserved(true)
      }
      expect(h.api.pages).toHaveLength(pagesBefore + 3)
      expect(h.api.states.at(-1)).not.toBe(h.api.states.at(-2))
      expect(h.a.parsed.some((event) => event.type === 'entry_appended')).toBe(false)
      for (const timestamp of [h.turn.assistant.timestamp, final.message.timestamp]) {
        expect(h.a.parsed.filter((event) => event.type === 'message_end'
          && messageOf(event).role === 'assistant' && messageOf(event).timestamp === timestamp)).toHaveLength(1)
      }
      expect(JSON.stringify(h.a.entries)).toBe(diskBefore)
    } finally {
      Object.defineProperty(window, 'innerHeight', height)
    }
  })

  it.each<{
    cacheSize: CompletedCacheSize; order: LongRestoreOrder
  }>(['restorable cache', 'oversized cache'].flatMap((cacheSize) =>
    ['STATE before newest page', 'newest page before STATE'].map((order) => ({
      cacheSize: cacheSize as CompletedCacheSize, order: order as LongRestoreOrder
    }))))('completed long final replaces a legitimately older streaming cache: $cacheSize / $order', async ({ cacheSize, order }) => {
    // Separate from the completed-before-leaving cases above: A really finishes
    // while B is selected. This creates an old draft cache through the public
    // hooks instead of inventing contradictory cache/page/projection payloads.
    const height = Object.getOwnPropertyDescriptor(window, 'innerHeight')!
    Object.defineProperty(window, 'innerHeight', { configurable: true,
      value: cacheSize === 'restorable cache' ? 960 : 768 })
    try {
      const h = await setupLongTurn()
      const view = timelineView(h)
      await selectB(h)
      view.paint()
      const cached = h.result.current.history.timelineCache.current.get(aPath)!
      const cachedTail = cached.items.find((row) => row.kind === 'assistant' && row.liveMessageId === h.turn.tailLiveId)!
      expect(cachedTail).toMatchObject({ kind: 'assistant', text: '仍在继续', streaming: true })
      let final!: ReturnType<MemoryBackend['finishLongTurn']>
      act(() => { final = h.a.finishLongTurn(h.api) })
      expect(h.result.current.state.session?.sessionFile).toBe(bPath)
      expect(h.a.streaming).toBe(false)
      expect(h.a.entries.at(-1)).toEqual(final.entry)
      expect(h.result.current.history.timelineCache.current.get(aPath)).toBe(cached)
      expect(cachedTail).toMatchObject({ text: '仍在继续', streaming: true })
      const diskBefore = JSON.stringify(h.a.entries)
      h.api.deferStateReads = true
      const pagesBefore = h.api.pages.length
      const stateCallsBefore = vi.mocked(h.api.api.getState).mock.calls.length
      const switchOffset = h.actions.length
      const selecting = beginSelect(h, aPath)
      await paintFrames()
      view.paint()
      let mounted: { id: number; node: HTMLElement } | undefined
      if (cacheSize === 'restorable cache') {
        const draft = h.result.current.state.timeline.find((row) => row.id === cachedTail.id)!
        expect(draft).toMatchObject({ kind: 'assistant', text: '仍在继续', streaming: true })
        mounted = { id: draft.id, node: view.keyedNodes().get(draft.id)! }
      } else {
        expect(h.result.current.state.timeline).toEqual([])
      }
      await act(async () => { h.api.finishSwitch(false) })
      expect(h.api.switches.at(-1)).toMatchObject({ path: aPath, resolved: true })
      expect(vi.mocked(h.api.api.getState).mock.calls.length).toBe(stateCallsBefore + 1)
      expect(h.api.pages).toHaveLength(pagesBefore + 1)
      const read = h.api.pages[pagesBefore]
      const stateRead = h.api.stateReads.at(-1)!
      expect(read).toMatchObject({ path: aPath, before: undefined, limit: getViewportHistoryPageSize(),
        page: { start: 22 - getViewportHistoryPageSize(), end: 22, total: 22 } })
      expect(read.page.entries).toEqual(h.a.entries.slice(read.page.start, 22))
      expect(read.page.entries.at(-1)).toEqual(final.entry)
      expect(read.page.entries.at(-1)).not.toBe(final.entry)
      expect(stateRead.session.isStreaming).toBe(false)
      const assertFinal = (persisted: boolean) => {
        view.paint()
        const rows = h.result.current.state.timeline.filter((row) => row.kind === 'assistant'
          && (row.liveMessageId === final.liveId || row.entryId === final.entry.id || row.text === completedFinalText))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ kind: 'assistant', text: completedFinalText, streaming: false,
          ...(persisted ? { entryId: final.entry.id } : {}) })
        const node = view.keyedNodes().get(rows[0].id)!
        expect(node.textContent).toBe(completedFinalText)
        expect(node).toHaveClass('row-assistant')
        expect(node.isConnected).toBe(true)
        expect(h.result.current.state.timeline.at(-1)?.id, 'completed final remains at the end after a stale cache restore').toBe(rows[0].id)
        expect(node.parentElement?.lastElementChild, 'completed final remains the last mounted timeline row').toBe(node)
        if (mounted) {
          expect(rows[0].id).toBe(mounted.id)
          expect(node).toBe(mounted.node)
          expect(mounted.node.isConnected).toBe(true)
        }
        mounted = { id: rows[0].id, node }
      }
      const deliverState = async () => {
        await act(async () => {
          h.api.publishState(h.a)
          stateRead.gate.resolve(clone(stateRead.session))
        })
      }
      if (order === 'STATE before newest page') {
        await deliverState()
        assertFinal(false)
        await finishPages(h.api)
        assertFinal(true)
      } else {
        await finishPages(h.api)
        assertFinal(true)
        await paintFrames()
        await act(async () => { expect(await selecting).toEqual({ cancelled: false }) })
        await deliverState()
        assertFinal(true)
      }
      await paintFrames()
      await act(async () => { expect(await selecting).toEqual({ cancelled: false }) })
      assertFinal(true)
      expect(h.result.current.state.busy).toBe(false)
      const switched = h.actions.slice(switchOffset)
      expect(switched.filter((action) => action.type === 'loadEntries' && action.replayHistory))
        .toHaveLength(cacheSize === 'restorable cache' ? 1 : 0)
      const stateAt = switched.findIndex((action) => action.type === 'session')
      const pageAt = switched.findIndex((action) => action.type === 'loadEntries' && !action.replayHistory)
      expect(stateAt).toBeGreaterThanOrEqual(0)
      expect(pageAt).toBeGreaterThanOrEqual(0)
      expect(order === 'STATE before newest page' ? stateAt < pageAt : pageAt < stateAt).toBe(true)
      // Once the final is mounted, neither repeated STATE nor the hook's real
      // same-leaf disk revalidation may resurrect the old cached draft.
      await act(async () => { h.api.publishState(h.a) })
      assertFinal(true)
      let reload!: Promise<void>
      act(() => { reload = h.result.current.history.reloadTimeline(aPath) })
      await finishPages(h.api)
      await act(async () => { await reload })
      assertFinal(true)
      expect(h.api.pages).toHaveLength(pagesBefore + 2)
      expect(h.a.parsed.slice(-3).map((event) => event.type)).toEqual(['message_end', 'agent_end', 'agent_settled'])
      expect(h.a.parsed.some((event) => event.type === 'entry_appended')).toBe(false)
      expect(JSON.stringify(h.a.entries)).toBe(diskBefore)
    } finally {
      Object.defineProperty(window, 'innerHeight', height)
    }
  })

  it('long active turn viewport fill invokes real older paging without duplicating the opening', async () => {
    const h = await setupLongTurn()
    await selectB(h)
    const selecting = beginSelect(h, aPath)
    await paintFrames()
    await finishSelection(h, selecting)
    const view = timelineView(h)
    const before = h.result.current.history.historyCursor.current!.apiBefore
    const mounted = view.keyedNodes()
    expect(before).toBeGreaterThan(1)
    expectLongTurn(h, '仍在继续', false)
    expect(view.targetNodes()).toHaveLength(2)
    // jsdom has no layout. Give the actual ChatTimeline scroll element a
    // non-scrolling viewport; the hook's public effect must choose older.
    Object.defineProperties(view.scrollRef.current!, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 400 }
    })
    const loadOlder = vi.fn((options?: { viaScroll?: boolean }) => h.result.current.history.loadOlder(options))
    const loadNewer = vi.fn((options?: { viaScroll?: boolean }) => h.result.current.history.loadNewer(options))
    const pageOffset = h.api.pages.length
    const paging = renderHook(({ length }) => useHistoryPaging({ scrollRef: view.scrollRef,
      owner: `${cwd}:${aPath}:${h.result.current.state.timelineScopeRevision}`,
      timelineLength: length, loadOlder, loadNewer
    }), { initialProps: { length: h.result.current.state.timeline.length } })
    // No private fill function, wheel, or manually dispatched prepend action.
    expect(loadOlder).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(h.api.pages[pageOffset]).toMatchObject({ path: aPath, before, limit: getViewportHistoryPageSize() })
    await finishPages(h.api)
    await act(async () => { paging.rerender({ length: h.result.current.state.timeline.length }) })
    view.paint()
    expect(h.api.pages.slice(pageOffset)).toHaveLength(1)
    expect(h.result.current.history.historyCursor.current).toBeNull()
    const rows = h.result.current.state.timeline
    expect.soft(rows.filter((row) => row.kind === 'user' && row.text === prompt), 'viewport fill keeps one user opening').toHaveLength(1)
    expect.soft(rows.filter((row) => row.kind === 'assistant' && row.text === answer), 'viewport fill keeps one assistant opening').toHaveLength(1)
    expect.soft(turnRows(h, h.turn).map((row) => row.entryId), 'viewport fill attaches real disk IDs')
      .toEqual([h.turn.userEntry.id, h.turn.assistantEntry.id])
    expect.soft(rows.filter((row) => row.kind === 'tool').map((row) => row.tool.id), 'viewport fill preserves batch order')
      .toEqual(h.turn.toolCallIds)
    expect.soft(view.targetNodes()).toHaveLength(2)
    expectLongTurn(h, '仍在继续', true)
    view.expectPreservedNodes(mounted)
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
