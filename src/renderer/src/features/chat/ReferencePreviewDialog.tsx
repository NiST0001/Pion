import { useId, useLayoutEffect, useRef } from 'react'
import type { ReactElement, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'
import type { ReferenceAttachment } from './composerReferences'

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

/** Only displays attachment bytes already held by Composer; never reads or sends files. */
export function ReferencePreviewDialog({ reference, onClose, restoreFocus }: {
  reference: ReferenceAttachment
  onClose(): void
  restoreFocus: RefObject<boolean>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  useLayoutEffect(() => { onCloseRef.current = onClose }, [onClose])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (isTopmostModalDialog(dialog)) closeRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        containModalTab(event, dialog)
        event.stopImmediatePropagation()
      } else if (event.key === 'Escape' || event.key === 'Enter') {
        // Keep modal keys away from Composer, including the closing event.
        event.stopImmediatePropagation()
        if (event.key !== 'Escape') return
        event.preventDefault()
        if (!event.repeat && !event.isComposing && event.keyCode !== 229) onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const canRestore = dialog.isConnected ? isTopmostModalDialog(dialog)
        : !document.querySelector(MODAL_SELECTOR)
          || isTopmostModalDialog(previousFocus?.closest<HTMLElement>(MODAL_SELECTOR) ?? null)
      if (restoreFocus.current && canRestore && previousFocus?.isConnected
        && !previousFocus.matches(':disabled')
        && (document.activeElement === document.body || dialog.contains(document.activeElement))) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [restoreFocus])

  const close = (): void => { if (isTopmostModalDialog(dialogRef.current)) onCloseRef.current() }
  return createPortal(
    <div
      className="confirm-dialog-backdrop reference-preview-backdrop"
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
        className="confirm-dialog reference-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-modal-layer="340"
        tabIndex={-1}
      >
        <header className="reference-preview-head confirm-dialog-copy">
          <h2 id={titleId}>{reference.kind === 'image' ? `图像 ${reference.imageNumber} · ` : ''}{reference.name}</h2>
          <div className="confirm-dialog-actions">
            <button ref={closeRef} type="button" className="confirm-dialog-cancel" aria-label="关闭参考预览" onClick={close}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="reference-preview-content" tabIndex={0} aria-label="参考内容">
          {reference.kind === 'image' ? (
            <img src={`data:${reference.image.mimeType};base64,${reference.image.data}`} alt={`图像 ${reference.imageNumber} · ${reference.name}`} />
          ) : <pre>{reference.content}</pre>}
        </div>
      </section>
    </div>,
    document.body
  )
}
