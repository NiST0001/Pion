import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { AgentMode, HistoryLandmark, PionApi } from '../../../../shared/types'
import type { Action, AgentState, TimelineItem } from '../../agent/types'
import {
  collectToolResults,
  entriesToTimeline,
  getViewportHistoryPageSize,
  storeTimelineCache,
  uniqueTimelineItems
} from '../../agent/timeline'
import type { HistoryCursor, TimelineCacheEntry } from '../../agent/timeline'

/**
 * Yield through a real paint before starting the next expensive switch phase.
 * Two animation frames guarantee that React's pending UI commit is visible;
 * the timeout prevents an occluded Electron window from stalling forever.
 */
function waitForNextPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    let firstFrame = 0
    let secondFrame = 0
    let fallback = 0
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(fallback)
      if (firstFrame) window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
      resolve()
    }
    fallback = window.setTimeout(finish, 100)
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(finish)
    })
  })
}

interface UseAgentHistoryOptions {
  api: PionApi | undefined
  state: AgentState
  dispatch: Dispatch<Action>
}

export function useAgentHistory({ api, state, dispatch }: UseAgentHistoryOptions) {
  const timelineLoadId = useRef(0)
  const historyIndexLoadId = useRef(0)
  const historyIndexInFlight = useRef<{ path: string; promise: Promise<void>; dirty: boolean } | null>(null)
  const historyJumpNonce = useRef(0)
  const timelineCache = useRef(new Map<string, TimelineCacheEntry>())
  const historyCursor = useRef<HistoryCursor | null>(null)
  const timelineOwnerPath = useRef<string | undefined>(undefined)
  const expectedTimeline = useRef<{ path: string; items: TimelineItem[] } | null>(null)

  // Read the authoritative cursor at event time, not a potentially stale
  // React snapshot. A loaded page's end is not necessarily the session end.
  const hasNewerHistory = useCallback((): boolean => {
    const cursor = historyCursor.current
    return Boolean(cursor && cursor.loadId === timelineLoadId.current && !cursor.newerComplete)
  }, [])

  const showTimeline = useCallback((path: string, items: TimelineItem[], mode: AgentMode): void => {
    timelineOwnerPath.current = path
    expectedTimeline.current = { path, items }
    dispatch({ type: 'loadEntries', items, mode })
  }, [])

  const restoreCachedTimeline = useCallback((path: string, cached: TimelineCacheEntry): void => {
    const loadId = ++timelineLoadId.current
    // Cached snapshots may contain live-created rows without `historical`, or
    // rows whose first reveal already ran before they were cached. Clone the
    // snapshot for each revisit so short and second-load sessions replay the
    // same restrained opacity cascade as a cold history load.
    const items = cached.items.map((item) => ({ ...item, historical: true }))
    const revealedCache = { ...cached, items }
    const cursor: HistoryCursor | null = revealedCache.complete && revealedCache.newerComplete
      ? null
      : { path, ...revealedCache, loading: false, loadId }
    historyCursor.current = cursor
    storeTimelineCache(timelineCache.current, path, revealedCache)
    showTimeline(path, items, revealedCache.mode)
  }, [showTimeline])

  // Keep a loaded session's rendered timeline in memory. Switching back to a
  // retained backend should restore this snapshot instead of transferring and
  // parsing the complete JSONL file again.
  useEffect(() => {
    const expected = expectedTimeline.current
    if (expected && (expected.path !== timelineOwnerPath.current || state.timeline !== expected.items)) return
    if (expected) expectedTimeline.current = null

    const path = timelineOwnerPath.current
    if (!path) return
    const cached = timelineCache.current.get(path)
    if (!cached) return
    const cursor = historyCursor.current
    if (cursor?.path === path) cursor.items = state.timeline
    storeTimelineCache(timelineCache.current, path, {
      ...cached,
      items: state.timeline,
      mode: state.mode
    })
  }, [state.mode, state.timeline])

  /** Load only the newest history window; older windows are fetched on demand. */
  const reloadTimeline = useCallback(async (sessionPath?: string): Promise<void> => {
    if (!api) return
    const loadId = ++timelineLoadId.current
    const path = sessionPath
      ?? timelineOwnerPath.current
      ?? (await api.getState().catch(() => null))?.sessionFile
    const cached = path ? timelineCache.current.get(path) : undefined
    const keepVisibleCache = Boolean(path && cached && timelineOwnerPath.current === path)
    historyCursor.current = null
    // A retained session is already fully paintable from memory. Revalidate its
    // JSONL in the background without showing a loading state or blanking it.
    if (path && !keepVisibleCache) dispatch({ type: 'timelineLoading', loading: true })

    let page = null
    for (let attempt = 0; attempt < 3; attempt++) {
      page = await api.getEntriesPage(undefined, getViewportHistoryPageSize(), path)
        .catch(() => null)
      if (page || loadId !== timelineLoadId.current) break
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)))
    }
    if (loadId !== timelineLoadId.current) return
    if (!page) {
      if (keepVisibleCache) {
        console.warn('[pion] retained timeline revalidation failed; keeping cached view:', path)
        return
      }
      dispatch({
        type: 'timelineError',
        error: '会话历史加载失败，请重新选择该会话或检查会话文件是否仍然存在。'
      })
      return
    }

    if (
      path
      && cached
      && cached.leafId === page.leafId
      && cached.total === page.total
    ) {
      const cursor: HistoryCursor | null = cached.complete && cached.newerComplete
        ? null
        : { path, ...cached, loading: false, loadId }
      historyCursor.current = cursor
      storeTimelineCache(timelineCache.current, path, cached)
      // The exact snapshot is already on screen. Avoid a second replace action,
      // which would reset scroll position and look like another session load.
      if (!keepVisibleCache) showTimeline(path, cached.items, cached.mode)
      return
    }

    const toolResults = collectToolResults([...page.entries, ...page.toolResults])
    // Mount the complete newest page as one stable snapshot. Splitting out a
    // special bottom-only slice made long sessions visibly appear in phases.
    const initialItems = entriesToTimeline(page.entries, toolResults)
    const cursor: HistoryCursor = {
      path: path ?? '',
      items: initialItems,
      mode: page.mode,
      apiBefore: page.start,
      apiAfter: page.end,
      toolResults: page.toolResults,
      complete: page.start === 0,
      newerComplete: page.end >= page.total,
      leafId: page.leafId,
      total: page.total,
      loading: false,
      loadId
    }

    if (path) {
      storeTimelineCache(timelineCache.current, path, {
        items: cursor.items,
        mode: cursor.mode,
        apiBefore: cursor.apiBefore,
        apiAfter: cursor.apiAfter,
        toolResults: cursor.toolResults,
        complete: cursor.complete,
        newerComplete: cursor.newerComplete,
        leafId: cursor.leafId,
        total: cursor.total
      })
      historyCursor.current = cursor.complete && cursor.newerComplete ? null : cursor
      showTimeline(path, cursor.items, cursor.mode)
    } else {
      dispatch({ type: 'loadEntries', items: cursor.items, mode: cursor.mode })
    }
  }, [api, showTimeline])

  /** Fetch and prepend the next older history window when the user reaches the top. */
  const loadOlder = useCallback(async (options?: { viaScroll?: boolean }): Promise<void> => {
    if (!api) return
    const cursor = historyCursor.current
    if (!cursor || cursor.loading || cursor.complete) return
    cursor.loading = true
    const loadId = cursor.loadId
    try {
      // A chunk can render zero timeline items (e.g. toolResult-only entries).
      // Keep consuming older chunks until something is prepended or history is
      // exhausted, otherwise the view would stall at the top with no scroll
      // events left to trigger the next load.
      for (let attempt = 0; attempt < 16; attempt++) {
        if (loadId !== timelineLoadId.current || historyCursor.current !== cursor) return
        const page = await api.getEntriesPage(
          cursor.apiBefore,
          getViewportHistoryPageSize(),
          cursor.path
        )
        if (!page || loadId !== timelineLoadId.current || historyCursor.current !== cursor) return
        cursor.toolResults = page.toolResults
        cursor.apiBefore = page.start
        cursor.leafId = page.leafId
        cursor.total = page.total

        const incomingItems = entriesToTimeline(
          page.entries,
          collectToolResults([...page.entries, ...page.toolResults])
        )
        // User-scroll paging renders statically; the initial viewport fill
        // (fillViewport) still joins the waterfall.
        if (options?.viaScroll) for (const item of incomingItems) item.noReveal = true
        const items = uniqueTimelineItems(cursor.items, incomingItems)
        cursor.items = [...items, ...cursor.items]
        cursor.complete = cursor.apiBefore === 0
        if (items.length > 0) dispatch({ type: 'prependEntries', items })
        storeTimelineCache(timelineCache.current, cursor.path, {
          items: cursor.items,
          mode: cursor.mode,
          apiBefore: cursor.apiBefore,
          apiAfter: cursor.apiAfter,
          toolResults: cursor.toolResults,
          complete: cursor.complete,
          newerComplete: cursor.newerComplete,
          leafId: cursor.leafId,
          total: cursor.total
        })
        if (cursor.complete) {
          if (cursor.newerComplete) historyCursor.current = null
          return
        }
        if (items.length > 0) return
      }
    } finally {
      if (historyCursor.current === cursor) cursor.loading = false
    }
  }, [api])

  /** Fetch and append newer history after jumping into the middle of a session. */
  const loadNewer = useCallback(async (options?: { viaScroll?: boolean }): Promise<void> => {
    if (!api) return
    const cursor = historyCursor.current
    if (!cursor || cursor.loading || cursor.newerComplete) return
    cursor.loading = true
    const loadId = cursor.loadId
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        if (loadId !== timelineLoadId.current || historyCursor.current !== cursor) return
        const end = Math.min(cursor.total, cursor.apiAfter + getViewportHistoryPageSize())
        const limit = Math.max(1, end - cursor.apiAfter)
        const page = await api.getEntriesPage(end, limit, cursor.path)
        if (!page || loadId !== timelineLoadId.current || historyCursor.current !== cursor) return
        cursor.apiAfter = page.end
        cursor.toolResults = page.toolResults
        cursor.leafId = page.leafId
        cursor.total = page.total
        cursor.newerComplete = cursor.apiAfter >= cursor.total

        const incomingItems = entriesToTimeline(
          page.entries,
          collectToolResults([...page.entries, ...page.toolResults])
        )
        if (options?.viaScroll) for (const item of incomingItems) item.noReveal = true
        const items = uniqueTimelineItems(cursor.items, incomingItems)
        cursor.items = [...cursor.items, ...items]
        if (items.length > 0) dispatch({ type: 'appendEntries', items })
        storeTimelineCache(timelineCache.current, cursor.path, {
          items: cursor.items,
          mode: cursor.mode,
          apiBefore: cursor.apiBefore,
          apiAfter: cursor.apiAfter,
          toolResults: cursor.toolResults,
          complete: cursor.complete,
          newerComplete: cursor.newerComplete,
          leafId: cursor.leafId,
          total: cursor.total
        })
        if (cursor.newerComplete) {
          if (cursor.complete) historyCursor.current = null
          return
        }
        if (items.length > 0) return
      }
    } finally {
      if (historyCursor.current === cursor) cursor.loading = false
    }
  }, [api])

  const refreshHistoryIndex = useCallback(async (sessionPath?: string): Promise<void> => {
    if (!api) return
    if (!sessionPath) {
      ++historyIndexLoadId.current
      historyIndexInFlight.current = null
      dispatch({ type: 'historyIndex', index: null })
      return
    }
    const existing = historyIndexInFlight.current
    if (existing?.path === sessionPath) {
      existing.dirty = true
      return existing.promise
    }

    const loadId = ++historyIndexLoadId.current
    const flight = { path: sessionPath, promise: Promise.resolve(), dirty: false }
    historyIndexInFlight.current = flight
    flight.promise = (async () => {
      do {
        flight.dirty = false
        const index = await api.getHistoryIndex(sessionPath).catch(() => null)
        // Transient reads must not remove the rail. A late snapshot must not
        // replace the index belonging to a newly selected history window.
        if (index && loadId === historyIndexLoadId.current && timelineOwnerPath.current === sessionPath) {
          dispatch({ type: 'historyIndex', index })
        }
      } while (flight.dirty && loadId === historyIndexLoadId.current && timelineOwnerPath.current === sessionPath)
    })().finally(() => {
      if (historyIndexInFlight.current === flight) historyIndexInFlight.current = null
    })
    return flight.promise
  }, [api])

  useEffect(() => {
    const sessionPath = state.session?.sessionFile
    if (
      !sessionPath
      || state.timelineLoading
      || timelineOwnerPath.current !== sessionPath
    ) return
    void refreshHistoryIndex(sessionPath)
  }, [refreshHistoryIndex, state.session?.sessionFile, state.timelineLoading])

  useEffect(() => {
    const path = state.session?.sessionFile
    if (!api || !path) return
    let timer: number | undefined
    const off = api.onEvent((event) => {
      if (event.type === 'entry_appended') {
        const entry = event.entry as { type?: string; message?: { role?: string } } | undefined
        if (entry?.type !== 'compaction' && (entry?.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role ?? ''))) return
      }
      if (event.type === 'message_end') {
        const message = event.message as { role?: string } | undefined
        if (!['user', 'assistant'].includes(message?.role ?? '')) return
      }
      // Persisted entries supply real, jumpable IDs. Do not read the entire
      // index for each streamed token or for unrelated background sessions.
      if (!['entry_appended', 'message_end', 'agent_settled', 'compaction_end'].includes(event.type)
        || timelineOwnerPath.current !== path || timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        if (timelineOwnerPath.current === path) void refreshHistoryIndex(path)
      }, 60)
    })
    return () => {
      off()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [api, refreshHistoryIndex, state.session?.sessionFile])

  /** Fork before a user message; resolves with the message text for prefill. */
  const forkAt = useCallback(
    async (entryId: string): Promise<string> => {
      if (!api) return ''
      const result = await api.forkAt(entryId)
      if (!result.cancelled) {
        timelineOwnerPath.current = undefined
        historyCursor.current = null
        await reloadTimeline()
        return result.text
      }
      return ''
    },
    [api, reloadTimeline]
  )

  const switchSession = useCallback(
    async (sessionPath: string): Promise<{ cancelled: boolean }> => {
      if (!api) return { cancelled: true }
      const previousPath = timelineOwnerPath.current
      const previousCached = previousPath ? timelineCache.current.get(previousPath) : undefined
      const cached = timelineCache.current.get(sessionPath)
      const restorableLimit = getViewportHistoryPageSize()
      const restorableCache = cached && cached.items.length <= restorableLimit
        ? cached
        : undefined
      if (cached && !restorableCache) timelineCache.current.delete(sessionPath)

      ++historyIndexLoadId.current
      historyIndexInFlight.current = null
      const selectionLoadId = ++timelineLoadId.current
      historyCursor.current = null
      timelineOwnerPath.current = sessionPath
      expectedTimeline.current = null
      dispatch({ type: 'historyIndex', index: null })
      dispatch({ type: 'clearTimeline' })
      dispatch({ type: 'timelineLoading', loading: true })

      // Phase 1 is UI-only: commit the selected sidebar row and lightweight
      // loading shell before cached messages, JSONL parsing, or backend startup.
      await waitForNextPaint()
      if (selectionLoadId !== timelineLoadId.current) return { cancelled: true }

      // Phase 2 mounts a bounded cached conversation with historical opacity
      // markers. Clearing in the prior paint guarantees the fade replays.
      let requestLoadId = selectionLoadId
      if (restorableCache) {
        restoreCachedTimeline(sessionPath, restorableCache)
        requestLoadId = timelineLoadId.current
      }

      const restorePreviousTimeline = (): void => {
        if (previousPath && previousCached) {
          restoreCachedTimeline(previousPath, previousCached)
        } else {
          historyCursor.current = null
          timelineOwnerPath.current = previousPath
          expectedTimeline.current = null
          dispatch({ type: 'clearTimeline' })
        }
      }

      let result: { cancelled: boolean }
      try {
        result = await api.switchSession(sessionPath)
      } catch (error) {
        if (requestLoadId === timelineLoadId.current) {
          restorePreviousTimeline()
          dispatch({
            type: 'timelineError',
            error: error instanceof Error ? error.message : String(error)
          })
        }
        throw error
      }
      if (result.cancelled || requestLoadId !== timelineLoadId.current) {
        if (result.cancelled && requestLoadId === timelineLoadId.current) {
          restorePreviousTimeline()
        }
        return { cancelled: true }
      }

      // Phase 2 finishes with a bounded newest history window. Give its opacity
      // cascade a real paint before indexing the full session or enabling Git.
      await reloadTimeline(sessionPath)
      const contentLoadId = timelineLoadId.current
      await waitForNextPaint()
      if (contentLoadId !== timelineLoadId.current) return { cancelled: true }

      // Phase 3 builds navigation metadata. App-level resource staging enables
      // review files only after this resolves; models refresh from lifecycle events.
      await refreshHistoryIndex(sessionPath)
      return result
    },
    [api, refreshHistoryIndex, reloadTimeline, restoreCachedTimeline]
  )

  const jumpToHistoryLandmark = useCallback(async (landmark: HistoryLandmark): Promise<void> => {
    const index = state.historyIndex
    if (!api || !index || !index.sessionPath || index.totalEntries <= 0) return
    const loadId = ++timelineLoadId.current
    const end = Math.min(
      index.totalEntries,
      Math.max(
        Math.min(getViewportHistoryPageSize(), index.totalEntries),
        landmark.entryIndex + Math.floor(getViewportHistoryPageSize() * 0.35)
      )
    )
    const limit = Math.min(getViewportHistoryPageSize(), end)
    dispatch({ type: 'timelineLoading', loading: true })

    let page = null
    for (let attempt = 0; attempt < 3; attempt++) {
      page = await api.getEntriesPage(end, limit, index.sessionPath).catch(() => null)
      if (page || loadId !== timelineLoadId.current) break
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)))
    }
    if (loadId !== timelineLoadId.current) return
    if (!page) {
      dispatch({ type: 'timelineError', error: '无法加载所选历史消息。' })
      return
    }

    const items = entriesToTimeline(
      page.entries,
      collectToolResults([...page.entries, ...page.toolResults])
    )
    // Keep the in-flight assistant message pinned to the end of the jumped
    // window so the live stream keeps rendering instead of being dropped.
    const liveItems = state.timeline.filter((item) => (
      item.kind === 'assistant'
      && item.streaming
      && !items.some((pageItem) => pageItem.id === item.id)
    ))
    const windowedItems = [...items, ...liveItems]
    const cursor: HistoryCursor = {
      path: index.sessionPath,
      items,
      mode: page.mode,
      apiBefore: page.start,
      apiAfter: page.end,
      toolResults: page.toolResults,
      complete: page.start === 0,
      newerComplete: page.end >= page.total,
      leafId: page.leafId,
      total: page.total,
      loading: false,
      loadId
    }
    timelineOwnerPath.current = index.sessionPath
    historyCursor.current = cursor.complete && cursor.newerComplete ? null : cursor
    storeTimelineCache(timelineCache.current, index.sessionPath, {
      items: windowedItems,
      mode: cursor.mode,
      apiBefore: cursor.apiBefore,
      apiAfter: cursor.apiAfter,
      toolResults: cursor.toolResults,
      complete: cursor.complete,
      newerComplete: cursor.newerComplete,
      leafId: cursor.leafId,
      total: cursor.total
    })
    showTimeline(index.sessionPath, windowedItems, page.mode)
    dispatch({
      type: 'historyJump',
      entryId: landmark.entryId,
      nonce: ++historyJumpNonce.current
    })
  }, [api, showTimeline, state.historyIndex])


  return {
    timelineLoadId,
    historyIndexLoadId,
    historyIndexInFlight,
    timelineCache,
    historyCursor,
    timelineOwnerPath,
    expectedTimeline,
    reloadTimeline,
    loadOlder,
    loadNewer,
    hasNewerHistory,
    refreshHistoryIndex,
    forkAt,
    switchSession,
    jumpToHistoryLandmark
  }
}
