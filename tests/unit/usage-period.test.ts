import { describe, expect, it } from 'vitest'
import { cycleMonth, usageDayPeriod, usagePeriod, usageYearPeriod, validateUsageOverviewQuery } from '../../src/shared/usage-period'

describe('usage billing periods', () => {
  it('keeps no-argument compatibility and accepts only explicit month/day fields', () => {
    expect(validateUsageOverviewQuery(undefined)).toBeUndefined()
    expect(validateUsageOverviewQuery({})).toEqual({})
    expect(validateUsageOverviewQuery({ month: '2026-06', startDay: 31 })).toEqual({ month: '2026-06', startDay: 31 })
    for (const query of [null, [], '2026-06', { month: '2026-6' }, { month: '2026-13' }, { month: '26-06' }, { month: '2026-06\n' },
      { startDay: '1' }, { startDay: 0 }, { startDay: 32 }, { startDay: 1.5 }, { startDay: NaN }, { cwd: '/private' }]) {
      expect(() => validateUsageOverviewQuery(query)).toThrow()
    }
  })

  it('accepts one strict calendar selector and rejects invalid dates or conflicting selectors', () => {
    expect(validateUsageOverviewQuery({ year: '0000', startDay: 31 })).toEqual({ year: '0000', startDay: 31 })
    for (const date of ['0000-02-29', '0096-02-29', '2000-02-29', '2024-02-29', '2025-04-30']) {
      expect(validateUsageOverviewQuery({ date, startDay: 15 })).toEqual({ date, startDay: 15 })
    }
    for (const query of [{ year: 2024 }, { year: '024' }, { year: '2024\n' }, { year: '10000' },
      ...['2025-02-29', '1900-02-29', '2024-02-30', '2024-04-31', '2024-00-01', '2024-01-00',
        '2024-1-01', '2024-01-1', '2024-01-01\n'].map(date => ({ date })),
      { date: 20240101 }, { year: '2024', month: '2024-01' }, { year: '2024', date: '2024-01-01' },
      { month: '2024-01', date: '2024-01-01' }, { year: '2024', month: '2024-01', date: '2024-01-01' }]) {
      expect(() => validateUsageOverviewQuery(query)).toThrow()
    }
  })

  it('uses natural UTC years and days independently of the monthly start day', () => {
    const year = usageYearPeriod('2024', 31)
    expect(new Date(year.startAt).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(new Date(year.endAt).toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(year.endAt - year.startAt).toBe(366 * 86_400_000)
    const day = usageDayPeriod('2024-02-29', 31)
    expect(new Date(day.startAt).toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(new Date(day.endAt).toISOString()).toBe('2024-03-01T00:00:00.000Z')
    expect(new Date(usageYearPeriod('0000').startAt).toISOString()).toBe('0000-01-01T00:00:00.000Z')
    expect(new Date(usageYearPeriod('0099').endAt).toISOString()).toBe('0100-01-01T00:00:00.000Z')
    expect(new Date(usageDayPeriod('0099-12-31').endAt).toISOString()).toBe('0100-01-01T00:00:00.000Z')
    expect(() => usageYearPeriod('24')).toThrow()
    expect(() => usageDayPeriod('2025-02-29')).toThrow()
  })

  it('uses half-open UTC cycles and clamps each short month independently', () => {
    const period = usagePeriod('2024-01', 31)
    expect(new Date(period.startAt).toISOString()).toBe('2024-01-31T00:00:00.000Z')
    expect(new Date(period.endAt).toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(cycleMonth(period.startAt - 1, 31)).toBe('2023-12')
    expect(cycleMonth(period.startAt, 31)).toBe('2024-01')
    expect(cycleMonth(period.endAt - 1, 31)).toBe('2024-01')
    expect(cycleMonth(period.endAt, 31)).toBe('2024-02')
    expect(new Date(usagePeriod('2025-02', 31).startAt).toISOString()).toBe('2025-02-28T00:00:00.000Z')
    expect(new Date(usagePeriod('2025-02', 31).endAt).toISOString()).toBe('2025-03-31T00:00:00.000Z')
  })

  it('defaults to the first and preserves early years and year rollover', () => {
    expect(new Date(usagePeriod('0000-02').startAt).toISOString()).toBe('0000-02-01T00:00:00.000Z')
    expect(new Date(usagePeriod('0099-12', 15).endAt).toISOString()).toBe('0100-01-15T00:00:00.000Z')
    expect(cycleMonth(Date.parse('2026-01-14T23:59:59.999Z'), 15)).toBe('2025-12')
    expect(cycleMonth(Date.parse('2026-01-15T00:00:00.000Z'), 15)).toBe('2026-01')
  })
})
