// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/pion-api'
import type { UsageOverview, UsageOverviewQuery } from '../../src/shared/usage-overview'
import { usageDayPeriod, usagePeriod, usageYearPeriod } from '../../src/shared/usage-period'
import { useUsageOverview } from '../../src/renderer/src/features/operations/useUsageOverview'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function snapshot(selection: string | UsageOverviewQuery, startDay = 1, revision = 1): UsageOverview {
  const query = typeof selection === 'string' ? { month: selection, startDay } : selection
  const day = query.startDay ?? 1
  const period = query.year ? usageYearPeriod(query.year, day)
    : query.date ? usageDayPeriod(query.date, day) : usagePeriod(query.month!, day)
  return {
    revision, collectedAt: Date.UTC(2026, 9, 23), firstRecordAt: null,
    totals: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3, costUsd: 0.01 },
    sessions: 1, projects: 1, records: 1, byProject: [], byModel: [], daily: [],
    period, availableMonths: query.month ? [query.month] : [],
    coverage: { discoveredSessions: 1, collectedSessions: 1, unavailableSessions: 0, unresolvedSessions: 0, limitReached: false },
    warnings: []
  }
}

const A: UsageOverviewQuery = { month: '2026-01', startDay: 1 }
const B: UsageOverviewQuery = { month: '2026-02', startDay: 1 }
const C: UsageOverviewQuery = { month: '2026-03', startDay: 1 }
const apiFor = (getter: PionApi['getUsageOverview']): PionApi => ({ getUsageOverview: getter }) as PionApi
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

afterEach(cleanup)

