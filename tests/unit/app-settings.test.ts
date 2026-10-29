import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSettings } from '../../src/main/app-settings'
import { captureIpcOwner } from '../../src/main/ipc/owner'
import { IPC } from '../../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  userData: '',
  publish: vi.fn<(file: string, value: unknown) => Promise<void>>()
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('../../src/main/atomic-json-file', () => ({ writeAtomicJson: mocks.publish }))
let publishJson: typeof import('../../src/main/atomic-json-file').writeAtomicJson
const path = () => join(mocks.userData, 'pion-settings.json')
const modelPath = resolve('/project/session.jsonl')
const model = { provider: 'example', modelId: 'original' }

beforeAll(async () => {
  ;({ writeAtomicJson: publishJson } = await vi.importActual<typeof import('../../src/main/atomic-json-file')>('../../src/main/atomic-json-file'))
})
beforeEach(async () => {
  mocks.userData = await mkdtemp(join(tmpdir(), 'pion-app-settings-'))
  mocks.publish.mockReset().mockImplementation((file, value) => publishJson(file, value))
})
afterEach(async () => { await rm(mocks.userData, { recursive: true, force: true }) })

describe('shell settings persistence', () => {
  it.each(['{broken', 'null', '{"windowEffectsEnabled":"yes"}', '{"sessionModels":[]}'])('preserves corrupt source without allowing a default write: %s', async (raw) => {
    await writeFile(path(), raw)
    const store = new AppSettings()
    await expect(store.load()).rejects.toThrow()
    await expect(store.setCompletionNotificationsEnabled(false)).rejects.toThrow()
    expect(await readFile(path(), 'utf8')).toBe(raw)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('keeps non-missing read failures visible and blocks writes until a successful read', async () => {
    await mkdir(path())
    await writeFile(join(path(), 'preserved'), 'original')
    const store = new AppSettings()
    await expect(store.load()).rejects.toThrow()
    await expect(store.setWindowEffectsEnabled(true)).rejects.toThrow()
    expect(await readFile(join(path(), 'preserved'), 'utf8')).toBe('original')
    expect(mocks.publish).not.toHaveBeenCalled()
    await rm(path(), { recursive: true })
    await writeFile(path(), JSON.stringify({ completionNotificationsEnabled: false }))
    await store.setWindowEffectsEnabled(true)
    expect(store.completionNotificationsEnabled).toBe(false)
  })

  it('retains every previous value and source after failed setting/model mutations', async () => {
    const original = {
      completionNotificationsEnabled: false, windowEffectsEnabled: true,
      usageBackgroundCollectionEnabled: false, sessionModels: { [modelPath]: model }
    }
    const source = JSON.stringify(original)
    await writeFile(path(), source)
    const store = new AppSettings()
    await store.load()
    const failure = new Error('controlled publication failure')
    mocks.publish.mockRejectedValue(failure)
    const results = await Promise.allSettled([
      store.setCompletionNotificationsEnabled(true), store.setWindowEffectsEnabled(false),
      store.setUsageBackgroundCollectionEnabled(true),
      store.setSessionModel(modelPath, { ...model, modelId: 'new' }), store.deleteSessionModel(modelPath)
    ])
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ status: 'rejected', reason: failure })))
    expect(store.completionNotificationsEnabled).toBe(false)
    expect(store.windowEffectsEnabled).toBe(true)
    expect(store.usageBackgroundCollectionEnabled).toBe(false)
    expect(store.getSessionModel(modelPath)).toEqual(model)
    expect(await readFile(path(), 'utf8')).toBe(source)
    mocks.publish.mockImplementation((file, value) => publishJson(file, value))
    await store.setCompletionNotificationsEnabled(true)
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({ ...original, completionNotificationsEnabled: true })
  })

  it('merges queued patches only after publication and waits for actual admitted work on shutdown', async () => {
    const extra = { futureSetting: { preserved: true } }
    await writeFile(path(), JSON.stringify({ ...extra, sessionModels: { [modelPath]: model } }))
    const store = new AppSettings()
    await store.load()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    mocks.publish.mockImplementationOnce(async (file, value) => {
      entered()
      await blocked
      await publishJson(file, value)
    })
    const first = store.setWindowEffectsEnabled(true)
    await started
    const updates = [
      first, store.setUsageBackgroundCollectionEnabled(false),
      store.setCompletionNotificationsEnabled(false),
      store.setSessionModel(modelPath, { ...model, modelId: 'new' }), store.load()
    ]
    let drained = false
    const shutdown = store.shutdown().then(() => { drained = true })
    await expect(store.setWindowEffectsEnabled(false)).rejects.toThrow('closed')
    expect(store.windowEffectsEnabled).toBe(false)
    expect(store.usageBackgroundCollectionEnabled).toBe(true)
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    expect(drained).toBe(false)
    release()
    await Promise.all([...updates, shutdown])
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      ...extra, windowEffectsEnabled: true, usageBackgroundCollectionEnabled: false,
      completionNotificationsEnabled: false, sessionModels: { [modelPath]: { ...model, modelId: 'new' } }
    })
    expect(store.windowEffectsEnabled).toBe(true)
    expect(drained).toBe(true)
  })

  it('cleans a closed staging file after a failed atomic replacement while preserving the source', async () => {
    await mkdir(path())
    await writeFile(join(path(), 'preserved'), 'original')
    await expect(publishJson(path(), { windowEffectsEnabled: true })).rejects.toThrow()
    expect(await readFile(join(path(), 'preserved'), 'utf8')).toBe('original')
    expect(await readdir(mocks.userData)).toEqual(['pion-settings.json'])
  })
})

