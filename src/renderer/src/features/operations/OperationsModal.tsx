import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck, Users, X } from 'lucide-react'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'

export type OperationsPanelKind = 'verification' | 'agents'

export function OperationsModal({
  kind,
  children,
  onClose
}: {
  kind: OperationsPanelKind
  children: ReactNode
  onClose(): void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const title = kind === 'verification' ? '项目自动验证' : '隔离多 Agent'
  const command = kind === 'verification' ? '/verify' : '/agents'

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog || !isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        containModalTab(event, dialog)
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className="operations-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className={`operations-modal operations-modal-${kind}`}
        role="dialog"
        tabIndex={-1}
        data-modal-layer="300"
        aria-modal="true"
        aria-labelledby="operations-modal-title"
      >
        <header className="operations-modal-head">
          <span className="operations-modal-icon">
            {kind === 'verification' ? <ShieldCheck size={15} /> : <Users size={15} />}
          </span>
          <div>
            <h2 id="operations-modal-title">{title}</h2>
            <span>输入 <code>{command}</code> 可随时重新打开</span>
          </div>
          <button ref={closeRef} type="button" aria-label={`关闭${title}`} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="operations-modal-body">{children}</div>
      </section>
    </div>,
    document.body
  )
}
