import { describe, expect, it } from 'vitest'
import { LiveSessionProjection } from '../../src/main/agent/live-session-state'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { entriesToTimeline } from '../../src/renderer/src/agent/timeline'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState, TimelineItem, ToolStateScope } from '../../src/renderer/src/agent/types'
import type { SessionInfo, WireEntry, WireEvent, WireEventInput, WireMessage } from '../../src/shared/types'

const T = 1_780_000_000_000
const owner = { cwd: '/fixture/project', sessionPath: '/fixture/sessions/current.jsonl', sessionId: 'fixture-current' }
type Owner = typeof owner
type MessageEvent = Extract<WireEvent, { type: 'message_start' | 'message_end' }>
type UserRow = Extract<TimelineItem, { kind: 'user' }>
type AssistantRow = Extract<TimelineItem, { kind: 'assistant' }>

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asWireEventInput(event: WireEvent): WireEventInput {
  return event
}

function messageOf(event: WireEventInput): WireMessage {
  if (event.type !== 'message_start' && event.type !== 'message_end') throw new Error('Expected message lifecycle event')
  return (event as MessageEvent).message
}

function selectedState(selection: Owner = owner): AgentState {
  return reducer({ ...initialState, status: { phase: 'running', cwd: selection.cwd } }, {
    type: 'clearTimeline', sessionPath: selection.sessionPath
  })
}

function scopeOf(state: AgentState): ToolStateScope {
  return { revision: state.timelineScopeRevision, cwd: state.status.cwd,
    sessionId: state.session?.sessionId, sessionPath: state.liveSessionOwnerPath }
}

// SDK 1.0.4 appends ordinary messages after message_end, without entry_appended.
// The fake manager supplies the real disk IDs; only RPC display messages are annotated.
class FixtureManager {
  readonly entries: WireEntry[] = []

  appendMessage(id: string, rawMessage: WireMessage): WireEntry {
    if (typeof rawMessage.timestamp !== 'number') throw new Error('Fixture needs an SDK message clock')
    if ('_pionLiveMessageId' in rawMessage || '_pionLiveEntryId' in rawMessage) throw new Error('Do not persist RPC annotations')
    const entry: WireEntry = { type: 'message', id, parentId: this.entries.at(-1)?.id ?? null,
      timestamp: new Date(rawMessage.timestamp + 27).toISOString(), message: jsonClone(rawMessage) }
    this.entries.push(entry)
    return entry
  }

  getEntries(): WireEntry[] {
    return jsonClone(this.entries)
  }
}

class RpcFixture {
  readonly projection = new LiveSessionProjection()
  readonly manager = new FixtureManager()
  readonly parsed: WireEventInput[] = []
  readonly forwarded: WireEventInput[] = []
  isStreaming = false

  constructor(readonly selection: Owner = owner) {}

  emit(event: WireEvent): WireEventInput {
    // Each RPC line is parsed separately: start/end never share an SDK object.
    const parsed = jsonClone(asWireEventInput(event))
    this.parsed.push(parsed)
    this.projection.record(parsed)
    if (parsed.type === 'agent_start') this.isStreaming = true
    if (parsed.type === 'agent_settled') this.isStreaming = false
    const forwarded = jsonClone({ ...this.projection.annotateEvent(parsed),
      _pionLive: this.projection.metadata(this.selection.cwd, this.selection.sessionPath) })
    this.forwarded.push(forwarded)
    return forwarded
  }

  session(): SessionInfo {
    return jsonClone({ sessionId: this.selection.sessionId, sessionFile: this.selection.sessionPath,
      isStreaming: this.isStreaming, isCompacting: false,
      messageCount: this.manager.entries.filter((entry) => entry.type === 'message').length,
      pendingMessageCount: 0, liveState: this.projection.snapshot(this.selection.cwd, this.selection.sessionPath) })
  }

