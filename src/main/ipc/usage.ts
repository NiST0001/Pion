import type { IpcMain } from 'electron'
import { captureIpcOwner } from './owner'
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
  ipcMain.handle(IPC.UsageOverview, async (event, value: unknown) => {
    const assertCurrent = captureIpcOwner(event, getMainWindowId)
    const query = validateUsageOverviewQuery(value)
    const snapshot = await (query === undefined ? ledger.getOverview() : ledger.getOverview(query))
    assertCurrent()
    return snapshot
  })
  ipcMain.handle(IPC.GetUsageBackgroundCollection, (event) => {
    captureIpcOwner(event, getMainWindowId)
    return appSettings.usageBackgroundCollectionEnabled
  })
  ipcMain.handle(IPC.SetUsageBackgroundCollection, async (event, enabled: unknown) => {
    const assertCurrent = captureIpcOwner(event, getMainWindowId)
    if (typeof enabled !== 'boolean') throw new Error('后台自动采集开关必须是布尔值')
    await appSettings.setUsageBackgroundCollectionEnabled(enabled, assertCurrent)
    assertCurrent()
    ledger.setBackgroundCollectionEnabled(enabled)
    assertCurrent()
    return appSettings.usageBackgroundCollectionEnabled
  })
}
