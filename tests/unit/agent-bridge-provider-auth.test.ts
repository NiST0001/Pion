import type { BrowserWindow } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { ProviderAuthService, type ProviderLoginInteraction } from '../../src/main/provider-auth'
import { ProviderConfigStore } from '../../src/main/provider-config'
import { RunStore } from '../../src/main/run-store'
import type { ModelProviderInfo } from '../../src/shared/types'
import type { BackendRecord } from '../../src/main/agent/types'
import { BackendPool } from '../../src/main/agent/backend-pool'

const roots: string[] = []

const provider: ModelProviderInfo = {
  id: 'openai',
  name: 'OpenAI',
  modelCount: 3,
  configured: false,
  authMethods: [{
    type: 'api_key',
    name: 'OpenAI API key',
    interactive: true
  }]
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentBridge provider authentication', () => {
  it.each(['prompt', 'steering', 'control', 'completion', 'checkpoint-create', 'checkpoint-refresh', 'queue', 'interaction', 'run'])
  ('holds provider mutation behind the actual %s receipt even when busy is false', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'pion-provider-idle-'))
    roots.push(root)
    const service = { logout: vi.fn(), invalidate: vi.fn() } as unknown as ProviderAuthService
    const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')), undefined,
      new ProviderConfigStore(join(root, 'agent')), service)
    const backend = { key: 'retained', cwd: root, client: {}, phase: 'running', busy: false, compacting: false,
      pendingRunIds: [], startPromise: Promise.resolve() } as unknown as BackendRecord
    const pending = new Promise<void>(() => undefined)
    if (kind === 'prompt') backend.promptDispatch = { promise: pending, runId: 'in-flight' }
    if (kind === 'steering') backend.steeringDispatchPromises = new Set([pending])
    if (kind === 'control') backend.controlDispatchPromises = new Set([pending])
    if (kind === 'completion') backend.runCompletionPromise = pending
    if (kind === 'checkpoint-create') backend.checkpointCreatePromise = pending
    if (kind === 'checkpoint-refresh') backend.checkpointRefreshPromise = pending.then(() => null)
    if (kind === 'queue') backend.localFollowUps = [{ runId: 'unsent', text: 'unsent', images: [] }]
    if (kind === 'run') backend.activeRunId = 'still-running'
    const internals = bridge as unknown as { backendPool: BackendPool; capabilityHasPendingInteraction(backend: BackendRecord): boolean }
    internals.backendPool.add(backend)
    if (kind === 'interaction') vi.spyOn(internals, 'capabilityHasPendingInteraction').mockReturnValue(true)
    await expect(bridge.logoutModelProvider('openai')).rejects.toThrow('会话正在运行')
    expect(service.logout).not.toHaveBeenCalled()
    expect((bridge as unknown as { providerMutationInFlight: boolean }).providerMutationInFlight).toBe(false)
  })

  it('reads the independent SDK directory without a backend and rejects wrong or replaced owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-subagent-models-'))
    roots.push(root)
    let resolve!: (models: { provider: string; id: string }[]) => void
    const pending = new Promise<{ provider: string; id: string }[]>((done) => { resolve = done })
    const listAvailableModels = vi.fn().mockResolvedValueOnce([{ provider: 'hidden', id: 'child' }]).mockReturnValueOnce(pending)
    const service = { listAvailableModels, refreshForRead: vi.fn(), invalidate: vi.fn(), login: vi.fn(), listProviders: vi.fn() } as unknown as ProviderAuthService
    const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')), undefined,
      new ProviderConfigStore(join(root, 'agent')), service)
    const window = () => ({ webContents: { id: 73, send: vi.fn(), isDestroyed: () => false }, isDestroyed: () => false }) as unknown as BrowserWindow
    const first = window()
    bridge.bind(first)
    await expect(bridge.getSubagentModels(99)).rejects.toThrow('所属主窗口')
    expect(listAvailableModels).not.toHaveBeenCalled()
    await expect(bridge.getSubagentModels(73)).resolves.toEqual([{ provider: 'hidden', id: 'child' }])
    const late = bridge.getSubagentModels(73)
    bridge.bind(window())
    resolve([{ provider: 'old', id: 'late' }])
    await expect(late).rejects.toThrow('所属主窗口')
    expect(service.login).not.toHaveBeenCalled()
    expect(service.listProviders).not.toHaveBeenCalled()
  })

  it('shares actual SDK initialization across both read entries and owner replacement, then refreshes settled metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-subagent-model-slot-'))
    roots.push(root)
    const runtime = { getAvailableSnapshot: () => [], getProviders: () => [], listCredentials: async () => [] } as unknown as ModelRuntime
    let resolve!: (runtime: ModelRuntime) => void
    const pending = new Promise<ModelRuntime>((done) => { resolve = done })
    const createRuntime = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(runtime)
    const service = new ProviderAuthService(createRuntime)
    const available = vi.spyOn(service, 'listAvailableModels')
    const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')), undefined,
      new ProviderConfigStore(join(root, 'agent')), service)
    const window = () => ({ webContents: { id: 73, send: vi.fn(), isDestroyed: () => false }, isDestroyed: () => false }) as unknown as BrowserWindow
    bridge.bind(window())
    const old = bridge.getSubagentModels(73)
    const stale = expect(old).rejects.toThrow('所属主窗口')
    const providers = bridge.getModelProviders()
    bridge.bind(window())
    const current = bridge.getSubagentModels(73)
    expect(available).toHaveBeenCalledOnce()
    expect(createRuntime).toHaveBeenCalledOnce()
    resolve(runtime)
    await stale
    await expect(current).resolves.toEqual([])
    await expect(providers).resolves.toEqual([])
    const refreshedProviders = bridge.getModelProviders()
    const refreshedModels = bridge.getSubagentModels(73)
    expect(createRuntime).toHaveBeenCalledTimes(2)
    await Promise.all([refreshedProviders, refreshedModels])
    await bridge.getSubagentModels(73)
    expect(createRuntime).toHaveBeenCalledTimes(3)
    expect(available).toHaveBeenCalledTimes(3)
  })

  it('retires pending outer directory reuse after a partially failed provider addition without clearing a new shared read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-provider-partial-'))
    roots.push(root)
    const store = new ProviderConfigStore(join(root, 'agent'))
    vi.spyOn(store, 'addProvider').mockRejectedValue(new Error('Pi 已保存凭据，但 models.json 写入失败'))
    let resolveOld!: (runtime: ModelRuntime) => void, resolveCurrent!: (runtime: ModelRuntime) => void
    const createRuntime = vi.fn()
      .mockReturnValueOnce(new Promise<ModelRuntime>(resolve => { resolveOld = resolve }))
      .mockReturnValueOnce(new Promise<ModelRuntime>(resolve => { resolveCurrent = resolve }))
    const service = new ProviderAuthService(createRuntime)
    const invalidate = vi.spyOn(service, 'invalidate')
    const available = vi.spyOn(service, 'listAvailableModels')
    const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')), undefined, store, service)
    bridge.bind({ webContents: { id: 73, send: vi.fn(), isDestroyed: () => false }, isDestroyed: () => false } as unknown as BrowserWindow)
    const stale = expect(bridge.getSubagentModels(73)).rejects.toThrow('模型目录已失效')
    const reload = vi.spyOn(bridge as unknown as { reloadBackendsAfterProviderMutation(): Promise<[]> }, 'reloadBackendsAfterProviderMutation')
    await expect(bridge.addModelProvider({} as Parameters<AgentBridge['addModelProvider']>[0]))
      .rejects.toThrow('Pi 已保存凭据')
    expect(invalidate).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    expect((bridge as unknown as { providerMutationInFlight: boolean }).providerMutationInFlight).toBe(false)
    const current = bridge.getSubagentModels(73)
    const shared = bridge.getSubagentModels(73)
    expect(createRuntime).toHaveBeenCalledTimes(2)
    resolveOld({ getAvailableSnapshot: () => [{ provider: 'old', id: 'stale' }] } as unknown as ModelRuntime)
    await stale
    const stillShared = bridge.getSubagentModels(73)
    expect(available).toHaveBeenCalledTimes(2)
    resolveCurrent({ getAvailableSnapshot: () => [{ provider: 'new', id: 'current' }] } as unknown as ModelRuntime)
    for (const models of await Promise.all([current, shared, stillShared])) expect(models).toEqual([{ provider: 'new', id: 'current' }])
  })

  it('keeps the lower authentication cancellation warning about credentials already saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-provider-cancelled-'))
    roots.push(root)
    const warning = '登录已取消；凭据可能已保存，请刷新提供商状态确认'
    const service = { listProviders: vi.fn(async () => [provider]),
      login: vi.fn(async () => { throw new Error(warning) }), invalidate: vi.fn() } as unknown as ProviderAuthService
    const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')), undefined,
      new ProviderConfigStore(join(root, 'agent')), service)
    await expect(bridge.loginModelProvider('openai', 'api_key')).rejects.toThrow(warning)
    expect(bridge.getModelProviderAuthState()).toMatchObject({ phase: 'cancelled', message: warning })
  })

  it('routes Pi secret prompts through the existing extension UI queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-provider-auth-'))
    roots.push(root)
    let submittedSecret = ''
    const service = {
      listProviders: vi.fn(async () => [
        submittedSecret ? { ...provider, configured: true, storedCredentialType: 'api_key' as const } : provider
      ]),
      login: vi.fn(async (
        _providerId: string,
        _authType: 'api_key' | 'oauth',
        interaction: ProviderLoginInteraction
      ) => {
        interaction.notify({ type: 'progress', message: '等待密钥输入' })
        submittedSecret = await interaction.prompt({
          type: 'secret',
          message: '输入 API 密钥',
          placeholder: 'sk-...'
        })
      }),
      logout: vi.fn(async () => undefined),
      invalidate: vi.fn()
    } as unknown as ProviderAuthService
    const bridge = new AgentBridge(
      new RunStore(join(root, 'runs.json')),
      undefined,
      new ProviderConfigStore(join(root, 'agent')),
      service
    )

    const login = bridge.loginModelProvider('openai', 'api_key')
    await vi.waitFor(() => expect(bridge.getPendingExtensionUiRequests()).toHaveLength(1))
    const request = bridge.getPendingExtensionUiRequests()[0]
    expect(request).toMatchObject({
      source: 'provider-auth',
      scope: 'global',
      method: 'input',
      secret: true
    })
    expect(JSON.stringify(bridge.getModelProviderAuthState())).not.toContain('sk-secret')

    await bridge.resolveExtensionUiRequest(request.id, { value: 'sk-secret' })
    const providers = await login

    expect(submittedSecret).toBe('sk-secret')
    expect(providers[0]).toMatchObject({ configured: true, storedCredentialType: 'api_key' })
    expect(bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(bridge.getModelProviderAuthState()).toMatchObject({ phase: 'success' })
    expect(JSON.stringify(bridge.getModelProviderAuthState())).not.toContain('sk-secret')
  })
})