  page(entries = this.manager.getEntries()): TimelineItem[] {
    return entriesToTimeline(jsonClone(entries))
  }

  liveState(): AgentState {
    return this.forwarded.reduce((state, event) => reducer(state, {
      type: 'event', event: jsonClone(event)
    }), selectedState(this.selection))
  }
}

function beginTurn(fixture: RpcFixture, id = 'first', clock = T, prompt = '安装这个吧', reply = '已经处理好了。') {
  const user: WireMessage = { role: 'user', timestamp: clock, content: [{ type: 'text', text: prompt }] }
  const assistant: WireMessage = { role: 'assistant', timestamp: clock + 1_000,
    content: [{ type: 'text', text: reply }], stopReason: 'stop' }
  const eventOffset = fixture.forwarded.length
  fixture.emit({ type: 'agent_start' })
  const userStart = fixture.emit({ type: 'message_start', message: user })
  const userEnd = fixture.emit({ type: 'message_end', message: user })
  const userEntry = fixture.manager.appendMessage(`${id}-user`, user)
  const assistantStart = fixture.emit({ type: 'message_start', message: { ...assistant, content: [] } })
  const draft = `准备回复：${reply}`
  fixture.emit({ type: 'message_update', usage: null, assistantMessageEvent: { type: 'text_delta', delta: draft } })
  return { user, assistant, userStart, userEnd, userEntry, assistantStart, draft, eventOffset, id }
}

function finishTurn(fixture: RpcFixture, turn: ReturnType<typeof beginTurn>) {
  const assistantEnd = fixture.emit({ type: 'message_end', message: turn.assistant })
  const assistantEntry = fixture.manager.appendMessage(`${turn.id}-assistant`, turn.assistant)
  fixture.emit({ type: 'agent_end', messages: [turn.user, turn.assistant], willRetry: false })
  fixture.emit({ type: 'agent_settled' })
  return { ...turn, assistantEnd, assistantEntry }
}

function completedFixture(selection: Owner = owner) {
  const fixture = new RpcFixture(selection)
  return { fixture, turn: finishTurn(fixture, beginTurn(fixture)) }
}

function acceptState(state: AgentState, fixture: RpcFixture): AgentState {
  return reducer(state, { type: 'session', session: fixture.session() })
}

function restoreCache(state: AgentState, items: TimelineItem[], backendId: string, scope = scopeOf(state)): AgentState {
  return reducer(state, { type: 'loadEntries', items: jsonClone(items), replayHistory: true,
    cachedBackendId: backendId, preserveToolState: scope })
}

function loadDisk(state: AgentState, fixture: RpcFixture): AgentState {
  return reducer(state, { type: 'loadEntries', items: fixture.page(), preserveToolState: scopeOf(state) })
}

function appendDisk(state: AgentState, fixture: RpcFixture): AgentState {
  return reducer(state, { type: 'appendEntries', items: fixture.page() })
}

function users(state: AgentState): UserRow[] {
  return state.timeline.filter((row): row is UserRow => row.kind === 'user')
}

function assistants(state: AgentState): AssistantRow[] {
  return state.timeline.filter((row): row is AssistantRow => row.kind === 'assistant')
}

function mountedKeys(state: AgentState) {
  return state.timeline.map((row) => ({ kind: row.kind, id: row.id }))
}

function expectTurn(state: AgentState, turn: ReturnType<typeof finishTurn>, keys: ReturnType<typeof mountedKeys>, step: string) {
  expect(state.timeline, step).toHaveLength(2)
  expect(mountedKeys(state), step).toEqual(keys)
  expect(users(state), step).toEqual([expect.objectContaining({ entryId: turn.userEntry.id,
    liveMessageId: messageOf(turn.userStart)._pionLiveMessageId,
    messageTimestamp: turn.user.timestamp, text: '安装这个吧' })])
  expect(assistants(state), step).toEqual([expect.objectContaining({ entryId: turn.assistantEntry.id,
    liveMessageId: messageOf(turn.assistantStart)._pionLiveMessageId,
    messageTimestamp: turn.assistant.timestamp, text: '已经处理好了。', streaming: false })])
}

