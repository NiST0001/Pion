import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentBridge as Bridge } from '../../src/main/agent/agent-bridge'
import type { PionApi } from '../../src/shared/pion-api'
import { IPC } from '../../src/shared/ipc'
import { ProviderVisibilityStore } from '../../src/main/provider-visibility'

let AgentBridge: typeof import('../../src/main/agent/agent-bridge').AgentBridge
let api: PionApi
const invoke = vi.fn()
const roots: string[] = []
const model = { provider: 'openai', id: 'shared', contextWindow: 8192, reasoning: true }
const otherModel = { ...model, provider: 'other' }
const providers = [
  { id: 'openai', name: 'OpenAI', modelCount: 1, configured: true, authMethods: [] },
  { id: 'other', name: 'Other', modelCount: 1, configured: false, authMethods: [] }
]

// No constructor: the SDK, real credentials and user configuration are never opened.
function fixture(store: ProviderVisibilityStore) {
  const client = {
    getAvailableModels: vi.fn(async () => [
      { ...model, api: 'openai-responses', apiKey: 'private-sentinel', baseUrl: 'https://private.test' },
      otherModel
    ]),
    setModel: vi.fn(), stop: vi.fn(), start: vi.fn(), prompt: vi.fn()
  }
  const state = { model: { ...model }, sessionId: 'existing-session', isStreaming: true }
  const backend = { key: 'existing', client, state, busy: true, compacting: true, pendingRunIds: ['run'] }
  const auth = { listProviders: vi.fn(async () => providers.map((provider) => ({ ...provider }))),
    invalidate: vi.fn(), login: vi.fn(), logout: vi.fn() }
  const sessionModelPreferences = { setSessionModelPreference: vi.fn(), getSessionModelPreference: vi.fn(() => model) }
  const stopBackend = vi.fn(), beginProviderMutation = vi.fn(), reloadBackendsAfterProviderMutation = vi.fn()
  const waitForActiveBackend = vi.fn(async () => backend)
  const win = { webContents: { id: 7, isDestroyed: vi.fn(() => false) }, isDestroyed: vi.fn(() => false) }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    providerVisibility: store, providerAuthService: auth, providerMutationInFlight: false,
    sessionModelPreferences, backendPool: new Map([[backend.key, backend]]), activeKey: backend.key,
    win, waitForActiveBackend, stopBackend, beginProviderMutation, reloadBackendsAfterProviderMutation
  }) as Bridge
  const internals = bridge as unknown as { readBackendModels(value: typeof backend): Promise<unknown[]> }
  const assertNoMutation = () => {
    for (const fn of [client.setModel, client.stop, client.start, client.prompt, auth.login, auth.logout,
      sessionModelPreferences.setSessionModelPreference, stopBackend, beginProviderMutation, reloadBackendsAfterProviderMutation]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(backend.state).toBe(state)
    expect(backend.state.model).toEqual(model)
    expect(backend.busy).toBe(true)
    expect(backend.pendingRunIds).toEqual(['run'])
  }
  return { bridge, store, client, backend, state, auth, win, waitForActiveBackend, internals, assertNoMutation }
}

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), 'pion-provider-display-bridge-'))
  roots.push(root)
  const file = join(root, 'pion-provider-visibility.json')
  return { root, file, store: new ProviderVisibilityStore(file) }
}

