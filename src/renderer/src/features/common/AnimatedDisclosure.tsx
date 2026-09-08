import { useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'

/** Mount expensive details on demand, retain them only for the short closing
 * transition, then release their DOM. Grid interpolation also handles auto height. */
export function AnimatedDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const [present, setPresent] = useState(open)
  useLayoutEffect(() => {
    if (open) { setPresent(true); return }
    if (!present) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false)
      return
    }
    const timer = window.setTimeout(() => setPresent(false), 200)
    return () => window.clearTimeout(timer)
  }, [open, present])
  if (!present) return null
  return <div className="animated-disclosure" data-open={open} aria-hidden={!open} inert={!open}
    onTransitionEnd={(event) => {
      if (!open && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') setPresent(false)
    }}>
    <div className="animated-disclosure-inner">{children}</div>
  </div>
}
