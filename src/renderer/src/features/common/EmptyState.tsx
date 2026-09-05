import type { ReactElement } from 'react'
import { FolderOpen, Sparkles } from 'lucide-react'

export function EmptyState({
  cwd,
  starting,
  loadingHistory,
  hasSessions
}: {
  cwd?: string
  starting: boolean
  loadingHistory: boolean
  hasSessions: boolean
}): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Sparkles size={40} />
      </div>
      <h2>{loadingHistory ? '正在加载会话…' : starting ? '正在启动 agent…' : 'Pion 已就绪'}</h2>
      <p>
        {cwd ? (
          <>
            工作目录 <code>{cwd}</code>
            {loadingHistory
              ? '。正在直接读取会话历史，无需等待 Agent 后台启动。'
              : hasSessions
                ? '。左侧选择历史会话继续，或直接开始新对话。'
                : '。发送一条消息开始。'}
          </>
        ) : (
          '点击左上角「+」添加项目目录'
        )}
      </p>
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
