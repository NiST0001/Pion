import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '@earendil-works/pi-coding-agent'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { LiveSessionProjection } from '../../src/main/agent/live-session-state'
import type { BackendRecord } from '../../src/main/agent/types'
import {
  MCP_STATUS_MAX_BYTES,
  MCP_STATUS_STALE_MS,
  MCP_STATUS_WIDGET_KEY,
  projectMcpStatusSnapshot
} from '../../src/shared/mcp'
import type { McpStatusNotice, McpStatusSnapshot, McpStatusTarget } from '../../src/shared/mcp'
import { IPC, IPC_EVENTS } from '../../src/shared/ipc'
import type { PionApi } from '../../src/shared/pion-api'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: {},
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off, send: electron.send }
}))

const NOW = 1_700_000_000_000
const cwd = '/project/worktree'
const sessionPath = '/sessions/selected.jsonl'
const ownerId = 41

function mockClock(): void {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(performance, 'now').mockReturnValue(NOW)
}

function transport() {
  const callbacks: Array<(event: unknown) => void> = []
  const forbidden = () => { throw new Error('MCP reader must not call the SDK') }
  const client = {
    onEvent: vi.fn((listener: (event: unknown) => void) => { callbacks.push(listener); return () => {} }),
    start: vi.fn(forbidden), getState: vi.fn(forbidden), getCommands: vi.fn(forbidden),
    prompt: vi.fn(forbidden), stop: vi.fn(forbidden)
  }
  return { client, emit: (event: unknown) => { for (const callback of callbacks) callback(event) } }
}

interface BridgeInternals {
  attachBackendEvents(backend: BackendRecord): void
  activeKey: string | null
  activeCwd?: string
  activeSessionPath?: string
  stopping: boolean
  providerReloading: boolean
  quarantinedSessionPaths?: Set<string>
  backendPool: Pick<Map<string, BackendRecord>, 'get'>
  win: { webContents: { id: number; send: ReturnType<typeof vi.fn> } } | null
}

/** No Bridge constructor, SDK services, filesystem, credentials or sessions. */
function setup() {
  const rpc = transport()
  const backend: BackendRecord = {
    key: 'selected', cwd, sessionPath, phase: 'running', busy: false, compacting: false,
    client: rpc.client as unknown as RpcClient, liveState: new LiveSessionProjection(),
    pendingRunIds: [], startPromise: new Promise<void>(() => {})
  }
  const pool = new Map([[backend.key, backend]])
  const send = vi.fn()
  const trackBackendEvent = vi.fn()
  const handleExtensionUiRequest = vi.fn(() => true)
  const ensureActiveBackend = vi.fn(() => { throw new Error('Must not create an MCP backend') })
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: backend.key, activeCwd: cwd, activeSessionPath: sessionPath,
    stopping: false, providerReloading: false, backendPool: pool,
    win: { webContents: { id: ownerId, send } }, trackBackendEvent, handleExtensionUiRequest,
    desiredModes: new Map(), ensureActiveBackend, dispatchLifecycles: new WeakMap(),
    getSessionInfo: vi.fn(() => { throw new Error('Must not query session state') }),
    getCommands: vi.fn(() => { throw new Error('Must not query commands') })
  }) as AgentBridge
  const internals = bridge as unknown as BridgeInternals
  internals.attachBackendEvents(backend)
  const target = (): McpStatusTarget => ({ cwd: internals.activeCwd, sessionPath: internals.activeSessionPath,
    backendId: backend.liveState!.backendId })
  const read = (request: McpStatusTarget = target()) => bridge.getMcpStatus(request, ownerId)
  return { bridge, internals, backend, pool, rpc, send, trackBackendEvent, handleExtensionUiRequest,
    ensureActiveBackend, target, read }
}

function notice(overrides: Partial<McpStatusNotice> & Record<string, unknown> = {}): McpStatusNotice {
  return { version: 1, runtimeId: 'runtime-a', revision: 1, cwd, sessionPath,
    availability: 'native', phase: 'ready', diagnosticsOmitted: false,
    servers: [{ name: 'server-a', state: 'connected', exposure: 'codemode', toolCount: 5 }], ...overrides }
}

function widget(value: unknown = notice(), fields: Record<string, unknown> = {}) {
  return { type: 'extension_ui_request', id: 'private-request', method: 'setWidget',
    widgetKey: MCP_STATUS_WIDGET_KEY, widgetLines: [JSON.stringify(value)], ...fields }
}

