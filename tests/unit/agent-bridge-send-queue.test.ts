import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import type { RunOperation } from '../../src/shared/operations'
import type { SessionInfo, WireEvent, WireEventInput, WireMessage } from '../../src/shared/types'
import { RunStore } from '../../src/main/run-store'
import { SessionListCache } from '../../src/main/agent/session-list-cache'

function messageOf(event: WireEventInput): WireMessage {
  if (event.type !== 'message_start' && event.type !== 'message_end') throw new Error('Expected a message lifecycle event')
  return (event as Extract<WireEvent, { type: 'message_start' | 'message_end' }>).message
}

type Disposition = 'started' | 'queued' | 'handled'
interface BridgeHarness {
  send(message: string): Promise<void>
  queue(message: string): Promise<void>
  resumeRun(runId: string): Promise<RunOperation>
  startVerificationRepair(sessionPath: string, cwd: string, message: string): Promise<RunOperation | null>
  sendQueuedMessage(kind: 'followUp', index: number): Promise<void>
  dispatchNextLocalFollowUp(backend: BackendRecord): void
  createRun(backend: BackendRecord, state: null, message: string, images: [], kind: 'follow-up', phase: 'queued'): RunOperation
  activeKey: string
  sessionSelectionGeneration: number
  historyRevision: number
  getSessionInfo(): Promise<SessionInfo | null>
}
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'pion-send-queue-'))
  roots.push(root)
  const runStore = new RunStore(join(root, 'runs.json'))
  const state = { sessionId: 'session-1', isStreaming: false, isCompacting: false, messageCount: 1, pendingMessageCount: 0 }
  let listener: (event: unknown) => void = () => undefined
  const getState = vi.fn(async () => state)
  const prompt = vi.fn(async (): Promise<Disposition> => 'started')
  const steer = vi.fn(async (): Promise<'queued' | 'handled'> => 'queued')
  const backend = {
    key: 'backend-1', cwd: root, phase: 'running', busy: false, compacting: false,
    modePrimed: 'build', pendingRunIds: [], localFollowUps: [],
    client: { getState, prompt, steer, onEvent: vi.fn((callback: (event: unknown) => void) => { listener = callback }) },
    startPromise: Promise.resolve()
  } as unknown as BackendRecord
  const pool = new Map([[backend.key, backend]])
  const wireSend = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: backend.key, activeCwd: root, runStore,
    sessionSelectionGeneration: 0, historyRevision: 0, yoloSessions: new Set(),
    win: { webContents: { send: wireSend } },
    backendPool: pool, desiredModes: new Map([[backend.key, 'build']]),
    sessionCompletedListeners: new Set(), runCompletedListeners: new Set(), unreadSessionPaths: new Set(),
    ensureActiveBackend: vi.fn(async () => backend),
    syncBackendSession: vi.fn(async () => undefined), pushSessionInfo: vi.fn(async () => undefined),
    refreshSidebarSessions: vi.fn(async () => undefined), pushRunCheckpoint: vi.fn(),
    refreshRunCheckpoint: vi.fn(async () => undefined), pushRunningSessionPaths: vi.fn(),
    setActiveBackendStatus: vi.fn(), resetRunCheckpoint: vi.fn()
  })
  bridge.attachBackendEvents(backend)
  const api = bridge as BridgeHarness
  const addQueued = (text: string) => {
    const run = api.createRun(backend, null, text, [], 'follow-up', 'queued')
    backend.localFollowUps!.push({ runId: run.id, text, images: [] })
    return run
  }
  const emit = (type: string, fields: Record<string, unknown> = {}) => listener({ type, ...fields })
  const runs = () => runStore.list({ limit: 100 })
  return { bridge: api, backend, pool, state, runStore, getState, prompt, steer, emit, addQueued, runs, wireSend }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

