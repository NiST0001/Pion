const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function isVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const visibility = window.getComputedStyle(element).visibility
  if (visibility === 'hidden' || visibility === 'collapse') return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (window.getComputedStyle(ancestor).display === 'none') return false
  }
  return true
}

function modalLayer(dialog: HTMLElement): number {
  if (dialog.dataset.modalLayer !== undefined && Number.isFinite(Number(dialog.dataset.modalLayer))) {
    return Number(dialog.dataset.modalLayer)
  }
  // Older modal callers declare their layer on the backdrop through CSS.
  let layer = 0
  for (let element: HTMLElement | null = dialog; element; element = element.parentElement) {
    const zIndex = Number.parseInt(window.getComputedStyle(element).zIndex, 10)
    if (Number.isFinite(zIndex)) layer = Math.max(layer, zIndex)
  }
  return layer
}

export function topmostModalDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  )).filter(isVisible)
  return dialogs.reduce<HTMLElement | null>((current, candidate) => {
    if (!current) return candidate
    const currentLayer = modalLayer(current)
    const candidateLayer = modalLayer(candidate)
    return candidateLayer >= currentLayer ? candidate : current
  }, null)
}

export function isTopmostModalDialog(dialog: HTMLElement | null): boolean {
  return dialog !== null && topmostModalDialog() === dialog
}

export function restoreModalFocus(dialog: HTMLElement, previousFocus: HTMLElement | null): void {
  if (!previousFocus?.isConnected || previousFocus.matches(':disabled') || !isVisible(previousFocus)) return
  const active = document.activeElement
  if (active !== document.body && !dialog.contains(active)) return
  const topmost = topmostModalDialog()
  if (topmost && topmost !== dialog && !topmost.contains(previousFocus)) return
  previousFocus.focus({ preventScroll: true })
}

export function containModalTab(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== 'Tab' || event.defaultPrevented) return
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0
      && !element.matches(':disabled, input[type="hidden"]')
      && isVisible(element))
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus({ preventScroll: true })
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (event.shiftKey) {
    if (active === first || active === dialog || !dialog.contains(active)) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    }
  } else if (active === last || active === dialog || !dialog.contains(active)) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}
