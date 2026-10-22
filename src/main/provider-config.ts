import { CredentialSynchronizationError, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AddModelProviderInput, ModelProviderApi } from '../shared/types'

const SUPPORTED_APIS = new Set<ModelProviderApi>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
])

interface JsonFile {
  value: Record<string, unknown>
}

interface NormalizedProviderInput {
  providerId: string
  baseUrl: string
  api: ModelProviderApi
  apiKey: string
  modelIds: string[]
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  imageInput: boolean
  authHeader: boolean
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function readJsonFile(path: string, label: string): Promise<JsonFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const value = objectRecord(parsed)
    if (!value) throw new Error(`${label} 顶层必须是 JSON 对象`)
    return { value }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { value: {} }
    }
    if (error instanceof SyntaxError) throw new Error(`${label} 不是有效的 JSON`)
    throw error
  }
}

async function writePrivateJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function normalizeProviderInput(input: AddModelProviderInput): NormalizedProviderInput {
  if (!input || typeof input !== 'object') throw new Error('提供商配置无效')

  const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : ''
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)) {
    throw new Error('提供商 ID 仅支持小写字母、数字、点、短横线和下划线')
  }

  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (!baseUrl || baseUrl.length > 2048) throw new Error('请输入有效的 API 地址')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('API 地址必须是完整的 http:// 或 https:// URL')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('API 地址必须使用 http 或 https，且不能包含登录凭据')
  }
  if (parsedUrl.search || parsedUrl.hash) throw new Error('API 地址不能包含查询参数或片段')

  if (!SUPPORTED_APIS.has(input.api)) throw new Error('不支持的提供商 API 类型')

  if (!Array.isArray(input.modelIds)) throw new Error('至少需要一个模型 ID')
  const modelIds = [...new Set(input.modelIds.map((modelId) => (
    typeof modelId === 'string' ? modelId.trim() : ''
  )).filter(Boolean))]
  if (modelIds.length === 0) throw new Error('至少需要一个模型 ID')
  if (modelIds.length > 32) throw new Error('一次最多添加 32 个模型')
  for (const modelId of modelIds) {
    if (modelId.length > 200 || /[\s\u0000-\u001f\u007f]/.test(modelId)) {
      throw new Error(`模型 ID 无效：${modelId.slice(0, 40)}`)
    }
  }

  const contextWindow = Number(input.contextWindow)
  if (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000) {
    throw new Error('上下文窗口必须是 1,024–10,000,000 之间的整数')
  }
  const maxTokens = Number(input.maxTokens)
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > contextWindow) {
    throw new Error('最大输出必须是 256 以上且不超过上下文窗口的整数')
  }

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (apiKey.length > 16_384 || /[\r\n\u0000]/.test(apiKey)) {
    throw new Error('API 密钥格式无效')
  }

  return {
    providerId,
    baseUrl: baseUrl.replace(/\/$/, ''),
    api: input.api,
    apiKey,
    modelIds,
    contextWindow,
    maxTokens,
    reasoning: input.reasoning === true,
    imageInput: input.imageInput === true,
    authHeader: input.authHeader === true
  }
}

/** Persists custom Pi model providers without exposing credentials to the renderer again. */
export class ProviderConfigStore {
  readonly modelsPath: string
  readonly authPath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(agentDir: string) {
    const root = resolve(agentDir)
    this.modelsPath = join(root, 'models.json')
    this.authPath = join(root, 'auth.json')
  }

  async addProvider(input: AddModelProviderInput): Promise<void> {
    const normalized = normalizeProviderInput(input)
    const operation = this.writeQueue.then(() => this.addProviderNow(normalized))
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }

  private async addProviderNow(input: NormalizedProviderInput): Promise<void> {
    const modelsFile = await readJsonFile(this.modelsPath, 'models.json')
    const configuredProviders = modelsFile.value.providers
    if (configuredProviders !== undefined && !objectRecord(configuredProviders)) {
      throw new Error('models.json 的 providers 必须是 JSON 对象')
    }
    const providers = objectRecord(configuredProviders) ?? {}
    if (Object.prototype.hasOwnProperty.call(providers, input.providerId)) {
      throw new Error(`提供商 ${input.providerId} 已存在，请直接编辑 models.json`)
    }

    const models: NonNullable<Parameters<ModelRuntime['registerProvider']>[1]['models']> = input.modelIds.map((id) => ({
      id,
      name: id,
      reasoning: input.reasoning,
      input: input.imageInput ? ['text', 'image'] : ['text'],
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
    const provider = {
      baseUrl: input.baseUrl,
      api: input.api,
      // Pi resolves stored credentials before this non-secret local-server fallback.
      // Stored OAuth requires the provider's native OAuth handler; Pi does not
      // silently fall back when that handler is absent or token refresh fails.
      // An empty key must never replace an existing credential (including OAuth).
      ...(!input.apiKey ? { apiKey: 'pion-local' } : {}),
      ...(input.authHeader ? { authHeader: true } : {}),
      models
    }
    const nextModels: Record<string, unknown> = {
      ...modelsFile.value,
      providers: { ...providers, [input.providerId]: provider }
    }

    if (input.apiKey) {
      // Use only public SDK APIs. Pi owns credential locking/merging; Pion never
      // snapshots auth.json, so a concurrent login/refresh cannot be rolled back.
      let runtimeConfigDir: string | undefined
      try {
        // registerProvider starts a detached, all-provider availability refresh:
        // even offline that can execute unrelated stored !command credentials.
        // Load only this target's static config instead, then await login's scoped
        // synchronization. Neither user config nor unrelated credentials resolve.
        runtimeConfigDir = await mkdtemp(join(tmpdir(), 'pion-provider-login-'))
        const runtimeModelsPath = join(runtimeConfigDir, 'models.json')
        await writeFile(runtimeModelsPath, JSON.stringify({
          providers: { [input.providerId]: provider }
        }), { mode: 0o600 })
        const runtime = await ModelRuntime.create({
          authPath: this.authPath,
          modelsPath: runtimeModelsPath,
          // This one-shot static catalog has no remote cache to persist.
          modelsStore: {
            read: async () => undefined,
            write: async () => undefined,
            delete: async () => undefined
          },
          allowModelNetwork: false,
          refreshOnCreate: false
        })
        let prompted = false
        await runtime.login(input.providerId, 'api_key', {
          prompt: async (prompt) => {
            if (prompt.type !== 'secret' || prompted) {
              throw new Error('此提供商需要交互式认证，请使用提供商登录入口')
            }
            prompted = true
            return input.apiKey
          },
          notify: () => undefined
        })
      } catch (error) {
        // SDK synchronization errors carry the credential/cause. Do not leak
        // either through IPC, and never compensate by restoring old credentials.
        if (error instanceof CredentialSynchronizationError) {
          throw new Error('Pi 已保存凭据，但认证状态同步失败；models.json 未更新，请刷新提供商状态后重试')
        }
        throw new Error('Pi 凭据提交失败；models.json 未更新，凭据可能已保存，请检查 Pi 认证存储或使用提供商登录入口')
      } finally {
        if (runtimeConfigDir) await rm(runtimeConfigDir, { recursive: true, force: true })
      }
    }

    try {
      await writePrivateJson(this.modelsPath, nextModels)
    } catch (error) {
      if (!input.apiKey) throw error
      const detail = error instanceof Error ? error.message : '未知文件错误'
      throw new Error(`Pi 已保存凭据，但 models.json 写入失败；凭据未回滚，请检查配置后重试：${detail}`)
    }
  }
}
