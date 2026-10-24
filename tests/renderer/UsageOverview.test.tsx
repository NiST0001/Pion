// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/pion-api'
import type { UsageOverview, UsageOverviewQuery } from '../../src/shared/usage-overview'
import { usagePeriod } from '../../src/shared/usage-period'
import { UsageOverviewModal } from '../../src/renderer/src/features/operations/UsageOverviewModal'
import { useUsageOverview } from '../../src/renderer/src/features/operations/useUsageOverview'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function snapshot(overrides: Partial<UsageOverview> = {}): UsageOverview {
  const usage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, reasoning: 20, total: 165, costUsd: 12.3456 }
  return {
    revision: 1,
    collectedAt: Date.UTC(2026, 9, 23), firstRecordAt: Date.UTC(2026, 9, 1),
    totals: usage, sessions: 3, projects: 1, records: 12,
    byProject: [{ cwd: '/project', sessions: 3, usage }],
    byModel: [{ source: 'model', provider: 'provider', modelId: 'model', usage }],
    daily: [{ date: '2026-10-23', usage }],
    coverage: { discoveredSessions: 3, collectedSessions: 3, unavailableSessions: 0, unresolvedSessions: 0, limitReached: false },
    warnings: [], ...overrides
  }
}

const apiFor = (getter: () => Promise<UsageOverview>): PionApi => ({ getUsageOverview: getter }) as PionApi
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

