import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DisclosureRevealGate } from './DisclosureRevealGate'

/** Mount details on demand. By default release after the short closing
 * transition; stateful batch lists opt into retaining hidden DOM after it.
 * Grid interpolation also handles auto height. */
export function AnimatedDisclosure({ open, children, retainContent = false }: {
  open: boolean; children: ReactNode; retainContent?: boolean
}) {
  const [present, setPresent] = useState(open)
  const mountedOnce = useRef(open)
  useLayoutEffect(() => {
    if (open) { mountedOnce.current = true; setPresent(true); return }
    if (!present) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false)
      return
    }
    const timer = window.setTimeout(() => setPresent(false), 200)
    return () => window.clearTimeout(timer)
  }, [open, present])
  if (!present && !(retainContent && mountedOnce.current)) return null
  return <div className="animated-disclosure" data-open={open} aria-hidden={!open} inert={!open}
    hidden={!present} style={!present ? { display: 'none' } : undefined}
    onTransitionEnd={(event) => {
      if (!open && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') setPresent(false)
    }}>
    <div className="animated-disclosure-inner"><DisclosureRevealGate open={open}>{children}</DisclosureRevealGate></div>
  </div>
}
