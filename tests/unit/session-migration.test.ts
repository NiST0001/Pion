import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { RpcClient } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import type { AgentStatus, ModelOption } from '../../src/shared/types'

type RpcState = Awaited<ReturnType<RpcClient['getState']>>
const roots: string[] = []
const releases: (() => void)[] = []
const observations: Promise<unknown>[] = []
const children: HistoryProcess[] = []

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  releases.push(() => resolve(fallback))
  return { promise, resolve, reject }
}

// Attach rejection handlers before deliberately holding an RPC/stop/exit open.
function observe<T>(promise: Promise<T>) {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  observations.push(result)
  return result
}

class HistoryProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  exit() {
    if (this.exitCode !== null) return
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

function runtime(key: string, cwd: string, path?: string) {
  const state: RpcState = {
    sessionId: key, sessionFile: path, thinkingLevel: 'off',
    isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 0,
    steeringMode: 'all', followUpMode: 'all', autoCompactionEnabled: true
  }
  const client = {
    // Explicit SDK adapter: null means there is no child writer, not unknown exit.
    process: null as HistoryProcess | null,
    getState: vi.fn(async (): Promise<RpcState> => ({ ...state })),
    stop: vi.fn(async () => undefined),
    setModel: vi.fn(async (_provider: string, _id: string) => undefined)
  }
  const backend: BackendRecord = {
    key, cwd, sessionPath: path, client: client as unknown as RpcClient,
    phase: 'running', busy: false, compacting: false,
    pendingRunIds: [], localFollowUps: [], startPromise: Promise.resolve()
  }
  return { state, client, backend }
}

function fixture(options: { backend?: boolean; path?: boolean; persisted?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pion-migrate-mock-'))
  roots.push(root)
  const sourceCwd = join(root, 'project-a')
  const targetCwd = join(root, 'project-b')
  mkdirSync(sourceCwd)
  mkdirSync(targetCwd)
  const sourceDir = join(root, 'sessions-a')
  const targetDir = join(root, 'sessions-b')
  const sourcePath = join(sourceDir, 'session-1.jsonl')
  const targetPath = join(targetDir, basename(sourcePath))
  const content = [
    JSON.stringify({ type: 'session', version: 3, id: 's-1', timestamp: '2026-01-01T00:00:00Z', cwd: sourceCwd }),
    JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
  ].join('\n') + '\n'
  if (options.persisted) {
    mkdirSync(sourceDir)
    writeFileSync(sourcePath, content)
  }
  const hasPath = options.path ?? options.persisted ?? false
  const source = runtime('source', sourceCwd, hasPath ? sourcePath : undefined)
  if (options.persisted) source.state.messageCount = 1
  const target = runtime('target', targetCwd)
  const backendPool = new Map<string, BackendRecord>()
  if (options.backend !== false) backendPool.set(source.backend.key, source.backend)
  const pushSessionInfo = vi.fn(async () => undefined)
  const setStatus = vi.fn((status: Partial<AgentStatus>) => {
    internals.status = { ...internals.status, ...status }
  })
  const ensureActiveBackend = vi.fn(async () => {
    if (internals.activeCwd !== targetCwd) throw new Error('Unexpected SDK initialization')
    target.backend.key = internals.activeKey!
    backendPool.set(target.backend.key, target.backend)
    return target.backend
  })
  const switchSession = vi.fn(async (path: string) => {
    if (path !== targetPath) throw new Error('Unexpected session selection')
    internals.activeCwd = targetCwd
    internals.activeSessionPath = path
    internals.activeKey = 'target'
    return { cancelled: false }
  })
  // No constructor: its defaults create real provider services. All session
  // buckets and every file operation below are rooted in this private temp dir.
  // No SessionManager, SDK construction, user config, credentials or network.
  const fields = {
    activeCwd: sourceCwd as string | undefined,
    activeKey: source.backend.key as string | null,
    activeSessionPath: hasPath ? sourcePath : undefined,
    sessionSelectionGeneration: 1,
    stopping: false, sessionMigrationInFlight: false,
    status: { phase: 'running', cwd: sourceCwd } as AgentStatus,
    backendPool, backendKeysBySessionPath: new Map([[sourcePath, source.backend.key]]),
    sessionManagers: new Map(), sessionManagerSignatures: new Map(),
    sessionDirFor: vi.fn((cwd: string) => {
      if (cwd === targetCwd) return targetDir
      if (cwd === sourceCwd) return sourceDir
      throw new Error('Unexpected session directory')
    }),
    ensureActiveBackend, switchSession, pushSessionInfo, setStatus,
    syncBackendSession: vi.fn(async (_backend: BackendRecord) => undefined),
    refreshSidebarSessions: vi.fn(async () => undefined),
    pushRunCheckpoint: vi.fn(), refresh: vi.fn(async () => undefined),
    markSubagentBackendGone: vi.fn(), clearBackendToolPermissionRequests: vi.fn(),
    clearBackendExtensionUiRequests: vi.fn(),
    readBackendModels: vi.fn(async (_backend: BackendRecord): Promise<ModelOption[]> => []),
    providerVisibility: { filterModels: vi.fn((models: ModelOption[]) => models) }
  }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), fields) as AgentBridge
  const internals = bridge as unknown as typeof fields
  return { root, bridge, internals, sourceCwd, targetCwd, sourceDir, targetDir,
    sourcePath, targetPath, content, source, target }
}