// Execute only the actual shell callbacks; never import the Electron bootstrap.
const shellSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function shellIpc(store: AppSettings) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const context = {
    mainWindowId: 41 as number | undefined, completionNotificationsEnabled: true,
    appSettings: store, captureIpcOwner, IPC,
    ipcMain: { handle: (channel: string, listener: Parameters<IpcMain['handle']>[1]) => handlers.set(channel, listener) }
  }
  const start = shellSource.indexOf('  const getMainWindowId = ')
  const end = shellSource.indexOf('  registerComputerUseIpc(', start)
  const notification = shellSource.slice(shellSource.indexOf('  handle(IPC.GetCompletionNotifications,'), shellSource.indexOf('  // projects ----'))
  const handle = runInNewContext(shellSource.slice(start, end)
    .replace('(): number | undefined', '()').replace(': typeof ipcMain.handle', '')
    + notification.replace('enabled: boolean', 'enabled') + '\nhandle', context) as IpcMain['handle']
  const frame = { detached: false }
  const sender = { id: 41, mainFrame: frame, isDestroyed: () => false }
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { context, handle, sender, event, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) }
}

describe('shell startup, settings IPC and shutdown wiring', () => {
  it('keeps notification runtime state committed and propagates persistence errors', async () => {
    const store = new AppSettings()
    await store.load()
    const h = shellIpc(store)
    const blocked = deferred()
    const started = deferred()
    mocks.publish.mockImplementationOnce(async (file, value) => {
      started.resolve()
      await blocked.promise
      await publishJson(file, value)
    })
    const pending = h.invoke(IPC.SetCompletionNotifications, false)
    await started.promise
    expect(h.context.completionNotificationsEnabled).toBe(true)
    blocked.resolve()
    await pending
    expect(h.context.completionNotificationsEnabled).toBe(false)
    const failure = new Error('publication failed')
    mocks.publish.mockRejectedValueOnce(failure)
    await expect(h.invoke(IPC.SetCompletionNotifications, true)).rejects.toBe(failure)
    expect(h.context.completionNotificationsEnabled).toBe(false)
    await expect(h.invoke(IPC.GetCompletionNotifications)).resolves.toBe(false)
  })

  it.each(['foreign', 'iframe', 'detached', 'destroyed', 'closed'] as const)('rejects %s IPC owners before privileged work', async (invalid) => {
    const h = shellIpc(new AppSettings())
    const effect = vi.fn()
    h.handle('controlled', effect)
    if (invalid === 'foreign') h.sender.id = 99
    if (invalid === 'iframe') Object.assign(h.event, { senderFrame: { detached: false } })
    if (invalid === 'detached') h.sender.mainFrame.detached = true
    if (invalid === 'destroyed') h.sender.isDestroyed = () => true
    if (invalid === 'closed') h.context.mainWindowId = undefined
    await expect(h.invoke('controlled')).rejects.toThrow('活主帧')
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(['window', 'frame'] as const)('rejects late IPC publication after %s replacement', async (replacement) => {
    const h = shellIpc(new AppSettings())
    const blocked = deferred()
    h.handle('controlled', () => blocked.promise)
    const pending = h.invoke('controlled')
    if (replacement === 'window') h.context.mainWindowId = 42
    else h.sender.mainFrame = { detached: false }
    blocked.resolve()
    await expect(pending).rejects.toThrow('活主帧')
  })

  it('shows a fixed settings-read error and continues safe startup without changing the source', async () => {
    const source = '{broken-private-content'
    await writeFile(path(), source)
    const store = new AppSettings()
    const context = {
      appSettings: store, bridge: { loadToolPermissions: vi.fn(async () => {}) },
      verification: { load: vi.fn(async () => {}) }, workflows: { load: vi.fn(async () => {}) },
      completionNotificationsEnabled: true, usageLedger: { setBackgroundCollectionEnabled: vi.fn() },
      console: { error: vi.fn() }, dialog: { showErrorBox: vi.fn() },
      registerIpc: vi.fn(), nativeTheme: { on: vi.fn() }, windowEffects: {}, createWindow: vi.fn()
    }
    const start = shellSource.indexOf('app.whenReady().then(async () => {') + 'app.whenReady().then(async () => {'.length
    const end = shellSource.indexOf('  createWindow()', start) + '  createWindow()'.length
    await runInNewContext(`(async () => {${shellSource.slice(start, end)}})()`, context)
    expect(context.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith('Pion 设置读取失败', 'Pion 设置读取失败，已保留原文件。本次使用默认设置，后续保存前会重新读取。')
    expect(context.console.error).toHaveBeenCalledExactlyOnceWith('[pion] Pion 设置读取失败，已保留原文件。本次使用默认设置，后续保存前会重新读取。')
    expect(context.createWindow).toHaveBeenCalledTimes(1)
    expect(await readFile(path(), 'utf8')).toBe(source)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('waits for bridge and both actual store shutdown promises before quitting', async () => {
    const blocked = [deferred(), deferred(), deferred()]
    const entered = [deferred(), deferred(), deferred()]
    const shutdown = (index: number) => vi.fn(() => { entered[index].resolve(); return blocked[index].promise })
    const context = {
      windowShutdown: Promise.resolve(), bridge: { stop: shutdown(0) },
      appSettings: { shutdown: shutdown(1) }, projects: { shutdown: shutdown(2) },
      sessionOrganization: { shutdown: vi.fn(async () => {}) }, usageLedger: { flush: vi.fn(async () => {}) },
      captureQuitSettled: false, app: { quit: vi.fn() }
    }
    const start = shellSource.indexOf('void stopLocalCapture().then(') + 'void stopLocalCapture().then('.length
    const end = shellSource.indexOf(").catch(error => console.error('[pion] shutdown unverified:', error))", start)
    const quit = runInNewContext(`(${shellSource.slice(start, end)})`, context) as (state: { actualPending: boolean }) => Promise<void>
    await quit({ actualPending: true })
    expect(context.bridge.stop).not.toHaveBeenCalled()
    expect(context.app.quit).not.toHaveBeenCalled()
    const pending = quit({ actualPending: false })
    await entered[0].promise
    expect(context.appSettings.shutdown).not.toHaveBeenCalled()
    blocked[0].resolve()
    await entered[1].promise
    expect(context.projects.shutdown).not.toHaveBeenCalled()
    blocked[1].resolve()
    await entered[2].promise
    expect(context.app.quit).not.toHaveBeenCalled()
    blocked[2].resolve()
    await pending
    expect(context.captureQuitSettled).toBe(true)
    expect(context.app.quit).toHaveBeenCalledTimes(1)
  })
})
