import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { AppSettings } from '../app-settings'
import { IPC } from '../../shared/ipc'
import type { UsageOverview, UsageOverviewQuery } from '../../shared/usage-overview'
import { validateUsageOverviewQuery } from '../../shared/usage-period'

interface UsageIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  ledger: { getOverview(query?: UsageOverviewQuery): Promise<UsageOverview>; setBackgroundCollectionEnabled(enabled: boolean): void }
  appSettings: Pick<AppSettings, 'usageBackgroundCollectionEnabled' | 'setUsageBackgroundCollectionEnabled'>
  getMainWindowId(): number | undefined
}

/** Explicit wiring only. The main process owns the ledger and its lifetime. */
export function registerUsageIpc({ ipcMain, ledger, appSettings, getMainWindowId }: UsageIpcDependencies): void {
  const assertOwner = (event: IpcMainInvokeEvent): (() => void) => {
    const owner = getMainWindowId()
    const sender = event.sender
    const frame = event.senderFrame
    const assertCurrent = (): void => {
      if (owner === undefined || getMainWindowId() !== owner || sender.id !== owner
        || sender.isDestroyed() || !frame || frame.detached
        || event.senderFrame !== frame || sender.mainFrame !== frame) {
        throw new Error('只允许所属主窗口读取使用总览')
      }
    }
    assertCurrent()
    return assertCurrent
  }
  ipcMain.handle(IPC.UsageOverview, async (event, value: unknown) => {
    const assertCurrent = assertOwner(event)
    const query = validateUsageOverviewQuery(value)
    const snapshot = await (query === undefined ? ledger.getOverview() : ledger.getOverview(query))
    assertCurrent()
    return snapshot
  })
  ipcMain.handle(IPC.GetUsageBackgroundCollection, (event) => {
    assertOwner(event)
    return appSettings.usageBackgroundCollectionEnabled
  })
  ipcMain.handle(IPC.SetUsageBackgroundCollection, async (event, enabled: unknown) => {
    const assertCurrent = assertOwner(event)
    if (typeof enabled !== 'boolean') throw new Error('后台自动采集开关必须是布尔值')
    await appSettings.setUsageBackgroundCollectionEnabled(enabled)
    ledger.setBackgroundCollectionEnabled(enabled)
    assertCurrent()
    return appSettings.usageBackgroundCollectionEnabled
  })
}
