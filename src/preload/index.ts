import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import type {
  AgentCapabilities,
  AgentMode,
  AgentStatus,
  ImageContent,
  BranchInfo,
  PionApi,
  PluginCatalogItem,
  PluginInstallResult,
  ProjectMeta,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  RunCheckpointStatus,
  SessionEntriesPage,
  SessionInfo,
  SessionMeta,
  SkillInfo,
  SlashCommandInfo,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRules,
  TreeNodeLite,
  WireEventInput
} from '../shared/types'

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
  abort: () => ipcRenderer.invoke(IPC.AgentAbort),
  getRunCheckpoint: () =>
    ipcRenderer.invoke(IPC.AgentRunCheckpoint) as Promise<RunCheckpointStatus | null>,
  rollbackRunCheckpoint: () =>
    ipcRenderer.invoke(IPC.AgentRollbackCheckpoint) as Promise<RunCheckpointStatus>,

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
  getEntriesPage: (before, limit, sessionPath) =>
    ipcRenderer.invoke(IPC.AgentEntriesPage, before, limit, sessionPath) as Promise<SessionEntriesPage | null>,
  getTree: () => ipcRenderer.invoke(IPC.AgentTree),

  // commands, modes, model & thinking
  getCommands: () => ipcRenderer.invoke(IPC.AgentCommands) as Promise<SlashCommandInfo[]>,
  getPluginCatalog: () => ipcRenderer.invoke(IPC.PluginsCatalog) as Promise<PluginCatalogItem[]>,
  getInstalledPlugins: () => ipcRenderer.invoke(IPC.PluginsInstalled) as Promise<string[]>,
  installPlugin: (source) => ipcRenderer.invoke(IPC.PluginsInstall, source) as Promise<PluginInstallResult>,
  setMode: (mode: AgentMode) => ipcRenderer.invoke(IPC.AgentSetMode, mode),
  getAvailableModels: () => ipcRenderer.invoke(IPC.AgentModels),
  getSkills: () => ipcRenderer.invoke(IPC.AgentSkills) as Promise<SkillInfo[]>,
  getCapabilities: () => ipcRenderer.invoke(IPC.AgentCapabilities) as Promise<AgentCapabilities>,
  setModel: (provider, modelId) => ipcRenderer.invoke(IPC.AgentSetModel, provider, modelId),
  getThinkingLevels: () => ipcRenderer.invoke(IPC.AgentThinkingLevels),
  setThinkingLevel: (level) => ipcRenderer.invoke(IPC.AgentSetThinking, level),

  // agent settings
  setAutoCompaction: (enabled) => ipcRenderer.invoke(IPC.AgentSetAutoCompaction, enabled),
  setAutoRetry: (enabled) => ipcRenderer.invoke(IPC.AgentSetAutoRetry, enabled),
  compactNow: () => ipcRenderer.invoke(IPC.AgentCompact),
  exportSessionHtml: () => ipcRenderer.invoke(IPC.AgentExportHtml),
  renameSession: (name) => ipcRenderer.invoke(IPC.AgentRenameSession, name),
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
  onState: (listener) => subscribe<SessionInfo | null>(IPC_EVENTS.AgentState, listener),
  onSessions: (listener) => subscribe<SessionMeta[]>(IPC_EVENTS.AgentSessions, listener),
  onTree: (listener) =>
    subscribe<{ tree: TreeNodeLite[]; leafId: string | null } | null>(IPC_EVENTS.AgentTree, listener),
  onProjects: (listener) => subscribe<ProjectMeta[]>(IPC_EVENTS.Projects, listener),
  onToolPermissionRequests: (listener) =>
    subscribe<ToolPermissionRequest[]>(IPC_EVENTS.ToolPermissionRequests, listener),
  onWindowState: (listener) => subscribe<boolean>(IPC_EVENTS.WindowState, listener)
}

contextBridge.exposeInMainWorld('pion', api)
