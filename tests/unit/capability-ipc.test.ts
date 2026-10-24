import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBridge } from '../../src/main/agent/agent-bridge'
import { registerAgentIpc } from '../../src/main/ipc/agent'
import type { CapabilitySettingsSnapshot, CapabilitySettingsUpdate } from '../../src/shared/capability-settings'
import { IPC } from '../../src/shared/ipc'
import type { PionApi } from '../../src/shared/pion-api'

// Only injected bridge methods and a local Electron mock; no user settings or Agent runtime.
afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
})

const cwd = '/project/worktree'
const snapshot: CapabilitySettingsSnapshot = {
  cwd, revision: 3, catalogueRevision: 'c'.repeat(64), items: [], notices: [],
  application: { state: 'pending', requestedRevision: 3, pendingBackends: 1 }
}
const toggle: CapabilitySettingsUpdate = {
  cwd, expectedRevision: 2, catalogueRevision: snapshot.catalogueRevision,
  change: { type: 'toggle', id: 'tool:pion_task', enabled: false }
}
const preset: CapabilitySettingsUpdate = { ...toggle, change: { type: 'preset', preset: 'minimal' } }
const routes = [
  [IPC.GetCapabilitySettings, 'getCapabilitySettings', cwd],
  [IPC.UpdateCapabilitySettings, 'updateCapabilitySettings', toggle]
] as const

function mainEvent() {
  const frame = { detached: false }
  return {
    sender: { id: 41, mainFrame: frame, isDestroyed: vi.fn(() => false) },
    senderFrame: frame as typeof frame | null
  }
}

function harness(withOwnerGetter = true) {
  type Handler = Parameters<IpcMain['handle']>[1]
  const handlers = new Map<string, Handler>()
  const owner = { id: 41 as number | undefined }
  const bridge = {
    getCapabilitySettings: vi.fn(), updateCapabilitySettings: vi.fn(), start: vi.fn(),
    withSessionOperation: vi.fn().mockRejectedValue(new Error('session mutation is busy'))
  }
  const projects = { touchCanonical: vi.fn() }, pushProjects = vi.fn()
  registerAgentIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    bridge: bridge as unknown as AgentBridge, projects, pushProjects,
    getMainWindowId: withOwnerGetter ? () => owner.id : undefined
  })
  return {
    bridge, owner, projects, pushProjects,
    invoke: (channel: string, event: ReturnType<typeof mainEvent>, input?: unknown) =>
      handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, input)
  }
}

