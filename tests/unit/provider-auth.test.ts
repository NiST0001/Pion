import { CredentialSynchronizationError, SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { ProviderAuthService } from '../../src/main/provider-auth'

function runtimeFixture(overrides: Partial<ModelRuntime> = {}): ModelRuntime {
  const providers = [{
    id: 'openai-codex',
    name: 'OpenAI Codex',
    auth: {
      oauth: {
        name: 'OpenAI (ChatGPT Plus/Pro)',
        loginLabel: 'Sign in with ChatGPT',
        isSubscription: true,
        login: vi.fn(),
        refresh: vi.fn(),
        toAuth: vi.fn()
      }
    },
    getModels: () => [{ id: 'gpt-5', provider: 'openai-codex' }]
  }, {
    id: 'ambient-only',
    name: 'Ambient Only',
    auth: {
      apiKey: {
        name: 'System credentials',
        resolve: vi.fn()
      }
    },
    getModels: () => []
  }]
  return {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((provider) => provider.id === id),
    getProviderAuthStatus: (id: string) => id === 'openai-codex'
      ? { configured: true, source: 'stored' }
      : { configured: false },
    listCredentials: vi.fn(async () => [{ providerId: 'openai-codex', type: 'oauth' }]),
    login: vi.fn(async () => ({ type: 'oauth', refresh: 'hidden', access: 'hidden', expires: 1 })),
    logout: vi.fn(async () => undefined),
    ...overrides
  } as unknown as ModelRuntime
}

describe('ProviderAuthService', () => {
  it('projects Pi provider methods and status without credential values', async () => {
    const service = new ProviderAuthService(async () => runtimeFixture())

    const providers = await service.listProviders()

    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openai-codex',
        configured: true,
        storedCredentialType: 'oauth',
        modelCount: 1,
        authMethods: [expect.objectContaining({
          type: 'oauth',
          loginLabel: 'Sign in with ChatGPT',
          subscription: true
        })]
      }),
      expect.objectContaining({
        id: 'ambient-only',
        authMethods: [expect.objectContaining({
          type: 'api_key',
          interactive: false
        })]
      })
    ]))
    expect(JSON.stringify(providers)).not.toContain('hidden')
  })

  it('delegates interactive login and logout to Pi ModelRuntime', async () => {
    const runtime = runtimeFixture()
    const service = new ProviderAuthService(async () => runtime)
    const interaction = {
      prompt: vi.fn(async () => 'answer'),
      notify: vi.fn()
    }

    await service.login('openai-codex', 'oauth', interaction)
    await service.logout('openai-codex')

    expect(runtime.login).toHaveBeenCalledWith('openai-codex', 'oauth', interaction, {
      getDeviceId: expect.any(Function)
    })
    expect(runtime.logout).toHaveBeenCalledWith('openai-codex')
  })

  it('uses a stable global SDK device ID across logins and runtime replacement', async () => {
    let global: string | undefined
    const projectId = '11111111-1111-4111-8111-111111111111'
    const storage = {
      withLock: vi.fn((scope: 'global' | 'project', update: (current: string | undefined) => string | undefined) => {
        const next = update(scope === 'global' ? global : JSON.stringify({ deviceId: projectId }))
        if (scope === 'global' && next !== undefined) global = next
      })
    }
    const createSettings = vi.fn(() => SettingsManager.fromStorage(storage, { projectTrusted: false }))
    const ids: string[] = []
    const runtime = runtimeFixture({
      login: vi.fn<ModelRuntime['login']>(async (_provider, _type, _interaction, options) => {
        ids.push(options!.getDeviceId!())
        return { type: 'oauth', refresh: 'hidden', access: 'hidden', expires: 1 }
      })
    })
    const service = new ProviderAuthService(async () => runtime, createSettings)
    const interaction = { prompt: vi.fn(async () => ''), notify: vi.fn() }

    await service.login('openai-codex', 'oauth', interaction)
    service.invalidate()
    await service.login('openai-codex', 'oauth', interaction)

    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(ids).toEqual([ids[0], ids[0]])
    expect(ids[0]).not.toBe(projectId)
    expect(JSON.parse(global!).deviceId).toBe(ids[0])
    expect(storage.withLock.mock.calls.every(([scope]) => scope === 'global')).toBe(true)
  })

  it('does not load settings when OAuth or legacy API-key login never requests an ID', async () => {
    const runtime = runtimeFixture({
      getProvider: vi.fn(() => ({
        id: 'legacy', name: 'Legacy',
        auth: {
          apiKey: { name: 'API key', login: vi.fn(), resolve: vi.fn(() => { throw new Error('Unexpected credential resolution') }) },
          oauth: { name: 'OAuth', login: vi.fn(), refresh: vi.fn(), toAuth: vi.fn() }
        },
        getModels: () => [],
        stream: vi.fn(() => { throw new Error('Unexpected provider stream') }),
        streamSimple: vi.fn(() => { throw new Error('Unexpected provider stream') })
      })) as ModelRuntime['getProvider']
    })
    const createSettings = vi.fn(() => SettingsManager.inMemory())
    const service = new ProviderAuthService(async () => runtime, createSettings)
    const interaction = { prompt: vi.fn(async () => 'hidden'), notify: vi.fn() }

    await service.login('legacy', 'api_key', interaction)
    await service.login('legacy', 'oauth', interaction)

    expect(runtime.login).toHaveBeenCalledWith('legacy', 'api_key', interaction, {
      getDeviceId: expect.any(Function)
    })
    expect(createSettings).not.toHaveBeenCalled()
  })

  it('rejects settings load errors before generating an ID', async () => {
    const getOrCreateDeviceId = vi.fn(() => 'unused')
    const settings = {
      getOrCreateDeviceId,
      flush: vi.fn(async () => undefined),
      drainErrors: vi.fn()
        .mockReturnValueOnce([{ scope: 'global', error: new Error('invalid settings') }])
        .mockReturnValue([])
    }
    const runtime = runtimeFixture({
      login: vi.fn<ModelRuntime['login']>(async (_provider, _type, _interaction, options) => {
        options!.getDeviceId!()
        throw new Error('unreachable')
      })
    })
    const service = new ProviderAuthService(async () => runtime, () => settings)

    await expect(service.login('openai-codex', 'oauth', {
      prompt: vi.fn(async () => ''), notify: vi.fn()
    })).rejects.toThrow('无法读取 Pi 安装设备 ID')
    expect(getOrCreateDeviceId).not.toHaveBeenCalled()
    expect(settings.flush).toHaveBeenCalledOnce()
  })

  it.each(['success', 'cancel', 'credential-sync'] as const)(
    'surfaces device ID save failures after %s instead of treating login as successful', async (outcome) => {
      const settings = {
        getOrCreateDeviceId: vi.fn(() => '22222222-2222-4222-8222-222222222222'),
        flush: vi.fn(async () => undefined),
        drainErrors: vi.fn().mockReturnValueOnce([])
          .mockReturnValue([{ scope: 'global', error: new Error('write denied') }])
      }
      const runtime = runtimeFixture({
        login: vi.fn<ModelRuntime['login']>(async (_provider, _type, _interaction, options) => {
          options!.getDeviceId!()
          if (outcome === 'cancel') throw new Error('Login cancelled')
          if (outcome === 'credential-sync') {
            throw new CredentialSynchronizationError('openai-codex', 'login', undefined, {
              cause: new Error('snapshot failed')
            })
          }
          return { type: 'oauth', refresh: 'hidden', access: 'hidden', expires: 1 }
        })
      })
      const service = new ProviderAuthService(async () => runtime, () => settings)

      await expect(service.login('openai-codex', 'oauth', {
        prompt: vi.fn(async () => ''), notify: vi.fn()
      })).rejects.toThrow('无法保存 Pi 安装设备 ID')
      expect(settings.flush).toHaveBeenCalledOnce()
    }
  )

  it.each([true, false])('preserves direct cancellation and its original interaction signal (device ID: %s)', async (requestId) => {
    const settings = {
      getOrCreateDeviceId: vi.fn(() => '22222222-2222-4222-8222-222222222222'),
      flush: vi.fn(async () => undefined),
      drainErrors: vi.fn(() => [])
    }
    const controller = new AbortController()
    const cancellation = new Error('Login cancelled')
    const runtime = runtimeFixture({
      login: vi.fn<ModelRuntime['login']>(async (_provider, _type, interaction, options) => {
        if (requestId) options!.getDeviceId!()
        controller.abort()
        expect(interaction.signal?.aborted).toBe(true)
        throw cancellation
      })
    })
    const createSettings = vi.fn(() => settings)
    const service = new ProviderAuthService(async () => runtime, createSettings)
    const interaction = { signal: controller.signal, prompt: vi.fn(async () => ''), notify: vi.fn() }

    await expect(service.login('openai-codex', 'oauth', interaction)).rejects.toBe(cancellation)
    expect(settings.flush).toHaveBeenCalledTimes(requestId ? 1 : 0)
    expect(createSettings).toHaveBeenCalledTimes(requestId ? 1 : 0)
    expect(runtime.login).toHaveBeenCalledWith('openai-codex', 'oauth', interaction, {
      getDeviceId: expect.any(Function)
    })
  })

  it.each([
    { requestId: true, settingsFailure: 'none' },
    { requestId: false, settingsFailure: 'none' },
    { requestId: true, settingsFailure: 'drain' },
    { requestId: true, settingsFailure: 'flush' }
  ] as const)(
    'preserves post-commit cancellation (device ID: $requestId, settings: $settingsFailure)',
    async ({ requestId, settingsFailure }) => {
      const deviceId = '22222222-2222-4222-8222-222222222222'
      const credential = { type: 'oauth' as const, refresh: 'private-refresh', access: 'private-access', expires: 1 }
      const committed = new Map<string, typeof credential>()
      const controller = new AbortController()
      const settings = {
        getOrCreateDeviceId: vi.fn(() => deviceId),
        flush: vi.fn(async () => {
          expect(invalidate).toHaveBeenCalledOnce()
          if (settingsFailure === 'flush') throw new Error(`write failed: ${deviceId}`)
        }),
        drainErrors: vi.fn().mockReturnValueOnce([]).mockReturnValue(
          settingsFailure === 'drain' ? [{ scope: 'global', error: new Error(deviceId) }] : []
        )
      }
      const createSettings = vi.fn(() => settings)
      const runtime = runtimeFixture({
        // Mirror ModelRuntime.login: models.login commits first, then
        // synchronizeCredentialState wraps signal.throwIfAborted() with the
        // committed credential. No real SDK storage or provider API is used.
        login: vi.fn<ModelRuntime['login']>(async (providerId, _type, interaction, options) => {
          if (requestId) options!.getDeviceId!()
          committed.set(providerId, credential)
          controller.abort(new Error(`private-access ${deviceId}`))
          try {
            interaction.signal!.throwIfAborted()
          } catch (cause) {
            throw new CredentialSynchronizationError(providerId, 'login', credential, { cause })
          }
          return credential
        })
      })
      const replacement = runtimeFixture()
      const createRuntime = vi.fn().mockResolvedValueOnce(runtime).mockResolvedValue(replacement)
      const service = new ProviderAuthService(createRuntime, createSettings)
      const invalidate = vi.spyOn(service, 'invalidate')
      const interaction = { signal: controller.signal, prompt: vi.fn(async () => ''), notify: vi.fn() }

      const error = await service.login('openai-codex', 'oauth', interaction).catch((error: unknown) => error)

      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({
        name: 'AbortError', message: expect.stringContaining('凭据可能已保存')
      })
      if (settingsFailure !== 'none') {
        expect((error as Error).message).toContain('无法保存 Pi 安装设备 ID')
      }
      expect(error).not.toHaveProperty('credential')
      expect(error).not.toHaveProperty('cause')
      for (const secret of [credential.access, credential.refresh, deviceId]) {
        expect(String(error)).not.toContain(secret)
        expect(JSON.stringify(error)).not.toContain(secret)
      }
      expect(committed.get('openai-codex')).toBe(credential)
      expect(runtime.logout).not.toHaveBeenCalled()
      expect(invalidate).toHaveBeenCalledOnce()
      expect(settings.flush).toHaveBeenCalledTimes(requestId ? 1 : 0)
      expect(createSettings).toHaveBeenCalledTimes(requestId ? 1 : 0)
      expect(settings.drainErrors).toHaveBeenCalledTimes(requestId
        ? settingsFailure === 'flush' ? 1 : 2
        : 0)
      await service.listProviders()
      expect(createRuntime).toHaveBeenCalledTimes(2)
      expect(replacement.listCredentials).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { cancelled: true, settingsFailure: 'flush' },
    { cancelled: true, settingsFailure: 'drain' },
    { cancelled: false, settingsFailure: 'flush' },
    { cancelled: false, settingsFailure: 'drain' }
  ] as const)(
    'sanitizes save failure after direct login (cancelled: $cancelled, settings: $settingsFailure)',
    async ({ cancelled, settingsFailure }) => {
      const secret = 'private-io-device-id-and-credential'
      const privateCause = new Error(secret)
      const controller = new AbortController()
      const settings = {
        getOrCreateDeviceId: vi.fn(() => secret),
        flush: vi.fn(async () => {
          if (settingsFailure === 'flush') throw new Error(secret, { cause: privateCause })
        }),
        drainErrors: vi.fn().mockReturnValueOnce([]).mockReturnValue(
          settingsFailure === 'drain' ? [{ scope: 'global', error: privateCause }] : []
        )
      }
      const runtime = runtimeFixture({
        login: vi.fn<ModelRuntime['login']>(async (_provider, _type, _interaction, options) => {
          options!.getDeviceId!()
          if (cancelled) {
            controller.abort(privateCause)
            throw new Error(secret, { cause: privateCause })
          }
          return { type: 'oauth', refresh: secret, access: secret, expires: 1 }
        })
      })
      const service = new ProviderAuthService(async () => runtime, () => settings)
      const error = await service.login('openai-codex', 'oauth', {
        signal: controller.signal, prompt: vi.fn(async () => ''), notify: vi.fn()
      }).catch((error: unknown) => error)

      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({
        name: cancelled ? 'AbortError' : 'Error',
        message: expect.stringContaining('无法保存 Pi 安装设备 ID')
      })
      if (cancelled) expect((error as Error).message).toContain('凭据可能已保存')
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('credential')
      expect(String(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect((error as Error).stack).not.toContain(secret)
      expect(runtime.logout).not.toHaveBeenCalled()
      expect(settings.getOrCreateDeviceId).toHaveBeenCalledOnce()
      expect(settings.flush).toHaveBeenCalledOnce()
      expect(settings.drainErrors).toHaveBeenCalledTimes(settingsFailure === 'flush' ? 1 : 2)
    }
  )

  it('still accepts ordinary committed synchronization errors and invalidates the runtime', async () => {
    const runtime = runtimeFixture({
      login: vi.fn<ModelRuntime['login']>(async () => {
        throw new CredentialSynchronizationError('openai-codex', 'login', {
          type: 'oauth', refresh: 'private-refresh', access: 'private-access', expires: 1
        }, { cause: new Error('snapshot failed') })
      })
    })
    const createRuntime = vi.fn(async () => runtime)
    const service = new ProviderAuthService(createRuntime)

    await expect(service.login('openai-codex', 'oauth', {
      prompt: vi.fn(async () => ''), notify: vi.fn()
    })).resolves.toBeUndefined()
    await service.listProviders()
    expect(createRuntime).toHaveBeenCalledTimes(2)
    expect(runtime.logout).not.toHaveBeenCalled()
  })

  it('does not invent an interactive form for ambient-only credentials', async () => {
    const service = new ProviderAuthService(async () => runtimeFixture())

    await expect(service.login('ambient-only', 'api_key', {
      prompt: vi.fn(async () => ''),
      notify: vi.fn()
    })).rejects.toThrow('仅支持环境或系统凭据')
  })
})
