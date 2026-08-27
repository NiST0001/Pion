import type { ReactElement } from 'react'
import type { TimelineItem } from '../hooks/useAgent'

export function ChatMessage({ item }: { item: Extract<TimelineItem, { kind: 'assistant' | 'user' }> }): ReactElement | null {
  if (item.kind === 'user') {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">{item.text}</div>
      </div>
    )
  }

  return (
    <div className="row row-assistant">
      <div className="bubble bubble-assistant">
        {item.thinking !== '' && (
          <details className="thinking">
            <summary>思考过程</summary>
            <pre>{item.thinking}</pre>
          </details>
        )}
        {item.text !== '' && <div className="assistant-text">{item.text}</div>}
        {item.streaming && <span className="caret" />}
        {item.error && <div className="bubble-error">{item.error}</div>}
      </div>
    </div>
  )
}
