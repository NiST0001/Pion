const padTimePart = (value: number): string => String(value).padStart(2, '0')

/** Local wall-clock time; missing/invalid source timestamps stay unknown. */
export function formatMessageTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return undefined

  const day = `${String(date.getFullYear()).padStart(4, '0')}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`
  const time = `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}:${padTimePart(date.getSeconds())}`
  return `${day} ${time}`
}

/** Whole elapsed seconds, truncated rather than rounded up. */
export function formatTurnDuration(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined
  if (durationMs < 1000) return '<1秒'

  const seconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${remainder ? `${remainder}秒` : ''}`
}
