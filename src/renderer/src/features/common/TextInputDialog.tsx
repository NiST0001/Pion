import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent, ReactElement, ReactNode } from 'react'
import { Loader2, PencilLine } from 'lucide-react'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'

export function TextInputDialog({
  open,
  title,
  message,
  label,
  initialValue,
  placeholder,
  confirmLabel,
  cancelLabel = '取消',
  busy = false,
  error = '',
  maxLength = 120,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message?: ReactNode
  label: string
  initialValue: string
  placeholder?: string
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  error?: string
  maxLength?: number
  onConfirm: (value: string) => void
  onCancel: () => void
}): ReactElement | null {
  const [value, setValue] = useState(initialValue)
  const dialogRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(busy)
  const onCancelRef = useRef(onCancel)
  const titleId = useId()
  const messageId = useId()
  const inputId = useId()

  useEffect(() => {
    busyRef.current = busy
    onCancelRef.current = onCancel
  }, [busy, onCancel])

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog || !isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        containModalTab(event, dialog)
        return
      }
      if (event.key !== 'Escape' || busyRef.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onCancelRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [initialValue, open])

  if (!open) return null

  const trimmed = value.replace(/[\r\n]+/g, ' ').trim()
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!trimmed || busy) return
    onConfirm(trimmed)
  }

  return createPortal(
    <div
      className="confirm-dialog-backdrop text-input-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <form
        ref={dialogRef}
        className="confirm-dialog text-input-dialog"
        role="dialog"
        tabIndex={-1}
        data-modal-layer="340"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        onSubmit={submit}
      >
        <div className="confirm-dialog-icon" aria-hidden="true"><PencilLine size={17} /></div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId}>{title}</h2>
          {message && <div id={messageId} className="confirm-dialog-message">{message}</div>}
          <label className="text-input-dialog-field" htmlFor={inputId}>
            <span>{label}</span>
            <input
              ref={inputRef}
              id={inputId}
              value={value}
              placeholder={placeholder}
              maxLength={maxLength}
              autoComplete="off"
              aria-invalid={Boolean(error)}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <div className="text-input-dialog-meta">
            <span role={error ? 'alert' : undefined}>{error}</span>
            <span>{value.length}/{maxLength}</span>
          </div>
        </div>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="confirm-dialog-confirm"
            disabled={busy || !trimmed}
          >
            {busy && <Loader2 size={12} className="spin" />}
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
