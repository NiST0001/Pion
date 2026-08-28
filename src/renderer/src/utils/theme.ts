/**
 * 主题色（accent）持久化与应用。
 * 存储 localStorage('pion:accent')，通过覆盖 CSS 变量生效。
 */

export type ThemeId = 'claude-dark' | 'claude-light'

export interface ThemeOption {
  id: ThemeId
  name: string
  description: string
}

export const THEMES: ThemeOption[] = [
  { id: 'claude-dark', name: 'Claude 深色', description: '暖黑背景，低干扰长时间工作' },
  { id: 'claude-light', name: 'Claude 浅色', description: '暖白纸张感，适合明亮环境' }
]

export interface AccentOption {
  name: string
  value: string
}

export const ACCENTS: AccentOption[] = [
  { name: '蓝', value: '#7aa2f7' },
  { name: '紫', value: '#bb9af7' },
  { name: '青', value: '#7dcfff' },
  { name: '绿', value: '#9ece6a' },
  { name: '琥珀', value: '#e0af68' },
  { name: '玫红', value: '#f7768e' }
]

const STORAGE_KEY = 'pion:accent'
const THEME_STORAGE_KEY = 'pion:theme'

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** 向白色混合提亮。 */
function lighten(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = clamp255(((n >> 16) & 0xff) + 255 * amount)
  const g = clamp255(((n >> 8) & 0xff) + 255 * amount)
  const b = clamp255((n & 0xff) + 255 * amount)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

function rgbValues(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `${r}, ${g}, ${b}`
}

function withAlpha(hex: string, alpha: number): string {
  return `rgba(${rgbValues(hex)}, ${alpha})`
}

export function applyAccent(hex: string): void {
  const root = document.documentElement
  root.style.setProperty('--accent', hex)
  root.style.setProperty('--accent-rgb', rgbValues(hex))
  root.style.setProperty('--accent-strong', lighten(hex, 0.14))
  root.style.setProperty('--accent-soft', withAlpha(hex, 0.13))
}

export function currentTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'claude-light' || stored === 'claude-dark' ? stored : 'claude-dark'
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme === 'claude-light' ? 'light' : 'dark'
}

export function saveTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme)
  applyTheme(theme)
}

/** 启动时恢复已保存的主题。 */
export function loadTheme(): void {
  applyTheme(currentTheme())
}

export function currentAccent(): string {
  return localStorage.getItem(STORAGE_KEY) ?? ACCENTS[0].value
}

export function saveAccent(hex: string): void {
  localStorage.setItem(STORAGE_KEY, hex)
  applyAccent(hex)
}

/** 启动时恢复已保存的主题色。 */
export function loadAccent(): void {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && ACCENTS.some((a) => a.value === stored)) {
    applyAccent(stored)
  }
}
