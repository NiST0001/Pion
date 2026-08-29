import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AgentBridge } from './agent-bridge'
import { PluginManager } from './plugin-manager'
import { ProjectStore } from './projects'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import type { ProjectMeta } from '../shared/types'

const bridge = new AgentBridge()
const plugins = new PluginManager()
const projects = new ProjectStore()

let projectsPush = (list: ProjectMeta[]): void => {
  // replaced once a window exists
  void list
}

function pushProjects(): void {
  projectsPush(projects.list())
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Pion',
    backgroundColor: '#14161b',
    show: false,
    frame: false, // 自绘标题栏
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for ESM preload scripts
      webviewTag: true,
      spellcheck: false
    }
  })

  const push = (list: ProjectMeta[]): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.Projects, list)
  }
  projectsPush = push
  push(projects.list())

  const pushMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.WindowState, win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.once('ready-to-show', () => {
    win.show()
    pushMaximized()
  })
  win.on('closed', () => bridge.unbind(win))
  bridge.bind(win)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[pion] page load FAILED: ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[pion] renderer GONE: ${details.reason} ${details.exitCode ?? ''}`)
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      console.error(`[pion:renderer] ${event.message}`)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // agent lifecycle -----------------------------------------------------------
  ipcMain.handle(IPC.AgentStart, async (_event, cwd: string) => {
    const result = await bridge.start(cwd)
    projects.touch(cwd)
    pushProjects()
    return result
  })
  ipcMain.handle(IPC.AgentStop, () => bridge.stop())
  ipcMain.handle(IPC.AgentSend, (_event, message: string) => bridge.send(message))
  ipcMain.handle(IPC.AgentQueue, (_event, message: string) => bridge.queue(message))
  ipcMain.handle(IPC.AgentAbort, () => bridge.abort())
  ipcMain.handle(IPC.AgentState, () => bridge.getSessionInfo())
  ipcMain.handle(IPC.AgentStderr, () => bridge.getStderr())

  // session management ----------------------------------------------------------
  ipcMain.handle(IPC.AgentNewSession, () => bridge.newSession())
  ipcMain.handle(IPC.AgentFork, (_event, entryId: string) => bridge.forkAt(entryId))
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
  ipcMain.handle(IPC.AgentEntriesPage, (_event, before?: number, limit?: number) =>
    bridge.getEntriesPage(before, limit)
  )
  ipcMain.handle(IPC.AgentTree, () => bridge.getTree())
  ipcMain.handle(IPC.AgentSessions, (_event, cwd?: string) => bridge.listSessions(cwd))

  // commands, modes, model & thinking -------------------------------------------
  ipcMain.handle(IPC.AgentCommands, () => bridge.getCommands())
  ipcMain.handle(IPC.AgentSetMode, (_event, mode: 'build' | 'plan') => bridge.setMode(mode))
  ipcMain.handle(IPC.AgentModels, () => bridge.getModels())
  ipcMain.handle(IPC.AgentSkills, () => bridge.getSkills())
  ipcMain.handle(IPC.AgentSetModel, (_event, provider: string, modelId: string) =>
    bridge.setModel(provider, modelId)
  )
  ipcMain.handle(IPC.AgentThinkingLevels, () => bridge.getThinkingLevels())
  ipcMain.handle(IPC.AgentSetThinking, (_event, level: string) =>
    bridge.setThinkingLevel(level)
  )

  // plugin store --------------------------------------------------------------
  ipcMain.handle(IPC.PluginsCatalog, () => plugins.getCatalog())
  ipcMain.handle(IPC.PluginsInstalled, () => plugins.getInstalled())
  ipcMain.handle(IPC.PluginsInstall, (_event, source: string) => plugins.install(source))

  // agent settings ----------------------------------------------------------------
  ipcMain.handle(IPC.AgentSetAutoCompaction, (_event, enabled: boolean) =>
    bridge.setAutoCompaction(enabled)
  )
  ipcMain.handle(IPC.AgentSetAutoRetry, (_event, enabled: boolean) =>
    bridge.setAutoRetry(enabled)
  )
  ipcMain.handle(IPC.AgentCompact, () => bridge.compactNow())
  ipcMain.handle(IPC.AgentExportHtml, () => bridge.exportSessionHtml())
  ipcMain.handle(IPC.AgentRenameSession, (_event, name: string) => bridge.renameSession(name))
  ipcMain.handle(IPC.AgentSetSteeringMode, (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setSteeringMode(mode)
  )
  ipcMain.handle(IPC.AgentSetFollowUpMode, (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setFollowUpMode(mode)
  )

  // window ----------------------------------------------------------------------
  ipcMain.handle(IPC.WindowState, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })
  ipcMain.on(IPC.WindowControl, (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })

  // projects ----------------------------------------------------------------------
  ipcMain.handle(IPC.ProjectsList, () => projects.list())
  ipcMain.handle(IPC.BranchesList, (_event, cwd: string) => bridge.listBranches(cwd))
  ipcMain.handle(IPC.BranchCreate, (_event, cwd: string, name: string) => bridge.createBranch(cwd, name))
  ipcMain.handle(IPC.ProjectsAdd, (_event, cwd: string) => {
    projects.touch(cwd)
    pushProjects()
    return projects.list()
  })
  ipcMain.handle(IPC.ProjectsRemove, (_event, cwd: string) => {
    projects.remove(cwd)
    pushProjects()
    return projects.list()
  })

  // misc --------------------------------------------------------------------------
  ipcMain.handle(IPC.PickWorkspace, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.DefaultWorkspace, () => homedir())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void bridge.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void bridge.stop()
})
