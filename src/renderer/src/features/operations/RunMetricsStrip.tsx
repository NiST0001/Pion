import { useEffect, useMemo, useState } from 'react'
import { Activity, ChevronDown, Clock3, Gauge, Wrench, Zap } from 'lucide-react'
import type { ReactElement } from 'react'
import type { RunOperation, TokenUsage } from '../../../../shared/types'

const ACTIVE_STATES = new Set<RunOperation['state']>(['queued', 'dispatching', 'running', 'ending'])

function sumUsage(total: TokenUsage, live?: TokenUsage): TokenUsage {
  if (!live) return total
  return {
    input: total.input + live.input,
    output: total.output + live.output,
    cacheRead: total.cacheRead + live.cacheRead,
    cacheWrite: total.cacheWrite + live.cacheWrite,
    reasoning: total.reasoning + live.reasoning,
    total: total.total + live.total,
    costUsd: total.costUsd + live.costUsd
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
  return String(Math.round(tokens))
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`
}

function stateLabel(state: RunOperation['state']): string {
  switch (state) {
    case 'queued': return '已排队'
    case 'dispatching': return '正在发送'
    case 'running': return '运行中'
    case 'ending': return '正在收尾'
    case 'completed': return '已完成'
    case 'aborted': return '已中止'
    case 'failed': return '失败'
    case 'interrupted': return '待恢复'
    case 'discarded': return '已忽略'
  }
}

export interface SessionTotals {
  duration: number
  usage: TokenUsage
}

export function RunMetricsStrip({
  run,
  sessionTotals,
  showDuration = true,
  showCost = false
}: {
  run: RunOperation | null
  sessionTotals?: SessionTotals | null
  showDuration?: boolean
  showCost?: boolean
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const active = Boolean(run && ACTIVE_STATES.has(run.state))

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  useEffect(() => setExpanded(false), [run?.id])

  const metrics = useMemo(() => {
    if (!run) return null
    const usage = sumUsage(run.usage, run.liveUsage)
    const started = run.agentStartedAt ?? run.dispatchedAt ?? run.createdAt
    const ended = run.settledAt ?? run.interruptedAt ?? now
    const toolDuration = run.tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0)
    return { usage, duration: Math.max(0, ended - started), toolDuration }
  }, [now, run])

  if (!run || !metrics) return null
  const pressure = run.contextPressure === undefined
    ? null
    : Math.max(0, Math.min(run.contextPressure, 1.5))
  const cost = metrics.usage.costUsd

  return (
    <section className={`run-metrics-strip state-${run.state}${expanded ? ' expanded' : ''}`} aria-label="运行指标">
      <button
        type="button"
        className="run-metrics-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="run-metrics-state">
          <Activity size={13} />
          <span>{stateLabel(run.state)}</span>
        </span>
        {showDuration && <span className="run-metric"><Clock3 size={12} />{formatDuration(metrics.duration)}</span>}
        <span className="run-metric" title={`输入 ${metrics.usage.input} / 输出 ${metrics.usage.output}`}>
          <Zap size={12} />{formatTokens(metrics.usage.total)} tokens
        </span>
        {showCost && cost > 0 && <span className="run-metric">${cost.toFixed(cost < 0.01 ? 4 : 3)}</span>}
        {pressure !== null && (
          <span
            className={`run-metric${pressure >= 0.8 ? ' pressure-high' : ''}`}
            title={run.contextTokens !== undefined && run.contextWindow !== undefined
              ? `上下文 ${formatTokens(run.contextTokens)} / ${formatTokens(run.contextWindow)}`
              : '最近一次模型请求的上下文占用'}
          >
            <Gauge size={12} />{Math.round(pressure * 100)}%
          </span>
        )}
        {sessionTotals && (
          <span
            className="run-metric run-metric-session"
            title={`整个会话累计：输入 ${sessionTotals.usage.input} / 输出 ${sessionTotals.usage.output} / 缓存 ${sessionTotals.usage.cacheRead}`}
          >
            <span className="run-metric-session-label">会话</span>
            {showDuration && formatDuration(sessionTotals.duration)}
            {showDuration && ' · '}
            {formatTokens(sessionTotals.usage.total)}
            {showCost && sessionTotals.usage.costUsd > 0 && ` · $${sessionTotals.usage.costUsd.toFixed(sessionTotals.usage.costUsd < 0.01 ? 4 : 3)}`}
          </span>
        )}
        <ChevronDown size={13} className="run-metrics-chevron" />
      </button>

      {expanded && (
        <div className="run-metrics-detail">
          <div className="run-metrics-grid">
            <span><small>输入</small><strong>{formatTokens(metrics.usage.input)}</strong></span>
            <span><small>输出</small><strong>{formatTokens(metrics.usage.output)}</strong></span>
            <span><small>缓存读取</small><strong>{formatTokens(metrics.usage.cacheRead)}</strong></span>
            <span><small>推理</small><strong>{formatTokens(metrics.usage.reasoning)}</strong></span>
            <span>
              <small>上下文</small>
              <strong>{run.contextTokens !== undefined
                ? `${formatTokens(run.contextTokens)}${run.contextWindow !== undefined ? ` / ${formatTokens(run.contextWindow)}` : ''}`
                : '未知'}</strong>
            </span>
            <span><small>费用</small><strong>{cost > 0 ? `$${cost.toFixed(cost < 0.01 ? 4 : 3)}` : '$0'}</strong></span>
            <span><small>工具</small><strong>{run.tools.length}</strong></span>
            <span><small>工具耗时</small><strong>{formatDuration(metrics.toolDuration)}</strong></span>
            <span><small>压缩</small><strong>{run.compactions.length}</strong></span>
            <span><small>模型</small><strong title={run.modelId}>{run.modelId ?? '未知'}</strong></span>
          </div>
          {pressure !== null && (
            <div className="run-context-meter" aria-label={`上下文占用 ${Math.round(pressure * 100)}%`}>
              <span style={{ width: `${Math.min(100, pressure * 100)}%` }} />
            </div>
          )}
          {run.tools.length > 0 && (
            <div className="run-tool-summary">
              <Wrench size={12} />
              {run.tools.slice(-4).map((tool) => (
                <span key={tool.toolCallId} className={`tool-${tool.state}`}>
                  {tool.name} · {tool.durationMs === undefined ? '…' : formatDuration(tool.durationMs)}
                </span>
              ))}
            </div>
          )}
          {(run.error || run.stopReason) && (
            <div className="run-metrics-note">{run.error || `停止原因：${run.stopReason}`}</div>
          )}
        </div>
      )}
    </section>
  )
}
