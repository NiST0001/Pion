import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { GitBranch, Undo2 } from 'lucide-react'
import { describeModelError } from '../../agent/modelError'
import type { TimelineItem } from '../../agent/types'
import { armHistoryRevealRow } from '../../utils/historyReveal'
import {
  appendedCharacterCount,
  assignLineRevealDelay,
  assignPendingLineDelays,
  RevealLines,
  RevealText,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS,
  syncContainerRevealDelay
} from '../../utils/screenTextReveal'
import { Markdown } from './Markdown'

interface ChatMessageProps {
  item: Extract<TimelineItem, { kind: 'assistant' | 'user' }>
  onFork?: (entryId: string) => void
  canFork: boolean
  canRevert?: boolean
  onRevert?: (entryId: string) => void
  revertDisabledReason?: string
}

const ModelErrorAnnouncement = memo(function ModelErrorAnnouncement({ text }: { text: string }): ReactElement {
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    // Register an empty region first; history transitions/unmount can cancel
    // the deferred update. Only changes to the short copy trigger a new one.
    const timeout = window.setTimeout(() => setAnnouncement(text), 0)
    return () => window.clearTimeout(timeout)
  }, [text])

  return (
    <div className="bubble-error-announcement" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  )
})

export const ChatMessage = memo(function ChatMessage({
  item,
  onFork,
  canFork,
  canRevert,
  onRevert,
  revertDisabledReason
}: ChatMessageProps): ReactElement | null {
  const rowRef = useRef<HTMLDivElement>(null)
  // Paged history carries noReveal on the item itself; it never waterfalls.
  const revealSuppressed = item.noReveal === true
  const previousThinkingRef = useRef('')
  const previousErrorMessageRef = useRef('')
  const assistant = item.kind === 'assistant' ? item : undefined
  const liveOutput = Boolean(assistant?.live && !assistant.historical)
  // Display restoration must stay silent, but a restored running row can
  // continue suffix-only text/thinking animation after its history bubble fade.
  const liveStreamingReveal = Boolean(liveOutput || (assistant?.live && assistant.streaming))
  const text = assistant?.text ?? ''
  const thinking = assistant?.thinking ?? ''
  const error = assistant?.error ?? ''
  const errorContext = assistant?.errorContext
  const describedError = useMemo(() => error === '' ? undefined : describeModelError(error), [error])
  const errorMessage = describedError?.message ?? ''
  const thinkingRevealCount = liveStreamingReveal
    ? appendedCharacterCount(previousThinkingRef.current, thinking)
    : 0
  // Unrelated output/detail updates must not replace the visible summary's
  // animated text nodes.
  const errorContent = useMemo(() => {
    if (revealSuppressed) return errorMessage
    if (liveOutput) {
      return (
        <RevealText
          text={errorMessage}
          mode="live"
          revealCount={appendedCharacterCount(previousErrorMessageRef.current, errorMessage)}
        />
      )
    }
    return item.historical ? <RevealLines text={errorMessage} mode="history" /> : errorMessage
  }, [errorMessage, item.historical, liveOutput, revealSuppressed])

  useLayoutEffect(() => {
    previousThinkingRef.current = thinking
    previousErrorMessageRef.current = errorMessage
  }, [errorMessage, thinking])

  if (item.kind === 'user') {
    const entryId = item.entryId
    return (
      <div ref={rowRef} className={`row row-user${item.historical ? ' history-reveal' : ''}`} data-entry-id={item.entryId}>
        <div
          className={`bubble bubble-user${revealSuppressed ? '' : ` ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${item.historical ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}`}`}
          ref={revealSuppressed ? undefined : assignLineRevealDelay}
        >
          {item.text !== '' && (
            <div className="bubble-content">
              {item.text}
            </div>
          )}
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
          {entryId && (canFork || onRevert) && (
            <div className="message-actions">
              {canFork && (
                <button
                  type="button"
                  className="fork-button"
                  title="从此消息分叉新分支"
                  onClick={() => onFork?.(entryId)}
                >
                  <GitBranch size={12} aria-hidden="true" />
                  分叉
                </button>
              )}
              {onRevert && (
                <button
                  type="button"
                  className="revert-button"
                  disabled={!canRevert}
                  title={revertDisabledReason || '撤销到此消息之前；不回滚文件'}
                  onClick={() => onRevert(entryId)}
                >
                  <Undo2 size={12} aria-hidden="true" />
                  撤销
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // The timeline-level working status occupies this slot until the assistant
  // has actual thinking, text, or an error to show. Avoid a duplicate dots row.
  if (item.streaming && item.text === '' && item.thinking === '' && !item.error) return null

  const thinkingOnly = item.thinking !== '' && item.text === '' && !item.error

  return (
    <div ref={rowRef} className={`row row-assistant${thinkingOnly ? ' row-assistant-thinking-only' : ''}${item.historical ? ' history-reveal' : ''}${item.streaming ? ' streaming-reveal' : ''}`}>
      <div
        className={`bubble bubble-assistant${revealSuppressed ? '' : ` ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${item.historical ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}`}`}
        ref={revealSuppressed ? undefined : syncContainerRevealDelay}
      >
        {thinking !== '' && (
          <details
            className="thinking"
            data-live-output="thinking"
            onToggle={(event) => {
              if (!event.currentTarget.open) return
              const row = rowRef.current
              const container = row?.closest<HTMLElement>('.chat-scroll')
              if (!row || !container) return
              window.requestAnimationFrame(() => {
                assignPendingLineDelays(container)
                armHistoryRevealRow(row, container)
              })
            }}
          >
            <summary>思考过程</summary>
            <pre>{liveStreamingReveal ? (
              <RevealText text={thinking} mode="live" revealCount={thinkingRevealCount} />
            ) : item.historical && !revealSuppressed ? (
              <RevealLines text={thinking} mode="history" />
            ) : thinking}</pre>
          </details>
        )}
        {text !== '' && (
          <div data-live-output="assistant-text">
            <Markdown
              text={text}
              revealMode={revealSuppressed ? undefined : liveStreamingReveal ? 'live' : item.historical ? 'history' : undefined}
            />
          </div>
        )}
        {describedError && (
          <div
            className="bubble-error"
            data-error-category={describedError.category}
            data-live-output="error"
          >
            <div className="bubble-error-summary">
              {errorContext === 'compaction' && (
                <span className="bubble-error-context">上下文压缩失败</span>
              )}
              <strong className="bubble-error-title">{describedError.title}</strong>
              <p className="bubble-error-message">{errorContent}</p>
            </div>
            {liveOutput && (
              <ModelErrorAnnouncement
                text={`${describedError.title}。${errorMessage}${errorContext === 'compaction' ? ' 上下文压缩失败。' : ''}`}
              />
            )}
            <details className="bubble-error-details">
              <summary>技术详情</summary>
              <pre>{describedError.raw}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  )
})
