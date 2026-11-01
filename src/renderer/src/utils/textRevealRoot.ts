/** Exact scroll owner shared by text admission and animation cleanup. */
export function textRevealRoot(element: HTMLElement): Element | null {
  const viewport = element.closest('.review-detail-body, .chat-scroll')
  if (viewport) return viewport
  // Coarse wrappers are transparent to fallback ownership: their fine chunks
  // must continue sharing the same root with the original coarse placeholder.
  let parent = element.parentElement
  while (parent?.dataset.textRevealCoarse === 'true') parent = parent.parentElement
  return parent
}
