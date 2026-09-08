import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AgentState, TimelineItem } from '../agent/types'
import { armPendingHistoryRevealRows } from '../utils/historyReveal'

interface UseConversationNavigationOptions {
  scrollRef: RefObject<HTMLDivElement | null>
  timeline: TimelineItem[]
  timelineMutation: AgentState['timelineMutation']
  busy: boolean
  timelineLoading?: boolean
  projectCwd?: string
  sessionPath?: string
  historyIndexSessionPath?: string
  historyJump: AgentState['historyJump']
  /** Floating composer panels add bottom clearance; re-pin when they toggle. */
  panelsVisible?: boolean
  loadOlder: (options?: { viaScroll?: boolean }) => Promise<void>
  loadNewer: (options?: { viaScroll?: boolean }) => Promise<void>
}

function historyAnchor(container: HTMLElement): number {
  return container.getBoundingClientRect().top + container.clientTop + Math.min(container.clientHeight * 0.38, 260)
}

export function useConversationNavigation({
  scrollRef,
  timeline,
  timelineMutation,
  busy,
  timelineLoading = false,
  projectCwd,
  sessionPath,
  historyIndexSessionPath,
  historyJump,
  panelsVisible,
  loadOlder,
  loadNewer
}: UseConversationNavigationOptions) {
  const [visibleHistoryEntryId, setVisibleHistoryEntryId] = useState<string | undefined>()
  const historyScrollFrame = useRef<number | null>(null)
  const highlightedHistoryRow = useRef<HTMLElement | null>(null)
  const historyHighlightTimer = useRef<number | null>(null)
  const previousTimelineHeight = useRef(0)
  const previousTimelineLength = useRef(0)
  /** Follow intent; layout changes alone must never re-enable it. */
  const nearBottomRef = useRef(true)
  const navigationSession = useRef(sessionPath)
  const navigationProject = useRef(projectCwd)
  const readingHistory = useRef(false)
  const explicitHistoryEntry = useRef<string | undefined>(undefined)
  const pendingJumpNonce = useRef<number | null>(null)
  const observedJumpNonce = useRef<number | undefined>(undefined)
  const scrollSurfaceRef = useRef<HTMLDivElement>(null)
  const reservedHeight = useRef(0)
  const manualScroll = useRef(false)
  const gestureUntil = useRef(0)
  const lastScrollTop = useRef(0)
  const loadingRef = useRef(timelineLoading)
  const hasContentRef = useRef(timeline.length > 0)
  // This is provisional blank space, not an estimate of the entire history.
  // Keep its extent while the user is scrolling; actual content can fill it
  // naturally, and an explicit return to the end releases unused space.
  const reserveSpace = useCallback((element: HTMLElement, loading = false) => {
    const surface = scrollSurfaceRef.current
    if (!surface) return
    const height = surface.getBoundingClientRect().height
    const padding = Math.max(0, element.scrollHeight - height)
    reservedHeight.current = Math.max(reservedHeight.current, height,
      element.scrollTop + element.clientHeight - padding, loading ? element.clientHeight * 3 : 0)
    surface.style.minHeight = `${reservedHeight.current}px`
  }, [])

  const timelineLength = timeline.length
  const lastItem = timeline[timelineLength - 1]
  const lastGrow = lastItem
    ? lastItem.kind === 'assistant'
      ? lastItem.text.length
      : lastItem.kind === 'tool'
        ? lastItem.tool.outputText?.length ?? 0
        : 0
    : 0
  const lastItemId = lastItem?.id ?? null

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    loadingRef.current = timelineLoading
    hasContentRef.current = timelineLength > 0
    scrollSurfaceRef.current?.style.setProperty('--chat-viewport-height', `${element.clientHeight}px`)
    if (navigationSession.current !== sessionPath || navigationProject.current !== projectCwd) {
      const assigningFirstPath = navigationProject.current === projectCwd && navigationSession.current === undefined && sessionPath !== undefined && manualScroll.current
      navigationSession.current = sessionPath
      navigationProject.current = projectCwd
      if (!assigningFirstPath) {
        nearBottomRef.current = true
        readingHistory.current = false
        manualScroll.current = false
        explicitHistoryEntry.current = undefined
        previousTimelineHeight.current = 0
        previousTimelineLength.current = 0
        reservedHeight.current = 0
        gestureUntil.current = 0
        if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
      }
    }
    if (manualScroll.current || (timelineLoading && timelineLength === 0)) {
      reserveSpace(element, timelineLoading && timelineLength === 0)
    } else {
      reservedHeight.current = 0
      if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
    }
    if (historyJump?.nonce !== observedJumpNonce.current) {
      observedJumpNonce.current = historyJump?.nonce
      pendingJumpNonce.current = historyJump?.nonce ?? null
      explicitHistoryEntry.current = historyJump?.entryId
      if (historyJump) {
        nearBottomRef.current = false
        readingHistory.current = true
      }
    }
    const previousHeight = previousTimelineHeight.current
    const addedTimelineItems = timelineLength > previousTimelineLength.current
    if (timelineMutation === 'prepend' && addedTimelineItems && previousHeight > 0) {
      // Background filling can preserve an anchor, but a user's scroll must
      // not be undone when the older page finally arrives.
      if (!manualScroll.current) element.scrollTop += element.scrollHeight - previousHeight
    } else if (timelineMutation === 'replace') {
      // Cache refreshes and new array references are not a request to go live.
      if (pendingJumpNonce.current === null && nearBottomRef.current && !(timelineLoading && timelineLength === 0)) element.scrollTop = element.scrollHeight
    } else if (timelineMutation === 'append') {
      // Follow the newest message only while the user is already near the
      // bottom; never yank someone away who is reading older history.
      const wasNearBottom = previousHeight - element.scrollTop - element.clientHeight <= 80
      if (pendingJumpNonce.current === null && nearBottomRef.current && !(timelineLoading && timelineLength === 0) && (wasNearBottom || previousHeight === 0)) {
        element.scrollTop = element.scrollHeight
      }
    }
    previousTimelineHeight.current = element.scrollHeight
    previousTimelineLength.current = timelineLength
    lastScrollTop.current = element.scrollTop
  }, [lastGrow, lastItemId, busy, timelineLoading, timelineLength, timelineMutation, scrollRef, timeline, historyJump?.nonce, sessionPath, projectCwd, reserveSpace])

  // Async siblings above the scroller (run metrics strip, trust banner, error
  // banner) and the composer dock (task/queue panels) mount after a session
  // switch or mid-run and shrink the viewport. Preserve follow intent rather
  // than deriving it again from the changed viewport geometry.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver !== 'function') return
    let previousClientHeight = element.clientHeight
    const observer = new ResizeObserver(() => {
      const nextClientHeight = element.clientHeight
      if (nextClientHeight === previousClientHeight) return
      // Keep the user's follow intent. Inferring it from resized geometry
      // can turn a history reader into a bottom follower.
      previousClientHeight = nextClientHeight
      scrollSurfaceRef.current?.style.setProperty('--chat-viewport-height', `${nextClientHeight}px`)
      if (loadingRef.current && !hasContentRef.current) return
      if (pendingJumpNonce.current === null && nearBottomRef.current && !readingHistory.current) {
        element.scrollTop = element.scrollHeight
        lastScrollTop.current = element.scrollTop
        nearBottomRef.current = true
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef])

  // Floating composer panels add bottom padding without changing the
  // scroller's clientHeight, so the resize observer never fires for them.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || pendingJumpNonce.current !== null || !nearBottomRef.current || (loadingRef.current && !hasContentRef.current)) return
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
  }, [scrollRef, panelsVisible])

  const updateVisibleHistoryEntry = useCallback((): void => {
    const container = scrollRef.current
    if (!container) return
    // A clicked landmark stays authoritative through programmatic scrolls,
    // viewport clamping and live layout changes, even for adjacent short rows.
    if (explicitHistoryEntry.current) {
      setVisibleHistoryEntryId(explicitHistoryEntry.current)
      return
    }
    const rows = [...container.querySelectorAll<HTMLElement>('.row-user[data-entry-id]')]
    if (rows.length === 0) {
      setVisibleHistoryEntryId(undefined)
      return
    }
    const anchor = historyAnchor(container)
    const nearest = rows.reduce((best, row) => (
      Math.abs(row.getBoundingClientRect().top - anchor)
        < Math.abs(best.getBoundingClientRect().top - anchor)
        ? row
        : best
    ))
    setVisibleHistoryEntryId(nearest.dataset.entryId)
  }, [scrollRef])

  const scheduleVisibleHistoryUpdate = useCallback((): void => {
    if (historyScrollFrame.current !== null) return
    historyScrollFrame.current = window.requestAnimationFrame(() => {
      historyScrollFrame.current = null
      updateVisibleHistoryEntry()
    })
  }, [updateVisibleHistoryEntry])

  // A loaded window may fit entirely inside the viewport, leaving no scroll
  // events to request the adjacent older/newer page.
  useEffect(() => {
    let cancelled = false
    const fillViewport = async (): Promise<void> => {
      const element = scrollRef.current
      if (!element || element.scrollHeight > element.clientHeight + 16) return
      // Do not start both directions against the same cursor at once. Once
      // older content has filled the viewport, newer content is only fetched
      // when there is still room, such as after a history jump.
      await loadOlder()
      if (cancelled) return
      const current = scrollRef.current
      if (current && current.scrollHeight <= current.clientHeight + 16) await loadNewer()
    }
    void fillViewport()
    scheduleVisibleHistoryUpdate()
    return () => {
      cancelled = true
    }
  }, [loadNewer, loadOlder, scheduleVisibleHistoryUpdate, scrollRef, sessionPath, timelineLength])

  useEffect(() => {
    setVisibleHistoryEntryId(undefined)
  }, [historyIndexSessionPath])

  useLayoutEffect(() => {
    const jump = historyJump
    if (!jump) return
    const frame = window.requestAnimationFrame(() => {
      if (pendingJumpNonce.current !== jump.nonce) return
      const container = scrollRef.current
      const target = container
        ? [...container.querySelectorAll<HTMLElement>('[data-entry-id]')]
            .find((element) => element.dataset.entryId === jump.entryId)
        : undefined
      pendingJumpNonce.current = null
      if (!target || !container) {
        explicitHistoryEntry.current = undefined
        return
      }
      // Use the same row-top anchor as scroll tracking. Centering the whole
      // bubble used a different reference and selected the preceding short row.
      const top = container.scrollTop + target.getBoundingClientRect().top - historyAnchor(container)
      container.scrollTop = Math.max(0, Math.min(Math.max(0, container.scrollHeight - container.clientHeight), top))
      // Do not wait for the asynchronous scroll event: live output or dock
      // resizing may arrive first and otherwise reuse the old bottom flag.
      nearBottomRef.current = false
      readingHistory.current = true
      previousTimelineHeight.current = container.scrollHeight
      lastScrollTop.current = container.scrollTop
      highlightedHistoryRow.current?.classList.remove('history-jump-target')
      target.classList.add('history-jump-target')
      highlightedHistoryRow.current = target
      setVisibleHistoryEntryId(jump.entryId)
      if (historyHighlightTimer.current !== null) {
        window.clearTimeout(historyHighlightTimer.current)
      }
      historyHighlightTimer.current = window.setTimeout(() => {
        target.classList.remove('history-jump-target')
        if (highlightedHistoryRow.current === target) highlightedHistoryRow.current = null
        historyHighlightTimer.current = null
      }, 1_600)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [historyJump?.nonce, scrollRef])

  // Arm eager historical rows after scroll restoration. Lazy chat rows also
  // arm themselves when their chunk finishes mounting; otherwise Suspense can
  // miss this timeline-keyed layout effect and leave their opacity at zero.
  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    armPendingHistoryRevealRows(container)
  }, [scrollRef, timeline])

  useEffect(() => {
    const armVisibleHistory = (): void => {
      const container = scrollRef.current
      if (container) armPendingHistoryRevealRows(container)
    }
    window.addEventListener('resize', armVisibleHistory)
    return () => window.removeEventListener('resize', armVisibleHistory)
  }, [scrollRef])

  useEffect(() => () => {
    if (historyScrollFrame.current !== null) window.cancelAnimationFrame(historyScrollFrame.current)
    if (historyHighlightTimer.current !== null) window.clearTimeout(historyHighlightTimer.current)
    highlightedHistoryRow.current?.classList.remove('history-jump-target')
  }, [])

  // Programmatic scroll events (including scrollIntoView and resize clamping)
  // must not cancel an explicit history jump. Resume only after user input.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const resume = () => {
      if (pendingJumpNonce.current !== null) {
        pendingJumpNonce.current = null
        explicitHistoryEntry.current = undefined
      }
      gestureUntil.current = Date.now() + 300
      manualScroll.current = true
      readingHistory.current = true
      nearBottomRef.current = false
      reserveSpace(element, loadingRef.current && !hasContentRef.current)
    }
    const wheel = (event: WheelEvent) => { if (event.deltaY !== 0) resume() }
    const pointerMove = (event: PointerEvent) => { if (event.buttons) resume() }
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(event.target.tagName))) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) resume()
      if (event.key === 'End' && !loadingRef.current && hasContentRef.current) {
        event.preventDefault()
        readingHistory.current = false
        manualScroll.current = false
        explicitHistoryEntry.current = undefined
        reservedHeight.current = 0
        if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
        element.scrollTop = element.scrollHeight
        lastScrollTop.current = element.scrollTop
        nearBottomRef.current = true
      }
    }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('touchstart', resume, { passive: true })
    element.addEventListener('touchmove', resume, { passive: true })
    element.addEventListener('pointermove', pointerMove)
    element.addEventListener('pointerdown', resume)
    element.addEventListener('keydown', key)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchstart', resume)
      element.removeEventListener('touchmove', resume)
      element.removeEventListener('pointermove', pointerMove)
      element.removeEventListener('pointerdown', resume)
      element.removeEventListener('keydown', key)
    }
  }, [scrollRef, reserveSpace])

  const handleTimelineScroll = useCallback((): void => {
    const element = scrollRef.current
    if (!element || pendingJumpNonce.current !== null) return
    const moved = element.scrollTop !== lastScrollTop.current
    const userMoved = Date.now() <= gestureUntil.current && moved
    const movedForward = element.scrollTop > lastScrollTop.current
    if (userMoved) explicitHistoryEntry.current = undefined
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 96
    if (userMoved && movedForward && atBottom && !loadingRef.current && hasContentRef.current) {
      // Resume only after a real, forward user scroll to the bottom, never
      // because an empty/partially rendered viewport happens to fit on screen.
      readingHistory.current = false
      manualScroll.current = false
      reservedHeight.current = 0
      if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
      element.scrollTop = element.scrollHeight
    }
    nearBottomRef.current = !readingHistory.current && atBottom
    if (!nearBottomRef.current) {
      readingHistory.current = true
      if (!explicitHistoryEntry.current || manualScroll.current) {
        manualScroll.current = true
        reserveSpace(element)
      }
    }
    lastScrollTop.current = element.scrollTop
    armPendingHistoryRevealRows(element)
    if (element.scrollTop <= 96) void loadOlder({ viaScroll: true })
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 96) void loadNewer({ viaScroll: true })
    scheduleVisibleHistoryUpdate()
  }, [loadNewer, loadOlder, scheduleVisibleHistoryUpdate, scrollRef, reserveSpace])

  return { visibleHistoryEntryId, handleTimelineScroll, scrollSurfaceRef }
}
