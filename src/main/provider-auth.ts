import {
  CredentialSynchronizationError,
  ModelRuntime,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type {
  ModelProviderAuthType,
  ModelProviderInfo
} from '../shared/types'

export type ProviderLoginInteraction = Parameters<ModelRuntime['login']>[2]
export type ProviderAuthPrompt = Parameters<ProviderLoginInteraction['prompt']>[0]
export type ProviderAuthEvent = Parameters<ProviderLoginInteraction['notify']>[0]

type RuntimeFactory = () => Promise<ModelRuntime>
type LoginSettings = Pick<SettingsManager, 'getOrCreateDeviceId' | 'flush' | 'drainErrors'>
type SettingsFactory = () => LoginSettings

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
    }),
    private readonly createLoginSettings: SettingsFactory = () => SettingsManager.create(
      process.cwd(), undefined, { projectTrusted: false }
    )
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

    // Match Pi's interactive login: the SDK decides whether it needs a host ID.
    // Do not load settings or generate an ID for legacy/API-key flows that never
    // request one. Device IDs are global; project settings must not participate.
    let settings: LoginSettings | undefined
    try {
      await runtime.login(normalizedId, authType, interaction, {
        getDeviceId: () => {
          settings ??= this.createLoginSettings()
          if (settings.drainErrors().length) {
            throw new Error('无法读取 Pi 安装设备 ID 设置，请检查全局设置后重试登录')
          }
          return settings.getOrCreateDeviceId()
        }
      })
    } catch (error) {
      // Pi wraps synchronization failures (including post-commit aborts) after
      // the credential mutation. Never roll it back; discard the stale snapshot
      // before reporting cancellation or accepting an ordinary sync failure.
      if (!(error instanceof CredentialSynchronizationError)) throw error
      this.invalidate()
      if (interaction.signal?.aborted) {
        // Neither the wrapped error's credential/cause nor an arbitrary abort
        // reason is safe to expose through IPC. Cancellation is not a rollback.
        const cancellation = new Error('登录已取消；凭据可能已保存，请刷新提供商状态确认')
        cancellation.name = 'AbortError'
        throw cancellation
      }
    } finally {
      // SDK settings writes are queued and report errors separately from flush().
      // Await them even if login was cancelled or credential sync failed; an
      // unsaved ID must never be silently treated as a stable installation ID.
      if (settings) {
        try {
          await settings.flush()
          if (settings.drainErrors().length) throw new Error('Settings write failed')
        } catch {
          // Do not expose settings errors, wrapped causes or abort reasons that
          // may contain the device UUID/credentials. A failed settings flush
          // must not erase cancellation or imply a credential rollback.
          if (interaction.signal?.aborted) {
            const cancellation = new Error('登录已取消；无法保存 Pi 安装设备 ID，请检查全局设置写入权限；凭据可能已保存，请刷新提供商状态确认')
            cancellation.name = 'AbortError'
            throw cancellation
          }
          throw new Error('无法保存 Pi 安装设备 ID，请检查全局设置写入权限后重试登录')
        }
      }
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
