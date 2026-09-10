export const THEME_IDS = ['terracotta-dark', 'terracotta-light', 'plain-dark', 'plain-light'] as const
export type ThemeId = typeof THEME_IDS[number]
export const DEFAULT_THEME: ThemeId = 'terracotta-dark'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.includes(value as ThemeId)
}
