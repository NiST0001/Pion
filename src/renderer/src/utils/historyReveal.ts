import { armScreenTextReveal } from './screenTextReveal'

export function armHistoryRevealRow(row: HTMLElement, container: HTMLElement): void {
  const containerRect = container.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  if (rowRect.bottom < containerRect.top || rowRect.top > containerRect.bottom) return

  // History is revealed by actual screen coordinates, not by the order of the
  // session entries. Arm the whole visible window at once so adjacent rows do
  // not each restart their own left-to-right sequence.
  armScreenTextReveal(container, container)
  row.classList.add('history-reveal-armed')
}

export function armPendingHistoryRevealRows(container: HTMLElement): void {
  const pendingRows = [...container.querySelectorAll<HTMLElement>('.history-reveal:not(.history-reveal-armed)')]
    .filter((row) => {
      const rowRect = row.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      return rowRect.bottom >= containerRect.top && rowRect.top <= containerRect.bottom
    })
  if (pendingRows.length === 0) return
  armScreenTextReveal(container, container)
  pendingRows.forEach((row) => row.classList.add('history-reveal-armed'))
}
