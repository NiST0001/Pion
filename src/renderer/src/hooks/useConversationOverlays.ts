import { useCallback, useRef } from 'react'
import type { RefCallback } from 'react'

/** Measure the two floating chrome rows, not their expanded popovers. Writing
 * CSS clearance leaves React children/drafts and the scroll viewport mounted. */
export function useConversationOverlays(hasMetrics: boolean): RefCallback<HTMLDivElement> {
  const disconnect = useRef<(() => void) | undefined>(undefined)
  return useCallback((shell: HTMLDivElement | null) => {
    disconnect.current?.()
    disconnect.current = undefined
    if (!shell) return
    const metrics = hasMetrics ? shell.querySelector<HTMLElement>('.run-metrics-strip') : null
    const composer = shell.querySelector<HTMLElement>('.composer-dock')
    const measure = () => {
      // The summary has a 6px top margin. Detail is absolute and must never
      // reserve space or resize the message viewport when it expands.
      shell.style.setProperty('--conversation-top-clearance', `${metrics ? metrics.offsetHeight + 6 : 0}px`)
      shell.style.setProperty('--conversation-bottom-clearance', `${composer?.offsetHeight ?? 0}px`)
    }
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      if (metrics) observer.observe(metrics)
      if (composer) observer.observe(composer)
      disconnect.current = () => observer.disconnect()
    } else {
      window.addEventListener('resize', measure)
      disconnect.current = () => window.removeEventListener('resize', measure)
    }
  }, [hasMetrics])
}
