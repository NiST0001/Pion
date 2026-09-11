import type { IpcMain } from 'electron'
import type { AgentBridge } from '../agent/agent-bridge'
import type { ProjectStore } from '../projects'
import { IPC } from '../../shared/ipc'
import type {
  AddModelProviderInput,
  ExtensionUiResponse,
  ImageContent,
  MessageRevertRequest,
  ModelProviderAuthType,
  RunTelemetryQuery,
  ToolPermissionResolution,
  ToolPermissionRules
} from '../../shared/types'

interface AgentIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  bridge: AgentBridge
  projects: Pick<ProjectStore, 'touch'>
  pushProjects: () => void
}

// Reserve asynchronous mutations from IPC entry, including the gap before a
// run sets backend.busy. Reads and undo itself are deliberately not reservations.
const SESSION_OPERATIONS = new Set<string>([
  IPC.AgentStart, IPC.AgentStop, IPC.AgentSend, IPC.AgentQueue, IPC.AgentSendQueued,
  IPC.AgentRemoveQueued, IPC.AgentMigrateProject, IPC.AgentAbort, IPC.AgentRollbackCheckpoint,
  IPC.AgentResumeRun, IPC.AgentDiscardRunRecovery, IPC.AgentRestoreRecoveredCheckpoint,
  IPC.AgentNewSession, IPC.AgentFork, IPC.AgentSwitchSession, IPC.AgentDeleteSession,
  IPC.AgentCopySession, IPC.AgentForkSession, IPC.AgentSetMode, IPC.AgentSetYolo,
  IPC.AgentSetSubagents, IPC.AgentLoginModelProvider, IPC.AgentLogoutModelProvider,
  IPC.AgentAddModelProvider, IPC.AgentSetModel, IPC.AgentSetThinking, IPC.AgentSetAutoCompaction,
  IPC.AgentSetAutoRetry, IPC.AgentCompact, IPC.AgentExportHtml, IPC.AgentRenameSession,
  IPC.AgentSetSteeringMode, IPC.AgentSetFollowUpMode, IPC.ProjectTrustSet,
  IPC.ToolPermissionResolve, IPC.ExtensionUiResolve
])