// Flush only in-memory microtasks in the written tests; never launch a real backend.
async function dispatchGap() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('AgentBridge live session state', () => {
  it('forwards stable root identities shared by the snapshot without resending the prompt or mutating SDK messages', async () => {
    const h = await harness()
    await h.bridge.send('one question')
    const message = { role: 'user', timestamp: 1, content: 'one question' }
    h.emit('agent_start')
    h.emit('message_start', { message, preserved: 'root-field' })
    h.emit('message_end', { message })
    const forwarded = h.wireSend.mock.calls.map((call) => call[1]).filter((event) =>
      event.type === 'message_start' || event.type === 'message_end')
    const id = `${h.backend.liveState!.backendId}:1`
    expect(forwarded).toHaveLength(2)
    expect(forwarded[0]).toMatchObject({ preserved: 'root-field', message: { _pionLiveMessageId: id } })
    expect(forwarded[1]).toMatchObject({ message: { _pionLiveMessageId: id } })
    expect(h.backend.liveState!.snapshot(h.backend.cwd).events.every((event) => messageOf(event)._pionLiveMessageId === id)).toBe(true)
    const entry = { type: 'message', id: 'disk-user', parentId: 'actual-parent', timestamp: 'date', message }
    h.emit('entry_appended', { entry, preserved: 'entry-field' })
    const forwardedEntry = h.wireSend.mock.calls.map((call) => call[1]).find((event) => event.type === 'entry_appended')
    expect(forwardedEntry).toMatchObject({ preserved: 'entry-field', entry: { parentId: 'actual-parent', message: {
      _pionLiveMessageId: id, _pionLiveEntryId: 'disk-user'
    } } })
    expect(entry.message).not.toHaveProperty('_pionLiveEntryId')
    expect(message).not.toHaveProperty('_pionLiveMessageId')
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('projects inactive roots with the same identity later forwarded, while nested messages stay excluded', async () => {
    const h = await harness()
    h.bridge.activeKey = 'elsewhere'
    h.emit('message_start', { message: { role: 'user', timestamp: 1, content: 'background' } })
    h.emit('message_start', { parentToolCallId: 'child', message: { role: 'user', timestamp: 1, content: 'nested' } })
    expect(h.backend.liveState!.snapshot(h.backend.cwd).events).toHaveLength(1)
    const id = `${h.backend.liveState!.backendId}:1`
    h.bridge.activeKey = h.backend.key
    h.emit('message_end', { message: { role: 'user', timestamp: 1, content: 'background' } })
    const forwarded = h.wireSend.mock.calls.map((call) => call[1]).find((event) => event.type === 'message_end')
    expect(forwarded).toMatchObject({ message: { _pionLiveMessageId: id } })
    expect(JSON.stringify(h.backend.liveState!.snapshot(h.backend.cwd))).not.toContain('nested')
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it('bounds UI waiting to two seconds, shares the real pending RPC, and overlays latest live flags', async () => {
    const h = await harness()
    await h.bridge.getSessionInfo() // last successful SDK state
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValue(pending.promise)
    vi.useFakeTimers()
    const first = h.bridge.getSessionInfo()
    const second = h.bridge.getSessionInfo()
    h.emit('agent_start')
    h.emit('compaction_start', { reason: 'manual' })
    h.emit('message_start', { message: { role: 'assistant', timestamp: 1, content: [] } })
    h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'latest' } })
    await vi.advanceTimersByTimeAsync(2_000)
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({ sessionId: 'session-1', messageCount: 1, isStreaming: true, isCompacting: true })
    expect(JSON.stringify(b?.liveState?.events)).toContain('latest')
    expect(h.getState).toHaveBeenCalledTimes(2)
    const retry = h.bridge.getSessionInfo()
    await vi.advanceTimersByTimeAsync(2_000)
    await retry
    expect(h.getState).toHaveBeenCalledTimes(2) // timeout is not RPC cancellation
    expect(h.backend.modePrimed).toBe('build')
  })

  it('warms a late successful snapshot without emitting STATE or mixing a new selection', async () => {
    const h = await harness()
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(pending.promise)
    vi.useFakeTimers()
    const loading = h.bridge.getSessionInfo()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await loading).toBeNull() // fresh path/id unknown; no fabricated identity
    h.bridge.activeKey = 'other-project'
    h.bridge.sessionSelectionGeneration++
    pending.resolve({ ...h.state, messageCount: 9 })
    await dispatchGap()
    expect(h.wireSend).not.toHaveBeenCalled()
    h.bridge.activeKey = h.backend.key
    h.bridge.sessionSelectionGeneration++
    h.getState.mockReturnValue(new Promise(() => undefined))
    h.backend.busy = true
    const restored = h.bridge.getSessionInfo()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await restored).toMatchObject({ sessionId: 'session-1', messageCount: 9, isStreaming: true })
  })

  it('describes persisted history when a hot RPC hangs without inventing counts or model', async () => {
    const h = await harness()
    h.backend.sessionPath = join(h.backend.cwd, 'persisted.jsonl')
    h.backend.busy = true
    h.getState.mockReturnValue(new Promise(() => undefined))
    const currentManager = vi.fn(async () => ({
      buildSessionContext: () => ({ messages: [{ role: 'user' }, { role: 'assistant' }], thinkingLevel: 'off' }),
      getSessionFile: () => h.backend.sessionPath, getSessionId: () => 'persisted-id', getSessionName: () => 'saved'
    }))
    Object.assign(h.bridge, { openCurrentSessionManager: currentManager })
    vi.useFakeTimers()
    const loading = h.bridge.getSessionInfo()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await loading).toMatchObject({ sessionId: 'persisted-id', messageCount: 2, isStreaming: true })
    expect(currentManager).toHaveBeenCalledWith(h.backend.sessionPath)
    expect(h.backend.modePrimed).toBe('build')
  })

  it.each([false, true])('does not wait for SDK initialization or fake state for a cold session (persisted=%s)', async (persisted) => {
    const h = await harness()
    h.backend.phase = 'starting'
    h.backend.startPromise = new Promise(() => undefined)
    h.backend.busy = true
    const path = join(h.backend.cwd, 'cold.jsonl')
    const currentManager = vi.fn(async () => ({
      buildSessionContext: () => ({ messages: [], thinkingLevel: 'off' }),
      getSessionFile: () => path, getSessionId: () => 'cold-id', getSessionName: () => undefined
    }))
    Object.assign(h.bridge, { activeSessionPath: persisted ? path : null, openCurrentSessionManager: currentManager })
    if (persisted) expect(await h.bridge.getSessionInfo()).toMatchObject({ sessionId: 'cold-id', messageCount: 0, isStreaming: true })
    else expect(await h.bridge.getSessionInfo()).toBeNull()
    expect(h.backend.busy).toBe(true)
    expect(h.getState).not.toHaveBeenCalled()
    expect(currentManager).toHaveBeenCalledTimes(persisted ? 1 : 0)
  })

  it('rejects a timed-out old-project result instead of applying its cache to the new selection', async () => {
    const h = await harness()
    await h.bridge.getSessionInfo()
    h.getState.mockReturnValue(new Promise(() => undefined))
    vi.useFakeTimers()
    const loading = h.bridge.getSessionInfo()
    h.bridge.activeKey = 'new-project'
    h.bridge.sessionSelectionGeneration++
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await loading).toBeNull()
  })

  it('invalidates persisted sidebar summaries on message completion, not token or queue activity', async () => {
    const h = await harness()
    const invalidate = vi.fn()
    Object.assign(h.bridge, { sessionListCache: { invalidate } })
    h.emit('message_start', { message: { role: 'assistant', timestamp: 1, content: [] } })
    h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'stream' } })
    h.emit('queue_updated', { steering: [], followUp: [] })
    expect(invalidate).not.toHaveBeenCalled()
    h.emit('message_end', { message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'done' }] } })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(h.backend.cwd, { soft: true })
    h.emit('session_info_changed', { name: 'renamed' })
    expect(invalidate).toHaveBeenLastCalledWith(h.backend.cwd)
    expect((h.bridge as unknown as { syncBackendSession: ReturnType<typeof vi.fn> }).syncBackendSession).toHaveBeenCalledWith(h.backend)
  })

  it('publishes a first persisted session after a pre-file empty scan is softly dirtied', async () => {
    const h = await harness()
    const path = join(h.backend.cwd, 'first.jsonl')
    Object.assign(h.state, { sessionFile: path })
    const pending = deferred<import('../../src/shared/types').SessionMeta[]>()
    const persisted = { path, id: 'session-1', timestamp: '', mtime: 1, preview: 'first', messageCount: 1 }
    const load = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue([persisted])
    const cache = new SessionListCache(load)
    const prototype = AgentBridge.prototype as unknown as { syncBackendSession(backend: BackendRecord): Promise<void> }
    Object.assign(h.bridge, {
      sessionListCache: cache,
      backendKeysBySessionPath: new Map(),
      updateRunSession: vi.fn(), restoreQueuedRuns: vi.fn(),
      listSessions: (cwd: string) => cache.list(cwd),
      syncBackendSession: prototype.syncBackendSession
    })
    h.emit('message_start', { message: { role: 'user', timestamp: 1, content: [] } })
    await dispatchGap()
    expect(load).toHaveBeenCalledTimes(1)
    h.emit('message_end', { message: { role: 'user', timestamp: 1, content: [] } })
    pending.resolve([])
    await dispatchGap()
    expect(load).toHaveBeenCalledTimes(2)
    expect(h.backend.sidebarPublishedSessionPath).toBe(path)
    expect(h.wireSend.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0]?.path === path)).toBe(true)
  })

  it('records background output without forwarding ordinary events and returns a complete selected snapshot', async () => {
    const h = await harness()
    h.bridge.activeKey = 'other'
    h.emit('message_start', { message: { role: 'assistant', timestamp: 1, content: [] } })
    h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'background' } })
    expect(h.wireSend).not.toHaveBeenCalled()
    h.bridge.activeKey = h.backend.key
    const info = await h.bridge.getSessionInfo()
    expect(JSON.stringify(info?.liveState?.events)).toContain('background')
    h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'active' } })
    expect(h.wireSend.mock.calls.at(-1)?.[1]).toMatchObject({
      _pionLive: { backendId: info?.liveState?.backendId, revision: 3, cwd: h.backend.cwd }
    })
  })

  it('captures events that arrive during getState rather than a pre-await snapshot', async () => {
    const h = await harness()
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(pending.promise)
    const info = h.bridge.getSessionInfo()
    h.emit('message_start', { message: { role: 'assistant', timestamp: 1 } })
    h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'during await' } })
    pending.resolve(h.state)
    expect(JSON.stringify((await info)?.liveState?.events)).toContain('during await')
  })

  it('pairs a post-await agent_start snapshot with authoritative busy flags, not stale idle RPC flags', async () => {
    const h = await harness()
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(pending.promise)
    const info = h.bridge.getSessionInfo()
    h.emit('agent_start')
    h.emit('message_start', { message: { role: 'assistant', timestamp: 1 } })
    h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'new run' } })
    pending.resolve({ ...h.state, isStreaming: false, isCompacting: false })
    const result = await info
    expect(result).toMatchObject({ isStreaming: true, isCompacting: false, liveState: { revision: 3 } })
    expect(JSON.stringify(result?.liveState?.events)).toContain('new run')
  })

  it('does not restore streaming from an older RPC after the event lifecycle settles', async () => {
    const h = await harness()
    h.emit('agent_start')
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(pending.promise)
    const info = h.bridge.getSessionInfo()
    h.emit('agent_settled')
    pending.resolve({ ...h.state, isStreaming: true, isCompacting: true })
    expect(await info).toMatchObject({ isStreaming: false, isCompacting: false, liveState: { revision: 2 } })
  })

  it('keeps an in-flight compaction busy across a stale state reply', async () => {
    const h = await harness()
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(pending.promise)
    const info = h.bridge.getSessionInfo()
    h.emit('compaction_start', { reason: 'manual' })
    pending.resolve({ ...h.state, isStreaming: false, isCompacting: false })
    expect(await info).toMatchObject({ isStreaming: true, isCompacting: true })
  })

  it('does not hide a dispatch reservation before the first agent_start event', async () => {
    const h = await harness()
    h.backend.busy = true
    expect(await h.bridge.getSessionInfo()).toMatchObject({ isStreaming: true, isCompacting: false })
  })

  it.each(['replacement', 'selection', 'history'] as const)('rejects a late getState after %s changes', async (change) => {
    const h = await harness()
    const pending = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(pending.promise)
    const info = h.bridge.getSessionInfo()
    if (change === 'replacement') h.pool.set(h.backend.key, { ...h.backend })
    if (change === 'selection') h.bridge.sessionSelectionGeneration += 2 // A -> B -> A
    if (change === 'history') h.bridge.historyRevision++
    pending.resolve(h.state)
    expect(await info).toBeNull()
  })
})