function expectUnknown(snapshot: McpStatusSnapshot, reason: string, phase = 'unavailable') {
  expect(snapshot).toMatchObject({ availability: 'unavailable', phase, reason, servers: [], diagnosticsOmitted: false })
  expect(projectMcpStatusSnapshot(snapshot)).toEqual(snapshot)
}

function expectNoSdk(h: ReturnType<typeof setup>) {
  for (const method of ['start', 'stop', 'getState', 'getCommands', 'prompt'] as const) {
    expect(h.rpc.client[method]).not.toHaveBeenCalled()
  }
  expect(h.ensureActiveBackend).not.toHaveBeenCalled()
}

describe('MCP main reader', () => {
  beforeEach(mockClock)
  it('reads the cache synchronously with default or exact targets, without waiting for startup or SDK state', () => {
    const h = setup()
    expectUnknown(h.read(), 'waiting-status', 'waiting')
    expect(h.backend.mcpStatus).toBeUndefined()
    h.rpc.emit(widget(notice({ revision: 600 })))
    const snapshot = h.read()
    expect(snapshot).toEqual({ availability: 'native', phase: 'ready', diagnosticsOmitted: false,
      cwd, sessionPath, backendId: h.backend.liveState!.backendId, runtimeId: 'runtime-a',
      revision: 1, receivedAt: NOW, servers: [{ name: 'server-a', state: 'connected', exposure: 'codemode', toolCount: 5 }] })
    expect(h.bridge.getMcpStatus(undefined, ownerId)).toEqual(snapshot)
    expect(h.read({})).toEqual(snapshot)
    expect(h.read({ cwd })).toEqual(snapshot)
    h.backend.busy = true
    h.backend.compacting = true
    expect(h.read()).toEqual(snapshot)
    expectNoSdk(h)
  })

  it('does not equate a workspace without a retained backend with a successful empty configuration', () => {
    const h = setup()
    h.pool.clear()
    const snapshot = h.read({ cwd, sessionPath })
    expectUnknown(snapshot, 'no-backend')
    expect(snapshot).toMatchObject({ cwd, sessionPath, revision: 0, receivedAt: 0 })
    expect(snapshot.backendId).toBeUndefined()
    expectNoSdk(h)
  })

  it('accepts an explicitly observed empty native configuration without inventing a server failure', () => {
    const h = setup()
    h.rpc.emit(widget(notice({ servers: [] })))
    expect(h.read()).toMatchObject({ availability: 'native', phase: 'ready', servers: [], revision: 1 })
    expect(h.read().reason).toBeUndefined()
  })

  it.each([
    ['stopping', 'backend-stopped', 'unavailable'], ['providerReloading', 'backend-stopped', 'unavailable'],
    ['historyMutation', 'backend-stopped', 'unavailable'], ['historyStopFailed', 'backend-stopped', 'unavailable'],
    ['error', 'backend-stopped', 'unavailable'], ['starting', 'waiting-status', 'waiting'],
    ['quarantined', 'backend-stopped', 'unavailable']
  ])('returns safe unknown rows for %s without SDK access', (condition, reason, phase) => {
    const h = setup()
    h.rpc.emit(widget())
    if (condition === 'stopping' || condition === 'providerReloading') h.internals[condition] = true
    if (condition === 'historyMutation' || condition === 'historyStopFailed') h.backend[condition] = true
    if (condition === 'error' || condition === 'starting') h.backend.phase = condition
    if (condition === 'quarantined') h.internals.quarantinedSessionPaths = new Set([sessionPath])
    h.rpc.emit(widget(notice({ revision: 2 })))
    expectUnknown(h.read(), reason, phase)
    expect(h.send).toHaveBeenCalledTimes(1)
    expectNoSdk(h)
  })

  it.each([
    { cwd: '/foreign/worktree' }, { sessionPath: '/sessions/foreign.jsonl' }, { backendId: 'foreign-backend' }
  ])('uses target %s only as a fence, not to read another backend', (target) => {
    const h = setup()
    h.rpc.emit(widget())
    const snapshot = h.read(target)
    expectUnknown(snapshot, 'scope-mismatch')
    expect(snapshot).toMatchObject({ ...target, revision: 0, receivedAt: 0 })
    expect(snapshot.runtimeId).toBeUndefined()
    expectNoSdk(h)
  })

  it.each([null, 'raw target', [], { cwd: '' }, { sessionPath: 'secret\npath' }, { backendId: 'a'.repeat(129) },
    { cwd: 3 }, { sessionPath: false }, { backendId: {} }])('rejects malformed target %s without preserving its raw content', (target) => {
    const h = setup()
    h.rpc.emit(widget())
    const snapshot = h.bridge.getMcpStatus(target as McpStatusTarget, ownerId)
    expectUnknown(snapshot, 'scope-mismatch')
    expect(snapshot).toEqual({ availability: 'unavailable', phase: 'unavailable', reason: 'scope-mismatch',
      servers: [], diagnosticsOmitted: false, revision: 0, receivedAt: 0 })
    expectNoSdk(h)
  })

  it.each(['cwd', 'sessionPath', 'key'])('rejects a selected record whose %s differs from the current selection', (field) => {
    const h = setup()
    h.rpc.emit(widget())
    h.backend[field as 'cwd' | 'sessionPath' | 'key'] = '/different-scope'
    expectUnknown(h.read({}), 'scope-mismatch')
    expectNoSdk(h)
  })

  it('captures the pool instance and client rather than returning a replaced record during a read', () => {
    const h = setup()
    h.rpc.emit(widget())
    const replacement = { ...h.backend, client: transport().client as unknown as RpcClient }
    h.internals.backendPool = { get: vi.fn().mockReturnValueOnce(h.backend).mockReturnValueOnce(replacement) }
    expectUnknown(h.read(), 'scope-mismatch')
    h.internals.backendPool = { get: vi.fn().mockReturnValueOnce(h.backend).mockImplementationOnce(() => {
      h.backend.client = replacement.client
      return h.backend
    }) }
    expectUnknown(h.read(), 'scope-mismatch')
    expectNoSdk(h)
  })

  it('requires the bound main window owner even for missing backend or invalid targets', () => {
    const h = setup()
    expect(() => h.bridge.getMcpStatus({}, ownerId + 1)).toThrow('只允许所属主窗口读取 MCP 状态')
    h.internals.win = null
    h.pool.clear()
    expect(() => h.bridge.getMcpStatus({}, ownerId)).toThrow('只允许所属主窗口读取 MCP 状态')
    expectNoSdk(h)
  })

  it('expires rows only after the shared stale threshold and does not refresh receipt time on repeated revisions', () => {
    const h = setup()
    h.rpc.emit(widget())
    vi.mocked(Date.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS)
    vi.mocked(performance.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS)
    expect(h.read().phase).toBe('ready')
    vi.mocked(Date.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS + 1)
    vi.mocked(performance.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS + 1)
    h.rpc.emit(widget())
    const stale = h.read()
    expectUnknown(stale, 'stale-status')
    expect(stale).toMatchObject({ revision: 1, receivedAt: NOW, backendId: h.backend.liveState!.backendId })
    expect(h.send).toHaveBeenCalledTimes(1)
    h.rpc.emit(widget(notice({ revision: 2 })))
    expect(h.read()).toMatchObject({ phase: 'ready', revision: 2, receivedAt: NOW + MCP_STATUS_STALE_MS + 1 })
    expectNoSdk(h)
  })

  it('expires on elapsed monotonic time and never resurrects an expired cache after wall-clock rollback', () => {
    const h = setup()
    h.rpc.emit(widget())
    vi.mocked(performance.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS + 1)
    vi.mocked(Date.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS + 1)
    expectUnknown(h.read(), 'stale-status')
    vi.mocked(Date.now).mockReturnValue(NOW + 1_000)
    expectUnknown(h.read(), 'stale-status')
    vi.mocked(Date.now).mockReturnValue(NOW - 60_000)
    expectUnknown(h.read(), 'stale-status')
    // Only a genuinely newer notice, not rereading/clock changes, restores it.
    h.rpc.emit(widget(notice({ revision: 2 })))
    expect(h.read()).toMatchObject({ phase: 'ready', revision: 2, receivedAt: NOW - 60_000 })
    expectNoSdk(h)
  })

  it('expires even when the wall clock rolls backward before the first stale read', () => {
    const h = setup()
    h.rpc.emit(widget())
    vi.mocked(performance.now).mockReturnValue(NOW + MCP_STATUS_STALE_MS + 1)
    vi.mocked(Date.now).mockReturnValue(NOW - 1)
    expectUnknown(h.read(), 'stale-status')
    expectNoSdk(h)
  })

  it('returns copied whitelist fields so readers and event listeners cannot mutate the cache', () => {
    const h = setup()
    h.rpc.emit(widget(notice({ secretConfig: { token: 'private-token' }, error: 'raw stderr',
      diagnosticsOmitted: true,
      servers: [{ name: 'server-a', state: 'connected', exposure: 'direct', toolCount: 4, endpoint: 'secret-url' } as never] })))
    const snapshot = h.read()
    expect(snapshot.diagnosticsOmitted).toBe(true)
    expect(JSON.stringify(snapshot)).not.toMatch(/private-token|secretConfig|stderr|endpoint|secret-url/)
    snapshot.servers[0].name = 'mutated'
    snapshot.servers.push({ name: 'extra', state: 'failed', exposure: 'hidden' })
    const pushed = h.send.mock.calls[0][1] as McpStatusSnapshot
    pushed.servers[0].toolCount = 999
    expect(h.read().servers).toEqual([{ name: 'server-a', state: 'connected', exposure: 'direct', toolCount: 4 }])
    expectNoSdk(h)
  })
})

