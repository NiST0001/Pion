import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { TerminalService } from '../terminal-service'
import type { WindowEffectsService } from '../window-effects'
import { IPC } from '../../shared/ipc'
import type { QuestionSettingsStore } from '../question-settings'
import { captureIpcOwner } from './owner'

interface WindowIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  windowFromWebContents: (sender: WebContents) => BrowserWindow | null
  windowEffects: WindowEffectsService
  terminals: TerminalService
  reserveMutation?: <T>(operation: () => Promise<T>) => Promise<T>
  questionSettings?: QuestionSettingsStore
  getMainWindowId?: () => number | undefined
}

export function registerWindowIpc({ ipcMain, windowFromWebContents, windowEffects, terminals, reserveMutation, questionSettings, getMainWindowId }: WindowIpcDependencies): void {
  const captureOwner = (event: IpcMainInvokeEvent): (() => void) =>
    captureIpcOwner(event, getMainWindowId ?? (() => event.sender.id))
  const mainFrameOwner = (event: IpcMainInvokeEvent): number => {
    captureOwner(event)
    return event.sender.id
  }
  if (questionSettings && getMainWindowId) {
    ipcMain.handle(IPC.GetQuestionSettings, async (event) => {
      const assertCurrent = captureOwner(event)
      const value = await questionSettings.get()
      assertCurrent()
      return value
    })
    ipcMain.handle(IPC.SetQuestionSettings, async (event, value: unknown) => {
      const assertCurrent = captureOwner(event)
      const saved = await questionSettings.set(value, assertCurrent)
      assertCurrent()
      return saved
    })
  }
  ipcMain.handle(IPC.GetWindowEffects, (event) => windowEffects.get(mainFrameOwner(event)))
  ipcMain.handle(IPC.SetWindowEffects, (event, enabled: boolean) => {
    const assertCurrent = captureOwner(event)
    return windowEffects.setEnabled(event.sender.id, enabled, assertCurrent).then((value) => { assertCurrent(); return value })
  })
  ipcMain.handle(IPC.TerminalOpen, (event, cwd: string, cols: number, rows: number) => {
    const assertCurrent = captureOwner(event)
    const owner = event.sender.id
    const open = () => { assertCurrent(); return terminals.open(owner, cwd, cols, rows) }
    const pending = reserveMutation ? reserveMutation(open) : open()
    return pending.then((value) => { assertCurrent(); return value })
  })
  ipcMain.handle(IPC.TerminalWrite, (event, id: string, data: string) => terminals.write(mainFrameOwner(event), id, data))
  ipcMain.handle(IPC.TerminalResize, (event, id: string, cols: number, rows: number) => terminals.resize(mainFrameOwner(event), id, cols, rows))
  ipcMain.handle(IPC.TerminalClose, (event, id: string) => terminals.close(mainFrameOwner(event), id))

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
