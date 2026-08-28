/**
 * 陶土主题的本地持久化与应用。
 * 主题会统一改变工作台的整体配色、背景、边框和文字层级。
 */

export type ThemeId = 'terracotta-dark' | 'terracotta-light'

export interface ThemeOption {
  id: ThemeId
  name: string
  description: string
}

export const THEMES: ThemeOption[] = [
  { id: 'terracotta-dark', name: '陶土深色', description: '暖黑背景，低干扰长时间工作' },
  { id: 'terracotta-light', name: '陶土浅色', description: '暖白纸张感，适合明亮环境' }
]

const THEME_STORAGE_KEY = 'pion:theme'

export function currentTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'terracotta-light' || stored === 'terracotta-dark' ? stored : 'terracotta-dark'
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme === 'terracotta-light' ? 'light' : 'dark'
}

export function saveTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme)
  applyTheme(theme)
}

/** 启动时恢复已保存的主题。 */
export function loadTheme(): void {
  applyTheme(currentTheme())
}