describe('provider visibility bridge (display preferences, no real SDK/auth access)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      BrowserWindow: {},
      contextBridge: { exposeInMainWorld: (_name: string, value: PionApi) => { api = value } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }
    }))
    ;({ AgentBridge } = await import('../../src/main/agent/agent-bridge'))
    await import('../../src/preload/index')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    invoke.mockReset()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })
  afterAll(() => { vi.doUnmock('electron'); vi.resetModules() })

  it('hides only the picker provider while busy, retaining the actual model and same-ID other provider', async () => {
    const { store, file } = await temporaryStore()
    const h = fixture(store)
    expect(await h.bridge.getModels()).toEqual([model, otherModel])
    expect(await h.bridge.setModelProviderEnabled('openai', false, 7)).toEqual([
      { ...providers[0], enabled: false }, { ...providers[1], enabled: true }
    ])
    expect(await h.bridge.getModels()).toEqual([otherModel])
    // The runtime catalog is unchanged; future/existing sessions may still use
    // the original model. This preference is not an SDK provider switch.
    expect(await h.client.getAvailableModels()).toHaveLength(2)
    h.assertNoMutation()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, disabledProviderIds: ['openai'] })
    const fresh = fixture(new ProviderVisibilityStore(file))
    expect(await fresh.bridge.getModels()).toEqual([otherModel])
    fresh.assertNoMutation()
    expect(await h.bridge.setModelProviderEnabled('openai', true, 7)).toEqual(providers.map((provider) => ({ ...provider, enabled: true })))
    expect(await h.bridge.getModels()).toEqual([model, otherModel])
    h.assertNoMutation()
  })

  it.each(['false', 0, null, undefined])('rejects invalid boolean %s before catalog reads or saving', async (enabled) => {
    const { store } = await temporaryStore()
    const h = fixture(store), save = vi.spyOn(store, 'setEnabled')
    await expect(h.bridge.setModelProviderEnabled('openai', enabled as unknown as boolean, 7)).rejects.toThrow('提供商显示设置无效')
    expect(h.auth.listProviders).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    h.assertNoMutation()
  })

  it.each(['', 'OpenAI', '../openai', 'openai\n'])('rejects invalid provider ID %s before saving', async (id) => {
    const { store } = await temporaryStore()
    const h = fixture(store), save = vi.spyOn(store, 'setEnabled')
    await expect(h.bridge.setModelProviderEnabled(id, false, 7)).rejects.toThrow('提供商显示设置无效')
    expect(save).not.toHaveBeenCalled()
    h.assertNoMutation()
  })

  it('rejects non-owner, destroyed owner and unknown catalog IDs before saving', async () => {
    const { store } = await temporaryStore()
    const h = fixture(store), save = vi.spyOn(store, 'setEnabled')
    await expect(h.bridge.setModelProviderEnabled('openai', false, 99)).rejects.toThrow('只允许所属主窗口')
    expect(h.auth.listProviders).not.toHaveBeenCalled()
    h.win.isDestroyed.mockReturnValueOnce(true)
    await expect(h.bridge.setModelProviderEnabled('openai', false, 7)).rejects.toThrow('只允许所属主窗口')
    await expect(h.bridge.setModelProviderEnabled('unknown', false, 7)).rejects.toThrow('提供商不存在')
    expect(save).not.toHaveBeenCalled()
    h.assertNoMutation()
  })

  it('rechecks owner after catalog read before committing', async () => {
    const { store } = await temporaryStore()
    const h = fixture(store), save = vi.spyOn(store, 'setEnabled')
    h.auth.listProviders.mockImplementationOnce(async () => {
      h.win.webContents.id = 99
      return providers
    })
    await expect(h.bridge.setModelProviderEnabled('openai', false, 7)).rejects.toThrow('只允许所属主窗口')
    expect(save).not.toHaveBeenCalled()
    h.assertNoMutation()
  })

  it('keeps committed catalog and picker state after a failed save', async () => {
    const { store, file } = await temporaryStore()
    const h = fixture(store)
    await h.bridge.setModelProviderEnabled('openai', false, 7)
    const committed = await readFile(file, 'utf8')
    const error = new Error('save failed')
    vi.spyOn(store, 'setEnabled').mockRejectedValueOnce(error)
    await expect(h.bridge.setModelProviderEnabled('openai', true, 7)).rejects.toBe(error)
    expect(await h.bridge.getModels()).toEqual([otherModel])
    expect((await h.bridge.getModelProviders())[0].enabled).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(committed)
    h.assertNoMutation()
  })

  it('retains a committed preference if the response catalog fails afterwards', async () => {
    const { store, file } = await temporaryStore()
    const h = fixture(store), error = new Error('catalog refresh failed')
    h.auth.listProviders.mockResolvedValueOnce(providers).mockRejectedValueOnce(error)
    await expect(h.bridge.setModelProviderEnabled('openai', false, 7)).rejects.toBe(error)
    expect(JSON.parse(await readFile(file, 'utf8')).disabledProviderIds).toEqual(['openai'])
    expect((await h.bridge.getModelProviders())[0].enabled).toBe(false)
    expect(await h.bridge.getModels()).toEqual([otherModel])
    h.assertNoMutation()
  })

  it('propagates unreadable preferences in catalog/public model projection and never overwrites them', async () => {
    const { store, file } = await temporaryStore()
    await writeFile(file, 'corrupt settings', 'utf8')
    const h = fixture(store), save = vi.spyOn(store, 'setEnabled')
    await expect(h.bridge.getModelProviders()).rejects.toThrow()
    await expect(h.bridge.getModels()).rejects.toThrow()
    await expect(h.bridge.setModelProviderEnabled('openai', false, 7)).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('corrupt settings')
    h.assertNoMutation()
  })

  it('strips SDK API/private model fields and derives enabled from preferences rather than catalog hints', async () => {
    const { store, file } = await temporaryStore()
    const h = fixture(store)
    h.auth.listProviders.mockResolvedValue(providers.map((provider) => ({ ...provider, enabled: false })))
    expect((await h.bridge.getModelProviders()).every((provider) => provider.enabled)).toBe(true)
    await h.bridge.setModelProviderEnabled('openai', false, 7)
    await h.bridge.setModelProviderEnabled('openai', true, 7)
    expect(await h.bridge.getModels()).toEqual([model, otherModel])
    const settings = await readFile(file, 'utf8')
    for (const privateField of ['apiKey', 'private-sentinel', 'baseUrl', 'openai-responses', 'configured', 'authMethods']) {
      expect(settings).not.toContain(privateField)
      expect(JSON.stringify(await h.bridge.getModels())).not.toContain(privateField)
    }
    h.assertNoMutation()
  })

  it('preload forwards invalid runtime input unchanged for main-process validation', async () => {
    invoke.mockResolvedValueOnce([])
    await api.setModelProviderEnabled('openai', 'false' as unknown as boolean)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC.AgentSetModelProviderEnabled, 'openai', 'false')
  })

  it.each([true, false])('preload forwards typed display boolean %s without coercion', async (enabled) => {
    const result = [{ ...providers[0], enabled }]
    invoke.mockResolvedValueOnce(result)
    await expect(api.setModelProviderEnabled('openai', enabled)).resolves.toBe(result)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC.AgentSetModelProviderEnabled, 'openai', enabled)
  })
})
