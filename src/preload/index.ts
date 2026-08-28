import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentStatus,
  BranchInfo,
  PionApi,
  ProjectMeta,
  SessionInfo,
  SessionMeta,
  SkillInfo,
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
  startAgent: (cwd) => ipcRenderer.invoke('pion:agent-start', cwd),
  stopAgent: () => ipcRenderer.invoke('pion:agent-stop'),
  send: (message) => ipcRenderer.invoke('pion:agent-send', message),
  queue: (message) => ipcRenderer.invoke('pion:agent-queue', message),
  abort: () => ipcRenderer.invoke('pion:agent-abort'),

  // session management
  getState: () => ipcRenderer.invoke('pion:agent-state'),
  newSession: () => ipcRenderer.invoke('pion:agent-new-session'),
  forkAt: (entryId) => ipcRenderer.invoke('pion:agent-fork', entryId),
  switchSession: (sessionPath) => ipcRenderer.invoke('pion:agent-switch-session', sessionPath),
  deleteSession: (sessionPath) => ipcRenderer.invoke('pion:agent-delete-session', sessionPath),
  copySession: (sessionPath) => ipcRenderer.invoke('pion:agent-copy-session', sessionPath),
  getSessionForkMessages: (sessionPath) =>
    ipcRenderer.invoke('pion:agent-session-fork-messages', sessionPath),
  forkSession: (sessionPath, entryId) =>
    ipcRenderer.invoke('pion:agent-fork-session', sessionPath, entryId),
  getEntries: () => ipcRenderer.invoke('pion:agent-entries'),
  getTree: () => ipcRenderer.invoke('pion:agent-tree'),

  // model & thinking
  getAvailableModels: () => ipcRenderer.invoke('pion:agent-models'),
  getSkills: () => ipcRenderer.invoke('pion:agent-skills') as Promise<SkillInfo[]>,
  setModel: (provider, modelId) => ipcRenderer.invoke('pion:agent-set-model', provider, modelId),
  getThinkingLevels: () => ipcRenderer.invoke('pion:agent-thinking-levels'),
  setThinkingLevel: (level) => ipcRenderer.invoke('pion:agent-set-thinking', level),

  // agent settings
  setAutoCompaction: (enabled) => ipcRenderer.invoke('pion:agent-set-auto-compaction', enabled),
  setAutoRetry: (enabled) => ipcRenderer.invoke('pion:agent-set-auto-retry', enabled),
  compactNow: () => ipcRenderer.invoke('pion:agent-compact'),
  exportSessionHtml: () => ipcRenderer.invoke('pion:agent-export-html'),
  renameSession: (name) => ipcRenderer.invoke('pion:agent-rename-session', name),
  setSteeringMode: (mode) => ipcRenderer.invoke('pion:agent-set-steering-mode', mode),
  setFollowUpMode: (mode) => ipcRenderer.invoke('pion:agent-set-follow-up-mode', mode),

  // window
  minimizeWindow: () => ipcRenderer.send('pion:window-control', 'minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('pion:window-control', 'toggle-maximize'),
  closeWindow: () => ipcRenderer.send('pion:window-control', 'close'),
  getWindowState: () => ipcRenderer.invoke('pion:window-state'),

  // projects
  listProjects: () => ipcRenderer.invoke('pion:projects-list'),
  listBranches: (cwd) => ipcRenderer.invoke('pion:branches-list', cwd) as Promise<BranchInfo[]>,
  createBranch: (cwd, name) => ipcRenderer.invoke('pion:branch-create', cwd, name) as Promise<BranchInfo>,
  addProject: (cwd) => ipcRenderer.invoke('pion:projects-add', cwd),
  removeProject: (cwd) => ipcRenderer.invoke('pion:projects-remove', cwd),
  listSessions: (cwd) => ipcRenderer.invoke('pion:agent-sessions', cwd),

  // misc
  getStderr: () => ipcRenderer.invoke('pion:agent-stderr'),
  pickWorkspace: () => ipcRenderer.invoke('pion:pick-workspace'),
  defaultWorkspace: () => ipcRenderer.invoke('pion:default-workspace'),

  // events
  onEvent: (listener) => subscribe<WireEventInput>('pion:agent-event', listener),
  onStatus: (listener) => subscribe<AgentStatus>('pion:agent-status', listener),
  onState: (listener) => subscribe<SessionInfo | null>('pion:agent-state', listener),
  onSessions: (listener) => subscribe<SessionMeta[]>('pion:agent-sessions', listener),
  onTree: (listener) =>
    subscribe<{ tree: TreeNodeLite[]; leafId: string | null } | null>('pion:agent-tree', listener),
  onProjects: (listener) => subscribe<ProjectMeta[]>('pion:projects', listener),
  onWindowState: (listener) => subscribe<boolean>('pion:window-state', listener)
}

contextBridge.exposeInMainWorld('pion', api)
