import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'

interface ComposerProps {
  busy: boolean
  queued: { steering: number; followUp: number }
  disabled: boolean
  prefill: string
  /** 输入框下方的控制区（模型/思考级别选择器等） */
  controls?: ReactNode
  onSend: (text: string) => void
  onAbort: () => void
}

export function Composer({
  busy,
  queued,
  disabled,
  prefill,
  controls,
  onSend,
  onAbort
}: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (prefill) {
      setValue(prefill)
      textareaRef.current?.focus()
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
        }
      })
    }
  }, [prefill])

  const submit = useCallback(() => {
    const text = value.trim()
    if (text === '' || disabled) return
    onSend(text)
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [value, disabled, onSend])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={disabled ? 'agent 未运行…' : '描述任务… (Enter 发送 / Shift+Enter 换行)'}
          disabled={disabled}
          rows={1}
          onChange={(event) => {
            setValue(event.target.value)
            autoSize(event.target)
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          className="send-button"
          onClick={submit}
          disabled={disabled || value.trim() === ''}
          title="发送"
        >
          <ArrowUp size={16} />
        </button>
      </div>
      <div className="composer-controls">
        <div className="composer-controls-left">{controls}</div>
        <div className="composer-controls-right">
          {busy && (
            <>
              <span className="pulse status-run">● 运行中</span>
              {queuedTotal > 0 && (
                <span className="queued">排队 {queuedTotal} 条（转向注入）</span>
              )}
              <button className="ghost-button stop-button" onClick={onAbort}>
                <Square size={11} /> 停止
              </button>
            </>
          )}
        </div>
      </div>
    </footer>
  )
}
