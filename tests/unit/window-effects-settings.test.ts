import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

it('ignores malformed transparency preferences', async () => {
  await writeFile(join(paths.userData, 'pion-settings.json'), JSON.stringify({ windowEffectsEnabled: 'yes' }))
  const store = new AppSettings()
  await store.load()
  expect(store.windowEffectsEnabled).toBe(false)
})
