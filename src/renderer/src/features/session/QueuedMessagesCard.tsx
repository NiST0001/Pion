import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Clock3, MessageSquare, Send, Zap } from 'lucide-react'

const QUEUE_PANEL_STATE_PREFIX = 'pion:session-queue-panel-state:'

type QueueKind = 'steering' | 'followUp'

interface QueueItem {
  kind: QueueKind
  text: string
  index: number
}

function queuePanelStateKey(sessionKey: string): string {
  return `${QUEUE_PANEL_STATE_PREFIX}${encodeURIComponent(sessionKey)}`
}

function loadExpanded(sessionKey: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(queuePanelStateKey(sessionKey))
    if (raw === null) return true
    const saved = JSON.parse(raw)
    return typeof saved === 'boolean' ? saved : true
  } catch {
    return true
  }
}

function saveExpanded(sessionKey: string, expanded: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(queuePanelStateKey(sessionKey), JSON.stringify(expanded))
  } catch {
    // Queue panel state persistence is best effort and should never block the chat UI.
  }
}

function displayText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized || '(空消息)'
}

/** User messages waiting for the current agent run, shown beside the task panel. */
export function QueuedMessagesCard({
  sessionKey,
  steering = [],
  followUp = [],
  agentBusy = false,
  onSendItem
}: {
  sessionKey: string
  steering?: string[]
  followUp?: string[]
  agentBusy?: boolean
  onSendItem?: (kind: QueueKind, index: number) => void | Promise<void>
}): ReactElement | null {
  const items: QueueItem[] = [
    ...steering.map((text, index) => ({ kind: 'steering' as const, text, index })),
    ...followUp.map((text, index) => ({ kind: 'followUp' as const, text, index }))
  ]
  const [expanded, setExpanded] = useState(() => loadExpanded(sessionKey))
  const [sendingKey, setSendingKey] = useState<string | null>(null)
  const expandedHeight = Math.min(265, Math.max(102, 52 + items.length * 34))
  const panelStyle = {
    '--task-panel-expanded-height': `${expandedHeight}px`
  } as CSSProperties
  const steeringCount = steering.length
  const followUpCount = followUp.length
  const caption = steeringCount > 0 && followUpCount > 0
    ? `${steeringCount} 条插入 · ${followUpCount} 条稍后`
    : steeringCount > 0
      ? '等待插入当前运行'
      : '等待本轮完成'

  useEffect(() => {
    saveExpanded(sessionKey, expanded)
  }, [sessionKey, expanded])

  const handleSendItem = async (item: QueueItem): Promise<void> => {
    if (!onSendItem) return
    const key = `${item.kind}:${item.index}:${item.text}`
    if (sendingKey === key) return
    setSendingKey(key)
    try {
      await onSendItem(item.kind, item.index)
    } finally {
      setSendingKey((current) => current === key ? null : current)
    }
  }

  if (items.length === 0) return null

  return (
    <section
      className={`task-panel queue-panel${expanded ? ' expanded' : ' collapsed'}${agentBusy ? ' running' : ''}`}
      data-session-key={sessionKey}
      data-queue-count={items.length}
      style={panelStyle}
    >
      <div className="task-panel-card">
        <button
          type="button"
          className="task-panel-head queue-panel-head"
          aria-label={expanded ? '收起排队消息' : '展开排队消息'}
          aria-expanded={expanded}
          aria-controls="queue-message-list"
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="task-panel-summary">
            <MessageSquare size={15} />
            <span className="task-panel-title">排队消息</span>
            <span className="task-panel-count">{items.length} 条</span>
          </span>
          <span className="task-panel-caption">{caption}</span>
        </button>

        <div className="task-panel-list-shell queue-panel-list-shell">
          <div
            id="queue-message-list"
            className="task-panel-list queue-panel-list"
            role="list"
            aria-label="用户排队消息"
            aria-live="polite"
          >
            {items.map((item, index) => {
              const text = displayText(item.text)
              const isSteering = item.kind === 'steering'
              return (
                <div
                  key={`${item.kind}-${item.index}-${item.text}`}
                  className={`task-item queue-item ${isSteering ? 'queue-item-steering' : 'queue-item-follow-up'}`}
                  role="listitem"
                  data-queue-index={index + 1}
                  data-queue-kind={item.kind}
                  title={item.text}
                >
                  <span className="task-check queue-item-status" aria-hidden="true">
                    {isSteering ? <Zap size={11} /> : <Clock3 size={11} />}
                  </span>
                  <span className="task-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="queue-item-copy">
                    <span className="queue-item-kind">{isSteering ? '插入' : '稍后'}</span>
                    <span className="queue-item-text">{text}</span>
                  </span>
                  <button
                    type="button"
                    className="queue-item-send"
                    aria-label={`直接发送第 ${index + 1} 条排队消息`}
                    title="直接发送"
                    disabled={!onSendItem || sendingKey !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleSendItem(item)
                    }}
                  >
                    {sendingKey === `${item.kind}:${item.index}:${item.text}`
                      ? <span className="queue-item-send-pending" aria-hidden="true">…</span>
                      : <Send size={12} aria-hidden="true" />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
