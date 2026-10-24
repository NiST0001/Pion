import type { UsageOverviewPeriod, UsageOverviewQuery } from './usage-overview'

export function validateUsageOverviewQuery(value: unknown): UsageOverviewQuery | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage overview query')
  const query = value as Record<string, unknown>
  if (Object.keys(query).some(key => !['year', 'month', 'date', 'startDay'].includes(key))
    || ['year', 'month', 'date'].filter(key => query[key] !== undefined).length > 1
    || (query.year !== undefined && (typeof query.year !== 'string' || query.year.length !== 4 || !/^\d{4}$/.test(query.year)))
    || (query.date !== undefined && !validDate(query.date))
    || (query.month !== undefined && (typeof query.month !== 'string' || query.month.length !== 7 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)))
    || (query.startDay !== undefined && (typeof query.startDay !== 'number' || !Number.isInteger(query.startDay) || query.startDay < 1 || query.startDay > 31))) {
    throw new Error('Invalid usage overview query')
  }
  return { ...(query.year !== undefined ? { year: query.year as string } : {}),
    ...(query.month !== undefined ? { month: query.month as string } : {}),
    ...(query.date !== undefined ? { date: query.date as string } : {}),
    ...(query.startDay !== undefined ? { startDay: query.startDay as number } : {}) }
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return new Date(boundary(year, month - 1, day)).getUTCDate() === day
}

function boundary(year: number, month: number, day: number): number {
  // setUTCFullYear preserves years 0000–0099, unlike Date.UTC.
  const date = new Date(0)
  date.setUTCFullYear(year, month + 1, 0)
  const lastDay = date.getUTCDate()
  date.setUTCFullYear(year, month, Math.min(day, lastDay))
  return date.getTime()
}

export function usagePeriod(month: string, startDay = 1): UsageOverviewPeriod {
  validateUsageOverviewQuery({ month, startDay })
  const [year, index] = month.split('-').map(Number)
  return { month, startDay, startAt: boundary(year, index - 1, startDay), endAt: boundary(year, index, startDay) }
}

export function usageYearPeriod(year: string, startDay = 1): UsageOverviewPeriod {
  validateUsageOverviewQuery({ year, startDay })
  return { year, startDay, startAt: boundary(Number(year), 0, 1), endAt: boundary(Number(year) + 1, 0, 1) }
}

export function usageDayPeriod(date: string, startDay = 1): UsageOverviewPeriod {
  validateUsageOverviewQuery({ date, startDay })
  const [year, month, day] = date.split('-').map(Number)
  const startAt = boundary(year, month - 1, day)
  return { date, startDay, startAt, endAt: startAt + 86_400_000 }
}

export function cycleMonth(at: number, startDay = 1): string {
  const date = new Date(at)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  if (at < boundary(year, month, startDay)) date.setUTCFullYear(year, month - 1, 1)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}
