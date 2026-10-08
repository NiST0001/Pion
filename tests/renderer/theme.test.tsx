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

it('registers division-dark alongside the original themes without changing the default', async () => {
  const { THEME_IDS, DEFAULT_THEME, isThemeId } = await import('../../src/shared/theme')
  const { THEMES, currentTheme } = await import('../../src/renderer/src/utils/theme')
  expect(THEME_IDS).toEqual(['terracotta-dark', 'terracotta-light', 'plain-dark', 'plain-light', 'division-dark'])
  expect(THEMES.map(({ id }) => id)).toEqual(THEME_IDS)
  expect(THEMES.find(({ id }) => id === 'division-dark')).toEqual({
    id: 'division-dark', name: '信号橙', description: '中性炭灰与明亮橙色，战术终端风格'
  })
  expect(DEFAULT_THEME).toBe('terracotta-dark')
  expect(currentTheme()).toBe(DEFAULT_THEME)
  expect(isThemeId('division-dark')).toBe(true)
  expect(isThemeId('division-unknown')).toBe(false)
})

it('saves and restores division-dark as a dark theme across renderer instances', async () => {
  const api = bridge()
  const theme = await import('../../src/renderer/src/utils/theme')
  await theme.saveTheme('division-dark')
  expect(theme.currentTheme()).toBe('division-dark')
  expect(document.documentElement.dataset.theme).toBe('division-dark')
  expect(document.documentElement.style.colorScheme).toBe('dark')
  expect(localStorage.getItem('pion:theme')).toBe('division-dark')
  expect(api.setTheme).toHaveBeenCalledExactlyOnceWith('division-dark')

  vi.resetModules()
  localStorage.setItem('pion:theme', 'plain-light')
  api.getTheme.mockResolvedValue('division-dark')
  const restored = await import('../../src/renderer/src/utils/theme')
  await restored.loadTheme()
  expect(restored.currentTheme()).toBe('division-dark')
  expect(document.documentElement.dataset.theme).toBe('division-dark')
  expect(document.documentElement.style.colorScheme).toBe('dark')
  expect(localStorage.getItem('pion:theme')).toBe('division-dark')
  expect(api.setTheme).toHaveBeenCalledTimes(1)
})

it('ignores unknown cached theme IDs without persisting a fallback', async () => {
  const api = bridge()
  localStorage.setItem('pion:theme', 'division-unknown')
  const theme = await import('../../src/renderer/src/utils/theme')
  await theme.loadTheme()
  expect(theme.currentTheme()).toBe('terracotta-dark')
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

it.each(['plain-light', 'division-dark'] as const)('does not let delayed restoration overwrite a newer user choice (%s)', async (selected) => {
  const api = bridge()
  let resolve!: (value: ThemeId) => void
  api.getTheme.mockImplementation(() => new Promise<ThemeId | null>((done) => { resolve = done }))
  const theme = await import('../../src/renderer/src/utils/theme')
  const loading = theme.loadTheme()
  await theme.saveTheme(selected)
  resolve('terracotta-dark')
  await loading
  expect(theme.currentTheme()).toBe(selected)
  expect(document.documentElement.dataset.theme).toBe(selected)
  expect(localStorage.getItem('pion:theme')).toBe(selected)
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
