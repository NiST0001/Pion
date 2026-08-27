import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

interface ComposerProps {
  busy: boolean
  queued: { steering: number; followUp: number }
  disabled: boolean
  onSend: (text: string) => void
  onAbort: () => void
}

export function Composer({ busy, queued, disabled, onSend, onAbort }: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      {busy && (
        <div className="composer-hint">
          <span className="pulse">● 运行中</span>
          {queuedTotal > 0 && <span className="queued">排队 {queuedTotal} 条（将作为转向消息注入）</span>}
          <button className="ghost-button stop-button" onClick={onAbort}>
            停止
          </button>
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={disabled ? 'agent 未运行…' : '给 Pion 发消息… (Enter 发送 / Shift+Enter 换行)'}
          disabled={disabled}
          rows={1}
          onChange={(event) => {
            setValue(event.target.value)
            autoSize(event.target)
          }}
          onKeyDown={handleKeyDown}
        />
        <button className="send-button" onClick={submit} disabled={disabled || value.trim() === ''}>
          发送
        </button>
      </div>
    </footer>
  )
}