describe('capability settings IPC', () => {
  it.each([...routes, [IPC.GetCapabilitySettings, 'getCapabilitySettings', undefined],
    [IPC.UpdateCapabilitySettings, 'updateCapabilitySettings', preset]] as const)(
    '%s forwards the original input, return value, receiver and errors through %s without reserving a session',
    async (channel, method, input) => {
      const h = harness(), event = mainEvent(), stub = h.bridge[method]
      for (const member of Object.values(h.bridge)) expect(member).not.toHaveBeenCalled()
      stub.mockReturnValueOnce(snapshot)
      expect(h.invoke(channel, event, input)).toBe(snapshot)
      expect(stub).toHaveBeenCalledExactlyOnceWith(input, expect.any(Function))
      expect(stub.mock.calls[0][0]).toBe(input)
      expect(stub.mock.contexts[0]).toBe(h.bridge)
      expect(() => stub.mock.calls[0][1]()).not.toThrow()
      const promised = Promise.resolve(snapshot)
      stub.mockReturnValueOnce(promised)
      expect(h.invoke(channel, event, input)).toBe(promised)
      await expect(promised).resolves.toBe(snapshot)
      const error = new Error('capability settings rejected')
      stub.mockImplementationOnce(() => { throw error })
      expect(() => h.invoke(channel, event, input)).toThrow(error)
      stub.mockRejectedValueOnce(error)
      await expect(h.invoke(channel, event, input)).rejects.toBe(error)
      expect(stub).toHaveBeenCalledTimes(4)
      for (const member of Object.values(h.bridge)) if (member !== stub) expect(member).not.toHaveBeenCalled()
      expect(h.projects.touchCanonical).not.toHaveBeenCalled()
      expect(h.pushProjects).not.toHaveBeenCalled()
    }
  )

  it.each(routes)('%s rejects foreign, missing or dead owners and non-main frames before %s', (channel, method, input) => {
    for (const kind of ['foreign-owner', 'missing-owner', 'missing-getter', 'iframe', 'missing-frame', 'detached', 'destroyed'] as const) {
      const h = harness(kind !== 'missing-getter'), event = mainEvent()
      if (kind === 'foreign-owner') event.sender.id = 73
      if (kind === 'missing-owner') h.owner.id = undefined
      if (kind === 'iframe') event.senderFrame = { detached: false }
      if (kind === 'missing-frame') event.senderFrame = null
      if (kind === 'detached') event.senderFrame!.detached = true
      if (kind === 'destroyed') event.sender.isDestroyed.mockReturnValue(true)
      expect(() => h.invoke(channel, event, input)).toThrow('只允许所属主窗口管理工具与能力')
      expect(h.bridge[method]).not.toHaveBeenCalled()
      expect(h.bridge.withSessionOperation).not.toHaveBeenCalled()
      expect(h.bridge.start).not.toHaveBeenCalled()
    }
  })

  it.each(routes)('%s supplies %s with a live owner/frame fence for asynchronous work', async (channel, method, input) => {
    for (const kind of ['owner', 'missing-owner', 'main-frame', 'sender-frame', 'detached', 'destroyed'] as const) {
      const h = harness(), event = mainEvent()
      let finish!: () => void
      const pendingWork = new Promise<void>((resolve) => { finish = resolve })
      h.bridge[method].mockImplementation(async (_input, assertCurrent) => {
        await pendingWork
        assertCurrent()
        return snapshot
      })
      const pending = h.invoke(channel, event, input)
      expect(h.bridge[method]).toHaveBeenCalledExactlyOnceWith(input, expect.any(Function))
      if (kind === 'owner') h.owner.id = 73
      if (kind === 'missing-owner') h.owner.id = undefined
      if (kind === 'main-frame') event.sender.mainFrame = { detached: false }
      if (kind === 'sender-frame') event.senderFrame = { detached: false }
      if (kind === 'detached') event.senderFrame!.detached = true
      if (kind === 'destroyed') event.sender.isDestroyed.mockReturnValue(true)
      finish()
      await expect(pending).rejects.toThrow('只允许所属主窗口管理工具与能力')
      expect(h.bridge[method]).toHaveBeenCalledTimes(1)
      expect(h.bridge.withSessionOperation).not.toHaveBeenCalled()
      expect(h.bridge.start).not.toHaveBeenCalled()
    }
  })
})

it('preload forwards only the exact capability channels and inputs, with no eager calls or retries', async () => {
  let api!: PionApi
  const invoke = vi.fn(), on = vi.fn(), off = vi.fn(), send = vi.fn()
  const expose = vi.fn((_name: string, value: PionApi) => { api = value })
  vi.resetModules()
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke, on, off, send }
  }))
  await import('../../src/preload/index')
  expect(expose).toHaveBeenCalledExactlyOnceWith('pion', api)
  expect(invoke).not.toHaveBeenCalled()
  const calls = [
    [() => api.getCapabilitySettings(cwd), IPC.GetCapabilitySettings, cwd],
    [() => api.getCapabilitySettings(), IPC.GetCapabilitySettings, undefined],
    [() => api.updateCapabilitySettings(toggle), IPC.UpdateCapabilitySettings, toggle],
    [() => api.updateCapabilitySettings(preset), IPC.UpdateCapabilitySettings, preset]
  ] as const
  for (const [call, channel, input] of calls) {
    invoke.mockClear()
    const pending = Promise.resolve(snapshot)
    invoke.mockReturnValueOnce(pending)
    expect(call()).toBe(pending)
    await expect(pending).resolves.toBe(snapshot)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, input)
    expect(invoke.mock.calls[0][1]).toBe(input)
    const error = new Error('capability IPC unavailable')
    invoke.mockRejectedValueOnce(error)
    await expect(call()).rejects.toBe(error)
    expect(invoke.mock.calls).toEqual([[channel, input], [channel, input]])
  }
  for (const method of [on, off, send]) expect(method).not.toHaveBeenCalled()
})
