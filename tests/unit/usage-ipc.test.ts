import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerUsageIpc } from '../../src/main/ipc/usage'
import { IPC } from '../../src/shared/ipc'
import type { UsageOverview, UsageOverviewQuery } from '../../src/shared/usage-overview'

type Handler = Parameters<IpcMain['handle']>[1]
const snapshot: UsageOverview = {
  revision: 3, collectedAt: 123, firstRecordAt: 100,
  totals: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2, reasoning: 1, total: 36, costUsd: 0.12 },
  sessions: 2, projects: 1, records: 3, byProject: [], byModel: [], daily: [],
  coverage: { discoveredSessions: 2, collectedSessions: 2, unavailableSessions: 0, unresolvedSessions: 0, limitReached: false },
  warnings: []
}

function mainEvent() {
  const frame = { detached: false }
  return { sender: { id: 41, mainFrame: frame, isDestroyed: vi.fn(() => false) }, senderFrame: frame }
}

function harness() {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: vi.fn((channel: string, handler: Handler) => { handlers.set(channel, handler) }) }
  const owner = { id: 41 as number | undefined }
  const ledger = { getOverview: vi.fn<(query?: UsageOverviewQuery) => Promise<UsageOverview>>().mockResolvedValue(snapshot), setBackgroundCollectionEnabled: vi.fn() }
  const appSettings = {
    usageBackgroundCollectionEnabled: true,
    setUsageBackgroundCollectionEnabled: vi.fn(async (value: boolean) => { appSettings.usageBackgroundCollectionEnabled = value })
  }
  registerUsageIpc({ ipcMain, ledger, appSettings, getMainWindowId: () => owner.id })
  return { handlers, ipcMain, owner, ledger, appSettings,
    setting: (channel: string, event: ReturnType<typeof mainEvent>, value?: unknown) =>
      Promise.resolve().then(() => handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, value)),
    invoke: (event: ReturnType<typeof mainEvent>, ...args: [] | [unknown]) =>
      handlers.get(IPC.UsageOverview)!(event as unknown as IpcMainInvokeEvent, ...args) }
}

