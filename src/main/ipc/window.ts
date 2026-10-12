import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { TerminalService } from '../terminal-service'
import type { WindowEffectsService } from '../window-effects'
import { IPC } from '../../shared/ipc'
import { assertQuestionSettingsOwner, type QuestionSettingsStore } from '../question-settings'

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
  if (questionSettings && getMainWindowId) {
    const captureOwner = (event: IpcMainInvokeEvent) => {
      const id = getMainWindowId()
      const sender = event.sender
      const frame = event.senderFrame
      const assertCurrent = () => {
        if (getMainWindowId() !== id || event.sender !== sender || event.senderFrame !== frame) throw new Error('AI 提问设置窗口已变更')
        assertQuestionSettingsOwner(event, id)
      }
      assertCurrent()
      return assertCurrent
    }
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
  ipcMain.handle(IPC.TerminalOpen, (event, cwd: string, cols: number, rows: number) => {
    const owner = terminalOwner(event)
    const open = () => terminals.open(owner, cwd, cols, rows)
    return reserveMutation ? reserveMutation(open) : open()
  })
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
