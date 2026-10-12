import { createContext, useContext, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'

const DisclosureRevealReadyContext = createContext(true)

/** Text outside a disclosure is ready immediately. Nested gates wait for all ancestors. */
export function useDisclosureRevealReady(): boolean {
  return useContext(DisclosureRevealReadyContext)
}

/** Keep real content geometry while deferring its first text reveal until expansion settles. */
export function DisclosureRevealGate({ open, children }: { open: boolean; children: ReactNode }) {
  const parentReady = useDisclosureRevealReady()
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const [localSettled, setLocalSettled] = useState(false)

  useLayoutEffect(() => {
    setLocalSettled(false)
    if (!open || reducedMotion) return
    const timer = window.setTimeout(() => setLocalSettled(true), 200)
    return () => window.clearTimeout(timer)
  }, [open, reducedMotion])

  const ready = parentReady && open && (reducedMotion || localSettled)
  return <DisclosureRevealReadyContext.Provider value={ready}>
    <div className="disclosure-reveal-gate" data-text-reveal-ready={ready}>{children}</div>
  </DisclosureRevealReadyContext.Provider>
}
