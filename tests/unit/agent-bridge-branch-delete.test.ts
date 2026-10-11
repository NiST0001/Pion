import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentBridge as AgentBridgeType } from '../../src/main/agent/agent-bridge'
import { BackendPool } from '../../src/main/agent/backend-pool'
import type { BackendRecord } from '../../src/main/agent/types'
let AgentBridge: typeof import('../../src/main/agent/agent-bridge').AgentBridge
let branchDelete: typeof import('../../src/main/git/branch-delete')
const realpath = vi.fn(async (path: unknown) => String(path))

const request = { projectCwd: '/project', cwd: '/worktree', name: 'feature' }
const result = { worktreeRemoved: true, branchDeleted: true }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null })
  const client = {
    process: child as typeof child | null,
    getState: vi.fn(async () => ({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 })),
    stop: vi.fn(async () => { child.exitCode = 0; child.emit('exit', 0, null); client.process = null })
  }
  const backend = { key: 'target', cwd: request.cwd, sessionPath: '/history/target.jsonl',
    phase: 'running', busy: false, compacting: false, pendingRunIds: [], localFollowUps: [],
    companionRunIds: [], directSteering: [], rawQueue: { steering: [], followUp: [] },
    client, startPromise: Promise.resolve() } as unknown as BackendRecord
  const backendPool = new BackendPool()
  backendPool.add(backend)
  const fields = {
    win: { webContents: { id: 7 } }, activeCwd: request.projectCwd, activeKey: 'main',
    status: { cwd: request.projectCwd }, sessionSelectionGeneration: 1,
    branchDeletionInFlight: false, messageRevertInFlight: false, sessionOperationsInFlight: 0,
    historyRevision: 0, stopping: false, providerMutationInFlight: false, providerReloading: false,
    newSessionInFlight: null, unconfirmedStoppedWorktreeCwds: new Set<string>(),
    quarantinedSessionPaths: new Set<string>(), backendPool,
    backendKeysBySessionPath: new Map([[backend.sessionPath!, backend.key]]),
    sessionManagers: new Map(), sessionManagerSignatures: new Map(),
    runStore: { list: vi.fn((): Array<{ state: string }> => []), hasUnsettledSessionRuns: vi.fn(() => false), hasUnsettledCwdRuns: vi.fn(() => false) },
    getPendingToolPermissionRequests: vi.fn(() => []), getPendingExtensionUiRequests: vi.fn(() => []),
    clearBackendToolPermissionRequests: vi.fn(), clearBackendExtensionUiRequests: vi.fn()
  }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), fields) as AgentBridgeType
  // Suite-scoped mock only; retain the real process-exit barrier and avoid filesystem/Git side effects.
  const paths = realpath.mockReset().mockImplementation(async (path) => String(path))
  const git = vi.fn(async (): Promise<typeof result & { warning?: string }> => result)
  const prepare = vi.spyOn(branchDelete, 'prepareWorktreeBranchDeletion').mockImplementation(async (_root, _cwd, _name, idle) => {
    await idle()
    return async () => { await idle(); return git() }
  })
  // Observe and mutate the actual bridge fields, not Object.assign's source snapshot.
  return { bridge, fields: bridge as unknown as typeof fields, backend, client, child, git, prepare, paths, idle: vi.fn(async () => undefined) }
}
describe('AgentBridge branch deletion lifecycle', () => {
  beforeAll(async () => {
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return { ...actual, realpath }
    })
    ;({ AgentBridge } = await import('../../src/main/agent/agent-bridge'))
    branchDelete = await import('../../src/main/git/branch-delete')
  })
  afterEach(() => { vi.restoreAllMocks() })
  afterAll(() => {
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })

  it('gets real state and confirms process exit before removing records and invoking Git', async () => {
    const h = fixture()
    h.git.mockImplementation(async () => {
      expect(h.child.exitCode).toBe(0)
      expect(h.fields.backendPool.get(h.backend.key)).toBeUndefined()
      expect(h.fields.backendKeysBySessionPath.size).toBe(0)
      return result
    })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).resolves.toEqual(result)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.prepare.mock.invocationCallOrder[0]).toBeLessThan(h.client.getState.mock.invocationCallOrder[0])
    expect(h.client.getState).toHaveBeenCalledTimes(1)
    expect(h.client.stop).toHaveBeenCalledTimes(1)
    expect(h.fields.branchDeletionInFlight).toBe(false)
  })

  it('holds the gate across external checks and rejects all synchronous startup/selection entrypoints', async () => {
    const h = fixture()
    const wait = deferred()
    const deletion = h.bridge.deleteBranch(request, 7, () => wait.promise)
    try {
      await expect(h.bridge.withSessionOperation(() => undefined)).rejects.toThrow('正在删除分支')
      await expect(h.bridge.start('/other')).rejects.toThrow('正在删除分支')
      await expect(h.bridge.newSession()).rejects.toThrow('正在删除分支')
      await expect(h.bridge.switchSession('/history/other')).rejects.toThrow('正在删除分支')
      await expect(h.bridge.startVerificationRepair(undefined, '/other', 'repair')).rejects.toThrow('正在删除分支')
      await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('正在删除分支')
    } finally { wait.resolve(); await deletion }
  })

  it.each(['busy', 'compacting', 'awaitingRetry', 'runCompletionPromise', 'checkpointCreatePromise'])('refuses %s before stopping', async (field) => {
    const h = fixture()
    Object.assign(h.backend, { [field]: true })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow()
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.git).not.toHaveBeenCalled()
  })

  it('rejects the wrong owner and an in-flight ordinary operation before external checks', async () => {
    const h = fixture()
    await expect(h.bridge.deleteBranch(request, 8, h.idle)).rejects.toThrow('窗口或会话已变化')
    h.fields.sessionOperationsInFlight = 1
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('会话操作')
    expect(h.idle).not.toHaveBeenCalled()
    expect(h.git).not.toHaveBeenCalled()
  })

  it('rejects SDK pending messages and rechecks activity created during the external await', async () => {
    const h = fixture()
    h.client.getState.mockResolvedValueOnce({ isStreaming: false, isCompacting: false, pendingMessageCount: 1 })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('排队消息')
    await expect(h.bridge.deleteBranch(request, 7, async () => { h.backend.awaitingRetry = true })).rejects.toThrow('所有运行')
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.git).not.toHaveBeenCalled()
  })

  it('refuses main worktree and current worktree without switching automatically', async () => {
    const h = fixture()
    await expect(h.bridge.deleteBranch({ ...request, cwd: request.projectCwd }, 7, h.idle)).rejects.toThrow('主工作树')
    h.fields.activeCwd = request.cwd
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('请先切换到主工作树再删除')
    expect(h.client.stop).not.toHaveBeenCalled()
  })

  it('rechecks owner after state await, without invoking stop or Git', async () => {
    const h = fixture()
    h.client.getState.mockImplementation(async () => {
      h.fields.win.webContents.id = 9
      return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
    })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('窗口或会话已变化')
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.git).not.toHaveBeenCalled()
    expect(h.backend.historyMutation).toBe(false)
  })

  it('does not equate SDK stop resolution with actual process exit', async () => {
    const h = fixture()
    const stopped = deferred()
    h.client.stop.mockImplementation(async () => { h.client.process = null; stopped.resolve() })
    const deletion = h.bridge.deleteBranch(request, 7, h.idle)
    await stopped.promise
    expect(h.git).not.toHaveBeenCalled()
    expect(h.fields.backendPool.get(h.backend.key)).toBe(h.backend)
    h.child.exitCode = 0
    h.child.emit('exit', 0, null)
    await deletion
    expect(h.git).toHaveBeenCalledTimes(1)
  })

  it('quarantines failed shutdown and never retries from a null process', async () => {
    const h = fixture()
    h.client.stop.mockImplementation(async () => { h.client.process = null; throw new Error('stop failed') })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('stop failed')
    expect(h.backend.historyStopFailed).toBe(true)
    expect(h.fields.quarantinedSessionPaths.has(h.backend.sessionPath!)).toBe(true)
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('旧Agent退出未确认')
    expect(h.client.stop).toHaveBeenCalledTimes(1)
    expect(h.git).not.toHaveBeenCalled()
  })

  it('rejects a previously discarded handle and a currently null handle', async () => {
    const h = fixture()
    h.fields.unconfirmedStoppedWorktreeCwds.add(request.cwd)
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('旧Agent退出未确认')
    h.fields.unconfirmedStoppedWorktreeCwds.clear()
    h.client.process = null
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('旧Agent退出未确认')
    expect(h.client.stop).not.toHaveBeenCalled()
  })

  it('preflights Git before any backend state query or stop, with zero lifecycle side effects on failure', async () => {
    const h = fixture()
    h.prepare.mockRejectedValueOnce(new Error('dirty or unmerged worktree'))
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('dirty or unmerged worktree')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.git).not.toHaveBeenCalled()
    expect(h.backend.historyMutation).toBeUndefined()
    expect(h.fields.backendPool.get(h.backend.key)).toBe(h.backend)
    expect(h.fields.branchDeletionInFlight).toBe(false)
  })

  it.each(['worktree', '/worktree/../worktree', '/worktree/', '/worktree/.git/child'])('rejects raw noncanonical path %s without querying or stopping', async (cwd) => {
    const h = fixture()
    await expect(h.bridge.deleteBranch({ ...request, cwd }, 7, h.idle)).rejects.toThrow('路径无效')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it.each(['backend', 'active', 'quarantined', 'process'])('rejects %s directory aliases before state queries or shutdown', async (source) => {
    const h = fixture()
    const alias = '/alias'
    if (source === 'backend') h.backend.cwd = alias
    if (source === 'active') h.fields.activeCwd = alias
    if (source === 'quarantined') h.fields.unconfirmedStoppedWorktreeCwds.add(alias)
    const mapped = source === 'process' ? process.cwd() : alias
    h.paths.mockImplementation(async (path) => String(path) === mapped ? request.cwd : String(path))
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('别名或符号链接')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.fields.branchDeletionInFlight).toBe(false)
  })

  it('fails closed for an unrelated missing quarantined cwd', async () => {
    const h = fixture()
    h.fields.unconfirmedStoppedWorktreeCwds.add('/missing')
    h.paths.mockImplementation(async (path) => {
      if (String(path) === '/missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return String(path)
    })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('无法确认 Agent 工作目录')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
  })

  it('rechecks cwd mappings immediately after external callbacks', async () => {
    const h = fixture()
    await expect(h.bridge.deleteBranch(request, 7, async () => {
      h.paths.mockImplementation(async (path) => String(path) === request.cwd ? '/replacement' : String(path))
    })).rejects.toThrow('别名或符号链接')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('rechecks cwd mappings after SDK callbacks before shutdown', async () => {
    const h = fixture()
    h.client.getState.mockImplementation(async () => {
      h.paths.mockImplementation(async (path) => String(path) === request.cwd ? '/replacement' : String(path))
      return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
    })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('别名或符号链接')
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.git).not.toHaveBeenCalled()
  })

  it('keeps the preflight closure across shutdown rather than recapturing changed identities', async () => {
    const h = fixture()
    let identity = 1
    h.prepare.mockImplementation(async (_root, _cwd, _name, idle) => {
      await idle()
      const captured = identity
      return async () => {
        await idle()
        if (captured !== identity) throw new Error('工作树目录身份已改变')
        return h.git()
      }
    })
    h.client.stop.mockImplementation(async () => {
      identity++
      h.child.exitCode = 0
      h.child.emit('exit', 0, null)
      h.client.process = null
    })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('目录身份已改变')
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.git).not.toHaveBeenCalled()
    expect(h.fields.branchDeletionInFlight).toBe(false)
  })

  it('uses the full cwd ledger instead of a capped list of recent runs', async () => {
    const h = fixture()
    h.fields.runStore.hasUnsettledCwdRuns.mockReturnValue(true)
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('运行记录')
    expect(h.fields.runStore.hasUnsettledCwdRuns).toHaveBeenCalledWith(request.cwd)
    expect(h.fields.runStore.list).not.toHaveBeenCalled()
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
  })

  it('does not mistake 100 old settled records for incomplete idle evidence', async () => {
    const h = fixture()
    h.fields.runStore.list.mockReturnValue(Array.from({ length: 100 }, () => ({ state: 'completed' })))
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).resolves.toEqual(result)
    expect(h.fields.runStore.list).not.toHaveBeenCalled()
    expect(h.fields.runStore.hasUnsettledCwdRuns).toHaveBeenCalledWith(request.cwd)
  })

  it.each(['window', 'webContents'])('rejects destroyed %s even with the correct owner id', async (source) => {
    const h = fixture()
    Object.assign(source === 'window' ? h.fields.win : h.fields.win.webContents, { isDestroyed: () => true })
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('窗口或会话已变化')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
  })

  it('preserves partial Git success, and releases the gate on Git failure', async () => {
    const h = fixture()
    const partial = { worktreeRemoved: true, branchDeleted: false, warning: 'retained branch' }
    h.git.mockResolvedValueOnce(partial)
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).resolves.toEqual(partial)
    h.git.mockRejectedValueOnce(new Error('Git check failed'))
    await expect(h.bridge.deleteBranch(request, 7, h.idle)).rejects.toThrow('Git check failed')
    expect(h.fields.branchDeletionInFlight).toBe(false)
  })
})
