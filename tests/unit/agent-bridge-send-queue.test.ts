import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import type { RunOperation } from '../../src/shared/operations'
import { RunStore } from '../../src/main/run-store'

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
}
const roots: string[] = []
afterEach(async () => {
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
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: backend.key, activeCwd: root, runStore,
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
  return { bridge: api, backend, pool, state, runStore, getState, prompt, steer, emit, addQueued, runs }
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
