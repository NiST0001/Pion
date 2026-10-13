import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { BackendRecord } from '../../src/main/agent/types'
import type { RunOperation } from '../../src/shared/operations'
import type { ImageContent, SessionEntriesPage, SessionHistoryIndex, SessionInfo, WireEntry, WireEvent, WireEventInput, WireMessage } from '../../src/shared/types'
import { RunStore } from '../../src/main/run-store'
import { SessionListCache } from '../../src/main/agent/session-list-cache'
import { PendingRequestStore } from '../../src/main/agent/pending-requests'
import { TOOL_PERMISSION_MARKER } from '../../src/main/tool-permissions'

function messageOf(event: WireEventInput): WireMessage {
  if (event.type !== 'message_start' && event.type !== 'message_end') throw new Error('Expected a message lifecycle event')
  return (event as Extract<WireEvent, { type: 'message_start' | 'message_end' }>).message
}

type Disposition = 'started' | 'queued' | 'handled'
interface BridgeHarness {
  abort(): Promise<void>
  send(message: string): Promise<void>
  queue(message: string, images?: ImageContent[]): Promise<void>
  resumeRun(runId: string): Promise<RunOperation>
  startVerificationRepair(sessionPath: string, cwd: string, message: string): Promise<RunOperation | null>
  sendQueuedMessage(kind: 'followUp', index: number): Promise<void>
  editQueuedMessage(request: import('../../src/shared/types').QueuedMessageEditRequest, ownerId: number): import('../../src/shared/types').QueuedMessageEditResult
  dispatchNextLocalFollowUp(backend: BackendRecord): void
  restoreQueuedRuns(backend: BackendRecord): void
  createRun(backend: BackendRecord, state: null, message: string, images: [], kind: 'follow-up', phase: 'queued'): RunOperation
  activeKey: string
  sessionSelectionGeneration: number
  historyRevision: number
  getSessionInfo(): Promise<SessionInfo | null>
  getEntriesPage(before?: number, limit?: number, sessionPath?: string): Promise<SessionEntriesPage | null>
  getHistoryIndex(sessionPath?: string): Promise<SessionHistoryIndex | null>
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
    // Most dispatcher fixtures model an already proven normal settle.
    modePrimed: 'build', pendingRunIds: [], localFollowUps: [], queueAutoReady: true,
    client: { getState, prompt, steer, onEvent: vi.fn((callback: (event: unknown) => void) => { listener = callback }) },
    startPromise: Promise.resolve()
  } as unknown as BackendRecord
  const pool = new Map([[backend.key, backend]])
  const wireSend = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: backend.key, activeCwd: root, runStore,
    sessionSelectionGeneration: 0, historyRevision: 0, yoloSessions: new Set(),
    win: { webContents: { id: 7, send: wireSend } },
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

describe('AgentBridge queue draft retrieval', () => {
  it('takes root images in order by real id after queue positions drift without dispatching other items', async () => {
    const h = await harness()
    const first = h.addQueued('same')
    const second = h.addQueued('same')
    const images = [
      { type: 'image' as const, data: 'first-original', mimeType: 'image/png' },
      { type: 'image' as const, data: 'second-original', mimeType: 'image/jpeg' }
    ]
    h.runStore.update(second.id, (run) => { run.prompt.images = images; run.usageBackendId = 'old-actor' })
    h.backend.localFollowUps![1].images = [] // projection is not the attachment source
    h.backend.queueAutoReady = false
    const scope = { cwd: h.backend.cwd, sessionFile: h.backend.sessionPath }
    h.bridge.editQueuedMessage({ ...scope, runId: first.id }, 7)
    const payload = h.bridge.editQueuedMessage({ ...scope, runId: second.id }, 7)
    expect(payload).toEqual({ runId: second.id, text: 'same', images })
    expect(payload.images).not.toBe(images)
    expect(payload.images[0]).not.toBe(images[0])
    expect(h.backend.localFollowUps).toEqual([])
    expect(h.backend.pendingRunIds).not.toContain(second.id)
    expect(h.backend.queueAutoReady).toBe(false)
    expect(h.runStore.get(second.id)?.state).toBe('discarded')
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
    expect(h.getState).not.toHaveBeenCalled()
    // A lost IPC response can be retried without restoring the item to dispatch.
    expect(h.bridge.editQueuedMessage({ ...scope, runId: second.id }, 7)).toEqual(payload)
    expect(h.backend.localFollowUps).toEqual([])
    await h.runStore.flush()
  })

  it('rejects wrong owner/scope, native identities, attempted runs and items already shifted for dispatch', async () => {
    const h = await harness()
    const run = h.addQueued('same')
    const request = { runId: run.id, cwd: h.backend.cwd }
    expect(() => h.bridge.editQueuedMessage(request, 8)).toThrow()
    expect(() => h.bridge.editQueuedMessage({ ...request, cwd: '/other' }, 7)).toThrow()
    expect(() => h.bridge.editQueuedMessage({ ...request, sessionFile: '/other.jsonl' }, 7)).toThrow()
    expect(() => h.bridge.editQueuedMessage({ ...request, runId: 'native' }, 7)).toThrow()
    h.bridge.activeKey = 'other-backend'
    expect(() => h.bridge.editQueuedMessage(request, 7)).toThrow()
    h.bridge.activeKey = h.backend.key
    h.runStore.update(run.id, (current) => { current.dispatchedAt = 1 })
    expect(() => h.bridge.editQueuedMessage(request, 7)).toThrow()
    h.runStore.update(run.id, (current) => { current.dispatchedAt = undefined })
    const item = h.backend.localFollowUps!.shift()!
    expect(() => h.bridge.editQueuedMessage(request, 7)).toThrow()
    h.backend.localFollowUps!.push(item)
    h.runStore.update(run.id, (current) => { current.state = 'running' })
    expect(() => h.bridge.editQueuedMessage(request, 7)).toThrow()
    expect(h.backend.localFollowUps).toHaveLength(1)
    expect(h.prompt).not.toHaveBeenCalled()
  })
})

