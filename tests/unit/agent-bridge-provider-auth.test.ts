import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { ProviderAuthService, ProviderLoginInteraction } from '../../src/main/provider-auth'
import { ProviderConfigStore } from '../../src/main/provider-config'
import { RunStore } from '../../src/main/run-store'
import type { ModelProviderInfo } from '../../src/shared/types'

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
