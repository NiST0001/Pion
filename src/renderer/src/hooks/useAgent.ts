/**
 * useAgent：组装 Agent 状态与全部动作。
 *
 * 状态模型在 agent/types.ts，事件归约在 agent/reducer.ts，时间线解析与
 * 分页缓存（agent/timeline.ts）、会话排序（agent/sessionOrder.ts）都在
 * 各自模块内；这里只负责订阅 IPC 事件、管理时间线加载与对外暴露 actions。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { reducer } from '../agent/reducer'
import { useAgentHistory } from './agent/useAgentHistory'
import { useAgentSubscriptions } from './agent/useAgentSubscriptions'
import { useAgentModelActions } from './agent/useAgentModelActions'
import { useAgentProjectActions } from './agent/useAgentProjectActions'
import { useAgentRunActions } from './agent/useAgentRunActions'
import { useAgentSessionActions } from './agent/useAgentSessionActions'
import { useAgentSettingsActions } from './agent/useAgentSettingsActions'
import { initialState } from '../agent/types'

export function useAgent() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const api = typeof window !== 'undefined' ? window.pion : undefined
  const bootstrapped = useRef(false)
  const modelRefreshId = useRef(0)
  const optimisticSessionTimers = useRef(new Map<string, number>())
  const {
    selectionRef,
    clearTimeline,
    invalidateSelection: invalidateHistorySelection,
    revertMessage: revertHistoryMessage,
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
    forkAt: forkHistoryAt,
    switchSession: switchHistorySession,
    jumpToHistoryLandmark
  } = useAgentHistory({ api, state, dispatch })

  const modelScope = useRef({ api, state })
  modelScope.current = { api, state }
  const captureModelSelection = useCallback(() => {
    const selected = { ...selectionRef.current }
    const captured = modelScope.current
    const backendId = captured.state.liveSessionBackendId ?? captured.state.session?.liveState?.backendId
    return () => {
      const current = modelScope.current
      const selection = selectionRef.current
      return current.api === api && captured.api === api
        && selection.generation === selected.generation
        && selection.cwd === selected.cwd
        && selection.ownerPath === selected.ownerPath
        && selection.sessionPath === selected.sessionPath
        && selection.sessionId === selected.sessionId
        && current.state.status.cwd === captured.state.status.cwd
        && current.state.session?.sessionFile === captured.state.session?.sessionFile
        && current.state.session?.sessionId === captured.state.session?.sessionId
        && (current.state.liveSessionBackendId ?? current.state.session?.liveState?.backendId) === backendId
    }
  }, [api, selectionRef])
  const invalidateSelection = useCallback(() => {
    ++modelRefreshId.current
    invalidateHistorySelection()
  }, [invalidateHistorySelection])
  const switchSession = useCallback((...args: Parameters<typeof switchHistorySession>) => {
    ++modelRefreshId.current
    return switchHistorySession(...args)
  }, [switchHistorySession])
  const forkAt = useCallback((...args: Parameters<typeof forkHistoryAt>) => {
    ++modelRefreshId.current
    return forkHistoryAt(...args)
  }, [forkHistoryAt])
  const revertMessage = useCallback((...args: Parameters<typeof revertHistoryMessage>) => {
    ++modelRefreshId.current
    return revertHistoryMessage(...args)
  }, [revertHistoryMessage])

  useAgentSubscriptions({
    api,
    dispatch,
    projects: state.projects,
    branchesByProject: state.branchesByProject,
    sessionsByProject: state.sessionsByProject,
    optimisticSessionTimers
  })

  const refreshModels = useCallback(async () => {
    if (!api || modelScope.current.api !== api) return
    const refreshId = ++modelRefreshId.current
    const isSelected = captureModelSelection()
    // Each field publishes as soon as its own RPC settles. The deadline only
    // stops waiting/publication; it does not cancel the underlying IPC.
    const publish = <T,>(read: () => Promise<T>, action: (value: T) => void): Promise<void> =>
      new Promise((resolve) => {
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, 10_000)
        void Promise.resolve().then(read).then((value) => {
          if (!finished && refreshId === modelRefreshId.current && isSelected()) action(value)
        }).catch(() => undefined).finally(finish)
      })
    await Promise.all([
      publish(() => api.getAvailableModels(), (models) => dispatch({ type: 'models', models })),
      publish(() => api.getThinkingLevels(), (levels) => dispatch({ type: 'thinkingLevels', levels })),
      publish(() => api.getCommands(), (commands) => dispatch({ type: 'commands', commands }))
    ])
  }, [api, captureModelSelection])

  const start = useCallback(
    async (cwd: string, options: { fresh?: boolean } = {}) => {
      if (!api) return
      invalidateSelection()
      ++timelineLoadId.current
      ++historyIndexLoadId.current
      historyIndexInFlight.current = null
      historyCursor.current = null
      timelineOwnerPath.current = undefined
      expectedTimeline.current = null
      dispatch({ type: 'historyIndex', index: null })
      dispatch({ type: 'status', status: { phase: 'starting', cwd } })
      clearTimeline()
      await api.startAgent(cwd)
      // A migration-prepared empty SDK session has an allocated path but no
      // disk history yet. Adopt it without reading/creating that missing file.
      await Promise.all([options.fresh ? Promise.resolve() : reloadTimeline(), refreshModels()])
    },
    [api, clearTimeline, invalidateSelection, reloadTimeline, refreshModels]
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

  // Refresh pickers once per selected scope, but only after its bounded
  // conversation has painted. Cold model/command RPCs must not contend with
  // the UI-first and history-content phases of a session switch.
  const lastModelRefreshScope = useRef<{ api: typeof api; scope: string } | null>(null)
  const modelRefreshScope = JSON.stringify([
    selectionRef.current.generation, selectionRef.current.ownerPath, state.status.cwd, state.session?.sessionFile,
    state.session?.sessionId, state.liveSessionBackendId ?? state.session?.liveState?.backendId
  ])
  useEffect(() => {
    if (state.status.phase !== 'running' || !state.session?.sessionId || state.timelineLoading) return
    const previous = lastModelRefreshScope.current
    if (previous && previous.api === api && modelRefreshScope === previous.scope) return
    // Record the attempt, not success: empty/failing catalogs must not cause
    // an automatic retry loop. A new selection/backend gets its own attempt.
    lastModelRefreshScope.current = { api, scope: modelRefreshScope }
    void refreshModels().catch(() => undefined)
  }, [api, refreshModels, modelRefreshScope, state.session?.sessionId, state.status.phase, state.timelineLoading])
  useEffect(() => () => { ++modelRefreshId.current }, [])

  // Window focus/visibility changes must not reload the history window: doing
  // so replaces the user's reading position with the newest page. Agent IPC
  // subscriptions remain attached while the window is in the background.

  const {
    send,
    queue,
    sendQueuedMessage,
    removeQueuedMessage,
    abort,
    rollbackRunCheckpoint,
    newSession: createNewSession
  } = useAgentRunActions({
    api,
    state,
    dispatch,
    refreshModels,
    optimisticSessionTimers,
    timelineLoadId,
    historyIndexLoadId,
    historyIndexInFlight,
    historyCursor,
    timelineCache,
    timelineOwnerPath,
    expectedTimeline,
    clearTimeline,
    reloadTimeline
  })
  const {
    reorderSessions,
    refreshProjectSessions,
    deleteSession: removeSession,
    copySession: duplicateSession,
    getSessionForkMessages,
    forkSession: createForkSession
  } = useAgentSessionActions({
    api,
    dispatch,
    timelineCache,
    timelineOwnerPath,
    historyCursor,
    clearTimeline,
    reloadTimeline
  })
  const {
    addProject,
    createBranch,
    renameBranch,
    deleteBranch,
    removeProject,
    setProjectTrust
  } = useAgentProjectActions({ api, dispatch, refreshModels })
  const {
    setModel,
    listModelProviders,
    setModelProviderEnabled,
    loginModelProvider,
    logoutModelProvider,
    cancelModelProviderAuth,
    openModelProviderAuthUrl,
    addModelProvider,
    setThinkingLevel,
    setMode,
    setYoloMode,
    setSubagentsMode
  } = useAgentModelActions({ api, dispatch, refreshModels, captureSelection: captureModelSelection })
  const {
    setAutoCompaction,
    setAutoRetry,
    compactNow,
    exportHtml,
    renameSession,
    migrateSessionToProject: moveSessionToProject,
    setSteeringMode,
    setFollowUpMode
  } = useAgentSettingsActions({
    api,
    timelineOwnerPath,
    reloadTimeline,
    refreshHistoryIndex
  })

  // Record explicit selection intent before awaiting the backend. Session IDs
  // alone cannot distinguish an undo started before a quick A -> B -> A switch.
  const newSession = useCallback(async (): Promise<void> => {
    invalidateSelection()
    await createNewSession()
  }, [createNewSession, invalidateSelection])
  const deleteSession = useCallback(async (path: string): Promise<void> => {
    if (timelineOwnerPath.current === path) invalidateSelection()
    await removeSession(path)
  }, [invalidateSelection, removeSession, timelineOwnerPath])
  const copySession = useCallback(async (path: string): Promise<void> => {
    invalidateSelection()
    await duplicateSession(path)
  }, [duplicateSession, invalidateSelection])
  const forkSession = useCallback(async (path: string, entryId: string): Promise<string> => {
    invalidateSelection()
    return createForkSession(path, entryId)
  }, [createForkSession, invalidateSelection])
  const migrateSessionToProject = useCallback(async (cwd: string): Promise<string | null> => {
    invalidateSelection()
    return moveSessionToProject(cwd)
  }, [invalidateSelection, moveSessionToProject])

  const actions = useMemo(
    () => ({
      revertMessage,
      bootstrap,
      start,
      reloadTimeline,
      loadOlder,
      loadNewer,
      hasNewerHistory,
      jumpToHistoryLandmark,
      send,
      queue,
      sendQueuedMessage,
      removeQueuedMessage,
      abort,
      rollbackRunCheckpoint,
      newSession,
      forkAt,
      switchSession,
      reorderSessions,
      refreshProjectSessions,
      deleteSession,
      copySession,
      getSessionForkMessages,
      forkSession,
      addProject,
      createBranch,
      renameBranch,
      removeProject,
      setProjectTrust,
      setModel,
      listModelProviders,
      loginModelProvider,
      logoutModelProvider,
      cancelModelProviderAuth,
      openModelProviderAuthUrl,
      addModelProvider,
      setThinkingLevel,
      setMode,
      setYoloMode,
      setAutoCompaction,
      setAutoRetry,
      compactNow,
      exportHtml,
      renameSession,
      migrateSessionToProject,
      setSteeringMode,
      setFollowUpMode,
      setSubagentsMode,
      deleteBranch,
      setModelProviderEnabled
    }),
    [
      revertMessage,
      bootstrap,
      start,
      reloadTimeline,
      loadOlder,
      loadNewer,
      hasNewerHistory,
      jumpToHistoryLandmark,
      send,
      queue,
      sendQueuedMessage,
      removeQueuedMessage,
      abort,
      rollbackRunCheckpoint,
      newSession,
      forkAt,
      switchSession,
      reorderSessions,
      refreshProjectSessions,
      deleteSession,
      copySession,
      getSessionForkMessages,
      forkSession,
      addProject,
      createBranch,
      renameBranch,
      removeProject,
      setProjectTrust,
      setModel,
      listModelProviders,
      loginModelProvider,
      logoutModelProvider,
      cancelModelProviderAuth,
      openModelProviderAuthUrl,
      addModelProvider,
      setThinkingLevel,
      setMode,
      setYoloMode,
      setAutoCompaction,
      setAutoRetry,
      compactNow,
      exportHtml,
      renameSession,
      migrateSessionToProject,
      setSteeringMode,
      setFollowUpMode,
      setSubagentsMode,
      deleteBranch,
      setModelProviderEnabled
    ]
  )

  return { state, actions, selectionRef, hasBridge: Boolean(api) }
}
