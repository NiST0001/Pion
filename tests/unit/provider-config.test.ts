import { CredentialSynchronizationError, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderConfigStore } from '../../src/main/provider-config'
import type { AddModelProviderInput } from '../../src/shared/types'

const roots: string[] = []

function providerInput(overrides: Partial<AddModelProviderInput> = {}): AddModelProviderInput {
  return {
    providerId: 'local-openai',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    apiKey: 'secret-provider-key',
    modelIds: ['qwen2.5-coder:7b', 'llama3.1:8b'],
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: true,
    imageInput: false,
    authHeader: false,
    ...overrides
  }
}

async function fixture(): Promise<{ root: string; store: ProviderConfigStore }> {
  const root = await mkdtemp(join(tmpdir(), 'pion-provider-config-'))
  roots.push(root)
  return { root, store: new ProviderConfigStore(root) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProviderConfigStore', () => {
  it('stores provider metadata separately from its private credential', async () => {
    const { root, store } = await fixture()
    const create = vi.spyOn(ModelRuntime, 'create')
    const register = vi.spyOn(ModelRuntime.prototype, 'registerProvider')
    const login = vi.spyOn(ModelRuntime.prototype, 'login')
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))
    // Even an expired unrelated OAuth credential must not trigger any refresh.
    const expiredOAuth = { type: 'oauth', access: 'expired', refresh: 'must-not-refresh', expires: 1 }
    await writeFile(store.authPath, JSON.stringify({ 'openai-codex': expiredOAuth }), { mode: 0o600 })
    await store.addProvider(providerInput())

    expect(fetch).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()

    expect(create).toHaveBeenCalledWith({
      authPath: join(root, 'auth.json'),
      modelsPath: expect.any(String),
      modelsStore: { read: expect.any(Function), write: expect.any(Function), delete: expect.any(Function) },
      allowModelNetwork: false,
      refreshOnCreate: false
    })
    const temporaryModelsPath = create.mock.calls[0][0]?.modelsPath as string
    expect(temporaryModelsPath).not.toBe(store.modelsPath)
    await expect(stat(dirname(temporaryModelsPath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(login).toHaveBeenCalledWith('local-openai', 'api_key', {
      prompt: expect.any(Function), notify: expect.any(Function)
    })
    const modelsText = await readFile(join(root, 'models.json'), 'utf8')
    const authText = await readFile(join(root, 'auth.json'), 'utf8')
    const models = JSON.parse(modelsText)
    const auth = JSON.parse(authText)

    expect(models.providers['local-openai']).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [
        { id: 'qwen2.5-coder:7b', reasoning: true, input: ['text'] },
        { id: 'llama3.1:8b', reasoning: true, input: ['text'] }
      ]
    })
    expect(modelsText).not.toContain('secret-provider-key')
    expect(auth['local-openai']).toEqual({ type: 'api_key', key: 'secret-provider-key' })
    expect(auth['openai-codex']).toEqual(expiredOAuth)
    // POSIX 权限位断言仅在不做权限模拟的系统上成立；Windows 的 chmod 是空操作
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'models.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(root, 'auth.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('never executes unrelated stored or configured !command credentials during target login', async () => {
    const { root, store } = await fixture()
    const marker = join(root, 'unrelated-command-executed')
    const encodedMarker = Buffer.from(marker).toString('hex')
    const command = `!"${process.execPath}" -e "require('node:fs').writeFileSync(Buffer.from('${encodedMarker}', 'hex').toString(), 'executed')"`
    const credentials = {
      anthropic: { type: 'api_key', key: command },
      unrelated: { type: 'api_key', key: command }
    }
    await writeFile(store.authPath, JSON.stringify(credentials))
    await writeFile(store.modelsPath, JSON.stringify({
      providers: { unrelated: { apiKey: command, baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' } }
    }))
    const originalCreate = ModelRuntime.create
    let temporaryPath: string | undefined
    vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
      temporaryPath = options?.modelsPath as string
      const config = JSON.parse(await readFile(temporaryPath, 'utf8'))
      expect(Object.keys(config.providers)).toEqual(['local-openai'])
      expect(await readFile(temporaryPath, 'utf8')).not.toContain('secret-provider-key')
      if (process.platform !== 'win32') {
        expect((await stat(temporaryPath)).mode & 0o777).toBe(0o600)
      }
      return originalCreate(options)
    })
    const register = vi.spyOn(ModelRuntime.prototype, 'registerProvider')
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))

    await store.addProvider(providerInput())

    expect(register).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(temporaryPath!))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(store.authPath, 'utf8'))).toEqual({
      ...credentials, 'local-openai': { type: 'api_key', key: 'secret-provider-key' }
    })
  })

  it('uses a models.json fallback without creating credentials when no key is supplied', async () => {
    const { root, store } = await fixture()
    const login = vi.spyOn(ModelRuntime.prototype, 'login')
    await store.addProvider(providerInput({
      providerId: 'ollama',
      apiKey: '',
      modelIds: ['gemma3:4b'],
      imageInput: true
    }))

    const models = JSON.parse(await readFile(join(root, 'models.json'), 'utf8'))
    expect(models.providers.ollama.models[0].input).toEqual(['text', 'image'])
    expect(models.providers.ollama.apiKey).toBe('pion-local')
    await expect(readFile(join(root, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(login).not.toHaveBeenCalled()
  })

  it('does not read, migrate or replace existing credentials on empty-key configuration', async () => {
    const { root, store } = await fixture()
    const authPath = join(root, 'auth.json')
    // Even malformed storage is Pi-owned; adding metadata must not rewrite it.
    const original = '{ opaque Pi credential storage'
    await writeFile(authPath, original)
    await store.addProvider(providerInput({ apiKey: '' }))
    expect(await readFile(authPath, 'utf8')).toBe(original)
  })

  it('resolves existing supported OAuth before the empty-key fallback through the native SDK', async () => {
    const { store } = await fixture()
    const oauth = { type: 'oauth', access: 'existing-oauth-access', refresh: 'refresh', expires: 9999999999999 }
    await writeFile(store.authPath, JSON.stringify({ 'openai-codex': oauth }))
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))
    await store.addProvider(providerInput({ providerId: 'openai-codex', apiKey: '' }))
    const runtime = await ModelRuntime.create({
      authPath: store.authPath, modelsPath: store.modelsPath,
      allowModelNetwork: false, refreshOnCreate: false
    })

    await expect(runtime.checkAuth('openai-codex')).resolves.toMatchObject({ type: 'oauth' })
    await expect(runtime.getAuth('openai-codex')).resolves.toMatchObject({
      source: 'OAuth', auth: { apiKey: 'existing-oauth-access' }
    })
    expect(JSON.parse(await readFile(store.authPath, 'utf8'))['openai-codex']).toEqual(oauth)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not silently use the fallback when stored OAuth has no native handler', async () => {
    const { store } = await fixture()
    const oauth = { type: 'oauth', access: 'access', refresh: 'refresh', expires: 9999999999999 }
    await writeFile(store.authPath, JSON.stringify({ 'local-openai': oauth }))
    await store.addProvider(providerInput({ apiKey: '' }))
    const runtime = await ModelRuntime.create({
      authPath: store.authPath, modelsPath: store.modelsPath,
      allowModelNetwork: false, refreshOnCreate: false
    })

    await expect(runtime.checkAuth('local-openai')).resolves.toBeUndefined()
    await expect(runtime.getAuth('local-openai')).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(store.authPath, 'utf8'))['local-openai']).toEqual(oauth)
  })

  it('preserves existing OAuth and a concurrent native credential mutation', async () => {
    const { root, store } = await fixture()
    const oauth = { type: 'oauth', access: 'access', refresh: 'refresh', expires: 9999999999999 }
    await writeFile(store.authPath, JSON.stringify({ existing: oauth }))
    const concurrentModelsPath = join(root, 'concurrent-models.json')
    await writeFile(concurrentModelsPath, JSON.stringify({ providers: { concurrent: {
      api: 'openai-completions', baseUrl: 'http://localhost:11434/v1',
      models: [{
        id: 'other-model', name: 'other-model', reasoning: false, input: ['text'],
        contextWindow: 128000, maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }]
    } } }))
    const other = await ModelRuntime.create({
      authPath: store.authPath, modelsPath: concurrentModelsPath,
      allowModelNetwork: false, refreshOnCreate: false
    })
    await Promise.all([
      store.addProvider(providerInput()),
      other.login('concurrent', 'api_key', {
        prompt: async () => 'concurrent-secret', notify: () => undefined
      })
    ])
    expect(JSON.parse(await readFile(store.authPath, 'utf8'))).toEqual({
      existing: oauth,
      concurrent: { type: 'api_key', key: 'concurrent-secret' },
      'local-openai': { type: 'api_key', key: 'secret-provider-key' }
    })
  })

  it('leaves credentials intact when models.json publication fails after native login', async () => {
    const { root, store } = await fixture()
    const login = ModelRuntime.prototype.login
    vi.spyOn(ModelRuntime.prototype, 'login').mockImplementation(async function (this: ModelRuntime, ...args) {
      const credential = await login.apply(this, args)
      const auth = JSON.parse(await readFile(store.authPath, 'utf8'))
      auth.concurrent = { type: 'api_key', key: 'newer-concurrent-key' }
      await writeFile(store.authPath, JSON.stringify(auth))
      await mkdir(join(root, 'models.json'))
      return credential
    })
    await expect(store.addProvider(providerInput())).rejects.toThrow('凭据未回滚')
    expect(JSON.parse(await readFile(store.authPath, 'utf8'))).toEqual({
      'local-openai': { type: 'api_key', key: 'secret-provider-key' },
      concurrent: { type: 'api_key', key: 'newer-concurrent-key' }
    })
  })

  it('does not publish model metadata or leak SDK credential errors on failed login', async () => {
    const { root, store } = await fixture()
    const create = vi.spyOn(ModelRuntime, 'create')
    vi.spyOn(ModelRuntime.prototype, 'login').mockRejectedValue(new Error('secret-provider-key'))
    const result = store.addProvider(providerInput())
    await expect(result).rejects.toThrow('Pi 凭据提交失败')
    await expect(result).rejects.not.toThrow('secret-provider-key')
    await expect(readFile(join(root, 'models.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(create.mock.calls[0][0]?.modelsPath as string))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans up the private config when runtime creation fails', async () => {
    const { store } = await fixture()
    let temporaryPath: string | undefined
    vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
      temporaryPath = options?.modelsPath as string
      await expect(stat(temporaryPath)).resolves.toBeDefined()
      throw new Error('runtime initialization failed')
    })

    await expect(store.addProvider(providerInput())).rejects.toThrow('Pi 凭据提交失败')
    await expect(stat(dirname(temporaryPath!))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(store.authPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(store.modelsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports committed-but-unsynchronized credentials without rollback or leaking secrets', async () => {
    const { root, store } = await fixture()
    const create = vi.spyOn(ModelRuntime, 'create')
    const login = ModelRuntime.prototype.login
    vi.spyOn(ModelRuntime.prototype, 'login').mockImplementation(async function (this: ModelRuntime, ...args) {
      const credential = await login.apply(this, args)
      throw new CredentialSynchronizationError(args[0], 'login', credential, {
        cause: new Error('secret-provider-key')
      })
    })
    const result = store.addProvider(providerInput())
    await expect(result).rejects.toThrow('Pi 已保存凭据，但认证状态同步失败')
    await expect(result).rejects.not.toThrow('secret-provider-key')
    await expect(readFile(join(root, 'models.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(store.authPath, 'utf8'))['local-openai'])
      .toEqual({ type: 'api_key', key: 'secret-provider-key' })
    await expect(stat(dirname(create.mock.calls[0][0]?.modelsPath as string))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects duplicate providers and invalid endpoints without overwriting files', async () => {
    const { root, store } = await fixture()
    await store.addProvider(providerInput())
    const before = await readFile(join(root, 'models.json'), 'utf8')

    await expect(store.addProvider(providerInput({ modelIds: ['replacement'] })))
      .rejects.toThrow('已存在')
    await expect(store.addProvider(providerInput({
      providerId: 'another-provider',
      baseUrl: 'file:///tmp/provider'
    }))).rejects.toThrow('http 或 https')

    expect(await readFile(join(root, 'models.json'), 'utf8')).toBe(before)
  })
})
