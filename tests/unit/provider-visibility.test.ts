import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProviderVisibilityStore } from '../../src/main/provider-visibility'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; path: string; store: ProviderVisibilityStore }> {
  const root = await mkdtemp(join(tmpdir(), 'pion-provider-visibility-'))
  roots.push(root)
  const path = join(root, 'pion-provider-visibility.json')
  return { root, path, store: new ProviderVisibilityStore(path) }
}

it('shares the actual load promise and defaults to visible without saving a missing file', async () => {
  const { root, store } = await fixture()
  const loading = store.load()
  expect(store.load()).toBe(loading)
  await loading
  expect(store.load()).toBe(loading)
  expect(store.disabledProviderIds).toEqual([])
  const model = Object.freeze({ provider: 'openai', id: 'test-model' })
  const models = [model]
  const filtered = await store.filterModels(models)
  expect(filtered).toEqual(models)
  expect(filtered).not.toBe(models)
  expect(filtered[0]).toBe(model)
  expect(await store.projectProviders([{ id: 'openai' }])).toEqual([{ id: 'openai', enabled: true }])
  await store.setEnabled('openai', true)
  expect(await readdir(root)).toEqual([])
})

it('serializes concurrent changes, persists only disabled IDs, and restores them', async () => {
  const { path, store } = await fixture()
  await Promise.all([store.setEnabled('openai', false), store.setEnabled('anthropic', false), store.setEnabled('openai', true)])
  expect(store.disabledProviderIds).toEqual(['anthropic'])
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, disabledProviderIds: ['anthropic'] })
  const restored = new ProviderVisibilityStore(path)
  await restored.load()
  expect(restored.disabledProviderIds).toEqual(['anthropic'])
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
})

it('filters only model lists, keeps disabled catalog entries, and does not mutate inputs or snapshots', async () => {
  const { store } = await fixture()
  const change = store.setEnabled('openai-codex', false)
  const model = Object.freeze({ provider: 'openai-codex', id: 'model', extra: 7 })
  const models = [model, Object.freeze({ provider: 'custom-provider', id: 'other', extra: 8 })]
  const provider = Object.freeze({ id: 'openai-codex', authenticated: true })
  const projection = await store.projectProviders([provider])
  await change
  expect(projection).toEqual([{ ...provider, enabled: false }])
  expect(projection[0]).not.toBe(provider)
  expect(provider).toEqual({ id: 'openai-codex', authenticated: true })
  expect(await store.filterModels(models)).toEqual([models[1]])
  expect(models[0]).toBe(model)
  const snapshot = store.disabledProviderIds as string[]
  snapshot.length = 0
  expect(store.disabledProviderIds).toEqual(['openai-codex'])
})

it('folds duplicate IDs without normalizing their spelling or rewriting during load', async () => {
  const { path, store } = await fixture()
  const content = JSON.stringify({ version: 1, disabledProviderIds: ['constructor', 'openai', 'openai', 'a_b.c-d'] })
  await writeFile(path, content)
  await store.load()
  expect(store.disabledProviderIds).toEqual(['a_b.c-d', 'constructor', 'openai'])
  expect(await store.projectProviders([{ id: 'constructor' }, { id: 'toString' }, { id: '__proto__' }])).toEqual([
    { id: 'constructor', enabled: false }, { id: 'toString', enabled: true }, { id: '__proto__', enabled: true }
  ])
  expect(await readFile(path, 'utf8')).toBe(content)
})

it.each([
  '{broken', 'null', '[]', '{}',
  JSON.stringify({ version: 2, disabledProviderIds: [] }),
  JSON.stringify({ version: 1, disabledProviderIds: [], extra: true }),
  JSON.stringify({ version: 1, disabledProviderIds: {} }),
  JSON.stringify({ version: 1, disabledProviderIds: ['OpenAI'] }),
  JSON.stringify({ version: 1, disabledProviderIds: [' openai'] }),
  JSON.stringify({ version: 1, disabledProviderIds: ['openai\n'] }),
  JSON.stringify({ version: 1, disabledProviderIds: ['__proto__'] }),
  JSON.stringify({ version: 1, disabledProviderIds: ['a'.repeat(129)] }),
  JSON.stringify({ version: 1, disabledProviderIds: Array(257).fill('openai') })
])('rejects corrupt/schema-invalid records and never overwrites them: %s', async (content) => {
  const { path, store } = await fixture()
  await writeFile(path, content)
  const loading = store.load()
  await expect(loading).rejects.toThrow()
  expect(store.load()).toBe(loading)
  await expect(store.setEnabled('openai', false)).rejects.toThrow()
  await expect(store.filterModels([{ provider: 'openai' }])).rejects.toThrow()
  await expect(store.projectProviders([{ id: 'openai' }])).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(content)
  expect(store.getRevision()).toBe(0)
})

