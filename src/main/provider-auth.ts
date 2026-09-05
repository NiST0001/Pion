import {
  CredentialSynchronizationError,
  ModelRuntime
} from '@earendil-works/pi-coding-agent'
import type {
  ModelProviderAuthType,
  ModelProviderInfo
} from '../shared/types'

export type ProviderLoginInteraction = Parameters<ModelRuntime['login']>[2]
export type ProviderAuthPrompt = Parameters<ProviderLoginInteraction['prompt']>[0]
export type ProviderAuthEvent = Parameters<ProviderLoginInteraction['notify']>[0]

type RuntimeFactory = () => Promise<ModelRuntime>

/**
 * Thin adapter over Pi's canonical ModelRuntime provider/auth APIs.
 *
 * It deliberately returns only credential metadata. Secrets stay inside Pi's
 * AuthStorage and are never projected through Electron IPC.
 */
export class ProviderAuthService {
  private runtimePromise: Promise<ModelRuntime> | null = null

  constructor(
    private readonly createRuntime: RuntimeFactory = () => ModelRuntime.create({
      allowModelNetwork: false
    })
  ) {}

  invalidate(): void {
    this.runtimePromise = null
  }

  private runtime(): Promise<ModelRuntime> {
    if (this.runtimePromise) return this.runtimePromise
    const pending = this.createRuntime().catch((error) => {
      if (this.runtimePromise === pending) this.runtimePromise = null
      throw error
    })
    this.runtimePromise = pending
    return pending
  }

  async listProviders(): Promise<ModelProviderInfo[]> {
    const runtime = await this.runtime()
    const credentials = new Map(
      (await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type])
    )

    return runtime.getProviders()
      .map((provider): ModelProviderInfo => {
        const status = runtime.getProviderAuthStatus(provider.id)
        const authMethods: ModelProviderInfo['authMethods'] = []
        if (provider.auth.apiKey) {
          authMethods.push({
            type: 'api_key',
            name: provider.auth.apiKey.name,
            interactive: typeof provider.auth.apiKey.login === 'function'
          })
        }
        if (provider.auth.oauth) {
          authMethods.push({
            type: 'oauth',
            name: provider.auth.oauth.name,
            loginLabel: provider.auth.oauth.loginLabel,
            interactive: true,
            subscription: provider.auth.oauth.isSubscription === true
          })
        }
        return {
          id: provider.id,
          name: provider.name,
          modelCount: provider.getModels().length,
          configured: status.configured,
          configuredSource: status.source,
          configuredLabel: status.label,
          storedCredentialType: credentials.get(provider.id),
          authMethods
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: 'base'
      }))
  }

  async login(
    providerId: string,
    authType: ModelProviderAuthType,
    interaction: ProviderLoginInteraction
  ): Promise<void> {
    const normalizedId = providerId.trim()
    if (!normalizedId) throw new Error('请选择提供商')
    if (authType !== 'api_key' && authType !== 'oauth') throw new Error('不支持的认证方式')

    const runtime = await this.runtime()
    const provider = runtime.getProvider(normalizedId)
    if (!provider) throw new Error(`未知提供商：${normalizedId}`)
    const auth = authType === 'api_key' ? provider.auth.apiKey : provider.auth.oauth
    if (!auth) throw new Error(`${provider.name} 不支持所选认证方式`)
    if (authType === 'api_key' && typeof provider.auth.apiKey?.login !== 'function') {
      throw new Error(`${provider.name} 仅支持环境或系统凭据，无法在 Pion 中交互配置`)
    }

    try {
      await runtime.login(normalizedId, authType, interaction)
    } catch (error) {
      // Pi guarantees the credential mutation already committed for this error.
      // Pion restarts every idle backend immediately afterwards, so a stale
      // in-memory snapshot must not turn a successful login into a false failure.
      if (!(error instanceof CredentialSynchronizationError)) throw error
      this.invalidate()
    }
  }

  async logout(providerId: string): Promise<void> {
    const normalizedId = providerId.trim()
    if (!normalizedId) throw new Error('请选择提供商')
    const runtime = await this.runtime()
    if (!runtime.getProvider(normalizedId)) throw new Error(`未知提供商：${normalizedId}`)
    try {
      await runtime.logout(normalizedId)
    } catch (error) {
      if (!(error instanceof CredentialSynchronizationError)) throw error
      this.invalidate()
    }
  }
}
