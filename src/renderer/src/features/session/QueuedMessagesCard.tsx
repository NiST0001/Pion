import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Clock3, MessageSquare, Pencil, Send, Trash2, Zap } from 'lucide-react'
import { loadPanelExpanded, savePanelExpanded } from '../../utils/sessionPanelPreferences'
import { QUEUE_ADMISSION_ERROR_MESSAGES, projectQueueAdmissionErrors, type QueuedMessageAdmissionError } from '../../../../shared/types'

type QueueKind = 'steering' | 'followUp'

interface QueueItem {
  kind: QueueKind
  text: string
  index: number
  runId: string | null
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
  nativeFollowUpCount = 0,
  controlsDisabled = false,
  followUpRunIds = [],
  admissionErrors = [],
  agentBusy = false,
  onSendItem,
  onEditItem,
  onRemoveItem
}: {
  sessionKey: string
  steering?: string[]
  followUp?: string[]
  /** Leading followUp entries owned by Pi's native queue (display-only). */
  nativeFollowUpCount?: number
  controlsDisabled?: boolean
  followUpRunIds?: (string | null)[]
  admissionErrors?: QueuedMessageAdmissionError[]
  agentBusy?: boolean
  onSendItem?: (kind: QueueKind, index: number, runId: string) => void | Promise<void>
  onEditItem?: (item: QueueItem) => void | Promise<void>
  onRemoveItem?: (kind: QueueKind, index: number, runId: string) => void | Promise<void>
}): ReactElement | null {
  const items: QueueItem[] = [
    ...steering.map((text, index) => ({ kind: 'steering' as const, text, index, runId: null })),
    ...followUp.map((text, index) => ({ kind: 'followUp' as const, text, index,
      runId: index >= nativeFollowUpCount ? followUpRunIds[index] ?? null : null }))
  ]
  const errors = new Map(projectQueueAdmissionErrors(admissionErrors, items.map(item => item.runId))
    .map(error => [error.runId, QUEUE_ADMISSION_ERROR_MESSAGES[error.code]]))
  const [expanded, setExpanded] = useState(() => loadPanelExpanded('queue', sessionKey))
  const [sendingKey, setSendingKey] = useState<string | null>(null)
  const expandedHeight = Math.min(360, Math.max(102, 52 + items.length * 34 + errors.size * 32))
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
    savePanelExpanded('queue', sessionKey, expanded)
  }, [sessionKey, expanded])

  const handleSendItem = async (item: QueueItem): Promise<void> => {
    if (!onSendItem || controlsDisabled || item.kind !== 'followUp' || !item.runId || sendingKey !== null) return
    const key = `${sessionKey}\u0000${item.runId}`
    setSendingKey(key)
    try {
      await onSendItem(item.kind, item.index, item.runId)
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
              // Native steering has already been dispatched; only identified
              // Pion-local follow-ups support queue mutations.
              const local = !isSteering && item.index >= nativeFollowUpCount
              const actionable = local && Boolean(item.runId?.trim())
              const error = actionable && item.runId ? errors.get(item.runId) : undefined
              return (
                <div
                  key={item.runId ?? `${item.kind}-${item.index}-${item.text}`}
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
                    <span className="queue-item-message">
                      <span className="queue-item-text">{text}</span>
                      {error && <span className="queue-item-admission-error" role="status">{error}</span>}
                    </span>
                  </span>
                  {onEditItem && (
                    <button
                      type="button"
                      className="queue-item-action"
                      aria-label={`编辑第 ${index + 1} 条排队消息`}
                      title={item.runId ? '退回到输入框编辑' : '这条消息暂不支持编辑'}
                      disabled={controlsDisabled || !actionable || sendingKey !== null}
                      onClick={(event) => {
                        event.stopPropagation()
                        void onEditItem(item)
                      }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                  )}
                  {local && onRemoveItem && (
                    <button
                      type="button"
                      className="queue-item-action queue-item-remove"
                      aria-label={`删除第 ${index + 1} 条排队消息`}
                      title={actionable ? '删除这条排队消息' : '这条消息暂不支持删除'}
                      disabled={controlsDisabled || !actionable || sendingKey !== null}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (item.runId) void onRemoveItem(item.kind, item.index, item.runId)
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="queue-item-send"
                    aria-label={`直接发送第 ${index + 1} 条排队消息`}
                    title={actionable ? '直接发送' : '这条消息暂不支持直接发送'}
                    disabled={controlsDisabled || !actionable || !onSendItem || sendingKey !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleSendItem(item)
                    }}
                  >
                    {sendingKey === `${sessionKey}\u0000${item.runId}`
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
