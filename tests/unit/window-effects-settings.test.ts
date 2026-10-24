import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppSettings } from '../../src/main/app-settings'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }))
beforeEach(async () => { paths.userData = await mkdtemp(join(tmpdir(), 'pion-appearance-')) })
afterEach(async () => { await rm(paths.userData, { recursive: true, force: true }) })

it('keeps effects opt-in and persists them without discarding shell settings', async () => {
  const store = new AppSettings()
  await store.load()
  expect(store.windowEffectsEnabled).toBe(false)
  await store.setCompletionNotificationsEnabled(false)
  await store.setWindowEffectsEnabled(true)
  const restored = new AppSettings()
  await restored.load()
  expect(restored.windowEffectsEnabled).toBe(true)
  expect(restored.completionNotificationsEnabled).toBe(false)
  const persisted = JSON.parse(await readFile(join(paths.userData, 'pion-settings.json'), 'utf8'))
  expect(persisted.windowEffectsEnabled).toBe(true)
})

it('defaults background collection on and persists its switch without losing other settings', async () => {
  const store = new AppSettings()
  await store.load()
  expect(store.usageBackgroundCollectionEnabled).toBe(true)
  await store.setCompletionNotificationsEnabled(false)
  await store.setSessionModel('/project/session.jsonl', { provider: 'example', modelId: 'model' })
  await store.setUsageBackgroundCollectionEnabled(false)
  const restored = new AppSettings()
  await restored.load()
  expect(restored.usageBackgroundCollectionEnabled).toBe(false)
  expect(restored.completionNotificationsEnabled).toBe(false)
  expect(restored.getSessionModel('/project/session.jsonl')).toEqual({ provider: 'example', modelId: 'model' })
})

it('rolls back only the collection preference after a failed write', async () => {
  const store = new AppSettings()
  await store.setCompletionNotificationsEnabled(false)
  const path = join(paths.userData, 'pion-settings.json')
  await rm(path)
  await mkdir(path)
  await expect(store.setUsageBackgroundCollectionEnabled(false)).rejects.toThrow()
  expect(store.usageBackgroundCollectionEnabled).toBe(true)
  expect(store.completionNotificationsEnabled).toBe(false)
  await rm(path, { recursive: true })
  await store.setWindowEffectsEnabled(true)
  const restored = new AppSettings()
  await restored.load()
  expect(restored.usageBackgroundCollectionEnabled).toBe(true)
  expect(restored.completionNotificationsEnabled).toBe(false)
})

it.each([
  { firstFails: true, expected: true },
  { firstFails: false, expected: false }
])('serializes overlapping collection writes when firstFails=$firstFails', async ({ firstFails, expected }) => {
  const store = new AppSettings()
  await store.setCompletionNotificationsEnabled(false)
  await store.setWindowEffectsEnabled(true)
  await store.setSessionModel('/project/session.jsonl', { provider: 'example', modelId: 'model' })

  const persistence = store as unknown as { persist(): Promise<void> }
  const persist = persistence.persist.bind(store)
  let releaseFirst!: () => void
  let markStarted!: () => void
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const failure = new Error('controlled collection write failure')
  const spy = vi.spyOn(persistence, 'persist')
    .mockImplementationOnce(async () => {
      markStarted()
      await blocked
      if (firstFails) throw failure
      await persist()
    })
    .mockImplementationOnce(async () => {
      if (!firstFails) throw failure
      await persist()
    })

  const first = store.setUsageBackgroundCollectionEnabled(false)
  await started
  const second = store.setUsageBackgroundCollectionEnabled(true)
  const settled = Promise.allSettled([first, second])
  await Promise.resolve()
  expect(store.usageBackgroundCollectionEnabled).toBe(false)
  expect(spy).toHaveBeenCalledTimes(1)
  releaseFirst()
  const results = await settled
  expect(results).toEqual(firstFails
    ? [{ status: 'rejected', reason: failure }, { status: 'fulfilled', value: undefined }]
    : [{ status: 'fulfilled', value: undefined }, { status: 'rejected', reason: failure }])
  expect(spy).toHaveBeenCalledTimes(2)
  expect(store.usageBackgroundCollectionEnabled).toBe(expected)

  const restored = new AppSettings()
  await restored.load()
  for (const settings of [store, restored]) {
    expect(settings.usageBackgroundCollectionEnabled).toBe(expected)
    expect(settings.windowEffectsEnabled).toBe(true)
    expect(settings.completionNotificationsEnabled).toBe(false)
    expect(settings.getSessionModel('/project/session.jsonl')).toEqual({ provider: 'example', modelId: 'model' })
  }
  const persisted = JSON.parse(await readFile(join(paths.userData, 'pion-settings.json'), 'utf8'))
  expect(persisted.usageBackgroundCollectionEnabled).toBe(expected)
  spy.mockRestore()
})

it('ignores malformed background collection preferences', async () => {
  await writeFile(join(paths.userData, 'pion-settings.json'), JSON.stringify({ usageBackgroundCollectionEnabled: 'false' }))
  const store = new AppSettings()
  await store.load()
  expect(store.usageBackgroundCollectionEnabled).toBe(true)
})

it('ignores malformed transparency preferences', async () => {
  await writeFile(join(paths.userData, 'pion-settings.json'), JSON.stringify({ windowEffectsEnabled: 'yes' }))
  const store = new AppSettings()
  await store.load()
  expect(store.windowEffectsEnabled).toBe(false)
})
