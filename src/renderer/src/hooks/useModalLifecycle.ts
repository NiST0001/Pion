import { useEffect, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { containModalTab, isTopmostModalDialog, registerModalKeydown, restoreModalFocus } from '../utils/dialogFocus'

/** Shared lifecycle; menu capture handlers retain first refusal of keyboard input. */
export function useModalLifecycle({
  open, dialogRef, initialFocusRef, onClose, busy = false, selectInitialText = false, focusKey
}: {
  open: boolean
  dialogRef: RefObject<HTMLElement | null>
  initialFocusRef: RefObject<HTMLElement | null>
  onClose: () => void
  busy?: boolean
  selectInitialText?: boolean
  focusKey?: unknown
}) {
  const latest = useRef({ onClose, busy })
  latest.current = { onClose, busy }
  // React capture scopes the source to this dialog, including its portals.
  const composingTarget = useRef<EventTarget | null>(null)
  const isComposing = (target: EventTarget | null = dialogRef.current?.ownerDocument.activeElement ?? null) => {
    const source = composingTarget.current
    if (!(source instanceof Node) || !source.isConnected) {
      composingTarget.current = null
      return false
    }
    const ownerDocument = source.ownerDocument
    const ownerView = ownerDocument?.defaultView
    // Window wrappers may differ by identity while sharing their realm and document.
    const fromWindow = ownerView != null && target instanceof ownerView.Window && target.document === ownerDocument
    return ownerDocument !== null && ownerDocument === dialogRef.current?.ownerDocument
      && (source === target || source === ownerDocument.activeElement || fromWindow || target === ownerDocument)
  }

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    composingTarget.current = null
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      if (!isTopmostModalDialog(dialog) || (!selectInitialText && dialog.contains(document.activeElement))) return
      const initial = initialFocusRef.current
      initial?.focus({ preventScroll: true })
      if (selectInitialText && (initial instanceof HTMLInputElement || initial instanceof HTMLTextAreaElement)) initial.select()
      if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true })
    })
    const unregister = registerModalKeydown(dialog, (event) => {
      if (event.key === 'Tab') {
        containModalTab(event, dialog)
        event.stopImmediatePropagation()
        return
      }
      event.stopImmediatePropagation()
      if (latest.current.busy || isComposing(event.target) || event.isComposing || event.keyCode === 229 || event.repeat) return
      event.preventDefault()
      latest.current.onClose()
    })
    return () => {
      cancelAnimationFrame(frame)
      unregister()
      composingTarget.current = null
      restoreModalFocus(dialog, previousFocus)
    }
  }, [open, dialogRef, initialFocusRef, selectInitialText, focusKey])

  return {
    isComposing,
    close: () => {
      if (open && !latest.current.busy && isTopmostModalDialog(dialogRef.current)) latest.current.onClose()
    },
    dialogEvents: {
      onCompositionStartCapture: (event: { target: EventTarget }) => { composingTarget.current = event.target },
      onCompositionEndCapture: (event: { target: EventTarget }) => { if (composingTarget.current === event.target) composingTarget.current = null },
      onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229 || isComposing(event.target) || event.repeat)) {
          event.preventDefault()
        }
      }
    }
  }
}
