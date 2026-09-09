import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AgentState, TimelineItem } from '../agent/types'
import { armPendingHistoryRevealRows } from '../utils/historyReveal'
import { consumedInside, useHistoryPaging } from './useHistoryPaging'

const noNewerHistory = () => false
// Only tolerate pixel rounding here; the 96px pagination prefetch zone is NOT
// an instruction to resume following the live conversation.
const atScrollEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= 2

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
  hasNewerHistory?: () => boolean
}

function historyAnchor(container: HTMLElement): number {
  const style = getComputedStyle(container)
  const top = Math.min(container.clientHeight, parseFloat(style.getPropertyValue('--conversation-top-clearance')) || 0)
  const bottom = parseFloat(style.getPropertyValue('--conversation-bottom-clearance')) || 0
  const visibleHeight = Math.max(0, container.clientHeight - top - bottom)
  return container.getBoundingClientRect().top + container.clientTop + top + Math.min(visibleHeight * 0.38, 260)
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
  loadNewer,
  hasNewerHistory = noNewerHistory
}: UseConversationNavigationOptions) {
  const [visibleHistoryEntryId, setVisibleHistoryEntryId] = useState<string | undefined>()
  const historyScrollFrame = useRef<number | null>(null)
  const highlightedHistoryRow = useRef<HTMLElement | null>(null)
  const historyHighlightTimer = useRef<number | null>(null)
  const previousTimelineHeight = useRef(0)
  const previousTimelineLength = useRef(0)
  const previousContentHeight = useRef(0)
  const prependAnchor = useRef<{ element: HTMLElement; top: number; parent: Element | null } | null>(null)
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
  const observedContentHeight = useRef(0)
  const manualScroll = useRef(false)
  const gestureUntil = useRef(0)
  const lastScrollTop = useRef(0)
  const loadingRef = useRef(timelineLoading)
  const hasContentRef = useRef(timeline.length > 0)
  // This is provisional blank space, not an estimate of the entire history.
  // Keep its extent while the user is scrolling; actual content can fill it
  // naturally; an explicit jump or return to the end releases unused space.
  const reserveSpace = useCallback((element: HTMLElement, loading = false) => {
    const surface = scrollSurfaceRef.current
    if (!surface) return
    const height = surface.getBoundingClientRect().height
    const padding = Math.max(0, element.scrollHeight - height)
    reservedHeight.current = Math.max(reservedHeight.current, height,
      element.scrollTop + element.clientHeight - padding, loading ? element.clientHeight * 3 : 0)
    surface.style.minHeight = `${reservedHeight.current}px`
  }, [])

  const followEnd = useCallback((element: HTMLElement) => {
    readingHistory.current = false
    manualScroll.current = false
    explicitHistoryEntry.current = undefined
    reservedHeight.current = 0
    gestureUntil.current = 0
    if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
    nearBottomRef.current = true
  }, [])

  const timelineLength = timeline.length
  const { onScroll: pageOnScroll } = useHistoryPaging({
    scrollRef, timelineLength, loadOlder, loadNewer,
    owner: JSON.stringify([projectCwd, sessionPath, historyJump?.nonce])
  })
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
        previousContentHeight.current = 0
        prependAnchor.current = null
        reservedHeight.current = 0
        gestureUntil.current = 0
        if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
      }
    }
    if (historyJump?.nonce !== observedJumpNonce.current) {
      observedJumpNonce.current = historyJump?.nonce
      pendingJumpNonce.current = historyJump?.nonce ?? null
      explicitHistoryEntry.current = historyJump?.entryId
      if (historyJump) {
        // An explicit jump starts a new reading window, not a continuation of
        // manual scrolling through the previous window. Drop its provisional
        // height BEFORE measuring/clamping the target. Otherwise a short page
        // inherits the old page's blank tail until a bottom scroll releases it.
        manualScroll.current = false
        gestureUntil.current = 0
        reservedHeight.current = 0
        if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
        nearBottomRef.current = false
        readingHistory.current = true
      }
    }
    const reservedBeforeLayout = reservedHeight.current
    if (manualScroll.current || (timelineLoading && timelineLength === 0 && pendingJumpNonce.current === null)) {
      reserveSpace(element, timelineLoading && timelineLength === 0)
    } else {
      reservedHeight.current = 0
      if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
    }
    const previousHeight = previousTimelineHeight.current
    const content = element.querySelector<HTMLElement>('.timeline')
    const contentHeight = content?.offsetHeight ?? element.scrollHeight
    // Page replacement/prepend is handled here, not as a disclosure collapse.
    observedContentHeight.current = content?.offsetHeight ?? 0
    const addedTimelineItems = timelineLength > previousTimelineLength.current
    if (hasNewerHistory() || (timelineMutation === 'history-append' && addedTimelineItems)) {
      nearBottomRef.current = false
      readingHistory.current = true
    }
    if (timelineMutation === 'prepend' && addedTimelineItems && previousHeight > 0 && pendingJumpNonce.current === null) {
      // Prepending moves existing rows, even during manual scrolling. Keeping
      // the same numeric scrollTop would jump to the newly inserted page.
      // Measure a retained row in layout coordinates (not transformed screen
      // coordinates), independently of reserved blank space. Add only its
      // displacement to the CURRENT offset, preserving input during the fetch.
      const anchor = prependAnchor.current
      const displacement = element.scrollTop >= previousContentHeight.current ? 0
        : anchor && element.contains(anchor.element) && anchor.element.offsetParent === anchor.parent
          ? anchor.element.offsetTop - anchor.top
          : Math.max(0, contentHeight - previousContentHeight.current)
      if (displacement > 0 && reservedBeforeLayout > 0 && scrollSurfaceRef.current) {
        reservedHeight.current = Math.max(reservedHeight.current, reservedBeforeLayout + displacement)
        scrollSurfaceRef.current.style.minHeight = `${reservedHeight.current}px`
      }
      element.scrollTop += displacement
    } else if (timelineMutation === 'replace') {
      // Cache refreshes and new array references are not a request to go live.
      if (pendingJumpNonce.current === null && nearBottomRef.current && !(timelineLoading && timelineLength === 0)) element.scrollTop = element.scrollHeight
    } else if (timelineMutation === 'append') {
      // Follow the newest message only while the user is already near the
      // bottom; never yank someone away who is reading older history.
      if (pendingJumpNonce.current === null && nearBottomRef.current && !(timelineLoading && timelineLength === 0)) {
        element.scrollTop = element.scrollHeight
      }
    }
    previousTimelineHeight.current = element.scrollHeight
    previousTimelineLength.current = timelineLength
    previousContentHeight.current = contentHeight
    const firstRow = content?.firstElementChild
    prependAnchor.current = firstRow instanceof HTMLElement
      ? { element: firstRow, top: firstRow.offsetTop, parent: firstRow.offsetParent }
      : null
    lastScrollTop.current = element.scrollTop
  }, [lastGrow, lastItemId, busy, timelineLoading, timelineLength, timelineMutation, scrollRef, timeline, historyJump?.nonce, sessionPath, projectCwd, reserveSpace, hasNewerHistory])

  // Banners resize the viewport; floating summary/composer rows change its
  // padding. Preserve follow intent for both instead of deriving it again
  // from changed geometry. Top-clearance changes must preserve a reader's
  // current message position as well as their numeric scroll offset.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver !== 'function') return
    let previousClientHeight = element.clientHeight
    let previousPaddingTop = parseFloat(getComputedStyle(element).paddingTop) || 0
    const content = element.querySelector<HTMLElement>('.timeline')
    const observer = new ResizeObserver(() => {
      const nextContentHeight = content?.offsetHeight ?? 0
      const shrink = observedContentHeight.current - nextContentHeight
      observedContentHeight.current = nextContentHeight
      if (shrink > 0 && !loadingRef.current && content && reservedHeight.current > 0) {
        // A collapsed tool/thinking/detail must not leave its expanded height
        // pinned by manual reading. Remove only the lost content extent so a
        // genuine loading placeholder is not discarded wholesale.
        const remaining = Math.max(0, reservedHeight.current - shrink)
        reservedHeight.current = remaining <= nextContentHeight ? 0 : remaining
        if (scrollSurfaceRef.current) {
          scrollSurfaceRef.current.style.minHeight = reservedHeight.current > 0 ? `${reservedHeight.current}px` : ''
        }
        // Browser clamping after shrink is programmatic, not a new gesture or
        // permission to resume live following.
        lastScrollTop.current = element.scrollTop
      }
      const nextClientHeight = element.clientHeight
      const nextPaddingTop = parseFloat(getComputedStyle(element).paddingTop) || 0
      const topDisplacement = nextPaddingTop - previousPaddingTop
      previousPaddingTop = nextPaddingTop
      if (topDisplacement !== 0 && element.scrollTop > 0 && pendingJumpNonce.current === null) {
        element.scrollTop += topDisplacement
        lastScrollTop.current = element.scrollTop
      }
      // Observe both viewport and content: image/Markdown layout may finish
      // after the parent render. Geometry must not change the user's intent.
      if (nextClientHeight !== previousClientHeight) {
        previousClientHeight = nextClientHeight
        scrollSurfaceRef.current?.style.setProperty('--chat-viewport-height', `${nextClientHeight}px`)
      }
      if (loadingRef.current && !hasContentRef.current) return
      if (pendingJumpNonce.current === null && nearBottomRef.current && !readingHistory.current && !hasNewerHistory()) {
        element.scrollTop = element.scrollHeight
        lastScrollTop.current = element.scrollTop
        nearBottomRef.current = true
      }
    })
    observer.observe(element)
    if (scrollSurfaceRef.current) observer.observe(scrollSurfaceRef.current)
    // The outer min-height can hide a collapse from the surface observer.
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [scrollRef, hasNewerHistory, timelineLoading, timelineLength])

  // Panel visibility also changes bottom clearance in the current commit;
  // synchronize an existing follow intent without waiting for a resize delivery.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || pendingJumpNonce.current !== null || !nearBottomRef.current || hasNewerHistory() || (loadingRef.current && !hasContentRef.current)) return
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
  }, [scrollRef, panelsVisible, hasNewerHistory])

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

  useEffect(() => {
    scheduleVisibleHistoryUpdate()
  }, [scheduleVisibleHistoryUpdate, sessionPath, timelineLength])

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
    const resumeAtEnd = () => {
      if (!loadingRef.current && hasContentRef.current && !hasNewerHistory() && atScrollEnd(element)) followEnd(element)
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0 || consumedInside(event, element, event.deltaY > 0 ? 'newer' : 'older')) return
      resume()
      // At the hard end there may be no scroll event. Outward user input is
      // still an explicit return to the end (e.g. after a history jump).
      if (event.deltaY > 0) resumeAtEnd()
    }
    let touchY: number | undefined
    const touchStart = (event: TouchEvent) => { touchY = event.touches?.[0]?.clientY; resume() }
    const touchMove = (event: TouchEvent) => {
      const y = event.touches?.[0]?.clientY
      const previousY = touchY
      touchY = y
      if (y === undefined || previousY === undefined || y === previousY) return
      const forward = y < previousY
      if (consumedInside(event, element, forward ? 'newer' : 'older')) return
      resume()
      if (forward) resumeAtEnd()
    }
    const pointerMove = (event: PointerEvent) => { if (event.buttons) resume() }
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, [contenteditable]')) return
      const forward = ['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)
      if (consumedInside(event, element, forward ? 'newer' : 'older')) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) resume()
      if (['ArrowDown', 'PageDown'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) resumeAtEnd()
      if (event.key === 'End' && !loadingRef.current && hasContentRef.current) {
        event.preventDefault()
        readingHistory.current = hasNewerHistory()
        manualScroll.current = false
        explicitHistoryEntry.current = undefined
        reservedHeight.current = 0
        if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
        element.scrollTop = element.scrollHeight
        lastScrollTop.current = element.scrollTop
        nearBottomRef.current = !hasNewerHistory()
      }
    }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchmove', touchMove, { passive: true })
    element.addEventListener('pointermove', pointerMove)
    element.addEventListener('pointerdown', resume)
    element.addEventListener('keydown', key)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchstart', touchStart)
      element.removeEventListener('touchmove', touchMove)
      element.removeEventListener('pointermove', pointerMove)
      element.removeEventListener('pointerdown', resume)
      element.removeEventListener('keydown', key)
    }
  }, [scrollRef, reserveSpace, hasNewerHistory, followEnd])

  const handleTimelineScroll = useCallback((): void => {
    const element = scrollRef.current
    if (!element || pendingJumpNonce.current !== null) return
    const moved = element.scrollTop !== lastScrollTop.current
    const userMoved = manualScroll.current && Date.now() <= gestureUntil.current && moved
    const movedForward = element.scrollTop > lastScrollTop.current
    if (userMoved) {
      explicitHistoryEntry.current = undefined
      // Keep touch momentum/continuous scrollbar movement associated with
      // the user's gesture, rather than expiring mid-scroll after 300ms.
      gestureUntil.current = Date.now() + 300
    }
    const atBottom = atScrollEnd(element)
    const atSessionBottom = atBottom && !hasNewerHistory()
    if (userMoved && movedForward && atSessionBottom && !loadingRef.current && hasContentRef.current) {
      // Resume only after a real, forward user scroll to the bottom, never
      // because an empty/partially rendered viewport happens to fit on screen.
      followEnd(element)
    }
    if (userMoved && !(movedForward && atSessionBottom && !loadingRef.current && hasContentRef.current)) {
      nearBottomRef.current = false
      readingHistory.current = true
      reserveSpace(element)
    }
    // Loading placeholders, cache restoration and session switches can emit
    // scroll without any user input (even with no offset change). Never turn
    // those events into manual reading or freeze the placeholder's height.
    // Programmatic writers already synchronize their own offset/follow state.
    lastScrollTop.current = element.scrollTop
    armPendingHistoryRevealRows(element)
    // Layout compensation can emit scroll too. Its offset was already synced
    // above; do not cascade through every page on those no-movement events.
    pageOnScroll(userMoved, movedForward)
    scheduleVisibleHistoryUpdate()
  }, [pageOnScroll, scheduleVisibleHistoryUpdate, scrollRef, reserveSpace, hasNewerHistory, followEnd])

  return { visibleHistoryEntryId, handleTimelineScroll, scrollSurfaceRef }
}
