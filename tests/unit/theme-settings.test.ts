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
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await store.set('terracotta-light')
  expect(await store.get()).toBe('terracotta-light')
})

it('limits installer sync deletion to generated directories, not the application root', async () => {
  // Source contract only; do not run installation from a unit test.
  const script = await readFile('scripts/install-local.sh', 'utf8')
  expect(script).toContain('rsync -a --delete out/ "$APP_DIR/out/"')
  expect(script).toContain('rsync -a --delete node_modules/ "$APP_DIR/node_modules/"')
  expect(script).not.toMatch(/rsync[^\n]*--delete[^\n]*"\$APP_DIR\/"/)
})