describe('usage overview IPC', () => {
  it('registers overview and settings routes without eager collection', async () => {
    const h = harness()
    expect([...h.handlers.keys()]).toEqual([IPC.UsageOverview, IPC.GetUsageBackgroundCollection, IPC.SetUsageBackgroundCollection])
    expect(h.ipcMain.handle).toHaveBeenCalledTimes(3)
    expect(h.ledger.getOverview).not.toHaveBeenCalled()
    await expect(h.invoke(mainEvent())).resolves.toBe(snapshot)
    expect(h.ledger.getOverview).toHaveBeenCalledExactlyOnceWith()
    expect(h.ledger.getOverview.mock.contexts[0]).toBe(h.ledger)
  })

  it.each<UsageOverviewQuery>([{}, { month: '2026-06' }, { startDay: 31 }, { month: '2024-02', startDay: 29 },
    { year: '2024' }, { year: '2024', startDay: 31 }, { date: '2024-02-29' }, { date: '2026-12-31', startDay: 15 }])(
    'forwards a valid filter %j without applying defaults', async query => {
      const h = harness()
      await expect(h.invoke(mainEvent(), query)).resolves.toBe(snapshot)
      expect(h.ledger.getOverview).toHaveBeenCalledExactlyOnceWith(query)
    }
  )

  it('preserves the no-argument ledger call for explicit undefined', async () => {
    const h = harness()
    await expect(h.invoke(mainEvent(), undefined)).resolves.toBe(snapshot)
    expect(h.ledger.getOverview).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    null, '2026-06', [], { cwd: '/project' }, { month: '2026-06', extra: true },
    { month: '2026-00' }, { month: '2026-13' }, { month: '2026-6' }, { month: '2026-06-01' },
    { month: 202606 }, { startDay: 0 }, { startDay: 32 }, { startDay: 1.5 },
    { startDay: '1' }, { startDay: NaN }, { startDay: Infinity },
    { year: 2024 }, { year: '24' }, { year: '2024-01' }, { date: '2023-02-29' }, { date: '2024-02-30' },
    { date: '2024-04-31' }, { date: '2024-2-29' }, { date: '2024-02-29T00:00:00Z' },
    { year: '2024', month: '2024-02' }, { month: '2024-02', date: '2024-02-29' }, { year: '2024', date: '2024-02-29' }
  ])('rejects invalid filter %j before collecting usage', async query => {
    const h = harness()
    await expect(h.invoke(mainEvent(), query)).rejects.toThrow()
    expect(h.ledger.getOverview).not.toHaveBeenCalled()
  })

  it('does not merge concurrent queries or their results in the IPC layer', async () => {
    const h = harness()
    const queries = [{ month: '2026-05', startDay: 15 }, { month: '2026-06', startDay: 1 }]
    const finishes: Array<(value: UsageOverview) => void> = []
    h.ledger.getOverview.mockImplementation(() => new Promise(resolve => { finishes.push(resolve) }))
    const first = h.invoke(mainEvent(), queries[0])
    const second = h.invoke(mainEvent(), queries[1])
    expect(h.ledger.getOverview.mock.calls).toEqual([[queries[0]], [queries[1]]])
    const secondSnapshot = { ...snapshot, revision: 4 }
    finishes[1](secondSnapshot)
    await expect(second).resolves.toBe(secondSnapshot)
    finishes[0](snapshot)
    await expect(first).resolves.toBe(snapshot)
    expect(h.ledger.getOverview).toHaveBeenCalledTimes(2)
  })

  it.each(['foreign-window', 'missing-owner', 'child-frame', 'detached-frame', 'destroyed-window'] as const)(
    'rejects %s before collecting usage', async (kind) => {
      const h = harness()
      const event = mainEvent()
      if (kind === 'foreign-window') event.sender.id = 73
      if (kind === 'missing-owner') h.owner.id = undefined
      if (kind === 'child-frame') event.senderFrame = { detached: false }
      if (kind === 'detached-frame') event.senderFrame.detached = true
      if (kind === 'destroyed-window') event.sender.isDestroyed.mockReturnValue(true)
      await expect(h.invoke(event)).rejects.toThrow('只允许所属主窗口')
      expect(h.ledger.getOverview).not.toHaveBeenCalled()
    }
  )

  it.each(['owner', 'main-frame', 'sender-frame', 'detached-frame', 'destroyed-window'] as const)(
    'rejects a late result after %s changes without calling the ledger again', async (kind) => {
      const h = harness()
      const event = mainEvent()
      let finish!: (value: UsageOverview) => void
      h.ledger.getOverview.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      const pending = h.invoke(event)
      expect(h.ledger.getOverview).toHaveBeenCalledExactlyOnceWith()
      if (kind === 'owner') h.owner.id = 73
      if (kind === 'main-frame') event.sender.mainFrame = { detached: false }
      if (kind === 'sender-frame') event.senderFrame = { detached: false }
      if (kind === 'detached-frame') event.senderFrame.detached = true
      if (kind === 'destroyed-window') event.sender.isDestroyed.mockReturnValue(true)
      finish(snapshot)
      await expect(pending).rejects.toThrow('只允许所属主窗口')
      expect(h.ledger.getOverview).toHaveBeenCalledExactlyOnceWith()
    }
  )

  it('preserves ledger failures without retrying', async () => {
    const h = harness()
    const error = new Error('collection unavailable')
    h.ledger.getOverview.mockRejectedValue(error)
    await expect(h.invoke(mainEvent())).rejects.toBe(error)
    expect(h.ledger.getOverview).toHaveBeenCalledExactlyOnceWith()
  })

  it('persists the switch before changing background collection and never scans', async () => {
    const h = harness()
    let finish!: () => void
    h.appSettings.setUsageBackgroundCollectionEnabled.mockImplementation(value => new Promise<void>(resolve => {
      finish = () => { h.appSettings.usageBackgroundCollectionEnabled = value; resolve() }
    }))
    await expect(h.setting(IPC.GetUsageBackgroundCollection, mainEvent())).resolves.toBe(true)
    const pending = h.setting(IPC.SetUsageBackgroundCollection, mainEvent(), false)
    await Promise.resolve()
    expect(h.ledger.setBackgroundCollectionEnabled).not.toHaveBeenCalled()
    finish()
    await expect(pending).resolves.toBe(false)
    expect(h.ledger.setBackgroundCollectionEnabled).toHaveBeenCalledExactlyOnceWith(false)
    expect(h.ledger.getOverview).not.toHaveBeenCalled()
  })

  it('does not change the collector when persistence fails', async () => {
    const h = harness()
    h.appSettings.setUsageBackgroundCollectionEnabled.mockRejectedValue(new Error('disk full'))
    await expect(h.setting(IPC.SetUsageBackgroundCollection, mainEvent(), false)).rejects.toThrow('disk full')
    expect(h.ledger.setBackgroundCollectionEnabled).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 0, 'false', {}])('rejects non-boolean switch %j', async value => {
    const h = harness()
    await expect(h.setting(IPC.SetUsageBackgroundCollection, mainEvent(), value)).rejects.toThrow('布尔值')
    expect(h.appSettings.setUsageBackgroundCollectionEnabled).not.toHaveBeenCalled()
  })

  it.each([IPC.GetUsageBackgroundCollection, IPC.SetUsageBackgroundCollection])('guards settings owner on %s', async channel => {
    const h = harness()
    const event = mainEvent()
    event.senderFrame = { detached: false }
    await expect(h.setting(channel, event, false)).rejects.toThrow('只允许所属主窗口')
    expect(h.appSettings.setUsageBackgroundCollectionEnabled).not.toHaveBeenCalled()
  })

  it('rejects a stale settings response after saving without undoing the persisted collector setting', async () => {
    const h = harness()
    const event = mainEvent()
    h.appSettings.setUsageBackgroundCollectionEnabled.mockImplementation(async value => {
      h.appSettings.usageBackgroundCollectionEnabled = value
      event.senderFrame.detached = true
    })
    await expect(h.setting(IPC.SetUsageBackgroundCollection, event, false)).rejects.toThrow('只允许所属主窗口')
    expect(h.ledger.setBackgroundCollectionEnabled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('starts configured background collection after settings load and stops before shutdown without final scanning', () => {
    const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/appSettings\.load\(\)[\s\S]*usageLedger\.setBackgroundCollectionEnabled\(appSettings\.usageBackgroundCollectionEnabled\)/)
    expect(source).toMatch(/app\.on\('before-quit', \(event\) => \{\s*usageLedger\.stopBackgroundCollection\(\)/)
    expect(source).not.toContain('usageLedger.getOverview()')
    expect(source).toContain('await usageLedger.flush()')
    expect(source).toContain('if (error instanceof UsageLedgerError && error.closeUnknown) throw error')
  })

  it('keeps preload on the shared channel and registration free of runtime backend dependencies', () => {
    const source = readFileSync(new URL('../../src/main/ipc/usage.ts', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
    expect(source.match(/^import (?!type\b).+$/gm)).toEqual([
      "import { IPC } from '../../shared/ipc'",
      "import { validateUsageOverviewQuery } from '../../shared/usage-period'"
    ])
    expect(source).not.toMatch(/\bnew\s+(?!Error\b)/)
    expect(preload).toContain('ipcRenderer.invoke(IPC.GetUsageBackgroundCollection)')
    expect(preload).toContain('ipcRenderer.invoke(IPC.SetUsageBackgroundCollection, enabled)')
    expect(preload).toMatch(/getUsageOverview:\s*\(query\?: UsageOverviewQuery\)\s*=>\s*\(query === undefined\s*\? ipcRenderer\.invoke\(IPC\.UsageOverview\)\s*: ipcRenderer\.invoke\(IPC\.UsageOverview, query\)\)/)
  })
})
