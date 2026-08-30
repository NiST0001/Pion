import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Loader2,
  Play,
  RotateCw,
  ShieldCheck,
  Square,
  Wrench
} from 'lucide-react'
import type { ReactElement } from 'react'
import type {
  VerificationKind,
  VerificationPlan,
  VerificationPolicy,
  VerificationRun
} from '../../../shared/types'

const KIND_LABELS: Record<VerificationKind, string> = {
  typecheck: '类型',
  lint: 'Lint',
  test: '测试',
  build: '构建'
}

function stateLabel(run: VerificationRun | null): string {
  if (!run) return '尚未运行'
  switch (run.state) {
    case 'queued': return '等待运行'
    case 'running': return '验证中'
    case 'passed': return '全部通过'
    case 'failed': return '验证失败'
    case 'cancelled': return '已停止'
    case 'interrupted': return '验证被中断'
    case 'infrastructure-error': return '验证环境错误'
  }
}

function duration(run: VerificationRun): string {
  const start = run.startedAt ?? run.createdAt
  const end = run.finishedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function VerificationPanel({
  embedded = false,
  plan,
  policy,
  run,
  activeRun,
  liveLog,
  loading,
  busy,
  error,
  onStart,
  onRerun,
  onCancel,
  onPolicyChange,
  onRepair
}: {
  embedded?: boolean
  plan: VerificationPlan | null
  policy: VerificationPolicy | null
  run: VerificationRun | null
  activeRun: VerificationRun | null
  liveLog: string
  loading: boolean
  busy: boolean
  error: string
  onStart: (kinds?: VerificationKind[]) => void
  onRerun: (runId: string) => void
  onCancel: (runId: string) => void
  onPolicyChange: (updates: Partial<Omit<VerificationPolicy, 'cwd'>>) => void
  onRepair: (prompt: string) => void
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const detailVisible = embedded || expanded
  useEffect(() => {
    if (run?.state === 'failed' || run?.state === 'infrastructure-error') setExpanded(true)
  }, [run?.id, run?.state])

  const output = useMemo(() => {
    if (liveLog) return liveLog
    if (!run) return ''
    return run.steps.map((step) => step.outputTail).filter(Boolean).join('\n').slice(-24_000)
  }, [liveLog, run])

  if (!embedded && !loading && !plan && !run && !error) return null
  const steps = plan?.steps ?? []
  const selectedKinds = policy?.selectedKinds ?? steps.map((step) => step.kind)
  const runnable = steps.filter((step) => selectedKinds.includes(step.kind))
  const running = activeRun?.state === 'running' || activeRun?.state === 'queued'
  const summaryContent = (
    <>
      {run?.state === 'passed' ? <CheckCircle2 size={14} />
        : run?.state === 'failed' || run?.state === 'infrastructure-error' ? <CircleAlert size={14} />
          : running ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
      <strong>验证</strong>
      <span>{stateLabel(run)}</span>
      {run && <span>· {duration(run)}</span>}
      {!embedded && <ChevronDown size={13} className="verification-chevron" />}
    </>
  )

  return (
    <section className={`verification-panel state-${run?.state ?? 'idle'}${detailVisible ? ' expanded' : ''}${embedded ? ' embedded' : ''}`} aria-label="自动验证">
      <div className="verification-summary-row">
        {embedded ? (
          <div className="verification-summary verification-summary-static">{summaryContent}</div>
        ) : (
          <button
            type="button"
            className="verification-summary"
            aria-expanded={detailVisible}
            onClick={() => setExpanded((value) => !value)}
          >
            {summaryContent}
          </button>
        )}
        <div className="verification-primary-actions">
          {running && activeRun ? (
            <button type="button" className="verification-stop" disabled={busy} onClick={() => onCancel(activeRun.id)}>
              <Square size={11} />停止
            </button>
          ) : run ? (
            <button type="button" disabled={busy || runnable.length === 0} onClick={() => onRerun(run.id)}>
              <RotateCw size={11} />重跑
            </button>
          ) : (
            <button type="button" disabled={busy || loading || runnable.length === 0} onClick={() => onStart(selectedKinds)}>
              <Play size={11} />运行
            </button>
          )}
        </div>
      </div>

      {detailVisible && (
        <div className="verification-detail">
          {loading && !plan && (
            <div className="verification-empty"><Loader2 size={13} className="spin" />正在发现项目验证命令…</div>
          )}
          {!loading && !plan && !run && !error && (
            <div className="verification-empty">未发现 typecheck、lint、test 或 build 命令。</div>
          )}
          <div className="verification-options">
            <div className="verification-kinds" aria-label="验证步骤">
              {steps.map((step) => {
                const selected = selectedKinds.includes(step.kind)
                return (
                  <button
                    type="button"
                    key={step.id}
                    aria-pressed={selected}
                    disabled={running || busy || (selected && selectedKinds.length === 1)}
                    onClick={() => onPolicyChange({
                      selectedKinds: selected
                        ? selectedKinds.filter((kind) => kind !== step.kind)
                        : [...selectedKinds, step.kind]
                    })}
                    title={`${step.executable} ${step.args.join(' ')} · ${step.source}`}
                  >
                    {KIND_LABELS[step.kind]}
                  </button>
                )
              })}
            </div>
            {policy && (
              <div className="verification-toggles">
                <button
                  type="button"
                  className={policy.autoRun ? 'active' : ''}
                  aria-pressed={policy.autoRun}
                  disabled={busy}
                  title="每轮 Agent 完成后执行已选择的项目脚本。项目脚本会以当前用户权限运行。"
                  onClick={() => onPolicyChange({ autoRun: !policy.autoRun })}
                >每轮自动</button>
                <button
                  type="button"
                  className={policy.autoRepair ? 'active' : ''}
                  aria-pressed={policy.autoRepair}
                  disabled={busy || !policy.autoRun}
                  title="验证失败后最多自动启动两轮 Agent 修复；仍遵循工具权限。"
                  onClick={() => onPolicyChange({ autoRepair: !policy.autoRepair })}
                >失败自动修复</button>
              </div>
            )}
          </div>

          {run && (
            <div className="verification-steps">
              {run.steps.map((step) => (
                <div key={step.id} className={`verification-step state-${step.state}`}>
                  <span className="verification-step-state" />
                  <strong>{KIND_LABELS[step.kind]}</strong>
                  <span>{step.label}</span>
                  {step.durationMs !== undefined && <small>{Math.round(step.durationMs / 100) / 10}s</small>}
                </div>
              ))}
            </div>
          )}

          {output && <pre className="verification-log" aria-label="验证日志">{output}</pre>}
          {error && <div className="verification-error">{error}</div>}
          {plan?.warnings.map((warning) => <div className="verification-warning" key={warning}>{warning}</div>)}

          {run?.state === 'failed' && run.repairPrompt && (
            <div className="verification-repair">
              <span>可以把精简后的失败日志交回当前 Agent。</span>
              <button type="button" onClick={() => onRepair(run.repairPrompt as string)}>
                <Wrench size={11} />交给 Agent 修复
              </button>
            </div>
          )}
          {policy?.autoRun && (
            <div className="verification-security-note">
              自动验证会执行项目定义的脚本；它是验证机制，不是系统沙箱。
            </div>
          )}
        </div>
      )}
    </section>
  )
}
