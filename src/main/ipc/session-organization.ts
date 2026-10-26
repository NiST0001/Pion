import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import type { SessionOrganizationStore } from '../session-organization'

export function assertSessionOrganizationIpcOwner(event: IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (ownerId === undefined || event.sender.isDestroyed() || event.sender.id !== ownerId || !event.senderFrame || event.senderFrame.detached || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('会话分组所属窗口已失效')
  }
}

interface SessionOrganizationIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  store: Pick<SessionOrganizationStore, 'get' | 'update'>
  getMainWindowId: () => number | undefined
}

/** Explicit registration only; store ownership and lifecycle remain with main. */
export function registerSessionOrganizationIpc({ ipcMain, store, getMainWindowId }: SessionOrganizationIpcDependencies): void {
  const invoke = async <T>(event: IpcMainInvokeEvent, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> => {
    const ownerId = getMainWindowId()
    assertSessionOrganizationIpcOwner(event, ownerId)
    const frame = event.senderFrame
    let navigated = false
    const onNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !isInPlace) navigated = true
    }
    const assertCurrent = (): void => {
      assertSessionOrganizationIpcOwner(event, getMainWindowId())
      if (navigated || getMainWindowId() !== ownerId || event.senderFrame !== frame) throw new Error('会话分组所属页面已失效')
    }
    event.sender.on('did-start-navigation', onNavigation)
    try {
      const result = await operation(assertCurrent)
      assertCurrent()
      return result
    } finally { event.sender.removeListener('did-start-navigation', onNavigation) }
  }
  ipcMain.handle(IPC.SessionOrganizationGet, (event, ...args: unknown[]) => invoke(event, async () => {
    if (args.length) throw new Error('会话分组读取参数无效')
    return store.get()
  }))
  ipcMain.handle(IPC.SessionOrganizationUpdate, (event, ...args: unknown[]) => invoke(event, async (assertCurrent) => {
    if (args.length !== 1) throw new Error('会话分组更新参数无效')
    return store.update(args[0], assertCurrent)
  }))
}
