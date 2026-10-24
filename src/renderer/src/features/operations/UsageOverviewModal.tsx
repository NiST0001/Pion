import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import type { PionApi } from '../../../../shared/pion-api'
import type { TokenUsage } from '../../../../shared/operations'
import type { UsageOverview, UsageOverviewQuery, UsageOverviewWarning } from '../../../../shared/usage-overview'
import { PionSelect } from '../common/PionSelect'
import { OperationsModal } from './OperationsModal'
import { useUsageOverview } from './useUsageOverview'

export interface UsageOverviewModalProps {
  open: boolean
  api?: PionApi
  onClose(): void
}

const PAGE_SIZE = 20
const START_DAY_KEY = 'pion:usage-cycle-start-day'
const START_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: `每月 ${index + 1} 日` }))
function readStartDay(): number {
  try {
    const value = localStorage.getItem(START_DAY_KEY)
    return value && /^(?:[1-9]|[12]\d|3[01])$/.test(value) ? Number(value) : 1
  } catch { return 1 }
}
const utcDate = (value: number): string => new Date(value).toISOString().slice(0, 10)
const numberFormat = new Intl.NumberFormat('zh-CN')
const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
const count = (value: number): string => numberFormat.format(value)
const cost = (value: number): string => costFormat.format(value)
const timestamp = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false })
const WARNING_LABELS: Record<UsageOverviewWarning, string> = {
  'incomplete-history': '部分历史未采集。',
  'unresolved-lineage': '部分分支来源待确认。',
  'collection-failed': '部分文件读取失败，已保留此前数据。'
}

interface DistributionEntry {
  id: string
  label: string
  note?: string
  usage: TokenUsage
}

