export const DEFAULT_HISTORY_NAV_MAX_VISIBLE = 40
export const MIN_HISTORY_NAV_MAX_VISIBLE = 8
export const MAX_HISTORY_NAV_MAX_VISIBLE = 120

const STORAGE_KEY = 'pion:history-nav-max-visible'

export function normalizeHistoryNavMaxVisible(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_NAV_MAX_VISIBLE
  return Math.min(
    Math.max(Math.round(value), MIN_HISTORY_NAV_MAX_VISIBLE),
    MAX_HISTORY_NAV_MAX_VISIBLE
  )
}

export function readHistoryNavMaxVisible(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_HISTORY_NAV_MAX_VISIBLE
  const raw = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isInteger(raw)
    && raw >= MIN_HISTORY_NAV_MAX_VISIBLE
    && raw <= MAX_HISTORY_NAV_MAX_VISIBLE
    ? raw
    : DEFAULT_HISTORY_NAV_MAX_VISIBLE
}

export function saveHistoryNavMaxVisible(value: number): number {
  const normalized = normalizeHistoryNavMaxVisible(value)
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(normalized))
  return normalized
}