afterEach(async () => {
  // Release actual fixture promises/process barriers before deleting directories.
  for (const release of releases.splice(0)) release()
  for (const child of children.splice(0)) child.exit()
  await Promise.all(observations.splice(0))
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function unchanged(h: ReturnType<typeof fixture>) {
  expect(existsSync(h.targetPath)).toBe(false)
  expect(h.internals.switchSession).not.toHaveBeenCalled()
  expect(h.internals.ensureActiveBackend).not.toHaveBeenCalled()
  expect(h.internals.activeCwd).toBe(h.sourceCwd)
  if (existsSync(h.sourcePath)) expect(readFileSync(h.sourcePath, 'utf8')).toBe(h.content)
}

describe('AgentBridge migration with isolated session buckets and mocked SDK boundaries', () => {
  it('explicitly prepares a target backend for a pathless new selection', async () => {
    const h = fixture({ backend: false })
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).resolves.toBeNull()
    expect(h.internals.ensureActiveBackend).toHaveBeenCalledOnce()
    expect(h.internals.syncBackendSession).toHaveBeenCalledWith(h.target.backend)
    expect(h.internals.pushSessionInfo).toHaveBeenCalled()
    expect(h.internals.activeCwd).toBe(h.targetCwd)
    expect(h.internals.switchSession).not.toHaveBeenCalled()
    expect(existsSync(h.targetDir)).toBe(false)
  })

  it('treats allocated ENOENT as empty only with zero messages/pending and preserves exact model identity', async () => {
    const h = fixture({ path: true })
    // API/display names must not be substituted for these SDK IDs.
    h.source.state.model = { provider: 'fixture-provider', id: 'exact/model:id' } as RpcState['model']
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).resolves.toBeNull()
    expect(h.internals.ensureActiveBackend).toHaveBeenCalledOnce()
    expect(h.target.client.setModel).toHaveBeenCalledExactlyOnceWith('fixture-provider', 'exact/model:id')
    expect(h.source.client.stop).not.toHaveBeenCalled()
    expect(h.internals.activeSessionPath).toBeUndefined()
    expect(existsSync(h.sourcePath)).toBe(false)
    expect(existsSync(h.targetDir)).toBe(false)
  })

  it.each([
    { path: true, messageCount: 1, pendingMessageCount: 0 },
    { path: true, messageCount: 0, pendingMessageCount: 1 },
    { path: false, messageCount: 1, pendingMessageCount: 0 }
  ])('rejects missing history rather than discarding messages: %j', async (patch) => {
    const h = fixture({ path: patch.path })
    h.source.state.messageCount = patch.messageCount
    h.source.state.pendingMessageCount = patch.pendingMessageCount
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow()
    unchanged(h)
    expect(h.source.client.stop).not.toHaveBeenCalled()
  })

  it('fails closed when getState fails, without switching or preparing the target', async () => {
    const h = fixture({ path: true })
    h.source.client.getState.mockRejectedValue(new Error('state unavailable'))
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow('state unavailable')
    unchanged(h)
  })

  it('moves persisted history only with an explicit null process and rewrites only the header cwd', async () => {
    const h = fixture({ persisted: true })
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).resolves.toBe(h.targetPath)
    const lines = readFileSync(h.targetPath, 'utf8').split('\n')
    expect(JSON.parse(lines[0])).toEqual({ ...JSON.parse(h.content.split('\n')[0]), cwd: h.targetCwd })
    expect(lines.slice(1).join('\n')).toBe(h.content.split('\n').slice(1).join('\n'))
    expect(existsSync(h.sourcePath)).toBe(false)
    expect(h.source.client.stop).not.toHaveBeenCalled()
    expect(h.internals.switchSession).toHaveBeenCalledExactlyOnceWith(h.targetPath)
    expect(h.internals.refreshSidebarSessions).toHaveBeenCalledOnce()
  })

  it('waits for both stop settlement and real exit before any target write or source unlink', async () => {
    const h = fixture({ persisted: true })
    const child = new HistoryProcess()
    children.push(child)
    h.source.client.process = child
    const started = deferred<void>(undefined)
    const stop = deferred<void>(undefined)
    h.source.client.stop.mockImplementation(async () => {
      started.resolve()
      await stop.promise
      // SDK clearing the process handle is not proof of real process exit.
      h.source.client.process = null
    })
    const result = observe(h.bridge.migrateSessionToProject(h.targetCwd))
    await started.promise
    unchanged(h)
    expect(existsSync(h.targetDir)).toBe(false)
    stop.resolve()
    await stop.promise
    await Promise.resolve()
    unchanged(h)
    expect(existsSync(h.targetDir)).toBe(false)
    child.exit()
    expect(await result).toEqual({ ok: true, value: h.targetPath })
    expect(existsSync(h.sourcePath)).toBe(false)
  })

  it('does not publish or unlink when stop fails and the writer exit is unknown', async () => {
    const h = fixture({ persisted: true })
    const child = new HistoryProcess()
    children.push(child)
    h.source.client.process = child
    h.source.client.stop.mockRejectedValue(new Error('stop failed'))
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow('无法确认旧 Agent 已退出')
    unchanged(h)
    expect(existsSync(h.targetDir)).toBe(false)
    expect(h.source.backend.historyStopFailed).toBe(true)
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow('重启 Pion')
  })

  it('times out a settled stop with no real exit without changing either file', async () => {
    const h = fixture({ persisted: true })
    const child = new HistoryProcess()
    children.push(child)
    h.source.client.process = child
    const started = deferred<void>(undefined)
    h.source.client.stop.mockImplementation(async () => {
      h.source.client.process = null
      started.resolve()
    })
    vi.useFakeTimers()
    try {
      const result = observe(h.bridge.migrateSessionToProject(h.targetCwd))
      await started.promise
      await vi.advanceTimersByTimeAsync(5000)
      const outcome = await result
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(String(outcome.error)).toContain('无法确认旧 Agent 已退出')
      unchanged(h)
      expect(existsSync(h.targetDir)).toBe(false)
      expect(h.source.backend.historyStopFailed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an incompatible missing process adapter instead of treating it as null', async () => {
    const h = fixture({ persisted: true })
    Reflect.deleteProperty(h.source.client, 'process')
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow('无法确认旧 Agent 已退出')
    unchanged(h)
    expect(h.source.client.stop).not.toHaveBeenCalled()
  })

  it('rejects a pre-existing target without even stopping the source writer', async () => {
    const h = fixture({ persisted: true })
    mkdirSync(h.targetDir)
    writeFileSync(h.targetPath, 'existing target')
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow('目标已存在同名会话')
    expect(readFileSync(h.targetPath, 'utf8')).toBe('existing target')
    expect(readFileSync(h.sourcePath, 'utf8')).toBe(h.content)
    expect(h.source.client.stop).not.toHaveBeenCalled()
    expect(h.internals.switchSession).not.toHaveBeenCalled()
  })

  it('exclusive wx publication never overwrites a target appearing after the existence check', async () => {
    const h = fixture({ persisted: true })
    const child = new HistoryProcess()
    children.push(child)
    h.source.client.process = child
    h.source.client.stop.mockImplementation(async () => {
      mkdirSync(h.targetDir)
      writeFileSync(h.targetPath, 'concurrent target; must remain intact')
      child.exit()
    })
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow()
    expect(readFileSync(h.targetPath, 'utf8')).toBe('concurrent target; must remain intact')
    expect(readFileSync(h.sourcePath, 'utf8')).toBe(h.content)
    expect(h.internals.switchSession).not.toHaveBeenCalled()
  })

  it('rejects a changed captured selection generation after asynchronous getState', async () => {
    const h = fixture({ persisted: true })
    const state = deferred<RpcState>(h.source.state)
    h.source.client.getState.mockImplementation(() => state.promise)
    const result = observe(h.bridge.migrateSessionToProject(h.targetCwd))
    h.internals.sessionSelectionGeneration += 1
    state.resolve(h.source.state)
    const outcome = await result
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(String(outcome.error)).toContain('会话已切换')
    unchanged(h)
    expect(h.source.client.stop).not.toHaveBeenCalled()
  })

  it('rechecks the captured generation after real exit before changing any file', async () => {
    const h = fixture({ persisted: true })
    const child = new HistoryProcess()
    children.push(child)
    h.source.client.process = child
    h.source.client.stop.mockImplementation(async () => {
      h.internals.sessionSelectionGeneration += 1
      child.exit()
    })
    await expect(h.bridge.migrateSessionToProject(h.targetCwd)).rejects.toThrow('会话已切换')
    unchanged(h)
    expect(existsSync(h.targetDir)).toBe(false)
  })
})

describe('model and selection races around migration', () => {
  it('does not return or publish a late model directory for the old selection', async () => {
    const h = fixture()
    const models: ModelOption[] = [{ provider: 'old-provider', id: 'old-model', contextWindow: 8192, reasoning: false }]
    const started = deferred<void>(undefined)
    const directory = deferred<ModelOption[]>([])
    h.internals.readBackendModels.mockImplementation(async () => {
      started.resolve()
      return directory.promise
    })
    const result = observe(h.bridge.getModels())
    await started.promise
    h.internals.sessionSelectionGeneration += 1
    h.internals.activeKey = h.target.backend.key
    h.internals.backendPool.set(h.target.backend.key, h.target.backend)
    directory.resolve(models)
    expect(await result).toEqual({ ok: true, value: [] })
    expect(h.internals.providerVisibility.filterModels).not.toHaveBeenCalled()
    expect(h.internals.readBackendModels).toHaveBeenCalledExactlyOnceWith(h.source.backend)
  })

  it('never sends setModel to either wrong client after initialization resolves for an old selection', async () => {
    const h = fixture()
    const pending = deferred<BackendRecord>(h.source.backend)
    h.internals.ensureActiveBackend.mockImplementation(() => pending.promise)
    const result = observe(h.bridge.setModel('requested-provider', 'requested-id'))
    h.internals.sessionSelectionGeneration += 1
    h.internals.activeCwd = h.targetCwd
    h.internals.activeKey = h.target.backend.key
    h.internals.backendPool.set(h.target.backend.key, h.target.backend)
    pending.resolve(h.source.backend)
    const outcome = await result
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(String(outcome.error)).toContain('会话已切换')
    expect(h.source.client.setModel).not.toHaveBeenCalled()
    expect(h.target.client.setModel).not.toHaveBeenCalled()
    expect(h.internals.refresh).not.toHaveBeenCalled()
  })

  it('idempotent same-cwd start preserves selection but republishes running status and session info', async () => {
    const h = fixture({ path: true })
    const key = h.internals.activeKey
    const generation = h.internals.sessionSelectionGeneration
    await h.bridge.start(h.sourceCwd)
    await h.bridge.start(h.sourceCwd)
    expect(h.internals.activeKey).toBe(key)
    expect(h.internals.activeSessionPath).toBe(h.sourcePath)
    expect(h.internals.sessionSelectionGeneration).toBe(generation + 2)
    expect(h.internals.setStatus).toHaveBeenCalledTimes(2)
    expect(h.internals.setStatus).toHaveBeenLastCalledWith({ phase: 'running', error: undefined, cwd: h.sourceCwd })
    expect(h.internals.pushSessionInfo).toHaveBeenCalledTimes(2)
    expect(h.internals.ensureActiveBackend).not.toHaveBeenCalled()
    expect(h.internals.switchSession).not.toHaveBeenCalled()
  })
})
