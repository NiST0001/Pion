import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { GitService } from '../../src/main/git-service'
import type { TerminalService } from '../../src/main/terminal-service'
import type { WindowEffectsService } from '../../src/main/window-effects'
import { registerAgentIpc } from '../../src/main/ipc/agent'
import { registerGitIpc } from '../../src/main/ipc/git'
import { registerWindowIpc } from '../../src/main/ipc/window'
import { IPC } from '../../src/shared/ipc'
import type { BranchDeleteRequest } from '../../src/shared/branches'
import type { SessionCommandTarget } from '../../src/shared/slash-command-protocol'
import type { AddModelProviderInput, GitSelectionRequest, ImageContent, MessageRevertRequest, QueuedMessageEditRequest } from '../../src/shared/types'

type InvokeHandler = Parameters<IpcMain['handle']>[1]
type SendListener = Parameters<IpcMain['on']>[1]
type RouteCase<Service> = [channel: string, method: keyof Service, args: unknown[], forwarded?: unknown[]]

function collectIpc() {
  const handlers = new Map<string, InvokeHandler>(), listeners = new Map<string, SendListener>()
  const ipcMain = {
    handle: (channel: string, handler: InvokeHandler) => { handlers.set(channel, handler) },
    on: (channel: string, listener: SendListener) => { listeners.set(channel, listener) }
  }
  return {
    ipcMain: ipcMain as Pick<IpcMain, 'handle' | 'on'>,
    invoke: (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    send: (channel: string, event: IpcMainEvent, ...args: unknown[]) => listeners.get(channel)!(event, ...args)
  }
}

function mainEvent(id = 41, iframe = false): IpcMainInvokeEvent & IpcMainEvent {
  const mainFrame = { detached: false }
  return { sender: { id, mainFrame, isDestroyed: () => false }, senderFrame: iframe ? { detached: false } : mainFrame } as unknown as IpcMainInvokeEvent & IpcMainEvent
}

function agentHarness(
  methods: Partial<AgentBridge> = {},
  assertWorktreeDeletionIdle?: Parameters<typeof registerAgentIpc>[0]['assertWorktreeDeletionIdle'],
  getMainWindowId: () => number | undefined = () => 41
) {
  const ipc = collectIpc()
  const projects = { touchCanonical: vi.fn(async () => {}) }, pushProjects = vi.fn(async () => {})
  const withSessionOperation = vi.fn<AgentBridge['withSessionOperation']>(async operation => await operation())
  const bridge = { ...methods, withSessionOperation }
  registerAgentIpc({ ipcMain: ipc.ipcMain, bridge: bridge as unknown as AgentBridge, projects, pushProjects, assertWorktreeDeletionIdle, getMainWindowId })
  return { ...ipc, bridge, withSessionOperation, projects, pushProjects }
}

const ownerError = '只允许所属主窗口的活主帧调用'
const cwd = '/project/worktree', sessionPath = '/sessions/current.jsonl'
const queuedRequest: QueuedMessageEditRequest = { runId: 'queued-run', cwd, sessionFile: sessionPath }
const revertRequest: MessageRevertRequest = {
  sessionPath, sessionId: 'current-session', entryId: 'user-entry', expectedLeafId: 'selected-leaf'
}
const commandTarget: SessionCommandTarget = { cwd, sessionId: 'current-session', sessionPath, backendId: 'backend-id' }
const images: ImageContent[] = [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]
const query = { cwd, sessionPath, limit: 12, metricsOnly: true }
const provider: AddModelProviderInput = {
  providerId: 'local', baseUrl: 'http://localhost:8080/v1', api: 'openai-completions',
  modelIds: ['model-a'], contextWindow: 8192, maxTokens: 2048, reasoning: false, imageInput: true, authHeader: false
}
const agentRoutes: RouteCase<AgentBridge>[] = [
  [IPC.AgentStop, 'stop', []],
  [IPC.AgentSend, 'send', ['prompt', images]],
  [IPC.AgentQueue, 'queue', ['queued'], ['queued', undefined]],
  [IPC.AgentSendQueued, 'sendQueuedMessage', [queuedRequest], [queuedRequest, 41]],
  [IPC.AgentRemoveQueued, 'removeQueuedMessage', [queuedRequest], [queuedRequest, 41]],
  [IPC.AgentEditQueued, 'editQueuedMessage', [queuedRequest], [queuedRequest, 41]],
  [IPC.AgentMigrateProject, 'migrateSessionToProject', [cwd]],
  [IPC.AgentAbort, 'abort', []],
  [IPC.AgentRunCheckpoint, 'getRunCheckpoint', []],
  [IPC.AgentRollbackCheckpoint, 'rollbackRunCheckpoint', []],
  [IPC.AgentRunTelemetry, 'getRunTelemetry', [query]],
  [IPC.AgentRunRecovery, 'getRunRecoveryCandidates', [], [undefined]],
  [IPC.AgentResumeRun, 'resumeRun', ['run-id']],
  [IPC.AgentDiscardRunRecovery, 'discardRunRecovery', ['run-id']],
  [IPC.AgentRestoreRecoveredCheckpoint, 'restoreRecoveredCheckpoint', ['run-id']],
  [IPC.AgentState, 'getSessionInfo', []],
  [IPC.AgentStderr, 'getStderr', []],
  [IPC.AgentNewSession, 'newSession', []],
  [IPC.AgentFork, 'forkAt', ['entry-id']],
  [IPC.AgentSwitchSession, 'switchSession', [sessionPath]],
  [IPC.AgentDeleteSession, 'deleteSession', [sessionPath]],
  [IPC.AgentCopySession, 'copySession', [sessionPath]],
  [IPC.AgentSessionForkMessages, 'getSessionForkMessages', [sessionPath]],
  [IPC.AgentForkSession, 'forkSession', [sessionPath, 'entry-id']],
  [IPC.AgentEntries, 'getEntries', []],
  [IPC.AgentHistoryIndex, 'getHistoryIndex', [sessionPath]],
  [IPC.AgentTaskHistory, 'getSessionTaskHistory', [sessionPath]],
  [IPC.AgentRunningSessions, 'getRunningSessionPaths', []],
  [IPC.AgentUnreadSessions, 'getUnreadSessionPaths', []],
  [IPC.AgentEntriesPage, 'getEntriesPage', [120, 40, sessionPath]],
  [IPC.AgentTree, 'getTree', []],
  [IPC.AgentSessions, 'listSessions', [cwd]],
  [IPC.AgentCommands, 'getCommands', []],
  [IPC.AgentSetMode, 'setMode', ['plan']],
  [IPC.AgentSetSubagents, 'setSubagentsMode', [false, 'current-session'], [false, 'current-session', 41]],
  [IPC.AgentModels, 'getModels', []],
  [IPC.AgentModelProviders, 'getModelProviders', []],
  [IPC.AgentLoginModelProvider, 'loginModelProvider', ['provider', 'oauth']],
  [IPC.AgentLogoutModelProvider, 'logoutModelProvider', ['provider']],
  [IPC.AgentModelProviderAuthState, 'getModelProviderAuthState', []],
  [IPC.AgentCancelModelProviderAuth, 'cancelModelProviderAuth', []],
  [IPC.AgentOpenModelProviderAuthUrl, 'openModelProviderAuthUrl', ['https://example.test/auth?code=value']],
  [IPC.AgentAddModelProvider, 'addModelProvider', [provider]],
  [IPC.AgentSkills, 'getSkills', []],
  [IPC.AgentCapabilities, 'getCapabilities', []],
  [IPC.AgentSetModel, 'setModel', ['provider', 'model-id']],
  [IPC.AgentThinkingLevels, 'getThinkingLevels', []],
  [IPC.AgentSetThinking, 'setThinkingLevel', ['high']],
  [IPC.ToolPermissionPolicyGet, 'getToolPermissionPolicy', [cwd]],
  [IPC.ToolPermissionPolicySet, 'setToolPermissionPolicy', [cwd, { shell: 'ask' }]],
  [IPC.ToolPermissionPending, 'getPendingToolPermissionRequests', []],
  [IPC.ExtensionUiPending, 'getPendingExtensionUiRequests', []],
  [IPC.AgentSetAutoCompaction, 'setAutoCompaction', [false]],
  [IPC.AgentSetAutoRetry, 'setAutoRetry', [true]],
  [IPC.AgentCompact, 'compactNow', ['keep the plan']],
  [IPC.AgentExportForCommand, 'exportSessionForCommand', [commandTarget], [commandTarget, undefined, 41]],
  [IPC.AgentRenameSession, 'renameSession', ['new name', sessionPath]],
  [IPC.AgentSetSteeringMode, 'setSteeringMode', ['one-at-a-time']],
  [IPC.AgentSetFollowUpMode, 'setFollowUpMode', ['all']],
  [IPC.ProjectTrustGet, 'getProjectTrust', [cwd]],
  [IPC.ProjectTrustSet, 'setProjectTrust', [cwd, null]],
  [IPC.BranchesList, 'listBranches', [cwd]],
  [IPC.BranchCreate, 'createBranch', [cwd, 'new-branch']],
  [IPC.BranchRename, 'renameBranch', [cwd, 'old-branch', 'new-branch']]
]
const identityRoutes: RouteCase<AgentBridge>[] = [
  [IPC.AgentSessionCommandInfo, 'getSessionCommandInfo', [commandTarget], [commandTarget, 73]],
  [IPC.AgentCopyLastAssistantText, 'copyLastAssistantText', [commandTarget], [commandTarget, 73]],
  [IPC.AgentPiChangelog, 'getPiChangelog', [], [73]],
  [IPC.AgentSubagentModels, 'getSubagentModels', [], [73]],
  [IPC.AgentSetModelProviderEnabled, 'setModelProviderEnabled', ['provider', false], ['provider', false, 73]],
  [IPC.AgentRevertMessage, 'revertMessage', [revertRequest], [revertRequest, 73]],
  [IPC.AgentMcpStatus, 'getMcpStatus', [], [{}, 73]],
  [IPC.AgentSubagentSessions, 'getSubagentSessions', [], [73]],
  [IPC.AgentSubagentSession, 'getSubagentSession', ['child', 'backend'], ['child', 'backend', 73]]
]

describe('agent IPC registration', () => {
  it.each(agentRoutes)('%s forwards arguments and results to %s', async (channel, method, args, forwarded) => {
    const result = { channel }, stub = vi.fn(() => result)
    const h = agentHarness({ [method]: stub } as Partial<AgentBridge>)
    await expect(Promise.resolve(h.invoke(channel, mainEvent(), ...args))).resolves.toBe(result)
    expect(stub).toHaveBeenCalledWith(...(forwarded ?? args))
    expect(stub.mock.contexts[0]).toBe(h.bridge)
  })

  it.each(identityRoutes)('%s retains owner arguments outside session mutation admission', async (channel, method, args, forwarded) => {
    const result = { channel }, stub = vi.fn(() => result)
    const h = agentHarness({ [method]: stub } as Partial<AgentBridge>, undefined, () => 73)
    h.withSessionOperation.mockRejectedValue(new Error('session mutation busy'))
    await expect(Promise.resolve(h.invoke(channel, mainEvent(73), ...args))).resolves.toBe(result)
    expect(stub).toHaveBeenCalledWith(...forwarded!)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it.each([mainEvent(99), mainEvent(41, true)])('rejects foreign owners and child frames before bridge access', event => {
    const resolveToolPermission = vi.fn(), h = agentHarness({ resolveToolPermission })
    expect(() => h.invoke(IPC.ToolPermissionResolve, event, 'request-id', 'allow-once')).toThrow(ownerError)
    expect(resolveToolPermission).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('rechecks the original owner after asynchronous reservation admission', async () => {
    let admit!: () => void, owner: number | undefined = 41
    const admission = new Promise<void>(resolve => { admit = resolve })
    const send = vi.fn(), h = agentHarness({ send }, undefined, () => owner)
    h.withSessionOperation.mockImplementationOnce(async operation => { await admission; return operation() })
    const pending = h.invoke(IPC.AgentSend, mainEvent(), 'prompt', images)
    owner = undefined
    admit()
    await expect(pending).rejects.toThrow(ownerError)
    expect(send).not.toHaveBeenCalled()
  })

  it('holds an admitted reservation until the real send settles and rejects its retired owner result', async () => {
    let finish!: () => void, released = false
    const sent = new Promise<void>(resolve => { finish = resolve })
    const send = vi.fn(() => sent), h = agentHarness({ send })
    h.withSessionOperation.mockImplementationOnce(async operation => {
      try { return await operation() } finally { released = true }
    })
    const event = mainEvent(), pending = h.invoke(IPC.AgentSend, event, 'prompt', images)
    event.sender.isDestroyed = () => true
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith('prompt', images)
    expect(released).toBe(false)
    finish()
    await expect(pending).rejects.toThrow(ownerError)
    expect(released).toBe(true)
  })

  it('preserves mutation admission errors without sending', async () => {
    const send = vi.fn(), h = agentHarness({ send }), error = new Error('正在撤销消息，请稍后重试')
    h.withSessionOperation.mockRejectedValueOnce(error)
    await expect(h.invoke(IPC.AgentSend, mainEvent(), 'prompt')).rejects.toBe(error)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    [IPC.ToolPermissionResolve, 'resolveToolPermission', ['request-id', 'deny']],
    [IPC.ExtensionUiResolve, 'resolveExtensionUiRequest', ['request-id', { cancelled: true }]]
  ] as RouteCase<AgentBridge>[])('%s admits approval replies during replacement hooks', async (channel, method, args) => {
    const stub = vi.fn(), h = agentHarness({ [method]: stub } as Partial<AgentBridge>)
    h.withSessionOperation.mockImplementationOnce(async (operation, allowDuringReplacement) => {
      expect(allowDuringReplacement).toBe(true)
      return operation()
    })
    await h.invoke(channel, mainEvent(), ...args)
    expect(stub).toHaveBeenCalledWith(...args)
  })

  it('awaits start, canonical project registration and publication before replying', async () => {
    let finishStart!: () => void, finishTouch!: () => void, finishPush!: () => void, settled = false
    const started = new Promise<void>(resolve => { finishStart = resolve })
    const touch = new Promise<void>(resolve => { finishTouch = resolve })
    const push = new Promise<void>(resolve => { finishPush = resolve })
    const h = agentHarness({ start: vi.fn(() => started) })
    h.projects.touchCanonical.mockReturnValue(touch)
    h.pushProjects.mockReturnValue(push)
    const pending = Promise.resolve(h.invoke(IPC.AgentStart, mainEvent(), cwd)).then(() => { settled = true })
    expect(h.bridge.start).toHaveBeenCalledWith(cwd)
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    finishStart()
    await Promise.resolve()
    expect(h.projects.touchCanonical).toHaveBeenCalledWith(cwd)
    expect(h.pushProjects).not.toHaveBeenCalled()
    finishTouch()
    await Promise.resolve()
    expect(h.pushProjects).toHaveBeenCalled()
    expect(settled).toBe(false)
    finishPush()
    await pending
    expect(settled).toBe(true)
  })

  it('rejects a stale start before touching or publishing projects', async () => {
    let finish!: () => void
    const started = new Promise<void>(resolve => { finish = resolve })
    const h = agentHarness({ start: vi.fn(() => started) }), event = mainEvent()
    const pending = h.invoke(IPC.AgentStart, event, cwd)
    event.sender.isDestroyed = () => true
    finish()
    await expect(pending).rejects.toThrow(ownerError)
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
  })

  it('leaves projects unchanged when start fails', async () => {
    const error = new Error('start failed'), h = agentHarness({ start: vi.fn().mockRejectedValue(error) })
    await expect(h.invoke(IPC.AgentStart, mainEvent(), cwd)).rejects.toBe(error)
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
  })

  it.each([[true, true], [false, false], ['true', false]])('normalizes YOLO input %s to %s', async (input, expected) => {
    const setYoloMode = vi.fn(async () => {}), h = agentHarness({ setYoloMode })
    await h.invoke(IPC.AgentSetYolo, mainEvent(), input)
    expect(setYoloMode).toHaveBeenCalledWith(expected)
  })
})

describe('branch deletion IPC registration', () => {
  const request: BranchDeleteRequest = { projectCwd: '/project/main', cwd, name: 'feature/delete' }

  it('forwards the request and owner with a deferred idle guard, outside ordinary reservations', async () => {
    const result = { worktreeRemoved: true, branchDeleted: false, warning: 'branch retained' }
    const assertIdle = vi.fn(async () => {})
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(async (_request, _owner, check) => {
      expect(assertIdle).not.toHaveBeenCalled()
      await check()
      return result
    })
    const h = agentHarness({ deleteBranch }, assertIdle)
    await expect(h.invoke(IPC.BranchDelete, mainEvent(), request)).resolves.toBe(result)
    expect(deleteBranch).toHaveBeenCalledWith(request, 41, expect.any(Function))
    expect(assertIdle).toHaveBeenCalledWith(cwd)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('fails closed without the external idle guard', () => {
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(), h = agentHarness({ deleteBranch })
    expect(() => h.invoke(IPC.BranchDelete, mainEvent(), request)).toThrow('工作树删除安全检查未接入')
    expect(deleteBranch).not.toHaveBeenCalled()
  })

  it('rechecks the captured frame at the deferred deletion gate', async () => {
    let proceed!: () => void
    const ready = new Promise<void>(resolve => { proceed = resolve }), assertIdle = vi.fn()
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(async (_request, _owner, check) => {
      await ready
      await check()
      return { worktreeRemoved: true, branchDeleted: true }
    })
    const h = agentHarness({ deleteBranch }, assertIdle), event = mainEvent()
    const pending = h.invoke(IPC.BranchDelete, event, request)
    Object.defineProperty(event.sender, 'mainFrame', { value: { detached: false } })
    proceed()
    await expect(pending).rejects.toThrow(ownerError)
    expect(assertIdle).not.toHaveBeenCalled()
  })

  it('propagates a failing deferred idle check', async () => {
    const error = new Error('terminal owns target worktree'), assertIdle = vi.fn(async () => { throw error })
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(async (_request, _owner, check) => {
      await check()
      return { worktreeRemoved: true, branchDeleted: true }
    })
    const h = agentHarness({ deleteBranch }, assertIdle)
    await expect(h.invoke(IPC.BranchDelete, mainEvent(), request)).rejects.toBe(error)
  })
})

const selection: GitSelectionRequest = {
  cwd, snapshotId: 'snapshot-id', path: 'src/file.ts', action: 'stage', hunkId: 'hunk-id', lineIds: ['line-a', 'line-b']
}
const gitRoutes: RouteCase<GitService>[] = [
  [IPC.GitCommitTree, 'getCommitTree', [cwd, { revision: 'a'.repeat(64), offset: 200 }]],
  [IPC.GitStatus, 'getStatus', [cwd]],
  [IPC.GitDiff, 'getDiff', [cwd, 'src/file.ts', 'staged']],
  [IPC.GitStagePaths, 'stagePaths', [cwd, 'snapshot-id', ['src/file.ts', 'file with spaces.txt']]],
  [IPC.GitUnstagePaths, 'unstagePaths', [cwd, 'snapshot-id', ['src/file.ts']]],
  [IPC.GitDiscardPaths, 'discardPaths', [cwd, 'snapshot-id', ['src/file.ts']]],
  [IPC.GitApplySelection, 'applySelection', [selection]],
  [IPC.GitCommit, 'commit', [cwd, 'snapshot-id', 'commit summary\n\nbody']],
  [IPC.GitConflictRead, 'readConflict', [cwd, 'src/file.ts']],
  [IPC.GitConflictResolve, 'resolveConflict', [cwd, 'snapshot-id', 'src/file.ts', 'content', '\nresolved content\n']],
  [IPC.GitConflictResolve, 'resolveConflict', [cwd, 'snapshot-id', 'src/file.ts', 'ours'], [cwd, 'snapshot-id', 'src/file.ts', 'ours', undefined]],
  [IPC.GitOperationContinue, 'continueOperation', [cwd, 'snapshot-id']],
  [IPC.GitOperationAbort, 'abortOperation', [cwd, 'snapshot-id']]
]

describe('Git IPC registration', () => {
  it.each(gitRoutes)('%s forwards arguments and results to %s', async (channel, method, args, forwarded) => {
    const h = collectIpc(), value = { snapshotId: 'next-snapshot' }, stub = vi.fn().mockResolvedValue(value)
    const git = { [method]: stub }
    registerGitIpc({ ipcMain: h.ipcMain, git: git as unknown as GitService, getMainWindowId: () => 41 })
    await expect(h.invoke(channel, mainEvent(), ...args)).resolves.toBe(value)
    expect(stub).toHaveBeenCalledWith(...(forwarded ?? args))
    expect(stub.mock.contexts[0]).toBe(git)
  })

  it('rejects subframes before reading and drops a late result after the original sender changes', async () => {
    const h = collectIpc()
    let finish!: (value: unknown) => void
    const getStatus = vi.fn(() => new Promise(resolve => { finish = resolve }))
    registerGitIpc({ ipcMain: h.ipcMain, git: { getStatus } as unknown as GitService, getMainWindowId: () => 41 })
    expect(() => h.invoke(IPC.GitStatus, mainEvent(41, true), cwd)).toThrow(ownerError)
    expect(getStatus).not.toHaveBeenCalled()
    const event = mainEvent(), pending = h.invoke(IPC.GitStatus, event, cwd)
    Object.defineProperty(event, 'sender', { value: { ...event.sender } })
    finish({ snapshotId: 'next-snapshot' })
    await expect(pending).rejects.toThrow(ownerError)
  })

  it('preserves synchronous and asynchronous Git failures', async () => {
    const h = collectIpc(), error = new Error('Git snapshot rejected')
    const getStatus = vi.fn<GitService['getStatus']>(() => { throw error })
    registerGitIpc({ ipcMain: h.ipcMain, git: { getStatus } as unknown as GitService, getMainWindowId: () => 41 })
    expect(() => h.invoke(IPC.GitStatus, mainEvent(), cwd)).toThrow(error)
    getStatus.mockRejectedValueOnce(error)
    await expect(h.invoke(IPC.GitStatus, mainEvent(), cwd)).rejects.toBe(error)
  })
})

function windowHarness(reserveMutation?: Parameters<typeof registerWindowIpc>[0]['reserveMutation']) {
  const ipc = collectIpc()
  const win = {
    isDestroyed: vi.fn(() => false), isMaximized: vi.fn(() => false),
    minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), close: vi.fn()
  }
  const windowFromWebContents = vi.fn<Parameters<typeof registerWindowIpc>[0]['windowFromWebContents']>(() => win as unknown as BrowserWindow)
  const windowEffects = { get: vi.fn(), setEnabled: vi.fn().mockResolvedValue(undefined) }
  const terminals = { open: vi.fn().mockResolvedValue(undefined), write: vi.fn(), resize: vi.fn(), close: vi.fn() }
  registerWindowIpc({
    ipcMain: ipc.ipcMain, windowFromWebContents,
    windowEffects: windowEffects as unknown as WindowEffectsService,
    terminals: terminals as unknown as TerminalService, reserveMutation
  })
  return { ...ipc, win, windowFromWebContents, windowEffects, terminals }
}

describe('window IPC registration', () => {
  it('reserves terminal opening before admission and forwards its captured owner', async () => {
    let admit!: () => void
    const admission = new Promise<void>(resolve => { admit = resolve })
    const h = windowHarness(async operation => { await admission; return operation() })
    const result = { id: 'terminal-id' }
    h.terminals.open.mockResolvedValue(result)
    const pending = h.invoke(IPC.TerminalOpen, mainEvent(73), cwd, 100, 32)
    expect(h.terminals.open).not.toHaveBeenCalled()
    admit()
    await expect(pending).resolves.toBe(result)
    expect(h.terminals.open).toHaveBeenCalledWith(73, cwd, 100, 32)
  })

  it('leaves the terminal unopened when mutation admission rejects', async () => {
    const error = new Error('worktree deletion in progress')
    const h = windowHarness(async () => { throw error })
    await expect(h.invoke(IPC.TerminalOpen, mainEvent(), cwd, 80, 24)).rejects.toBe(error)
    expect(h.terminals.open).not.toHaveBeenCalled()
  })

  it('returns false when the sender has no window', () => {
    const h = windowHarness()
    h.windowFromWebContents.mockReturnValue(null)
    expect(h.invoke(IPC.WindowState, mainEvent())).toBe(false)
  })

  it.each([
    ['minimize', false, 'minimize'], ['toggle-maximize', false, 'maximize'],
    ['toggle-maximize', true, 'unmaximize'], ['close', false, 'close']
  ] as const)('handles %s with maximized=%s', (action, maximized, method) => {
    const h = windowHarness(), event = mainEvent()
    h.win.isMaximized.mockReturnValue(maximized)
    h.send(IPC.WindowControl, event, action)
    expect(h.windowFromWebContents).toHaveBeenCalledWith(event.sender)
    expect(h.win[method]).toHaveBeenCalled()
  })

  it.each(['missing', 'destroyed', 'unknown-action'])('ignores controls for %s', reason => {
    const h = windowHarness()
    if (reason === 'missing') h.windowFromWebContents.mockReturnValue(null)
    if (reason === 'destroyed') h.win.isDestroyed.mockReturnValue(true)
    for (const action of reason === 'unknown-action' ? ['unknown'] : ['minimize', 'toggle-maximize', 'close']) {
      h.send(IPC.WindowControl, mainEvent(), action)
    }
    for (const method of ['isMaximized', 'minimize', 'maximize', 'unmaximize', 'close'] as const) {
      expect(h.win[method]).not.toHaveBeenCalled()
    }
  })

  it.each([
    [IPC.GetWindowEffects, 'get', []], [IPC.SetWindowEffects, 'setEnabled', [true]]
  ] as const)('%s forwards appearance ownership and arguments', async (channel, method, args) => {
    const h = windowHarness(), result = { enabled: true, revision: 7 }
    h.windowEffects[method].mockReturnValueOnce(method === 'setEnabled' ? Promise.resolve(result) : result)
    await expect(Promise.resolve(h.invoke(channel, mainEvent(73), ...args))).resolves.toBe(result)
    expect(h.windowEffects[method]).toHaveBeenCalledWith(73, ...args, ...(method === 'setEnabled' ? [expect.any(Function)] : []))
  })

  it.each([
    [IPC.TerminalWrite, 'write', ['terminal-id', 'printf "hello"\r']],
    [IPC.TerminalResize, 'resize', ['terminal-id', 120, 40]],
    [IPC.TerminalClose, 'close', ['terminal-id']]
  ] as const)('%s forwards owner and terminal arguments', async (channel, method, args) => {
    const h = windowHarness(), result = { id: 'terminal-id' }
    h.terminals[method].mockResolvedValueOnce(result)
    await expect(h.invoke(channel, mainEvent(73), ...args)).resolves.toBe(result)
    expect(h.terminals[method]).toHaveBeenCalledWith(73, ...args)
  })
})
