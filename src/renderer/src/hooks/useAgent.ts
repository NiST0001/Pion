/**
 * useAgent：组装 Agent 状态与全部动作。
 *
 * 状态模型在 agent/types.ts，事件归约在 agent/reducer.ts，时间线解析与
 * 分页缓存（agent/timeline.ts）、会话排序（agent/sessionOrder.ts）都在
 * 各自模块内；这里只负责订阅 IPC 事件、管理时间线加载与对外暴露 actions。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  AgentMode,
  BranchInfo,
  ForkMessageOption,
  ImageContent,
  ProjectTrustInfo
} from '../../../shared/types'
import { reducer } from '../agent/reducer'
import {
  collectToolResults,
  entriesToTimeline,
  HISTORY_ENTRY_CHUNK_SIZE,
  INITIAL_HISTORY_PAGE_SIZE,
  storeTimelineCache
} from '../agent/timeline'
import type { HistoryCursor, TimelineCacheEntry } from '../agent/timeline'
import { saveSessionOrder } from '../agent/sessionOrder'
import { initialState } from '../agent/types'
import type { TimelineItem } from '../agent/types'

export function useAgent() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const api = typeof window !== 'undefined' ? window.pion : undefined
  const bootstrapped = useRef(false)
  const timelineLoadId = useRef(0)
  const modelRefreshId = useRef(0)
  const timelineCache = useRef(new Map<string, TimelineCacheEntry>())
  const historyCursor = useRef<HistoryCursor | null>(null)
  const timelineOwnerPath = useRef<string | undefined>(undefined)
  const expectedTimeline = useRef<{ path: string; items: TimelineItem[] } | null>(null)

  const showTimeline = useCallback((path: string, items: TimelineItem[], mode: AgentMode): void => {
    timelineOwnerPath.current = path
    expectedTimeline.current = { path, items }
    dispatch({ type: 'loadEntries', items, mode })
  }, [])

  const restoreCachedTimeline = useCallback((path: string, cached: TimelineCacheEntry): void => {
    const loadId = ++timelineLoadId.current
    const cursor: HistoryCursor | null = cached.complete
      ? null
      : { path, ...cached, loading: false, loadId }
    historyCursor.current = cursor
    showTimeline(path, cached.items, cached.mode)
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

  useEffect(() => {
    if (!api) return
    const offs = [
      api.onStatus((status) => dispatch({ type: 'status', status })),
      api.onRunCheckpoint((checkpoint) => dispatch({ type: 'runCheckpoint', checkpoint })),
      api.onState((session) => dispatch({ type: 'session', session })),
      api.onSessions((sessions) => dispatch({ type: 'sessions', sessions })),
      api.onTree((tree) => dispatch({ type: 'tree', tree })),
      api.onProjects((projects) => dispatch({ type: 'projects', projects })),
      api.onEvent((event) => dispatch({ type: 'event', event }))
    ]
    return () => offs.forEach((off) => off())
  }, [api])

  // Load each project's Git worktrees so the sidebar can render
  // Project -> Branch -> Session instead of a flat project list.
  useEffect(() => {
    if (!api || state.projects.length === 0) return
    let cancelled = false
    void Promise.all(
      state.projects.map(async (project) => [project.cwd, await api.listBranches(project.cwd)] as const)
    ).then((entries) => {
      if (cancelled) return
      for (const [cwd, branches] of entries) {
        dispatch({ type: 'branches', cwd, branches })
      }
    })
    return () => {
      cancelled = true
    }
  }, [api, state.projects])

  // Load every branch worktree's sessions so the sidebar can render a folder tree.
  useEffect(() => {
    if (!api) return
    let cancelled = false
    const projectList = state.projects
    if (projectList.length === 0) {
      dispatch({ type: 'projectSessions', sessionsByProject: {} })
      return () => {
        cancelled = true
      }
    }

    const branches = projectList.flatMap((project) => (
      state.branchesByProject[project.cwd] ?? [{ name: 'main', cwd: project.cwd, isMain: true }]
    ))
    const branchCwds = [...new Set(branches.map((branch) => branch.cwd))]
    void Promise.all(
      branchCwds.map(async (cwd) => [cwd, await api.listSessions(cwd)] as const)
    ).then((entries) => {
      if (cancelled) return
      dispatch({ type: 'projectSessions', sessionsByProject: Object.fromEntries(entries) })
    })

    return () => {
      cancelled = true
    }
  }, [api, state.projects, state.branchesByProject])

  /** Load only the newest history window; older windows are fetched on demand. */
  const reloadTimeline = useCallback(async (sessionPath?: string): Promise<void> => {
    if (!api) return
    const loadId = ++timelineLoadId.current
    const path = sessionPath
      ?? timelineOwnerPath.current
      ?? (await api.getState().catch(() => null))?.sessionFile
    const cached = path ? timelineCache.current.get(path) : undefined
    historyCursor.current = null
    if (path) dispatch({ type: 'timelineLoading', loading: true })

    let page = null
    for (let attempt = 0; attempt < 3; attempt++) {
      page = await api.getEntriesPage(undefined, INITIAL_HISTORY_PAGE_SIZE, path)
        .catch(() => null)
      if (page || loadId !== timelineLoadId.current) break
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)))
    }
    if (loadId !== timelineLoadId.current) return
    if (!page) {
      dispatch({
        type: 'timelineError',
        error: '会话历史加载失败，请重新选择该会话或检查会话文件是否仍然存在。'
      })
      return
    }

    if (path && cached && cached.leafId === page.leafId && cached.total === page.total) {
      const cursor: HistoryCursor | null = cached.complete
        ? null
        : { path, ...cached, loading: false, loadId }
      historyCursor.current = cursor
      storeTimelineCache(timelineCache.current, path, cached)
      showTimeline(path, cached.items, cached.mode)
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
      toolResults: page.toolResults,
      complete: page.start === 0,
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
        toolResults: cursor.toolResults,
        complete: cursor.complete,
        leafId: cursor.leafId,
        total: cursor.total
      })
      historyCursor.current = cursor.complete ? null : cursor
      showTimeline(path, cursor.items, cursor.mode)
    } else {
      dispatch({ type: 'loadEntries', items: cursor.items, mode: cursor.mode })
    }
  }, [api, showTimeline])

  /** Fetch and prepend the next older history window when the user reaches the top. */
  const loadOlder = useCallback(async (): Promise<void> => {
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
          HISTORY_ENTRY_CHUNK_SIZE,
          cursor.path
        )
        if (!page || loadId !== timelineLoadId.current || historyCursor.current !== cursor) return
        cursor.toolResults = page.toolResults
        cursor.apiBefore = page.start
        cursor.leafId = page.leafId
        cursor.total = page.total

        const items = entriesToTimeline(
          page.entries,
          collectToolResults([...page.entries, ...page.toolResults])
        )
        cursor.items = [...items, ...cursor.items]
        cursor.complete = cursor.apiBefore === 0
        if (items.length > 0) dispatch({ type: 'prependEntries', items })
        storeTimelineCache(timelineCache.current, cursor.path, {
          items: cursor.items,
          mode: cursor.mode,
          apiBefore: cursor.apiBefore,
          toolResults: cursor.toolResults,
          complete: cursor.complete,
          leafId: cursor.leafId,
          total: cursor.total
        })
        if (cursor.complete) {
          historyCursor.current = null
          return
        }
        if (items.length > 0) return
      }
    } finally {
      if (historyCursor.current === cursor) cursor.loading = false
    }
  }, [api])

  const refreshModels = useCallback(async () => {
    if (!api) return
    const refreshId = ++modelRefreshId.current
    const [models, levels, commands] = await Promise.all([
      api.getAvailableModels(),
      api.getThinkingLevels(),
      api.getCommands()
    ])
    if (refreshId !== modelRefreshId.current) return
    dispatch({ type: 'models', models })
    dispatch({ type: 'thinkingLevels', levels })
    dispatch({ type: 'commands', commands })
  }, [api])

  const start = useCallback(
    async (cwd: string) => {
      if (!api) return
      ++timelineLoadId.current
      historyCursor.current = null
      timelineOwnerPath.current = undefined
      expectedTimeline.current = null
      dispatch({ type: 'status', status: { phase: 'starting', cwd } })
      dispatch({ type: 'clearTimeline' })
      await api.startAgent(cwd)
      await Promise.all([reloadTimeline(), refreshModels()])
    },
    [api, reloadTimeline, refreshModels]
  )

  const bootstrap = useCallback(async () => {
    if (!api || bootstrapped.current) return
    bootstrapped.current = true
    let projects = await api.listProjects()
    let cwd = projects[0]?.cwd
    if (!cwd) {
      cwd = await api.defaultWorkspace()
      projects = await api.addProject(cwd)
    }
    dispatch({ type: 'projects', projects })
    await start(cwd)
  }, [api, start])

  const send = useCallback(
    async (message: string, images: ImageContent[] = []) => {
      if (!api || (message.trim() === '' && images.length === 0)) return
      await api.send(message.trim(), images)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const queue = useCallback(
    async (message: string, images: ImageContent[] = []) => {
      if (!api || (message.trim() === '' && images.length === 0)) return
      await api.queue(message.trim(), images)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const abort = useCallback(async () => {
    if (!api) return
    await api.abort()
  }, [api])

  const rollbackRunCheckpoint = useCallback(async () => {
    if (!api) return null
    const checkpoint = await api.rollbackRunCheckpoint()
    dispatch({ type: 'runCheckpoint', checkpoint })
    return checkpoint
  }, [api])

  const newSession = useCallback(async () => {
    if (!api) return
    ++timelineLoadId.current
    historyCursor.current = null
    timelineOwnerPath.current = undefined
    expectedTimeline.current = null
    // Clear the visible conversation before backend startup. The new backend
    // can take a moment to initialize, and the previous session must not stay
    // on screen while that happens.
    dispatch({ type: 'clearTimeline' })
    await api.newSession()
    await refreshModels()
  }, [api, refreshModels])

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
      const requestLoadId = ++timelineLoadId.current
      const cached = timelineCache.current.get(sessionPath)
      let result: { cancelled: boolean }
      try {
        result = await api.switchSession(sessionPath)
      } catch (error) {
        if (requestLoadId === timelineLoadId.current) {
          dispatch({
            type: 'timelineError',
            error: error instanceof Error ? error.message : String(error)
          })
        }
        throw error
      }
      if (result.cancelled || requestLoadId !== timelineLoadId.current) {
        return { cancelled: true }
      }

      if (cached) {
        // Paint the cached timeline immediately, then revalidate JSONL below in
        // case this retained backend produced messages while it was hidden.
        restoreCachedTimeline(sessionPath, cached)
      } else {
        historyCursor.current = null
        timelineOwnerPath.current = sessionPath
        expectedTimeline.current = null
        dispatch({ type: 'clearTimeline' })
        dispatch({ type: 'timelineLoading', loading: true })
      }
      await reloadTimeline(sessionPath)
      // Session history comes from its JSONL file and must not wait for a cold
      // RPC backend. Models and commands refresh once that backend is ready.
      void refreshModels().catch((error: unknown) => {
        console.error('[pion] failed to refresh models after session switch:', error)
      })
      return result
    },
    [api, refreshModels, reloadTimeline, restoreCachedTimeline]
  )

  const reorderSessions = useCallback((cwd: string, paths: string[]) => {
    saveSessionOrder(cwd, paths)
    dispatch({ type: 'reorderSessions', cwd, paths })
  }, [])

  const deleteSession = useCallback(
    async (sessionPath: string) => {
      if (!api) return
      timelineCache.current.delete(sessionPath)
      if (timelineOwnerPath.current === sessionPath) {
        timelineOwnerPath.current = undefined
        historyCursor.current = null
      }
      const result = await api.deleteSession(sessionPath)
      if (result.activeSessionChanged) await reloadTimeline()
    },
    [api, reloadTimeline]
  )

  const copySession = useCallback(
    async (sessionPath: string) => {
      if (!api) return
      const result = await api.copySession(sessionPath)
      if (!result.cancelled) {
        timelineOwnerPath.current = undefined
        historyCursor.current = null
        await reloadTimeline()
      }
    },
    [api, reloadTimeline]
  )

  const getSessionForkMessages = useCallback(
    async (sessionPath: string): Promise<ForkMessageOption[]> => {
      if (!api) return []
      return api.getSessionForkMessages(sessionPath)
    },
    [api]
  )

  const forkSession = useCallback(
    async (sessionPath: string, entryId: string): Promise<string> => {
      if (!api) return ''
      const result = await api.forkSession(sessionPath, entryId)
      if (result.cancelled) return ''
      timelineOwnerPath.current = undefined
      historyCursor.current = null
      await reloadTimeline()
      return result.text
    },
    [api, reloadTimeline]
  )

  const addProject = useCallback(
    async (cwd: string) => {
      if (!api) return
      const projects = await api.addProject(cwd)
      dispatch({ type: 'projects', projects })
    },
    [api]
  )

  const createBranch = useCallback(
    async (cwd: string, name: string): Promise<BranchInfo> => {
      if (!api) throw new Error('preload 桥未加载')
      const branch = await api.createBranch(cwd, name)
      const branches = await api.listBranches(cwd)
      dispatch({ type: 'branches', cwd, branches })
      return branch
    },
    [api]
  )

  const removeProject = useCallback(
    async (cwd: string) => {
      if (!api) return
      const projects = await api.removeProject(cwd)
      dispatch({ type: 'projects', projects })
    },
    [api]
  )

  const setProjectTrust = useCallback(
    async (cwd: string, decision: boolean | null): Promise<ProjectTrustInfo> => {
      if (!api) throw new Error('preload 桥未加载')
      const trust = await api.setProjectTrust(cwd, decision)
      void refreshModels().catch((error: unknown) => {
        console.error('[pion] failed to refresh models after project trust change:', error)
      })
      return trust
    },
    [api, refreshModels]
  )

  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      if (!api) return
      await api.setModel(provider, modelId)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const setThinkingLevel = useCallback(
    async (level: string) => {
      if (!api) return
      await api.setThinkingLevel(level)
    },
    [api]
  )

  const setMode = useCallback(
    async (mode: AgentMode) => {
      if (!api) return
      await api.setMode(mode)
      dispatch({ type: 'mode', mode })
    },
    [api]
  )

  // --- agent settings -------------------------------------------------------
  const setAutoCompaction = useCallback(
    async (enabled: boolean) => {
      await api?.setAutoCompaction(enabled)
    },
    [api]
  )
  const setAutoRetry = useCallback(
    async (enabled: boolean) => {
      await api?.setAutoRetry(enabled)
    },
    [api]
  )
  const compactNow = useCallback(async () => {
    await api?.compactNow()
  }, [api])
  const exportHtml = useCallback(
    async (): Promise<string> => (await api?.exportSessionHtml()) ?? '',
    [api]
  )
  const renameSession = useCallback(
    async (name: string) => {
      await api?.renameSession(name)
    },
    [api]
  )
  const setSteeringMode = useCallback(
    async (mode: 'all' | 'one-at-a-time') => {
      await api?.setSteeringMode(mode)
    },
    [api]
  )
  const setFollowUpMode = useCallback(
    async (mode: 'all' | 'one-at-a-time') => {
      await api?.setFollowUpMode(mode)
    },
    [api]
  )

  const actions = useMemo(
    () => ({
      bootstrap,
      start,
      loadOlder,
      send,
      queue,
      abort,
      rollbackRunCheckpoint,
      newSession,
      forkAt,
      switchSession,
      reorderSessions,
      deleteSession,
      copySession,
      getSessionForkMessages,
      forkSession,
      addProject,
      createBranch,
      removeProject,
      setProjectTrust,
      setModel,
      setThinkingLevel,
      setMode,
      setAutoCompaction,
      setAutoRetry,
      compactNow,
      exportHtml,
      renameSession,
      setSteeringMode,
      setFollowUpMode
    }),
    [
      bootstrap,
      start,
      loadOlder,
      send,
      queue,
      abort,
      rollbackRunCheckpoint,
      newSession,
      forkAt,
      switchSession,
      reorderSessions,
      deleteSession,
      copySession,
      getSessionForkMessages,
      forkSession,
      addProject,
      createBranch,
      removeProject,
      setProjectTrust,
      setModel,
      setThinkingLevel,
      setMode,
      setAutoCompaction,
      setAutoRetry,
      compactNow,
      exportHtml,
      renameSession,
      setSteeringMode,
      setFollowUpMode
    ]
  )

  return { state, actions, hasBridge: Boolean(api) }
}
