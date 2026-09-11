import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { TerminalService } from '../terminal-service'
import type { WindowEffectsService } from '../window-effects'
import { IPC } from '../../shared/ipc'

interface WindowIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  windowFromWebContents: (sender: WebContents) => BrowserWindow | null
  windowEffects: WindowEffectsService
  terminals: TerminalService
}

export function registerWindowIpc({ ipcMain, windowFromWebContents, windowEffects, terminals }: WindowIpcDependencies): void {
  const appearanceOwner = (event: IpcMainInvokeEvent): number => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作外观')
    return event.sender.id
  }
  ipcMain.handle(IPC.GetWindowEffects, (event) => windowEffects.get(appearanceOwner(event)))
  ipcMain.handle(IPC.SetWindowEffects, (event, enabled: boolean) => windowEffects.setEnabled(appearanceOwner(event), enabled))
  const terminalOwner = (event: IpcMainInvokeEvent): number => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作终端')
    return event.sender.id
  }
  ipcMain.handle(IPC.TerminalOpen, (event, cwd: string, cols: number, rows: number) => terminals.open(terminalOwner(event), cwd, cols, rows))
  ipcMain.handle(IPC.TerminalWrite, (event, id: string, data: string) => terminals.write(terminalOwner(event), id, data))
  ipcMain.handle(IPC.TerminalResize, (event, id: string, cols: number, rows: number) => terminals.resize(terminalOwner(event), id, cols, rows))
  ipcMain.handle(IPC.TerminalClose, (event, id: string) => terminals.close(terminalOwner(event), id))

  ipcMain.handle(IPC.WindowState, (event) => {
    const win = windowFromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })
  ipcMain.on(IPC.WindowControl, (event, action: string) => {
    const win = windowFromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })
}