export function registerAgentIpc({ ipcMain: host, bridge, projects, pushProjects }: AgentIpcDependencies): void {
  const ipcMain: Pick<IpcMain, 'handle'> = {
    handle: (channel, listener) => host.handle(channel, SESSION_OPERATIONS.has(channel)
      ? (event, ...args) => bridge.withSessionOperation(() => listener(event, ...args))
      : listener)
  }
  // agent lifecycle -----------------------------------------------------------
  ipcMain.handle(IPC.AgentStart, async (_event, cwd: string) => {
    const result = await bridge.start(cwd)
    projects.touch(cwd)
    pushProjects()
    return result
  })
  ipcMain.handle(IPC.AgentStop, () => bridge.stop())
  ipcMain.handle(IPC.AgentSend, (_event, message: string, images?: ImageContent[]) => bridge.send(message, images))
  ipcMain.handle(IPC.AgentQueue, (_event, message: string, images?: ImageContent[]) => bridge.queue(message, images))
  ipcMain.handle(
    IPC.AgentSendQueued,
    (_event, kind: 'steering' | 'followUp', index: number) => bridge.sendQueuedMessage(kind, index)
  )
  ipcMain.handle(
    IPC.AgentRemoveQueued,
    (_event, kind: 'steering' | 'followUp', index: number) => bridge.removeQueuedMessage(kind, index)
  )
  ipcMain.handle(IPC.AgentMigrateProject, (_event, cwd: string) => bridge.migrateSessionToProject(cwd))
  ipcMain.handle(IPC.AgentAbort, () => bridge.abort())
  ipcMain.handle(IPC.AgentRunCheckpoint, () => bridge.getRunCheckpoint())
  ipcMain.handle(IPC.AgentRollbackCheckpoint, () => bridge.rollbackRunCheckpoint())
  ipcMain.handle(IPC.AgentRunTelemetry, (_event, query?: RunTelemetryQuery) =>
    bridge.getRunTelemetry(query)
  )
  ipcMain.handle(IPC.AgentRunRecovery, (_event, query?: RunTelemetryQuery) =>
    bridge.getRunRecoveryCandidates(query)
  )
  ipcMain.handle(IPC.AgentResumeRun, (_event, runId: string) => bridge.resumeRun(runId))
  ipcMain.handle(IPC.AgentDiscardRunRecovery, (_event, runId: string) =>
    bridge.discardRunRecovery(runId)
  )
  ipcMain.handle(IPC.AgentRestoreRecoveredCheckpoint, (_event, runId: string) =>
    bridge.restoreRecoveredCheckpoint(runId)
  )
  ipcMain.handle(IPC.AgentState, () => bridge.getSessionInfo())
  ipcMain.handle(IPC.AgentStderr, () => bridge.getStderr())

  // session management ----------------------------------------------------------
  ipcMain.handle(IPC.AgentNewSession, () => bridge.newSession())
  ipcMain.handle(IPC.AgentFork, (_event, entryId: string) => bridge.forkAt(entryId))
  ipcMain.handle(IPC.AgentRevertMessage, (event, request: MessageRevertRequest) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口撤销消息')
    return bridge.revertMessage(request, event.sender.id)
  })
  ipcMain.handle(IPC.AgentSwitchSession, (_event, sessionPath: string) =>
    bridge.switchSession(sessionPath)
  )
  ipcMain.handle(IPC.AgentDeleteSession, (_event, sessionPath: string) =>
    bridge.deleteSession(sessionPath)
  )
  ipcMain.handle(IPC.AgentCopySession, (_event, sessionPath: string) =>
    bridge.copySession(sessionPath)
  )
  ipcMain.handle(IPC.AgentSessionForkMessages, (_event, sessionPath: string) =>
    bridge.getSessionForkMessages(sessionPath)
  )
  ipcMain.handle(IPC.AgentForkSession, (_event, sessionPath: string, entryId: string) =>
    bridge.forkSession(sessionPath, entryId)
  )
  ipcMain.handle(IPC.AgentEntries, () => bridge.getEntries())
  ipcMain.handle(IPC.AgentHistoryIndex, (_event, sessionPath?: string) =>
    bridge.getHistoryIndex(sessionPath)
  )
  ipcMain.handle(IPC.AgentTaskHistory, (_event, sessionPath: string) =>
    bridge.getSessionTaskHistory(sessionPath)
  )
  ipcMain.handle(IPC.AgentRunningSessions, () => bridge.getRunningSessionPaths())
  ipcMain.handle(IPC.AgentUnreadSessions, () => bridge.getUnreadSessionPaths())
  ipcMain.handle(
    IPC.AgentEntriesPage,
    (_event, before?: number, limit?: number, sessionPath?: string) =>
      bridge.getEntriesPage(before, limit, sessionPath)
  )
  ipcMain.handle(IPC.AgentTree, () => bridge.getTree())
  ipcMain.handle(IPC.AgentSessions, (_event, cwd?: string) => bridge.listSessions(cwd))

  // commands, modes, model & thinking -------------------------------------------
  ipcMain.handle(IPC.AgentCommands, () => bridge.getCommands())
  ipcMain.handle(IPC.AgentSetMode, (_event, mode: 'build' | 'plan') => bridge.setMode(mode))
  ipcMain.handle(IPC.AgentSetYolo, (_event, enabled: boolean) => bridge.setYoloMode(enabled === true))
  ipcMain.handle(IPC.AgentSetSubagents, (event, enabled: boolean, sessionId: string) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口切换子代理')
    return bridge.setSubagentsMode(enabled, sessionId, event.sender.id)
  })
  ipcMain.handle(IPC.AgentModels, () => bridge.getModels())
  ipcMain.handle(IPC.AgentModelProviders, () => bridge.getModelProviders())
  ipcMain.handle(
    IPC.AgentLoginModelProvider,
    (_event, providerId: string, authType: ModelProviderAuthType) =>
      bridge.loginModelProvider(providerId, authType)
  )
  ipcMain.handle(IPC.AgentLogoutModelProvider, (_event, providerId: string) =>
    bridge.logoutModelProvider(providerId)
  )
  ipcMain.handle(IPC.AgentModelProviderAuthState, () => bridge.getModelProviderAuthState())
  ipcMain.handle(IPC.AgentCancelModelProviderAuth, () => bridge.cancelModelProviderAuth())
  ipcMain.handle(IPC.AgentOpenModelProviderAuthUrl, (_event, url: string) =>
    bridge.openModelProviderAuthUrl(url)
  )
  ipcMain.handle(IPC.AgentAddModelProvider, (_event, input: AddModelProviderInput) =>
    bridge.addModelProvider(input)
  )
  ipcMain.handle(IPC.AgentSkills, () => bridge.getSkills())
  ipcMain.handle(IPC.AgentCapabilities, () => bridge.getCapabilities())
  ipcMain.handle(IPC.AgentSetModel, (_event, provider: string, modelId: string) =>
    bridge.setModel(provider, modelId)
  )
  ipcMain.handle(IPC.AgentThinkingLevels, () => bridge.getThinkingLevels())
  ipcMain.handle(IPC.AgentSetThinking, (_event, level: string) =>
    bridge.setThinkingLevel(level)
  )

  // permissions & extension UI -------------------------------------------------
  ipcMain.handle(IPC.ToolPermissionPolicyGet, (_event, cwd: string) =>
    bridge.getToolPermissionPolicy(cwd)
  )
  ipcMain.handle(
    IPC.ToolPermissionPolicySet,
    (_event, cwd: string, updates: Partial<ToolPermissionRules> | null) =>
      bridge.setToolPermissionPolicy(cwd, updates)
  )
  ipcMain.handle(IPC.ToolPermissionPending, () => bridge.getPendingToolPermissionRequests())
  ipcMain.handle(
    IPC.ToolPermissionResolve,
    (_event, requestId: string, resolution: ToolPermissionResolution) =>
      bridge.resolveToolPermission(requestId, resolution)
  )
  ipcMain.handle(IPC.ExtensionUiPending, () => bridge.getPendingExtensionUiRequests())
  ipcMain.handle(
    IPC.ExtensionUiResolve,
    (_event, requestId: string, response: ExtensionUiResponse) =>
      bridge.resolveExtensionUiRequest(requestId, response)
  )

  // agent settings ------------------------------------------------------------
  ipcMain.handle(IPC.AgentSetAutoCompaction, (_event, enabled: boolean) =>
    bridge.setAutoCompaction(enabled)
  )
  ipcMain.handle(IPC.AgentSetAutoRetry, (_event, enabled: boolean) =>
    bridge.setAutoRetry(enabled)
  )
  ipcMain.handle(IPC.AgentCompact, (_event, customInstructions?: string) =>
    bridge.compactNow(customInstructions)
  )
  ipcMain.handle(IPC.AgentExportHtml, () => bridge.exportSessionHtml())
  ipcMain.handle(IPC.AgentRenameSession, (_event, name: string, sessionPath?: string) =>
    bridge.renameSession(name, sessionPath)
  )
  ipcMain.handle(IPC.AgentSetSteeringMode, (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setSteeringMode(mode)
  )
  ipcMain.handle(IPC.AgentSetFollowUpMode, (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setFollowUpMode(mode)
  )

  // project trust & branches --------------------------------------------------
  ipcMain.handle(IPC.ProjectTrustGet, (_event, cwd: string) => bridge.getProjectTrust(cwd))
  ipcMain.handle(IPC.ProjectTrustSet, (_event, cwd: string, decision: boolean | null) =>
    bridge.setProjectTrust(cwd, decision)
  )
  ipcMain.handle(IPC.BranchesList, (_event, cwd: string) => bridge.listBranches(cwd))
  ipcMain.handle(IPC.BranchCreate, (_event, cwd: string, name: string) => bridge.createBranch(cwd, name))
  ipcMain.handle(IPC.BranchRename, (_event, cwd: string, oldName: string, newName: string) =>
    bridge.renameBranch(cwd, oldName, newName))
}
