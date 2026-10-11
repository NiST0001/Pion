import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentBridge as Bridge } from '../../src/main/agent/agent-bridge'
import { LiveSessionProjection } from '../../src/main/agent/live-session-state'
import type { BackendRecord } from '../../src/main/agent/types'
import type { SubagentSessionStore } from '../../src/main/agent/subagent-session-store'
import { SUBAGENT_SESSION_WIDGET_KEY, SUBAGENT_SESSION_RETENTION_MS, SUBAGENT_SESSION_ADMISSION_TITLE } from '../../src/shared/subagent-sessions'
import { IPC_EVENTS } from '../../src/shared/ipc'
let AgentBridge: typeof import('../../src/main/agent/agent-bridge').AgentBridge
let messageRevert: typeof import('../../src/main/agent/message-revert')
const bridges: Bridge[] = []
const cwd = '/project', path = '/sessions/parent.jsonl'
interface Internals {
  attachBackendEvents(backend: BackendRecord): void
  subagentSessions(): SubagentSessionStore
  observeSubagentProcessExit(backend: BackendRecord): void
  markSubagentBackendGone(backend: BackendRecord, confirmed: boolean): void
  syncBackendSession(backend: BackendRecord): Promise<void>
  hiddenSubagentBackends?: Set<string>
  deletedSubagentParentPaths?: Set<string>
}
function admission(overrides = {}) {
  return { type: 'extension_ui_request', method: 'input', title: SUBAGENT_SESSION_ADMISSION_TITLE, id: 'admission',
    placeholder: JSON.stringify({ version: 1, nonce: 'nonce', runtimeId: 'runtime', parentToolCallId: 'call', count: 1, ...overrides }) }
}
function fixture(reserve = true, parentPath: string | null = path) {
  let listener!: (event: unknown) => void
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null })
  const forbidden = vi.fn(() => { throw new Error('Display read must not call SDK') })
  const client = { process: child, onEvent: (callback: typeof listener) => { listener = callback },
    start: forbidden, getState: forbidden, prompt: forbidden, stop: forbidden }
  const backend = { key: 'parent', cwd, sessionPath: parentPath ?? undefined, client, phase: 'running', busy: false,
    compacting: false, pendingRunIds: [], startPromise: Promise.resolve(), liveState: new LiveSessionProjection(),
    subagentViewNonce: 'nonce', usageBackendId: 'usage-backend', activeRunId: 'run' } as unknown as BackendRecord
  const pool = new Map([[backend.key, backend]])
  const send = vi.fn(), handleExtensionUiRequest = vi.fn(), respondToExtensionUi = vi.fn()
  const run = { state: 'running', cwd, sessionPath: path, usageBackendId: 'usage-backend', tools: [] }
  const runStore = { get: vi.fn(() => run), update: vi.fn((_id: string, update: (value: typeof run) => void) => update(run)),
    list: vi.fn(() => []), hasUnsettledSessionRuns: vi.fn(() => false) }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    win: { webContents: { id: 7, send } }, backendPool: pool, activeKey: backend.key,
    stopping: false, runStore, handleExtensionUiRequest, respondToExtensionUi, desiredModes: new Map(),
    pushSessionInfo: vi.fn(), refreshSidebarSessions: vi.fn()
  }) as Bridge
  const trackBackendEvent = vi.spyOn(bridge as unknown as { trackBackendEvent: (backend: BackendRecord, event: unknown, type?: string) => void }, 'trackBackendEvent')
  bridges.push(bridge)
  const internals = bridge as unknown as Internals
  internals.attachBackendEvents(backend)
  const packet = (overrides = {}) => ({ type: 'extension_ui_request', method: 'setWidget',
    widgetKey: SUBAGENT_SESSION_WIDGET_KEY, widgetLines: [JSON.stringify({ version: 1, nonce: 'nonce',
      source: 'sdk:pion_subagents', runtimeId: 'runtime', id: 'child', parentToolCallId: 'call',
      parentSessionId: 'parent-sdk', parentSessionPath: path, cwd, name: 'worker', revision: 1,
      status: 'running', truncated: false, rows: [{ id: 'row', kind: 'assistant', text: 'answer' }], ...overrides })] })
  const emit = (event: unknown) => listener(event)
  // Exercise the real root start -> trackBackendEvent -> native receipt flow.
  expect(backend.nativeToolReceipts).toBeUndefined()
  emit({ type: 'tool_execution_start', toolName: 'pion_subagents', toolCallId: 'call', args: { tasks: [] } })
  expect(backend.nativeToolReceipts?.get('call')).toMatchObject({ name: 'pion_subagents', state: 'running', runId: 'run' })
  if (reserve) {
    emit(admission())
    expect(respondToExtensionUi).toHaveBeenLastCalledWith(client, 'admission', { value: 'reserved' })
  }
  trackBackendEvent.mockClear(); send.mockClear(); runStore.update.mockClear(); handleExtensionUiRequest.mockClear(); respondToExtensionUi.mockClear()
  const read = () => bridge.getSubagentSession('child', backend.liveState!.backendId, 7)
  return { bridge, internals, backend, pool, send, trackBackendEvent, handleExtensionUiRequest, forbidden, child, client, run, runStore, respondToExtensionUi, packet, emit, read }
}
function replaceBackendWithoutReservation(h: ReturnType<typeof fixture>) {
  let listener!: (event: unknown) => void
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null })
  const client = { ...h.client, process: child, onEvent: (callback: typeof listener) => { listener = callback } }
  const backend = { ...h.backend, client, liveState: new LiveSessionProjection(), nativeToolReceipts: undefined,
    activeRunId: 'run', historyMutation: false, busy: false } as unknown as BackendRecord
  h.pool.set(backend.key, backend)
  h.internals.attachBackendEvents(backend)
  const emit = (event: unknown) => listener(event)
  emit({ type: 'tool_execution_start', toolName: 'pion_subagents', toolCallId: 'call', args: { tasks: [] } })
  return { backend, child, client, emit }
}
function replaceBackend(h: ReturnType<typeof fixture>) {
  const replacement = replaceBackendWithoutReservation(h)
  replacement.emit(admission())
  expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(replacement.client, 'admission', { value: 'reserved' })
  return replacement
}
function prepareUndo(h: ReturnType<typeof fixture>, backend: BackendRecord) {
  backend.activeRunId = undefined
  backend.client = { ...backend.client,
    getState: vi.fn(async () => ({ sessionId: 'parent-sdk', sessionFile: path,
      isStreaming: false, isCompacting: false, pendingMessageCount: 0 })),
    getEntries: vi.fn(async () => ({ leafId: 'user', entries: [{ id: 'user', parentId: null,
      type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'request' }] } }] })),
    stop: vi.fn(async () => {
      const process = (backend.client as unknown as { process: typeof h.child }).process
      process.exitCode = 0; process.emit('exit', 0, null)
    })
  } as unknown as BackendRecord['client']
  Object.assign(h.bridge, { activeSessionPath: path, sessionSelectionGeneration: 1, sessionOperationsInFlight: 0,
    historyRevision: 0, backendKeysBySessionPath: new Map([[path, backend.key]]),
    sessionManagers: new Map(), sessionManagerSignatures: new Map(),
    getPendingToolPermissionRequests: vi.fn(() => []), getPendingExtensionUiRequests: vi.fn(() => []),
    clearBackendToolPermissionRequests: vi.fn(), clearBackendExtensionUiRequests: vi.fn(),
    pushRunCheckpoint: vi.fn(), pushRunningSessionPaths: vi.fn(), refresh: vi.fn(async () => {}),
    ensureActiveBackend: vi.fn(async () => backend) })
  return { sessionPath: path, sessionId: 'parent-sdk', entryId: 'user', expectedLeafId: 'user' }
}
describe('subagent display bridge (no SDK sessions or process launches)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({ BrowserWindow: {} }))
    ;({ AgentBridge } = await import('../../src/main/agent/agent-bridge'))
    messageRevert = await import('../../src/main/agent/message-revert')
  })
  afterEach(() => { for (const bridge of bridges.splice(0)) bridge.disposeSubagentSessions(); vi.restoreAllMocks() })
  afterAll(() => { vi.doUnmock('electron'); vi.resetModules() })

  it('reads and pushes display-only snapshots before root/live/billing/UI projection', () => {
    const h = fixture(), revision = h.backend.liveState!.revision
    h.emit(h.packet())
    expect(h.read()?.rows[0].text).toBe('answer')
    expect(h.bridge.getSubagentSessions(7).sessions).toHaveLength(1)
    expect(h.send).toHaveBeenCalledWith(IPC_EVENTS.SubagentSessions, expect.objectContaining({ sessions: [expect.objectContaining({ id: 'child' })] }))
    expect(h.backend.liveState!.revision).toBe(revision)
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.runStore.update).not.toHaveBeenCalled()
    expect(h.forbidden).not.toHaveBeenCalled()
  })
  it('reserves through real private input/ACK without generic UI, live or billing projection', () => {
    const h = fixture(false), revision = h.backend.liveState!.revision
    h.emit(admission())
    expect(h.respondToExtensionUi).toHaveBeenCalledExactlyOnceWith(h.client, 'admission', { value: 'reserved' })
    expect(h.backend.liveState!.revision).toBe(revision)
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.runStore.update).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    h.emit(h.packet())
    expect(h.read()?.status).toBe('running')
  })
  it.each([
    { method: 'confirm' }, { type: 'message_update', usage: { input: 99 } }, { parentToolCallId: 'iframe' },
    { placeholder: 'not-json' }, { placeholder: 'x'.repeat(4097) },
    admission({ nonce: 'other' }), admission({ count: 0 }), admission({ count: 9 }), admission({ count: 1.5 }),
    admission({ extra: true }), admission({ runtimeId: 'x'.repeat(257) }), admission({ parentToolCallId: 'x\0y' })
  ])('swallows invalid reserved admission without generic UI or billing: %j', (invalid) => {
    const h = fixture(false), revision = h.backend.liveState!.revision
    h.emit({ ...admission(), ...invalid })
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'denied' })
    expect(h.backend.liveState!.revision).toBe(revision)
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.runStore.update).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
  })
  it('unusable request IDs remain private without attempting an ACK', () => {
    const h = fixture(false)
    for (const id of [undefined, '', 'x'.repeat(257), 'x\0y']) h.emit({ ...admission(), id })
    expect(h.respondToExtensionUi).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.runStore.update).not.toHaveBeenCalled()
  })
  it('captured parent scope cannot use a different run path or silently alias source paths', () => {
    const h = fixture(false)
    h.backend.sessionPath = '/sessions/alias/../parent.jsonl'
    h.emit(admission())
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'denied' })
    h.backend.sessionPath = path
    h.emit(admission())
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'reserved' })
    h.emit(h.packet({ parentSessionPath: '/sessions/alias/../parent.jsonl' }))
    expect(h.read()).toBeNull()
    h.emit(h.packet())
    expect(h.read()?.parentSessionPath).toBe(path)
  })
  it('receipt saturation denies admission without creating display capacity', () => {
    const h = fixture(false)
    const receipts = h.backend.nativeToolReceipts!
    const receipt = receipts.get('call')!
    receipts.clear()
    for (let i = 0; i < 512; i++) receipts.set(`old-${i}`, { ...receipt, state: 'ended' })
    h.emit({ type: 'tool_execution_start', toolName: 'pion_subagents', toolCallId: 'call', args: { tasks: [] } })
    h.emit(admission())
    expect(receipts.has('call')).toBe(false)
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'denied' })
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
  })
  it('global reserved capacity denies a different captured backend before any child starts', () => {
    const h = fixture(false)
    for (let i = 0; i < 32; i++) {
      const toolCallId = `batch-${i}`
      h.emit({ type: 'tool_execution_start', toolName: 'pion_subagents', toolCallId, args: { tasks: [] } })
      h.emit(admission({ parentToolCallId: toolCallId, count: 8 }))
      expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'reserved' })
    }
    const next = replaceBackendWithoutReservation(h)
    next.emit(admission({ runtimeId: 'unrelated-runtime' }))
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(next.client, 'admission', { value: 'denied' })
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
  })
  it.each([false, true])('actual root/nested end releases only unused reservations, nested=%s', (nested) => {
    const h = fixture(false)
    const toolCallId = nested ? 'nested-call' : 'call'
    if (nested) {
      h.emit({ type: 'tool_execution_start', toolName: 'codemode', toolCallId: 'code', args: {} })
      h.emit({ type: 'tool_execution_start', toolName: 'pion_subagents', toolCallId, parentToolCallId: 'code', args: {} })
    }
    h.emit(admission({ parentToolCallId: toolCallId, count: 2 }))
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'reserved' })
    h.emit(h.packet({ parentToolCallId: toolCallId, status: 'completed' }))
    const release = vi.spyOn(h.internals.subagentSessions(), 'releaseBatch')
    Object.assign(h.bridge, { clearSubagentPermissions: vi.fn() })
    h.emit({ type: 'tool_execution_end', toolName: 'pion_subagents', toolCallId,
      ...(nested ? { parentToolCallId: 'code' } : {}), result: {}, isError: false })
    expect(release).toHaveBeenCalledExactlyOnceWith(h.backend.liveState!.backendId, toolCallId)
    expect(h.backend.nativeToolReceipts?.get(toolCallId)?.state).toBe('ended')
    expect(h.read()?.status).toBe('completed')
    h.emit(h.packet({ parentToolCallId: toolCallId, id: 'unused' }))
    expect(h.bridge.getSubagentSession('unused', h.backend.liveState!.backendId, 7)).toBeNull()
  })
  it('discarded captured client cannot ACK or surface a private request', () => {
    const h = fixture(false)
    h.backend.client = {} as BackendRecord['client']
    h.emit(admission())
    expect(h.respondToExtensionUi).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })
  it('real root completion closes the receipt and cannot authorize another child', () => {
    const h = fixture()
    h.emit(h.packet({ status: 'completed' }))
    Object.assign(h.bridge, { clearSubagentPermissions: vi.fn() })
    h.emit({ type: 'tool_execution_end', toolName: 'pion_subagents', toolCallId: 'call', result: {}, isError: false })
    expect(h.backend.nativeToolReceipts?.get('call')?.state).toBe('ended')
    const calls = h.runStore.update.mock.calls.length
    const revision = h.backend.liveState!.revision
    h.emit(h.packet({ id: 'too-late' }))
    expect(h.bridge.getSubagentSession('too-late', h.backend.liveState!.backendId, 7)).toBeNull()
    expect(h.runStore.update.mock.calls).toHaveLength(calls)
    expect(h.backend.liveState!.revision).toBe(revision)
    expect(h.read()?.status).toBe('completed')
  })
  it('always swallows malformed reserved packets, even without a nonce', () => {
    const h = fixture()
    h.backend.subagentViewNonce = undefined
    h.emit({ widgetKey: SUBAGENT_SESSION_WIDGET_KEY, type: 'message_update', usage: { input: 99 } })
    h.emit({ ...h.packet(), parentToolCallId: 'nested', widgetLines: ['not-json'] })
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
  })
  it.each(['missing', 'closed', 'wrong-name', 'wrong-backend', 'missing-run', 'wrong-run-path'])('requires a matching live native receipt: %s', (reason) => {
    const h = fixture(false), receipt = h.backend.nativeToolReceipts!.get('call')!
    if (reason === 'missing') h.backend.nativeToolReceipts!.clear()
    if (reason === 'closed') receipt.state = 'ended'
    if (reason === 'wrong-name') receipt.name = 'codemode'
    if (reason === 'wrong-backend') receipt.backendId = 'old-backend'
    if (reason === 'missing-run') (h.bridge as unknown as { runStore: { get: () => unknown } }).runStore.get = () => undefined
    if (reason === 'wrong-run-path') h.run.sessionPath = '/other'
    h.emit(admission())
    expect(h.respondToExtensionUi).toHaveBeenLastCalledWith(h.client, 'admission', { value: 'denied' })
    h.emit(h.packet())
    expect(h.read()).toBeNull()
  })
  it('backfills the real parent path without manufacturing a normal session or changing backend identity', async () => {
    const h = fixture(true, null), id = h.backend.liveState!.backendId
    h.backend.sessionPath = undefined
    h.emit(h.packet({ parentSessionPath: undefined }))
    expect(h.read()?.parentSessionPath).toBeUndefined()
    h.backend.sidebarPublishedSessionPath = path // avoid any normal sidebar/history scan
    h.backend.client = { ...h.client, getState: vi.fn(async () => ({ sessionFile: path, sessionId: 'parent-sdk' })) } as unknown as BackendRecord['client']
    Object.assign(h.bridge, { historyRevision: 0, backendKeysBySessionPath: new Map(),
      updateRunSession: vi.fn(), pushRunningSessionPaths: vi.fn(), restoreQueuedRuns: vi.fn(),
      listSessions: vi.fn(() => { throw new Error('Must not scan normal history') }) })
    await h.internals.syncBackendSession(h.backend)
    expect(h.read()).toMatchObject({ backendId: id, parentSessionPath: path })
    expect(h.forbidden).not.toHaveBeenCalled()
  })

  it('rejects other owners and invalid bounded identifiers without SDK calls', () => {
    const h = fixture()
    expect(() => h.bridge.getSubagentSessions(8)).toThrow('所属主窗口')
    expect(() => h.bridge.getSubagentSession('child', 'backend', 8)).toThrow('所属主窗口')
    for (const id of ['', 'a'.repeat(257), 'a\0b']) expect(() => h.bridge.getSubagentSession(id, 'backend', 7)).toThrow('标识无效')
    expect(h.forbidden).not.toHaveBeenCalled()
  })
  it('fences replaced clients, evicted backends and history mutation', () => {
    const h = fixture()
    h.pool.delete(h.backend.key); h.emit(h.packet()); expect(h.read()).toBeNull()
    h.pool.set(h.backend.key, h.backend)
    h.backend.historyMutation = true; h.emit(h.packet()); expect(h.read()).toBeNull()
    h.backend.historyMutation = false
    h.backend.client = {} as BackendRecord['client']; h.emit(h.packet()); expect(h.read()).toBeNull()
  })
  it('logical stop is cancelling, actual captured exit alone starts retention after eviction', () => {
    const h = fixture()
    h.internals.observeSubagentProcessExit(h.backend)
    h.emit(h.packet())
    h.internals.markSubagentBackendGone(h.backend, false)
    expect(h.read()).toMatchObject({ status: 'cancelling' })
    expect(h.read()?.retentionRemainingMs).toBeUndefined()
    h.pool.delete(h.backend.key)
    const replacement = replaceBackend(h)
    const newBackend = replacement.backend.liveState!.backendId
    replacement.emit(h.packet())
    // The old captured process observer sees a replaced live projection too.
    h.backend.liveState = replacement.backend.liveState
    h.client.process = null as unknown as typeof h.child // SDK early pointer loss is not exit.
    expect(h.bridge.getSubagentSessions(7).sessions.find((session) => session.backendId !== newBackend)?.status).toBe('cancelling')
    h.child.emit('exit', 0, null)
    expect(h.bridge.getSubagentSessions(7).sessions.find((session) => session.backendId !== newBackend)).toMatchObject({ status: 'aborted', retentionRemainingMs: expect.any(Number) })
    expect(h.bridge.getSubagentSession('child', newBackend, 7)?.status).toBe('running')
  })
  it('retains completed records across pool removal, expires them, and clears only on explicit dispose', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const h = fixture()
    h.emit(h.packet({ status: 'completed' }))
    h.pool.clear()
    expect(h.read()?.status).toBe('completed')
    now = SUBAGENT_SESSION_RETENTION_MS + 1
    expect(h.read()).toBeNull()
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
    h.bridge.disposeSubagentSessions()
    expect(h.read()).toBeNull()
  })
  it('hides all retained parent incarnations only after undo commits, and allows a new branch backend', async () => {
    const h = fixture(), oldId = h.backend.liveState!.backendId
    h.emit(h.packet({ status: 'completed' }))
    const current = replaceBackend(h), currentId = current.backend.liveState!.backendId
    current.emit(h.packet({ status: 'completed' }))
    expect(h.bridge.getSubagentSessions(7).sessions).toHaveLength(2)
    const request = prepareUndo(h, current.backend)
    const commit = vi.spyOn(messageRevert, 'revertSessionMessage').mockImplementation(() => {
      expect(h.bridge.getSubagentSessions(7).sessions).toHaveLength(2)
      return { sessionPath: path, sessionId: 'parent-sdk', entryId: 'user', previousLeafId: 'user', leafId: 'marker', text: 'request', images: [] }
    })
    const revision = h.bridge.getSubagentSessions(7).revision
    await h.bridge.revertMessage(request, 7)
    expect(commit).toHaveBeenCalledOnce()
    expect(h.bridge.getSubagentSessions(7)).toMatchObject({ sessions: [] })
    expect(h.bridge.getSubagentSessions(7).revision).toBeGreaterThan(revision)
    expect(h.bridge.getSubagentSession('child', oldId, 7)).toBeNull()
    expect(h.bridge.getSubagentSession('child', currentId, 7)).toBeNull()
    const next = replaceBackend(h), nextId = next.backend.liveState!.backendId
    next.emit(h.packet({ status: 'completed' }))
    expect(h.bridge.getSubagentSessions(7).sessions.map((session) => session.backendId)).toEqual([nextId])
    expect(h.bridge.getSubagentSession('child', nextId, 7)?.status).toBe('completed')
  })
  it('a failed durable undo does not hide existing children', async () => {
    const h = fixture()
    h.emit(h.packet({ status: 'completed' }))
    const request = prepareUndo(h, h.backend)
    vi.spyOn(messageRevert, 'revertSessionMessage').mockImplementation(() => { throw new Error('commit failed') })
    await expect(h.bridge.revertMessage(request, 7)).rejects.toThrow('commit failed')
    expect(h.bridge.getSubagentSessions(7).sessions).toHaveLength(1)
    expect(h.read()?.status).toBe('completed')
    expect(h.internals.hiddenSubagentBackends?.size ?? 0).toBe(0)
  })
  it('expiry wins over hidden detail reads while normal retained views survive', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const h = fixture(), oldId = h.backend.liveState!.backendId
    h.emit(h.packet({ status: 'completed' }))
    h.internals.hiddenSubagentBackends = new Set([oldId])
    now = SUBAGENT_SESSION_RETENTION_MS / 2
    const next = replaceBackend(h), nextId = next.backend.liveState!.backendId
    next.emit(h.packet({ status: 'completed' }))
    const revision = h.bridge.getSubagentSessions(7).revision
    now = SUBAGENT_SESSION_RETENTION_MS + 1
    expect(h.bridge.getSubagentSession('child', oldId, 7)).toBeNull()
    expect(h.internals.hiddenSubagentBackends?.has(oldId)).toBe(false)
    expect(h.bridge.getSubagentSessions(7).revision).toBeGreaterThan(revision)
    expect(h.bridge.getSubagentSession('child', nextId, 7)?.status).toBe('completed')
    expect(h.forbidden).not.toHaveBeenCalled()
  })
  it('hides old branch/backend and deleted parent without deleting retained store records', () => {
    const h = fixture()
    h.emit(h.packet({ status: 'completed' }))
    h.internals.hiddenSubagentBackends = new Set([h.backend.liveState!.backendId])
    expect(h.read()).toBeNull()
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
    h.internals.hiddenSubagentBackends.clear()
    h.internals.deletedSubagentParentPaths = new Set([path])
    expect(h.read()).toBeNull()
    expect(h.bridge.getSubagentSessions(7).sessions).toEqual([])
  })
})
