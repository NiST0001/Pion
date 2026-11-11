import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertThemeSettingsOwner, ThemeSettingsStore } from '../../src/main/theme-settings'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('restricts theme access to the owning main frame', () => {
  const frame = {}
  const event = { sender: { id: 10, mainFrame: frame }, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent
  expect(() => assertThemeSettingsOwner(event, 10)).not.toThrow()
  expect(() => assertThemeSettingsOwner(event, 11)).toThrow()
  expect(() => assertThemeSettingsOwner(event, undefined)).toThrow()
  expect(() => assertThemeSettingsOwner({ ...event, senderFrame: {} as Electron.WebFrameMain }, 10)).toThrow()
})

it('restores the last theme in a new store and rejects invalid values without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-theme-'))
  roots.push(root)
  const path = join(root, 'pion-theme.json')
  const store = new ThemeSettingsStore(() => path)
  expect(await store.get()).toBeNull()
  await Promise.all([store.set('plain-dark'), store.set('plain-light')])
  expect(await new ThemeSettingsStore(() => path).get()).toBe('plain-light')
  for (const invalid of [null, {}, 'unknown', true]) expect(() => store.set(invalid)).toThrow()
  expect(JSON.parse(await readFile(path, 'utf8'))).toBe('plain-light')
  await writeFile(path, '{broken')
  await expect(store.get()).rejects.toThrow()
  await expect(store.set('terracotta-light')).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await writeFile(path, JSON.stringify('plain-light'))
  expect(await store.get()).toBe('plain-light')
  await store.set('terracotta-light')
  expect(await store.get()).toBe('terracotta-light')
})

it('persists division-dark across store instances without allowing unknown IDs to replace it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-theme-division-'))
  roots.push(root)
  const path = join(root, 'pion-theme.json')
  const store = new ThemeSettingsStore(() => path)
  await store.set('terracotta-dark')
  await expect(store.set('division-dark')).resolves.toBe('division-dark')
  const restored = new ThemeSettingsStore(() => path)
  expect(await restored.get()).toBe('division-dark')
  expect(() => restored.set('division-unknown')).toThrow('主题参数无效')
  expect(JSON.parse(await readFile(path, 'utf8'))).toBe('division-dark')
  await writeFile(path, JSON.stringify('division-unknown'))
  await expect(new ThemeSettingsStore(() => path).get()).rejects.toThrow('主题配置无效')
})

it('rechecks the owner before publication and drains accepted reads and saves on shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-theme-owner-'))
  roots.push(root)
  const path = join(root, 'pion-theme.json')
  const store = new ThemeSettingsStore(() => path)
  await store.set('plain-dark')
  let checks = 0
  await expect(store.set('plain-light', () => {
    if (++checks > 1) throw new Error('retired owner')
  })).rejects.toThrow('retired owner')
  expect(await store.get()).toBe('plain-dark')
  const prior = store.get()
  const saving = store.set('division-dark')
  const latest = store.get()
  const shutdown = store.shutdown()
  await expect(store.get()).rejects.toThrow('closed')
  await expect(store.set('plain-light')).rejects.toThrow('closed')
  expect(await prior).toBe('plain-dark')
  expect(await saving).toBe('division-dark')
  expect(await latest).toBe('division-dark')
  await shutdown
})