describe('AgentBridge immediate Tab enqueue', () => {
  const images: ImageContent[] = [
    { type: 'image', data: 'first-original', mimeType: 'image/png' },
    { type: 'image', data: 'second-original', mimeType: 'image/jpeg' }
  ]

  it.each([
    'busy', 'compacting', 'localQueueDispatching', 'localQueueDispatchPromise',
    'promptDispatch', 'runCompletionPromise', 'localFollowUps'
  ] as const)('takes an editable image draft immediately with %s occupied and no SDK receipt', async guard => {
    const h = await harness()
    // Enqueue/edit is isolated from the automatic pump in this fixture.
    h.backend.queueAutoReady = false
    const never = new Promise<void>(() => undefined)
    if (guard === 'localFollowUps') h.addQueued('older')
    else if (guard === 'promptDispatch') h.backend.promptDispatch = { promise: never, runId: 'current' }
    else if (guard === 'runCompletionPromise' || guard === 'localQueueDispatchPromise') h.backend[guard] = never
    else h.backend[guard] = true
    const ready = h.backend.queueAutoReady
    const beforeIds = h.backend.localFollowUps!.map(item => item.runId)
    h.getState.mockReturnValue(new Promise(() => undefined))
    const internals = h.bridge as unknown as {
      reserveDispatch(backend: BackendRecord): unknown
      syncBackendSession(backend: BackendRecord): Promise<void>
    }
    const reserve = vi.spyOn(internals, 'reserveDispatch')
    const sync = vi.spyOn(internals, 'syncBackendSession').mockReturnValue(never)
    let closed = false
    const queued = h.bridge.queue('draft with images', images).then(() => { closed = true })
    await dispatchGap()
    expect(closed).toBe(true)
    await queued
    expect(h.getState).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
    const item = h.backend.localFollowUps!.at(-1)!
    expect(h.backend.localFollowUps!.map(current => current.runId)).toEqual([...beforeIds, item.runId])
    expect(h.runStore.get(item.runId)).toMatchObject({
      id: item.runId, state: 'queued', prompt: { message: 'draft with images', images }
    })
    expect(h.runStore.get(item.runId)?.dispatchedAt).toBeUndefined()
    expect(h.runStore.get(item.runId)?.prompt.images).not.toBe(images)
    const payload = h.bridge.editQueuedMessage({ runId: item.runId, cwd: h.backend.cwd }, 7)
    expect(payload).toEqual({ runId: item.runId, text: 'draft with images', images })
    expect(payload.images).not.toBe(images)
    expect(payload.images[0]).not.toBe(images[0])
    expect(h.backend.localFollowUps!.map(current => current.runId)).toEqual(beforeIds)
    expect(h.backend.queueAutoReady).toBe(ready)
    expect(h.getState).not.toHaveBeenCalled()
    expect(h.prompt).not.toHaveBeenCalled()
    await h.runStore.flush()
  })

  it.each(['agent_start', 'compaction_start', 'normal settle'] as const)(
    'appends an idle state-read draft after %s changes generation without stealing execution', async boundary => {
      const h = await harness()
      const internals = h.bridge as unknown as { reserveDispatch(backend: BackendRecord): unknown }
      const reserve = vi.spyOn(internals, 'reserveDispatch')
      const receipt = deferred<typeof h.state>()
      h.getState.mockReturnValueOnce(receipt.promise)
      const queued = h.bridge.queue('pending read draft', images)
      await dispatchGap()
      expect(h.getState).toHaveBeenCalledTimes(1)
      expect(reserve).not.toHaveBeenCalled()
      if (boundary === 'normal settle') {
        // A real root run can finish while a previously idle state receipt is pending.
        // Its actual checkpoint receipt still holds completion, preventing an automatic pump.
        Object.assign(h.bridge, { refreshRunCheckpoint: vi.fn(() => new Promise<void>(() => undefined)) })
        const run = h.bridge.createRun(h.backend, null, 'independent root', [], 'follow-up', 'queued')
        h.runStore.update(run.id, current => { current.state = 'running' })
        h.backend.activeRunId = run.id
        h.emit('agent_start')
        h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
        h.emit('agent_settled')
        await dispatchGap()
        // The captured SDK receipt still reports streaming; it must enqueue, not execute.
        receipt.resolve({ ...h.state, isStreaming: true })
      } else {
        h.emit(boundary)
        receipt.resolve({ ...h.state })
      }
      await queued
      const item = h.backend.localFollowUps!.at(-1)!
      expect(h.backend.localFollowUps).toEqual([{ runId: item.runId, text: 'pending read draft', images }])
      expect(h.runStore.get(item.runId)).toMatchObject({ state: 'queued', prompt: { message: 'pending read draft', images } })
      expect(h.runStore.get(item.runId)?.dispatchedAt).toBeUndefined()
      expect(reserve).not.toHaveBeenCalled()
      expect(h.prompt).not.toHaveBeenCalled()
      expect(h.steer).not.toHaveBeenCalled()
      await h.runStore.flush()
    }
  )

  it.each(['owner', 'client'] as const)('rejects an idle state receipt after %s replacement without adding the draft', async replacement => {
    const h = await harness()
    const receipt = deferred<typeof h.state>()
    h.getState.mockReturnValueOnce(receipt.promise)
    const queued = h.bridge.queue('stale owner draft', images)
    const rejected = expect(queued).rejects.toThrow('Agent 会话已关闭')
    await dispatchGap()
    if (replacement === 'owner') h.pool.set(h.backend.key, { ...h.backend })
    else h.backend.client = { ...h.backend.client } as BackendRecord['client']
    receipt.resolve({ ...h.state })
    await rejected
    expect(h.runs()).toEqual([])
    expect(h.backend.localFollowUps).toEqual([])
    expect(h.pool.get(h.backend.key)?.localFollowUps).toEqual([])
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('appends image Tabs when no real settle is known without clearing older items', async () => {
    const h = await harness()
    const older = h.addQueued('older')
    h.backend.queueAutoReady = false
    h.getState.mockReturnValue(new Promise(() => undefined))
    await h.bridge.queue('new draft', images)
    const newer = h.backend.localFollowUps![1]
    expect(h.backend.queueAutoReady).toBe(false)
    expect(h.backend.localFollowUps).toEqual([
      { runId: older.id, text: 'older', images: [] }, { runId: newer.runId, text: 'new draft', images }
    ])
    expect(h.runStore.get(older.id)?.state).toBe('queued')
    expect(h.runStore.get(newer.runId)?.state).toBe('queued')
    expect(h.getState).not.toHaveBeenCalled()
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
    await h.runStore.flush()
  })

  it('keeps two busy image Tabs FIFO until every normal stop, settle and actual RPC receipt closes', async () => {
    const h = await harness()
    const originalReceipt = deferred<Disposition>()
    const firstReceipt = deferred<Disposition>()
    const secondReceipt = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => originalReceipt.promise)
      .mockImplementationOnce(() => firstReceipt.promise)
      .mockImplementationOnce(() => secondReceipt.promise)
    const original = h.bridge.send('original')
    await dispatchGap()
    await h.bridge.queue('same', images)
    const first = h.backend.localFollowUps![0]
    const reversed = [...images].reverse()
    await h.bridge.queue('same', reversed)
    const second = h.backend.localFollowUps![1]
    expect(first.runId).not.toBe(second.runId)
    expect(h.backend.localFollowUps).toEqual([
      { runId: first.runId, text: 'same', images }, { runId: second.runId, text: 'same', images: reversed }
    ])
    expect(h.prompt).toHaveBeenCalledTimes(1)
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    originalReceipt.resolve('started')
    await original
    await dispatchGap()
    expect(h.prompt.mock.calls[1]).toEqual(['same', images])
    expect(h.backend.activeRunId).toBe(first.runId)
    expect(h.backend.localFollowUps!.map(item => item.runId)).toEqual([second.runId])
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    const firstDispatch = h.backend.localQueueDispatchPromise!
    firstReceipt.resolve('started')
    await firstDispatch
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(3)
    expect(h.prompt.mock.calls[2]).toEqual(['same', reversed])
    expect(h.backend.activeRunId).toBe(second.runId)
    expect(h.backend.localFollowUps).toEqual([])
    const secondDispatch = h.backend.localQueueDispatchPromise!
    secondReceipt.resolve('started')
    await secondDispatch
    expect(h.runStore.get(first.runId)?.prompt.images).toEqual(images)
    expect(h.runStore.get(second.runId)?.prompt.images).toEqual(reversed)
    await h.runStore.flush()
  })

  it('does not let Tab steal an automatic dispatcher lease while real mode application awaits its RPC', async () => {
    const h = await harness()
    const first = h.addQueued('already shifted')
    h.backend.modePrimed = 'plan'
    const modeReceipt = deferred<Disposition>()
    const promptReceipt = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => modeReceipt.promise).mockImplementationOnce(() => promptReceipt.promise)
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    const dispatch = h.backend.localQueueDispatchPromise!
    expect(h.prompt.mock.calls).toEqual([['/plan exit']])
    expect(h.backend.localFollowUps).toEqual([])
    expect(h.runStore.get(first.id)?.state).toBe('queued')
    await h.bridge.queue('new image Tab', images)
    const second = h.backend.localFollowUps![0]
    expect(h.backend.localQueueDispatchPromise).toBe(dispatch)
    expect(h.getState).toHaveBeenCalledTimes(1)
    expect(h.backend.localFollowUps).toEqual([{ runId: second.runId, text: 'new image Tab', images }])
    modeReceipt.resolve('started')
    await dispatchGap()
    expect(h.prompt.mock.calls).toEqual([['/plan exit'], ['already shifted', []]])
    expect(h.backend.activeRunId).toBe(first.id)
    expect(h.runStore.get(first.id)?.dispatchedAt).toEqual(expect.any(Number))
    expect(h.backend.localFollowUps!.map(item => item.runId)).toEqual([second.runId])
    promptReceipt.resolve('started')
    await dispatch
    expect(h.prompt).toHaveBeenCalledTimes(2)
    expect(h.runStore.get(second.runId)).toMatchObject({ state: 'queued', prompt: { message: 'new image Tab', images } })
    await h.runStore.flush()
  })
})