it('rejects files over 64 KiB before parsing, accepts the exact bound, and blocks writes after a failed read', async () => {
  const { path, store } = await fixture()
  const content = JSON.stringify({ version: 1, disabledProviderIds: [] }).padEnd(64 * 1024 + 1, ' ')
  await writeFile(path, content)
  await expect(store.load()).rejects.toThrow('64 KiB')
  await expect(store.setEnabled('openai', false)).rejects.toThrow('64 KiB')
  expect(await readFile(path, 'utf8')).toBe(content)
  await writeFile(path, content.slice(0, -1))
  await expect(store.setEnabled('openai', false)).rejects.toThrow('64 KiB')
  const fresh = new ProviderVisibilityStore(path)
  await fresh.load()
  expect(fresh.disabledProviderIds).toEqual([])
})

it('rejects invalid setter arguments before creating any files or normalizing IDs', async () => {
  const { root, store } = await fixture()
  for (const id of ['', 'OpenAI', ' openai', 'openai ', 'openai\n', '__proto__', '../auth', 'a'.repeat(129), null, {}, 5]) {
    await expect(store.setEnabled(id as string, false)).rejects.toThrow('参数无效')
  }
  for (const enabled of [null, undefined, 'false', 0, {}]) {
    await expect(store.setEnabled('openai', enabled as boolean)).rejects.toThrow('参数无效')
  }
  expect(await readdir(root)).toEqual([])
})

it('enforces the disabled-provider bound while allowing a disabled provider to be re-enabled', async () => {
  const { path, store } = await fixture()
  const ids = Array.from({ length: 256 }, (_, i) => `provider-${i}`)
  await writeFile(path, JSON.stringify({ version: 1, disabledProviderIds: ids }))
  await store.load()
  const revision = store.getRevision()
  await expect(store.setEnabled('another', false)).rejects.toThrow('上限')
  expect(store.getRevision()).toBe(revision)
  await store.setEnabled(ids[0], true)
  await store.setEnabled('another', false)
  expect(store.disabledProviderIds).toHaveLength(256)
})

it('retains committed state/revision on write failure, cleans only its temp, and lets the queue recover', async () => {
  const { root, path, store } = await fixture()
  await store.setEnabled('openai', false)
  const revision = store.getRevision()
  const original = await readFile(path, 'utf8')
  const backup = join(root, 'backup')
  await rename(path, backup)
  await mkdir(path)
  const unrelated = join(root, 'unrelated.tmp')
  await writeFile(unrelated, 'keep')
  await expect(store.setEnabled('anthropic', false)).rejects.toThrow()
  expect(store.disabledProviderIds).toEqual(['openai'])
  expect(store.getRevision()).toBe(revision)
  expect((await readdir(root)).sort()).toEqual(['backup', 'pion-provider-visibility.json', 'unrelated.tmp'])
  expect(await readFile(backup, 'utf8')).toBe(original)
  await rm(path, { recursive: true })
  await rename(backup, path)
  await store.setEnabled('anthropic', false)
  expect(store.disabledProviderIds).toEqual(['anthropic', 'openai'])
  expect(store.getRevision()).toBe(revision + 1)
})

it('rejects non-file settings and changes only the explicitly supplied Pion file, not neighboring SDK fixtures', async () => {
  const { root, path, store } = await fixture()
  await mkdir(path)
  await expect(store.load()).rejects.toThrow()
  await expect(store.setEnabled('openai', false)).rejects.toThrow()
  expect((await stat(path)).isDirectory()).toBe(true)
  await rm(path, { recursive: true })
  const authPath = join(root, 'auth.json')
  const modelsPath = join(root, 'models.json')
  await writeFile(authPath, 'not-json-auth-fixture')
  await writeFile(modelsPath, 'not-json-models-fixture')
  await new ProviderVisibilityStore(path).setEnabled('openai', false)
  expect(await readFile(authPath, 'utf8')).toBe('not-json-auth-fixture')
  expect(await readFile(modelsPath, 'utf8')).toBe('not-json-models-fixture')
})
