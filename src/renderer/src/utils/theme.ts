/**
 * 工作台主题的本地持久化与应用。
 * 每套主题统一定义表面、文字层级、重点色和语义状态颜色。
 */

export type ThemeId =
  | 'terracotta-dark'
  | 'terracotta-light'
  | 'plain-dark'
  | 'plain-light'

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
const THEME_IDS = new Set<ThemeId>(THEMES.map((theme) => theme.id))

export function currentTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null
  return stored && THEME_IDS.has(stored) ? stored : 'terracotta-dark'
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme.endsWith('-light') ? 'light' : 'dark'
}

export function saveTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme)
  applyTheme(theme)
}

/** 启动时恢复已保存的主题。 */
export function loadTheme(): void {
  applyTheme(currentTheme())
}
