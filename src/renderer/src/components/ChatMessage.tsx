import type { ReactElement } from 'react'
import { GitBranch, User as UserIcon } from 'lucide-react'
import type { TimelineItem } from '../hooks/useAgent'
import { Markdown } from './Markdown'

interface ChatMessageProps {
  item: Extract<TimelineItem, { kind: 'assistant' | 'user' }>
  onFork?: (entryId: string) => void
  canFork: boolean
}

export function ChatMessage({ item, onFork, canFork }: ChatMessageProps): ReactElement | null {
  if (item.kind === 'user') {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">
          <div className="bubble-content">{item.text}</div>
          {canFork && item.entryId && (
            <button
              className="fork-button"
              title="从此消息分叉新分支"
              onClick={() => onFork?.(item.entryId as string)}
            >
              <GitBranch size={12} />
              分叉
            </button>
          )}
        </div>
        <div className="avatar avatar-user">
          <UserIcon size={14} />
        </div>
      </div>
    )
  }

  return (
    <div className="row row-assistant">
      <div className="avatar avatar-assistant">π</div>
      <div className="bubble bubble-assistant">
        {item.thinking !== '' && (
          <details className="thinking">
            <summary>思考过程</summary>
            <pre>{item.thinking}</pre>
          </details>
        )}
        {item.text !== '' && <Markdown text={item.text} />}
        {item.streaming && item.text === '' && item.thinking === '' && (
          <span className="typing">
            <span />
            <span />
            <span />
          </span>
        )}
        {item.streaming && item.text !== '' && <span className="caret" />}
        {item.error && <div className="bubble-error">{item.error}</div>}
      </div>
    </div>
  )
}