describe('AgentBridge send and local queue', () => {
  it('sends Enter directly while preserving existing follow-ups', async () => {
    const h = await harness()
    const queued = h.addQueued('稍后处理')
    await h.bridge.send('立即发送')
    expect(h.prompt).toHaveBeenCalledWith('立即发送', [])
    expect(h.steer).not.toHaveBeenCalled()
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([queued.id])
    await h.runStore.flush()
  })

  it.each(['send', 'queue'] as const)('releases event-free handled %s without synthesizing a run completion', async (method) => {
    const h = await harness()
    h.prompt.mockResolvedValue('handled')
    await h.bridge[method]('/consumed')
    expect(h.backend.busy).toBe(false)
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.runs()[0]).toMatchObject({ state: 'discarded', stopReason: 'input-handled' })
    expect(h.runs()[0].agentStartedAt).toBeUndefined()
    expect(h.runs()[0].usage.total).toBe(0)
    await h.bridge.send('next')
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it.each(['started', 'queued'] as const)('keeps %s acceptance busy until normal events settle', async (disposition) => {
    const h = await harness()
    h.prompt.mockResolvedValue(disposition)
    await h.bridge.send('work')
    expect(h.backend.busy).toBe(true)
    h.emit('agent_start')
    h.emit('agent_settled')
    expect(h.backend.busy).toBe(false)
    expect(h.runs()[0].state).toBe('completed')
    await h.runStore.flush()
  })

  it.each(['started', 'handled'] as const)('does not reopen a fast-finished run on late %s acceptance', async (disposition) => {
    const h = await harness()
    h.prompt.mockImplementation(async () => {
      h.emit('agent_start')
      h.emit('agent_settled')
      return disposition
    })
    await h.bridge.send('fast')
    expect(h.backend.busy).toBe(false)
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.runs()[0].state).toBe('completed')
    await h.runStore.flush()
  })

  it('does not release an independently started extension run on handled', async () => {
    const h = await harness()
    const queued = h.addQueued('local only')
    h.prompt.mockImplementation(async () => { h.emit('agent_start'); return 'handled' })
    await h.bridge.send('/extension')
    expect(h.backend.busy).toBe(true)
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.runStore.get(queued.id)?.state).toBe('queued')
    expect(h.prompt).toHaveBeenCalledTimes(1)
    await h.runStore.flush()
  })

  it('does not let an independent start after fast settlement adopt a local queued ledger', async () => {
    const h = await harness()
    const queued = h.addQueued('not yet dispatched')
    h.prompt.mockImplementation(async () => {
      h.emit('agent_start')
      h.emit('agent_settled')
      h.emit('agent_start')
      return 'handled'
    })
    await h.bridge.send('/extension')
    expect(h.backend.busy).toBe(true)
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.runStore.get(queued.id)?.state).toBe('queued')
    expect(h.prompt).toHaveBeenCalledTimes(1)
    await h.runStore.flush()
  })

  it('drains multiple handled auto-dispatched items and reserves only the actual queued item', async () => {
    const h = await harness()
    const first = h.addQueued('first')
    const second = h.addQueued('second')
    h.prompt.mockResolvedValue('handled')
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    while (h.backend.localQueueDispatchPromise) await h.backend.localQueueDispatchPromise
    expect(h.prompt).toHaveBeenNthCalledWith(1, 'first', [])
    expect(h.prompt).toHaveBeenNthCalledWith(2, 'second', [])
    expect(h.runStore.get(first.id)?.state).toBe('discarded')
    expect(h.runStore.get(second.id)?.state).toBe('discarded')
    expect(h.backend.pendingRunIds).toEqual([])
    expect(h.backend.busy).toBe(false)
    expect(h.backend.localQueueDispatching).toBe(false)
    await h.runStore.flush()
  })

  it('restores a rejected auto-dispatch without reserving its queued ledger for future events', async () => {
    const h = await harness()
    const queued = h.addQueued('retry')
    h.prompt.mockRejectedValue(new Error('preflight failed'))
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    if (h.backend.localQueueDispatchPromise) await h.backend.localQueueDispatchPromise
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([queued.id])
    expect(h.runStore.get(queued.id)?.state).toBe('queued')
    h.emit('agent_start')
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.runStore.get(queued.id)?.agentStartedAt).toBeUndefined()
    await h.runStore.flush()
  })

  it('closes handled explicit queue promotion without waiting for settled', async () => {
    const h = await harness()
    const queued = h.addQueued('/handled')
    h.prompt.mockResolvedValue('handled')
    await h.bridge.sendQueuedMessage('followUp', 0)
    expect(h.runStore.get(queued.id)?.state).toBe('discarded')
    expect(h.backend.pendingRunIds).toEqual([])
    expect(h.backend.busy).toBe(false)
    await h.runStore.flush()
  })

  it.each(['direct', 'promoted'] as const)('removes handled %s steering without closing the current run', async (path) => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    const activeId = h.backend.activeRunId
    h.state.isStreaming = true
    h.steer.mockResolvedValue('handled')
    const queued = path === 'promoted' ? h.addQueued('steer') : undefined
    if (queued) await h.bridge.sendQueuedMessage('followUp', 0)
    else await h.bridge.send('steer')
    expect(h.backend.busy).toBe(true)
    expect(h.backend.activeRunId).toBe(activeId)
    expect(h.backend.directSteering).toEqual([])
    expect(h.backend.companionRunIds ?? []).toEqual([])
    if (queued) expect(h.runStore.get(queued.id)?.state).toBe('discarded')
    expect(h.runStore.get(activeId!)?.state).toBe('running')
    await h.runStore.flush()
  })

  it('does not remove a newer same-text steering marker after the original queue entry was consumed', async () => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const result = deferred<'handled' | 'queued'>()
    h.steer.mockImplementationOnce(() => result.promise)
    const first = h.bridge.send('same text')
    await dispatchGap()
    h.emit('queue_update', { steering: [], followUp: [] })
    h.emit('agent_start')
    await h.bridge.send('same text')
    result.resolve('handled')
    await first
    expect(h.backend.directSteering).toEqual(['same text'])
    expect(h.backend.rawQueue?.steering).toEqual(['same text'])
    expect(h.backend.busy).toBe(true)
    await h.runStore.flush()
  })

  it('does not close a newer run when an earlier finished prompt finally returns handled', async () => {
    const h = await harness()
    const result = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => result.promise)
    const first = h.bridge.send('first')
    await dispatchGap()
    h.emit('agent_start')
    h.emit('agent_settled')
    await dispatchGap()
    await h.bridge.send('new run')
    const activeId = h.backend.activeRunId
    result.resolve('handled')
    await first
    expect(h.backend.activeRunId).toBe(activeId)
    expect(h.backend.busy).toBe(true)
    expect(h.runStore.get(activeId!)?.state).toBe('dispatching')
    await h.runStore.flush()
  })

  it('settles only the original backend when selection changes before handled response', async () => {
    const h = await harness()
    const result = deferred<Disposition>()
    h.prompt.mockImplementation(() => result.promise)
    const sending = h.bridge.send('/handled')
    await dispatchGap()
    const other = { ...h.backend, key: 'other', activeRunId: 'other-active', busy: true }
    h.pool.set(other.key, other)
    h.bridge.activeKey = other.key
    result.resolve('handled')
    await sending
    expect(h.backend.busy).toBe(false)
    expect(other.busy).toBe(true)
    expect(other.activeRunId).toBe('other-active')
    await h.runStore.flush()
  })

  it.each(['send', 'queue', 'auto', 'promoted'] as const)(
    'preserves event-owned busy/ledger on late %s rejection after extension start', async (path) => {
      const h = await harness()
      const result = deferred<Disposition>()
      h.prompt.mockImplementationOnce(() => result.promise)
      const queued = path === 'auto' || path === 'promoted' ? h.addQueued('dispatch') : undefined
      let sending: Promise<void>
      if (path === 'auto') {
        h.bridge.dispatchNextLocalFollowUp(h.backend)
        sending = h.backend.localQueueDispatchPromise!
      } else if (path === 'promoted') sending = h.bridge.sendQueuedMessage('followUp', 0)
      else sending = h.bridge[path]('/extension')
      // Attach rejection handling before deliberately rejecting the RPC.
      const observed = sending.catch((error: unknown) => error)
      await dispatchGap()
      const activeId = h.backend.activeRunId!
      h.emit('agent_start')
      h.emit('compaction_start')
      result.reject(new Error('late RPC rejection'))
      await observed
      expect(h.backend.busy).toBe(true)
      expect(h.backend.compacting).toBe(true)
      expect(h.backend.activeRunId).toBe(activeId)
      expect(h.runStore.get(activeId)?.state).toBe('running')
      if (queued) expect(h.backend.localFollowUps).toEqual([])
      await h.runStore.flush()
    }
  )

  it.each(['resume', 'repair'] as const)('preserves event-owned state on late %s prompt rejection', async (path) => {
    const h = await harness()
    const result = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => result.promise)
    let sending: Promise<RunOperation | null>
    if (path === 'resume') {
      const source = h.addQueued('interrupted source')
      h.runStore.update(source.id, (run) => { run.state = 'interrupted' })
      sending = h.bridge.resumeRun(source.id)
    } else {
      const sessionPath = join(h.backend.cwd, 'session.jsonl')
      Object.assign(h.bridge, {
        backendKeysBySessionPath: new Map([[sessionPath, h.backend.key]]),
        assertSessionNotQuarantined: vi.fn()
      })
      sending = h.bridge.startVerificationRepair(sessionPath, h.backend.cwd, 'repair')
    }
    const observed = sending.catch((error: unknown) => error)
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    const activeId = h.backend.activeRunId!
    h.emit('agent_start')
    h.emit('compaction_start')
    result.reject(new Error('late recovery rejection'))
    await observed
    expect(h.backend.busy).toBe(true)
    expect(h.backend.compacting).toBe(true)
    expect(h.backend.activeRunId).toBe(activeId)
    expect(h.runStore.get(activeId)?.state).toBe('running')
    await h.runStore.flush()
  })

  it.each(['settled', 'new-run', 'replacement'] as const)(
    'does not rewrite terminal or newer ownership on late reject after %s', async (phase) => {
      const h = await harness()
      const result = deferred<Disposition>()
      h.prompt.mockImplementationOnce(() => result.promise)
      const sending = h.bridge.send('first').catch((error: unknown) => error)
      await dispatchGap()
      const firstId = h.backend.activeRunId!
      let replacement: BackendRecord | undefined
      if (phase === 'replacement') {
        replacement = { ...h.backend, activeRunId: 'new-owner', busy: true, compacting: true }
        h.pool.set(h.backend.key, replacement)
      } else {
        h.emit('agent_start')
        h.emit('agent_settled')
        await dispatchGap()
        if (phase === 'new-run') await h.bridge.send('new run')
      }
      const activeId = h.backend.activeRunId
      result.reject(new Error('late rejection'))
      await sending
      expect(h.runStore.get(firstId)?.state).toBe(phase === 'replacement' ? 'dispatching' : 'completed')
      if (replacement) {
        expect(replacement).toMatchObject({ activeRunId: 'new-owner', busy: true, compacting: true })
      } else {
        expect(h.backend.activeRunId).toBe(activeId)
        expect(h.backend.busy).toBe(phase === 'new-run')
        if (activeId) expect(h.runStore.get(activeId)?.state).toBe('dispatching')
      }
      await h.runStore.flush()
    }
  )

  it.each(['send', 'queue', 'auto', 'promoted'] as const)(
    'does not dispatch %s using stale idle getState after start and compaction', async (path) => {
      const h = await harness()
      const result = deferred<typeof h.state>()
      h.getState.mockImplementationOnce(() => result.promise)
      const queued = path === 'auto' || path === 'promoted' ? h.addQueued('queued') : undefined
      let sending: Promise<void>
      if (path === 'auto') {
        h.bridge.dispatchNextLocalFollowUp(h.backend)
        sending = h.backend.localQueueDispatchPromise!
      } else if (path === 'promoted') sending = h.bridge.sendQueuedMessage('followUp', 0)
      else sending = h.bridge[path]('stale input')
      const observed = sending.catch((error: unknown) => error)
      await dispatchGap()
      h.emit('agent_start')
      h.emit('compaction_start')
      result.resolve({ ...h.state })
      await observed
      expect(h.prompt).not.toHaveBeenCalled()
      expect(h.backend.busy).toBe(true)
      expect(h.backend.compacting).toBe(true)
      expect(h.backend.activeRunId).toBeUndefined()
      if (queued) {
        expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([queued.id])
        expect(h.runStore.get(queued.id)?.state).toBe('queued')
      } else expect(h.runs()).toEqual([])
      await h.runStore.flush()
    }
  )

  it.each(['auto', 'promoted'] as const)(
    'restores only the unsent %s ledger when preparation yields to compaction', async (path) => {
      const h = await harness()
      const queued = h.addQueued('prepared but unsent')
      const gate = deferred<void>()
      const internals = h.bridge as unknown as {
        prepareQueuedRunForDispatch(backend: BackendRecord, runId: string): Promise<void>
      }
      const original = internals.prepareQueuedRunForDispatch.bind(internals)
      vi.spyOn(internals, 'prepareQueuedRunForDispatch').mockImplementationOnce(async (backend, runId) => {
        await original(backend, runId)
        await gate.promise
      })
      let sending: Promise<void>
      if (path === 'auto') {
        h.bridge.dispatchNextLocalFollowUp(h.backend)
        sending = h.backend.localQueueDispatchPromise!
      } else sending = h.bridge.sendQueuedMessage('followUp', 0)
      const observed = sending.catch((error: unknown) => error)
      await dispatchGap()
      expect(h.runStore.get(queued.id)?.state).toBe('dispatching')
      h.emit('compaction_start')
      gate.resolve()
      await observed
      expect(h.prompt).not.toHaveBeenCalled()
      expect(h.runStore.get(queued.id)?.state).toBe('queued')
      expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([queued.id])
      expect(h.backend.busy).toBe(true)
      expect(h.backend.compacting).toBe(true)
      expect(h.backend.localQueueDispatching).toBe(false)
      await h.runStore.flush()
    }
  )

  it.each(['send', 'queue'] as const)('does not dispatch %s after mode preparation starts independent work', async (method) => {
    const h = await harness()
    h.backend.modePrimed = 'plan'
    const result = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => result.promise)
    const observed = h.bridge[method]('unsent work').catch((error: unknown) => error)
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledWith('/plan exit')
    h.emit('agent_start')
    h.emit('compaction_start')
    result.reject(new Error('mode RPC late rejection'))
    await observed
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.runs()).toEqual([])
    expect(h.backend.busy).toBe(true)
    expect(h.backend.compacting).toBe(true)
    await h.runStore.flush()
  })

  it('keeps the prompt reservation recoverable when a second message is locally queued', async () => {
    const h = await harness()
    const result = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => result.promise)
    const first = h.bridge.send('first').catch((error: unknown) => error)
    await dispatchGap()
    const activeId = h.backend.activeRunId!
    await h.bridge.queue('local second')
    result.reject(new Error('event-free failure'))
    await first
    expect(h.backend.busy).toBe(false)
    expect(h.runStore.get(activeId)?.state).toBe('failed')
    expect(h.backend.localFollowUps?.map((item) => item.text)).toEqual(['local second'])
    await h.runStore.flush()
  })

  it('does not delete a new same-text steering marker on late rejection', async () => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const result = deferred<'queued' | 'handled'>()
    h.steer.mockImplementationOnce(() => result.promise)
    const first = h.bridge.send('same').catch((error: unknown) => error)
    await dispatchGap()
    h.emit('queue_update', { steering: [], followUp: [] })
    await h.bridge.send('same')
    result.reject(new Error('late steering rejection'))
    await first
    expect(h.backend.directSteering).toEqual(['same'])
    expect(h.backend.rawQueue?.steering).toEqual(['same'])
    expect(h.backend.busy).toBe(true)
    await h.runStore.flush()
  })

  it('does not requeue a promoted steering item consumed before its late rejection', async () => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const queued = h.addQueued('same')
    const result = deferred<'queued' | 'handled'>()
    h.steer.mockImplementationOnce(() => result.promise)
    const promoted = h.bridge.sendQueuedMessage('followUp', 0).catch((error: unknown) => error)
    await dispatchGap()
    h.emit('queue_update', { steering: [], followUp: [] })
    await h.bridge.send('same')
    result.reject(new Error('late steering rejection'))
    await promoted
    expect(h.backend.localFollowUps).toEqual([])
    expect(h.backend.directSteering).toEqual(['same'])
    expect(h.backend.companionRunIds).toContain(queued.id)
    expect(h.runStore.get(queued.id)?.state).toBe('running')
    await h.runStore.flush()
  })

  it('ignores late handled responses from a replaced backend', async () => {
    const h = await harness()
    const result = deferred<Disposition>()
    h.prompt.mockImplementation(() => result.promise)
    const sending = h.bridge.send('/handled')
    await dispatchGap()
    const replacement = { ...h.backend, activeRunId: 'replacement-run', busy: true }
    h.pool.set(h.backend.key, replacement)
    result.resolve('handled')
    await sending
    expect(replacement.busy).toBe(true)
    expect(replacement.activeRunId).toBe('replacement-run')
    expect(h.runs()[0].state).toBe('dispatching')
    await h.runStore.flush()
  })
})
