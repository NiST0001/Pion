import { resolve } from 'node:path'
import type { RpcClient, SessionStats } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { BackendPool } from '../../src/main/agent/backend-pool'
import { LiveSessionProjection } from '../../src/main/agent/live-session-state'
import type { BackendRecord } from '../../src/main/agent/types'
import type { PionApi } from '../../src/shared/pion-api'
import type { SessionCommandTarget } from '../../src/shared/slash-command-protocol'
import { IPC } from '../../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  UnknownFileState: class extends Error {},
  clipboard: vi.fn(), expose: vi.fn(), invoke: vi.fn(),
  readChangelog: vi.fn(), exportPath: vi.fn(), jsonl: vi.fn(), writeJsonl: vi.fn(), publish: vi.fn(), pathExists: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: {}, clipboard: { writeText: mocks.clipboard },
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }
}))
vi.mock('../../src/main/agent/utils', async (original) => ({
  ...await original<typeof import('../../src/main/agent/utils')>(), pathExists: mocks.pathExists
}))
vi.mock('../../src/main/agent/slash-command-files', () => ({
  SessionCommandFileStateUnknownError: mocks.UnknownFileState,
  SESSION_COMMAND_TEXT_MAX_BYTES: 1024 * 1024,
  readPiChangelog: mocks.readChangelog, sessionCommandExportPath: mocks.exportPath,
  sessionCommandJsonl: mocks.jsonl, writeSessionCommandJsonl: mocks.writeJsonl,
  publishSessionCommandExport: mocks.publish
}))

type RpcState = Awaited<ReturnType<RpcClient['getState']>>
type RpcHistory = Awaited<ReturnType<RpcClient['getEntries']>>
const owner = 41
const cwd = '/project/worktree'
const sessionPath = '/sessions/current.jsonl'
const scratch = '/project/worktree/.pion-session-export-private/session.html'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function treeWithSavedMessage(): RpcHistory {
  return {
    entries: [{ type: 'message', id: 'saved-other-branch', parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'persisted on another branch', timestamp: 1 } }],
    leafId: null // The selected branch is empty, not the full tree.
  }
}

