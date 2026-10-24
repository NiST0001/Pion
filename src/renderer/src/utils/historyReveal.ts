import { armScreenTextReveal } from './screenTextReveal'

export function armHistoryRevealRow(row: HTMLElement, container: HTMLElement): void {
  const containerRect = container.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  if (rowRect.bottom < containerRect.top || rowRect.top > containerRect.bottom) return

  // History is revealed by actual screen coordinates, not by the order of the
  // session entries. Arm the whole visible window at once so adjacent rows do
  // not each restart their own left-to-right sequence.
  armScreenTextReveal(container, container, containerRect)
  row.classList.add('history-reveal-armed')
}

export function armPendingHistoryRevealRows(container: HTMLElement): void {
  const pendingRows = [...container.querySelectorAll<HTMLElement>('.history-reveal:not(.history-reveal-armed)')]
  const containerRect = pendingRows.length ? container.getBoundingClientRect() : undefined
  const visibleRows = containerRect ? pendingRows.filter((row) => {
    const rowRect = row.getBoundingClientRect()
    return rowRect.bottom >= containerRect.top && rowRect.top <= containerRect.bottom
  }) : []
  // An armed row can still contain unarmed characters below the viewport.
  // Continue its reveal on scroll even when no new row needs to be armed.
  armScreenTextReveal(container, container, containerRect)
  visibleRows.forEach((row) => row.classList.add('history-reveal-armed'))
}