type RestoreStep = 'STATE' | 'cache' | 'disk load' | 'disk append'
function restoreStep(state: AgentState, step: RestoreStep, fixture: RpcFixture, cache: TimelineItem[]) {
  switch (step) {
    case 'STATE': return acceptState(state, fixture)
    case 'cache': return restoreCache(state, cache, fixture.projection.backendId)
    case 'disk load': return loadDisk(state, fixture)
    case 'disk append': return appendDisk(state, fixture)
  }
}

describe('session restore identity across real RPC-shaped messages', () => {
  it('keeps parsed lifecycle objects and unannotated manager entries separate, with independent clocks', () => {
    const { fixture, turn } = completedFixture()
    const lifecycle = fixture.parsed.filter((event) => event.type === 'message_start' || event.type === 'message_end')
    expect(fixture.parsed.some((event) => event.type === 'entry_appended')).toBe(false)
    expect(lifecycle).toHaveLength(4)
    expect(messageOf(lifecycle[0])).not.toBe(messageOf(lifecycle[1]))
    expect(messageOf(lifecycle[2])).not.toBe(messageOf(lifecycle[3]))
    const forwarded = fixture.forwarded.filter((event) => event.type === 'message_start' || event.type === 'message_end')
    expect(forwarded.map((event) => messageOf(event)._pionLiveMessageId)).toEqual([
      `${fixture.projection.backendId}:1`, `${fixture.projection.backendId}:1`,
      `${fixture.projection.backendId}:2`, `${fixture.projection.backendId}:2`
    ])
    for (const event of lifecycle) expect(messageOf(event)).not.toHaveProperty('_pionLiveMessageId')
    for (const event of forwarded) expect(messageOf(event)).not.toHaveProperty('_pionLiveEntryId')
    expect(fixture.session()).toMatchObject({ isStreaming: false, messageCount: 2 })
    expect(fixture.session().liveState?.events.some((event) => event.type === 'entry_appended')).toBe(false)
    expect(fixture.manager.getEntries()).toEqual([turn.userEntry, turn.assistantEntry])
    for (const entry of fixture.manager.getEntries()) {
      expect(entry.message).not.toHaveProperty('_pionLiveMessageId')
      expect(entry.message).not.toHaveProperty('_pionLiveEntryId')
      expect(Date.parse(entry.timestamp)).toBe(Number(entry.message?.timestamp) + 27)
    }
  })

  it.each<{ steps: RestoreStep[] }>([
    { steps: ['STATE', 'cache', 'disk append'] },
    { steps: ['cache', 'STATE', 'disk append'] },
    { steps: ['disk load', 'STATE', 'cache'] }
  ])('mounts one user and one final assistant through $steps, including repeated restores/pages', ({ steps }) => {
    const { fixture, turn } = completedFixture()
    const cache = jsonClone(fixture.liveState().timeline)
    const diskBefore = JSON.stringify(fixture.manager.entries)
    let state = restoreStep(selectedState(), steps[0], fixture, cache)
    const keys = mountedKeys(state)
    expect(state.timeline).toHaveLength(2)
    for (const step of steps.slice(1)) state = restoreStep(state, step, fixture, cache)
    expectTurn(state, turn, keys, steps.join(' -> '))
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const step of ['STATE', 'cache', 'disk append', 'disk load'] as const) {
        state = restoreStep(state, step, fixture, cache)
        expectTurn(state, turn, keys, `repeat ${repeat}: ${step}`)
      }
    }
    expect(JSON.stringify(fixture.manager.entries)).toBe(diskBefore)
  })

  it.each([false, true])('keeps the cached assistant entry ID when STATE has none (legacy cache: %s)', (legacy) => {
    const { fixture, turn } = completedFixture()
    let cache = appendDisk(fixture.liveState(), fixture).timeline
    if (legacy) cache = cache.map((row) => {
      if (row.kind !== 'assistant') return row
      const { liveMessageId: _liveMessageId, ...withoutLiveId } = row
      return withoutLiveId
    })
    expect(assistants({ ...initialState, timeline: cache })[0].entryId).toBe(turn.assistantEntry.id)
    let state = acceptState(selectedState(), fixture)
    const keys = mountedKeys(state)
    expect(assistants(state)[0].entryId).toBeUndefined()
    state = restoreCache(state, cache, fixture.projection.backendId)
    // Cache replay must transfer this real ID, not merely mark an ID-less row reconciled.
    expectTurn(state, turn, keys, 'STATE -> persisted cache')
    state = appendDisk(state, fixture)
    expectTurn(state, turn, keys, 'persisted cache -> repeated disk page')
  })

  it.each(['already on disk', 'still streaming'])('routes a late identified assistant end only to its row (%s)', (phase) => {
    const fixture = new RpcFixture()
    const firstStart = beginTurn(fixture, 'first', T, 'first question', 'first final')
    let state = fixture.liveState()
    const firstKey = assistants(state)[0].id
    const first = finishTurn(fixture, firstStart)
    // The disk read can finish before the queued renderer message_end arrives.
    if (phase === 'already on disk') state = appendDisk(state, fixture)
    const second = beginTurn(fixture, 'second', T + 10_000, 'second question', 'second final')
    for (const event of fixture.forwarded.slice(second.eventOffset)) {
      state = reducer(state, { type: 'event', event: jsonClone(event) })
    }
    const secondRow = assistants(state).find((row) => row.liveMessageId === messageOf(second.assistantStart)._pionLiveMessageId)
    expect(secondRow).toMatchObject({ text: second.draft, streaming: true })
    // Exercise end identity routing independently of metadata revision rejection.
    // The entry ID comes from the manager, not a synthetic ordinary entry event.
    const lateEnd = jsonClone(asWireEventInput({ type: 'message_end', message: {
      ...messageOf(first.assistantEnd), _pionLiveEntryId: first.assistantEntry.id
    } }))
    state = reducer(state, { type: 'event', event: lateEnd })
    expect(assistants(state).find((row) => row.id === firstKey)).toMatchObject({
      entryId: first.assistantEntry.id, liveMessageId: messageOf(first.assistantStart)._pionLiveMessageId,
      messageTimestamp: first.assistant.timestamp, text: 'first final', streaming: false
    })
    expect(assistants(state).find((row) => row.id === secondRow?.id)).toBe(secondRow)
    state = reducer(state, { type: 'event', event: jsonClone(lateEnd) })
    state = appendDisk(state, fixture)
    expect(assistants(state)).toHaveLength(2)
    expect(assistants(state).find((row) => row.id === secondRow?.id)).toBe(secondRow)
  })

  it('does not merge different known disk IDs with equal SDK clocks and equal message content', () => {
    const fixture = new RpcFixture()
    finishTurn(fixture, beginTurn(fixture, 'first'))
    finishTurn(fixture, beginTurn(fixture, 'second'))
    let state = loadDisk(selectedState(), fixture)
    const keys = mountedKeys(state)
    const cache = jsonClone(state.timeline)
    for (let repeat = 0; repeat < 3; repeat++) {
      state = appendDisk(state, fixture)
      state = restoreCache(state, cache, fixture.projection.backendId)
      state = loadDisk(state, fixture)
      expect(mountedKeys(state)).toEqual(keys)
      expect(users(state).map((row) => row.entryId)).toEqual(['first-user', 'second-user'])
      expect(assistants(state).map((row) => row.entryId)).toEqual(['first-assistant', 'second-assistant'])
    }
  })

  it.each([0, 10_000])('retains two real sends of the same prompt with fresh backend row sequences (clock offset: %s)', (offset) => {
    const fixture = new RpcFixture()
    const first = finishTurn(fixture, beginTurn(fixture, 'first'))
    let state = appendDisk(fixture.liveState(), fixture)
    const firstKeys = mountedKeys(state)
    const second = finishTurn(fixture, beginTurn(fixture, 'second', T + offset))
    for (const event of fixture.forwarded.slice(second.eventOffset)) {
      state = reducer(state, { type: 'event', event: jsonClone(event) })
    }
    const keys = mountedKeys(state)
    // A later page has its own real IDs, even if the SDK reused the millisecond clock.
    state = reducer(state, { type: 'appendEntries', items: fixture.page(fixture.manager.getEntries().slice(2)) })
    state = acceptState(state, fixture)
    const cache = jsonClone(state.timeline)
    for (let repeat = 0; repeat < 3; repeat++) {
      state = restoreCache(state, cache, fixture.projection.backendId)
      state = acceptState(state, fixture)
      state = appendDisk(state, fixture)
      expect(mountedKeys(state)).toEqual(keys)
      expect(mountedKeys(state).slice(0, 2)).toEqual(firstKeys)
      expect(users(state).map((row) => row.entryId)).toEqual([first.userEntry.id, second.userEntry.id])
      expect(assistants(state).map((row) => row.entryId)).toEqual([first.assistantEntry.id, second.assistantEntry.id])
      expect(users(state).map((row) => row.liveMessageId)).toEqual([
        `${fixture.projection.backendId}:1`, `${fixture.projection.backendId}:3`
      ])
      expect(assistants(state).map((row) => row.liveMessageId)).toEqual([
        `${fixture.projection.backendId}:2`, `${fixture.projection.backendId}:4`
      ])
    }
  })

  it('does not let an anonymous late final with another clock finish the current native draft', () => {
    const fixture = new RpcFixture()
    const turn = beginTurn(fixture)
    let state = fixture.liveState()
    const draft = assistants(state)[0]
    const old: WireEventInput = { type: 'message_end', message: { role: 'assistant',
      timestamp: T - 1_000, content: 'a genuinely older completion' } }
    expect(reducer(state, { type: 'event', event: old })).toBe(state)
    const unknown: WireEventInput = { type: 'message_update', usage: null,
      _pionLiveMessageId: 'an-unknown-message', assistantMessageEvent: { type: 'text_delta', delta: 'not this draft' } }
    expect(reducer(state, { type: 'event', event: unknown })).toBe(state)
    state = reducer(state, { type: 'event', event: { type: 'message_end',
      message: { ...turn.assistant, content: 'legacy final with the matching actual clock' } } })
    expect(assistants(state)).toEqual([expect.objectContaining({ id: draft.id,
      liveMessageId: draft.liveMessageId, text: 'legacy final with the matching actual clock', streaming: false })])
  })

  it('does not let a fresh same-clock user start claim an older disk-only send', () => {
    const { fixture } = completedFixture()
    let state = loadDisk(selectedState(), fixture)
    const original = users(state)[0]
    const second = beginTurn(fixture, 'second', T)
    for (const event of fixture.forwarded.slice(second.eventOffset)) {
      state = reducer(state, { type: 'event', event: jsonClone(event) })
    }
    expect(users(state)).toHaveLength(2)
    expect(users(state)[0]).toBe(original)
    expect(users(state)[1]).toMatchObject({ liveMessageId: messageOf(second.userStart)._pionLiveMessageId })
    expect(users(state)[1].entryId).toBeUndefined()
    const completed = finishTurn(fixture, second)
    state = acceptState(state, fixture)
    state = appendDisk(state, fixture)
    expect(users(state).map((row) => row.entryId)).toEqual(['first-user', completed.userEntry.id])
    expect(users(state)[0]).toBe(original)
    expect(users(state)[1].liveMessageId).toBe(messageOf(second.userStart)._pionLiveMessageId)
  })

  it('joins a split disk/live assistant after STATE provides its real final clock and body', () => {
    const fixture = new RpcFixture()
    const turn = beginTurn(fixture)
    let state = fixture.liveState()
    const key = assistants(state)[0].id
    turn.assistant.timestamp = T + 2_000
    const completed = finishTurn(fixture, turn)
    state = appendDisk(state, fixture)
    expect(assistants(state)).toHaveLength(2)
    const diskBefore = JSON.stringify(fixture.manager.entries)
    state = acceptState(state, fixture)
    expect(assistants(state)).toEqual([expect.objectContaining({ id: key,
      entryId: completed.assistantEntry.id, liveMessageId: messageOf(turn.assistantStart)._pionLiveMessageId,
      messageTimestamp: turn.assistant.timestamp, text: '已经处理好了。', streaming: false })])
    state = appendDisk(acceptState(state, fixture), fixture)
    expect(assistants(state)).toHaveLength(1)
    expect(assistants(state)[0].id).toBe(key)
    expect(JSON.stringify(fixture.manager.entries)).toBe(diskBefore)
  })

  it.each([true, false])('fills only explicitly clipped snapshot fields from the full cache (marked: %s)', (marked) => {
    const { fixture, turn } = completedFixture()
    const cache = appendDisk(fixture.liveState(), fixture).timeline
    const snapshot = fixture.session()
    if (!snapshot.liveState) throw new Error('Missing live snapshot')
    snapshot.liveState.truncated = true
    for (const event of snapshot.liveState.events) {
      if (event.type !== 'message_end' || messageOf(event).role !== 'assistant') continue
      const message = messageOf(event)
      message.content = [{ type: 'text', text: '已经' }]
      if (marked) message._pionLiveTruncatedFields = ['text']
    }
    let state = reducer(selectedState(), { type: 'session', session: snapshot })
    expect(assistants(state)[0].text).toBe('已经')
    state = restoreCache(state, cache, fixture.projection.backendId)
    expect(assistants(state)).toEqual([expect.objectContaining({ entryId: turn.assistantEntry.id,
      text: marked ? '已经处理好了。' : '已经', streaming: false })])
    state = appendDisk(state, fixture)
    expect(assistants(state)).toHaveLength(1)
    expect(assistants(state)[0].text).toBe(marked ? '已经处理好了。' : '已经')
  })

  it.each(['cwd', 'path', 'backend'])('rejects an old cache and STATE after changing selected %s', (changed) => {
    const old = completedFixture()
    const previous = appendDisk(acceptState(selectedState(), old.fixture), old.fixture)
    const oldScope = scopeOf(previous)
    const selection: Owner = { ...owner,
      ...(changed === 'cwd' ? { cwd: '/fixture/other-project' } : {}),
      ...(changed !== 'backend' ? { sessionPath: '/fixture/sessions/other.jsonl', sessionId: 'fixture-other' } : {}) }
    const current = new RpcFixture(selection)
    finishTurn(current, beginTurn(current, 'selected', T + 20_000, 'selected question', 'selected final'))
    let state = reducer(previous, { type: 'status', status: { phase: 'running', cwd: selection.cwd } })
    state = reducer(state, { type: 'clearTimeline', sessionPath: selection.sessionPath })
    state = appendDisk(acceptState(state, current), current)
    const selected = state
    const oldCache = jsonClone(previous.timeline)
    expect(restoreCache(state, oldCache, old.fixture.projection.backendId, oldScope)).toBe(selected)
    state = acceptState(state, old.fixture)
    expect(state).toBe(selected)
    expect(users(state).map((row) => row.entryId)).toEqual(['selected-user'])
    expect(assistants(state).map((row) => row.entryId)).toEqual(['selected-assistant'])
    expect(state.liveSessionBackendId).toBe(current.projection.backendId)
  })
})
