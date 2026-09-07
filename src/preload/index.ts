import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import type {
  AgentCapabilities,
  AgentMode,
  AgentStatus,
  ExtensionUiRequest,
  ExtensionUiResponse,
  GitCommitResult,
  GitConflictContent,
  GitDiffScope,
  GitFileDiff,
  GitSelectionRequest,
  GitSnapshotUpdate,
  GitWorkspaceSnapshot,
  ImageContent,
  BranchInfo,
  ModelProviderAuthState,
  ModelProviderAuthType,
  ModelProviderInfo,
  PionApi,
  PluginCatalogItem,
  PluginInstallResult,
  PluginUninstallResult,
  ProjectMeta,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  RunCheckpointStatus,
  RunOperation,
  RunRecoveryCandidate,
  RunTelemetryQuery,
  RunTelemetryUpdate,
  SessionEntriesPage,
  StartVerificationOptions,
  SessionHistoryIndex,
  SessionInfo,
  SessionMeta,
  SessionTaskRun,
  SkillInfo,
  SlashCommandInfo,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRules,
  TreeNodeLite,
  VerificationLogUpdate,
  VerificationPlan,
  VerificationPolicy,
  VerificationRun,
  VerificationSnapshotUpdate,
  WireEventInput
} from '../shared/types'
import type { WorkflowSnapshot, WorkflowUpdate } from '../shared/workflows'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.off(channel, wrapped)
}