function setup() {
  const state: RpcState = {
    sessionId: 'session-a', sessionFile: sessionPath, sessionName: 'Session A', thinkingLevel: 'high',
    isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 7,
    steeringMode: 'all', followUpMode: 'all', autoCompactionEnabled: true
  }
  const stats: SessionStats = {
    sessionId: state.sessionId, sessionFile: sessionPath,
    userMessages: 100, assistantMessages: 95, toolCalls: 250, toolResults: 249, totalMessages: 448,
    tokens: { input: 111, output: 222, cacheRead: 333, cacheWrite: 444, total: 1110 }, cost: 0.45,
    contextUsage: { tokens: null, contextWindow: 200_000, percent: null }
  }
  const forbidden = () => { throw new Error('Unexpected backend/model mutation') }
  let eventListener: Parameters<RpcClient['onEvent']>[0] | undefined
  const client = {
    onEvent: vi.fn<RpcClient['onEvent']>((listener) => { eventListener = listener; return () => {} }),
    getState: vi.fn(async () => ({ ...state })), getSessionStats: vi.fn(async () => stats),
    getLastAssistantText: vi.fn<() => Promise<string | null>>().mockResolvedValue('  full assistant text\n'),
    getEntries: vi.fn<RpcClient['getEntries']>().mockResolvedValue({ entries: [], leafId: null }),
    exportHtml: vi.fn(async (path?: string) => ({ path: path! })),
    getMessages: vi.fn(forbidden), getCommands: vi.fn(forbidden), prompt: vi.fn(forbidden),
    start: vi.fn(forbidden), stop: vi.fn(forbidden)
  }
  const backend: BackendRecord = {
    key: 'selected', cwd, sessionPath, client: client as unknown as RpcClient,
    liveState: new LiveSessionProjection(), phase: 'running', busy: false, compacting: false,
    pendingRunIds: [], localFollowUps: [], companionRunIds: [], directSteering: [],
    rawQueue: { steering: [], followUp: [] }, startPromise: new Promise(() => {})
  }
  const pool = new BackendPool()
  pool.add(backend)
  const frame = { detached: false }
  const win = { webContents: { id: owner, mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn() }, isDestroyed: vi.fn(() => false) }
  const fields = {
    win: win as typeof win | null, activeKey: backend.key, activeCwd: cwd,
    activeSessionPath: sessionPath as string | undefined,
    sessionSelectionGeneration: 1, historyRevision: 1, stopping: false, providerMutationInFlight: false,
    providerReloading: false, newSessionInFlight: null, messageRevertInFlight: false,
    sessionMigrationInFlight: false, branchDeletionInFlight: false, sessionOperationsInFlight: 0,
    sessionCommandExportInFlight: false, sessionCommandFilesUnknown: false,
    backendPool: pool, runStore: { hasUnsettledSessionRuns: vi.fn(() => false) },
    desiredModes: new Map(), trackBackendEvent: vi.fn(), pushRunningSessionPaths: vi.fn(),
    setActiveBackendStatus: vi.fn(), syncBackendSession: vi.fn(async () => {}),
    getPendingToolPermissionRequests: vi.fn(() => []), getPendingExtensionUiRequests: vi.fn(() => []),
    ensureActiveBackend: vi.fn(forbidden), createBackend: vi.fn(forbidden)
  }
  // Prototype-only fixture: no SDK factories, credentials, filesystem, process or model.
  const bridge = Object.assign(Object.create(AgentBridge.prototype), fields) as AgentBridge
  const internals = bridge as unknown as typeof fields & {
    dispatchLifecycle(backend: BackendRecord): { generation: number; token?: symbol }
    attachBackendEvents(backend: BackendRecord): void
  }
  const target: SessionCommandTarget = { cwd, sessionId: state.sessionId, sessionPath, backendId: backend.liveState!.backendId }
  const exportSession = (path?: string) => bridge.withSessionOperation(() => bridge.exportSessionForCommand(target, path, owner))
  const noModel = () => {
    for (const name of ['prompt', 'start', 'stop', 'getMessages', 'getCommands'] as const) expect(client[name]).not.toHaveBeenCalled()
    expect(fields.ensureActiveBackend).not.toHaveBeenCalled()
    expect(fields.createBackend).not.toHaveBeenCalled()
  }
  return { bridge, internals, backend, pool, win, state, stats, client, target, exportSession, noModel,
    emit: (event: Parameters<Parameters<RpcClient['onEvent']>[0]>[0]) => eventListener?.(event) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readChangelog.mockReset().mockImplementation(async (assert: () => void) => {
    assert()
    return { version: 'sdk-fixture', markdown: '# Pi changelog' }
  })
  mocks.exportPath.mockReset().mockImplementation((directory: string, path?: string) => resolve(directory, path ?? 'session-default.html'))
  mocks.jsonl.mockReset().mockReturnValue('current-branch-jsonl\n')
  mocks.writeJsonl.mockReset().mockResolvedValue(undefined)
  mocks.pathExists.mockReset().mockResolvedValue(true)
  mocks.publish.mockReset().mockImplementation(async (destination: string, produce: (path: string) => Promise<void>, assert: () => void) => {
    assert()
    await produce(scratch)
    assert()
    return destination
  })
})