describe('private MCP notifications', () => {
  beforeEach(mockClock)
  it('uses the dedicated event and backend ID without advancing chat revision, root events, billing or UI', () => {
    const h = setup()
    const record = vi.spyOn(h.backend.liveState!, 'record')
    h.rpc.emit(widget(notice(), { result: { usage: { totalTokens: 5 } }, entry: { customType: 'pion-task-state' } }))
    expect(h.backend.liveState!.revision).toBe(0)
    expect(record).not.toHaveBeenCalled()
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledExactlyOnceWith(IPC_EVENTS.AgentMcpStatus, h.read())
    expect(h.send.mock.calls[0][0]).not.toBe(IPC_EVENTS.AgentEvent)
    expectNoSdk(h)
  })

  it.each([
    { widgetLines: undefined }, { widgetLines: ['bad-json'] }, { widgetLines: ['{}', '{}'] },
    { widgetLines: ['x'.repeat(MCP_STATUS_MAX_BYTES + 1)] }, { method: 'notify', message: 'raw-secret' },
    { widgetLines: [JSON.stringify(notice({ version: 2 as never }))] },
    { widgetLines: [JSON.stringify(notice({ reason: 'raw-secret' as never }))] },
    { widgetLines: [JSON.stringify(notice({ servers: [{ name: 'server', state: 'failed', exposure: 'direct', toolCount: 1 }] }))] }
  ])('invalidates old cached rows and consumes malformed private fields %s without raw logging', (fields) => {
    const h = setup()
    const error = vi.spyOn(console, 'error')
    const warn = vi.spyOn(console, 'warn')
    h.rpc.emit(widget())
    h.rpc.emit(widget(notice({ revision: 2 }), fields))
    expectUnknown(h.read(), 'invalid-notice')
    expect(h.read()).toMatchObject({ revision: 2, receivedAt: NOW })
    expect(h.backend.liveState!.revision).toBe(0)
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(JSON.stringify(h.send.mock.calls)).not.toMatch(/raw-secret|bad-json/)
    h.rpc.emit(widget()) // A duplicate cannot restore rows after an invalid notice.
    expectUnknown(h.read(), 'invalid-notice')
    h.rpc.emit(widget(notice({ revision: 2 })))
    expect(h.read()).toMatchObject({ phase: 'ready', revision: 3 })
  })

  it.each(['parent-root', 9, { raw: 'nested-secret' }])('consumes nested/invalid-parent private notices %s before nested billing or chat', (parentToolCallId) => {
    const h = setup()
    h.rpc.emit(widget())
    h.rpc.emit(widget(notice({ revision: 2 }), { parentToolCallId, result: { usage: { totalTokens: 77 } } }))
    expectUnknown(h.read(), 'invalid-notice')
    expect(h.backend.liveState!.revision).toBe(0)
    expect(h.trackBackendEvent).not.toHaveBeenCalled()
    expect(h.handleExtensionUiRequest).not.toHaveBeenCalled()
    expect(JSON.stringify(h.send.mock.calls)).not.toContain('nested-secret')
  })

  it('consumes only its private widget key and leaves other extension widgets on the existing path', () => {
    const h = setup()
    const event = widget(notice(), { widgetKey: 'another-widget' })
    h.rpc.emit(event)
    expect(h.backend.mcpStatus).toBeUndefined()
    expect(h.handleExtensionUiRequest).toHaveBeenCalledExactlyOnceWith(h.backend, event)
    expect(h.backend.liveState!.revision).toBe(1)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('rejects duplicate and lower SDK revisions without advancing the main revision or receipt clock', () => {
    const h = setup()
    h.rpc.emit(widget(notice({ revision: 7 })))
    const first = h.read()
    vi.mocked(Date.now).mockReturnValue(NOW + 3_000)
    for (const revision of [7, 6, 1]) h.rpc.emit(widget(notice({ revision, servers: [] })))
    expect(h.read()).toEqual(first)
    expect(h.send).toHaveBeenCalledTimes(1)
    h.rpc.emit(widget(notice({ revision: 8, servers: [] })))
    expect(h.read()).toMatchObject({ phase: 'ready', revision: 2, receivedAt: NOW + 3_000, servers: [] })
  })

  it('keeps a main-owned monotonic revision across SDK owners and rejects retired runtime resurrection', () => {
    const h = setup()
    h.rpc.emit(widget(notice({ revision: 900 })))
    h.rpc.emit(widget(notice({ runtimeId: 'runtime-b', revision: 1, servers: [] })))
    const second = h.read()
    expect(second).toMatchObject({ runtimeId: 'runtime-b', revision: 2, servers: [] })
    expect(h.backend.mcpStatus?.retiredRuntimeIds).toEqual(['runtime-a'])
    h.rpc.emit(widget(notice({ revision: 901 })))
    expect(h.read()).toEqual(second)
    for (let index = 0; index < 10; index++) h.rpc.emit(widget(notice({ runtimeId: `next-${index}`, revision: 1 })))
    expect(h.read()).toMatchObject({ runtimeId: 'next-9', revision: 12 })
    expect(h.backend.mcpStatus?.retiredRuntimeIds).toEqual(Array.from({ length: 8 }, (_, index) => `next-${index + 1}`))
    h.rpc.emit(widget(notice({ runtimeId: 'next-1', revision: 1000 })))
    expect(h.read()).toMatchObject({ runtimeId: 'next-9', revision: 12 })
  })

  it('ignores wrong cwd/path until periodic notifications match the bridge path without burning their SDK revision', () => {
    const h = setup()
    h.rpc.emit(widget())
    h.rpc.emit(widget(notice({ revision: 2, cwd: '/foreign' })))
    h.rpc.emit(widget(notice({ revision: 2, sessionPath: '/sessions/new-branch.jsonl' })))
    expect(h.read()).toMatchObject({ phase: 'ready', revision: 1, sessionPath })
    expect(h.send).toHaveBeenCalledTimes(1)
    h.backend.sessionPath = '/sessions/new-branch.jsonl'
    h.internals.activeSessionPath = h.backend.sessionPath
    expectUnknown(h.read(), 'waiting-status', 'waiting')
    h.rpc.emit(widget(notice({ revision: 2, sessionPath: h.backend.sessionPath })))
    expect(h.read()).toMatchObject({ phase: 'ready', revision: 2, sessionPath: h.backend.sessionPath })
  })

  it('caches background observations but never uses target fields to disclose their rows', () => {
    const h = setup()
    const rpc = transport()
    const background: BackendRecord = { ...h.backend, key: 'background', cwd: '/background/worktree',
      sessionPath: '/sessions/background.jsonl', liveState: new LiveSessionProjection(), client: rpc.client as unknown as RpcClient }
    h.pool.set(background.key, background)
    h.internals.attachBackendEvents(background)
    rpc.emit(widget(notice({ cwd: background.cwd, sessionPath: background.sessionPath })))
    expect(background.mcpStatus?.snapshot.phase).toBe('ready')
    expect(h.send).not.toHaveBeenCalled()
    const target = { cwd: background.cwd, sessionPath: background.sessionPath, backendId: background.liveState!.backendId }
    const get = vi.spyOn(h.pool, 'get')
    expectUnknown(h.read(target), 'scope-mismatch')
    expect(get.mock.calls.every(([key]) => key === h.backend.key)).toBe(true)
    h.internals.activeKey = background.key
    h.internals.activeCwd = background.cwd
    h.internals.activeSessionPath = background.sessionPath
    expect(h.read(target)).toMatchObject({ phase: 'ready', backendId: background.liveState!.backendId, revision: 1 })
    expect(h.send).not.toHaveBeenCalled()
    expectNoSdk(h)
  })

  it('keeps active-key notices private when the selected cwd/path is not the backend scope', () => {
    const h = setup()
    h.internals.activeSessionPath = '/sessions/not-selected.jsonl'
    h.rpc.emit(widget())
    expect(h.backend.mcpStatus?.snapshot.phase).toBe('ready')
    expect(h.send).not.toHaveBeenCalled()
    expectUnknown(h.read({}), 'scope-mismatch')
  })

  it('drops late events from the captured client even when the same record gets a new client', () => {
    const h = setup()
    h.rpc.emit(widget())
    const rpc = transport()
    h.backend.client = rpc.client as unknown as RpcClient
    expectUnknown(h.read(), 'waiting-status', 'waiting')
    h.internals.attachBackendEvents(h.backend)
    h.rpc.emit(widget(notice({ revision: 900 })))
    h.rpc.emit(widget(notice(), { widgetLines: ['malformed-late-secret'] }))
    expect(h.backend.mcpStatus?.snapshot.revision).toBe(1)
    expect(h.send).toHaveBeenCalledTimes(1)
    rpc.emit(widget(notice({ runtimeId: 'new-client-runtime', revision: 1 })))
    expect(h.read()).toMatchObject({ phase: 'ready', runtimeId: 'new-client-runtime', revision: 2 })
    expect(h.backend.liveState!.revision).toBe(0)
    expectNoSdk(h)
  })

  it('drops events from a deleted or same-key replaced pool record before consuming private data', () => {
    const h = setup()
    h.pool.set(h.backend.key, { ...h.backend, liveState: new LiveSessionProjection() })
    h.rpc.emit(widget())
    expect(h.backend.mcpStatus).toBeUndefined()
    h.pool.delete(h.backend.key)
    h.rpc.emit(widget(notice(), { widgetLines: ['malformed-late-secret'] }))
    expect(h.backend.mcpStatus).toBeUndefined()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.backend.liveState!.revision).toBe(0)
  })

  it.each([
    { availability: 'replaced', phase: 'unavailable' }, { availability: 'inactive', phase: 'unavailable' },
    { availability: 'native', phase: 'waiting', reason: 'query-busy' },
    { availability: 'native', phase: 'unavailable', reason: 'query-timeout' },
    { availability: 'unavailable', phase: 'unavailable', reason: 'unsupported-sdk' }
  ] as const)('preserves observed availability/phase %s rather than claiming active native servers', (status) => {
    const h = setup()
    h.rpc.emit(widget(notice({ ...status, servers: [], diagnosticsOmitted: true })))
    expect(h.read()).toMatchObject({ ...status, servers: [], diagnosticsOmitted: true, revision: 1 })
  })

  it('projects all eight server states, exposures and connected-only registered tool counts', () => {
    const h = setup()
    const states = ['connecting', 'connected', 'disconnected', 'needs-auth', 'failed', 'closed', 'starting', 'disabled'] as const
    const exposures = ['codemode', 'deferred', 'direct', 'hidden'] as const
    const servers = states.map((state, index) => ({ name: `server-${index}`, state, exposure: exposures[index % exposures.length],
      ...(state === 'connected' ? { toolCount: 0 } : {}) }))
    h.rpc.emit(widget(notice({ servers, diagnosticsOmitted: true })))
    expect(h.read().servers).toEqual(servers)
  })
})

describe('typed preload MCP channel', () => {
  beforeEach(mockClock)
  it('invokes only the read channel and subscribes/unsubscribes only the dedicated event', async () => {
    await import('../../src/preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1] as Pick<PionApi, 'getMcpStatus' | 'onMcpStatus'>
    const target = { cwd, sessionPath, backendId: 'selected-backend' }
    const snapshot: McpStatusSnapshot = { availability: 'native', phase: 'ready', servers: [],
      diagnosticsOmitted: false, ...target, revision: 1, receivedAt: NOW }
    const result = Promise.resolve(snapshot)
    electron.invoke.mockReturnValueOnce(result)
    expect(api.getMcpStatus(target)).toBe(result)
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(IPC.AgentMcpStatus, target)
    const listener = vi.fn()
    const unsubscribe = api.onMcpStatus(listener)
    const wrapped = electron.on.mock.calls[0][1] as (event: unknown, snapshot: McpStatusSnapshot) => void
    expect(electron.on).toHaveBeenCalledExactlyOnceWith(IPC_EVENTS.AgentMcpStatus, wrapped)
    wrapped({ rawIpcEvent: true }, snapshot)
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot)
    unsubscribe()
    expect(electron.off).toHaveBeenCalledExactlyOnceWith(IPC_EVENTS.AgentMcpStatus, wrapped)
    expect(electron.send).not.toHaveBeenCalled()
  })
})
