import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useModalLifecycle } from '../../hooks/useModalLifecycle'

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
  const titleId = useId()
  const messageId = useId()
  const { close, dialogEvents } = useModalLifecycle({ open, dialogRef, initialFocusRef: cancelRef, busy, onClose: onCancel })

  if (!open) return null

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <section
        ref={dialogRef}
        className={`confirm-dialog confirm-dialog-${tone}`}
        role="alertdialog"
        tabIndex={-1}
        data-modal-layer="340"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        {...dialogEvents}
      >
        <div className="confirm-dialog-icon" aria-hidden="true"><AlertTriangle size={17} /></div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId}>{title}</h2>
          <div id={messageId} className="confirm-dialog-message">{message}</div>
          {detail && <div className="confirm-dialog-detail">{detail}</div>}
        </div>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog-cancel"
            disabled={busy}
            onClick={close}
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
