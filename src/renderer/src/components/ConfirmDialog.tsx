import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

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
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => cancelRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [busy, onCancel, open])

  if (!open) return null

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section
        className={`confirm-dialog confirm-dialog-${tone}`}
        role="alertdialog"
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
