import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProviderConfigStore', () => {
  it('stores provider metadata separately from its private credential', async () => {
    const { root, store } = await fixture()
    await store.addProvider(providerInput())

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
    expect((await stat(join(root, 'models.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'auth.json'))).mode & 0o777).toBe(0o600)
  })

  it('uses a local placeholder credential when no key is supplied', async () => {
    const { root, store } = await fixture()
    await store.addProvider(providerInput({
      providerId: 'ollama',
      apiKey: '',
      modelIds: ['gemma3:4b'],
      imageInput: true
    }))

    const models = JSON.parse(await readFile(join(root, 'models.json'), 'utf8'))
    const auth = JSON.parse(await readFile(join(root, 'auth.json'), 'utf8'))
    expect(models.providers.ollama.models[0].input).toEqual(['text', 'image'])
    expect(auth.ollama).toEqual({ type: 'api_key', key: 'pion-local' })
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
