import type { ReactElement } from 'react'
import { Loader2, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import type {
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  ToolPermissionCategory,
  ToolPermissionDecision
} from '../../../../shared/types'
import { PageHeading } from './SettingsPageHeading'
import { ToolPermissionSettings } from './ToolPermissionSettings'

interface SecurityPageProps {
  projectTrust: ProjectTrustInfo | null
  projectTrustBusy: boolean
  projectTrustError: string
  onProjectTrustChange: (decision: boolean | null) => void
  toolPermissionPolicy: ProjectToolPermissionPolicy | null
  toolPermissionBusy: boolean
  toolPermissionError: string
  onToolPermissionChange: (category: ToolPermissionCategory, decision: ToolPermissionDecision) => void
  onToolPermissionReset: () => void
}

export function SecurityPage({
  projectTrust,
  projectTrustBusy,
  projectTrustError,
  onProjectTrustChange,
  toolPermissionPolicy,
  toolPermissionBusy,
  toolPermissionError,
  onToolPermissionChange,
  onToolPermissionReset
}: SecurityPageProps): ReactElement {
  return (
    <section key="security" className="settings-page security-page">
      <PageHeading
        kicker="SECURITY"
        title="安全与信任"
        description="控制项目本地 Pi 资源加载，以及 Agent 工具调用前的允许、询问与拒绝策略。"
      />

      <div
        className={`project-trust-card project-trust-card-${projectTrust?.decision ?? 'unknown'}`}
        data-setting="project-trust"
      >
        <div className="project-trust-card-icon">
          {projectTrust?.decision === 'trusted'
            ? <ShieldCheck size={20} />
            : projectTrust?.decision === 'untrusted'
              ? <ShieldOff size={20} />
              : <ShieldAlert size={20} />}
        </div>
        <div className="project-trust-card-copy">
          <span>当前项目</span>
          <strong>{projectTrustLabel(projectTrust)}</strong>
          <small title={projectTrust?.cwd}>{projectTrust?.cwd ?? '尚未选择项目'}</small>
        </div>
      </div>

      {projectTrustError && <div className="settings-inline-error">{projectTrustError}</div>}

      <div className="settings-section">
        <div className="settings-section-title">项目资源</div>
        <div className="setting-row setting-row-stacked">
          <div>
            <div className="setting-label">Pi 项目信任</div>
            <div className="setting-desc">{projectTrustDescription(projectTrust)}</div>
          </div>
          {projectTrust?.requiresTrust && (
            <div className="project-trust-settings-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={projectTrustBusy || projectTrust.decision === 'untrusted'}
                onClick={() => onProjectTrustChange(false)}
              >
                <ShieldOff size={12} /> 不信任
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={projectTrustBusy || projectTrust.source === 'default' || projectTrust.source === 'inherited' || projectTrust.source === 'not-required'}
                onClick={() => onProjectTrustChange(null)}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="ghost-button project-trust-settings-approve"
                disabled={projectTrustBusy || projectTrust.decision === 'trusted'}
                onClick={() => onProjectTrustChange(true)}
              >
                {projectTrustBusy && <Loader2 size={12} className="spin" />}
                <ShieldCheck size={12} /> 信任项目
              </button>
            </div>
          )}
        </div>
      </div>

      <ToolPermissionSettings
        policy={toolPermissionPolicy}
        busy={toolPermissionBusy}
        error={toolPermissionError}
        onChange={onToolPermissionChange}
        onReset={onToolPermissionReset}
      />

      <div className="settings-note security-note">
        <ShieldAlert size={14} />
        项目信任与工具确认都是策略保护层，不是文件、命令或网络沙箱；真正隔离仍需要容器或虚拟机。
      </div>
    </section>
  )
}

function projectTrustLabel(trust: ProjectTrustInfo | null): string {
  if (!trust) return '等待状态'
  if (!trust.requiresTrust) return '无需额外授权'
  if (trust.decision === 'trusted') return '已信任项目资源'
  if (trust.decision === 'untrusted') return '未信任项目资源'
  return '等待你的决定'
}

function projectTrustDescription(trust: ProjectTrustInfo | null): string {
  if (!trust) return '选择项目后显示信任状态。'
  if (!trust.requiresTrust) return '当前项目没有需要信任确认的本地 Pi 资源。'
  if (trust.decision === 'trusted') {
    return '项目的 .pi 设置、技能、提示词、软件包和扩展会在 Agent 启动时加载。'
  }
  if (trust.decision === 'untrusted') {
    return '项目本地资源会被跳过；用户级和命令行扩展仍然可用。'
  }
  return '首次运行 Agent 前必须选择是否加载项目提供的本地资源。'
}