function selectFilter(name: string, option: string): void {
  fireEvent.click(screen.getByRole('combobox', { name }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

describe('UsageOverviewModal local snapshot lifecycle', () => {
  it('reads on each open or explicit refresh, retains successful data and reports failure without zeroing it', async () => {
    const getter = vi.fn<() => Promise<UsageOverview>>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ revision: 2 }))
      .mockRejectedValueOnce(new Error('private IPC failure'))
    const api = apiFor(getter)
    const onClose = vi.fn()
    const { rerender } = render(<UsageOverviewModal open={false} api={api} onClose={onClose} />)
    await flush()
    expect(getter).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    rerender(<UsageOverviewModal open api={api} onClose={onClose} />)
    expect(screen.queryByRole('group', { name: '已记录累计使用数据' })).not.toBeInTheDocument()
    await flush()
    const cards = screen.getByRole('group', { name: '已记录累计使用数据' })
    expect(within(cards).getByText('$12.3456')).toBeInTheDocument()
    expect(within(cards).getByText('165')).toBeInTheDocument()
    expect(within(cards).getByText('3')).toBeInTheDocument()
    expect(within(cards).getByText('12')).toBeInTheDocument()
    expect(screen.getByText('已报告推理')).toBeInTheDocument()
    expect(screen.getByText('推理已计入输出，Token 按 SDK 报告统计。')).toBeInTheDocument()
    expect(getter).toHaveBeenCalledTimes(1)

    // Callback-only rerenders do not read. Reopening rescans even with cached data.
    rerender(<UsageOverviewModal open api={api} onClose={() => onClose()} />)
    expect(getter).toHaveBeenCalledTimes(1)
    rerender(<UsageOverviewModal open={false} api={api} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<UsageOverviewModal open api={api} onClose={onClose} />)
    await flush()
    expect(screen.getByText('$12.3456', { selector: '.usage-overview-cards strong' })).toBeInTheDocument()
    expect(getter).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    expect(getter).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('alert')).toHaveTextContent('刷新失败，已保留上次成功快照。')
    expect(screen.getByText('$12.3456', { selector: '.usage-overview-cards strong' })).toBeInTheDocument()
    expect(screen.queryByText('private IPC failure')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭使用总览' })).toBeEnabled()
  })

  it('labels normalized zero reasoning as reported-only and preserves the SDK total without recalculating it', async () => {
    const data = snapshot()
    data.totals = { ...data.totals, reasoning: 0, total: 777 }
    render(<UsageOverviewModal open api={apiFor(vi.fn().mockResolvedValue(data))} onClose={vi.fn()} />)
    await flush()
    const tokens = screen.getByRole('region', { name: 'Token 细分' })
    expect(within(tokens).getByText('已报告推理')).toBeInTheDocument()
    expect(within(tokens).getByText('0', { selector: 'strong' })).toBeInTheDocument()
    expect(tokens).toHaveTextContent('Token 按 SDK 报告统计')
    expect(within(screen.getByRole('group', { name: '已记录累计使用数据' })).getByText('777')).toBeInTheDocument()
  })

  it('never presents initial failure as zero usage, including StrictMode effect replay', async () => {
    const getter = vi.fn().mockRejectedValue(new Error('failed'))
    const api = apiFor(getter)
    render(<StrictMode><UsageOverviewModal open api={api} onClose={vi.fn()} /></StrictMode>)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('读取使用总览失败')
    expect(getter).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group', { name: '已记录累计使用数据' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '关闭使用总览' })).toBeEnabled()
  })

  it('holds the actual single-flight across close and unmount; a new activation cannot accept the old result or automatically retry', async () => {
    const old = deferred<UsageOverview>()
    const getter = vi.fn<() => Promise<UsageOverview>>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot())
    const api = apiFor(getter)
    const props = { api, onClose: vi.fn() }
    const first = render(<UsageOverviewModal {...props} open />)
    await flush()
    first.rerender(<UsageOverviewModal {...props} open={false} />)
    first.rerender(<UsageOverviewModal {...props} open />)
    expect(screen.getByRole('button', { name: '读取中…' })).toBeDisabled()
    first.unmount()
    render(<UsageOverviewModal {...props} open />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '读取中…' }))
    expect(getter).toHaveBeenCalledTimes(1)

    await act(async () => { old.resolve(snapshot({ records: 999 })) })
    expect(screen.queryByRole('group', { name: '已记录累计使用数据' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('尚无可显示的快照')
    expect(getter).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    expect(getter).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('group', { name: '已记录累计使用数据' })).toBeInTheDocument()
  })

  it('shows a finite slow-read notice without releasing the real slot or preventing close', async () => {
    vi.useFakeTimers()
    const old = deferred<UsageOverview>()
    const getter = vi.fn(() => old.promise)
    const api = apiFor(getter)
    const props = { api, onClose: vi.fn() }
    const { rerender } = render(<UsageOverviewModal {...props} open />)
    await flush()
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(screen.getByRole('status')).toHaveTextContent('仍在读取')
    expect(screen.getByRole('button', { name: '读取中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '关闭使用总览' })).toBeEnabled()
    expect(screen.queryByRole('group', { name: '已记录累计使用数据' })).not.toBeInTheDocument()
    rerender(<UsageOverviewModal {...props} open={false} />)
    rerender(<UsageOverviewModal {...props} open />)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(getter).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '读取中…' })).toBeDisabled()
    await act(async () => { old.resolve(snapshot()) })
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByRole('group', { name: '已记录累计使用数据' })).not.toBeInTheDocument()
  })

  it.each(['API', 'getter'] as const)('retires %s A → B → A results, retaining each real pending slot until settlement', async (identity) => {
    const a = deferred<UsageOverview>()
    const b = deferred<UsageOverview>()
    const getA = vi.fn<() => Promise<UsageOverview>>().mockReturnValueOnce(a.promise).mockResolvedValueOnce(snapshot())
    const getB = vi.fn(() => b.promise)
    const apiA = apiFor(getA)
    const apiB = identity === 'API' ? apiFor(getB) : apiA
    const { result, rerender } = renderHook(({ api }) => useUsageOverview(true, api), { initialProps: { api: apiA } })
    await flush()
    if (identity === 'getter') apiA.getUsageOverview = getB
    rerender({ api: apiB })
    await flush()
    if (identity === 'getter') apiA.getUsageOverview = getA
    rerender({ api: apiA })
    await flush()
    expect(getA).toHaveBeenCalledTimes(1)
    expect(getB).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(true)
    act(() => result.current.refresh())
    expect(getA).toHaveBeenCalledTimes(1)
    await act(async () => { a.resolve(snapshot({ records: 1000 })); b.resolve(snapshot({ records: 2000 })) })
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(false)
    // Duplicate calls in one turn still reserve only one real IPC.
    act(() => { result.current.refresh(); result.current.refresh() })
    await flush()
    expect(getA).toHaveBeenCalledTimes(2)
    expect(result.current.data?.records).toBe(12)
  })

  it('bounds visible distribution rows, exposes later pages and reports coverage/unknown tool model without inventing zero days', async () => {
    const usage = snapshot().totals
    const data = snapshot({
      byProject: Array.from({ length: 45 }, (_, index) => ({ cwd: `/project-${index}`, sessions: 1, usage })),
      byModel: [
        { source: 'tool-summary', provider: 'parent-must-not-appear', modelId: 'parent-model', usage },
        ...Array.from({ length: 44 }, (_, index) => ({ source: 'model' as const, provider: 'provider', modelId: `model-${index}`, usage }))
      ],
      coverage: { discoveredSessions: 8, collectedSessions: 3, unavailableSessions: 3, unresolvedSessions: 2, limitReached: false },
      warnings: ['incomplete-history', 'unresolved-lineage', 'collection-failed'],
      daily: []
    })
    render(<UsageOverviewModal open api={apiFor(vi.fn().mockResolvedValue(data))} onClose={vi.fn()} />)
    await flush()
    const projectTable = screen.getByRole('table', { name: '项目分布' })
    const modelTable = screen.getByRole('table', { name: '模型分布' })
    expect(within(projectTable).getAllByRole('row')).toHaveLength(21)
    expect(within(modelTable).getAllByRole('row')).toHaveLength(21)
    expect(within(modelTable).getByText('工具汇总（模型未知）')).toBeInTheDocument()
    expect(within(modelTable).getByText('不归属父模型')).toBeInTheDocument()
    expect(screen.queryByText(/parent-must-not-appear/)).not.toBeInTheDocument()
    const pager = screen.getByRole('navigation', { name: '项目分布分页' })
    expect(pager).toHaveTextContent('第 1–20 项，共 45 项')
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }))
    expect(within(projectTable).queryByText('/project-0')).not.toBeInTheDocument()
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }))
    expect(within(projectTable).getAllByRole('row')).toHaveLength(6)
    expect(within(projectTable).getByText('/project-44')).toBeInTheDocument()
    expect(pager).toHaveTextContent('第 41–45 项，共 45 项')
    expect(screen.getByRole('list', { name: '覆盖警告' })).toHaveTextContent('部分分支来源待确认')
    expect(screen.getByRole('list', { name: '覆盖警告' })).toHaveTextContent('部分文件读取失败')
    expect(screen.queryByText(/采集容量上限|已达到采集上限/)).not.toBeInTheDocument()
    expect(screen.getByText('暂无可按日期归属的用量记录。')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '近30天用量' })).not.toBeInTheDocument()
    const scope = screen.getByRole('region', { name: '统计口径' })
    expect(scope).toHaveTextContent('$0 不代表免费')
    expect(scope).toHaveTextContent('采集后删除会话仍保留')
    expect(scope).toHaveTextContent('共用 SDK 会话根')
    expect(scope).toHaveTextContent('不外发')
    expect(scope).toHaveTextContent('生图额度不在内')
  })

  it('selects backend months in descending order, keeps the selected month and preserves no-argument defaults', async () => {
    const getter = vi.fn<(query?: UsageOverviewQuery) => Promise<UsageOverview>>()
      .mockResolvedValueOnce(snapshot({ availableMonths: ['2026-09', '2026-10'] }))
      .mockResolvedValue(snapshot({ period: usagePeriod('2026-09'), availableMonths: ['2026-10'] }))
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    expect(getter.mock.calls[0]).toEqual([])
    fireEvent.click(screen.getByRole('combobox', { name: '月份' }))
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['全部时间', '2026-10', '2026-09'])
    fireEvent.click(screen.getByRole('option', { name: '2026-09' }))
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ month: '2026-09', startDay: 1 })
    expect(screen.getByRole('combobox', { name: '月份' })).toHaveTextContent('2026-09')
    selectFilter('账期起始日', '每月 15 日')
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ month: '2026-09', startDay: 15 })
    expect(localStorage.getItem('pion:usage-cycle-start-day')).toBe('15')
    selectFilter('月份', '全部时间')
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ startDay: 15 })
    selectFilter('账期起始日', '每月 1 日')
    await flush()
    expect(getter.mock.calls.at(-1)).toEqual([])
  })

  it('selects mutually exclusive years, months and dates while preserving the start-day preference and selected options', async () => {
    localStorage.setItem('pion:usage-cycle-start-day', '31')
    const options = { availableYears: ['2024', '2026'], availableMonths: ['2026-10'], availableDates: ['2026-10-01', '2026-10-23'] }
    const getter = vi.fn<(query?: UsageOverviewQuery) => Promise<UsageOverview>>()
      .mockResolvedValueOnce(snapshot(options)).mockResolvedValue(snapshot())
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByRole('combobox', { name: '年份' }))
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['全部时间', '2026', '2024'])
    fireEvent.click(screen.getByRole('option', { name: '2024' }))
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ year: '2024', startDay: 31 })
    expect(screen.getByRole('combobox', { name: '年份' })).toHaveTextContent('2024')
    expect(screen.getByRole('combobox', { name: '月份' })).toHaveTextContent('全部时间')
    expect(screen.getByRole('combobox', { name: '日期' })).toHaveTextContent('全部时间')

    // Restore full-history choices through a refresh; the selected year was retained when absent.
    getter.mockResolvedValue(snapshot(options))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    selectFilter('月份', '2026-10')
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ month: '2026-10', startDay: 31 })
    expect(screen.getByRole('combobox', { name: '年份' })).toHaveTextContent('全部时间')
    fireEvent.click(screen.getByRole('combobox', { name: '日期' }))
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['全部时间', '2026-10-23', '2026-10-01'])
    getter.mockResolvedValue(snapshot())
    fireEvent.click(screen.getByRole('option', { name: '2026-10-23' }))
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ date: '2026-10-23', startDay: 31 })
    expect(screen.getByRole('combobox', { name: '日期' })).toHaveTextContent('2026-10-23')
    expect(screen.getByRole('combobox', { name: '月份' })).toHaveTextContent('全部时间')
    expect(screen.getByRole('combobox', { name: '年份' })).toHaveTextContent('全部时间')
    expect(screen.getByRole('combobox', { name: '账期起始日' })).toHaveTextContent('每月 31 日')
    expect(localStorage.getItem('pion:usage-cycle-start-day')).toBe('31')
    selectFilter('日期', '全部时间')
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ startDay: 31 })
  })

  it('labels natural UTC years and days from returned periods without truncating the 366 recorded days', async () => {
    const usage = snapshot().totals
    const annual = snapshot({
      period: { year: '2024', startDay: 31, startAt: Date.UTC(2024, 0, 1), endAt: Date.UTC(2025, 0, 1) },
      daily: Array.from({ length: 366 }, (_, index) => ({ date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10), usage }))
    })
    const getter = vi.fn().mockResolvedValueOnce(annual).mockResolvedValueOnce(snapshot({
      period: { date: '2026-10-23', startDay: 31, startAt: Date.UTC(2026, 9, 23), endAt: Date.UTC(2026, 9, 24) }
    }))
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    expect(screen.getByRole('group', { name: '已记录年度使用数据' })).toHaveTextContent('年度 SDK 估算费用')
    expect(screen.getByText('快照年度：2024-01-01 至 2024-12-31（UTC）')).toBeInTheDocument()
    const daily = screen.getByRole('table', { name: '年度每日用量' })
    expect(within(daily).getAllByRole('row')).toHaveLength(367)
    expect(daily).toHaveTextContent('2024-01-01')
    expect(daily).toHaveTextContent('2024-02-29')
    expect(daily).toHaveTextContent('2024-12-31')
    expect(screen.queryByText(/不足起始日|仅显示最近 30/)).not.toBeInTheDocument()
    expect(screen.getByText(/快照年度/)).not.toHaveTextContent('每月')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    expect(screen.getByRole('group', { name: '已记录当日使用数据' })).toHaveTextContent('当日 SDK 估算费用')
    expect(screen.getByText('快照当日：2026-10-23 至 2026-10-23（UTC）')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: '当日用量' })).getAllByRole('row')).toHaveLength(2)
    expect(screen.getByText(/快照当日/)).not.toHaveTextContent('每月')
    expect(screen.queryByText(/不足起始日/)).not.toBeInTheDocument()
  })

  it('keeps the returned monthly labels when year and date selections fail', async () => {
    const getter = vi.fn().mockResolvedValueOnce(snapshot({ period: usagePeriod('2026-09', 31), availableYears: ['2026'], availableDates: ['2026-10-23'] }))
      .mockRejectedValue(new Error('failed'))
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    const cards = screen.getByRole('group', { name: '已记录账期使用数据' })
    for (const [field, value] of [['年份', '2026'], ['日期', '2026-10-23']]) {
      selectFilter(field, value)
      await flush()
      expect(screen.getByRole('group', { name: '已记录账期使用数据' })).toBe(cards)
      expect(cards).toHaveTextContent('账期 SDK 估算费用')
      expect(screen.getByText(/快照账期：2026-09-30 至 2026-10-30/)).toBeInTheDocument()
      expect(screen.queryByRole('group', { name: '已记录年度使用数据' })).not.toBeInTheDocument()
      expect(screen.queryByRole('group', { name: '已记录当日使用数据' })).not.toBeInTheDocument()
    }
  })

  it('uses only returned period statistics across all sections and keeps all 31 daily rows', async () => {
    const usage = { ...snapshot().totals, total: 987, costUsd: 4.25 }
    const data = snapshot({ period: usagePeriod('2026-10'), totals: usage, sessions: 2, projects: 1, records: 31,
      byProject: [{ cwd: '/cycle-project', sessions: 2, usage }],
      byModel: [{ source: 'model', provider: 'cycle', modelId: 'cycle-model', usage }],
      daily: Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, usage })) })
    render(<UsageOverviewModal open api={apiFor(vi.fn().mockResolvedValue(data))} onClose={vi.fn()} />)
    await flush()
    expect(screen.getByText('快照账期：2026-10-01 至 2026-10-31（UTC）· 每月 1 日起')).toBeInTheDocument()
    const cards = screen.getByRole('group', { name: '已记录账期使用数据' })
    expect(cards).toHaveTextContent('账期 SDK 估算费用')
    expect(cards).toHaveTextContent('有用量会话')
    expect(within(cards).getByText('$4.25')).toBeInTheDocument()
    expect(within(cards).getByText('987')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Token 细分' })).toHaveTextContent('100')
    const projects = screen.getByRole('table', { name: '项目分布' })
    expect(projects).toHaveTextContent('/cycle-project')
    expect(within(projects).getByText('987')).toBeInTheDocument()
    expect(within(projects).getByText('$4.25')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: '模型分布' })).toHaveTextContent('cycle / cycle-model987$4.25')
    expect(screen.getByRole('region', { name: '全局采集覆盖' })).toHaveTextContent('本次发现 3 个会话文件')
    const daily = screen.getByRole('table', { name: '账期每日用量' })
    expect(within(daily).getAllByRole('row')).toHaveLength(32)
    expect(daily).toHaveTextContent('2026-10-01')
    expect(daily).toHaveTextContent('2026-10-31')
    expect(screen.queryByText(/仅显示最近 30/)).not.toBeInTheDocument()
  })

  it('remembers the start day, explains short months and reports failed saves without reverting the selection', async () => {
    localStorage.setItem('pion:usage-cycle-start-day', '31')
    const getter = vi.fn().mockResolvedValue(snapshot({ period: usagePeriod('2026-02', 31) }))
    const api = apiFor(getter)
    const first = render(<UsageOverviewModal open api={api} onClose={vi.fn()} />)
    await flush()
    expect(getter).toHaveBeenLastCalledWith({ startDay: 31 })
    expect(screen.getByRole('combobox', { name: '账期起始日' })).toHaveTextContent('每月 31 日')
    expect(screen.getByText(/快照账期：2026-02-28 至 2026-03-30/)).toHaveTextContent('不足起始日的月份按月末开始')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    selectFilter('账期起始日', '每月 15 日')
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('起始日未保存，当前选择仍生效')
    expect(screen.getByRole('combobox', { name: '账期起始日' })).toHaveTextContent('每月 15 日')
    expect(getter).toHaveBeenLastCalledWith({ startDay: 15 })
    first.unmount()
    render(<UsageOverviewModal open api={api} onClose={vi.fn()} />)
    await flush()
    expect(screen.getByRole('combobox', { name: '账期起始日' })).toHaveTextContent('每月 31 日')
  })

  it.each(['bad-value', 'read-failure'])('does not persist the default after a %s in stored start day', async mode => {
    localStorage.setItem('pion:usage-cycle-start-day', 'invalid')
    if (mode === 'read-failure') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const save = vi.spyOn(Storage.prototype, 'setItem')
    const getter = vi.fn().mockResolvedValue(snapshot())
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    expect(screen.getByRole('combobox', { name: '账期起始日' })).toHaveTextContent('每月 1 日')
    expect(getter.mock.calls[0]).toEqual([])
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps old amounts labeled with their returned period while a new selection loads or fails', async () => {
    const pending = deferred<UsageOverview>()
    const getter = vi.fn().mockResolvedValueOnce(snapshot({ period: usagePeriod('2026-09'), availableMonths: ['2026-10', '2026-09'] }))
      .mockReturnValueOnce(pending.promise)
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    const cards = screen.getByRole('group', { name: '已记录账期使用数据' })
    selectFilter('月份', '2026-10')
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent('当前显示上次成功快照')
    expect(screen.getByText(/快照账期：2026-09-01 至 2026-09-30/)).toBeInTheDocument()
    expect(screen.queryByText(/快照账期：2026-10/)).not.toBeInTheDocument()
    expect(cards).toHaveTextContent('$12.3456')
    await act(async () => { pending.reject(new Error('failed')) })
    expect(screen.getByRole('group', { name: '已记录账期使用数据' })).toBe(cards)
    expect(screen.getByText(/快照账期：2026-09-01 至 2026-09-30/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('已保留上次成功快照')
  })

  it('resets distribution pages only when the returned period changes without remounting tables', async () => {
    const data = snapshot({ availableMonths: ['2026-10'], byProject: Array.from({ length: 25 }, (_, index) => ({ cwd: `/project-${index}`, sessions: 1, usage: snapshot().totals })) })
    const getter = vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce(snapshot({ ...data, revision: 2 }))
      .mockResolvedValueOnce(snapshot({ ...data, revision: 3, period: usagePeriod('2026-10') }))
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    const table = screen.getByRole('table', { name: '项目分布' })
    const pager = screen.getByRole('navigation', { name: '项目分布分页' })
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    expect(pager).toHaveTextContent('第 21–25 项')
    selectFilter('月份', '2026-10')
    await flush()
    expect(pager).toHaveTextContent('第 1–20 项')
    expect(screen.getByRole('table', { name: '项目分布' })).toBe(table)
  })

  it('retains distribution DOM and same-year pages but resets on a different year or date', async () => {
    const year = { year: '2024', startDay: 1, startAt: Date.UTC(2024, 0, 1), endAt: Date.UTC(2025, 0, 1) }
    const data = snapshot({ period: year, byProject: Array.from({ length: 25 }, (_, index) => ({ cwd: `/project-${index}`, sessions: 1, usage: snapshot().totals })) })
    const getter = vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce(snapshot({ ...data, revision: 2 }))
      .mockResolvedValueOnce(snapshot({ ...data, revision: 3, period: { ...year, year: '2025', startAt: Date.UTC(2025, 0, 1), endAt: Date.UTC(2026, 0, 1) } }))
      .mockResolvedValueOnce(snapshot({ ...data, revision: 4, period: { date: '2025-01-01', startDay: 1, startAt: Date.UTC(2025, 0, 1), endAt: Date.UTC(2025, 0, 2) } }))
      .mockResolvedValueOnce(snapshot({ ...data, revision: 5, period: { date: '2025-01-02', startDay: 1, startAt: Date.UTC(2025, 0, 2), endAt: Date.UTC(2025, 0, 3) } }))
    render(<UsageOverviewModal open api={apiFor(getter)} onClose={vi.fn()} />)
    await flush()
    const table = screen.getByRole('table', { name: '项目分布' })
    const pager = screen.getByRole('navigation', { name: '项目分布分页' })
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    expect(pager).toHaveTextContent('第 21–25 项')
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      await flush()
      expect(pager).toHaveTextContent('第 1–20 项')
      expect(screen.getByRole('table', { name: '项目分布' })).toBe(table)
      fireEvent.click(within(pager).getByRole('button', { name: '下一页' }))
    }
  })

  it('cancels IME/repeated keys, keeps ordinary Enter native and contains topmost modal keys while restoring focus without scrolling', async () => {
    render(<textarea aria-label="消息输入" />)
    const composer = screen.getByRole('textbox', { name: '消息输入' })
    composer.focus()
    const restoreFocus = vi.spyOn(composer, 'focus')
    const onClose = vi.fn()
    const getter = vi.fn().mockResolvedValue(snapshot())
    const api = apiFor(getter)
    function Harness() {
      const [open, setOpen] = useState(true)
      return <UsageOverviewModal open={open} api={api} onClose={() => { onClose(); setOpen(false) }} />
    }
    render(<Harness />)
    await flush()
    const dialog = screen.getByRole('dialog', { name: '使用总览' })
    const close = screen.getByRole('button', { name: '关闭使用总览' })
    expect(close).toHaveFocus()
    const leakedKey = vi.fn()
    window.addEventListener('keydown', leakedKey)
    try {
      expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false)
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
      expect(composer).not.toHaveFocus()
      const refresh = screen.getByRole('button', { name: '刷新' })
      for (const button of [close, refresh]) {
        for (const key of ['Enter', 'Escape']) {
          for (const state of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
            const blocked = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...state })
            fireEvent(button, blocked)
            expect(blocked.defaultPrevented).toBe(true)
          }
        }
        fireEvent.compositionStart(button)
        for (const key of ['Enter', 'Escape']) {
          const blocked = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          fireEvent(button, blocked)
          expect(blocked.defaultPrevented).toBe(true)
        }
        fireEvent.compositionEnd(button)
      }
      expect(onClose).not.toHaveBeenCalled()
      expect(getter).toHaveBeenCalledTimes(1)
      expect(leakedKey).not.toHaveBeenCalled()

      const higher = document.createElement('section')
      higher.setAttribute('role', 'dialog')
      higher.setAttribute('aria-modal', 'true')
      higher.dataset.modalLayer = '999'
      document.body.appendChild(higher)
      fireEvent.keyDown(higher, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      higher.remove()
      leakedKey.mockClear()
      close.focus()
      for (const button of [close, refresh]) {
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        fireEvent(button, enter)
        expect(enter.defaultPrevented).toBe(false)
      }
      expect(onClose).not.toHaveBeenCalled()
      expect(getter).toHaveBeenCalledTimes(1)
      expect(leakedKey).not.toHaveBeenCalled()
      // fireEvent does not perform native Enter button activation; exercise close/focus explicitly.
      fireEvent.click(close)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(leakedKey).not.toHaveBeenCalled()
      expect(composer).toHaveFocus()
      expect(restoreFocus).toHaveBeenLastCalledWith({ preventScroll: true })
    } finally { window.removeEventListener('keydown', leakedKey) }
  })
})
