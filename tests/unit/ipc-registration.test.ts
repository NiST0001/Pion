import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { GitService } from '../../src/main/git-service'
import type { TerminalService } from '../../src/main/terminal-service'
import type { WindowEffectsService } from '../../src/main/window-effects'
import { registerAgentIpc } from '../../src/main/ipc/agent'
import { registerGitIpc } from '../../src/main/ipc/git'
import { registerUsageIpc } from '../../src/main/ipc/usage'
import { registerWindowIpc } from '../../src/main/ipc/window'
import { registerComputerUseIpc } from '../../src/main/ipc/computer-use'
import type { ComputerUseService } from '../../src/main/computer-use/service'
import { IPC } from '../../src/shared/ipc'
import type { BranchDeleteRequest, BranchDeleteResult } from '../../src/shared/branches'
import type { McpStatusTarget } from '../../src/shared/mcp'
import type { SessionCommandTarget } from '../../src/shared/slash-command-protocol'
import type { AddModelProviderInput, GitSelectionRequest, ImageContent, MessageRevertRequest, RunTelemetryQuery } from '../../src/shared/types'

type InvokeHandler = Parameters<IpcMain['handle']>[1]
type SendListener = Parameters<IpcMain['on']>[1]
type RouteCase<Service> = [channel: string, method: keyof Service, args: unknown[], forwarded?: unknown[]]

function collectIpc() {
  const handlers = new Map<string, InvokeHandler>()
  const listeners = new Map<string, SendListener>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: SendListener) => {
      if (listeners.has(channel)) throw new Error(`Duplicate listener: ${channel}`)
      listeners.set(channel, listener)
    })
  }
  return {
    ipcMain: ipcMain as unknown as Pick<IpcMain, 'handle' | 'on'>,
    handlers,
    listeners,
    invoke: (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    send: (channel: string, event: IpcMainEvent, ...args: unknown[]) => listeners.get(channel)!(event, ...args)
  }
}

function mainEvent(id = 41, iframe = false): IpcMainInvokeEvent & IpcMainEvent {
  const mainFrame = {}
  return { sender: { id, mainFrame, isDestroyed: () => false }, senderFrame: iframe ? {} : mainFrame } as unknown as IpcMainInvokeEvent & IpcMainEvent
}

function agentHarness(
  methods: Partial<AgentBridge> = {},
  assertWorktreeDeletionIdle?: Parameters<typeof registerAgentIpc>[0]['assertWorktreeDeletionIdle']
) {
  const ipc = collectIpc()
  const projects = { touchCanonical: vi.fn(async () => {}) }
  const pushProjects = vi.fn(async () => {})
  const withSessionOperation = vi.fn<AgentBridge['withSessionOperation']>(async (operation) => await operation())
  const bridge = { ...methods, withSessionOperation }
  // This harness supplies only the methods exercised by each route case, not
  // the bridge's private runtime/lifecycle state.
  registerAgentIpc({ ipcMain: ipc.ipcMain, bridge: bridge as unknown as AgentBridge, projects, pushProjects, assertWorktreeDeletionIdle, getMainWindowId: () => 41 })
  return { ...ipc, bridge, withSessionOperation, projects, pushProjects }
}

const cwd = '/project/worktree'
const sessionPath = '/sessions/current.jsonl'
const revertRequest: MessageRevertRequest = {
  sessionPath, sessionId: 'current-session', entryId: 'user-entry', expectedLeafId: 'selected-leaf'
}
const images: ImageContent[] = [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]
const query: RunTelemetryQuery = { cwd, sessionPath, limit: 12, metricsOnly: true }
const provider: AddModelProviderInput = {
  providerId: 'local', baseUrl: 'http://localhost:8080/v1', api: 'openai-completions',
  modelIds: ['model-a'], contextWindow: 8192, maxTokens: 2048, reasoning: false, imageInput: true, authHeader: false
}

const agentRoutes: RouteCase<AgentBridge>[] = [
  [IPC.AgentStop, 'stop', []],
  [IPC.AgentSend, 'send', ['prompt', images]],
  [IPC.AgentSend, 'send', ['prompt'], ['prompt', undefined]],
  [IPC.AgentQueue, 'queue', ['queued', images]],
  [IPC.AgentQueue, 'queue', ['queued'], ['queued', undefined]],
  [IPC.AgentSendQueued, 'sendQueuedMessage', ['steering', 2]],
  [IPC.AgentRemoveQueued, 'removeQueuedMessage', ['followUp', 3]],
  [IPC.AgentMigrateProject, 'migrateSessionToProject', [cwd]],
  [IPC.AgentAbort, 'abort', []],
  [IPC.AgentRunCheckpoint, 'getRunCheckpoint', []],
  [IPC.AgentRollbackCheckpoint, 'rollbackRunCheckpoint', []],
  [IPC.AgentRunTelemetry, 'getRunTelemetry', [query]],
  [IPC.AgentRunTelemetry, 'getRunTelemetry', [], [undefined]],
  [IPC.AgentRunRecovery, 'getRunRecoveryCandidates', [query]],
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
  [IPC.AgentHistoryIndex, 'getHistoryIndex', [], [undefined]],
  [IPC.AgentTaskHistory, 'getSessionTaskHistory', [sessionPath]],
  [IPC.AgentRunningSessions, 'getRunningSessionPaths', []],
  [IPC.AgentUnreadSessions, 'getUnreadSessionPaths', []],
  [IPC.AgentEntriesPage, 'getEntriesPage', [120, 40, sessionPath]],
  [IPC.AgentEntriesPage, 'getEntriesPage', [undefined, 30, sessionPath]],
  [IPC.AgentEntriesPage, 'getEntriesPage', [], [undefined, undefined, undefined]],
  [IPC.AgentTree, 'getTree', []],
  [IPC.AgentSessions, 'listSessions', [cwd]],
  [IPC.AgentSessions, 'listSessions', [], [undefined]],
  [IPC.AgentCommands, 'getCommands', []],
  [IPC.AgentSetMode, 'setMode', ['plan']],
  [IPC.AgentModels, 'getModels', []],
  [IPC.AgentModelProviders, 'getModelProviders', []],
  [IPC.AgentLoginModelProvider, 'loginModelProvider', ['provider', 'oauth']],
  [IPC.AgentLoginModelProvider, 'loginModelProvider', ['provider', 'api_key']],
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
  [IPC.ToolPermissionPolicySet, 'setToolPermissionPolicy', [cwd, null]],
  [IPC.ToolPermissionPending, 'getPendingToolPermissionRequests', []],
  [IPC.ToolPermissionResolve, 'resolveToolPermission', ['request-id', 'deny']],
  [IPC.ExtensionUiPending, 'getPendingExtensionUiRequests', []],
  [IPC.ExtensionUiResolve, 'resolveExtensionUiRequest', ['request-id', { cancelled: true }]],
  [IPC.AgentSetAutoCompaction, 'setAutoCompaction', [false]],
  [IPC.AgentSetAutoRetry, 'setAutoRetry', [true]],
  [IPC.AgentCompact, 'compactNow', ['keep the plan']],
  [IPC.AgentCompact, 'compactNow', [], [undefined]],
  [IPC.AgentExportHtml, 'exportSessionHtml', []],
  [IPC.AgentRenameSession, 'renameSession', ['new name', sessionPath]],
  [IPC.AgentRenameSession, 'renameSession', ['new name'], ['new name', undefined]],
  [IPC.AgentSetSteeringMode, 'setSteeringMode', ['one-at-a-time']],
  [IPC.AgentSetFollowUpMode, 'setFollowUpMode', ['all']],
  [IPC.ProjectTrustGet, 'getProjectTrust', [cwd]],
  [IPC.ProjectTrustSet, 'setProjectTrust', [cwd, null]],
  [IPC.ProjectTrustSet, 'setProjectTrust', [cwd, false]],
  [IPC.BranchesList, 'listBranches', [cwd]],
  [IPC.BranchCreate, 'createBranch', [cwd, 'new-branch']],
  [IPC.BranchRename, 'renameBranch', [cwd, 'old-branch', 'new-branch']]
]

