import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { containModalTab, isTopmostModalDialog } from '../utils/dialogFocus'

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel = '取消',
  busy = false,
  tone = 'danger',
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message: ReactNode
  detail?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  tone?: 'danger' | 'accent'
  onConfirm: () => void
  onCancel: () => void
}): ReactElement | null {
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  const onCancelRef = useRef(onCancel)

  useEffect(() => {
    busyRef.current = busy
    onCancelRef.current = onCancel
  }, [busy, onCancel])

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => cancelRef.current?.focus())
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
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section
        ref={dialogRef}
        className={`confirm-dialog confirm-dialog-${tone}`}
        role="alertdialog"
        tabIndex={-1}
        data-modal-layer="340"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
      >
        <div className="confirm-dialog-icon" aria-hidden="true"><AlertTriangle size={17} /></div>
        <div className="confirm-dialog-copy">
          <h2 id="confirm-dialog-title">{title}</h2>
          <div id="confirm-dialog-message" className="confirm-dialog-message">{message}</div>
          {detail && <div className="confirm-dialog-detail">{detail}</div>}
        </div>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="confirm-dialog-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 size={12} className="spin" />}
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
