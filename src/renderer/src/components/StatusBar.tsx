import type { ReactElement } from 'react'
import type { AgentStatus, SessionInfo } from '../../../shared/types'

const PHASE_LABEL: Record<AgentStatus['phase'], string> = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  error: '错误'
}

export function StatusBar({
  status,
  session
}: {
  status: AgentStatus
  session: SessionInfo | null
}): ReactElement {
  return (
    <div className="status-bar">
      <span className={`status-phase phase-${status.phase}`}>{PHASE_LABEL[status.phase]}</span>
      {status.cwd && <span className="status-item" title={status.cwd}>{status.cwd}</span>}
      {session && (
        <>
          {session.sessionName && <span className="status-item">{session.sessionName}</span>}
          <span className="status-item">
            消息 {session.messageCount}
            {session.pendingMessageCount ? ` (+${session.pendingMessageCount})` : ''}
          </span>
          {session.isStreaming && <span className="status-item pulse">streaming</span>}
        </>
      )}
    </div>
  )
}
