import { contextBridge, ipcRenderer } from 'electron'
import type { AgentStatus, PionApi, SessionInfo, WireEventInput } from '../shared/types'

function subscribe<T>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.off(channel, wrapped)
}

const api: PionApi = {
  startAgent: (cwd) => ipcRenderer.invoke('pion:agent-start', cwd),
  stopAgent: () => ipcRenderer.invoke('pion:agent-stop'),
  send: (message) => ipcRenderer.invoke('pion:agent-send', message),
  abort: () => ipcRenderer.invoke('pion:agent-abort'),
  getState: () => ipcRenderer.invoke('pion:agent-state'),
  getStderr: () => ipcRenderer.invoke('pion:agent-stderr'),
  pickWorkspace: () => ipcRenderer.invoke('pion:pick-workspace'),
  defaultWorkspace: () => ipcRenderer.invoke('pion:default-workspace'),
  onEvent: (listener) => subscribe<WireEventInput>('pion:agent-event', listener),
  onStatus: (listener) => subscribe<AgentStatus>('pion:agent-status', listener),
  onState: (listener) => subscribe<SessionInfo | null>('pion:agent-state', listener)
}

contextBridge.exposeInMainWorld('pion', api)
