import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'

interface ComposerProps {
  busy: boolean
  queued: { steering: number; followUp: number }
  disabled: boolean
  prefill: string
  /** 当前会话中的用户消息，按时间顺序用于上下键导航。 */
  history: string[]
  /** 嵌入输入框底部的控制区（模型/思考级别选择器等） */
  controls?: ReactNode
  onSend: (text: string) => void
  onQueue: (text: string) => void
  onAbort: () => void
}

export function Composer({
  busy,
  queued,
  disabled,
  prefill,
  history,
  controls,
  onSend,
  onQueue,
  onAbort
}: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historyIndexRef = useRef<number | null>(null)
  const historyDraftRef = useRef('')

  const resetHistoryNavigation = useCallback((): void => {
    historyIndexRef.current = null
    historyDraftRef.current = ''
  }, [])

  useEffect(() => {
    if (prefill) {
      resetHistoryNavigation()
      setValue(prefill)
      textareaRef.current?.focus()
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
        }
      })
    }
  }, [prefill, resetHistoryNavigation])

  const moveHistory = useCallback(
    (direction: 'up' | 'down'): boolean => {
      if (history.length === 0) return false
      const currentIndex = historyIndexRef.current
      let nextIndex: number

      if (direction === 'up') {
        if (currentIndex === null) {
          historyDraftRef.current = value
          nextIndex = history.length - 1
        } else if (currentIndex > 0) {
          nextIndex = currentIndex - 1
        } else {
          return true
        }
      } else {
        if (currentIndex === null) return false
        if (currentIndex < history.length - 1) {
          nextIndex = currentIndex + 1
        } else {
          historyIndexRef.current = null
          setValue(historyDraftRef.current)
          requestAnimationFrame(() => {
            const element = textareaRef.current
            if (!element) return
            element.focus()
            element.setSelectionRange(element.value.length, element.value.length)
          })
          return true
        }
      }

      historyIndexRef.current = nextIndex
      const nextValue = history[nextIndex]
      setValue(nextValue)
      requestAnimationFrame(() => {
        const element = textareaRef.current
        if (!element) return
        element.focus()
        element.setSelectionRange(nextValue.length, nextValue.length)
      })
      return true
    },
    [history, value]
  )

  const clearValue = useCallback((): void => {
    setValue('')
    resetHistoryNavigation()
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [resetHistoryNavigation])

  const submit = useCallback(() => {
    const text = value.trim()
    if (text === '' || disabled) return
    onSend(text)
    clearValue()
  }, [value, disabled, onSend, clearValue])

  const queue = useCallback(() => {
    const text = value.trim()
    if (text === '' || disabled) return
    onQueue(text)
    clearValue()
  }, [value, disabled, onQueue, clearValue])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const historyDirection = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null
    const atHistoryBoundary = historyDirection === 'up'
      ? event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
      : historyDirection === 'down'
        ? event.currentTarget.selectionStart === event.currentTarget.value.length &&
          event.currentTarget.selectionEnd === event.currentTarget.value.length
        : false
    if (
      historyDirection &&
      atHistoryBoundary &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing &&
      moveHistory(historyDirection)
    ) {
      event.preventDefault()
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && value.trim() !== '') {
      event.preventDefault()
      queue()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const autoSize = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }

  const queuedTotal = queued.steering + queued.followUp

  return (
    <footer className="composer">
      <div className="composer-row">
        <div className="composer-input-main">
          <textarea
            ref={textareaRef}
            value={value}
            placeholder={disabled ? 'agent 未运行…' : '描述任务… (↑↓ 编辑历史 / Tab 排队 / Enter 直接发送)'}
            disabled={disabled}
            rows={1}
            onChange={(event) => {
              resetHistoryNavigation()
              setValue(event.target.value)
              autoSize(event.target)
            }}
            onKeyDown={handleKeyDown}
            aria-keyshortcuts="ArrowUp ArrowDown"
          />
          <div className="composer-inline-controls">{controls}</div>
        </div>
        <button
          className="send-button"
          onClick={submit}
          disabled={disabled || value.trim() === ''}
          title="Enter 直接发送"
        >
          <ArrowUp size={16} />
        </button>
      </div>
      {busy && (
        <div className="composer-status-row">
          <div className="composer-status-right">
            <span className="pulse status-run">● 运行中</span>
            {queuedTotal > 0 && (
              <span className="queued">排队 {queuedTotal} 条（转向注入）</span>
            )}
            <button className="ghost-button stop-button" onClick={onAbort}>
              <Square size={11} /> 停止
            </button>
          </div>
        </div>
      )}
    </footer>
  )
}
