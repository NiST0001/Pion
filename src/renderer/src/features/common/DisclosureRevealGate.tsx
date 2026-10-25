import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DISCLOSURE_REVEAL_READY_EVENT } from '../../utils/disclosureScroll'
import type { DisclosureRevealRequest } from '../../utils/disclosureScroll'

const DisclosureRevealReadyContext = createContext(true)

/** Text outside a disclosure is ready immediately. Nested gates wait for all ancestors. */
export function useDisclosureRevealReady(): boolean {
  return useContext(DisclosureRevealReadyContext)
}

/** Keep real content geometry while waiting for expansion and any registered scroll to settle. */
export function DisclosureRevealGate({ open, children }: { open: boolean; children: ReactNode }) {
  const parentReady = useDisclosureRevealReady()
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const [localSettled, setLocalSettled] = useState(false)
  const gateRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)

  useLayoutEffect(() => {
    const generation = ++generationRef.current
    const gate = gateRef.current
    setLocalSettled(false)
    if (!open || reducedMotion || !gate) return
    const settle = () => {
      if (generationRef.current === generation && gateRef.current === gate) setLocalSettled(true)
    }
    const timer = window.setTimeout(() => {
      if (generationRef.current !== generation || gateRef.current !== gate) return
      const waiters: Promise<unknown>[] = []
      let collecting = true
      gate.dispatchEvent(new CustomEvent<DisclosureRevealRequest>(DISCLOSURE_REVEAL_READY_EVENT, {
        bubbles: true,
        detail: { waitUntil: (promise) => { if (collecting) waiters.push(promise) } }
      }))
      collecting = false
      if (waiters.length === 0) settle()
      else void Promise.allSettled(waiters).then(settle)
    }, 200)
    return () => {
      ++generationRef.current
      window.clearTimeout(timer)
    }
  }, [open, reducedMotion])

  const ready = parentReady && open && (reducedMotion || localSettled)
  return <DisclosureRevealReadyContext.Provider value={ready}>
    <div ref={gateRef} className="disclosure-reveal-gate" data-text-reveal-open={open} data-text-reveal-ready={ready}>{children}</div>
  </DisclosureRevealReadyContext.Provider>
}
