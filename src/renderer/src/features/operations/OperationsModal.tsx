import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Archive, BarChart3, ShieldCheck, Users, X } from 'lucide-react'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'

export type OperationsPanelKind = 'verification' | 'agents' | 'stats'

const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

export function OperationsModal({
  kind,
  children,
  onClose
}: {
  kind: OperationsPanelKind | 'archive'
  children: ReactNode
  onClose(): void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  const composingRef = useRef(false)
  const title = kind === 'archive' ? '归档会话' : kind === 'stats' ? '使用总览' : kind === 'verification' ? '项目自动验证' : '隔离多 Agent'
  const command = kind === 'archive' ? undefined : kind === 'stats' ? '/stats' : kind === 'verification' ? '/verify' : '/agents'

  useLayoutEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (isTopmostModalDialog(dialog)) closeRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        if (document.activeElement === dialog) {
          const focusable = dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
          event.preventDefault()
          const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0]
          target?.focus({ preventScroll: true })
        } else containModalTab(event, dialog)
        event.stopImmediatePropagation()
        return
      }
      if (event.key !== 'Escape' && ((kind !== 'stats' && kind !== 'archive') || event.key !== 'Enter')) return
      // Read-only/search panels consume Enter before it reaches Composer;
      // native button activation still works. Editing panels keep their own handlers.
      event.stopImmediatePropagation()
      if (event.isComposing || event.keyCode === 229 || composingRef.current || (kind === 'stats' && event.repeat)) {
        if (kind === 'stats') event.preventDefault()
        return
      }
      // Ordinary stats Enter retains native button activation, without reaching Composer.
      if (event.key === 'Enter') return
      event.preventDefault()
      if (event.repeat) return
      onCloseRef.current()
    }
    const captureKeys = kind === 'stats' || kind === 'archive'
    window.addEventListener('keydown', onKeyDown, captureKeys)
    return () => {
      composingRef.current = false
      window.removeEventListener('keydown', onKeyDown, captureKeys)
      const canRestore = dialog.isConnected ? isTopmostModalDialog(dialog)
        : !document.querySelector(MODAL_DIALOG_SELECTOR) || isTopmostModalDialog(previousFocus?.closest<HTMLElement>(MODAL_DIALOG_SELECTOR) ?? null)
      if (canRestore && previousFocus?.isConnected &&
        (document.activeElement === document.body || dialog.contains(document.activeElement))) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [kind])

  const close = (): void => { if (isTopmostModalDialog(dialogRef.current)) onCloseRef.current() }

  return createPortal(
    <div
      className="operations-modal-backdrop"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation()
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        close()
      }}
    >
      <section
        ref={dialogRef}
        className={`operations-modal operations-modal-${kind}`}
        role="dialog"
        tabIndex={-1}
        data-modal-layer="300"
        aria-modal="true"
        aria-labelledby={titleId}
        onCompositionStartCapture={() => { composingRef.current = true }}
        onCompositionEndCapture={() => { composingRef.current = false }}
      >
        <header className="operations-modal-head">
          <span className="operations-modal-icon">
            {kind === 'archive' ? <Archive size={15} /> : kind === 'stats' ? <BarChart3 size={15} /> : kind === 'verification' ? <ShieldCheck size={15} /> : <Users size={15} />}
          </span>
          <div>
            <h2 id={titleId}>{title}</h2>
            {command && <span>输入 <code>{command}</code> 可随时重新打开</span>}
          </div>
          <button ref={closeRef} type="button" aria-label={`关闭${title}`} onClick={close}>
            <X size={15} />
          </button>
        </header>
        <div className="operations-modal-body">{children}</div>
      </section>
    </div>,
    document.body
  )
}