const commandTarget: SessionCommandTarget = { cwd, sessionId: 'current-session', sessionPath, backendId: 'backend-id' }
const sessionCommandRoutes: Array<[string, keyof AgentBridge, unknown[], unknown[], string]> = [
  [IPC.AgentSessionCommandInfo, 'getSessionCommandInfo', [commandTarget], [commandTarget, 73], '只允许主窗口读取会话命令信息'],
  [IPC.AgentCopyLastAssistantText, 'copyLastAssistantText', [commandTarget], [commandTarget, 73], '只允许主窗口复制助手正文'],
  [IPC.AgentPiChangelog, 'getPiChangelog', [], [73], '只允许主窗口读取 Pi 更新日志'],
  [IPC.AgentExportForCommand, 'exportSessionForCommand', [commandTarget, 'exports/session.jsonl'],
    [commandTarget, 'exports/session.jsonl', 73], '只允许主窗口导出会话'],
  [IPC.AgentExportForCommand, 'exportSessionForCommand', [commandTarget], [commandTarget, undefined, 73], '只允许主窗口导出会话']
]

// These routes intentionally turn both synchronous results and throws into promises.
const reservedAgentChannels = new Set<string>([
  IPC.AgentStart, IPC.AgentStop, IPC.AgentSend, IPC.AgentQueue, IPC.AgentSendQueued,
  IPC.AgentRemoveQueued, IPC.AgentEditQueued, IPC.AgentMigrateProject, IPC.AgentAbort, IPC.AgentRollbackCheckpoint,
  IPC.AgentResumeRun, IPC.AgentDiscardRunRecovery, IPC.AgentRestoreRecoveredCheckpoint,
  IPC.AgentNewSession, IPC.AgentFork, IPC.AgentSwitchSession, IPC.AgentDeleteSession,
  IPC.AgentCopySession, IPC.AgentForkSession, IPC.AgentSetMode, IPC.AgentSetYolo,
  IPC.AgentSetSubagents, IPC.AgentLoginModelProvider, IPC.AgentLogoutModelProvider,
  IPC.AgentAddModelProvider, IPC.AgentSetModel, IPC.AgentSetThinking, IPC.AgentSetAutoCompaction,
  IPC.AgentSetAutoRetry, IPC.AgentCompact, IPC.AgentExportHtml, IPC.AgentExportForCommand, IPC.AgentRenameSession,
  IPC.AgentSetSteeringMode, IPC.AgentSetFollowUpMode, IPC.ProjectTrustSet,
  IPC.ToolPermissionResolve, IPC.ExtensionUiResolve, IPC.BranchCreate, IPC.BranchRename
])

