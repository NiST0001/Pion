import type { ReactElement } from 'react'
import { GitBranch } from 'lucide-react'
import type { TimelineItem } from '../agent/types'
import { Markdown } from './Markdown'

interface ChatMessageProps {
  item: Extract<TimelineItem, { kind: 'assistant' | 'user' }>
  onFork?: (entryId: string) => void
  canFork: boolean
}

export function ChatMessage({ item, onFork, canFork }: ChatMessageProps): ReactElement | null {
  if (item.kind === 'user') {
    return (
      <div className={`row row-user${item.historical ? ' history-reveal' : ''}`} data-entry-id={item.entryId}>
        <div className="bubble bubble-user">
          {item.text !== '' && <div className="bubble-content">{item.text}</div>}
          {item.images && item.images.length > 0 && (
            <div className="message-images" aria-label="消息中的图像">
              {item.images.map((image, index) => (
                <img
                  key={`${image.mimeType}:${index}`}
                  className="message-image"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`消息图像 ${index + 1}`}
                />
              ))}
            </div>
          )}
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
      </div>
    )
  }

  return (
    <div className={`row row-assistant${item.historical ? ' history-reveal' : ''}${item.streaming ? ' streaming-reveal' : ''}`}>
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
