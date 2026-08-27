import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentStatus,
  PionApi,
  ProjectMeta,
  SessionInfo,
  SessionMeta,
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
  abort: () => ipcRenderer.invoke('pion:agent-abort'),

  // session management
  getState: () => ipcRenderer.invoke('pion:agent-state'),
  newSession: () => ipcRenderer.invoke('pion:agent-new-session'),
  forkAt: (entryId) => ipcRenderer.invoke('pion:agent-fork', entryId),
  switchSession: (sessionPath) => ipcRenderer.invoke('pion:agent-switch-session', sessionPath),
  getEntries: () => ipcRenderer.invoke('pion:agent-entries'),
  getTree: () => ipcRenderer.invoke('pion:agent-tree'),

  // model & thinking
  getAvailableModels: () => ipcRenderer.invoke('pion:agent-models'),
  setModel: (provider, modelId) => ipcRenderer.invoke('pion:agent-set-model', provider, modelId),
  getThinkingLevels: () => ipcRenderer.invoke('pion:agent-thinking-levels'),
  setThinkingLevel: (level) => ipcRenderer.invoke('pion:agent-set-thinking', level),

  // projects
  listProjects: () => ipcRenderer.invoke('pion:projects-list'),
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
  onProjects: (listener) => subscribe<ProjectMeta[]>('pion:projects', listener)
}

contextBridge.exposeInMainWorld('pion', api)
