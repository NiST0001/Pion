import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ScriptTarget, transpileModule } from 'typescript'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSettings } from '../../src/main/app-settings'
import { captureIpcOwner } from '../../src/main/ipc/owner'
import { IPC } from '../../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  userData: '',
  publish: vi.fn<typeof import('../../src/main/atomic-json-file').writeAtomicJson>()
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
  mocks.publish.mockReset().mockImplementation((file, value, beforePublish) => publishJson(file, value, beforePublish))
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
    mocks.publish.mockImplementation((file, value, beforePublish) => publishJson(file, value, beforePublish))
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

  it('rechecks the owner after staging closes and preserves both source and cache on refusal', async () => {
    const source = JSON.stringify({ completionNotificationsEnabled: false })
    await writeFile(path(), source)
    const store = new AppSettings()
    await store.load()
    let current = true
    const assertCurrent = () => { if (!current) throw new Error('retired owner') }
    mocks.publish.mockImplementationOnce(async (file, value, beforePublish) => {
      current = false
      await publishJson(file, value, beforePublish)
    })
    await expect(store.setCompletionNotificationsEnabled(true, assertCurrent)).rejects.toThrow('retired owner')
    expect(store.completionNotificationsEnabled).toBe(false)
    expect(await readFile(path(), 'utf8')).toBe(source)
    expect(await readdir(mocks.userData)).toEqual(['pion-settings.json'])
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
    themeSettings: { get: vi.fn(), set: vi.fn(async (value: unknown, assertCurrent?: () => void) => { assertCurrent?.(); return value }) },
    subagentSettings: { get: vi.fn(), set: vi.fn(async (value: unknown, assertCurrent?: () => void) => { assertCurrent?.(); return value }) },
    ipcMain: { handle: (channel: string, listener: Parameters<IpcMain['handle']>[1]) => handlers.set(channel, listener) }
  }
  const start = shellSource.indexOf('  const getMainWindowId = ')
  const end = shellSource.indexOf('  registerComputerUseIpc(', start)
  const notification = shellSource.slice(shellSource.indexOf('  handle(IPC.GetCompletionNotifications,'), shellSource.indexOf('  // projects ----'))
  const settings = shellSource.slice(shellSource.indexOf('  handle(IPC.GetTheme,'), shellSource.indexOf('  registerWindowIpc('))
  const callbacks = transpileModule(`${shellSource.slice(start, end)}${settings}${notification}\nhandle`, {
    compilerOptions: { target: ScriptTarget.ES2022 }
  }).outputText
  const handle = runInNewContext(callbacks, context) as IpcMain['handle']
  const frame = { detached: false }
  const sender = { id: 41, mainFrame: frame, isDestroyed: () => false }
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { context, handle, sender, event, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) }
}

describe('shell settings IPC wiring', () => {
  it('keeps notification runtime state committed and propagates persistence errors', async () => {
    const store = new AppSettings()
    await store.load()
    const h = shellIpc(store)
    const blocked = deferred()
    const started = deferred()
    mocks.publish.mockImplementationOnce(async (file, value, beforePublish) => {
      started.resolve()
      await blocked.promise
      await publishJson(file, value, beforePublish)
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

  it('retires a notification save before atomic publication when its frame changes', async () => {
    const source = JSON.stringify({ completionNotificationsEnabled: true })
    await writeFile(path(), source)
    const store = new AppSettings()
    await store.load()
    const h = shellIpc(store)
    const blocked = deferred(), staged = deferred()
    mocks.publish.mockImplementationOnce(async (file, value, beforePublish) => {
      staged.resolve()
      await blocked.promise
      await publishJson(file, value, beforePublish)
    })
    const pending = h.invoke(IPC.SetCompletionNotifications, false)
    await staged.promise
    h.sender.mainFrame = { detached: false }
    blocked.resolve()
    await expect(pending).rejects.toThrow('活主帧')
    expect(h.context.completionNotificationsEnabled).toBe(true)
    expect(store.completionNotificationsEnabled).toBe(true)
    expect(await readFile(path(), 'utf8')).toBe(source)
  })

  it.each([
    [IPC.SetTheme, 'themeSettings', 'division-dark'],
    [IPC.SetSubagentSettings, 'subagentSettings', { maxTasks: 3 }]
  ] as const)('passes the captured owner to %s publication', async (channel, storeName, value) => {
    const h = shellIpc(new AppSettings())
    const store = h.context[storeName]
    await expect(h.invoke(channel, value)).resolves.toBe(value)
    expect(store.set).toHaveBeenCalledExactlyOnceWith(value, expect.any(Function))
    const assertCurrent = store.set.mock.calls[0][1]!
    h.sender.mainFrame = { detached: false }
    expect(assertCurrent).toThrow('活主帧')
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
})
