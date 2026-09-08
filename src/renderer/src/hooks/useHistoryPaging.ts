import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

type Direction = 'older' | 'newer'
type LoadPage = (options?: { viaScroll?: boolean }) => Promise<void>
const EDGE = 96

function atEdge(element: HTMLElement, direction: Direction): boolean {
  return direction === 'older' ? element.scrollTop <= EDGE
    : element.scrollHeight - element.scrollTop - element.clientHeight <= EDGE
}

/** Let nested code/output scrollers consume their own input first. */
export function consumedInside(event: Event, root: HTMLElement, direction: Direction): boolean {
  if (event.defaultPrevented) return true
  let node = event.target instanceof Element ? event.target : null
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight
      && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
      const room = direction === 'older' ? node.scrollTop > 0
        : node.scrollTop < node.scrollHeight - node.clientHeight - 1
      if (room) return true
    }
    node = node.parentElement
  }
  return false
}

/** Fetching owns no scroll position or follow intent. A page is requested by
 * user movement/outward input, or to fill a viewport that has no scrollbar. */
export function useHistoryPaging({ scrollRef, owner, timelineLength, loadOlder, loadNewer }: {
  scrollRef: RefObject<HTMLDivElement | null>
  owner: string
  timelineLength: number
  loadOlder: LoadPage
  loadNewer: LoadPage
}) {
  const epoch = useRef(0)
  const inFlight = useRef<{ promise: Promise<void> } | null>(null)
  useLayoutEffect(() => {
    epoch.current++
    inFlight.current = null
    return () => { epoch.current++; inFlight.current = null }
  }, [owner])

  const requestPage = useCallback((direction: Direction, viaScroll = true): Promise<void> => {
    const element = scrollRef.current
    if (!element || !atEdge(element, direction)) return Promise.resolve()
    // Both directions share one cursor. Do not race or silently start a second
    // request while the first page is pending; fresh input can retry later.
    if (inFlight.current) return inFlight.current.promise
    const generation = epoch.current
    const request = { promise: Promise.resolve() }
    inFlight.current = request
    request.promise = (async () => {
      try {
        if (epoch.current !== generation) return
        await (direction === 'older' ? loadOlder : loadNewer)(viaScroll ? { viaScroll: true } : undefined)
      } catch {
        // Keep the current page on failure. Retry only on new input/fill, not
        // an unbounded automatic retry loop or an unhandled event promise.
      } finally {
        if (inFlight.current === request) inFlight.current = null
      }
    })()
    return request.promise
  }, [loadOlder, loadNewer, scrollRef])

  const onScroll = useCallback((moved: boolean, forward: boolean) => {
    if (moved) void requestPage(forward ? 'newer' : 'older')
  }, [requestPage])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    let touchY: number | undefined
    const input = (event: Event, direction: Direction) => {
      if (!consumedInside(event, element, direction)) void requestPage(direction)
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return
      input(event, event.deltaY > 0 ? 'newer' : 'older')
    }
    const touchStart = (event: TouchEvent) => { touchY = event.touches?.[0]?.clientY }
    const touchMove = (event: TouchEvent) => {
      const y = event.touches?.[0]?.clientY
      if (y !== undefined && touchY !== undefined && y !== touchY) input(event, y < touchY ? 'newer' : 'older')
      touchY = y
    }
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, [contenteditable]')) return
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) input(event, 'newer')
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) input(event, 'older')
    }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchmove', touchMove, { passive: true })
    element.addEventListener('keydown', key)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchstart', touchStart)
      element.removeEventListener('touchmove', touchMove)
      element.removeEventListener('keydown', key)
    }
  }, [owner, requestPage, scrollRef])

  useEffect(() => {
    const generation = epoch.current
    let cancelled = false
    const fill = async () => {
      const element = scrollRef.current
      if (!element || element.scrollHeight > element.clientHeight + 16) return
      await requestPage('older', false)
      if (cancelled || generation !== epoch.current) return
      const current = scrollRef.current
      if (current && current.scrollHeight <= current.clientHeight + 16) await requestPage('newer', false)
    }
    void fill()
    return () => { cancelled = true }
  }, [owner, timelineLength, requestPage, scrollRef])

  return { onScroll }
}
