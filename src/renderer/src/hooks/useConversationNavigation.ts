import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AgentState, TimelineItem } from '../agent/types'
import type { SessionHistoryIndex } from '../../../shared/types'
import { armPendingHistoryRevealRows } from '../utils/historyReveal'
import { consumedInside, useHistoryPaging } from './useHistoryPaging'
import { createEndFollowAnimator } from '../utils/endFollowAnimator'
import { createHistoryJumpAnimator } from '../utils/historyJumpAnimator'

const noNewerHistory = () => false
// Only tolerate pixel rounding here; the 96px pagination prefetch zone is NOT
// an instruction to resume following the live conversation.
const atScrollEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= 1

interface UseConversationNavigationOptions {
  scrollRef: RefObject<HTMLDivElement | null>
  /** Rebind conditional viewport DOM without resetting the conversation's reading intent. */
  viewportActive?: boolean
  timeline: TimelineItem[]
  timelineMutation: AgentState['timelineMutation']
  busy: boolean
  timelineLoading?: boolean
  projectCwd?: string
  sessionPath?: string
  historyIndexSessionPath?: string
  historyIndex?: SessionHistoryIndex | null
  historyJump: AgentState['historyJump']
  /** Explicit same-session branch replacement (undo), not an ordinary reload. */
  historyResetRevision?: number
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
  viewportActive = true,
  timeline,
  timelineMutation,
  busy,
  timelineLoading = false,
  projectCwd,
  sessionPath,
  historyIndexSessionPath,
  historyIndex,
  historyJump,
  historyResetRevision = 0,
  panelsVisible,
  loadOlder,
  loadNewer,
  hasNewerHistory = noNewerHistory
}: UseConversationNavigationOptions) {
  const [visibleHistoryEntryId, setVisibleHistoryEntryId] = useState<string | undefined>()
  const historyIdentity = useRef({ sessionPath, index: historyIndex })
  historyIdentity.current = { sessionPath, index: historyIndex }
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
  const observedHistoryResetRevision = useRef(historyResetRevision)
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
  const followScope = useRef({ viewportActive, sessionPath, projectCwd, historyResetRevision, hasNewerHistory })
  followScope.current = { viewportActive, sessionPath, projectCwd, historyResetRevision, hasNewerHistory }
  const endFollow = useRef<{
    element: HTMLElement; sessionPath?: string; projectCwd?: string; reset: number
    controller: ReturnType<typeof createEndFollowAnimator>
  } | null>(null)
  const cancelEndFollow = useCallback(() => { endFollow.current?.controller.cancel() }, [])
  const historyMotion = useRef<ReturnType<typeof createHistoryJumpAnimator> | null>(null)
  const cancelHistoryMotion = useCallback(() => {
    historyMotion.current?.cancel()
    historyMotion.current = null
  }, [])
  const jumpScope = useRef({ viewportActive, sessionPath, projectCwd, historyResetRevision, nonce: historyJump?.nonce })
  jumpScope.current = { viewportActive, sessionPath, projectCwd, historyResetRevision, nonce: historyJump?.nonce }
  const panelPinSnapshot = useRef<{ element: HTMLElement; panelsVisible?: boolean; height: number; top: string; bottom: string; scope: string } | null>(null)
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
    cancelEndFollow()
    cancelHistoryMotion()
    pendingJumpNonce.current = null
    readingHistory.current = false
    manualScroll.current = false
    explicitHistoryEntry.current = undefined
    reservedHeight.current = 0
    gestureUntil.current = 0
    if (scrollSurfaceRef.current) scrollSurfaceRef.current.style.minHeight = ''
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
    nearBottomRef.current = true
  }, [cancelEndFollow, cancelHistoryMotion])

  // Active-marker tracking is read-only and independently frame-coalesced;
  // neither layout delivery nor an index refresh represents a scroll gesture.
  const updateVisibleHistoryEntry = useCallback((): void => {
    const container = scrollRef.current
    if (!viewportActive || !container) return
    // Keep a clicked landmark authoritative until actual user scrolling,
    // including when layout or a late history index cannot align its row.
    if (explicitHistoryEntry.current) {
      setVisibleHistoryEntryId(explicitHistoryEntry.current)
      return
    }
    // The last live turn may already be persisted/indexed while its SDK entry
    // ID has not reached the message row. Do not silently omit that user row.
    const rows = [...container.querySelectorAll<HTMLElement>('.row-user')]
    const entryForRow = (row: HTMLElement | undefined): string | undefined => {
      if (!row) return undefined
      if (row.dataset.entryId) return row.dataset.entryId
      const time = Number(row.dataset.userMessageTime)
      const { sessionPath: selectedPath, index } = historyIdentity.current
      if (!Number.isFinite(time) || time <= 0 || !selectedPath || index?.sessionPath !== selectedPath) return undefined
      // This is a display-only bridge, never a fork/undo identity. Both clocks
      // must be actual message clocks and unique; append time/text/ordinal are
      // not substitutes. Conflicting known row IDs also rule out the bridge.
      if (rows.filter((other) => Number(other.dataset.userMessageTime) === time).length !== 1) return undefined
      const matches = index.landmarks.filter((mark) => mark.messageTimestamp === time)
      if (matches.length !== 1 || rows.some((other) => other !== row && other.dataset.entryId === matches[0].entryId)) return undefined
      return matches[0].entryId
    }
    const content = container.querySelector<HTMLElement>('.timeline')
    const hasBlankTail = reservedHeight.current > 0
      && (!content || reservedHeight.current > content.offsetHeight + 1)
    // Short final turns may never reach the shared reading/jump reference
    // point, especially with floating composer clearance. At the genuine
    // session end the last MOUNTED user row owns the turn, not the last entry
    // in the whole-session index (which may describe an unloaded page).
    // A loading/min-height placeholder or a paged window's end is not that end.
    if (rows.length > 0 && atScrollEnd(container) && !hasNewerHistory()
      && !loadingRef.current && !hasBlankTail) {
      setVisibleHistoryEntryId(entryForRow(rows[rows.length - 1]))
      return
    }
    const anchor = historyAnchor(container)
    // A user's turn lasts until the next user row reaches the reference point.
    // Nearest row-top distance selects a future turn while a long message or
    // its assistant/tool response still spans the reference point.
    let active = rows[0]
    for (const row of rows) {
      if (row.getBoundingClientRect().top > anchor) break
      active = row
    }
    setVisibleHistoryEntryId(entryForRow(active))
  }, [scrollRef, hasNewerHistory, viewportActive])

  const scheduleVisibleHistoryUpdate = useCallback((): void => {
    if (!viewportActive || historyScrollFrame.current !== null) return
    historyScrollFrame.current = window.requestAnimationFrame(() => {
      historyScrollFrame.current = null
      updateVisibleHistoryEntry()
    })
  }, [updateVisibleHistoryEntry, viewportActive])

  const requestEndFollow = useCallback((element: HTMLElement) => {
    const scope = followScope.current
    let owned = endFollow.current
    if (!owned || owned.element !== element || owned.sessionPath !== scope.sessionPath
      || owned.projectCwd !== scope.projectCwd || owned.reset !== scope.historyResetRevision) {
      cancelEndFollow()
      const session = scope.sessionPath, project = scope.projectCwd, reset = scope.historyResetRevision
      const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
      const controller = createEndFollowAnimator({
        position: () => element.scrollTop,
        target: () => element.scrollHeight - element.clientHeight,
        valid: () => {
          const current = followScope.current
          return current.viewportActive && scrollRef.current === element
            && current.sessionPath === session && current.projectCwd === project && current.historyResetRevision === reset
            && nearBottomRef.current && !manualScroll.current && !readingHistory.current
            && pendingJumpNonce.current === null && !current.hasNewerHistory()
            && !(loadingRef.current && !hasContentRef.current)
        },
        reducedMotion: () => motion?.matches ?? false,
        now: () => performance.now(),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (id) => window.cancelAnimationFrame(id),
        write: (top) => {
          element.scrollTop = top
          // A smooth frame is programmatic, never a paging/reading gesture.
          lastScrollTop.current = element.scrollTop
          scheduleVisibleHistoryUpdate()
        }
      })
      owned = { element, sessionPath: session, projectCwd: project, reset, controller }
      endFollow.current = owned
    }
    owned.controller.request()
  }, [scrollRef, cancelEndFollow, scheduleVisibleHistoryUpdate])

  const timelineLength = timeline.length
  const { onScroll: pageOnScroll } = useHistoryPaging({
    scrollRef, timelineLength, loadOlder, loadNewer,
    owner: JSON.stringify([projectCwd, sessionPath, historyJump?.nonce, historyResetRevision])
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
    if (!viewportActive || !element) return
    const wasLoading = loadingRef.current
    loadingRef.current = timelineLoading
    hasContentRef.current = timelineLength > 0
    scrollSurfaceRef.current?.style.setProperty('--chat-viewport-height', `${element.clientHeight}px`)
    if (observedHistoryResetRevision.current !== historyResetRevision) {
      cancelEndFollow()
      cancelHistoryMotion()
      observedHistoryResetRevision.current = historyResetRevision
      // Undo selects a different branch without changing the session path.
      // Its old reading window, jump and gestures no longer describe this
      // content. Release the surface BEFORE locating the new branch's end;
      // empty loading may then reserve fresh, provisional space as usual.
      pendingJumpNonce.current = null
      observedJumpNonce.current = historyJump?.nonce
      previousTimelineHeight.current = 0
      previousTimelineLength.current = 0
      previousContentHeight.current = 0
      observedContentHeight.current = 0
      prependAnchor.current = null
      if (historyScrollFrame.current !== null) window.cancelAnimationFrame(historyScrollFrame.current)
      historyScrollFrame.current = null
      if (historyHighlightTimer.current !== null) window.clearTimeout(historyHighlightTimer.current)
      historyHighlightTimer.current = null
      highlightedHistoryRow.current?.classList.remove('history-jump-target')
      highlightedHistoryRow.current = null
      setVisibleHistoryEntryId(undefined)
      followEnd(element)
    }
    if (navigationSession.current !== sessionPath || navigationProject.current !== projectCwd) {
      cancelEndFollow()
      cancelHistoryMotion()
      pendingJumpNonce.current = null
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
      cancelEndFollow()
      cancelHistoryMotion()
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
      cancelEndFollow()
      nearBottomRef.current = false
      readingHistory.current = true
    }
    if (timelineMutation === 'prepend' && previousHeight > 0 && pendingJumpNonce.current === null) {
      cancelEndFollow()
      // Older pages can also relocate mounted live rows without adding any.
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
      if (pendingJumpNonce.current === null && nearBottomRef.current && !(timelineLoading && timelineLength === 0)) {
        // Same-session STATE/cache replacement may contain live growth. It must
        // not finish an in-flight curve by snapping to the new end.
        if (previousHeight > 0 && previousTimelineLength.current > 0 && !wasLoading && !timelineLoading
          && contentHeight >= previousContentHeight.current) requestEndFollow(element)
        else { cancelEndFollow(); element.scrollTop = element.scrollHeight }
      }
    } else if (timelineMutation === 'append') {
      // Follow the newest message only while the user is already near the
      // bottom; never yank someone away who is reading older history.
      if (pendingJumpNonce.current === null && nearBottomRef.current && !(timelineLoading && timelineLength === 0)) {
        if (previousHeight > 0 && previousTimelineLength.current > 0 && !timelineLoading && lastItem?.kind !== 'user') {
          requestEndFollow(element)
        } else {
          cancelEndFollow()
          element.scrollTop = element.scrollHeight
        }
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
  }, [lastGrow, lastItemId, busy, timelineLoading, timelineLength, timelineMutation, scrollRef, timeline, historyJump?.nonce, historyResetRevision, sessionPath, projectCwd, reserveSpace, hasNewerHistory, followEnd, viewportActive, requestEndFollow, cancelEndFollow, cancelHistoryMotion])

  // Banners resize the viewport; floating summary/composer rows change its
  // padding. Preserve follow intent for both instead of deriving it again
  // from changed geometry. Top-clearance changes must preserve a reader's
  // current message position as well as their numeric scroll offset.
  useEffect(() => {
    const element = scrollRef.current
    if (!viewportActive || !element || typeof ResizeObserver !== 'function') return
    let previousClientHeight = element.clientHeight
    let previousPaddingTop = parseFloat(getComputedStyle(element).paddingTop) || 0
    let previousPaddingBottom = parseFloat(getComputedStyle(element).paddingBottom) || 0
    const content = element.querySelector<HTMLElement>('.timeline')
    const observer = new ResizeObserver(() => {
      scheduleVisibleHistoryUpdate()
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
      const style = getComputedStyle(element)
      const nextPaddingTop = parseFloat(style.paddingTop) || 0
      const nextPaddingBottom = parseFloat(style.paddingBottom) || 0
      const viewportChanged = nextClientHeight !== previousClientHeight || nextPaddingTop !== previousPaddingTop || nextPaddingBottom !== previousPaddingBottom
      previousPaddingBottom = nextPaddingBottom
      if (viewportChanged || shrink > 0) cancelEndFollow()
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
        if (viewportChanged || shrink > 0 || loadingRef.current) {
          element.scrollTop = element.scrollHeight
          lastScrollTop.current = element.scrollTop
        } else requestEndFollow(element)
        nearBottomRef.current = true
      }
    })
    observer.observe(element)
    if (scrollSurfaceRef.current) observer.observe(scrollSurfaceRef.current)
    // The outer min-height can hide a collapse from the surface observer.
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [scrollRef, hasNewerHistory, timelineLoading, timelineLength, scheduleVisibleHistoryUpdate, viewportActive, requestEndFollow, cancelEndFollow])

  // Panel visibility also changes bottom clearance in the current commit;
  // synchronize an existing follow intent without waiting for a resize delivery.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!viewportActive || !element) { panelPinSnapshot.current = null; return }
    const style = getComputedStyle(element)
    const scope = JSON.stringify([projectCwd, sessionPath, historyResetRevision])
    const snapshot = { element, panelsVisible, height: element.clientHeight, top: style.paddingTop, bottom: style.paddingBottom, scope }
    const previous = panelPinSnapshot.current
    panelPinSnapshot.current = snapshot
    // A callback identity/render alone is not a clearance change. Otherwise
    // this immediate pin can overwrite the smooth frame just scheduled above.
    if (previous && previous.element === element && previous.panelsVisible === panelsVisible
      && previous.height === snapshot.height && previous.top === snapshot.top && previous.bottom === snapshot.bottom && previous.scope === scope) return
    if (pendingJumpNonce.current !== null || !nearBottomRef.current || hasNewerHistory() || (loadingRef.current && !hasContentRef.current)) return
    cancelEndFollow()
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
  }, [scrollRef, panelsVisible, hasNewerHistory, viewportActive, projectCwd, sessionPath, historyResetRevision, cancelEndFollow])

  useEffect(() => {
    scheduleVisibleHistoryUpdate()
  }, [scheduleVisibleHistoryUpdate, projectCwd, sessionPath, timeline, timelineLoading, historyResetRevision, historyIndexSessionPath, historyIndex, panelsVisible])

  useLayoutEffect(() => {
    const jump = historyJump
    if (!viewportActive || !jump || pendingJumpNonce.current !== jump.nonce) return
    cancelEndFollow()
    if (historyMotion.current?.isActive()) return
    const scope = jumpScope.current
    let frame: number | null = null
    let disposed = false
    let observer: MutationObserver | undefined
    let timeout: number | undefined
    const locate = () => {
      frame = null
      const current = jumpScope.current
      if (disposed || historyMotion.current?.isActive() || pendingJumpNonce.current !== jump.nonce || !current.viewportActive || current.sessionPath !== scope.sessionPath
        || current.projectCwd !== scope.projectCwd || current.historyResetRevision !== scope.historyResetRevision
        || current.nonce !== jump.nonce) return
      const container = scrollRef.current
      const target = container
        ? [...container.querySelectorAll<HTMLElement>('[data-entry-id]')]
            .find((element) => element.dataset.entryId === jump.entryId)
        : undefined
      if (!target || !container || !target.isConnected) {
        // A lazy history row can mount after the timeline commit. Observe real
        // DOM arrival within a bounded wait; never move toward an old row or
        // estimate missing page heights.
        return
      }
      observer?.disconnect()
      if (timeout !== undefined) window.clearTimeout(timeout)
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
      const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
      const controller: ReturnType<typeof createHistoryJumpAnimator> = createHistoryJumpAnimator({
        position: () => container.scrollTop,
        target: () => Math.max(0, Math.min(Math.max(0, container.scrollHeight - container.clientHeight),
          container.scrollTop + target.getBoundingClientRect().top - historyAnchor(container))),
        valid: () => {
          const current = jumpScope.current
          return current.viewportActive && current.sessionPath === scope.sessionPath
            && current.projectCwd === scope.projectCwd && current.historyResetRevision === scope.historyResetRevision
            && current.nonce === jump.nonce && pendingJumpNonce.current === jump.nonce
            && scrollRef.current === container && container.contains(target) && target.dataset.entryId === jump.entryId
            && target.isConnected
        },
        reducedMotion: () => motion?.matches ?? false,
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (id) => window.cancelAnimationFrame(id),
        write: (top) => {
          container.scrollTop = top
          lastScrollTop.current = container.scrollTop
          armPendingHistoryRevealRows(container)
        },
        settled: () => {
          if (pendingJumpNonce.current === jump.nonce) pendingJumpNonce.current = null
          if (historyMotion.current === controller) historyMotion.current = null
        }
      })
      historyMotion.current = controller
      controller.request()
      if (historyHighlightTimer.current !== null) {
        window.clearTimeout(historyHighlightTimer.current)
      }
      historyHighlightTimer.current = window.setTimeout(() => {
        target.classList.remove('history-jump-target')
        if (highlightedHistoryRow.current === target) highlightedHistoryRow.current = null
        historyHighlightTimer.current = null
      }, 1_600)
    }
    const scheduleLocate = () => {
      if (frame === null && pendingJumpNonce.current === jump.nonce && !historyMotion.current?.isActive()) {
        frame = window.requestAnimationFrame(locate)
      }
    }
    const container = scrollRef.current
    if (container && typeof MutationObserver === 'function') {
      observer = new MutationObserver(scheduleLocate)
      observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-entry-id'] })
    }
    timeout = window.setTimeout(() => {
      if (disposed) return
      observer?.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (pendingJumpNonce.current === jump.nonce && !historyMotion.current?.isActive()) {
        pendingJumpNonce.current = null
        explicitHistoryEntry.current = undefined
        scheduleVisibleHistoryUpdate()
      }
    }, 1_600)
    scheduleLocate()
    return () => {
      disposed = true
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [historyJump?.nonce, historyResetRevision, projectCwd, sessionPath, timeline, timelineLoading, scrollRef, scheduleVisibleHistoryUpdate, viewportActive, cancelEndFollow])

  // Arm eager historical rows after scroll restoration. Lazy chat rows also
  // arm themselves when their chunk finishes mounting; otherwise Suspense can
  // miss this timeline-keyed layout effect and leave their opacity at zero.
  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!viewportActive || !container) return
    armPendingHistoryRevealRows(container)
  }, [scrollRef, timeline, viewportActive])

  useEffect(() => {
    if (!viewportActive || !scrollRef.current) return
    const armVisibleHistory = (): void => {
      const container = scrollRef.current
      if (container) armPendingHistoryRevealRows(container)
    }
    window.addEventListener('resize', armVisibleHistory)
    return () => window.removeEventListener('resize', armVisibleHistory)
  }, [scrollRef, viewportActive])

  useEffect(() => {
    if (!viewportActive) return
    return () => {
      cancelEndFollow()
      cancelHistoryMotion()
      pendingJumpNonce.current = null
      if (historyScrollFrame.current !== null) window.cancelAnimationFrame(historyScrollFrame.current)
      historyScrollFrame.current = null
      if (historyHighlightTimer.current !== null) window.clearTimeout(historyHighlightTimer.current)
      historyHighlightTimer.current = null
      highlightedHistoryRow.current?.classList.remove('history-jump-target')
      highlightedHistoryRow.current = null
    }
  }, [viewportActive, cancelEndFollow, cancelHistoryMotion])

  useEffect(() => {
    const hidden = () => {
      if (!document.hidden) return
      cancelEndFollow()
      cancelHistoryMotion()
      pendingJumpNonce.current = null
    }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [cancelEndFollow, cancelHistoryMotion])

  // Programmatic scroll events (including scrollIntoView and resize clamping)
  // must not cancel an explicit history jump. Resume only after user input.
  useEffect(() => {
    const element = scrollRef.current
    if (!viewportActive || !element) return
    const resume = () => {
      cancelEndFollow()
      cancelHistoryMotion()
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
      if (!loadingRef.current && hasContentRef.current && !hasNewerHistory() && atScrollEnd(element)) {
        followEnd(element)
        scheduleVisibleHistoryUpdate()
      }
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0 || consumedInside(event, element, event.deltaY > 0 ? 'newer' : 'older')) return
      resume()
      // At the hard end there may be no scroll event. Outward user input is
      // still an explicit return to the end (e.g. after a history jump).
      if (event.deltaY > 0) resumeAtEnd()
    }
    // A disclosure tap is an operation, not a reading gesture. Real wheel,
    // touch movement or dragging outside controls still pauses immediately.
    const insideControl = (event: Event) => {
      const control = event.target instanceof Element
        ? event.target.closest('input, textarea, select, button, summary, [role="button"], [contenteditable]')
        : null
      return control !== null && control !== element && element.contains(control)
    }
    let touchY: number | undefined
    const touchStart = (event: TouchEvent) => { touchY = event.touches?.[0]?.clientY; if (!insideControl(event)) resume() }
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
    // Keep the existing intent (including history reading); an operation
    // cannot grant follow intent. Subsequent growth uses the resize observer.
    const pointerDown = (event: PointerEvent) => { if (!insideControl(event)) resume() }
    const pointerMove = (event: PointerEvent) => { if (event.buttons && !insideControl(event)) resume() }
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, summary, [role="button"], [contenteditable]')) return
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
        scheduleVisibleHistoryUpdate()
      }
    }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchmove', touchMove, { passive: true })
    element.addEventListener('pointermove', pointerMove)
    element.addEventListener('pointerdown', pointerDown)
    element.addEventListener('keydown', key)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchstart', touchStart)
      element.removeEventListener('touchmove', touchMove)
      element.removeEventListener('pointermove', pointerMove)
      element.removeEventListener('pointerdown', pointerDown)
      element.removeEventListener('keydown', key)
    }
  }, [scrollRef, reserveSpace, hasNewerHistory, followEnd, historyResetRevision, scheduleVisibleHistoryUpdate, viewportActive, cancelEndFollow, cancelHistoryMotion])

  const handleTimelineScroll = useCallback((): void => {
    const element = scrollRef.current
    if (!viewportActive || !element || pendingJumpNonce.current !== null) return
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
  }, [pageOnScroll, scheduleVisibleHistoryUpdate, scrollRef, reserveSpace, hasNewerHistory, followEnd, viewportActive])

  return { visibleHistoryEntryId, handleTimelineScroll, scrollSurfaceRef }
}
