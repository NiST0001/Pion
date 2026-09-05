export type ResizeTarget = 'sidebar' | 'review'

export interface PanelResizeState {
  target: ResizeTarget
  startX: number
  startWidth: number
}

export const DEFAULT_SIDEBAR_WIDTH = 276
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 2200
export const MIN_REVIEW_WIDTH = 300
export const MAX_REVIEW_WIDTH = 2800

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function defaultReviewWidth(): number {
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
  return clamp(
    Math.round((viewportWidth - DEFAULT_SIDEBAR_WIDTH) / 2),
    MIN_REVIEW_WIDTH,
    MAX_REVIEW_WIDTH
  )
}
