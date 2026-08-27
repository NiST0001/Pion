import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AgentBridge } from './agent-bridge'

const bridge = new AgentBridge()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    title: 'Pion',
    backgroundColor: '#16181d',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for ESM preload scripts
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => bridge.unbind(win))
  bridge.bind(win)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('pion:agent-start', (_event, cwd: string) => bridge.start(cwd))
  ipcMain.handle('pion:agent-stop', () => bridge.stop())
  ipcMain.handle('pion:agent-send', (_event, message: string) => bridge.send(message))
  ipcMain.handle('pion:agent-abort', () => bridge.abort())
  ipcMain.handle('pion:agent-state', () => bridge.getSessionInfo())
  ipcMain.handle('pion:agent-stderr', () => bridge.getStderr())
  ipcMain.handle('pion:agent-status', () => bridge.getStatus())
  ipcMain.handle('pion:default-workspace', () => homedir())
  ipcMain.handle('pion:pick-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
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
