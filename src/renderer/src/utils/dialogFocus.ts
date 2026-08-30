const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function isTopmostModalDialog(dialog: HTMLElement | null): boolean {
  if (!dialog) return false
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  ))
  const topmost = dialogs.reduce<HTMLElement | null>((current, candidate) => {
    if (!current) return candidate
    const currentLayer = Number(current.dataset.modalLayer ?? 0)
    const candidateLayer = Number(candidate.dataset.modalLayer ?? 0)
    return candidateLayer >= currentLayer ? candidate : current
  }, null)
  return topmost === dialog
}

export function containModalTab(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== 'Tab') return
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true')
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (event.shiftKey) {
    if (active === first || !dialog.contains(active)) {
      event.preventDefault()
      last.focus()
    }
  } else if (active === last || !dialog.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}
