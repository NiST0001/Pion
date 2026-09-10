/**
 * 工作台主题的本地持久化与应用。
 * 每套主题统一定义表面、文字层级、重点色和语义状态颜色。
 */

import { DEFAULT_THEME, isThemeId, type ThemeId } from '../../../shared/theme'
export type { ThemeId } from '../../../shared/theme'

export interface ThemeOption {
  id: ThemeId
  name: string
  description: string
}

export const THEMES: ThemeOption[] = [
  { id: 'terracotta-dark', name: '陶土深色', description: '暖黑背景，低干扰长时间工作' },
  { id: 'terracotta-light', name: '陶土浅色', description: '暖白纸张感，适合明亮环境' },
  { id: 'plain-dark', name: '深色', description: '近黑表面与白色重点操作' },
  { id: 'plain-light', name: '浅色', description: '纯白表面与黑色重点操作' }
]

const THEME_STORAGE_KEY = 'pion:theme'
let activeTheme: ThemeId | undefined
let revision = 0
let writes: Promise<unknown> = Promise.resolve()

function cachedTheme(): ThemeId | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeId(stored) ? stored : null
  } catch { return null }
}

function cacheTheme(theme: ThemeId): void {
  try { localStorage.setItem(THEME_STORAGE_KEY, theme) }
  catch (error) { console.warn('[pion] 主题缓存不可写，仍将保存用户配置', error) }
}

export function currentTheme(): ThemeId {
  return activeTheme ?? cachedTheme() ?? DEFAULT_THEME
}

export function applyTheme(theme: ThemeId): void {
  activeTheme = theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme.endsWith('-light') ? 'light' : 'dark'
}

function persistTheme(theme: ThemeId): Promise<void> {
  const api = window.pion
  // Compatibility for a standalone renderer or an older preload during development.
  if (typeof api?.setTheme !== 'function') return Promise.resolve()
  const write = writes.catch(() => undefined).then(async () => { await api.setTheme(theme) })
  writes = write
  return write
}

export function saveTheme(theme: ThemeId): Promise<void> {
  revision += 1
  cacheTheme(theme)
  applyTheme(theme)
  return persistTheme(theme)
}

/** The user-data file is authoritative; localStorage is only a cache/migration source. */
export async function loadTheme(): Promise<void> {
  const startRevision = revision
  const legacy = cachedTheme()
  applyTheme(currentTheme())
  const api = window.pion
  if (typeof api?.getTheme !== 'function') return
  try {
    const saved = await api.getTheme()
    if (revision !== startRevision) return
    if (isThemeId(saved)) {
      cacheTheme(saved)
      applyTheme(saved)
    } else if (saved === null) {
      // Never persist a fallback default over a missing/failed read.
      if (legacy) await persistTheme(legacy)
    } else throw new Error('主题配置无效')
  } catch (error) { console.error('[pion] 无法恢复主题用户配置，保留本地外观', error) }
}