function UsageDistribution({ title, entries, periodId }: { title: string; entries: DistributionEntry[]; periodId: string }): ReactElement {
  const [requestedPage, setPage] = useState(0)
  useEffect(() => { setPage(0) }, [periodId])
  const regionRef = useRef<HTMLDivElement>(null)
  const lastPage = Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1)
  const page = Math.min(requestedPage, lastPage)
  if (page !== requestedPage) setPage(page)
  const start = page * PAGE_SIZE
  const visible = entries.slice(start, start + PAGE_SIZE)
  const changePage = (offset: number): void => {
    regionRef.current?.focus({ preventScroll: true })
    setPage(Math.max(0, Math.min(lastPage, page + offset)))
  }
  return (
    <section className="usage-overview-section" aria-label={title}>
      <h3>{title}<small>共 {count(entries.length)} 项</small></h3>
      {entries.length === 0 ? <p className="usage-overview-note">暂无可归属的已记录用量。</p> : <>
        <div ref={regionRef} className="usage-overview-table-wrap" role="region" aria-label={`${title}明细`} tabIndex={0}>
          <table className="usage-overview-table" aria-label={title}>
            <thead><tr><th scope="col">{title === '项目分布' ? '项目' : '模型 / 来源'}</th><th scope="col">Token</th><th scope="col">估算 USD</th></tr></thead>
            <tbody>{visible.map((entry) => <tr key={entry.id}>
              <th scope="row"><span className="usage-overview-name" title={entry.label}>{entry.label}</span>{entry.note && <small>{entry.note}</small>}</th>
              <td>{count(entry.usage.total)}</td><td>{cost(entry.usage.costUsd)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {lastPage > 0 && <nav className="usage-overview-pagination" aria-label={`${title}分页`}>
          <button type="button" disabled={page === 0} onClick={() => changePage(-1)}>上一页</button>
          <span aria-live="polite">第 {start + 1}–{start + visible.length} 项，共 {count(entries.length)} 项</span>
          <button type="button" disabled={page === lastPage} onClick={() => changePage(1)}>下一页</button>
        </nav>}
      </>}
    </section>
  )
}

function OverviewData({ data }: { data: UsageOverview }): ReactElement {
  // Missing days are not synthesised as zero. Reasoning is already included in output.
  const period = data.period
  const periodKind = period?.year ? 'year' : period?.date ? 'date' : period?.month ? 'month' : 'all'
  const periodId = periodKind === 'year' ? `year:${period?.year}` : periodKind === 'date' ? `date:${period?.date}` : periodKind === 'month' ? `month:${period?.month}:${period?.startDay}` : 'all'
  const periodLabel = periodKind === 'year' ? '年度' : periodKind === 'date' ? '当日' : periodKind === 'month' ? '账期' : '累计'
  const sortedDaily = [...data.daily].sort((left, right) => left.date.localeCompare(right.date))
  const daily = period ? sortedDaily : sortedDaily.slice(-30)
  const dailyTitle = periodKind === 'year' ? '年度每日用量' : periodKind === 'date' ? '当日用量' : period ? '账期每日用量' : '近30天用量'
  return <>
    <p className="usage-overview-note usage-overview-period">{period
      ? `快照${periodLabel}：${utcDate(period.startAt)} 至 ${utcDate(period.endAt - 1)}（UTC）${periodKind === 'month' ? `· 每月 ${period.startDay} 日起` : ''}`
      : '快照范围：全部时间'}{periodKind === 'month' && period && period.startDay > 28 && '；不足起始日的月份按月末开始。'}</p>
    <div className="run-metrics-grid usage-overview-cards" role="group" aria-label={`已记录${periodLabel}使用数据`}>
      <span><small>{periodLabel} SDK 估算费用</small><strong>{cost(data.totals.costUsd)}</strong><small>USD · 非实际账单</small></span>
      <span><small>总 Token</small><strong>{count(data.totals.total)}</strong><small>{periodLabel}计费用量，非上下文占用</small></span>
      <span><small>{period ? '有用量会话' : '已记录会话'}</small><strong>{count(data.sessions)}</strong><small>{count(data.projects)} 个项目</small></span>
      <span><small>用量记录</small><strong>{count(data.records)}</strong><small>去重持久记录，非请求次数</small></span>
    </div>

    <section className="usage-overview-section" aria-label="Token 细分">
      <h3>Token 细分</h3>
      <div className="run-metrics-grid usage-overview-token-grid">
        <span><small>输入</small><strong>{count(data.totals.input)}</strong></span>
        <span><small>输出</small><strong>{count(data.totals.output)}</strong></span>
        <span><small>缓存读取</small><strong>{count(data.totals.cacheRead)}</strong></span>
        <span><small>缓存写入</small><strong>{count(data.totals.cacheWrite)}</strong></span>
        <span><small>已报告推理</small><strong>{count(data.totals.reasoning)}</strong></span>
      </div>
      <p className="usage-overview-note">推理已计入输出，Token 按 SDK 报告统计。</p>
    </section>

    <section className="usage-overview-section usage-overview-coverage" aria-label="全局采集覆盖">
      <h3>全局采集覆盖</h3>
      <p className="usage-overview-note">本次发现 {count(data.coverage.discoveredSessions)} 个会话文件 · 已采集 {count(data.coverage.collectedSessions)} · 不可读取 {count(data.coverage.unavailableSessions)} · 来源待确认 {count(data.coverage.unresolvedSessions)}</p>
      <p className="usage-overview-note">{data.firstRecordAt === null ? '尚无带时间的已记录用量。' : `最早用量：${timestamp(data.firstRecordAt)}`}</p>
      {data.warnings.length > 0 && <ul className="usage-overview-warnings" aria-label="覆盖警告">
        {data.warnings.map((warning) => <li key={warning}>{WARNING_LABELS[warning]}</li>)}
      </ul>}
    </section>

    <div className="usage-overview-distributions">
      <UsageDistribution title="项目分布" periodId={periodId} entries={data.byProject.map((project) => ({
        id: project.cwd, label: project.cwd, note: `${count(project.sessions)} 个${period ? '有用量' : '已记录'}会话`, usage: project.usage
      }))} />
      <UsageDistribution title="模型分布" periodId={periodId} entries={data.byModel.map((model) => ({
        id: JSON.stringify([model.source, model.provider, model.modelId]),
        label: model.source === 'tool-summary' ? '工具汇总（模型未知）' : `${model.provider ?? '未知提供商'} / ${model.modelId ?? '未知模型'}`,
        note: model.source === 'tool-summary' ? '不归属父模型' : undefined,
        usage: model.usage
      }))} />
    </div>

    <section className="usage-overview-section" aria-label={dailyTitle}>
      <h3>{period ? dailyTitle : '近30天'}<small>UTC · 仅已记录日期</small></h3>
      {daily.length === 0 ? <p className="usage-overview-note">暂无可按日期归属的用量记录。</p> : <div className="usage-overview-table-wrap" role="region" aria-label={`${dailyTitle}明细`} tabIndex={0}>
        <table className="usage-overview-table" aria-label={dailyTitle}>
          <thead><tr><th scope="col">日期（UTC）</th><th scope="col">Token</th><th scope="col">估算 USD</th></tr></thead>
          <tbody>{daily.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td>{count(day.usage.total)}</td><td>{cost(day.usage.costUsd)}</td></tr>)}</tbody>
        </table>
      </div>}
      {!period && data.daily.length > 30 && <p className="usage-overview-note">仅显示最近 30 个已记录日期，共收到 {count(data.daily.length)} 项。</p>}
    </section>
  </>
}

/** Keep this host mounted after first open; closing only removes the modal presentation. */
export function UsageOverviewModal({ open, api, onClose }: UsageOverviewModalProps): ReactElement | null {
  const [year, setYear] = useState('')
  const [month, setMonth] = useState('')
  const [date, setDate] = useState('')
  const [startDay, setStartDay] = useState(readStartDay)
  const [saveError, setSaveError] = useState(false)
  const query = useMemo<UsageOverviewQuery | undefined>(() => !year && !month && !date && startDay === 1 ? undefined : {
    ...(year ? { year } : month ? { month } : date ? { date } : {}), startDay
  }, [year, month, date, startDay])
  const overview = useUsageOverview(open, api, query)
  const filterOptions = (available: string[] | undefined, selected: string): { value: string; label: string }[] => [
    { value: '', label: '全部时间' },
    ...[...new Set([...(available ?? []), ...(selected ? [selected] : [])])]
      .sort((left, right) => right.localeCompare(left)).map(value => ({ value, label: value }))
  ]
  const changePeriod = (field: 'year' | 'month' | 'date', value: string): void => {
    if (field === 'year' || value) setYear(field === 'year' ? value : '')
    if (field === 'month' || value) setMonth(field === 'month' ? value : '')
    if (field === 'date' || value) setDate(field === 'date' ? value : '')
  }
  const changeStartDay = (value: string): void => {
    setStartDay(Number(value))
    try { localStorage.setItem(START_DAY_KEY, value); setSaveError(false) }
    catch { setSaveError(true) }
  }
  if (!open) return null
  return <OperationsModal kind="stats" onClose={onClose}>
    <div className="usage-overview">
      <div className="usage-overview-toolbar">
        <span>{overview.data ? `上次采集：${timestamp(overview.data.collectedAt)}` : '长期本地账本'}</span>
        <button type="button" className="usage-overview-refresh" disabled={overview.loading || !overview.available} onClick={overview.refresh}>
          <RefreshCw size={13} aria-hidden="true" />{overview.loading ? '读取中…' : '刷新'}
        </button>
      </div>
      <div className="usage-overview-filters" role="group" aria-label="账期筛选">
        <label>年份<PionSelect ariaLabel="年份" value={year} options={filterOptions(overview.data?.availableYears, year)} onValueChange={value => changePeriod('year', value)} /></label>
        <label>月份<PionSelect ariaLabel="月份" value={month} options={filterOptions(overview.data?.availableMonths, month)} onValueChange={value => changePeriod('month', value)} /></label>
        <label>日期<PionSelect ariaLabel="日期" value={date} options={filterOptions(overview.data?.availableDates, date)} onValueChange={value => changePeriod('date', value)} /></label>
        <label>账期起始日<PionSelect ariaLabel="账期起始日" value={String(startDay)} options={START_DAY_OPTIONS} onValueChange={changeStartDay} /></label>
      </div>
      {saveError && <p className="usage-overview-error" role="alert">起始日未保存，当前选择仍生效。</p>}
      {overview.loading && <p className="usage-overview-note" role="status">{overview.slow ? '仍在读取，可随时关闭；实际读取结束前不会重试。' : '正在读取本地使用记录…'}{overview.data && ' 当前显示上次成功快照。'}</p>}
      {overview.error && <p className="usage-overview-error" role="alert">{overview.error}</p>}
      {!overview.data && !overview.loading && !overview.error && <p className="usage-overview-note" role="status">尚无可显示的快照，请点击刷新读取。关闭期间的旧读取结果不会发布到本次面板。</p>}
      {overview.data && <OverviewData data={overview.data} />}
      <section className="usage-overview-section usage-overview-scope" aria-label="统计口径">
        <h3>统计口径</h3>
        <p>SDK 估算费用并非实际账单，$0 不代表免费；覆盖不足时仅为已知记录，不将缺失或未知补零。</p>
        <p>费用与 Token 保存到长期本地账本，采集后删除会话仍保留；复制/分叉按来源记录去重。数据仅在本地保存，不外发。</p>
        <p>历史补录包含 Pion 与共用 SDK 会话根中仍可读取的记录；已删除且从未采集、未落盘用量及生图额度不在内。工具汇总未知用量不归属父模型。</p>
      </section>
    </div>
  </OperationsModal>
}