const api: PionApi = {
  // agent lifecycle
  startAgent: (cwd) => ipcRenderer.invoke(IPC.AgentStart, cwd),
  stopAgent: () => ipcRenderer.invoke(IPC.AgentStop),
  send: (message, images) => ipcRenderer.invoke(IPC.AgentSend, message, images),
  queue: (message, images) => ipcRenderer.invoke(IPC.AgentQueue, message, images),
  sendQueuedMessage: (kind, index) => ipcRenderer.invoke(IPC.AgentSendQueued, kind, index),
  removeQueuedMessage: (kind, index) => ipcRenderer.invoke(IPC.AgentRemoveQueued, kind, index),
  migrateSessionToProject: (cwd) => ipcRenderer.invoke(IPC.AgentMigrateProject, cwd),
  abort: () => ipcRenderer.invoke(IPC.AgentAbort),
  getRunCheckpoint: () =>
    ipcRenderer.invoke(IPC.AgentRunCheckpoint) as Promise<RunCheckpointStatus | null>,
  rollbackRunCheckpoint: () =>
    ipcRenderer.invoke(IPC.AgentRollbackCheckpoint) as Promise<RunCheckpointStatus>,
  getRunTelemetry: (query?: RunTelemetryQuery) =>
    ipcRenderer.invoke(IPC.AgentRunTelemetry, query) as Promise<RunOperation[]>,
  getRunRecoveryCandidates: (query?: RunTelemetryQuery) =>
    ipcRenderer.invoke(IPC.AgentRunRecovery, query) as Promise<RunRecoveryCandidate[]>,
  resumeRun: (runId) => ipcRenderer.invoke(IPC.AgentResumeRun, runId) as Promise<RunOperation>,
  discardRunRecovery: (runId) =>
    ipcRenderer.invoke(IPC.AgentDiscardRunRecovery, runId) as Promise<RunOperation>,
  restoreRecoveredCheckpoint: (runId) =>
    ipcRenderer.invoke(IPC.AgentRestoreRecoveredCheckpoint, runId) as Promise<RunCheckpointStatus>,

  // verification
  discoverVerification: (cwd, force) =>
    ipcRenderer.invoke(IPC.VerificationDiscover, cwd, force) as Promise<VerificationPlan>,
  listVerificationRuns: (cwd, sessionPath) =>
    ipcRenderer.invoke(IPC.VerificationRuns, cwd, sessionPath) as Promise<VerificationRun[]>,
  startVerification: (cwd, options?: StartVerificationOptions) =>
    ipcRenderer.invoke(IPC.VerificationStart, cwd, options) as Promise<VerificationRun>,
  rerunVerification: (runId) =>
    ipcRenderer.invoke(IPC.VerificationRerun, runId) as Promise<VerificationRun>,
  cancelVerification: (runId) =>
    ipcRenderer.invoke(IPC.VerificationCancel, runId) as Promise<VerificationRun>,
  getVerificationPolicy: (cwd) =>
    ipcRenderer.invoke(IPC.VerificationPolicyGet, cwd) as Promise<VerificationPolicy>,
  setVerificationPolicy: (cwd, updates) =>
    ipcRenderer.invoke(IPC.VerificationPolicySet, cwd, updates) as Promise<VerificationPolicy>,

  // bounded multi-agent workflows
  listWorkflows: (cwd) =>
    ipcRenderer.invoke(IPC.WorkflowList, cwd) as Promise<WorkflowSnapshot[]>,
  createWorkflow: (request) =>
    ipcRenderer.invoke(IPC.WorkflowCreate, request) as Promise<WorkflowSnapshot>,
  startWorkflow: (id) => ipcRenderer.invoke(IPC.WorkflowStart, id) as Promise<WorkflowSnapshot>,
  approveWorkflowPlan: (id) =>
    ipcRenderer.invoke(IPC.WorkflowApprovePlan, id) as Promise<WorkflowSnapshot>,
  repairWorkflow: (id) => ipcRenderer.invoke(IPC.WorkflowRepair, id) as Promise<WorkflowSnapshot>,
  waiveWorkflowTests: (id) =>
    ipcRenderer.invoke(IPC.WorkflowWaiveTests, id) as Promise<WorkflowSnapshot>,
  resumeWorkflow: (id) => ipcRenderer.invoke(IPC.WorkflowResume, id) as Promise<WorkflowSnapshot>,
  cancelWorkflow: (id) => ipcRenderer.invoke(IPC.WorkflowCancel, id) as Promise<WorkflowSnapshot>,
  mergeWorkflow: (id) => ipcRenderer.invoke(IPC.WorkflowMerge, id) as Promise<WorkflowSnapshot>,
  cleanupWorkflow: (id) => ipcRenderer.invoke(IPC.WorkflowCleanup, id) as Promise<WorkflowSnapshot>,

  // session management
  getState: () => ipcRenderer.invoke(IPC.AgentState),
  newSession: () => ipcRenderer.invoke(IPC.AgentNewSession),
  forkAt: (entryId) => ipcRenderer.invoke(IPC.AgentFork, entryId),
  switchSession: (sessionPath) => ipcRenderer.invoke(IPC.AgentSwitchSession, sessionPath),
  deleteSession: (sessionPath) => ipcRenderer.invoke(IPC.AgentDeleteSession, sessionPath),
  copySession: (sessionPath) => ipcRenderer.invoke(IPC.AgentCopySession, sessionPath),
  getSessionForkMessages: (sessionPath) =>
    ipcRenderer.invoke(IPC.AgentSessionForkMessages, sessionPath),
  forkSession: (sessionPath, entryId) =>
    ipcRenderer.invoke(IPC.AgentForkSession, sessionPath, entryId),
  getEntries: () => ipcRenderer.invoke(IPC.AgentEntries),
  getHistoryIndex: (sessionPath) =>
    ipcRenderer.invoke(IPC.AgentHistoryIndex, sessionPath) as Promise<SessionHistoryIndex | null>,
  getSessionTaskHistory: (sessionPath) =>
    ipcRenderer.invoke(IPC.AgentTaskHistory, sessionPath) as Promise<SessionTaskRun[]>,
  getRunningSessionPaths: () =>
    ipcRenderer.invoke(IPC.AgentRunningSessions) as Promise<string[]>,
  getUnreadSessionPaths: () =>
    ipcRenderer.invoke(IPC.AgentUnreadSessions) as Promise<string[]>,
  getEntriesPage: (before, limit, sessionPath) =>
    ipcRenderer.invoke(IPC.AgentEntriesPage, before, limit, sessionPath) as Promise<SessionEntriesPage | null>,
  getTree: () => ipcRenderer.invoke(IPC.AgentTree),

  // commands, modes, model & thinking
  getCommands: () => ipcRenderer.invoke(IPC.AgentCommands) as Promise<SlashCommandInfo[]>,
  getPluginCatalog: () => ipcRenderer.invoke(IPC.PluginsCatalog) as Promise<PluginCatalogItem[]>,
  getInstalledPlugins: () => ipcRenderer.invoke(IPC.PluginsInstalled) as Promise<string[]>,
  installPlugin: (source) => ipcRenderer.invoke(IPC.PluginsInstall, source) as Promise<PluginInstallResult>,
  uninstallPlugin: (source) =>
    ipcRenderer.invoke(IPC.PluginsUninstall, source) as Promise<PluginUninstallResult>,
  setMode: (mode: AgentMode) => ipcRenderer.invoke(IPC.AgentSetMode, mode),
  setYoloMode: (enabled: boolean) => ipcRenderer.invoke(IPC.AgentSetYolo, enabled),
  getAvailableModels: () => ipcRenderer.invoke(IPC.AgentModels),
  listModelProviders: () =>
    ipcRenderer.invoke(IPC.AgentModelProviders) as Promise<ModelProviderInfo[]>,
  loginModelProvider: (providerId, authType: ModelProviderAuthType) =>
    ipcRenderer.invoke(IPC.AgentLoginModelProvider, providerId, authType) as Promise<ModelProviderInfo[]>,
  logoutModelProvider: (providerId) =>
    ipcRenderer.invoke(IPC.AgentLogoutModelProvider, providerId) as Promise<ModelProviderInfo[]>,
  getModelProviderAuthState: () =>
    ipcRenderer.invoke(IPC.AgentModelProviderAuthState) as Promise<ModelProviderAuthState | null>,
  cancelModelProviderAuth: () => ipcRenderer.invoke(IPC.AgentCancelModelProviderAuth),
  openModelProviderAuthUrl: (url) => ipcRenderer.invoke(IPC.AgentOpenModelProviderAuthUrl, url),
  addModelProvider: (input) => ipcRenderer.invoke(IPC.AgentAddModelProvider, input),
  getSkills: () => ipcRenderer.invoke(IPC.AgentSkills) as Promise<SkillInfo[]>,
  getCapabilities: () => ipcRenderer.invoke(IPC.AgentCapabilities) as Promise<AgentCapabilities>,
  setModel: (provider, modelId) => ipcRenderer.invoke(IPC.AgentSetModel, provider, modelId),
  getThinkingLevels: () => ipcRenderer.invoke(IPC.AgentThinkingLevels),
  setThinkingLevel: (level) => ipcRenderer.invoke(IPC.AgentSetThinking, level),

  // agent settings
  setAutoCompaction: (enabled) => ipcRenderer.invoke(IPC.AgentSetAutoCompaction, enabled),
  setAutoRetry: (enabled) => ipcRenderer.invoke(IPC.AgentSetAutoRetry, enabled),
  compactNow: (customInstructions) => ipcRenderer.invoke(IPC.AgentCompact, customInstructions),
  exportSessionHtml: () => ipcRenderer.invoke(IPC.AgentExportHtml),
  renameSession: (name, sessionPath) => ipcRenderer.invoke(IPC.AgentRenameSession, name, sessionPath),
  setSteeringMode: (mode) => ipcRenderer.invoke(IPC.AgentSetSteeringMode, mode),
  setFollowUpMode: (mode) => ipcRenderer.invoke(IPC.AgentSetFollowUpMode, mode),

  // app settings
  getCompletionNotificationsEnabled: () => ipcRenderer.invoke(IPC.GetCompletionNotifications) as Promise<boolean>,
  setCompletionNotificationsEnabled: (enabled) => ipcRenderer.invoke(IPC.SetCompletionNotifications, enabled),
  getToolPermissionPolicy: (cwd) =>
    ipcRenderer.invoke(IPC.ToolPermissionPolicyGet, cwd) as Promise<ProjectToolPermissionPolicy>,
  setToolPermissionPolicy: (cwd, updates: Partial<ToolPermissionRules> | null) =>
    ipcRenderer.invoke(IPC.ToolPermissionPolicySet, cwd, updates) as Promise<ProjectToolPermissionPolicy>,
  getPendingToolPermissionRequests: () =>
    ipcRenderer.invoke(IPC.ToolPermissionPending) as Promise<ToolPermissionRequest[]>,
  resolveToolPermission: (requestId, resolution: ToolPermissionResolution) =>
    ipcRenderer.invoke(IPC.ToolPermissionResolve, requestId, resolution) as Promise<ProjectToolPermissionPolicy | null>,
  getPendingExtensionUiRequests: () =>
    ipcRenderer.invoke(IPC.ExtensionUiPending) as Promise<ExtensionUiRequest[]>,
  resolveExtensionUiRequest: (requestId, response: ExtensionUiResponse) =>
    ipcRenderer.invoke(IPC.ExtensionUiResolve, requestId, response) as Promise<void>,

  // window
  minimizeWindow: () => ipcRenderer.send(IPC.WindowControl, 'minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send(IPC.WindowControl, 'toggle-maximize'),
  closeWindow: () => ipcRenderer.send(IPC.WindowControl, 'close'),
  getWindowState: () => ipcRenderer.invoke(IPC.WindowState),

  // projects
  listProjects: () => ipcRenderer.invoke(IPC.ProjectsList),
  getProjectTrust: (cwd) =>
    ipcRenderer.invoke(IPC.ProjectTrustGet, cwd) as Promise<ProjectTrustInfo>,
  setProjectTrust: (cwd, decision) =>
    ipcRenderer.invoke(IPC.ProjectTrustSet, cwd, decision) as Promise<ProjectTrustInfo>,
  listBranches: (cwd) => ipcRenderer.invoke(IPC.BranchesList, cwd) as Promise<BranchInfo[]>,
  createBranch: (cwd, name) => ipcRenderer.invoke(IPC.BranchCreate, cwd, name) as Promise<BranchInfo>,
  renameBranch: (cwd, oldName, newName) =>
    ipcRenderer.invoke(IPC.BranchRename, cwd, oldName, newName) as Promise<BranchInfo>,
  getGitStatus: (cwd) => ipcRenderer.invoke(IPC.GitStatus, cwd) as Promise<GitWorkspaceSnapshot>,
  getGitDiff: (cwd, path, scope: GitDiffScope) =>
    ipcRenderer.invoke(IPC.GitDiff, cwd, path, scope) as Promise<GitFileDiff>,
  stageGitPaths: (cwd, snapshotId, paths) =>
    ipcRenderer.invoke(IPC.GitStagePaths, cwd, snapshotId, paths) as Promise<GitWorkspaceSnapshot>,
  unstageGitPaths: (cwd, snapshotId, paths) =>
    ipcRenderer.invoke(IPC.GitUnstagePaths, cwd, snapshotId, paths) as Promise<GitWorkspaceSnapshot>,
  discardGitPaths: (cwd, snapshotId, paths) =>
    ipcRenderer.invoke(IPC.GitDiscardPaths, cwd, snapshotId, paths) as Promise<GitWorkspaceSnapshot>,
  applyGitSelection: (request: GitSelectionRequest) =>
    ipcRenderer.invoke(IPC.GitApplySelection, request) as Promise<GitWorkspaceSnapshot>,
  commitGit: (cwd, snapshotId, message) =>
    ipcRenderer.invoke(IPC.GitCommit, cwd, snapshotId, message) as Promise<GitCommitResult>,
  readGitConflict: (cwd, path) =>
    ipcRenderer.invoke(IPC.GitConflictRead, cwd, path) as Promise<GitConflictContent>,
  resolveGitConflict: (cwd, snapshotId, path, strategy, content) =>
    ipcRenderer.invoke(IPC.GitConflictResolve, cwd, snapshotId, path, strategy, content) as Promise<GitWorkspaceSnapshot>,
  continueGitOperation: (cwd, snapshotId) =>
    ipcRenderer.invoke(IPC.GitOperationContinue, cwd, snapshotId) as Promise<GitWorkspaceSnapshot>,
  abortGitOperation: (cwd, snapshotId) =>
    ipcRenderer.invoke(IPC.GitOperationAbort, cwd, snapshotId) as Promise<GitWorkspaceSnapshot>,
  addProject: (cwd) => ipcRenderer.invoke(IPC.ProjectsAdd, cwd),
  removeProject: (cwd) => ipcRenderer.invoke(IPC.ProjectsRemove, cwd),
  listSessions: (cwd) => ipcRenderer.invoke(IPC.AgentSessions, cwd),

  // misc
  getStderr: () => ipcRenderer.invoke(IPC.AgentStderr),
  readClipboardImage: () => ipcRenderer.invoke(IPC.ClipboardImage) as Promise<ImageContent | null>,
  pickWorkspace: () => ipcRenderer.invoke(IPC.PickWorkspace),
  defaultWorkspace: () => ipcRenderer.invoke(IPC.DefaultWorkspace),

  // events
  onEvent: (listener) => subscribe<WireEventInput>(IPC_EVENTS.AgentEvent, listener),
  onStatus: (listener) => subscribe<AgentStatus>(IPC_EVENTS.AgentStatus, listener),
  onRunCheckpoint: (listener) =>
    subscribe<RunCheckpointStatus | null>(IPC_EVENTS.AgentRunCheckpoint, listener),
  onRunTelemetry: (listener) =>
    subscribe<RunTelemetryUpdate>(IPC_EVENTS.AgentRunTelemetry, listener),
  onVerificationRuns: (listener) =>
    subscribe<VerificationSnapshotUpdate>(IPC_EVENTS.VerificationRuns, listener),
  onVerificationLog: (listener) =>
    subscribe<VerificationLogUpdate>(IPC_EVENTS.VerificationLog, listener),
  onWorkflowUpdate: (listener) =>
    subscribe<WorkflowUpdate>(IPC_EVENTS.WorkflowUpdated, listener),
  onGitSnapshot: (listener) =>
    subscribe<GitSnapshotUpdate>(IPC_EVENTS.GitSnapshot, listener),
  onState: (listener) => subscribe<SessionInfo | null>(IPC_EVENTS.AgentState, listener),
  onSessions: (listener) => subscribe<SessionMeta[]>(IPC_EVENTS.AgentSessions, listener),
  onRunningSessionPaths: (listener) =>
    subscribe<string[]>(IPC_EVENTS.AgentRunningSessions, listener),
  onUnreadSessions: (listener) =>
    subscribe<string[]>(IPC_EVENTS.AgentUnreadSessions, listener),
  onTree: (listener) =>
    subscribe<{ tree: TreeNodeLite[]; leafId: string | null } | null>(IPC_EVENTS.AgentTree, listener),
  onProjects: (listener) => subscribe<ProjectMeta[]>(IPC_EVENTS.Projects, listener),
  onToolPermissionRequests: (listener) =>
    subscribe<ToolPermissionRequest[]>(IPC_EVENTS.ToolPermissionRequests, listener),
  onExtensionUiRequests: (listener) =>
    subscribe<ExtensionUiRequest[]>(IPC_EVENTS.ExtensionUiRequests, listener),
  onModelProviderAuthState: (listener) =>
    subscribe<ModelProviderAuthState | null>(IPC_EVENTS.ModelProviderAuthState, listener),
  onWindowState: (listener) => subscribe<boolean>(IPC_EVENTS.WindowState, listener)
}

contextBridge.exposeInMainWorld('pion', api)
