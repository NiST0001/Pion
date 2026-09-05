import { useEffect, useState } from 'react'

/** Delay a lazy panel's first download, then preserve its state across closes. */
export function useDeferredMount(open: boolean): boolean {
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) setMounted(true)
  }, [open])

  return mounted || open
}