describe('AgentBridge latest history window', () => {
  // Wire-shaped fixtures enter at the SDK manager boundary; all parent links
  // are explicit, so getEntriesPage still traverses the real selected branch.
  async function history(records: Array<Partial<WireEntry>>, abandoned: WireEntry[] = []) {
    const h = await harness()
    const entries: WireEntry[] = records.map((record, index) => ({
      type: 'custom', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
      timestamp: '2026-01-01T00:00:00.000Z', ...record
    }))
    const leafId = entries.at(-1)?.id ?? null
    const path = join(h.backend.cwd, 'history.jsonl')
    const open = vi.fn(async () => ({
      getEntries: () => [...entries, ...abandoned] as unknown as SessionEntry[],
      getBranch: () => entries as unknown as SessionEntry[],
      getLeafId: () => leafId
    }))
    Object.assign(h.bridge, {
      resolveListedSession: vi.fn(async () => path), openCurrentSessionManager: open
    })
    return { entries, leafId, page: (before?: number, limit?: number) => h.bridge.getEntriesPage(before, limit, path),
      index: () => h.bridge.getHistoryIndex(path) }
  }

  it.each([
    [5000, 5000], ['5000', 5000], ['2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:00.000Z')],
    [undefined, undefined], ['', undefined], [0, undefined], [NaN, undefined], [Infinity, undefined], ['invalid', undefined]
  ])('indexes the actual message clock independently of entry append time (%j)', async (clock, expected) => {
    const h = await history([{ type: 'message', timestamp: '2030-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'synthetic', timestamp: clock } }])
    const index = await h.index()
    expect(index?.landmarks).toHaveLength(1)
    expect(index?.landmarks[0]).toMatchObject({ entryId: 'entry-0', ordinal: 1,
      timestamp: '2030-01-01T00:00:00.000Z' })
    expect(index?.landmarks[0].messageTimestamp).toBe(expected)
    expect(h.entries[0].message?.timestamp).toBe(clock)
  })

  const metadataTail = () => Array.from({ length: 300 }, (_, index): Partial<WireEntry> =>
    index % 2 ? { customType: 'usage', data: { tokens: index } } : {
      type: 'message', message: { role: 'toolResult', toolCallId: 'call', toolName: 'read',
        content: [{ type: 'text', text: 'result' }], isError: false, timestamp: index }
    })

  it('keeps bounded content and physical cursors while folding the full selected branch tail', async () => {
    const records: Array<Partial<WireEntry>> = [
      ...Array.from({ length: 270 }, (): Partial<WireEntry> => ({
        type: 'message', message: { role: 'user', content: 'older', timestamp: 1 }
      })),
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } }
      ], timestamp: 2 } },
      ...metadataTail(),
      { customType: 'plan-mode-state', data: { enabled: true } },
      { customType: 'pion-task-state', data: { native: 'pion', tasks: [
        { id: 1, subject: 'selected task', status: 'pending' }
      ], nextId: 2 } }
    ]
    const h = await history(records, [{
      type: 'message', id: 'abandoned', parentId: 'entry-0', timestamp: 'date',
      message: { role: 'assistant', content: 'not selected' }
    }])
    const page = await h.page()
    expect(page).toMatchObject({ start: 111, end: records.length, total: records.length,
      leafId: h.leafId, mode: 'plan', taskSnapshot: [{ id: 1, title: 'selected task', status: 'pending' }] })
    expect(page?.entries).toEqual(h.entries.slice(111, 271))
    expect(page?.toolResults).toHaveLength(150)
    expect(page?.toolResults.every((entry) => entry.message?.toolCallId === 'call')).toBe(true)
    const capped = await h.page(undefined, 999)
    expect(capped?.entries).toHaveLength(240)
    expect(capped?.start).toBe(31)
    expect(capped?.end).toBe(records.length)
  })

  it.each<WireMessage>([
    { role: 'user', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }] },
    { role: 'assistant', content: [], stopReason: 'error' },
    { role: 'assistant', content: [], errorMessage: 'provider failed' }
  ])('retains the last displayable message before empty assistants and metadata (%j)', async (message) => {
    const h = await history([
      { type: 'message', message },
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall',
        id: 'child', name: 'read', arguments: {}, parentToolCallId: 'parent' }] } },
      ...metadataTail()
    ])
    expect(await h.page()).toMatchObject({ entries: [h.entries[0]], start: 0, end: 303, total: 303 })
  })

  it('retains compaction summaries, including an empty summary string', async () => {
    const h = await history([{ type: 'compaction', summary: '' }, ...metadataTail()])
    expect(await h.page()).toMatchObject({ entries: [h.entries[0]], start: 0, end: 301 })
  })

  it('returns successful empty windows for entirely non-displayable and genuinely empty branches', async () => {
    for (const records of [[], metadataTail(), [
      { type: 'custom_message', customType: 'notice', content: 'not a transcript row', display: true },
      { type: 'model_change', provider: 'openai', modelId: 'model' },
      { type: 'message', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request aborted' } },
      { type: 'message', message: { role: 'assistant', content: [], stopReason: 'stop', errorMessage: 'stale failure' } }
    ]] as Array<Array<Partial<WireEntry>>>) {
      const h = await history(records)
      expect(await h.page()).toMatchObject({ entries: [], toolResults: [], start: 0,
        end: records.length, total: records.length, leafId: h.leafId })
    }
  })

  it('preserves explicit physical paging, including non-finite numeric cursors', async () => {
    const h = await history([{ type: 'message', message: { role: 'user', content: 'question' } }, ...metadataTail()])
    for (const before of [0, 20, 301, 999, Infinity, NaN]) {
      const end = Number.isFinite(before) ? Math.min(Math.max(Math.trunc(before), 0), 301) : 301
      const start = Math.max(0, end - 160)
      expect(await h.page(before)).toMatchObject({ entries: h.entries.slice(start, end), start, end, total: 301 })
    }
  })
})

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
  async function interactionHarness() {
    const h = await harness()
    const writes = vi.fn()
    Object.assign(h.backend.client, { process: { stdin: { writable: true, write: writes } } })
    Object.assign(h.bridge, {
      pendingRequests: new PendingRequestStore({
        pushToolPermissionRequests: () => undefined, pushExtensionUiRequests: () => undefined
      }),
      pushToolPermissionRequests: vi.fn(), pushExtensionUiRequests: vi.fn(),
      notifyToolPermissionRequested: vi.fn()
    })
    const bridge = h.bridge as unknown as AgentBridge
    const handle = (event: unknown) => (bridge as unknown as {
      handleExtensionUiRequest(backend: BackendRecord, event: unknown): boolean
    }).handleExtensionUiRequest(h.backend, event)
    const ask = (timeout = 60_000, method: 'input' | 'confirm' = 'input') => {
      handle({ type: 'extension_ui_request', id: 'ask', method, title: 'Question',
        ...(method === 'confirm' ? { message: 'Proceed?' } : {}), timeout })
      return bridge.getPendingExtensionUiRequests()[0].id
    }
    const permission = (timeout = 60_000) => {
      handle({ type: 'extension_ui_request', id: 'permission', method: 'select', timeout,
        title: `${TOOL_PERMISSION_MARKER}${JSON.stringify({ cwd: h.backend.cwd, toolName: 'write',
          category: 'write', policyCategories: ['write'], summary: 'write file', detail: 'file',
          risks: [], canRemember: false })}` })
      return bridge.getPendingToolPermissionRequests()[0].id
    }
    return { ...h, interactionBridge: bridge, writes, ask, permission }
  }

  it.each(['cancel', 'blank', 'negative', 'deny'] as const)(
    'does not latch on %s and auto-dispatches only after normal settle and checkpoint cleanup', async (response) => {
      const h = await interactionHarness()
      const completion = deferred<void>()
      Object.assign(h.bridge, { refreshRunCheckpoint: vi.fn(() => completion.promise) })
      await h.bridge.send('first')
      const firstId = h.backend.activeRunId!
      h.emit('agent_start')
      const queued = h.addQueued('later')
      if (response === 'deny') {
        await h.interactionBridge.resolveToolPermission(h.permission(), 'deny')
        expect(JSON.parse(h.writes.mock.calls[0][0])).toMatchObject({ id: 'permission', value: 'deny' })
      } else {
        await h.interactionBridge.resolveExtensionUiRequest(h.ask(60_000, response === 'negative' ? 'confirm' : 'input'),
          response === 'cancel' ? { cancelled: true } : response === 'blank' ? { value: '   ' } : { confirmed: false })
      }
      expect(h.backend.turnInterrupted).not.toBe(true)
      expect(h.backend.queueAutoReady).toBe(false)
      expect(h.prompt).toHaveBeenCalledTimes(1)
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
      await dispatchGap()
      expect(h.prompt).toHaveBeenCalledTimes(1)
      h.emit('agent_settled')
      await dispatchGap()
      expect(h.runStore.get(firstId)?.state).toBe('completed')
      expect(h.prompt).toHaveBeenCalledTimes(1)
      completion.resolve()
      await dispatchGap()
      expect(h.prompt).toHaveBeenNthCalledWith(2, 'later', [])
      expect(h.backend.activeRunId).toBe(queued.id)
      await h.runStore.flush()
    }
  )

  it.each(['tool-error', 'deny-tool-error', 'question-timeout', 'permission-timeout'] as const)(
    'advances one FIFO item after %s actually settles, not at the error or agent_end', async (failure) => {
      const h = await interactionHarness()
      vi.useFakeTimers()
      await h.bridge.send('first')
      const firstId = h.backend.activeRunId!
      h.emit('agent_start')
      if (failure === 'tool-error' || failure === 'deny-tool-error') {
        h.emit('tool_execution_start', { toolCallId: 'write-call', toolName: 'write' })
        if (failure === 'deny-tool-error') {
          await h.interactionBridge.resolveToolPermission(h.permission(), 'deny')
          expect(h.backend.turnInterrupted).not.toBe(true)
        }
        h.emit('tool_execution_end', { toolCallId: 'write-call', toolName: 'write', isError: true })
      } else {
        if (failure === 'question-timeout') h.ask(1_000)
        else h.permission(1_000)
        await vi.advanceTimersByTimeAsync(1_250)
        expect(failure === 'question-timeout' ? h.interactionBridge.getPendingExtensionUiRequests()
          : h.interactionBridge.getPendingToolPermissionRequests()).toEqual([])
      }
      expect(h.backend.turnInterrupted).toBe(true)
      const queued = h.addQueued('later')
      const last = h.addQueued('last')
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
      await dispatchGap()
      expect(h.prompt).toHaveBeenCalledTimes(1)
      h.emit('agent_settled')
      await dispatchGap()
      expect(h.prompt).toHaveBeenNthCalledWith(2, 'later', [])
      expect(h.prompt).toHaveBeenCalledTimes(2)
      expect(h.runStore.get(firstId)?.state).toBe('interrupted')
      expect(h.backend.activeRunId).toBe(queued.id)
      expect(h.runStore.get(last.id)?.state).toBe('queued')
      await h.runStore.flush()
    }
  )

  it.each([
    ['cancel', 'unknown'], ['deny', 'unknown'], ['cancel', 'tool-error'], ['deny', 'tool-error'],
    ['cancel', 'timeout'], ['deny', 'timeout']
  ] as const)('ordinary %s after an ended %s turn does not suppress later FIFO settlement', async (response, failure) => {
    const h = await interactionHarness()
    vi.useFakeTimers()
    await h.bridge.send('first')
    h.emit('agent_start')
    if (failure === 'tool-error') {
      h.emit('tool_execution_start', { toolCallId: 'old-call', toolName: 'read' })
      h.emit('tool_execution_end', { toolCallId: 'old-call', toolName: 'read', isError: true })
    } else if (failure === 'timeout') {
      h.ask(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    h.emit('agent_settled')
    await dispatchGap()
    await h.bridge.send('manual recovery')
    h.emit('agent_start')
    const queued = h.addQueued('later')
    if (response === 'cancel') await h.interactionBridge.resolveExtensionUiRequest(h.ask(), { cancelled: true })
    else await h.interactionBridge.resolveToolPermission(h.permission(), 'deny')
    expect(h.backend.turnInterrupted).toBe(false)
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(3)
    expect(h.runStore.get(queued.id)?.state).toBe('dispatching')
    await h.runStore.flush()
  })

  it.each([undefined, 'length', 'toolUse', 'unknown', 'aborted', 'error'])(
    'advances one queued item on actual settled regardless of terminal stop classification (%s)', async (stopReason) => {
      const h = await harness()
      await h.bridge.send('first')
      const firstId = h.backend.activeRunId!
      h.emit('agent_start')
      const queued = h.addQueued('later')
      if (stopReason !== undefined) h.emit('agent_end', { messages: [{ role: 'assistant', stopReason }] })
      h.emit('agent_settled')
      await dispatchGap()
      h.bridge.dispatchNextLocalFollowUp(h.backend)
      await dispatchGap()
      expect(h.prompt).toHaveBeenCalledTimes(2)
      expect(h.runStore.get(firstId)?.state).not.toBe('completed')
      expect(h.backend.activeRunId).toBe(queued.id)
      await h.runStore.flush()
    }
  )

  it.each(['checkpoint', 'listener'] as const)(
    'advances one FIFO after a rejected %s receipt actually ends, retaining diagnostics', async source => {
      const h = await harness()
      const receipt = deferred<void>()
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      if (source === 'checkpoint') Object.assign(h.bridge, { refreshRunCheckpoint: vi.fn(() => receipt.promise) })
      else Object.assign(h.bridge, { runCompletedListeners: new Set([() => receipt.promise]) })
      await h.bridge.send('first')
      h.emit('agent_start')
      const next = h.addQueued('next')
      const remaining = h.addQueued('remaining')
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
      h.emit('agent_settled')
      await dispatchGap()
      expect(h.prompt).toHaveBeenCalledTimes(1)
      receipt.reject(new Error('cleanup failed'))
      await dispatchGap()
      expect(diagnostic).toHaveBeenCalled()
      diagnostic.mockRestore()
      expect(h.prompt).toHaveBeenCalledTimes(2)
      expect(h.backend.activeRunId).toBe(next.id)
      expect(h.runStore.get(remaining.id)?.state).toBe('queued')
      await h.runStore.flush()
    }
  )

  it.each([
    ['checkpointCreatePromise', 'error'], ['checkpointRefreshPromise', 'error'],
    ['checkpointCreatePromise', 'aborted'], ['checkpointRefreshPromise', 'aborted']
  ] as const)('holds %s after ended %s until its actual receipt closes', async (slot, reason) => {
    const h = await harness()
    const receipt = deferred<void>()
    await h.bridge.send('first')
    h.emit('agent_start')
    h.backend[slot] = receipt.promise as never
    void receipt.promise.then(() => { h.backend[slot] = undefined })
    const next = h.addQueued('next')
    const remaining = h.addQueued('remaining')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: reason, content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    receipt.resolve()
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    expect(h.backend.activeRunId).toBe(next.id)
    expect(h.runStore.get(remaining.id)?.state).toBe('queued')
    await h.runStore.flush()
  })

  it.each(['state', 'preparation'] as const)('retains an unsent item without spinning after %s fails before invocation', async source => {
    const h = await harness()
    const first = h.addQueued('first')
    h.addQueued('second')
    if (source === 'state') h.getState.mockRejectedValueOnce(new Error('state unavailable'))
    else vi.spyOn(h.bridge as unknown as { prepareQueuedRunForDispatch(...args: unknown[]): Promise<void> },
      'prepareQueuedRunForDispatch').mockRejectedValueOnce(new Error('preparation failed'))
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await h.backend.localQueueDispatchPromise
    await dispatchGap()
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.getState).toHaveBeenCalledTimes(1)
    expect(h.backend.localFollowUps?.[0].runId).toBe(first.id)
    expect(h.runStore.get(first.id)?.dispatchedAt).toBeUndefined()
    expect(h.runStore.get(first.id)?.state).toBe('queued')
    await h.bridge.send('explicit new input')
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenNthCalledWith(2, 'first', [])
    expect(h.backend.activeRunId).toBe(first.id)
    await h.runStore.flush()
  })

  it('does not let a late queued RPC receipt borrow settlement across an independent compaction generation', async () => {
    const h = await harness()
    const receipt = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => receipt.promise)
    h.addQueued('first')
    const remaining = h.addQueued('remaining')
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    const dispatch = h.backend.localQueueDispatchPromise!
    await dispatchGap()
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', content: [] }] })
    h.emit('agent_settled')
    h.emit('compaction_start')
    h.emit('compaction_end', { reason: 'manual' })
    receipt.resolve('started')
    await dispatch
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.runStore.get(remaining.id)?.state).toBe('queued')
    await h.runStore.flush()
  })

  it('requires actual normal settle and completion listeners before auto dispatch', async () => {
    const h = await harness()
    const gate = deferred<void>()
    Object.assign(h.bridge, { runCompletedListeners: new Set([() => gate.promise]) })
    await h.bridge.send('first')
    h.emit('agent_start')
    h.addQueued('later')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.backend.runCompletionPromise).toBeDefined()
    gate.resolve()
    await dispatchGap()
    expect(h.prompt).toHaveBeenLastCalledWith('later', [])
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it.each(['rpc-first', 'completion-first'] as const)(
    'pumps one follow-up after normal settle only when both pending leases close (%s)', async (order) => {
      const h = await harness()
      const rpc = deferred<Disposition>()
      const completion = deferred<void>()
      h.prompt.mockImplementationOnce(() => rpc.promise)
      Object.assign(h.bridge, { refreshRunCheckpoint: vi.fn(() => completion.promise) })
      const first = h.addQueued('first')
      const second = h.addQueued('second')
      const third = h.addQueued('third')
      h.bridge.dispatchNextLocalFollowUp(h.backend)
      const dispatch = h.backend.localQueueDispatchPromise!
      await dispatchGap()
      h.emit('agent_start')
      // Task snapshots are display state, not queue completion evidence or gates.
      h.emit('entry_appended', { entry: { type: 'custom', customType: 'pion-task-state', data: {
        native: 'pion', tasks: [{ id: 1, subject: 'unfinished task', status: 'pending' }], nextId: 2
      } } })
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
      h.emit('agent_settled')
      await dispatchGap()
      expect(h.runStore.get(first.id)?.state).toBe('completed')
      expect(h.backend.localQueueDispatchPromise).toBe(dispatch)
      expect(h.prompt).toHaveBeenCalledTimes(1)
      if (order === 'rpc-first') {
        rpc.resolve('started')
        await dispatch
        await dispatchGap()
        expect(h.backend.runCompletionPromise).toBeDefined()
        expect(h.prompt).toHaveBeenCalledTimes(1)
        completion.resolve()
      } else {
        completion.resolve()
        await dispatchGap()
        expect(h.backend.localQueueDispatchPromise).toBe(dispatch)
        expect(h.prompt).toHaveBeenCalledTimes(1)
        rpc.resolve('started')
        await dispatch
      }
      await dispatchGap()
      expect(h.prompt).toHaveBeenNthCalledWith(2, 'second', [])
      expect(h.prompt).toHaveBeenCalledTimes(2)
      expect(h.backend.activeRunId).toBe(second.id)
      expect(h.runStore.get(third.id)?.state).toBe('queued')
      await h.runStore.flush()
    }
  )

  it('does not pump a new generation when an older settled auto-dispatch RPC closes', async () => {
    const h = await harness()
    const rpc = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => rpc.promise)
    h.addQueued('first')
    const remaining = h.addQueued('remaining')
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    const dispatch = h.backend.localQueueDispatchPromise!
    await dispatchGap()
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    await dispatchGap()
    h.emit('agent_start')
    rpc.resolve('handled')
    await dispatch
    await dispatchGap()
    expect(h.backend.busy).toBe(true)
    expect(h.backend.activeRunId).toBeUndefined()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.runStore.get(remaining.id)?.state).toBe('queued')
    await h.runStore.flush()
  })

  it('retains the ended interrupted run but never persists an empty-queue dispatch lock', async () => {
    const h = await harness()
    await h.bridge.send('interrupted task')
    const original = h.backend.activeRunId!
    h.emit('agent_start')
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.backend.queueAutoReady).toBe(true)
    await h.runStore.flush()
    const restored = new RunStore(h.runStore.filePath)
    await restored.load()
    expect(restored.get(original)?.state).toBe('interrupted')
    await h.bridge.queue('new input')
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it.each(['checkpoint', 'listener'] as const)(
    'dispatches one item only after the last actual %s closes with RPC already settled', async last => {
      const h = await harness()
      await h.bridge.send('interrupted task')
      h.emit('agent_start')
      h.emit('agent_settled')
      await dispatchGap()
      const checkpoint = deferred<void>()
      const listener = deferred<void>()
      const completedListener = vi.fn(() => listener.promise)
      Object.assign(h.bridge, {
        refreshRunCheckpoint: vi.fn(() => checkpoint.promise),
        runCompletedListeners: new Set([completedListener])
      })
      await h.bridge.send('manual recovery')
      expect(h.backend.promptDispatch).toBeUndefined()
      const queued = h.addQueued('next')
      const remaining = h.addQueued('remaining')
      h.emit('agent_start')
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
      h.emit('agent_settled')
      await dispatchGap()
      expect(h.backend.localFollowUps).toHaveLength(2)
      expect(h.prompt).toHaveBeenCalledTimes(2)
      expect(h.backend.runCompletionPromise).toBeDefined()
      expect(completedListener).not.toHaveBeenCalled()
      if (last === 'checkpoint') listener.resolve()
      checkpoint.resolve()
      await dispatchGap()
      expect(completedListener).toHaveBeenCalledTimes(1)
      if (last === 'listener') {
        expect(h.prompt).toHaveBeenCalledTimes(2)
        expect(h.backend.runCompletionPromise).toBeDefined()
        listener.resolve()
        await dispatchGap()
      }
      expect(h.backend.runCompletionPromise).toBeUndefined()
      expect(h.prompt).toHaveBeenCalledTimes(3)
      expect(h.backend.activeRunId).toBe(queued.id)
      expect(h.runStore.get(remaining.id)?.state).toBe('queued')
      await h.runStore.flush()
    }
  )

  it.each(['owner', 'client', 'generation', 'promise'] as const)(
    'does not let old completion cleanup dispatch after %s changes', async change => {
      const h = await harness()
      const listener = deferred<void>()
      Object.assign(h.bridge, { runCompletedListeners: new Set([() => listener.promise]) })
      await h.bridge.send('first')
      h.emit('agent_start')
      const queued = h.addQueued('next')
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
      h.emit('agent_settled')
      await dispatchGap()
      expect(h.backend.runCompletionPromise).toBeDefined()
      if (change === 'owner') h.pool.set(h.backend.key, { ...h.backend })
      else if (change === 'client') h.backend.client = { ...h.backend.client } as BackendRecord['client']
      else if (change === 'generation') { h.emit('compaction_start'); h.emit('compaction_end') }
      else h.backend.runCompletionPromise = Promise.resolve()
      listener.resolve()
      await dispatchGap()
      expect(h.prompt).toHaveBeenCalledTimes(1)
      expect(h.runStore.get(queued.id)?.state).toBe('queued')
      await h.runStore.flush()
    }
  )

  it('manual promotion sends one item and its real settlement automatically advances the remaining FIFO', async () => {
    const h = await harness()
    h.backend.queueAutoReady = false
    const selected = h.addQueued('selected')
    const remaining = h.addQueued('remaining')
    await h.bridge.sendQueuedMessage('followUp', 0)
    expect(h.prompt).toHaveBeenCalledWith('selected', [])
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.runStore.get(selected.id)?.state).toBe('completed')
    expect(h.backend.activeRunId).toBe(remaining.id)
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it('explicit run resume waits for real settlement before advancing FIFO', async () => {
    const h = await harness()
    await h.bridge.send('interrupted task')
    const sourceId = h.backend.activeRunId!
    h.emit('agent_start')
    h.emit('agent_settled')
    const queued = h.addQueued('after resume')
    const resumed = await h.bridge.resumeRun(sourceId)
    expect(resumed.recoveredFromRunId).toBe(sourceId)
    expect(h.backend.queueAutoReady).toBe(false)
    expect(h.runStore.get(queued.id)?.state).toBe('queued')
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenLastCalledWith('after resume', [])
    await h.runStore.flush()
  })

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
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    expect(h.backend.busy).toBe(false)
    expect(h.runs()[0].state).toBe('completed')
    await h.runStore.flush()
  })

  it.each(['started', 'handled'] as const)('does not reopen a fast-finished run on late %s acceptance', async (disposition) => {
    const h = await harness()
    h.prompt.mockImplementation(async () => {
      h.emit('agent_start')
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
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

  it('does not auto-advance after handled without actual settlement', async () => {
    const h = await harness()
    const first = h.addQueued('first')
    const second = h.addQueued('second')
    h.prompt.mockResolvedValue('handled')
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    while (h.backend.localQueueDispatchPromise) await h.backend.localQueueDispatchPromise
    expect(h.prompt).toHaveBeenNthCalledWith(1, 'first', [])
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.runStore.get(first.id)?.state).toBe('discarded')
    expect(h.runStore.get(second.id)?.state).toBe('queued')
    expect(h.backend.pendingRunIds).toEqual([second.id])
    expect(h.backend.queueAutoReady).toBe(false)
    expect(h.backend.busy).toBe(false)
    expect(h.backend.localQueueDispatching).toBe(false)
    await h.runStore.flush()
  })

  it.each(['auto', 'promoted'] as const)('isolates a rejected %s RPC without requeuing or releasing busy', async (path) => {
    const h = await harness()
    const queued = h.addQueued('same')
    const remaining = h.addQueued('same')
    h.prompt.mockRejectedValueOnce(new Error('network disconnected'))
    if (path === 'auto') {
      h.bridge.dispatchNextLocalFollowUp(h.backend)
      await h.backend.localQueueDispatchPromise
    } else await expect(h.bridge.sendQueuedMessage('followUp', 0)).rejects.toThrow('network disconnected')
    expect(h.backend.activeRunId).toBe(queued.id)
    expect(h.backend.busy).toBe(true)
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([remaining.id])
    expect(h.backend.pendingRunIds).not.toContain(queued.id)
    expect(h.runStore.get(queued.id)).toMatchObject({ state: 'interrupted', dispatchedAt: expect.any(Number),
      interruptedAt: expect.any(Number) })
    expect(h.runStore.get(queued.id)?.settledAt).toBeUndefined()
    expect(h.backend.queueAutoReady).toBe(false)
    await h.bridge.send('new')
    expect(h.prompt).toHaveBeenCalledTimes(1)
    h.emit('agent_start')
    expect(h.backend.activeRunId).toBe(queued.id)
    expect(h.runStore.get(queued.id)?.state).toBe('running')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.backend.busy).toBe(true)
    expect(h.backend.activeRunId).toBe(remaining.id)
    expect(h.prompt).toHaveBeenCalledTimes(2)
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
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
    h.emit('agent_settled')
    await dispatchGap()
    await h.bridge.send('new run')
    expect(h.backend.localFollowUps?.map(item => item.text)).toEqual(['new run'])
    // Only a real new lifecycle, not a second send during pending RPC, owns busy.
    h.emit('agent_start')
    const activeId = h.backend.activeRunId
    result.resolve('handled')
    await first
    expect(h.backend.activeRunId).toBe(activeId)
    expect(h.backend.busy).toBe(true)
    expect(activeId).toBeUndefined()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.backend.localFollowUps?.map(item => item.text)).toEqual(['new run'])
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
        h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
        h.emit('agent_settled')
        await dispatchGap()
        if (phase === 'new-run') {
          await h.bridge.send('new run')
          expect(h.backend.localFollowUps?.map(item => item.text)).toEqual(['new run'])
          h.emit('agent_start')
        }
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
      } else if (path === 'queue') {
        expect(await observed).toBeUndefined()
        expect(h.runs()).toHaveLength(1)
        expect(h.runs()[0]).toMatchObject({ state: 'queued', prompt: { message: 'stale input', images: [] } })
        expect(h.backend.localFollowUps).toEqual([{ runId: h.runs()[0].id, text: 'stale input', images: [] }])
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
    expect(h.backend.busy).toBe(true)
    expect(h.runStore.get(activeId)?.state).toBe('interrupted')
    expect(h.runStore.get(activeId)?.dispatchedAt).toEqual(expect.any(Number))
    expect(h.backend.localFollowUps?.map((item) => item.text)).toEqual(['local second'])
    await h.runStore.flush()
  })

  it.each([
    ['direct', 'queued'], ['direct', 'reject'], ['promoted', 'queued'], ['promoted', 'reject']
  ] as const)('holds a pending %s steering RPC after SDK settlement until it really %s', async (path, outcome) => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const receipt = deferred<'queued' | 'handled'>()
    h.steer.mockImplementationOnce(() => receipt.promise)
    if (path === 'promoted') h.addQueued('inserted')
    const sending = (path === 'direct' ? h.bridge.send('inserted')
      : h.bridge.sendQueuedMessage('followUp', 0)).catch((error: unknown) => error)
    await dispatchGap()
    const remaining = h.addQueued('remaining')
    h.state.isStreaming = false
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.backend.steeringDispatchPromises?.size).toBe(1)
    expect(h.backend.runCompletionPromise).toBeDefined()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    if (outcome === 'reject') receipt.reject(new Error('late steering transport failure'))
    else receipt.resolve('queued')
    await sending
    await dispatchGap()
    expect(h.backend.steeringDispatchPromises?.size).toBe(0)
    expect(h.prompt).toHaveBeenCalledTimes(2)
    expect(h.backend.activeRunId).toBe(remaining.id)
    expect(h.runStore.list({ limit: 100 }).filter(run => run.state === 'queued')).toEqual([])
    await h.runStore.flush()
  })

  it('does not expose an uncertain direct insertion as an unsent queue item', async () => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const result = deferred<'queued' | 'handled'>()
    h.steer.mockImplementationOnce(() => result.promise)
    const sending = h.bridge.send('inserted').catch((error: unknown) => error)
    await dispatchGap()
    h.emit('queue_update', { steering: ['inserted'], followUp: [] })
    result.reject(new Error('network disconnected'))
    await sending
    expect(h.backend.directSteering).toEqual(['inserted'])
    expect(h.backend.queueAutoReady).toBe(false)
    expect(h.backend.busy).toBe(true)
    expect(h.backend.localFollowUps ?? []).toEqual([])
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

  it.each(['completed', 'failed'] as const)('preserves an already %s queued-card ledger on manual steering', async (terminal) => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const queued = h.addQueued('already ran')
    h.runStore.update(queued.id, (run) => {
      run.state = terminal
      run.dispatchedAt = 1
      run.usage.total = 12
      run.tools.push({ toolCallId: 'tool', name: 'read', state: 'completed', startedAt: 1 })
    })
    const before = h.runStore.get(queued.id)
    await expect(h.bridge.sendQueuedMessage('followUp', 0)).rejects.toThrow('不能作为未发送消息重发')
    expect(h.runStore.get(queued.id)).toEqual(before)
    expect(h.steer).not.toHaveBeenCalled()
    await h.runStore.flush()
  })

  it('retains a rejected promoted steering input as unknown, not unsent', async () => {
    const h = await harness()
    await h.bridge.send('active')
    h.emit('agent_start')
    h.state.isStreaming = true
    const first = h.addQueued('same')
    const second = h.addQueued('same')
    h.steer.mockRejectedValueOnce(new Error('network disconnected'))
    await expect(h.bridge.sendQueuedMessage('followUp', 0)).rejects.toThrow('network disconnected')
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([second.id])
    expect(h.backend.pendingRunIds).not.toContain(first.id)
    expect(h.backend.companionRunIds).toContain(first.id)
    expect(h.runStore.get(first.id)).toMatchObject({ state: 'interrupted', dispatchedAt: expect.any(Number) })
    expect(h.backend.busy).toBe(true)
    expect(h.backend.queueAutoReady).toBe(false)
    expect(h.backend.directSteering).toEqual(['same'])
    const snapshots = h.wireSend.mock.calls.map(([, event]) => event).filter(event => event.type === 'queue_update')
    expect(snapshots.at(-1)?.steering).toEqual([])
    await h.runStore.flush()
  })

  it.each(['auto', 'promoted'] as const)('does not misclassify an internal %s lease rejection as an invoked RPC', async (path) => {
    const h = await harness()
    const queued = h.addQueued('unsent')
    const internals = h.bridge as unknown as { dispatchPrompt(...args: unknown[]): Promise<void> }
    const original = internals.dispatchPrompt.bind(internals)
    vi.spyOn(internals, 'dispatchPrompt').mockImplementationOnce(async (...args) => {
      h.emit('compaction_start')
      await original(...args)
    })
    if (path === 'auto') {
      h.bridge.dispatchNextLocalFollowUp(h.backend)
      await h.backend.localQueueDispatchPromise
    } else await expect(h.bridge.sendQueuedMessage('followUp', 0)).rejects.toThrow()
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.runStore.get(queued.id)?.state).toBe('queued')
    expect(h.runStore.get(queued.id)?.dispatchedAt).toBeUndefined()
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([queued.id])
    expect(h.backend.busy).toBe(true)
    await h.runStore.flush()
  })

  it.each(['auto', 'promoted'] as const)('does not let late rejected %s RPCs rewrite a replacement owner', async (path) => {
    const h = await harness()
    const first = h.addQueued('same')
    const second = h.addQueued('same')
    const result = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => result.promise)
    let sending: Promise<void>
    if (path === 'auto') {
      h.bridge.dispatchNextLocalFollowUp(h.backend)
      sending = h.backend.localQueueDispatchPromise!
    } else sending = h.bridge.sendQueuedMessage('followUp', 0)
    const observed = sending.catch((error: unknown) => error)
    await dispatchGap()
    const replacement = { ...h.backend, activeRunId: 'new-owner', busy: true }
    h.pool.set(h.backend.key, replacement)
    const before = h.runStore.get(first.id)
    result.reject(new Error('old RPC rejection'))
    await observed
    expect(h.runStore.get(first.id)).toEqual(before)
    expect(replacement.activeRunId).toBe('new-owner')
    expect(replacement.busy).toBe(true)
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual([second.id])
    await h.runStore.flush()
  })

  it.each(['dispatchedAt', 'agentStartedAt', 'tools'] as const)('restores only truly unsent IDs, excluding queued records with %s evidence', async (evidence) => {
    const h = await harness()
    const old = h.addQueued('same')
    const unsent = h.addQueued('same')
    const duplicate = h.addQueued('same')
    const images = [{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' }]
    h.runStore.update(unsent.id, (run) => { run.prompt.images = images })
    h.runStore.update(old.id, (run) => {
      if (evidence === 'tools') run.tools.push({ toolCallId: 'real-tool', name: 'read', state: 'completed', startedAt: 1 })
      else run[evidence] = 1
      run.usage.total = 12
    })
    await h.runStore.flush()
    const restored = new RunStore(h.runStore.filePath)
    await restored.load()
    Object.assign(h.bridge, { runStore: restored })
    h.backend.localFollowUps = []
    h.backend.pendingRunIds = []
    h.bridge.restoreQueuedRuns(h.backend)
    h.bridge.restoreQueuedRuns(h.backend)
    expect(h.backend.localFollowUps).toHaveLength(2)
    expect(h.backend.localFollowUps?.map((item) => item.runId)).toEqual(expect.arrayContaining([unsent.id, duplicate.id]))
    expect(h.backend.localFollowUps?.find((item) => item.runId === unsent.id)?.images).toEqual(images)
    expect(restored.get(old.id)).toMatchObject({ state: 'interrupted', usage: { total: 12 } })
    if (evidence === 'tools') expect(restored.get(old.id)?.tools).toHaveLength(1)
    else expect(restored.get(old.id)?.[evidence]).toBe(1)
    expect(h.prompt).not.toHaveBeenCalled()
    await restored.flush()
  })

  it.each(['send', 'idle queue', 'promoted'] as const)('holds the actual %s RPC through an early SDK settle', async path => {
    const h = await harness()
    const receipt = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => receipt.promise)
    let sending: Promise<void>
    if (path === 'promoted') {
      h.addQueued('first')
      sending = h.bridge.sendQueuedMessage('followUp', 0)
    } else sending = path === 'send' ? h.bridge.send('first') : h.bridge.queue('first')
    await dispatchGap()
    await h.bridge.queue('second')
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.backend.promptDispatch).toBeDefined()
    expect(h.backend.busy).toBe(true)
    receipt.resolve('started')
    await sending
    await dispatchGap()
    expect(h.backend.promptDispatch).toBeUndefined()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it.each([
    ['RPC first', 'error'], ['settled first', 'error'],
    ['RPC first', 'aborted'], ['settled first', 'aborted'],
    ['RPC first', 'stop'], ['settled first', 'stop']
  ] as const)('advances exactly one FIFO after both real receipts close (%s, %s)', async (order, reason) => {
    const h = await harness()
    const receipt = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => receipt.promise)
    const sending = h.bridge.send('original')
    await dispatchGap()
    const originalId = h.backend.activeRunId!
    h.emit('agent_start')
    const queued = h.addQueued('next')
    const remaining = h.addQueued('remaining')
    if (order === 'RPC first') { receipt.resolve('started'); await sending }
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: reason, content: [] }] })
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    h.emit('agent_settled')
    await dispatchGap()
    if (order === 'settled first') {
      expect(h.prompt).toHaveBeenCalledTimes(1)
      expect(h.backend.promptDispatch).toBeDefined()
      receipt.resolve('started')
      await sending
      await dispatchGap()
    }
    expect(h.prompt).toHaveBeenCalledTimes(2)
    expect(h.runStore.get(originalId)?.state).toBe(reason === 'error' ? 'failed' : reason === 'aborted' ? 'aborted' : 'completed')
    expect(h.backend.activeRunId).toBe(queued.id)
    expect(h.runStore.get(remaining.id)?.state).toBe('queued')
    await h.runStore.flush()
  })

  it.each(['fulfilled', 'rejected'] as const)('waits for actual abort %s after owned settlement before sending one FIFO item', async outcome => {
    const h = await harness()
    const receipt = deferred<void>()
    Object.assign(h.backend.client, { abort: vi.fn(() => receipt.promise) })
    await h.bridge.send('original')
    h.emit('agent_start')
    const next = h.addQueued('next')
    const remaining = h.addQueued('remaining')
    const aborting = h.bridge.abort()
    const result = outcome === 'rejected' ? expect(aborting).rejects.toThrow('abort rejected') : aborting
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.backend.busy).toBe(true)
    expect(h.backend.controlDispatchPromises?.size).toBe(1)
    if (outcome === 'rejected') receipt.reject(new Error('abort rejected'))
    else receipt.resolve()
    await result
    await dispatchGap()
    expect(h.backend.controlDispatchPromises?.size).toBe(0)
    expect(h.prompt).toHaveBeenCalledTimes(2)
    expect(h.backend.activeRunId).toBe(next.id)
    expect(h.runStore.get(remaining.id)?.state).toBe('queued')
    await h.runStore.flush()
  })

  it.each(['abort-first', 'completion-first'] as const)('includes late abort beyond the captured settlement receipt list (%s)', async order => {
    const h = await harness()
    const completion = deferred<void>()
    const receipt = deferred<void>()
    Object.assign(h.bridge, { refreshRunCheckpoint: vi.fn(() => completion.promise) })
    Object.assign(h.backend.client, { abort: vi.fn(() => receipt.promise) })
    await h.bridge.send('original')
    h.emit('agent_start')
    h.addQueued('next')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    const aborting = h.bridge.abort()
    if (order === 'abort-first') {
      receipt.resolve()
      await aborting
    } else completion.resolve()
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.backend.busy).toBe(true)
    if (order === 'abort-first') completion.resolve()
    else receipt.resolve()
    await aborting
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it('registers abort before synchronous SDK settlement emitted inside abort()', async () => {
    const h = await harness()
    const receipt = deferred<void>()
    Object.assign(h.backend.client, { abort: vi.fn(() => {
      h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] })
      h.emit('agent_settled')
      return receipt.promise
    }) })
    await h.bridge.send('original')
    h.emit('agent_start')
    h.addQueued('next')
    const aborting = h.bridge.abort()
    await dispatchGap()
    expect(h.backend.controlDispatchPromises?.size).toBe(1)
    expect(h.backend.runCompletionPromise).toBeDefined()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    receipt.resolve()
    await aborting
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it('does not let primary prompt cleanup release busy while actual abort still owns the slot', async () => {
    const h = await harness()
    const primary = deferred<Disposition>()
    const receipt = deferred<void>()
    h.prompt.mockImplementationOnce(() => primary.promise)
    Object.assign(h.backend.client, { abort: vi.fn(() => receipt.promise) })
    const sending = h.bridge.send('original')
    await dispatchGap()
    h.emit('agent_start')
    h.addQueued('next')
    const aborting = h.bridge.abort()
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] })
    h.emit('agent_settled')
    primary.resolve('started')
    await sending
    await dispatchGap()
    expect(h.backend.promptDispatch).toBeUndefined()
    expect(h.backend.busy).toBe(true)
    expect(h.prompt).toHaveBeenCalledTimes(1)
    receipt.resolve()
    await aborting
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it('holds an unknown abort indefinitely despite SDK idle, and fulfilled abort alone cannot dispatch', async () => {
    const h = await harness()
    const receipt = deferred<void>()
    Object.assign(h.backend.client, { abort: vi.fn(() => receipt.promise) })
    await h.bridge.send('original')
    h.emit('agent_start')
    h.addQueued('next')
    const aborting = h.bridge.abort()
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] })
    await dispatchGap()
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    expect(h.backend.controlDispatchPromises?.size).toBe(1)
    expect(h.backend.busy).toBe(true)
    expect(h.prompt).toHaveBeenCalledTimes(1)
    receipt.resolve()
    await aborting
    await dispatchGap()
    expect(h.backend.busy).toBe(true)
    expect(h.prompt).toHaveBeenCalledTimes(1)
    h.emit('agent_settled')
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    await h.runStore.flush()
  })

  it.each(['backend', 'client', 'generation'] as const)('ignores late abort cleanup after %s replacement', async change => {
    const h = await harness()
    const completion = deferred<void>()
    const receipt = deferred<void>()
    Object.assign(h.bridge, { refreshRunCheckpoint: vi.fn(() => completion.promise) })
    Object.assign(h.backend.client, { abort: vi.fn(() => receipt.promise) })
    await h.bridge.send('original')
    h.emit('agent_start')
    h.addQueued('next')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    const aborting = h.bridge.abort()
    completion.resolve()
    await dispatchGap()
    if (change === 'backend') h.pool.set(h.backend.key, { ...h.backend, busy: true, activeRunId: 'replacement' })
    else if (change === 'client') h.backend.client = new Proxy(h.backend.client, {})
    else h.emit('compaction_start')
    receipt.resolve()
    await aborting
    await dispatchGap()
    expect(h.pool.get(h.backend.key)?.busy).toBe(true)
    expect(h.prompt).toHaveBeenCalledTimes(1)
    await h.runStore.flush()
  })

  it('advances after real settlement even if the pending RPC later rejects', async () => {
    const h = await harness()
    const receipt = deferred<Disposition>()
    h.prompt.mockImplementationOnce(() => receipt.promise)
    const sending = h.bridge.send('first')
    const failure = expect(sending).rejects.toThrow('transport failed')
    await dispatchGap()
    await h.bridge.queue('second')
    h.emit('agent_start')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    h.emit('agent_settled')
    await dispatchGap()
    receipt.reject(new Error('transport failed'))
    await failure
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(2)
    expect(h.backend.localFollowUps).toEqual([])
    await h.runStore.flush()
  })

  it.each(['error', 'aborted', 'stop'] as const)('never treats agent_end or idle as real settlement (%s)', async reason => {
    const h = await harness()
    await h.bridge.send('original')
    h.emit('agent_start')
    await h.bridge.queue('next')
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: reason, content: [] }] })
    await dispatchGap()
    h.bridge.dispatchNextLocalFollowUp(h.backend)
    await dispatchGap()
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.backend.busy).toBe(true)
    expect(h.backend.localFollowUps?.map(item => item.text)).toEqual(['next'])
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
