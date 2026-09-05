import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
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

    expect(runtime.login).toHaveBeenCalledWith('openai-codex', 'oauth', interaction)
    expect(runtime.logout).toHaveBeenCalledWith('openai-codex')
  })

  it('does not invent an interactive form for ambient-only credentials', async () => {
    const service = new ProviderAuthService(async () => runtimeFixture())

    await expect(service.login('ambient-only', 'api_key', {
      prompt: vi.fn(async () => ''),
      notify: vi.fn()
    })).rejects.toThrow('仅支持环境或系统凭据')
  })
})