describe('session slash-command bridge reads', () => {
  it('projects exact full SDK statistics, not the context estimate or finite history', async () => {
    const h = setup()
    const info = await h.bridge.getSessionCommandInfo(h.target, owner)
    expect(info).toEqual({ cwd, sessionId: 'session-a', sessionPath, sessionName: 'Session A', stats: {
      userMessages: 100, assistantMessages: 95, toolCalls: 250, toolResults: 249, totalMessages: 448,
      tokens: h.stats.tokens, cost: 0.45
    } })
    expect(info.stats.tokens).not.toBe(h.stats.tokens)
    expect(JSON.stringify(info)).not.toContain('contextUsage')
    expect(h.client.getSessionStats).toHaveBeenCalledExactlyOnceWith()
    expect(h.client.getEntries).not.toHaveBeenCalled()
    h.noModel()
  })

  it('treats optional path/backend fields as fences, including a fresh SDK-allocated but unpersisted path', async () => {
    const h = setup()
    await expect(h.bridge.getSessionCommandInfo({ cwd, sessionId: 'session-a' }, owner)).resolves.toHaveProperty('sessionPath', sessionPath)
    h.internals.activeSessionPath = undefined
    h.backend.sessionPath = undefined
    await expect(h.bridge.getSessionCommandInfo(h.target, owner)).resolves.toHaveProperty('sessionPath', sessionPath)
    await expect(h.bridge.copyLastAssistantText({ cwd, sessionId: 'session-a' }, owner)).resolves.toBe(true)
    expect(mocks.clipboard).toHaveBeenCalledOnce()
    h.noModel()
  })

  it('refuses statistics belonging to a different SDK session even if its counters look valid', async () => {
    const h = setup()
    h.stats.sessionId = 'other-session'
    await expect(h.bridge.getSessionCommandInfo(h.target, owner)).rejects.toThrow('统计身份已变化')
    h.noModel()
  })

  it.each(['missing', 'negative', 'nan', 'unsafe'])('fails visibly on %s statistics without inventing zeroes', async (kind) => {
    const h = setup()
    if (kind === 'missing') delete (h.stats as Partial<SessionStats>).tokens
    if (kind === 'negative') h.stats.toolCalls = -1
    if (kind === 'nan') h.stats.cost = Number.NaN
    if (kind === 'unsafe') h.stats.tokens.total = Number.MAX_SAFE_INTEGER + 1
    await expect(h.bridge.getSessionCommandInfo(h.target, owner)).rejects.toThrow('未以零值替代')
    h.noModel()
  })

  it('copies the real RPC last text, preserving whitespace and never scanning history', async () => {
    const h = setup()
    await expect(h.bridge.copyLastAssistantText(h.target, owner)).resolves.toBe(true)
    expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith('  full assistant text\n')
    expect(h.client.getLastAssistantText).toHaveBeenCalledExactlyOnceWith()
    expect(h.client.getEntries).not.toHaveBeenCalled()
    expect(h.client.getState).toHaveBeenCalledTimes(2)
    h.noModel()
  })

  it.each([null, '', undefined])('returns false for empty SDK text %s without touching the clipboard', async (text) => {
    const h = setup()
    h.client.getLastAssistantText.mockResolvedValueOnce(text as string | null)
    await expect(h.bridge.copyLastAssistantText(h.target, owner)).resolves.toBe(false)
    expect(mocks.clipboard).not.toHaveBeenCalled()
    h.noModel()
  })

  it('rejects a UTF-8 oversized response rather than copying or truncating it', async () => {
    const h = setup()
    h.client.getLastAssistantText.mockResolvedValueOnce('中'.repeat(400_000))
    await expect(h.bridge.copyLastAssistantText(h.target, owner)).rejects.toThrow('超过复制上限')
    expect(mocks.clipboard).not.toHaveBeenCalled()
  })

  it.each(['window', 'frame', 'cwd', 'path', 'key', 'backend', 'client', 'backendId', 'generation', 'run'])
  ('rejects late clipboard writes after %s identity changes', async (change) => {
    const h = setup()
    const text = deferred<string | null>()
    h.client.getLastAssistantText.mockReturnValueOnce(text.promise)
    const copied = h.bridge.copyLastAssistantText(h.target, owner)
    const observed = expect(copied).rejects.toThrow(/变化|所属主窗口/)
    await Promise.resolve()
    if (change === 'window') h.internals.win = { ...h.win }
    if (change === 'frame') h.win.webContents.mainFrame = { detached: false }
    if (change === 'cwd') h.internals.activeCwd = '/other'
    if (change === 'path') h.internals.activeSessionPath = '/sessions/other.jsonl'
    if (change === 'key') h.internals.activeKey = 'other-key'
    if (change === 'backend') h.pool.add({ ...h.backend })
    if (change === 'client') h.backend.client = {} as RpcClient
    if (change === 'backendId') h.backend.liveState = new LiveSessionProjection()
    if (change === 'generation') h.internals.sessionSelectionGeneration += 2 // includes A -> B -> A
    if (change === 'run') h.internals.dispatchLifecycle(h.backend).generation++
    text.resolve('late old-session text')
    await observed
    expect(mocks.clipboard).not.toHaveBeenCalled()
  })

  it('checks the second SDK state even if Bridge selection did not change', async () => {
    const h = setup()
    h.client.getState.mockResolvedValueOnce({ ...h.state }).mockResolvedValueOnce({ ...h.state, sessionId: 'other' })
    await expect(h.bridge.copyLastAssistantText(h.target, owner)).rejects.toThrow('SDK 会话身份已变化')
    expect(mocks.clipboard).not.toHaveBeenCalled()
  })

  it('does not query statistics after the captured state read becomes stale', async () => {
    const h = setup()
    const state = deferred<RpcState>()
    h.client.getState.mockReturnValueOnce(state.promise)
    const info = h.bridge.getSessionCommandInfo(h.target, owner)
    const observed = expect(info).rejects.toThrow('状态已变化')
    h.internals.historyRevision++
    state.resolve(h.state)
    await observed
    expect(h.client.getSessionStats).not.toHaveBeenCalled()
  })

  it('holds a read slot until the actual read settles, even after window/selection replacement', async () => {
    const h = setup()
    const state = deferred<RpcState>()
    h.client.getState.mockReturnValueOnce(state.promise)
    const pending = h.bridge.getSessionCommandInfo(h.target, owner)
    const observed = expect(pending).rejects.toThrow('状态已变化')
    h.internals.sessionSelectionGeneration++
    await expect(h.bridge.getSessionCommandInfo(h.target, owner)).rejects.toThrow('仍在读取')
    expect(h.client.getState).toHaveBeenCalledTimes(1)
    state.resolve(h.state)
    await observed
    await expect(h.bridge.getSessionCommandInfo(h.target, owner)).resolves.toHaveProperty('sessionId', 'session-a')
  })

  it.each(['missing', 'starting', 'owner', 'destroyed', 'target'])('fails %s reads without creating/waiting for a backend', async (condition) => {
    const h = setup()
    if (condition === 'missing') h.pool.clear()
    if (condition === 'starting') h.backend.phase = 'starting'
    if (condition === 'destroyed') h.win.isDestroyed.mockReturnValue(true)
    if (condition === 'target') h.target.cwd = '/other'
    const requestedOwner = condition === 'owner' ? owner + 1 : owner
    await expect(h.bridge.getSessionCommandInfo(h.target, requestedOwner)).rejects.toThrow()
    await expect(h.bridge.copyLastAssistantText(h.target, requestedOwner)).rejects.toThrow()
    expect(h.client.getState).not.toHaveBeenCalled()
    h.noModel()
  })

  it('reads only the fixed changelog helper, without requiring a selected backend', async () => {
    const h = setup()
    h.pool.clear()
    await expect(h.bridge.getPiChangelog(owner)).resolves.toEqual({ version: 'sdk-fixture', markdown: '# Pi changelog' })
    expect(mocks.readChangelog).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(h.client.getState).not.toHaveBeenCalled()
    await expect(h.bridge.getPiChangelog(owner + 1)).rejects.toThrow('所属主窗口')
    expect(mocks.readChangelog).toHaveBeenCalledTimes(1)
    h.noModel()
  })

  it('rejects late changelog results after owner replacement and latches unknown FD closure', async () => {
    const h = setup()
    const read = deferred<{ version: string; markdown: string }>()
    mocks.readChangelog.mockReturnValueOnce(read.promise)
    const result = h.bridge.getPiChangelog(owner)
    const observed = expect(result).rejects.toThrow('所属主窗口')
    h.internals.win = { ...h.win }
    read.resolve({ version: 'old', markdown: 'old' })
    await observed
    mocks.readChangelog.mockRejectedValueOnce(new mocks.UnknownFileState('close unknown'))
    await expect(h.bridge.getPiChangelog(owner)).rejects.toThrow('close unknown')
    await expect(h.bridge.withSessionOperation(() => 'unrelated operation')).resolves.toBe('unrelated operation')
    await expect(h.bridge.getSessionCommandInfo(h.target, owner)).resolves.toHaveProperty('sessionId', 'session-a')
    await expect(h.bridge.getPiChangelog(owner)).rejects.toThrow('收尾未知')
  })
})