describe('useUsageOverview period selection and real IPC reservation', () => {
  it('coalesces pending A → B → C into one latest C read only after A settles, never publishing A as C', async () => {
    const old = deferred<UsageOverview>()
    const latest = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), { initialProps: { query: A } })
    await flush()
    rerender({ query: B })
    await flush()
    rerender({ query: C })
    await flush()
    act(() => { result.current.refresh(); result.current.refresh() })
    expect(getter.mock.calls).toEqual([[A]])
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeUndefined()

    await act(async () => { old.resolve(snapshot('2026-01')) })
    expect(getter.mock.calls).toEqual([[A], [C]])
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)
    const data = snapshot('2026-03', 1, 2)
    await act(async () => { latest.resolve(data) })
    expect(result.current.data).toBe(data)
    expect(result.current.loading).toBe(false)
    await flush()
    expect(getter).toHaveBeenCalledTimes(2)
  })

  it('coalesces year → month → date behind the actual pending year and ignores equal rebuilt queries', async () => {
    const year: UsageOverviewQuery = { year: '2026', startDay: 1 }
    const date: UsageOverviewQuery = { date: '2026-03-15', startDay: 1 }
    const old = deferred<UsageOverview>()
    const latest = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), { initialProps: { query: year } })
    await flush()
    rerender({ query: { ...year } })
    await flush()
    rerender({ query: B })
    await flush()
    rerender({ query: date })
    await flush()
    rerender({ query: { ...date } })
    await flush()
    expect(getter.mock.calls).toEqual([[year]])
    expect(result.current.loading).toBe(true)
    await act(async () => { old.resolve(snapshot(year)) })
    expect(getter.mock.calls).toEqual([[year], [date]])
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)
    const data = snapshot(date, 1, 2)
    await act(async () => { latest.resolve(data) })
    expect(result.current.data).toBe(data)
    expect(result.current.data?.period).toEqual(usageDayPeriod('2026-03-15'))
    expect(result.current.loading).toBe(false)
    rerender({ query: { ...date } })
    await flush()
    expect(getter.mock.calls).toEqual([[year], [date]])
  })

  it('distinguishes different year values when returning from month to the year field', async () => {
    const year: UsageOverviewQuery = { year: '2026', startDay: 1 }
    const previousYear: UsageOverviewQuery = { year: '2025', startDay: 1 }
    const old = deferred<UsageOverview>()
    const latest = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), { initialProps: { query: year } })
    await flush()
    rerender({ query: B })
    await flush()
    rerender({ query: previousYear })
    await flush()
    expect(getter.mock.calls).toEqual([[year]])
    await act(async () => { old.resolve(snapshot(year)) })
    expect(result.current.data).toBeUndefined()
    expect(getter.mock.calls).toEqual([[year], [previousYear]])
    const data = snapshot(previousYear, 1, 2)
    await act(async () => { latest.resolve(data) })
    expect(result.current.data).toBe(data)
    expect(result.current.data?.period).toEqual(usageYearPeriod('2025'))
    rerender({ query: { ...previousYear } })
    await flush()
    expect(getter).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ year: '2026', startDay: 1 }, { date: '2026-03-15', startDay: 1 }],
    [{ date: '2026-03-15', startDay: 1 }, { year: '2025', startDay: 1 }]
  ] satisfies [UsageOverviewQuery, UsageOverviewQuery][])('keeps the actual successful period for %j when %j fails', async (query, failedQuery) => {
    const data = snapshot(query)
    const next = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockResolvedValueOnce(data).mockReturnValueOnce(next.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), { initialProps: { query } })
    await flush()
    rerender({ query: failedQuery })
    await flush()
    expect(result.current.data).toBe(data)
    expect(result.current.loading).toBe(true)
    await act(async () => { next.reject(new Error('private failure')) })
    expect(result.current.data).toBe(data)
    expect(result.current.data?.period).toEqual(data.period)
    expect(result.current.error).toContain('已保留上次成功快照')
    expect(result.current.loading).toBe(false)
    expect(getter.mock.calls).toEqual([[query], [failedQuery]])
  })

  it('retires the first selection in A → B → A even when the final query is the same object', async () => {
    const old = deferred<UsageOverview>()
    const fresh = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), { initialProps: { query: A } })
    await flush()
    rerender({ query: B })
    rerender({ query: A })
    await flush()
    expect(getter.mock.calls).toEqual([[A]])
    await act(async () => { old.resolve(snapshot('2026-01', 1, 10)) })
    expect(result.current.data).toBeUndefined()
    expect(getter.mock.calls).toEqual([[A], [A]])
    const data = snapshot('2026-01', 1, 11)
    await act(async () => { fresh.resolve(data) })
    expect(result.current.data).toBe(data)
  })

  it('treats startDay changes as new selections and forwards the latest day without duplicate equal-parameter reads', async () => {
    const old = deferred<UsageOverview>()
    const fresh = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), { initialProps: { query: A } })
    await flush()
    rerender({ query: { ...A } })
    await flush()
    expect(getter.mock.calls).toEqual([[A]])
    const query = { month: A.month, startDay: 20 }
    rerender({ query })
    await flush()
    expect(getter).toHaveBeenCalledTimes(1)
    await act(async () => { old.resolve(snapshot('2026-01')) })
    expect(result.current.data).toBeUndefined()
    expect(getter.mock.calls).toEqual([[A], [query]])
    const data = snapshot('2026-01', 20, 2)
    await act(async () => { fresh.resolve(data) })
    expect(result.current.data).toBe(data)
    rerender({ query: { ...query } })
    await flush()
    expect(getter).toHaveBeenCalledTimes(2)
  })

  it('preserves the successful snapshot and its original period when the new filter fails', async () => {
    const data = snapshot('2026-01', 15)
    const next = deferred<UsageOverview>()
    const getter = vi.fn<PionApi['getUsageOverview']>().mockResolvedValueOnce(data).mockReturnValueOnce(next.promise)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ query }) => useUsageOverview(true, api, query), {
      initialProps: { query: { month: '2026-01', startDay: 15 } }
    })
    await flush()
    rerender({ query: { month: '2026-02', startDay: 20 } })
    await flush()
    expect(result.current.data).toBe(data)
    await act(async () => { next.reject(new Error('private failure')) })
    expect(result.current.data).toBe(data)
    expect(result.current.data?.period).toEqual(usagePeriod('2026-01', 15))
    expect(result.current.error).toContain('已保留上次成功快照')
    expect(result.current.loading).toBe(false)
    expect(getter.mock.calls).toEqual([[{ month: '2026-01', startDay: 15 }], [{ month: '2026-02', startDay: 20 }]])
  })

  it.each(['refresh', 'open'] as const)('does not restart a closed pending filter selection until an explicit %s after settlement', async (resume) => {
    const old = deferred<UsageOverview>()
    const data = snapshot('2026-02', 1, 2)
    const getter = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(data)
    const api = apiFor(getter)
    const { result, rerender } = renderHook(({ open, query }) => useUsageOverview(open, api, query), {
      initialProps: { open: true, query: A }
    })
    await flush()
    rerender({ open: true, query: B })
    rerender({ open: false, query: B })
    act(() => result.current.refresh())
    // Reopening while A still owns the slot is not permission to retry on its settlement.
    rerender({ open: true, query: B })
    await flush()
    expect(getter.mock.calls).toEqual([[A]])
    await act(async () => { old.resolve(snapshot('2026-01')) })
    await flush()
    expect(getter.mock.calls).toEqual([[A]])
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(false)
    if (resume === 'refresh') act(() => result.current.refresh())
    else {
      rerender({ open: false, query: B })
      rerender({ open: true, query: B })
    }
    await flush()
    expect(getter.mock.calls).toEqual([[A], [B]])
    expect(result.current.data).toBe(data)
  })

  it.each(['API', 'getter'] as const)('does not let a pending old selection wake a new %s owner, including an identity round trip', async (identity) => {
    const old = deferred<UsageOverview>()
    const other = deferred<UsageOverview>()
    const getterA = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(old.promise)
    const getterB = vi.fn<PionApi['getUsageOverview']>().mockReturnValueOnce(other.promise)
    const apiA = apiFor(getterA)
    const apiB = identity === 'API' ? apiFor(getterB) : apiA
    const { result, rerender } = renderHook(({ api, query }) => useUsageOverview(true, api, query), {
      initialProps: { api: apiA, query: A }
    })
    await flush()
    rerender({ api: apiA, query: B })
    if (identity === 'getter') apiA.getUsageOverview = getterB
    rerender({ api: apiB, query: C })
    await flush()
    if (identity === 'getter') apiA.getUsageOverview = getterA
    rerender({ api: apiA, query: C })
    await flush()
    expect(getterA.mock.calls).toEqual([[A]])
    expect(getterB.mock.calls).toEqual([[C]])
    await act(async () => { other.resolve(snapshot('2026-03')); old.resolve(snapshot('2026-01')) })
    await flush()
    expect(getterA.mock.calls).toEqual([[A]])
    expect(getterB.mock.calls).toEqual([[C]])
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(false)
  })
})
