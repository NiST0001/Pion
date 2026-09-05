import type { ReactElement } from 'react'
import { Loader2, ShieldAlert, ShieldOff } from 'lucide-react'
import type { ProjectTrustInfo } from '../../../../shared/types'

export function ProjectTrustBanner({
  trust,
  busy,
  error,
  onDecision
}: {
  trust: ProjectTrustInfo | null
  busy: boolean
  error: string
  onDecision: (decision: boolean) => void
}): ReactElement | null {
  if (!trust?.requiresTrust || trust.decision === 'trusted') return null

  const pending = trust.decision === 'ask'
  return (
    <div className={`project-trust-banner project-trust-${trust.decision}`} role="status">
      <div className="project-trust-icon">
        {pending ? <ShieldAlert size={17} /> : <ShieldOff size={17} />}
      </div>
      <div className="project-trust-copy">
        <strong>{pending ? '此项目需要信任确认' : '项目本地 Pi 资源未加载'}</strong>
        <span>
          {pending
            ? '项目包含本地 Pi 配置、技能或扩展。选择信任后才会加载并执行这些资源。'
            : 'Pi 已跳过项目内的配置、技能、提示词和扩展。全局资源仍可正常使用。'}
        </span>
        <small>项目信任不是沙箱；Agent 工具仍以当前系统用户权限运行。</small>
        {error && <small className="project-trust-error">{error}</small>}
      </div>
      <div className="project-trust-actions">
        {pending && (
          <button
            type="button"
            className="project-trust-decline"
            disabled={busy}
            onClick={() => onDecision(false)}
          >
            不信任并继续
          </button>
        )}
        <button
          type="button"
          className="project-trust-approve"
          disabled={busy}
          onClick={() => onDecision(true)}
        >
          {busy && <Loader2 size={12} className="spin" />}
          {pending ? '信任项目' : '信任并重新加载'}
        </button>
      </div>
    </div>
  )
}
