import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { AgentMode, HistoryLandmark, MessageRevertResult, PionApi, SessionHistoryIndex } from '../../../../shared/types'
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
  const historyIndexAppliedId = useRef(0)
  const historyIndexInFlight = useRef<{ path: string; promise: Promise<void>; dirty: boolean } | null>(null)
  const historyJumpNonce = useRef(0)
  const timelineCache = useRef(new Map<string, TimelineCacheEntry>())
  const historyCursor = useRef<HistoryCursor | null>(null)
  const timelineOwnerPath = useRef<string | undefined>(undefined)
  const expectedTimeline = useRef<{ path: string; items: TimelineItem[] } | null>(null)
  const currentState = useRef(state)
  currentState.current = state
  // A cleared owner must not immediately re-adopt the snapshot from before
  // an explicit new/switch intent. Only a subsequent authoritative snapshot
  // may claim an otherwise unowned live timeline.
  const invalidatedOwnerSnapshot = useRef<AgentState['session'] | undefined>(undefined)
  const selectionRef = useRef({
    generation: 0,
    ownerPath: timelineOwnerPath.current,
    cwd: state.status.cwd,
    sessionId: state.session?.sessionId,
    sessionPath: state.session?.sessionFile
  })
  const readSelection = useCallback(() => {
    const previous = selectionRef.current
    const current = currentState.current
    const session = current.session
    if (!timelineOwnerPath.current && session?.sessionFile && session.sessionId
      && current.status.phase === 'running' && session !== invalidatedOwnerSnapshot.current) {
      // Fresh sessions do not load history before their first live messages.
      // Establish ownership without replacing those rows, before consumers
      // capture the selection generation (in particular, before undo starts).
      timelineOwnerPath.current = session.sessionFile
    }
    const ownerPath = timelineOwnerPath.current
    const cwd = current.status.cwd ?? previous.cwd
    const sameOwner = previous.ownerPath === ownerPath && previous.cwd === cwd
    // Backend restart/errors can temporarily clear state.session. They do not
    // select another conversation; retain its logical identity through gaps.
    const sessionId = session?.sessionId ?? (sameOwner ? previous.sessionId : undefined)
    const sessionPath = session?.sessionFile ?? (sameOwner ? previous.sessionPath : undefined)
    if (previous.ownerPath !== ownerPath || previous.cwd !== cwd
      || previous.sessionId !== sessionId || previous.sessionPath !== sessionPath) {
      selectionRef.current = {
        generation: previous.generation + 1,
        ownerPath,
        cwd,
        sessionId,
        sessionPath
      }
    }
    return selectionRef.current
  }, [])
  const { ownerPath: logicalOwnerPath, sessionId: logicalSessionId } = readSelection()
  useEffect(() => () => {
    selectionRef.current = { ...selectionRef.current, generation: selectionRef.current.generation + 1 }
    ++timelineLoadId.current
    ++historyIndexLoadId.current
    historyIndexInFlight.current = null
  }, [])

  // A mutation keeps the old view paintable, but no reader may publish a
  // pre-mutation branch. New selections of that path wait for its outcome.
  const revertInFlight = useRef<{ path: string; settled: boolean; done: Promise<void> } | null>(null)
  const branchRevisions = useRef(new Map<string, number>())
  const invalidateHistoryReads = useCallback((): number => {
    const loadId = ++timelineLoadId.current
    ++historyIndexLoadId.current
    historyIndexInFlight.current = null
    const cursor = historyCursor.current
    if (cursor) historyCursor.current = { ...cursor, loadId, loading: false }
    dispatch({ type: 'beginTaskRestore', id: loadId })
    return loadId
  }, [dispatch])
  // Explicit intent matters even when a switch is cancelled, or A -> B -> A
  // happens before React commits a different session snapshot.
  const invalidateSelection = useCallback((): void => {
    const selection = readSelection()
    invalidatedOwnerSnapshot.current = currentState.current.session
    selectionRef.current = { ...selection, generation: selection.generation + 1 }
    invalidateHistoryReads()
  }, [invalidateHistoryReads, readSelection])

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

  const restoreCachedTimeline = useCallback((path: string, cached: TimelineCacheEntry, revision: number): boolean => {
    if (revision !== (branchRevisions.current.get(path) ?? 0)
      || (revertInFlight.current?.path === path && !revertInFlight.current.settled)) return false
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
    if (cached.tasks !== undefined && cached.tasks !== null) dispatch({ type: 'cachedTasks', tasks: cached.tasks })
    showTimeline(path, items, revealedCache.mode)
    return true
  }, [dispatch, showTimeline])

  // Keep a loaded session's rendered timeline in memory. Switching back to a
  // retained backend should restore this snapshot instead of transferring and
  // parsing the complete JSONL file again.
  useEffect(() => {
    const expected = expectedTimeline.current
    if (expected && (expected.path !== timelineOwnerPath.current || state.timeline !== expected.items)) return
    if (expected) expectedTimeline.current = null

    const path = timelineOwnerPath.current
    if (!path || state.timelineLoading
      || (revertInFlight.current?.path === path && !revertInFlight.current.settled)) return
    const cached = timelineCache.current.get(path)
    if (!cached) return
    const cursor = historyCursor.current
    if (cursor?.path === path) cursor.items = state.timeline
    storeTimelineCache(timelineCache.current, path, {
      ...cached,
      items: state.timeline,
      mode: state.mode,
      tasks: state.tasks
    })
  }, [state.mode, state.timeline, state.tasks, state.timelineLoading])

  /** Load only the newest history window; older windows are fetched on demand. */
  const reloadTimeline = useCallback(async (sessionPath?: string): Promise<void> => {
    if (!api) return
    const loadId = ++timelineLoadId.current
    const path = sessionPath
      ?? timelineOwnerPath.current
      ?? (await api.getState().catch(() => null))?.sessionFile
    const mutation = revertInFlight.current
    if (mutation && mutation.path === path && !mutation.settled) await mutation.done
    if (loadId !== timelineLoadId.current) return
    // Capture the reducer's revision atomically, before the asynchronous read.
    dispatch({ type: 'beginTaskRestore', id: loadId })
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

    if (page.taskSnapshot !== undefined) {
      dispatch({ type: 'restoreTasks', id: loadId, tasks: page.taskSnapshot })
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
    if (!cursor || timelineOwnerPath.current !== cursor.path
      || cursor.loadId !== timelineLoadId.current || cursor.loading || cursor.complete
      || (revertInFlight.current?.path === cursor.path && !revertInFlight.current.settled)) return
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
        if (!page || loadId !== timelineLoadId.current || historyCursor.current !== cursor
          || timelineOwnerPath.current !== cursor.path) return
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
    if (!cursor || timelineOwnerPath.current !== cursor.path
      || cursor.loadId !== timelineLoadId.current || cursor.loading || cursor.newerComplete
      || (revertInFlight.current?.path === cursor.path && !revertInFlight.current.settled)) return
    cursor.loading = true
    const loadId = cursor.loadId
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        if (loadId !== timelineLoadId.current || historyCursor.current !== cursor) return
        const end = Math.min(cursor.total, cursor.apiAfter + getViewportHistoryPageSize())
        const limit = Math.max(1, end - cursor.apiAfter)
        const page = await api.getEntriesPage(end, limit, cursor.path)
        if (!page || loadId !== timelineLoadId.current || historyCursor.current !== cursor
          || timelineOwnerPath.current !== cursor.path) return
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
      const mutation = revertInFlight.current
      if (mutation?.path === sessionPath && !mutation.settled) await mutation.done
      if (loadId !== historyIndexLoadId.current || timelineOwnerPath.current !== sessionPath) return
      do {
        flight.dirty = false
        const index: SessionHistoryIndex | null = await api.getHistoryIndex(sessionPath).catch(() => null)
        // Transient reads must not remove the rail. A late snapshot must not
        // replace the index belonging to a newly selected history window.
        if (index?.sessionPath === sessionPath && loadId === historyIndexLoadId.current && timelineOwnerPath.current === sessionPath) {
          historyIndexAppliedId.current = loadId
          dispatch({ type: 'historyIndex', index })
        }
      } while (flight.dirty && loadId === historyIndexLoadId.current && timelineOwnerPath.current === sessionPath)
    })().finally(() => {
      if (historyIndexInFlight.current === flight) historyIndexInFlight.current = null
    })
    return flight.promise
  }, [api])

  // Snapshot metadata and startup completion can move the persisted leaf
  // without a message landmark. Watch these bounded changes, not snapshot
  // identity, streaming text or token usage; keep the live rows untouched.
  useEffect(() => {
    const sessionPath = state.session?.sessionFile
    if (
      !sessionPath
      || state.timelineLoading
      || timelineOwnerPath.current !== sessionPath
    ) return
    void refreshHistoryIndex(sessionPath)
  }, [
    refreshHistoryIndex, state.session?.sessionFile, state.session?.sessionId,
    state.session?.messageCount, state.session?.provider, state.session?.modelId,
    state.session?.model, state.session?.thinkingLevel, state.session?.sessionName,
    state.session?.subagentsEnabled, state.status.phase, state.timelineLoading
  ])

  useEffect(() => {
    const path = logicalOwnerPath
    if (!api || !path || !logicalSessionId) return
    let timer: number | undefined
    const off = api.onEvent((event) => {
      if (event.type === 'entry_appended') {
        const entry = event.entry as { id?: string } | undefined
        if (!entry?.id) return
      }
      if (event.type === 'message_end') {
        const message = event.message as { role?: string } | undefined
        if (!message?.role) return
      }
      // Every persisted entry can move the branch leaf, even when custom,
      // model/thinking/name metadata or tool results add no visible landmark.
      // Lifecycle/snapshot refreshes also cover cold-start appends that occur
      // before IPC subscriptions are ready. Never scan for streamed tokens.
      if (!['entry_appended', 'message_end', 'agent_settled', 'compaction_end',
        'session_info_changed', 'thinking_level_changed', 'model_changed'].includes(event.type)
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
  }, [api, refreshHistoryIndex, logicalOwnerPath, logicalSessionId])

  /** Fork before a user message; resolves with the message text for prefill. */
  const forkAt = useCallback(
    async (entryId: string): Promise<string> => {
      if (!api) return ''
      invalidateSelection()
      const result = await api.forkAt(entryId)
      if (!result.cancelled) {
        dispatch({ type: 'clearTimeline' })
        timelineOwnerPath.current = undefined
        historyCursor.current = null
        await reloadTimeline()
        return result.text
      }
      return ''
    },
    [api, dispatch, invalidateSelection, reloadTimeline]
  )

  const switchSession = useCallback(
    async (sessionPath: string): Promise<{ cancelled: boolean }> => {
      if (!api) return { cancelled: true }
      invalidateSelection()
      const previousPath = timelineOwnerPath.current
      const previousCached = previousPath ? timelineCache.current.get(previousPath) : undefined
      const previousRevision = previousPath ? branchRevisions.current.get(previousPath) ?? 0 : 0
      const cacheRevision = branchRevisions.current.get(sessionPath) ?? 0
      const cached = timelineCache.current.get(sessionPath)
      const restorableLimit = getViewportHistoryPageSize()
      const restorableCache = cached && cached.items.length <= restorableLimit
        && !(revertInFlight.current?.path === sessionPath && !revertInFlight.current.settled)
        ? cached
        : undefined
      if (cached && cached.items.length > restorableLimit) timelineCache.current.delete(sessionPath)

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
      if (restorableCache && restoreCachedTimeline(sessionPath, restorableCache, cacheRevision)) {
        requestLoadId = timelineLoadId.current
      }

      const restorePreviousTimeline = (): void => {
        if (!(previousPath && previousCached && restoreCachedTimeline(previousPath, previousCached, previousRevision))) {
          historyCursor.current = null
          timelineOwnerPath.current = previousPath
          expectedTimeline.current = null
          dispatch({ type: 'clearTimeline' })
        }
      }

      const mutation = revertInFlight.current
      if (mutation?.path === sessionPath && !mutation.settled) await mutation.done
      if (requestLoadId !== timelineLoadId.current) return { cancelled: true }

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
      const content = reloadTimeline(sessionPath)
      const contentLoadId = timelineLoadId.current
      await content
      await waitForNextPaint()
      if (contentLoadId !== timelineLoadId.current) return { cancelled: true }

      // Phase 3 builds navigation metadata. App-level resource staging enables
      // review files only after this resolves; models refresh from lifecycle events.
      await refreshHistoryIndex(sessionPath)
      return result
    },
    [api, invalidateSelection, refreshHistoryIndex, reloadTimeline, restoreCachedTimeline]
  )

  const jumpToHistoryLandmark = useCallback(async (landmark: HistoryLandmark): Promise<void> => {
    const index = currentState.current.historyIndex
    if (!api || !index || !index.sessionPath || index.totalEntries <= 0
      || timelineOwnerPath.current !== index.sessionPath
      || (revertInFlight.current?.path === index.sessionPath && !revertInFlight.current.settled)) return
    const loadId = ++timelineLoadId.current
    const end = Math.min(
      index.totalEntries,
      Math.max(
        Math.min(getViewportHistoryPageSize(), index.totalEntries),
        landmark.entryIndex + Math.floor(getViewportHistoryPageSize() * 0.35)
      )
    )
    const limit = Math.min(getViewportHistoryPageSize(), end)
    dispatch({ type: 'beginTaskRestore', id: loadId })
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

    if (page.taskSnapshot !== undefined) {
      dispatch({ type: 'restoreTasks', id: loadId, tasks: page.taskSnapshot })
    }
    const items = entriesToTimeline(
      page.entries,
      collectToolResults([...page.entries, ...page.toolResults])
    )
    // Keep the in-flight assistant message pinned to the end of the jumped
    // window so the live stream keeps rendering instead of being dropped.
    const liveItems = currentState.current.timeline.filter((item) => (
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
  }, [api, showTimeline])

  /** Undo conversation context in place; file rollback is a separate action. */
  const revertMessage = useCallback(async (entryId: string): Promise<MessageRevertResult | null> => {
    if (!api || revertInFlight.current) return null
    const selection = readSelection()
    const current = currentState.current
    const session = current.session
    const path = selection.ownerPath
    if (!entryId || !path || !session?.sessionId || session.sessionFile !== path
      || current.status.phase !== 'running') {
      throw new Error('请等待当前会话就绪后再撤销消息。')
    }
    if (current.busy || current.compacting || session.isStreaming || session.isCompacting
      || (session.pendingMessageCount ?? 0) > 0
      || current.queued.steering > 0 || current.queued.followUp > 0
      || current.queuedMessages.steering.length > 0 || current.queuedMessages.followUp.length > 0
      || current.queuedMessages.nativeFollowUpCount > 0) {
      throw new Error('请等待会话空闲并清空排队消息后再撤销。')
    }
    const index = current.historyIndex
    const expectedLeafId = index?.sessionPath === path && index.leafId !== undefined
      ? index.leafId : timelineCache.current.get(path)?.leafId
    if (expectedLeafId !== null && (typeof expectedLeafId !== 'string' || expectedLeafId.length === 0)) {
      throw new Error('无法确认当前会话分支，请重新选择会话后再撤销。')
    }

    let release!: () => void
    const mutation = { path, settled: false, done: new Promise<void>((resolve) => { release = resolve }) }
    revertInFlight.current = mutation
    invalidateHistoryReads()
    // An invalidated jump/reload must not leave its spinner running on failure.
    if (current.timelineLoading) dispatch({ type: 'timelineLoading', loading: false })
    const stillSelected = (): boolean => readSelection() === selection
      && timelineOwnerPath.current === path
    try {
      let result: MessageRevertResult
      try {
        result = await api.revertMessage({ sessionPath: path, sessionId: session.sessionId, entryId, expectedLeafId })
      } catch (error) {
        if (!stillSelected()) return null
        throw error
      }

      // This is unconditional: even a background success invalidates cached
      // snapshots (including ones captured by an in-flight switch/cancellation).
      timelineCache.current.delete(path)
      branchRevisions.current.set(path, (branchRevisions.current.get(path) ?? 0) + 1)
      // A cancelled selection can still own A's old cursor. Drop that cursor
      // without touching B's view, so a later scroll cannot re-cache old rows.
      if (historyCursor.current?.path === path) historyCursor.current = null
      mutation.settled = true
      if (!stillSelected()) return null

      invalidateHistoryReads()
      const indexReadBoundary = historyIndexLoadId.current
      historyCursor.current = null
      expectedTimeline.current = null
      dispatch({ type: 'runCheckpoint', checkpoint: null })
      dispatch({ type: 'tree', tree: null })
      dispatch({ type: 'historyIndex', index: null })
      dispatch({ type: 'resetHistoryNavigation' })
      dispatch({ type: 'clearTimeline' })
      // clearTimeline resets per-session switches. Retain the latest session
      // snapshot while the idle backend reopens the selected persisted branch.
      dispatch({ type: 'session', session: currentState.current.session })
      // API success and view hydration are separate outcomes. The restored
      // draft must survive a transient history failure; show that error in place.
      try {
        await Promise.all([reloadTimeline(path), refreshHistoryIndex(path)])
        if (stillSelected() && historyIndexAppliedId.current <= indexReadBoundary) dispatch({
          type: 'timelineError',
          error: '消息已撤销，但会话历史索引加载失败，请重新选择会话。'
        })
      } catch (error) {
        if (stillSelected()) dispatch({
          type: 'timelineError',
          error: `消息已撤销，但会话历史加载失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
      return stillSelected() ? result : null
    } finally {
      mutation.settled = true
      release()
      if (revertInFlight.current === mutation) revertInFlight.current = null
    }
  }, [api, dispatch, invalidateHistoryReads, readSelection, refreshHistoryIndex, reloadTimeline])

  return {
    selectionRef,
    invalidateSelection,
    revertMessage,
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
