import type { ReactElement } from 'react'
import { FileText } from 'lucide-react'
import type { SessionInfo } from '../../../../shared/types'
import { PageHeading } from './SettingsPageHeading'
import { SettingsInfoRow } from './SettingsInfoRow'

interface DiagnosticsPageProps {
  session: Pick<SessionInfo, 'sessionId' | 'sessionFile' | 'messageCount' | 'model'> | null
  stderr: string
  onRefreshStderr: () => void
}

export function DiagnosticsPage({
  session,
  stderr,
  onRefreshStderr
}: DiagnosticsPageProps): ReactElement {
  return (
    <section key="diagnostics" className="settings-page">
      <PageHeading
        kicker="DIAGNOSTICS"
        title="诊断"
        description="查看当前 agent 状态和 RPC 子进程的 stderr 输出。"
      />
      <div className="diagnostics-grid">
        <SettingsInfoRow label="会话 ID" value={session?.sessionId?.slice(0, 16) ?? '—'} mono />
        <SettingsInfoRow label="工作目录" value={session?.sessionFile ?? '—'} mono />
        <SettingsInfoRow label="消息数量" value={String(session?.messageCount ?? 0)} />
        <SettingsInfoRow label="当前模型" value={session?.model ?? '—'} />
      </div>
      <div className="settings-section diagnostics-log">
        <div className="diagnostics-log-head">
          <div>
            <div className="settings-section-title">agent stderr</div>
            <div className="setting-desc">仅显示最近 6000 个字符</div>
          </div>
          <button type="button" className="ghost-button" onClick={onRefreshStderr}>
            <FileText size={12} /> 刷新日志
          </button>
        </div>
        {stderr === '' ? (
          <div className="diagnostics-empty">点击“刷新日志”读取子进程输出。</div>
        ) : (
          <pre className="settings-stderr">{stderr}</pre>
        )}
      </div>
    </section>
  )
}
