import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AddModelProviderInput, ModelProviderApi } from '../shared/types'

const SUPPORTED_APIS = new Set<ModelProviderApi>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
])

interface JsonFile {
  exists: boolean
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
    return { exists: true, value }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, value: {} }
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
    const [modelsFile, authFile] = await Promise.all([
      readJsonFile(this.modelsPath, 'models.json'),
      readJsonFile(this.authPath, 'auth.json')
    ])
    const configuredProviders = modelsFile.value.providers
    if (configuredProviders !== undefined && !objectRecord(configuredProviders)) {
      throw new Error('models.json 的 providers 必须是 JSON 对象')
    }
    const providers = objectRecord(configuredProviders) ?? {}
    if (Object.prototype.hasOwnProperty.call(providers, input.providerId)) {
      throw new Error(`提供商 ${input.providerId} 已存在，请直接编辑 models.json`)
    }

    const models = input.modelIds.map((id) => ({
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
      ...(input.authHeader ? { authHeader: true } : {}),
      models
    }
    const nextModels: Record<string, unknown> = {
      ...modelsFile.value,
      providers: { ...providers, [input.providerId]: provider }
    }

    const existingCredential = authFile.value[input.providerId]
    const credential = input.apiKey
      ? { type: 'api_key', key: input.apiKey }
      : existingCredential ?? { type: 'api_key', key: 'pion-local' }
    const nextAuth: Record<string, unknown> = {
      ...authFile.value,
      [input.providerId]: credential
    }

    await writePrivateJson(this.authPath, nextAuth)
    try {
      await writePrivateJson(this.modelsPath, nextModels)
    } catch (error) {
      try {
        if (authFile.exists) await writePrivateJson(this.authPath, authFile.value)
        else await rm(this.authPath, { force: true })
      } catch {
        // Preserve the original write error; a later retry can repair credentials.
      }
      throw error
    }
  }
}