describe('explicit slash-command export', () => {
  it('defaults to HTML and only passes the helper-private scratch path to RPC', async () => {
    const h = setup()
    await expect(h.exportSession()).resolves.toBe(`${cwd}/session-default.html`)
    expect(mocks.exportPath).toHaveBeenCalledExactlyOnceWith(cwd, undefined)
    expect(mocks.publish).toHaveBeenCalledWith(`${cwd}/session-default.html`, expect.any(Function), expect.any(Function))
    expect(h.client.exportHtml).toHaveBeenCalledExactlyOnceWith(scratch)
    expect(h.client.getEntries).not.toHaveBeenCalled()
    expect(h.backend.historyMutation).not.toBe(true)
    expect(h.backend.sessionExportPending).toBe(false)
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    h.noModel()
  })

  it('rejects a foreign owner or target before export makes any SDK/FS calls', async () => {
    const h = setup()
    await expect(h.bridge.exportSessionForCommand(h.target, undefined, owner + 1)).rejects.toThrow('所属主窗口')
    h.target.backendId = 'wrong-backend'
    await expect(h.exportSession()).rejects.toThrow('状态已变化')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('uses full RPC entries and the actual leaf with current state identity for JSONL', async () => {
    const h = setup()
    const history = { entries: [], leafId: null }
    h.client.getEntries.mockResolvedValueOnce(history)
    await expect(h.exportSession('exports/current.JSONL')).resolves.toBe(`${cwd}/exports/current.JSONL`)
    expect(mocks.jsonl).toHaveBeenCalledExactlyOnceWith(cwd, 'session-a', history)
    expect(mocks.writeJsonl).toHaveBeenCalledWith(scratch, 'current-branch-jsonl\n', expect.any(Function))
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    h.noModel()
  })

  it.each(['busy', 'pending-rpc', 'queue', 'other-operation', 'undo', 'ledger'])('rejects %s before filesystem work', async (condition) => {
    const h = setup()
    if (condition === 'busy') h.backend.busy = true
    if (condition === 'pending-rpc') h.backend.promptDispatch = { promise: new Promise(() => {}), runId: 'pending' }
    if (condition === 'queue') h.backend.rawQueue!.followUp.push('not sent')
    if (condition === 'other-operation') h.internals.sessionOperationsInFlight = 1
    if (condition === 'undo') h.internals.messageRevertInFlight = true
    if (condition === 'ledger') h.internals.runStore.hasUnsettledSessionRuns.mockReturnValue(true)
    await expect(h.exportSession()).rejects.toThrow()
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('reserves synchronously, excludes undo and host mutations, and awaits the actual HTML RPC', async () => {
    const h = setup()
    const entered = deferred<void>(), exported = deferred<{ path: string }>()
    h.client.exportHtml.mockImplementationOnce(() => { entered.resolve(); return exported.promise })
    const pending = h.exportSession('explicit.html')
    expect(h.internals.sessionCommandExportInFlight).toBe(true)
    await entered.promise
    await expect(h.bridge.withSessionOperation(() => { throw new Error('must not run') })).rejects.toThrow('正在导出')
    await expect(h.bridge.revertMessage({ sessionPath, sessionId: 'session-a', entryId: 'user', expectedLeafId: null }, owner)).rejects.toThrow('正在导出')
    expect(h.internals.sessionOperationsInFlight).toBe(1)
    expect(h.backend.historyMutation).not.toBe(true)
    expect(h.backend.sessionExportPending).toBe(true)
    exported.resolve({ path: scratch })
    await expect(pending).resolves.toBe(`${cwd}/explicit.html`)
    expect(h.internals.sessionOperationsInFlight).toBe(0)
    expect(h.backend.historyMutation).not.toBe(true)
    expect(h.backend.sessionExportPending).toBe(false)
  })

  it('does not release the export gate while helper FS publication/cleanup remains pending', async () => {
    const h = setup()
    const cleanup = deferred<string>(), entered = deferred<void>()
    mocks.publish.mockImplementationOnce(async (_destination: string, produce: (path: string) => Promise<void>) => {
      await produce(scratch)
      entered.resolve()
      return cleanup.promise
    })
    const pending = h.exportSession()
    await entered.promise
    await expect(h.exportSession()).rejects.toThrow('正在导出')
    expect(h.internals.sessionOperationsInFlight).toBe(1)
    cleanup.resolve(`${cwd}/session-default.html`)
    await pending
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
  })

  it('awaits a late RPC but never publishes old-session HTML into a new selection', async () => {
    const h = setup()
    const entered = deferred<void>(), exported = deferred<{ path: string }>()
    h.client.exportHtml.mockImplementationOnce(() => { entered.resolve(); return exported.promise })
    const pending = h.exportSession()
    const observed = expect(pending).rejects.toThrow('状态已变化')
    await entered.promise
    h.internals.sessionSelectionGeneration += 2
    expect(h.internals.sessionCommandExportInFlight).toBe(true)
    exported.resolve({ path: scratch })
    await observed
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    expect(h.internals.sessionCommandFilesUnknown).toBe(false) // this real RPC did complete
    expect(h.client.exportHtml).toHaveBeenCalledTimes(1)
  })

  it('isolates unknown scratch writers without blocking unrelated sessions or retrying the export', async () => {
    const h = setup()
    h.client.exportHtml.mockRejectedValueOnce(new Error('Timeout waiting for response / process gone'))
    await expect(h.exportSession()).rejects.toBeInstanceOf(mocks.UnknownFileState)
    expect(h.internals.sessionCommandFilesUnknown).toBe(true)
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    expect(h.backend.sessionExportPending).toBe(false)
    expect(h.backend.historyMutation).not.toBe(true)
    h.internals.sessionSelectionGeneration++
    await expect(h.exportSession()).rejects.toThrow('收尾未知')
    await expect(h.bridge.withSessionOperation(() => 'normal session action')).resolves.toBe('normal session action')
    await expect(h.bridge.copyLastAssistantText(h.target, owner)).resolves.toBe(true)
    expect(h.client.exportHtml).toHaveBeenCalledTimes(1)
  })

  it('keeps unknown close isolation export-local, while ordinary failure allows a later export', async () => {
    const h = setup()
    mocks.publish.mockRejectedValueOnce(new Error('target exists; not overwritten'))
    await expect(h.exportSession()).rejects.toThrow('target exists')
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    mocks.publish.mockRejectedValueOnce(new mocks.UnknownFileState('write handle close unknown'))
    await expect(h.exportSession('out.jsonl')).rejects.toThrow('close unknown')
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    await expect(h.exportSession('other.jsonl')).rejects.toThrow('收尾未知')
    await expect(h.bridge.withSessionOperation(() => undefined)).resolves.toBeUndefined()
  })

  it.each(['empty', 'unpersisted'])('rejects a known %s HTML session before the export RPC without poisoning session actions', async (kind) => {
    const h = setup()
    if (kind === 'empty') h.state.messageCount = 0
    else mocks.pathExists.mockResolvedValueOnce(false)
    await expect(h.exportSession()).rejects.toThrow('没有已落盘的消息')
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(h.internals.sessionCommandFilesUnknown).toBe(false)
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    await expect(h.bridge.withSessionOperation(() => 'normal action')).resolves.toBe('normal action')
  })

  it('allows HTML for an empty selected branch when another full-tree branch has a saved message', async () => {
    const h = setup()
    h.state.messageCount = 0
    h.client.getEntries.mockResolvedValueOnce(treeWithSavedMessage())
    await expect(h.exportSession()).resolves.toBe(`${cwd}/session-default.html`)
    expect(mocks.pathExists).toHaveBeenCalledExactlyOnceWith(sessionPath)
    expect(h.client.getEntries).toHaveBeenCalledExactlyOnceWith()
    expect(h.client.getState).toHaveBeenCalledTimes(3) // initial, after full-tree read, after export
    expect(h.client.exportHtml).toHaveBeenCalledExactlyOnceWith(scratch)
    expect(mocks.jsonl).not.toHaveBeenCalled()
    h.noModel()
  })

  it('does not mistake a metadata-only full tree for saved messages', async () => {
    const h = setup()
    h.state.messageCount = 0
    h.client.getEntries.mockResolvedValueOnce({ entries: [
      { type: 'session_info', id: 'metadata', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', name: 'Empty tree' }
    ], leafId: null })
    await expect(h.exportSession()).rejects.toThrow('没有已落盘的消息')
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(h.internals.sessionCommandFilesUnknown).toBe(false)
    h.noModel()
  })

  it.each(['missing-file', 'zero-unpersisted', 'invalid-count'])('rejects %s before inspecting the full tree or invoking export', async (kind) => {
    const h = setup()
    h.state.messageCount = 0
    if (kind === 'missing-file') {
      h.internals.activeSessionPath = undefined
      h.backend.sessionPath = undefined
      delete h.target.sessionPath
      delete h.state.sessionFile
    }
    if (kind === 'zero-unpersisted') mocks.pathExists.mockResolvedValueOnce(false)
    if (kind === 'invalid-count') h.state.messageCount = Number.NaN
    await expect(h.exportSession()).rejects.toThrow('没有已落盘的消息')
    expect(h.client.getEntries).not.toHaveBeenCalled()
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(h.internals.sessionCommandFilesUnknown).toBe(false)
    h.noModel()
  })

  it.each(['invalid', 'oversized'])('rejects an %s full-tree response before export even if its first entry is a message', async (kind) => {
    const h = setup()
    h.state.messageCount = 0
    const history = treeWithSavedMessage()
    if (kind === 'invalid') (history as { entries: unknown }).entries = null
    else history.entries.length = 100_001
    h.client.getEntries.mockResolvedValueOnce(history)
    await expect(h.exportSession()).rejects.toThrow('会话树数据无效或超过 HTML 导出上限')
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(h.internals.sessionCommandFilesUnknown).toBe(false)
    h.noModel()
  })

  it.each(['scope', 'busy'])('rechecks %s after the file-existence read before requesting any full-tree entries', async (change) => {
    const h = setup()
    h.state.messageCount = 0
    const entered = deferred<void>(), exists = deferred<boolean>()
    mocks.pathExists.mockImplementationOnce(() => { entered.resolve(); return exists.promise })
    const pending = h.exportSession()
    const observed = expect(pending).rejects.toThrow()
    await entered.promise
    if (change === 'scope') h.internals.sessionSelectionGeneration++
    else h.backend.busy = true
    exists.resolve(true)
    await observed
    expect(h.client.getEntries).not.toHaveBeenCalled()
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    h.noModel()
  })

  it.each(['scope', 'client', 'run', 'busy', 'pending-rpc', 'sdk-session', 'sdk-path', 'sdk-streaming', 'sdk-compacting', 'sdk-pending'])
  ('rejects %s changes during the full-tree read and holds the real export gate until that RPC settles', async (change) => {
    const h = setup()
    h.state.messageCount = 0
    const entered = deferred<void>(), history = deferred<RpcHistory>()
    h.client.getEntries.mockImplementationOnce(() => { entered.resolve(); return history.promise })
    const pending = h.exportSession()
    const observed = expect(pending).rejects.toThrow()
    await entered.promise
    if (change === 'scope') h.internals.sessionSelectionGeneration++
    if (change === 'client') h.backend.client = {} as RpcClient
    if (change === 'run') h.internals.dispatchLifecycle(h.backend).generation++
    if (change === 'busy') h.backend.busy = true
    if (change === 'pending-rpc') h.backend.promptDispatch = { promise: new Promise(() => {}), runId: 'pending' }
    if (change === 'sdk-session') h.state.sessionId = 'other-session'
    if (change === 'sdk-path') h.state.sessionFile = '/sessions/other.jsonl'
    if (change === 'sdk-streaming') h.state.isStreaming = true
    if (change === 'sdk-compacting') h.state.isCompacting = true
    if (change === 'sdk-pending') h.state.pendingMessageCount = 1
    expect(h.internals.sessionCommandExportInFlight).toBe(true)
    expect(h.backend.sessionExportPending).toBe(true)
    expect(h.backend.historyMutation).not.toBe(true)
    await expect(h.exportSession()).rejects.toThrow('正在导出')
    history.resolve(treeWithSavedMessage())
    await observed
    expect(h.client.exportHtml).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(h.internals.sessionCommandExportInFlight).toBe(false)
    expect(h.backend.sessionExportPending).toBe(false)
    expect(h.internals.sessionCommandFilesUnknown).toBe(false)
    h.noModel()
  })

  it('processes a real SDK agent_start during export and rejects publication without losing its event or lifecycle', async () => {
    const h = setup()
    h.internals.attachBackendEvents(h.backend)
    const entered = deferred<void>(), exported = deferred<{ path: string }>()
    h.client.exportHtml.mockImplementationOnce(() => { entered.resolve(); return exported.promise })
    const pending = h.exportSession()
    const observed = expect(pending).rejects.toThrow('状态已变化')
    await entered.promise
    h.emit({ type: 'agent_start' })
    expect(h.internals.dispatchLifecycle(h.backend).generation).toBe(1)
    expect(h.backend.busy).toBe(true)
    expect(h.internals.trackBackendEvent).toHaveBeenCalledWith(h.backend, { type: 'agent_start' }, 'agent_start')
    expect(h.win.webContents.send).toHaveBeenCalled()
    exported.resolve({ path: scratch })
    await observed
    expect(h.backend.sessionExportPending).toBe(false)
    expect(h.internals.sessionCommandFilesUnknown).toBe(false)
  })
})

describe('typed preload slash-command channels', () => {
  it('forwards exact targets and optional paths on their dedicated channels', async () => {
    await import('../../src/preload/index')
    const api = mocks.expose.mock.calls[0][1] as PionApi
    const target: SessionCommandTarget = { cwd, sessionId: 'session-a', sessionPath, backendId: 'backend-a' }
    const calls: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.getSessionCommandInfo(target), IPC.AgentSessionCommandInfo, [target]],
      [() => api.copyLastAssistantText(target), IPC.AgentCopyLastAssistantText, [target]],
      [() => api.getPiChangelog(), IPC.AgentPiChangelog, []],
      [() => api.exportSessionForCommand(target, 'a b.jsonl'), IPC.AgentExportForCommand, [target, 'a b.jsonl']],
      [() => api.exportSessionForCommand(target), IPC.AgentExportForCommand, [target, undefined]]
    ]
    for (const [call, channel, args] of calls) {
      const result = Promise.resolve({ channel })
      mocks.invoke.mockReturnValueOnce(result)
      expect(call()).toBe(result)
      expect(mocks.invoke).toHaveBeenLastCalledWith(channel, ...args)
      await result
    }
  })
})
