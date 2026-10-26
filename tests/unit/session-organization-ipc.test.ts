import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import { registerSessionOrganizationIpc } from '../../src/main/ipc/session-organization'
import type { SessionOrganization } from '../../src/shared/session-organization'

const snapshot = (): SessionOrganization => ({ version: 1, revision: 0, folders: [], sessions: [] })
function fixture() {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  const handlers = new Map<string, Handler>()
  const frame = { detached: false }
  const sender = Object.assign(new EventEmitter(), { id: 7, mainFrame: frame, isDestroyed: vi.fn(() => false) })
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const store = { get: vi.fn(async () => snapshot()), update: vi.fn(async (_change: unknown, assertCurrent?: () => void) => { assertCurrent?.(); return snapshot() }) }
  let ownerId: number | undefined = 7
  registerSessionOrganizationIpc({ ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener as Handler) } }, store, getMainWindowId: () => ownerId })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { sender, frame, event, store, invoke, owner: (id: number | undefined) => { ownerId = id } }
}

it('only lets the owning live main frame access organization metadata', async () => {
  for (const mode of ['owner', 'destroyed', 'subframe', 'detached', 'missing'] as const) {
    const f = fixture()
    if (mode === 'owner') f.owner(8)
    if (mode === 'destroyed') f.sender.isDestroyed.mockReturnValue(true)
    if (mode === 'subframe') f.sender.mainFrame = { detached: false }
    if (mode === 'detached') f.frame.detached = true
    if (mode === 'missing') f.owner(undefined)
    await expect(f.invoke(IPC.SessionOrganizationGet)).rejects.toThrow()
    await expect(f.invoke(IPC.SessionOrganizationUpdate, { type: 'deleteFolder', id: 'a' })).rejects.toThrow()
    expect(f.store.get).not.toHaveBeenCalled()
    expect(f.store.update).not.toHaveBeenCalled()
  }
})

it('validates argument counts and forwards the update publication guard', async () => {
  const f = fixture()
  await expect(f.invoke(IPC.SessionOrganizationGet, {})).rejects.toThrow()
  await expect(f.invoke(IPC.SessionOrganizationUpdate)).rejects.toThrow()
  await expect(f.invoke(IPC.SessionOrganizationUpdate, {}, {})).rejects.toThrow()
  expect(f.store.get).not.toHaveBeenCalled()
  expect(f.store.update).not.toHaveBeenCalled()
  await expect(f.invoke(IPC.SessionOrganizationGet)).resolves.toEqual(snapshot())
  const change = { type: 'deleteFolder', id: 'a' }
  await expect(f.invoke(IPC.SessionOrganizationUpdate, change)).resolves.toEqual(snapshot())
  expect(f.store.update).toHaveBeenCalledWith(change, expect.any(Function))
  expect(f.sender.listenerCount('did-start-navigation')).toBe(0)
})

it('rejects late reads after owner replacement, destruction, frame detachment or document navigation', async () => {
  for (const mode of ['owner', 'destroyed', 'detached', 'navigation'] as const) {
    const f = fixture()
    let finish!: (value: SessionOrganization) => void
    f.store.get.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const result = f.invoke(IPC.SessionOrganizationGet)
    if (mode === 'owner') f.owner(8)
    if (mode === 'destroyed') f.sender.isDestroyed.mockReturnValue(true)
    if (mode === 'detached') f.frame.detached = true
    if (mode === 'navigation') f.sender.emit('did-start-navigation', {}, 'app://reload', false, true)
    finish(snapshot())
    await expect(result).rejects.toThrow()
    expect(f.sender.listenerCount('did-start-navigation')).toBe(0)
  }
})

it('makes document invalidation sticky before a pending update publishes', async () => {
  const f = fixture()
  let publish!: () => void
  f.store.update.mockImplementation((_change, guard) => new Promise((resolve, reject) => {
    publish = () => { try { guard?.(); resolve(snapshot()) } catch (error) { reject(error) } }
  }))
  const result = f.invoke(IPC.SessionOrganizationUpdate, { type: 'deleteFolder', id: 'a' })
  f.sender.emit('did-start-navigation', {}, 'app://reload', false, true)
  // Returning to the same frame/owner does not revive the previous document.
  publish()
  await expect(result).rejects.toThrow()
  expect(f.sender.listenerCount('did-start-navigation')).toBe(0)
})

it('retains ownership across same-document and subframe navigations', async () => {
  const f = fixture()
  let finish!: (value: SessionOrganization) => void
  f.store.get.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const result = f.invoke(IPC.SessionOrganizationGet)
  f.sender.emit('did-start-navigation', {}, 'app://hash', true, true)
  f.sender.emit('did-start-navigation', {}, 'app://child', false, false)
  finish(snapshot())
  await expect(result).resolves.toEqual(snapshot())
})