describe('branch deletion IPC registration', () => {
  const request: BranchDeleteRequest = { projectCwd: '/project/main', cwd, name: 'feature/delete' }

  it('forwards the original request, owner and deferred cwd guard without reserving itself', async () => {
    const result: BranchDeleteResult = { worktreeRemoved: true, branchDeleted: false, warning: 'branch retained' }
    const assertIdle = vi.fn(async () => {})
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(async (_request, _owner, check) => {
      expect(assertIdle).not.toHaveBeenCalled()
      await check()
      return result
    })
    const h = agentHarness({ deleteBranch }, assertIdle)
    await expect(h.invoke(IPC.BranchDelete, mainEvent(73), request)).resolves.toBe(result)
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith(request, 73, expect.any(Function))
    expect(deleteBranch.mock.contexts[0]).toBe(h.bridge)
    expect(assertIdle).toHaveBeenCalledExactlyOnceWith(request.cwd)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
  })

  it('fails closed without an external idle guard', () => {
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>()
    const h = agentHarness({ deleteBranch })
    expect(() => h.invoke(IPC.BranchDelete, mainEvent(), request)).toThrow('工作树删除安全检查未接入')
    expect(deleteBranch).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('rejects iframe access before invoking the bridge or guard', () => {
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>()
    const assertIdle = vi.fn()
    const h = agentHarness({ deleteBranch }, assertIdle)
    expect(() => h.invoke(IPC.BranchDelete, mainEvent(73, true), request)).toThrow('只允许主窗口删除分支')
    expect(deleteBranch).not.toHaveBeenCalled()
    expect(assertIdle).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('preserves synchronous and asynchronous bridge failures', async () => {
    const error = new Error('owner or worktree rejected')
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(() => { throw error })
    const h = agentHarness({ deleteBranch }, vi.fn())
    expect(() => h.invoke(IPC.BranchDelete, mainEvent(), request)).toThrow(error)
    deleteBranch.mockRejectedValueOnce(error)
    await expect(h.invoke(IPC.BranchDelete, mainEvent(), request)).rejects.toBe(error)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
  })

  it('propagates a failing deferred idle check unchanged', async () => {
    const error = new Error('terminal owns target worktree')
    const assertIdle = vi.fn(async () => { throw error })
    const deleteBranch = vi.fn<AgentBridge['deleteBranch']>(async (_request, _owner, check) => {
      await check()
      return { worktreeRemoved: true, branchDeleted: true }
    })
    const h = agentHarness({ deleteBranch }, assertIdle)
    await expect(h.invoke(IPC.BranchDelete, mainEvent(), request)).rejects.toBe(error)
    expect(assertIdle).toHaveBeenCalledExactlyOnceWith(request.cwd)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })
})

describe('slash-command IPC registration', () => {
  it.each(sessionCommandRoutes)('%s forwards identity, owner, path and receiver to %s', async (channel, method, args, forwarded) => {
    const value = { result: channel }
    const stub = vi.fn().mockReturnValue(value)
    const h = agentHarness({ [method]: stub } as Partial<AgentBridge>)
    const reserved = reservedAgentChannels.has(channel)
    await expect(Promise.resolve(h.invoke(channel, mainEvent(73), ...args))).resolves.toBe(value)
    expect(stub).toHaveBeenCalledExactlyOnceWith(...forwarded)
    expect(stub.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).toHaveBeenCalledTimes(reserved ? 1 : 0)
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
    const error = new Error('command owner or selection rejected')
    stub.mockImplementationOnce(() => { throw error })
    if (reserved) await expect(h.invoke(channel, mainEvent(73), ...args)).rejects.toBe(error)
    else expect(() => h.invoke(channel, mainEvent(73), ...args)).toThrow(error)
    stub.mockRejectedValueOnce(error)
    await expect(h.invoke(channel, mainEvent(73), ...args)).rejects.toBe(error)
  })

  it.each(sessionCommandRoutes)('%s rejects iframe access before command %s', async (channel, method, args, _forwarded, message) => {
    const stub = vi.fn()
    const h = agentHarness({ [method]: stub } as Partial<AgentBridge>)
    if (reservedAgentChannels.has(channel)) {
      await expect(h.invoke(channel, mainEvent(73, true), ...args)).rejects.toThrow(message)
    } else {
      expect(() => h.invoke(channel, mainEvent(73, true), ...args)).toThrow(message)
    }
    expect(stub).not.toHaveBeenCalled()
  })

  it('keeps export inside its mutation reservation until the bridge promise settles', async () => {
    let finish!: (path: string) => void
    const pending = new Promise<string>((resolve) => { finish = resolve })
    const order: string[] = []
    const exportSessionForCommand = vi.fn(() => { order.push('export'); return pending })
    const h = agentHarness({ exportSessionForCommand })
    h.withSessionOperation.mockImplementationOnce(async (operation) => {
      order.push('reserve')
      try { return await operation() } finally { order.push('release') }
    })
    const result = h.invoke(IPC.AgentExportForCommand, mainEvent(73), commandTarget)
    expect(order).toEqual(['reserve', 'export'])
    finish('/project/worktree/session.html')
    await expect(result).resolves.toBe('/project/worktree/session.html')
    expect(order).toEqual(['reserve', 'export', 'release'])
  })
})

describe('queued message editing IPC registration', () => {
  const request = { cwd, sessionFile: sessionPath, runId: 'queued-run' }

  it('forwards exact request and owner under session reservation without other service access', async () => {
    const result = { ...request, text: 'draft', images: [] }
    const editQueuedMessage = vi.fn().mockReturnValue(result)
    const h = agentHarness({ editQueuedMessage })
    await expect(h.invoke(IPC.AgentEditQueued, mainEvent(73), request)).resolves.toBe(result)
    expect(editQueuedMessage).toHaveBeenCalledExactlyOnceWith(request, 73)
    expect(editQueuedMessage.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
  })

  it('rejects iframe access before editing the queue', async () => {
    const editQueuedMessage = vi.fn()
    const h = agentHarness({ editQueuedMessage })
    await expect(h.invoke(IPC.AgentEditQueued, mainEvent(73, true), request)).rejects.toThrow('只允许主窗口编辑排队消息')
    expect(editQueuedMessage).not.toHaveBeenCalled()
  })

  it('preserves bridge owner and run validation failures', async () => {
    const error = new Error('queued run ownership rejected')
    const editQueuedMessage = vi.fn(() => { throw error })
    const h = agentHarness({ editQueuedMessage })
    await expect(h.invoke(IPC.AgentEditQueued, mainEvent(), request)).rejects.toThrow(error)
  })
})

describe('agent IPC registration', () => {
  it('registers exactly the agent domain without touching services at registration time', () => {
    const h = agentHarness()
    expect([...h.handlers.keys()].sort()).toEqual([...new Set([
      ...agentRoutes.map(([channel]) => channel), ...sessionCommandRoutes.map(([channel]) => channel),
      IPC.AgentStart, IPC.AgentSetYolo, IPC.AgentSetSubagents,
      IPC.AgentRevertMessage, IPC.AgentMcpStatus, IPC.BranchDelete, IPC.AgentEditQueued,
      IPC.AgentSubagentSessions, IPC.AgentSubagentSession, IPC.AgentSetModelProviderEnabled, IPC.AgentSubagentModels,
      IPC.GetCapabilitySettings, IPC.UpdateCapabilitySettings
    ])].sort())
    expect(h.listeners.size).toBe(0)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
  })

  it.each(agentRoutes)('%s forwards to %s with its receiver, arguments, result and errors', async (channel, method, args, forwarded) => {
    const result = { channel }
    const stub = vi.fn().mockReturnValue(result)
    const bridge = { [method]: stub }
    const h = agentHarness(bridge as Partial<AgentBridge>)
    const reserved = reservedAgentChannels.has(channel)
    const returned = h.invoke(channel, mainEvent(), ...args)
    if (reserved) {
      await expect(returned).resolves.toBe(result)
      if (channel === IPC.ToolPermissionResolve || channel === IPC.ExtensionUiResolve) {
        expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function), true)
      } else {
        expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
      }
      expect(h.withSessionOperation.mock.contexts[0]).toBe(h.bridge)
    } else {
      expect(returned).toBe(result)
      expect(h.withSessionOperation).not.toHaveBeenCalled()
    }
    expect(stub).toHaveBeenCalledExactlyOnceWith(...(forwarded ?? args))
    expect(stub.mock.contexts[0]).toBe(h.bridge)
    const promised = Promise.resolve(result)
    stub.mockReturnValueOnce(promised)
    const pending = h.invoke(channel, mainEvent(), ...args)
    if (reserved) await expect(pending).resolves.toBe(result)
    else expect(pending).toBe(promised)
    const error = new Error('agent operation failed')
    stub.mockImplementationOnce(() => { throw error })
    if (reserved) await expect(h.invoke(channel, mainEvent(), ...args)).rejects.toBe(error)
    else expect(() => h.invoke(channel, mainEvent(), ...args)).toThrow(error)
    stub.mockRejectedValueOnce(error)
    await expect(h.invoke(channel, mainEvent(), ...args)).rejects.toBe(error)
  })

  it('waits for a successful start before touching and pushing projects, in that order', async () => {
    const order: string[] = []
    let finish!: () => void
    const started = new Promise<void>((resolve) => { finish = resolve })
    const bridge = { start: vi.fn(() => { order.push('start'); return started }) }
    const h = agentHarness(bridge)
    h.projects.touchCanonical.mockImplementation(async () => { order.push('touch') })
    h.pushProjects.mockImplementation(async () => { order.push('push') })
    const pending = h.invoke(IPC.AgentStart, mainEvent(), cwd)
    expect(order).toEqual(['start'])
    expect(bridge.start).toHaveBeenCalledExactlyOnceWith(cwd)
    expect(bridge.start.mock.contexts[0]).toBe(h.bridge)
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
    finish()
    await expect(pending).resolves.toBeUndefined()
    expect(order).toEqual(['start', 'touch', 'push'])
    expect(h.projects.touchCanonical).toHaveBeenCalledExactlyOnceWith(cwd)
    expect(h.projects.touchCanonical.mock.contexts[0]).toBe(h.projects)
    expect(h.pushProjects).toHaveBeenCalledExactlyOnceWith()
  })

  it('keeps backend cwd isolated and waits for canonical registration and push', async () => {
    let finishTouch!: () => void
    let finishPush!: () => void
    const touch = new Promise<void>((resolve) => { finishTouch = resolve })
    const push = new Promise<void>((resolve) => { finishPush = resolve })
    const h = agentHarness({ start: vi.fn(async () => ({ cwd })) as unknown as AgentBridge['start'] })
    h.projects.touchCanonical.mockReturnValue(touch)
    h.pushProjects.mockReturnValue(push)
    let settled = false
    const pending = Promise.resolve(h.invoke(IPC.AgentStart, mainEvent(), cwd)).then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.bridge.start).toHaveBeenCalledWith(cwd)
    expect(h.projects.touchCanonical).toHaveBeenCalledWith(cwd)
    expect(h.pushProjects).not.toHaveBeenCalled()
    finishTouch()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pushProjects).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    finishPush()
    await pending
    expect(settled).toBe(true)
  })

  it.each(['throw', 'reject'])('does not update projects when start fails via %s', async (kind) => {
    const error = new Error('start failed')
    const h = agentHarness({ start: vi.fn(() => {
      if (kind === 'throw') throw error
      return Promise.reject(error)
    }) })
    await expect(h.invoke(IPC.AgentStart, mainEvent(), cwd)).rejects.toBe(error)
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
  })

  it.each([
    [true, true], [false, false], ['true', false], [1, false], [undefined, false], [null, false]
  ])('converts YOLO input %s using strict true equality', async (input, expected) => {
    const bridge = { setYoloMode: vi.fn(async () => {}) }
    const h = agentHarness(bridge)
    const result = h.invoke(IPC.AgentSetYolo, mainEvent(), input)
    expect(bridge.setYoloMode).toHaveBeenCalledExactlyOnceWith(expected)
    expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    await expect(result).resolves.toBeUndefined()
  })

  it('reads the independent subagent directory with main-frame and owner checks but no session reservation', async () => {
    const result = [{ provider: 'configured', id: 'child' }]
    const getSubagentModels = vi.fn().mockResolvedValue(result)
    const h = agentHarness({ getSubagentModels })
    await expect(h.invoke(IPC.AgentSubagentModels, mainEvent(73))).resolves.toEqual(result)
    expect(getSubagentModels).toHaveBeenCalledExactlyOnceWith(73)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    expect(() => h.invoke(IPC.AgentSubagentModels, mainEvent(73, true))).toThrow('只允许主窗口')
    expect(getSubagentModels).toHaveBeenCalledTimes(1)
    getSubagentModels.mockRejectedValueOnce(new Error('owner rejected'))
    await expect(h.invoke(IPC.AgentSubagentModels, mainEvent(99))).rejects.toThrow('owner rejected')
  })

  it.each([
    [true, 'current-session', 41], [false, 'stale-session', 99], ['true', 'current-session', 41]
  ] as const)('forwards subagent input %s, session %s and owner %s without weakening bridge validation', async (enabled, sessionId, owner) => {
    const result = Promise.resolve()
    const bridge = { setSubagentsMode: vi.fn().mockReturnValueOnce(result) }
    const h = agentHarness(bridge)
    await expect(h.invoke(IPC.AgentSetSubagents, mainEvent(owner), enabled, sessionId)).resolves.toBeUndefined()
    expect(bridge.setSubagentsMode).toHaveBeenCalledExactlyOnceWith(enabled, sessionId, owner)
    expect(bridge.setSubagentsMode.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    const error = new Error('bridge owner/session/input validation rejected')
    bridge.setSubagentsMode.mockRejectedValueOnce(error)
    await expect(h.invoke(IPC.AgentSetSubagents, mainEvent(owner), enabled, sessionId)).rejects.toBe(error)
  })

  it.each([true, false, 'false', 0, null, undefined])('forwards provider display input %s unchanged with owner and no session reservation', async (enabled) => {
    const result = [{ id: 'provider', enabled: false }]
    const setModelProviderEnabled = vi.fn().mockReturnValue(result)
    const h = agentHarness({ setModelProviderEnabled })
    h.withSessionOperation.mockRejectedValue(new Error('backend mutation is busy'))
    expect(h.invoke(IPC.AgentSetModelProviderEnabled, mainEvent(73), 'provider', enabled)).toBe(result)
    expect(setModelProviderEnabled).toHaveBeenCalledExactlyOnceWith('provider', enabled, 73)
    expect(setModelProviderEnabled.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    expect(h.projects.touchCanonical).not.toHaveBeenCalled()
    expect(h.pushProjects).not.toHaveBeenCalled()
    const error = new Error('display preference rejected')
    setModelProviderEnabled.mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(IPC.AgentSetModelProviderEnabled, mainEvent(73), 'provider', enabled)).toThrow(error)
    setModelProviderEnabled.mockRejectedValueOnce(error)
    await expect(h.invoke(IPC.AgentSetModelProviderEnabled, mainEvent(73), 'provider', enabled)).rejects.toBe(error)
  })

  it('rejects iframe provider display writes before bridge validation or saving', () => {
    const setModelProviderEnabled = vi.fn()
    const h = agentHarness({ setModelProviderEnabled })
    expect(() => h.invoke(IPC.AgentSetModelProviderEnabled, mainEvent(73, true), 'provider', false)).toThrow('只允许主窗口设置提供商显示')
    expect(setModelProviderEnabled).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('rejects iframe subagent toggles before reaching the bridge operation', async () => {
    const bridge = { setSubagentsMode: vi.fn() }
    const h = agentHarness(bridge)
    await expect(h.invoke(IPC.AgentSetSubagents, mainEvent(41, true), true, 'current-session')).rejects.toThrow('只允许主窗口切换子代理')
    expect(bridge.setSubagentsMode).not.toHaveBeenCalled()
  })

  it('enters the session reservation before sending and waits for the send to finish', async () => {
    const order: string[] = []
    let finish!: () => void
    const sent = new Promise<void>((resolve) => { finish = resolve })
    const send = vi.fn(() => { order.push('send'); return sent })
    const h = agentHarness({ send })
    h.withSessionOperation.mockImplementationOnce(async (operation) => {
      order.push('reserve')
      try {
        return await operation()
      } finally {
        order.push('release')
      }
    })

    const pending = h.invoke(IPC.AgentSend, mainEvent(), 'prompt', images)
    expect(order).toEqual(['reserve', 'send'])
    expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(h.withSessionOperation.mock.contexts[0]).toBe(h.bridge)
    expect(send).toHaveBeenCalledExactlyOnceWith('prompt', images)
    finish()
    await expect(pending).resolves.toBeUndefined()
    expect(order).toEqual(['reserve', 'send', 'release'])
  })

  it('does not send when the session reservation rejects', async () => {
    const send = vi.fn()
    const h = agentHarness({ send })
    const error = new Error('正在撤销消息，请稍后重试')
    h.withSessionOperation.mockRejectedValueOnce(error)

    await expect(h.invoke(IPC.AgentSend, mainEvent(), 'prompt', images)).rejects.toBe(error)
    expect(h.withSessionOperation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['selected-leaf', 41], [null, 99]
  ] as const)('forwards undo leaf %s, request identity and owner %s without reserving undo itself', async (expectedLeafId, owner) => {
    const request: MessageRevertRequest = { ...revertRequest, expectedLeafId }
    const result = {
      sessionPath, sessionId: request.sessionId, entryId: request.entryId,
      previousLeafId: expectedLeafId, leafId: 'branch-marker', text: 'original prompt', images
    }
    const promised = Promise.resolve(result)
    const revertMessage = vi.fn().mockReturnValue(promised)
    const h = agentHarness({ revertMessage })

    expect(h.invoke(IPC.AgentRevertMessage, mainEvent(owner), request)).toBe(promised)
    await expect(promised).resolves.toBe(result)
    expect(revertMessage).toHaveBeenCalledExactlyOnceWith(request, owner)
    expect(revertMessage.mock.calls[0][0]).toBe(request)
    expect(revertMessage.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it.each([
    ['只允许所属主窗口撤销消息', 99, revertRequest],
    ['无效的消息撤销参数', 41, { ...revertRequest, entryId: '' }],
    ['所选分支已改变', 41, { ...revertRequest, expectedLeafId: 'stale-leaf' }]
  ] as const)('propagates undo bridge validation failure: %s', async (message, owner, request) => {
    const error = new Error(message)
    const revertMessage = vi.fn().mockRejectedValueOnce(error)
    const h = agentHarness({ revertMessage })

    await expect(h.invoke(IPC.AgentRevertMessage, mainEvent(owner), request)).rejects.toBe(error)
    expect(revertMessage).toHaveBeenCalledExactlyOnceWith(request, owner)
    expect(revertMessage.mock.calls[0][0]).toBe(request)
    revertMessage.mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(IPC.AgentRevertMessage, mainEvent(owner), request)).toThrow(error)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it.each([
    [{ cwd, sessionPath, backendId: 'backend-id' }, 41], [{}, 99], [undefined, 41]
  ] as Array<[McpStatusTarget | undefined, number]>)('reads MCP status for target %s and owner %s without reserving a mutation', (target, owner) => {
    const result = { availability: 'native', phase: 'ready', servers: [], diagnosticsOmitted: false, revision: 1, receivedAt: 123 }
    const getMcpStatus = vi.fn().mockReturnValue(result)
    const h = agentHarness({ getMcpStatus })
    h.withSessionOperation.mockRejectedValue(new Error('a mutation would be blocked'))

    expect(h.invoke(IPC.AgentMcpStatus, mainEvent(owner), target)).toBe(result)
    expect(getMcpStatus).toHaveBeenCalledExactlyOnceWith(target ?? {}, owner)
    expect(getMcpStatus.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    const error = new Error('MCP reader owner rejected')
    getMcpStatus.mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(IPC.AgentMcpStatus, mainEvent(owner), target)).toThrow(error)
  })

  it('forwards read-only child-session IDs and owner without reserving a mutation', () => {
    const list = { revision: 1, sessions: [] }, snapshot = null
    const getSubagentSessions = vi.fn().mockReturnValue(list)
    const getSubagentSession = vi.fn().mockReturnValue(snapshot)
    const h = agentHarness({ getSubagentSessions, getSubagentSession })
    expect(h.invoke(IPC.AgentSubagentSessions, mainEvent(99))).toBe(list)
    expect(getSubagentSessions).toHaveBeenCalledExactlyOnceWith(99)
    expect(h.invoke(IPC.AgentSubagentSession, mainEvent(99), 'child', 'backend')).toBe(snapshot)
    expect(getSubagentSession).toHaveBeenCalledExactlyOnceWith('child', 'backend', 99)
    expect(getSubagentSession.mock.contexts[0]).toBe(h.bridge)
    expect(h.withSessionOperation).not.toHaveBeenCalled()
    const error = new Error('child owner rejected')
    getSubagentSession.mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(IPC.AgentSubagentSession, mainEvent(99), 'child', 'backend')).toThrow(error)
  })

  it('rejects iframe child-session reads before reaching the bridge', () => {
    const getSubagentSessions = vi.fn(), getSubagentSession = vi.fn()
    const h = agentHarness({ getSubagentSessions, getSubagentSession })
    expect(() => h.invoke(IPC.AgentSubagentSessions, mainEvent(7, true))).toThrow('只允许主窗口读取子会话')
    expect(() => h.invoke(IPC.AgentSubagentSession, mainEvent(7, true), 'child', 'backend')).toThrow('只允许主窗口读取子会话')
    expect(getSubagentSessions).not.toHaveBeenCalled()
    expect(getSubagentSession).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('rejects iframe MCP reads before reaching the bridge or reserving a mutation', () => {
    const getMcpStatus = vi.fn()
    const h = agentHarness({ getMcpStatus })
    expect(() => h.invoke(IPC.AgentMcpStatus, mainEvent(41, true), { cwd, sessionPath })).toThrow('只允许主窗口读取 MCP 状态')
    expect(getMcpStatus).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })

  it('rejects iframe undo synchronously before reaching the bridge or reserving a mutation', () => {
    const revertMessage = vi.fn()
    const h = agentHarness({ revertMessage })

    expect(() => h.invoke(IPC.AgentRevertMessage, mainEvent(41, true), revertRequest)).toThrow('只允许主窗口撤销消息')
    expect(revertMessage).not.toHaveBeenCalled()
    expect(h.withSessionOperation).not.toHaveBeenCalled()
  })
})

const selection: GitSelectionRequest = {
  cwd, snapshotId: 'snapshot-id', path: 'src/file.ts', action: 'stage', hunkId: 'hunk-id', lineIds: ['line-a', 'line-b']
}
const gitRoutes: RouteCase<GitService>[] = [
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
  [IPC.GitConflictResolve, 'resolveConflict', [cwd, 'snapshot-id', 'src/file.ts', 'theirs'], [cwd, 'snapshot-id', 'src/file.ts', 'theirs', undefined]],
  [IPC.GitOperationContinue, 'continueOperation', [cwd, 'snapshot-id']],
  [IPC.GitOperationAbort, 'abortOperation', [cwd, 'snapshot-id']]
]

describe('Git IPC registration', () => {
  it('registers exactly the GitService routes without calling the service', () => {
    const h = collectIpc()
    registerGitIpc({ ipcMain: h.ipcMain, git: {} as GitService, getMainWindowId: () => 41 })
    expect([...h.handlers.keys()].sort()).toEqual([...new Set([IPC.GitCommitTree, ...gitRoutes.map(([channel]) => channel)])].sort())
    expect(h.listeners.size).toBe(0)
  })

  it('forwards commit graph reads only for the current main-window frame', async () => {
    const h = collectIpc()
    const value = { root: cwd, revision: 'revision' }
    const getCommitTree = vi.fn().mockResolvedValue(value)
    registerGitIpc({ ipcMain: h.ipcMain, git: { getCommitTree } as unknown as GitService, getMainWindowId: () => 41 })
    for (const event of [mainEvent(42), mainEvent(41, true)]) {
      expect(() => h.invoke(IPC.GitCommitTree, event, cwd)).toThrow('只允许所属主窗口')
    }
    expect(getCommitTree).not.toHaveBeenCalled()
    const cursor = { revision: 'a'.repeat(64), offset: 200 }
    await expect(h.invoke(IPC.GitCommitTree, mainEvent(), cwd, cursor)).resolves.toBe(value)
    expect(getCommitTree).toHaveBeenCalledExactlyOnceWith(cwd, cursor)
    const failure = new Error('graph read failed')
    getCommitTree.mockRejectedValueOnce(failure)
    await expect(h.invoke(IPC.GitCommitTree, mainEvent(), cwd)).rejects.toBe(failure)
  })

  it.each(['owner', 'frame', 'destroyed'] as const)('rejects a commit graph result after its %s changes', async (change) => {
    const h = collectIpc()
    let owner: number | undefined = 41
    let destroyed = false
    let finish!: (value: unknown) => void
    const getCommitTree = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    registerGitIpc({ ipcMain: h.ipcMain, git: { getCommitTree } as unknown as GitService, getMainWindowId: () => owner })
    const event = mainEvent()
    event.sender.isDestroyed = () => destroyed
    const pending = h.invoke(IPC.GitCommitTree, event, cwd)
    if (change === 'owner') owner = undefined
    if (change === 'frame') Object.defineProperty(event.sender, 'mainFrame', { value: {} })
    if (change === 'destroyed') destroyed = true
    finish({ root: cwd })
    await expect(pending).rejects.toThrow('只允许所属主窗口')
  })

  it.each(gitRoutes)('%s forwards to %s with its receiver, arguments, result and errors', async (channel, method, args, forwarded) => {
    const h = collectIpc()
    const result = Promise.resolve({ snapshotId: 'next-snapshot' })
    const stub = vi.fn().mockReturnValue(result)
    const git = { [method]: stub }
    registerGitIpc({ ipcMain: h.ipcMain, git: git as unknown as GitService, getMainWindowId: () => 41 })
    expect(h.invoke(channel, mainEvent(), ...args)).toBe(result)
    expect(stub).toHaveBeenCalledExactlyOnceWith(...(forwarded ?? args))
    expect(stub.mock.contexts[0]).toBe(git)
    const error = new Error('Git snapshot or operation rejected')
    stub.mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(channel, mainEvent(), ...args)).toThrow(error)
    stub.mockRejectedValueOnce(error)
    await expect(h.invoke(channel, mainEvent(), ...args)).rejects.toBe(error)
  })
})

function windowHarness(reserveMutation?: Parameters<typeof registerWindowIpc>[0]['reserveMutation']) {
  const ipc = collectIpc()
  const win = {
    isDestroyed: vi.fn(() => false), isMaximized: vi.fn(() => false),
    minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), close: vi.fn()
  }
  const windowFromWebContents = vi.fn<Parameters<typeof registerWindowIpc>[0]['windowFromWebContents']>(() => win as unknown as BrowserWindow)
  const windowEffects = { get: vi.fn(), setEnabled: vi.fn() }
  const terminals = { open: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn() }
  registerWindowIpc({
    ipcMain: ipc.ipcMain, windowFromWebContents,
    windowEffects: windowEffects as unknown as WindowEffectsService,
    terminals: terminals as unknown as TerminalService,
    reserveMutation
  })
  return { ...ipc, win, windowFromWebContents, windowEffects, terminals }
}

const effectRoutes: Array<[string, 'get' | 'setEnabled', unknown[]]> = [
  [IPC.GetWindowEffects, 'get', []], [IPC.SetWindowEffects, 'setEnabled', [true]], [IPC.SetWindowEffects, 'setEnabled', [false]]
]
const terminalRoutes: Array<[string, 'open' | 'write' | 'resize' | 'close', unknown[]]> = [
  [IPC.TerminalOpen, 'open', [cwd, 100, 32]],
  [IPC.TerminalWrite, 'write', ['terminal-id', 'printf "hello"\r']],
  [IPC.TerminalResize, 'resize', ['terminal-id', 120, 40]],
  [IPC.TerminalClose, 'close', ['terminal-id']]
]

describe('window IPC registration', () => {
  it('reserves terminal opening and forwards the checked owner only after admission', async () => {
    let admit!: () => void
    const admission = new Promise<void>((resolve) => { admit = resolve })
    const reserveMutation = vi.fn<(operation: () => Promise<unknown>) => void>()
    const h = windowHarness(async <T>(operation: () => Promise<T>): Promise<T> => {
      reserveMutation(operation)
      await admission
      return operation()
    })
    const result = { id: 'terminal-id' }
    h.terminals.open.mockResolvedValue(result)
    const pending = h.invoke(IPC.TerminalOpen, mainEvent(73), cwd, 100, 32)
    expect(reserveMutation).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(h.terminals.open).not.toHaveBeenCalled()
    admit()
    await expect(pending).resolves.toBe(result)
    expect(h.terminals.open).toHaveBeenCalledExactlyOnceWith(73, cwd, 100, 32)
    expect(h.terminals.open.mock.contexts[0]).toBe(h.terminals)
  })

  it('does not open a terminal when mutation admission rejects', async () => {
    const error = new Error('worktree deletion in progress')
    const reserveMutation = vi.fn<(operation: () => Promise<unknown>) => void>(() => { throw error })
    const h = windowHarness(async <T>(operation: () => Promise<T>): Promise<T> => {
      reserveMutation(operation)
      return operation()
    })
    await expect(h.invoke(IPC.TerminalOpen, mainEvent(), cwd, 80, 24)).rejects.toBe(error)
    expect(h.terminals.open).not.toHaveBeenCalled()
  })

  it('rejects iframe terminal opening before mutation admission', () => {
    const reserveMutation = vi.fn<(operation: () => Promise<unknown>) => void>()
    const h = windowHarness(async <T>(operation: () => Promise<T>): Promise<T> => {
      reserveMutation(operation)
      return operation()
    })
    expect(() => h.invoke(IPC.TerminalOpen, mainEvent(41, true), cwd, 80, 24)).toThrow('只允许主窗口操作终端')
    expect(reserveMutation).not.toHaveBeenCalled()
    expect(h.terminals.open).not.toHaveBeenCalled()
  })
  it('registers its invoke routes and one send listener without resolving a window', () => {
    const h = windowHarness()
    expect([...h.handlers.keys()].sort()).toEqual([
      IPC.WindowState, IPC.GetWindowEffects, IPC.SetWindowEffects,
      IPC.TerminalOpen, IPC.TerminalWrite, IPC.TerminalResize, IPC.TerminalClose
    ].sort())
    expect([...h.listeners.keys()]).toEqual([IPC.WindowControl])
    expect(h.windowFromWebContents).not.toHaveBeenCalled()
    for (const stub of [...Object.values(h.windowEffects), ...Object.values(h.terminals)]) expect(stub).not.toHaveBeenCalled()
  })

  it.each([false, true])('looks up the sender and returns maximized state %s', (maximized) => {
    const h = windowHarness()
    const event = mainEvent()
    h.win.isMaximized.mockReturnValue(maximized)
    expect(h.invoke(IPC.WindowState, event)).toBe(maximized)
    expect(h.windowFromWebContents).toHaveBeenCalledExactlyOnceWith(event.sender)
    expect(h.win.isMaximized.mock.contexts[0]).toBe(h.win)
  })

  it('returns false when the sender no longer has a window', () => {
    const h = windowHarness()
    h.windowFromWebContents.mockReturnValue(null)
    expect(h.invoke(IPC.WindowState, mainEvent())).toBe(false)
  })

  it.each([
    ['minimize', false, 'minimize'], ['toggle-maximize', false, 'maximize'],
    ['toggle-maximize', true, 'unmaximize'], ['close', false, 'close']
  ] as const)('handles %s with maximized=%s', (action, maximized, method) => {
    const h = windowHarness()
    const event = mainEvent()
    h.win.isMaximized.mockReturnValue(maximized)
    h.send(IPC.WindowControl, event, action)
    expect(h.windowFromWebContents).toHaveBeenCalledExactlyOnceWith(event.sender)
    expect(h.win[method]).toHaveBeenCalledExactlyOnceWith()
    expect(h.win[method].mock.contexts[0]).toBe(h.win)
    for (const other of ['minimize', 'maximize', 'unmaximize', 'close'] as const) {
      if (other !== method) expect(h.win[other]).not.toHaveBeenCalled()
    }
  })

  it.each(['missing', 'destroyed', 'unknown-action'])('ignores controls for %s', (reason) => {
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

  it.each(effectRoutes)('%s forwards sender ownership and arguments to %s', async (channel, method, args) => {
    const h = windowHarness()
    const result = { enabled: true, revision: 7 }
    h.windowEffects[method].mockReturnValueOnce(result)
    expect(h.invoke(channel, mainEvent(73), ...args)).toBe(result)
    expect(h.windowEffects[method]).toHaveBeenCalledExactlyOnceWith(73, ...args)
    expect(h.windowEffects[method].mock.contexts[0]).toBe(h.windowEffects)
    const error = new Error('window owner rejected')
    h.windowEffects[method].mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(channel, mainEvent(99), ...args)).toThrow(error)
    h.windowEffects[method].mockRejectedValueOnce(error)
    await expect(h.invoke(channel, mainEvent(99), ...args)).rejects.toBe(error)
  })

  it.each(terminalRoutes)('%s forwards sender ownership and terminal arguments to %s', async (channel, method, args) => {
    const h = windowHarness()
    const result = Promise.resolve({ id: 'terminal-id' })
    h.terminals[method].mockReturnValueOnce(result)
    expect(h.invoke(channel, mainEvent(73), ...args)).toBe(result)
    expect(h.terminals[method]).toHaveBeenCalledExactlyOnceWith(73, ...args)
    expect(h.terminals[method].mock.contexts[0]).toBe(h.terminals)
    const error = new Error('terminal owner or operation rejected')
    h.terminals[method].mockImplementationOnce(() => { throw error })
    expect(() => h.invoke(channel, mainEvent(99), ...args)).toThrow(error)
    h.terminals[method].mockRejectedValueOnce(error)
    await expect(h.invoke(channel, mainEvent(99), ...args)).rejects.toBe(error)
  })

  it.each([
    [IPC.GetWindowEffects, '只允许主窗口操作外观'], [IPC.SetWindowEffects, '只允许主窗口操作外观'],
    [IPC.TerminalOpen, '只允许主窗口操作终端'], [IPC.TerminalWrite, '只允许主窗口操作终端'],
    [IPC.TerminalResize, '只允许主窗口操作终端'], [IPC.TerminalClose, '只允许主窗口操作终端']
  ])('rejects iframe access to %s before calling any service', (channel, message) => {
    const h = windowHarness()
    expect(() => h.invoke(channel, mainEvent(41, true), cwd, 80, 24)).toThrow(message)
    for (const stub of [...Object.values(h.windowEffects), ...Object.values(h.terminals)]) expect(stub).not.toHaveBeenCalled()
    expect(h.windowFromWebContents).not.toHaveBeenCalled()
  })
})

it('composes the domain registrars without duplicate channels', () => {
  const h = collectIpc()
  registerAgentIpc({ ipcMain: h.ipcMain, bridge: {} as AgentBridge, projects: { touchCanonical: vi.fn() }, pushProjects: vi.fn() })
  registerGitIpc({ ipcMain: h.ipcMain, git: {} as GitService, getMainWindowId: () => 41 })
  registerWindowIpc({
    ipcMain: h.ipcMain, windowFromWebContents: vi.fn(),
    windowEffects: {} as WindowEffectsService, terminals: {} as TerminalService
  })
  registerComputerUseIpc({
    ipcMain: h.ipcMain, service: {} as ComputerUseService, getMainWindowId: () => undefined,
    createLocalOwner: () => { throw new Error('not invoked') },
    getLocalOwner: () => { throw new Error('not invoked') }
  })
  const usageLedger = { getOverview: vi.fn(), setBackgroundCollectionEnabled: vi.fn() }
  registerUsageIpc({
    ipcMain: h.ipcMain, ledger: usageLedger,
    appSettings: { usageBackgroundCollectionEnabled: true, setUsageBackgroundCollectionEnabled: vi.fn() },
    getMainWindowId: () => 41
  })
  const expected = new Set([
    IPC.UsageOverview, IPC.GetUsageBackgroundCollection, IPC.SetUsageBackgroundCollection,
    IPC.ComputerUseGetState, IPC.ComputerUseStart, IPC.ComputerUseCapture, IPC.ComputerUseStop,
    ...agentRoutes.map(([channel]) => channel), ...sessionCommandRoutes.map(([channel]) => channel),
    IPC.AgentStart, IPC.AgentSetYolo, IPC.AgentSetSubagents,
    IPC.AgentRevertMessage, IPC.AgentMcpStatus, IPC.BranchDelete, IPC.AgentEditQueued,
    IPC.AgentSubagentSessions, IPC.AgentSubagentSession, IPC.AgentSetModelProviderEnabled, IPC.AgentSubagentModels,
    IPC.GetCapabilitySettings, IPC.UpdateCapabilitySettings,
    IPC.GitCommitTree, ...gitRoutes.map(([channel]) => channel), ...effectRoutes.map(([channel]) => channel),
    ...terminalRoutes.map(([channel]) => channel), IPC.WindowState
  ])
  expect(usageLedger.getOverview).not.toHaveBeenCalled()
  expect(usageLedger.setBackgroundCollectionEnabled).not.toHaveBeenCalled()
  expect([...h.handlers.keys()].sort()).toEqual([...expected].sort())
  expect([...h.listeners.keys()]).toEqual([IPC.WindowControl])
})
