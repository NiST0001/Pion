// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/types'
import type { ThemeId } from '../../src/shared/theme'

beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { pion?: unknown }).pion
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
  localStorage.clear()
})
function bridge() {
  const getTheme = vi.fn<() => Promise<ThemeId | null>>().mockResolvedValue(null)
  const setTheme = vi.fn<(theme: ThemeId) => Promise<ThemeId>>().mockImplementation(async (theme) => theme)
  window.pion = { getTheme, setTheme } as unknown as PionApi
  return { getTheme, setTheme }
}

it.each([null, 'terracotta-dark'])('restores durable theme with missing or stale cache (%s)', async (cached) => {
  const api = bridge()
  api.getTheme.mockResolvedValue('plain-light')
  if (cached) localStorage.setItem('pion:theme', cached)
  const theme = await import('../../src/renderer/src/utils/theme')
  await theme.loadTheme()
  expect(theme.currentTheme()).toBe('plain-light')
  expect(document.documentElement.dataset.theme).toBe('plain-light')
  expect(localStorage.getItem('pion:theme')).toBe('plain-light')
  expect(api.setTheme).not.toHaveBeenCalled()
})

it('migrates a valid legacy preference, but does not persist a fallback default', async () => {
  const api = bridge()
  const theme = await import('../../src/renderer/src/utils/theme')
  await theme.loadTheme()
  expect(api.setTheme).not.toHaveBeenCalled()
  localStorage.setItem('pion:theme', 'terracotta-light')
  vi.resetModules()
  await (await import('../../src/renderer/src/utils/theme')).loadTheme()
  expect(api.setTheme).toHaveBeenCalledWith('terracotta-light')
})

it('does not overwrite durable settings when startup reading fails', async () => {
  const api = bridge()
  api.getTheme.mockRejectedValue(new Error('unreadable'))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  localStorage.setItem('pion:theme', 'plain-dark')
  const theme = await import('../../src/renderer/src/utils/theme')
  await theme.loadTheme()
  expect(theme.currentTheme()).toBe('plain-dark')
  expect(api.setTheme).not.toHaveBeenCalled()
})

it('applies immediately and persists even if Chromium storage is unwritable', async () => {
  const api = bridge()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const theme = await import('../../src/renderer/src/utils/theme')
  const saved = theme.saveTheme('plain-light')
  expect(document.documentElement.dataset.theme).toBe('plain-light')
  await saved
  expect(api.setTheme).toHaveBeenCalledWith('plain-light')
  expect(theme.currentTheme()).toBe('plain-light')
})

it('does not let delayed restoration overwrite a newer user choice', async () => {
  const api = bridge()
  let resolve!: (value: ThemeId) => void
  api.getTheme.mockImplementation(() => new Promise<ThemeId | null>((done) => { resolve = done }))
  const theme = await import('../../src/renderer/src/utils/theme')
  const loading = theme.loadTheme()
  await theme.saveTheme('plain-light')
  resolve('terracotta-dark')
  await loading
  expect(theme.currentTheme()).toBe('plain-light')
  expect(localStorage.getItem('pion:theme')).toBe('plain-light')
})

it('reports failed saves and lets later selections retry in order', async () => {
  const api = bridge()
  api.setTheme.mockRejectedValueOnce(new Error('disk full'))
  const theme = await import('../../src/renderer/src/utils/theme')
  await expect(theme.saveTheme('plain-dark')).rejects.toThrow('disk full')
  await Promise.all([theme.saveTheme('terracotta-light'), theme.saveTheme('plain-light')])
  expect(api.setTheme.mock.calls.map(([value]) => value)).toEqual(['plain-dark', 'terracotta-light', 'plain-light'])
  expect(theme.currentTheme()).toBe('plain-light')
})
