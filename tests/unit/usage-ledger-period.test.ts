import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sessionUsage from '../../src/main/agent/session-token-total'
import { UsageLedger } from '../../src/main/usage-ledger'

const dirs: string[] = []
const createdAt = '2020-01-01T00:00:00.000Z'
const header = (id: string, cwd = '/project/a', parentSession?: string) => ({ type: 'session', version: 3, id, cwd,
  timestamp: createdAt, ...(parentSession ? { parentSession } : {}) })
const assistant = (id: string, timestamp: string, totalTokens = 10) => ({ type: 'message', id, parentId: null, timestamp,
  message: { role: 'assistant', timestamp: Date.parse(timestamp), provider: 'fixture', model: 'model', api: 'openai-responses',
    content: [{ type: 'text', text: 'PRIVATE-CONTENT' }], stopReason: 'stop',
    usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
      cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 } } } })

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pion-usage-period-'))
  dirs.push(dir)
  const sessionRoot = join(dir, 'sessions')
  await fs.mkdir(join(sessionRoot, 'bucket'), { recursive: true })
  const options = { ledgerPath: join(dir, 'ledger.json'), sessionRoot }
  return { options, ledger: new UsageLedger(options), file: async (name: string, entries: unknown[]) => {
    const path = join(sessionRoot, 'bucket', `${name}.jsonl`)
    await fs.writeFile(path, entries.map(value => JSON.stringify(value)).join('\n') + '\n')
    return path
  } }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('usage ledger monthly projection', () => {
  it('filters durable deduplicated receipts, not creation dates or the recent daily window', async () => {
    const f = await fixture()
    const inherited = assistant('inherited', '2024-01-15T00:00:00.000Z')
    const parent = await f.file('parent', [header('parent'), inherited,
      assistant('last', '2024-02-14T23:59:59.999Z', 20), assistant('outside', '2024-02-15T00:00:00.000Z', 30)])
    const child = await f.file('child', [header('child', '/project/b', parent), inherited,
      assistant('new', '2024-01-20T00:00:00.000Z', 40)])
    await f.file('empty', [header('empty', '/project/empty')])
    await f.file('orphan', [header('orphan', '/project/orphan', join(f.options.sessionRoot, 'missing.jsonl')),
      assistant('unresolved', '2024-01-20T00:00:00.000Z', 500)])
    const all = await f.ledger.getOverview()
    expect(all).toMatchObject({ records: 4, sessions: 4, totals: { total: 100 } })
    // Archived receipts remain queryable after their original files disappear.
    await fs.unlink(parent)
    await fs.unlink(child)
    const selected = await new UsageLedger(f.options).getOverview({ month: '2024-01', startDay: 15 })
    expect(selected).toMatchObject({ records: 3, sessions: 2, projects: 2, totals: { total: 70 },
      period: { month: '2024-01', startDay: 15 } })
    expect(selected.byProject.map(project => [project.cwd, project.sessions, project.usage.total])).toEqual([
      ['/project/a', 1, 30], ['/project/b', 1, 40]
    ])
    expect(selected.byModel).toHaveLength(1)
    expect(selected.byModel[0].usage.total).toBe(70)
    expect(selected.daily.map(day => day.date)).toEqual(['2024-01-15', '2024-01-20', '2024-02-14'])
    expect(selected.availableMonths).toEqual(expect.arrayContaining(['2024-01', '2024-02']))
    expect(selected.warnings).toEqual(all.warnings)
    expect(selected.coverage.unresolvedSessions).toBe(all.coverage.unresolvedSessions)
    expect(JSON.stringify(selected)).not.toContain('PRIVATE-CONTENT')
  })

  it('keeps every actual day in a 31-day cycle, including zero-usage receipts, and supports empty months', async () => {
    const f = await fixture()
    const entries = Array.from({ length: 31 }, (_, i) => assistant(`day-${i}`, `2024-03-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`, i === 0 ? 0 : 10))
    await f.file('days', [header('days'), ...entries])
    const selected = await f.ledger.getOverview({ month: '2024-03' })
    expect(selected.daily).toHaveLength(31)
    expect(selected.daily[0].usage.total).toBe(0)
    expect(selected.records).toBe(31)
    const empty = await f.ledger.getOverview({ month: '2024-04' })
    expect(empty).toMatchObject({ records: 0, sessions: 0, projects: 0, daily: [], byProject: [], byModel: [], totals: { total: 0 } })
    expect(empty.availableMonths).toContain('2024-03')
  })

  it('projects archived deduplicated years and leap days using UTC half-open boundaries', async () => {
    const f = await fixture()
    const inherited = assistant('inherited', '2024-02-29T00:00:00.000Z', 20)
    const parent = await f.file('parent', [header('parent'),
      assistant('before', '2023-12-31T23:59:59.999Z', 1),
      assistant('first', '2024-01-01T00:00:00.000Z', 10), inherited,
      assistant('after-day', '2024-03-01T00:00:00.000Z', 30),
      assistant('last', '2024-12-31T23:59:59.999Z', 40),
      assistant('next', '2025-01-01T00:00:00.000Z', 50)])
    const child = await f.file('child', [header('child', '/project/b', parent), inherited,
      assistant('new', '2024-02-29T23:59:59.999Z', 60)])
    await f.ledger.getOverview()
    await fs.unlink(parent)
    await fs.unlink(child)
    const ledger = new UsageLedger(f.options)
    const year = await ledger.getOverview({ year: '2024', startDay: 31 })
    expect(year).toMatchObject({ records: 5, sessions: 2, projects: 2, totals: { total: 160 }, period: { year: '2024', startDay: 31 } })
    expect(year.byProject.map(project => [project.cwd, project.sessions, project.usage.total])).toEqual([
      ['/project/a', 1, 100], ['/project/b', 1, 60]
    ])
    expect(year.byModel[0].usage.total).toBe(160)
    expect(year.daily.map(day => day.date)).toEqual(['2024-01-01', '2024-02-29', '2024-03-01', '2024-12-31'])
    const day = await ledger.getOverview({ date: '2024-02-29', startDay: 31 })
    expect(day).toMatchObject({ records: 2, sessions: 2, projects: 2, totals: { total: 80 }, period: { date: '2024-02-29', startDay: 31 } })
    expect(day.daily.map(value => [value.date, value.usage.total])).toEqual([['2024-02-29', 80]])
    expect(day.byProject.map(project => project.usage.total)).toEqual([20, 60])
    expect(day.byModel[0].usage.total).toBe(80)
    expect(day.availableYears).toEqual(year.availableYears)
    expect(day.availableDates).toEqual(year.availableDates)
    expect(day.availableMonths).toEqual(year.availableMonths)
    expect(day.availableYears).toEqual(expect.arrayContaining(['2023', '2024', '2025', new Date().toISOString().slice(0, 4)]))
    expect(day.availableDates).toEqual(expect.arrayContaining(['2023-12-31', '2025-01-01', new Date().toISOString().slice(0, 10)]))
    expect(day.availableDates).toEqual([...day.availableDates!].sort().reverse())
    expect(day.availableYears).toEqual([...day.availableYears!].sort().reverse())
    expect(day.coverage).toEqual(year.coverage)
    const first = await ledger.getOverview({ date: '2024-01-01' })
    const shifted = await ledger.getOverview({ date: '2024-01-01', startDay: 31 })
    expect(shifted.totals).toEqual(first.totals)
    expect(shifted.period?.startAt).toBe(first.period?.startAt)
    expect(shifted.availableMonths).toContain('2024-02')
    expect(shifted.availableMonths).not.toContain('2024-03')
    expect(first.availableMonths).toContain('2024-03')
  })

  it('retains every actual day of a leap year without a 30-day truncation or zero filling', async () => {
    const f = await fixture()
    const start = Date.parse('2024-01-01T00:00:00.000Z')
    await f.file('year', [header('year'), ...Array.from({ length: 366 }, (_, i) =>
      assistant(`day-${i}`, new Date(start + i * 86_400_000).toISOString(), i === 0 ? 0 : 10))])
    const year = await f.ledger.getOverview({ year: '2024' })
    expect(year.daily).toHaveLength(366)
    expect(year.records).toBe(366)
    expect(year.daily[0]).toMatchObject({ date: '2024-01-01', usage: { total: 0 } })
    expect(year.daily[365].date).toBe('2024-12-31')
    const empty = await f.ledger.getOverview({ date: '2025-01-01' })
    expect(empty).toMatchObject({ records: 0, sessions: 0, projects: 0, daily: [], byProject: [], byModel: [], totals: { total: 0 } })
  })

  it('rejects invalid selectors before any collection', async () => {
    const f = await fixture()
    const reads = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot')
    for (const query of [{ date: '2025-02-29' }, { year: '24' }, { year: '2024', month: '2024-01' },
      { month: '2024-01', date: '2024-01-01' }, { year: '2024', date: '2024-01-01' }]) {
      await expect(f.ledger.getOverview(query)).rejects.toThrow()
    }
    expect(reads).not.toHaveBeenCalled()
    await expect(fs.stat(f.options.ledgerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shares one actual collection but keeps each query projection distinct and preserves no-args promise identity', async () => {
    const f = await fixture()
    await f.file('root', [header('root'), assistant('jan', '2024-01-20T00:00:00.000Z'), assistant('feb', '2024-02-20T00:00:00.000Z', 20)])
    const reads = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot')
    const all = f.ledger.getOverview()
    expect(f.ledger.getOverview()).toBe(all)
    const january = f.ledger.getOverview({ month: '2024-01' })
    expect(f.ledger.getOverview({ month: '2024-01', startDay: 1 })).toBe(january)
    const february = f.ledger.getOverview({ month: '2024-02' })
    const year = f.ledger.getOverview({ year: '2024' })
    expect(f.ledger.getOverview({ year: '2024', startDay: 1 })).toBe(year)
    const day = f.ledger.getOverview({ date: '2024-02-20' })
    expect(f.ledger.getOverview({ date: '2024-02-20', startDay: 1 })).toBe(day)
    const nextYear = f.ledger.getOverview({ year: '2025' })
    const [a, jan, feb, annual, daily, next] = await Promise.all([all, january, february, year, day, nextYear])
    expect(reads).toHaveBeenCalledTimes(1)
    expect(a.totals.total).toBe(30)
    expect(jan.totals.total).toBe(10)
    expect(feb.totals.total).toBe(20)
    expect(annual).toMatchObject({ totals: { total: 30 }, period: { year: '2024' } })
    expect(daily).toMatchObject({ totals: { total: 20 }, period: { date: '2024-02-20' } })
    expect(next.totals.total).toBe(0)
    expect(annual.revision).toBe(daily.revision)
    expect(annual.coverage).toEqual(daily.coverage)
    expect(jan.revision).toBe(feb.revision)
    expect(jan.coverage).toEqual(feb.coverage)
    expect(jan.availableMonths).toEqual(feb.availableMonths)
    await f.ledger.flush()
  })
})
