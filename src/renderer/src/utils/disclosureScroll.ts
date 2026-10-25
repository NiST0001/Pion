/** Renderer-local coordination only; listeners register their actual scroll completion synchronously. */
export const DISCLOSURE_REVEAL_READY_EVENT = 'pion:disclosure-reveal-ready'

export interface DisclosureRevealRequest {
  waitUntil(promise: Promise<unknown>): void
}
