import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { SubagentSettingsStore } from '../../src/main/subagent-settings'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof import('node:fs/promises').readFile>(),
  publish: vi.fn<(file: string, value: unknown) => Promise<void>>()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), readFile: mocks.read
}))
vi.mock('../../src/main/atomic-json-file', () => ({ writeAtomicJson: mocks.publish }))
let actualRead: typeof import('node:fs/promises').readFile
let publishJson: typeof import('../../src/main/atomic-json-file').writeAtomicJson
let root: string
let path: string
const selected = {
  ...DEFAULT_SUBAGENT_SETTINGS,
  defaultModel: { provider: 'exact-provider', id: 'exact-model' },
  defaultThinkingLevel: 'high'
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
beforeAll(async () => {
  ;({ readFile: actualRead } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
  ;({ writeAtomicJson: publishJson } = await vi.importActual<typeof import('../../src/main/atomic-json-file')>('../../src/main/atomic-json-file'))
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pion-subagent-settings-persistence-'))
  path = join(root, 'pion-subagents.json')
  mocks.read.mockReset().mockImplementation(actualRead)
  mocks.publish.mockReset().mockImplementation((file, value) => publishJson(file, value))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('restores exact saved model and thinking defaults in a fresh store without leaving staging files', async () => {
  const store = new SubagentSettingsStore(() => path)
  await expect(store.get()).resolves.toEqual(DEFAULT_SUBAGENT_SETTINGS)
  await store.set(selected)
  await store.shutdown()
  const reopened = new SubagentSettingsStore(() => path)
  await expect(reopened.get()).resolves.toEqual(selected)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(selected)
  expect(await readdir(root)).toEqual(['pion-subagents.json'])
})

it('retains legacy numeric values and inherits missing optional defaults without writing on read', async () => {
  const legacy = { maxParallel: 7, timeoutMinutes: 31, maxTurns: 53, maxResultChars: 18000 }
  const source = JSON.stringify(legacy)
  await writeFile(path, source)
  const store = new SubagentSettingsStore(() => path)
  await expect(store.get()).resolves.toMatchObject({ ...legacy, defaultModel: null, defaultThinkingLevel: null })
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('orders reads after accepted writes, snapshots input and drains all admitted work on shutdown', async () => {
  const blocked = deferred()
  const entered = deferred()
  mocks.publish.mockImplementationOnce(async (file, value) => {
    entered.resolve()
    await blocked.promise
    await publishJson(file, value)
  })
  const store = new SubagentSettingsStore(() => path)
  const input = { ...selected, defaultModel: { ...selected.defaultModel } }
  const first = store.set(input)
  input.defaultModel.id = 'mutated-before-publication'
  input.defaultThinkingLevel = 'low'
  await entered.promise
  const between = store.get()
  const last = { ...selected, maxParallel: 9 }
  const second = store.set(last)
  let drained = false
  const shutdown = store.shutdown().then(() => { drained = true })
  try {
    await expect(store.get()).rejects.toThrow('closed')
    await expect(store.set(selected)).rejects.toThrow('closed')
    expect(drained).toBe(false)
    expect(mocks.publish).toHaveBeenCalledTimes(1)
  } finally { blocked.resolve() }
  const [saved, observed] = await Promise.all([first, between, second, shutdown])
  expect(saved).toEqual(selected)
  expect(observed).toEqual(selected)
  saved.defaultModel!.id = 'mutated-return-value'
  await expect(new SubagentSettingsStore(() => path).get()).resolves.toEqual(last)
  expect(drained).toBe(true)
})

it('waits for an actual admitted read to finish before shutdown settles', async () => {
  await writeFile(path, JSON.stringify(selected))
  const blocked = deferred()
  const entered = deferred()
  mocks.read.mockImplementationOnce(async (...args) => {
    entered.resolve()
    await blocked.promise
    return actualRead(...args)
  })
  const store = new SubagentSettingsStore(() => path)
  const reading = store.get()
  await entered.promise
  let drained = false
  const shutdown = store.shutdown().then(() => { drained = true })
  try {
    await expect(store.get()).rejects.toThrow('closed')
    expect(drained).toBe(false)
  } finally { blocked.resolve() }
  await expect(reading).resolves.toEqual(selected)
  await shutdown
  expect(drained).toBe(true)
})

it.each(['{broken', 'null', JSON.stringify({ ...selected, maxParallel: 0 })])('preserves invalid source and rejects ordinary saves: %s', async (source) => {
  await writeFile(path, source)
  const store = new SubagentSettingsStore(() => path)
  await expect(store.get()).rejects.toThrow()
  await expect(store.set(DEFAULT_SUBAGENT_SETTINGS)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('preserves source on non-ENOENT read failures including permission denial', async () => {
  const source = JSON.stringify(selected)
  await writeFile(path, source)
  const failure = Object.assign(new Error('controlled permission denial'), { code: 'EACCES' })
  const store = new SubagentSettingsStore(() => path)
  mocks.read.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
  await expect(store.get()).rejects.toBe(failure)
  await expect(store.set(DEFAULT_SUBAGENT_SETTINGS)).rejects.toBe(failure)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('retains a prior valid configuration when publication fails and permits a later explicit save', async () => {
  const source = JSON.stringify(selected)
  await writeFile(path, source)
  const store = new SubagentSettingsStore(() => path)
  const failure = new Error('controlled publication failure')
  mocks.publish.mockRejectedValueOnce(failure)
  await expect(store.set(DEFAULT_SUBAGENT_SETTINGS)).rejects.toBe(failure)
  await expect(store.get()).resolves.toEqual(selected)
  expect(await readFile(path, 'utf8')).toBe(source)
  await store.set(DEFAULT_SUBAGENT_SETTINGS)
  await expect(new SubagentSettingsStore(() => path).get()).resolves.toEqual(DEFAULT_SUBAGENT_SETTINGS)
})
