import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AgentBridge } from './agent-bridge'
import { PluginManager } from './plugin-manager'
import { ProjectStore } from './projects'
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
    if (!win.isDestroyed()) win.webContents.send('pion:projects', list)
  }
  projectsPush = push
  push(projects.list())

  const pushMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send('pion:window-state', win.isMaximized())
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
  ipcMain.handle('pion:agent-start', async (_event, cwd: string) => {
    const result = await bridge.start(cwd)
    projects.touch(cwd)
    pushProjects()
    return result
  })
  ipcMain.handle('pion:agent-stop', () => bridge.stop())
  ipcMain.handle('pion:agent-send', (_event, message: string) => bridge.send(message))
  ipcMain.handle('pion:agent-queue', (_event, message: string) => bridge.queue(message))
  ipcMain.handle('pion:agent-abort', () => bridge.abort())
  ipcMain.handle('pion:agent-state', () => bridge.getSessionInfo())
  ipcMain.handle('pion:agent-stderr', () => bridge.getStderr())
  ipcMain.handle('pion:agent-status', () => bridge.getStatus())

  // session management ----------------------------------------------------------
  ipcMain.handle('pion:agent-new-session', () => bridge.newSession())
  ipcMain.handle('pion:agent-fork', (_event, entryId: string) => bridge.forkAt(entryId))
  ipcMain.handle('pion:agent-switch-session', (_event, sessionPath: string) =>
    bridge.switchSession(sessionPath)
  )
  ipcMain.handle('pion:agent-delete-session', (_event, sessionPath: string) =>
    bridge.deleteSession(sessionPath)
  )
  ipcMain.handle('pion:agent-copy-session', (_event, sessionPath: string) =>
    bridge.copySession(sessionPath)
  )
  ipcMain.handle('pion:agent-session-fork-messages', (_event, sessionPath: string) =>
    bridge.getSessionForkMessages(sessionPath)
  )
  ipcMain.handle('pion:agent-fork-session', (_event, sessionPath: string, entryId: string) =>
    bridge.forkSession(sessionPath, entryId)
  )
  ipcMain.handle('pion:agent-entries', () => bridge.getEntries())
  ipcMain.handle('pion:agent-entries-page', (_event, before?: number, limit?: number) =>
    bridge.getEntriesPage(before, limit)
  )
  ipcMain.handle('pion:agent-tree', () => bridge.getTree())
  ipcMain.handle('pion:agent-sessions', (_event, cwd?: string) => bridge.listSessions(cwd))

  // commands, modes, model & thinking -------------------------------------------
  ipcMain.handle('pion:agent-commands', () => bridge.getCommands())
  ipcMain.handle('pion:agent-set-mode', (_event, mode: 'build' | 'plan') => bridge.setMode(mode))
  ipcMain.handle('pion:agent-models', () => bridge.getModels())
  ipcMain.handle('pion:agent-skills', () => bridge.getSkills())
  ipcMain.handle('pion:agent-set-model', (_event, provider: string, modelId: string) =>
    bridge.setModel(provider, modelId)
  )
  ipcMain.handle('pion:agent-thinking-levels', () => bridge.getThinkingLevels())
  ipcMain.handle('pion:agent-set-thinking', (_event, level: string) =>
    bridge.setThinkingLevel(level)
  )

  // plugin store --------------------------------------------------------------
  ipcMain.handle('pion:plugins-catalog', () => plugins.getCatalog())
  ipcMain.handle('pion:plugins-installed', () => plugins.getInstalled())
  ipcMain.handle('pion:plugins-install', (_event, source: string) => plugins.install(source))

  // agent settings ----------------------------------------------------------------
  ipcMain.handle('pion:agent-set-auto-compaction', (_event, enabled: boolean) =>
    bridge.setAutoCompaction(enabled)
  )
  ipcMain.handle('pion:agent-set-auto-retry', (_event, enabled: boolean) =>
    bridge.setAutoRetry(enabled)
  )
  ipcMain.handle('pion:agent-compact', () => bridge.compactNow())
  ipcMain.handle('pion:agent-export-html', () => bridge.exportSessionHtml())
  ipcMain.handle('pion:agent-rename-session', (_event, name: string) => bridge.renameSession(name))
  ipcMain.handle('pion:agent-set-steering-mode', (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setSteeringMode(mode)
  )
  ipcMain.handle('pion:agent-set-follow-up-mode', (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setFollowUpMode(mode)
  )

  // window ----------------------------------------------------------------------
  ipcMain.handle('pion:window-state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })
  ipcMain.on('pion:window-control', (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })

  // projects ----------------------------------------------------------------------
  ipcMain.handle('pion:projects-list', () => projects.list())
  ipcMain.handle('pion:branches-list', (_event, cwd: string) => bridge.listBranches(cwd))
  ipcMain.handle('pion:branch-create', (_event, cwd: string, name: string) => bridge.createBranch(cwd, name))
  ipcMain.handle('pion:projects-add', (_event, cwd: string) => {
    projects.touch(cwd)
    pushProjects()
    return projects.list()
  })
  ipcMain.handle('pion:projects-remove', (_event, cwd: string) => {
    projects.remove(cwd)
    pushProjects()
    return projects.list()
  })

  // misc --------------------------------------------------------------------------
  ipcMain.handle('pion:pick-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('pion:default-workspace', () => homedir())
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
