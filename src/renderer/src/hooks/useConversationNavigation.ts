import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AgentState, TimelineItem } from '../agent/types'
import { armPendingHistoryRevealRows } from '../utils/historyReveal'

interface UseConversationNavigationOptions {
  scrollRef: RefObject<HTMLDivElement | null>
  timeline: TimelineItem[]
  timelineMutation: AgentState['timelineMutation']
  busy: boolean
  sessionPath?: string
  historyIndexSessionPath?: string
  historyJump: AgentState['historyJump']
  loadOlder: (options?: { viaScroll?: boolean }) => Promise<void>
  loadNewer: (options?: { viaScroll?: boolean }) => Promise<void>
}

export function useConversationNavigation({
  scrollRef,
  timeline,
  timelineMutation,
  busy,
  sessionPath,
  historyIndexSessionPath,
  historyJump,
  loadOlder,
  loadNewer
}: UseConversationNavigationOptions) {
  const [visibleHistoryEntryId, setVisibleHistoryEntryId] = useState<string | undefined>()
  const historyScrollFrame = useRef<number | null>(null)
  const highlightedHistoryRow = useRef<HTMLElement | null>(null)
  const historyHighlightTimer = useRef<number | null>(null)
  const previousTimelineHeight = useRef(0)
  const previousTimelineLength = useRef(0)
  /** Live "user is at/near the bottom" flag, refreshed on scroll + layout. */
  const nearBottomRef = useRef(true)

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
    const previousHeight = previousTimelineHeight.current
    const addedTimelineItems = timelineLength > previousTimelineLength.current
    if (timelineMutation === 'prepend' && addedTimelineItems && previousHeight > 0) {
      // Keep the reading position stable while older history is prepended.
      element.scrollTop += element.scrollHeight - previousHeight
    } else if (timelineMutation === 'replace') {
      element.scrollTop = element.scrollHeight
    } else if (timelineMutation === 'append') {
      // Follow the newest message only while the user is already near the
      // bottom; never yank someone away who is reading older history.
      const wasNearBottom = previousHeight - element.scrollTop - element.clientHeight <= 80
      if (wasNearBottom || previousHeight === 0) element.scrollTop = element.scrollHeight
    }
    previousTimelineHeight.current = element.scrollHeight
    previousTimelineLength.current = timelineLength
    nearBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 96
  }, [lastGrow, lastItemId, busy, timelineLength, timelineMutation, scrollRef])

  // Async siblings above the scroller (run metrics strip, trust banner, error
  // banner) and the composer dock (task/queue panels) mount after a session
  // switch or mid-run and shrink the viewport. Track the pre-resize geometry:
  // if the view was at the bottom before the shrink, re-pin so the last line
  // is never sliced by the newly grown dock.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver !== 'function') return
    let previousClientHeight = element.clientHeight
    const observer = new ResizeObserver(() => {
      const nextClientHeight = element.clientHeight
      if (nextClientHeight === previousClientHeight) return
      // nearBottomRef is refreshed by layout effects that already see the new
      // (shrunken) height, so it can falsely report "not at bottom". Compute
      // the pre-resize state from the previous viewport height instead.
      const wasNearBottom = element.scrollTop + previousClientHeight >= element.scrollHeight - 96
      previousClientHeight = nextClientHeight
      if (wasNearBottom || nearBottomRef.current) {
        element.scrollTop = element.scrollHeight
        nearBottomRef.current = true
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef])

  const updateVisibleHistoryEntry = useCallback((): void => {
    const container = scrollRef.current
    if (!container) return
    const rows = [...container.querySelectorAll<HTMLElement>('.row-user[data-entry-id]')]
    if (rows.length === 0) {
      setVisibleHistoryEntryId(undefined)
      return
    }
    const rect = container.getBoundingClientRect()
    const anchor = rect.top + Math.min(container.clientHeight * 0.38, 260)
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
      const container = scrollRef.current
      const target = container
        ? [...container.querySelectorAll<HTMLElement>('[data-entry-id]')]
            .find((element) => element.dataset.entryId === jump.entryId)
        : undefined
      if (!target) return
      target.scrollIntoView({ behavior: 'auto', block: 'center' })
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

  const handleTimelineScroll = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    nearBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 96
    armPendingHistoryRevealRows(element)
    if (element.scrollTop <= 96) void loadOlder({ viaScroll: true })
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 96) void loadNewer({ viaScroll: true })
    scheduleVisibleHistoryUpdate()
  }, [loadNewer, loadOlder, scheduleVisibleHistoryUpdate, scrollRef])

  return { visibleHistoryEntryId, handleTimelineScroll }
}
