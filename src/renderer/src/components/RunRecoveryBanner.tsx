import { useState } from 'react'
import { AlertTriangle, Loader2, Play, RotateCcw, X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { RunRecoveryCandidate } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'

export function RunRecoveryBanner({
  candidates,
  busyId,
  agentBusy,
  error,
  onResume,
  onDiscard,
  onRestoreCheckpoint
}: {
  candidates: RunRecoveryCandidate[]
  busyId: string | null
  agentBusy: boolean
  error: string
  onResume: (runId: string) => void
  onDiscard: (runId: string) => void
  onRestoreCheckpoint: (runId: string) => void
}): ReactElement | null {
  const [restoreCandidate, setRestoreCandidate] = useState<RunRecoveryCandidate | null>(null)
  const candidate = candidates[0]
  if (!candidate) return null
  const busy = busyId === candidate.run.id
  const queued = candidate.reason === 'queued-prompt'

  return (
    <>
      <section className="run-recovery-banner" aria-label="运行恢复">
        <div className="run-recovery-icon"><AlertTriangle size={15} /></div>
        <div className="run-recovery-copy">
          <div className="run-recovery-title">
            <strong>{queued ? '发现未完成的排队消息' : '发现中断的运行'}</strong>
            {candidates.length > 1 && <span>另有 {candidates.length - 1} 条</span>}
          </div>
          <p>{candidate.note}</p>
          {candidate.run.promptPreview && <blockquote>{candidate.run.promptPreview}</blockquote>}
          {error && <div className="run-recovery-error">{error}</div>}
        </div>
        <div className="run-recovery-actions">
          {candidate.canRestoreCheckpoint && (
            <button
              type="button"
              className="run-recovery-secondary"
              disabled={busy || agentBusy}
              onClick={() => setRestoreCandidate(candidate)}
              title="恢复到这轮运行开始前的 Git 工作区和暂存区"
            >
              <RotateCcw size={12} />恢复修改
            </button>
          )}
          <button
            type="button"
            className="run-recovery-secondary"
            disabled={busy}
            onClick={() => onDiscard(candidate.run.id)}
          >
            <X size={12} />忽略
          </button>
          <button
            type="button"
            className="run-recovery-primary"
            disabled={busy || agentBusy || !candidate.canResume}
            onClick={() => onResume(candidate.run.id)}
          >
            {busy ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
            {queued ? '恢复队列' : '安全续接'}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={restoreCandidate !== null}
        title="恢复运行前的工作区？"
        message="这会将非忽略文件和 Git 暂存区恢复到本轮运行开始前。"
        detail="当前新增和修改的非忽略文件会被替换；运行中的 Agent 不会被强制中止。"
        confirmLabel="恢复检查点"
        busy={restoreCandidate !== null && busyId === restoreCandidate.run.id}
        onCancel={() => setRestoreCandidate(null)}
        onConfirm={() => {
          if (!restoreCandidate) return
          onRestoreCheckpoint(restoreCandidate.run.id)
          setRestoreCandidate(null)
        }}
      />
    </>
  )
}
