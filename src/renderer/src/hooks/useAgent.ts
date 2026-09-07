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
    refreshHistoryIndex,
    forkAt,
    switchSession,
    jumpToHistoryLandmark
  } = useAgentHistory({ api, state, dispatch })

  useAgentSubscriptions({
    api,
    dispatch,
    projects: state.projects,
    branchesByProject: state.branchesByProject,
    sessionsByProject: state.sessionsByProject,
    optimisticSessionTimers
  })

  const refreshModels = useCallback(async () => {
    if (!api) return
    const refreshId = ++modelRefreshId.current
    // Fetch independently: one failing/slow RPC (e.g. models on a cold backend)
    // must not discard the others, or slash commands and pickers go empty.
    const [models, levels, commands] = await Promise.all([
      api.getAvailableModels().catch(() => null),
      api.getThinkingLevels().catch(() => null),
      api.getCommands().catch(() => null)
    ])
    if (refreshId !== modelRefreshId.current) return
    if (models) dispatch({ type: 'models', models })
    if (levels) dispatch({ type: 'thinkingLevels', levels })
    if (commands) dispatch({ type: 'commands', commands })
  }, [api])

  const start = useCallback(
    async (cwd: string) => {
      if (!api) return
      ++timelineLoadId.current
      ++historyIndexLoadId.current
      historyIndexInFlight.current = null
      historyCursor.current = null
      timelineOwnerPath.current = undefined
      expectedTimeline.current = null
      dispatch({ type: 'historyIndex', index: null })
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

  // Refresh pickers once per running session, but only after its bounded
  // conversation has painted. Cold model/command RPCs must not contend with
  // the UI-first and history-content phases of a session switch.
  const lastModelRefreshSessionId = useRef<string | null>(null)
  useEffect(() => {
    if (state.status.phase !== 'running') {
      lastModelRefreshSessionId.current = null
      return
    }
    const sessionId = state.session?.sessionId ?? null
    if (!sessionId || state.timelineLoading || sessionId === lastModelRefreshSessionId.current) return
    lastModelRefreshSessionId.current = sessionId
    void refreshModels().catch(() => undefined)
  }, [refreshModels, state.session?.sessionId, state.status.phase, state.timelineLoading])

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
    newSession
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
    reloadTimeline
  })
  const {
    reorderSessions,
    refreshProjectSessions,
    deleteSession,
    copySession,
    getSessionForkMessages,
    forkSession
  } = useAgentSessionActions({
    api,
    dispatch,
    timelineCache,
    timelineOwnerPath,
    historyCursor,
    reloadTimeline
  })
  const {
    addProject,
    createBranch,
    renameBranch,
    removeProject,
    setProjectTrust
  } = useAgentProjectActions({ api, dispatch, refreshModels })
  const {
    setModel,
    listModelProviders,
    loginModelProvider,
    logoutModelProvider,
    cancelModelProviderAuth,
    openModelProviderAuthUrl,
    addModelProvider,
    setThinkingLevel,
    setMode,
    setYoloMode
  } = useAgentModelActions({ api, dispatch, refreshModels })
  const {
    setAutoCompaction,
    setAutoRetry,
    compactNow,
    exportHtml,
    renameSession,
    migrateSessionToProject,
    setSteeringMode,
    setFollowUpMode
  } = useAgentSettingsActions({
    api,
    timelineOwnerPath,
    reloadTimeline,
    refreshHistoryIndex
  })

  const actions = useMemo(
    () => ({
      bootstrap,
      start,
      loadOlder,
      loadNewer,
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
      setFollowUpMode
    }),
    [
      bootstrap,
      start,
      loadOlder,
      loadNewer,
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
      setFollowUpMode
    ]
  )

  return { state, actions, hasBridge: Boolean(api) }
}
