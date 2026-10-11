import type { ReactElement } from 'react'
import type { SubagentSessionSnapshot, SubagentSessionStatus } from '../../../../shared/subagent-sessions'

export const subagentStatusLabel: Record<SubagentSessionStatus, string> = {
  starting: '准备中', running: '运行中', cancelling: '停止中', completed: '已完成', failed: '失败', aborted: '已停止'
}

export interface SubagentSessionPaneProps {
  snapshot: SubagentSessionSnapshot | null
  loading: boolean
  error: string
  onClose: () => void
  parentName?: string
}

/** Plain text only: child output cannot navigate, load images, or invoke SDK operations. */
export function SubagentSessionPane({ snapshot, loading, error, onClose, parentName }: SubagentSessionPaneProps): ReactElement {
  return (
    <section className="subagent-session-pane" aria-label="只读子会话" aria-busy={loading}>
      <header className="subagent-session-pane-header">
        <div>
          <h2>{snapshot?.name || '子代理会话'}</h2>
          <p>只读 · 临时会话 · 结束后保留 30 分钟</p>
          <p>父会话：{parentName || snapshot?.parentSessionPath || '当前父会话'}</p>
          {snapshot && <span>{subagentStatusLabel[snapshot.status]}</span>}
        </div>
        <button type="button" onClick={onClose}>返回父会话</button>
      </header>
      <div className="subagent-session-pane-scroll" tabIndex={0} aria-label="子会话内容">
        {loading && !snapshot && <p role="status">正在读取子会话…</p>}
        {error && <p role="alert">{error}</p>}
        {snapshot?.truncated && <p>仅显示有界的近期记录，部分内容已省略。</p>}
        {snapshot?.rows.map((row) => (
          row.kind === 'assistant'
            ? <div key={row.id} className="subagent-session-text">{row.text}</div>
            : <details key={row.id} className="subagent-session-details">
              <summary>{row.kind === 'thinking' ? '思考' : `工具：${row.toolName || '工具'}${row.state ? ` · ${row.state === 'running' ? '执行中' : row.state === 'failed' ? '失败' : '已完成'}` : ''}`}</summary>
              <div className="subagent-session-text">{row.text}</div>
            </details>
        ))}
        {!loading && !error && !snapshot?.rows.length && <p>暂无可显示的子会话记录。</p>}
      </div>
    </section>
  )
}
