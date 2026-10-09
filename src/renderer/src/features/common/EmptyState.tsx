import type { ReactElement } from 'react'
import { FolderOpen, Sparkles } from 'lucide-react'

export function EmptyState({
  cwd,
  starting,
  loadingHistory,
  historyError,
  historyUnloaded = false,
  onReloadHistory,
  hasSessions
}: {
  cwd?: string
  starting: boolean
  loadingHistory: boolean
  historyError?: string
  historyUnloaded?: boolean
  onReloadHistory?: () => void
  hasSessions: boolean
}): ReactElement {
  const incompleteHistory = Boolean(historyError || historyUnloaded)
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Sparkles size={40} />
      </div>
      <h2>{loadingHistory ? '正在加载会话…' : incompleteHistory ? '会话历史未加载完成' : starting ? '正在启动 agent…' : 'Pion 已就绪'}</h2>
      <p>
        {cwd ? (
          <>
            工作目录 <code>{cwd}</code>
            {loadingHistory
              ? '。正在直接读取会话历史，无需等待 Agent 后台启动。'
              : incompleteHistory
                ? onReloadHistory ? '。请重新加载会话历史。' : '。请重新选择该会话。'
                : hasSessions
                  ? '。左侧选择历史会话继续，或直接开始新对话。'
                  : '。发送一条消息开始。'}
          </>
        ) : (
          '点击左上角「+」添加项目目录'
        )}
      </p>
      {incompleteHistory && !loadingHistory && onReloadHistory && (
        <button type="button" className="btn" onClick={onReloadHistory}>重新加载</button>
      )}
      <div className="empty-tips">
        <span>
          <FolderOpen size={11} /> 侧栏管理项目
        </span>
        <span>Enter 发送</span>
        <span>↑↓ 编辑历史</span>
        <span>消息可分叉</span>
        <span>设置 ⚙ 调整行为</span>
      </div>
    </div>
  )
}
