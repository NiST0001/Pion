import { useLayoutEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { GitBranch } from 'lucide-react'
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
}

export function ChatMessage({ item, onFork, canFork }: ChatMessageProps): ReactElement | null {
  const rowRef = useRef<HTMLDivElement>(null)
  // Paged history carries noReveal on the item itself; it never waterfalls.
  const revealSuppressed = item.noReveal === true
  const previousThinkingRef = useRef('')
  const previousErrorRef = useRef('')
  const assistant = item.kind === 'assistant' ? item : undefined
  const liveOutput = Boolean(assistant?.live && !assistant.historical)
  const text = assistant?.text ?? ''
  const thinking = assistant?.thinking ?? ''
  const error = assistant?.error ?? ''
  const thinkingRevealCount = liveOutput
    ? appendedCharacterCount(previousThinkingRef.current, thinking)
    : 0
  const errorRevealCount = liveOutput
    ? appendedCharacterCount(previousErrorRef.current, error)
    : 0

  useLayoutEffect(() => {
    previousThinkingRef.current = thinking
    previousErrorRef.current = error
  }, [error, thinking])

  if (item.kind === 'user') {
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
            <pre>{liveOutput ? (
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
              revealMode={revealSuppressed ? undefined : liveOutput ? 'live' : item.historical ? 'history' : undefined}
            />
          </div>
        )}
        {error && (
          <div className="bubble-error" data-live-output="error">
            {liveOutput ? <RevealText text={error} mode="live" revealCount={errorRevealCount} /> : item.historical && !revealSuppressed ? <RevealLines text={error} mode="history" /> : error}
          </div>
        )}
      </div>
    </div>
  )
}
