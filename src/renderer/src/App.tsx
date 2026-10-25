import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { Settings, Store, PanelLeft, PanelRight, TerminalSquare, Globe, GitBranch, ChartColumn, RotateCcw, PanelsTopLeft } from 'lucide-react'
import { useAgent } from './hooks/useAgent'
import { useSlashCommands } from './hooks/useSlashCommands'
import { DESKTOP_SLASH_COMMAND_NAMES, PREPARATION_SLASH_COMMAND_NAMES } from '../../shared/slash-commands'
import type { SettingsNavigationRequest } from './features/settings/settingsNavigation'
import { useSubagentSessions } from './hooks/useSubagentSessions'
import { createSubagentTimelineProjector } from './agent/subagentTimeline'
import { useMessageRevert } from './hooks/useMessageRevert'
import { useQueuedMessageEdit } from './hooks/useQueuedMessageEdit'
import { useRunTelemetry } from './hooks/useRunTelemetry'
import { useVerification } from './hooks/useVerification'
import { isSessionInteractionRequest, useAppInteractionState } from './hooks/useAppInteractionState'
import { useConversationNavigation } from './hooks/useConversationNavigation'
import { useConversationOverlays } from './hooks/useConversationOverlays'
import { useWorkflows } from './hooks/useWorkflows'
import { useGitWorkspace } from './hooks/useGitWorkspace'
import { usePanelLayout } from './hooks/usePanelLayout'
import { useWindowEffects } from './hooks/useWindowEffects'
import { useDeferredMount } from './hooks/useDeferredMount'
import { useSessionResourceStage } from './hooks/useSessionResourceStage'
import { useSessionModes } from './hooks/useSessionModes'
import { deriveWorkingStatus } from './agent/workingStatus'
import { DEFAULT_SUBAGENTS_ENABLED } from '../../shared/subagents'
import { BROWSER_BLANK_URL, isAllowedBrowserUrl } from '../../shared/browser'
import { BrowserNavigationContext } from './features/browser/BrowserNavigationContext'
import { hasIncompleteTasks } from '../../shared/task-history'
import type {
  BranchInfo,
  GitDiffScope,
  ImageContent,
  SessionMeta,
  SlashCommandInfo,
  TokenUsage
} from '../../shared/types'
import {
  readShowMetricCost,
  readShowMetricDuration,
  saveShowMetricCost,
  saveShowMetricDuration
} from './utils/metricsSettings'
import { TaskPanel } from './features/session/TaskPanel'
import { PendingInteractionSessions } from './features/session/PendingInteractionSessions'
import { QueuedMessagesCard } from './features/session/QueuedMessagesCard'
import { ComposerSupportPanels } from './features/session/ComposerSupportPanels'
import { ChatTimeline } from './features/chat/ChatTimeline'
import { Composer } from './features/chat/Composer'
import { ConfirmDialog } from './features/common/ConfirmDialog'
import { SubagentsToggle } from './features/chat/SubagentsToggle'
import { FavoriteSessions, ProjectList, SidebarToolbar } from './features/project/Sidebar'
import { ReviewPanel } from './features/review/ReviewPanel'
import { ModelPicker, ThinkingPicker } from './features/settings/ModelPicker'
import { TitleBar } from './features/chrome/TitleBar'
import { DockHeader } from './features/chrome/DockHeader'
import { useDockLayout } from './hooks/useDockLayout'
import { DOCK_PANELS, DOCK_LABELS, DOCK_EDGE_LABELS } from './utils/dockLayout'
import type { DockPanel } from './utils/dockLayout'
import { ProjectPicker } from './features/project/ProjectPicker'
import { ProjectTrustBanner } from './features/project/ProjectTrustBanner'
import { HistoryNavigator } from './features/session/HistoryNavigator'
import { ToolPermissionModal } from './features/operations/ToolPermissionModal'
import { ExtensionUiModal } from './features/common/ExtensionUiModal'
import { RunMetricsStrip } from './features/operations/RunMetricsStrip'
import { WorkbenchDialogs } from './app/WorkbenchDialogs'
import type { OperationsPanelKind } from './features/operations/OperationsModal'
import { readSessionPreviewDensity, saveSessionPreviewDensity } from './utils/sessionPreview'
import type { SessionPreviewDensity } from './utils/sessionPreview'
import {
  readHistoryNavMaxVisible,
  saveHistoryNavMaxVisible
} from './utils/historyNavigatorSettings'
import { orderFavoriteSessions, readFavoriteSessionPaths, saveFavoriteSessionPaths } from './agent/sessionFavorites'

const TerminalPanel = lazy(() => import('./features/terminal/TerminalPanel').then((module) => ({ default: module.TerminalPanel })))
const BrowserPanel = lazy(() => import('./features/browser/BrowserPanel').then((module) => ({ default: module.BrowserPanel })))
const GitCommitTree = lazy(() => import('./features/git-commit-tree/GitCommitTree').then((module) => ({ default: module.GitCommitTree })))

const noChildPaging = async (): Promise<void> => {}

export function App(): ReactElement {
  const { state, actions, selectionRef, hasBridge } = useAgent()
  const childSessions = useSubagentSessions(window.pion, hasBridge)
  const viewingChild = Boolean(childSessions.selectedTarget)
  const childSummary = childSessions.selected ?? childSessions.sessions.find((item) =>
    item.id === childSessions.selectedTarget?.id && item.backendId === childSessions.selectedTarget?.backendId)
  const childProjector = useMemo(() => createSubagentTimelineProjector(),
    [childSessions.selectedTarget?.backendId, childSessions.selectedTarget?.id])
  const childTimeline = useMemo(() => childProjector.project(childSessions.selected), [childProjector, childSessions.selected])
  const childBusy = Boolean(childSummary && ['starting', 'running', 'cancelling'].includes(childSummary.status))
  const childScrollRef = useRef<HTMLDivElement>(null)
  const { handleTimelineScroll: handleChildScroll, scrollSurfaceRef: childSurfaceRef } = useConversationNavigation({
    scrollRef: childScrollRef, timeline: childTimeline, timelineMutation: 'append',
    busy: childBusy, timelineLoading: childSessions.loading, viewportActive: viewingChild,
    projectCwd: childSummary?.cwd,
    // Display selection scope only, never an SDK session path or disk locator.
    sessionPath: childSessions.selectedTarget
      ? JSON.stringify([childSessions.selectedTarget.backendId, childSessions.selectedTarget.id]) : undefined,
    historyJump: null, loadOlder: noChildPaging, loadNewer: noChildPaging
  })
  useWindowEffects(true)
  const [selectedSession, setSelectedSession] = useState<{ cwd: string; path: string | null } | null>(null)
  const [operationsPanel, setOperationsPanel] = useState<OperationsPanelKind | null>(null)
  const resourceCwd = selectedSession?.cwd ?? state.status.cwd
  // A migrated fresh session has no persisted path yet. Only the target
  // backend may fill it; never borrow the previous project's session file.
  const resourceSessionPath = selectedSession
    ? selectedSession.path ?? (state.status.cwd === selectedSession.cwd ? state.session?.sessionFile : undefined)
    : state.session?.sessionFile
  const mcpBackendId = resourceCwd && state.status.cwd === resourceCwd
    && state.liveSessionOwnerPath === resourceSessionPath ? state.liveSessionBackendId : undefined
  const mcpScope = JSON.stringify([resourceCwd, resourceSessionPath, selectionRef.current.generation, mcpBackendId])
  const resourceKey = resourceCwd
    ? `${resourceCwd}\u0000${resourceSessionPath ?? 'new'}`
    : ''
  // Secondary resources load in timed waves after the conversation paints.
  // They must not wait for a live backend: run metrics, Git status and panels
  // are local reads that stay useful for idle or offline projects too.
  const resourceStage = useSessionResourceStage(
    resourceKey,
    !state.timelineLoading
      && !state.timelineError
      && (resourceSessionPath
        ? state.historyIndex?.sessionPath === resourceSessionPath
        : true)
  )
  const policyResourcesEnabled = resourceStage >= 2
  const gitResourcesEnabled = resourceStage >= 3
  const operationResourcesEnabled = resourceStage >= 4
  const runTelemetry = useRunTelemetry({
    hasBridge,
    enabled: resourceStage >= 1,
    sessionPath: resourceSessionPath,
    cwd: resourceCwd
  })
  const displayedRun = runTelemetry.activeRun ?? runTelemetry.latestRun
  const [showMetricDuration, setShowMetricDuration] = useState(() => readShowMetricDuration())
  const [showMetricCost, setShowMetricCost] = useState(() => readShowMetricCost())
  const sessionTotals = useMemo(() => {
    const runs = runTelemetry.runs
    if (runs.length === 0) return null
    const usage = runs.reduce<TokenUsage>((acc, run) => ({
      input: acc.input + run.usage.input + (run.liveUsage?.input ?? 0),
      output: acc.output + run.usage.output + (run.liveUsage?.output ?? 0),
      cacheRead: acc.cacheRead + run.usage.cacheRead + (run.liveUsage?.cacheRead ?? 0),
      cacheWrite: acc.cacheWrite + run.usage.cacheWrite + (run.liveUsage?.cacheWrite ?? 0),
      reasoning: acc.reasoning + run.usage.reasoning + (run.liveUsage?.reasoning ?? 0),
      total: acc.total + run.usage.total + (run.liveUsage?.total ?? 0),
      costUsd: acc.costUsd + run.usage.costUsd + (run.liveUsage?.costUsd ?? 0)
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: 0 })
    const now = Date.now()
    const duration = runs.reduce((total, run) => {
      const started = run.agentStartedAt ?? run.dispatchedAt ?? run.createdAt
      const ended = run.settledAt ?? run.interruptedAt ?? now
      return total + Math.max(0, ended - started)
    }, 0)
    return { duration, usage }
  }, [runTelemetry.runs])
  const verification = useVerification({
    hasBridge,
    enabled: operationResourcesEnabled && operationsPanel === 'verification',
    sessionPath: resourceSessionPath,
    cwd: resourceCwd
  })
  const workflows = useWorkflows({
    hasBridge,
    enabled: operationResourcesEnabled && operationsPanel === 'agents',
    cwd: resourceCwd
  })
  const [prefill, setPrefill] = useState('')
  const [reviewPath, setReviewPath] = useState<string | null>(null)
  const [reviewScope, setReviewScope] = useState<GitDiffScope>('unstaged')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsNavigation, setSettingsNavigation] = useState<SettingsNavigationRequest>()
  const settingsNavigationId = useRef(0)
  const openCommandSettings = useCallback((request: Omit<SettingsNavigationRequest, 'id'>): void => {
    setSettingsNavigation({ ...request, id: ++settingsNavigationId.current })
    setSettingsOpen(true)
  }, [])
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [pluginStoreOpen, setPluginStoreOpen] = useState(false)
  const [taskHistorySession, setTaskHistorySession] = useState<SessionMeta | null>(null)
  const [branchDialogCwd, setBranchDialogCwd] = useState<string | null>(null)
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false)
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [rollbackError, setRollbackError] = useState('')
  const [branchNotice, setBranchNotice] = useState('')
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [migrationError, setMigrationError] = useState('')
  const {
    maximized,
    sidebarOpen,
    setSidebarOpen,
    reviewOpen,
    setReviewOpen,
    terminalOpen,
    setTerminalOpen,
    browserOpen,
    setBrowserOpen,
    gitCommitTreeOpen,
    setGitCommitTreeOpen,
    resetPanelVisibility
  } = usePanelLayout(hasBridge)
  const [terminalCwd, setTerminalCwd] = useState<string>()
  const [browserMounted, setBrowserMounted] = useState(browserOpen)
  const [gitCommitTreeMounted, setGitCommitTreeMounted] = useState(gitCommitTreeOpen)
  useEffect(() => {
    if (terminalOpen && !terminalCwd && resourceCwd) setTerminalCwd(resourceCwd)
  }, [terminalOpen, terminalCwd, resourceCwd])
  const browserNavigationIdRef = useRef(0)
  const [browserNavigation, setBrowserNavigation] = useState<{ id: number; url: string }>()
  const openBrowserUrl = useCallback((url: string) => {
    if (!isAllowedBrowserUrl(url) || url === BROWSER_BLANK_URL
      || browserNavigationIdRef.current >= Number.MAX_SAFE_INTEGER) return
    setBrowserNavigation({ id: ++browserNavigationIdRef.current, url })
    setBrowserMounted(true)
    setBrowserOpen(true)
  }, [])
  const dockVisible = { projects: sidebarOpen, chat: true, review: reviewOpen, terminal: terminalOpen, browser: browserOpen, gitCommitTree: gitCommitTreeOpen }
  const dock = useDockLayout(dockVisible)
  const dockHeader = (panel: DockPanel, onClose?: () => void) => (
    <DockHeader panel={panel} targets={DOCK_PANELS.filter((target) => dockVisible[target])}
      onMove={(target, edge) => dock.movePanel(panel, target, edge)} onClose={onClose} dragProps={dock.dragProps(panel)} />
  )
  const {
    completionNotificationsEnabled,
    projectTrust,
    setProjectTrust,
    projectTrustBusy,
    projectTrustError,
    toolPermissionPolicy,
    toolPermissionBusy,
    toolPermissionError,
    toolPermissionRequests,
    toolPermissionResolutions,
    extensionUiRequests,
    modelProviderAuthState,
    extensionUiResolutions,
    handleCompletionNotificationsChange,
    handleProjectTrustChange,
    handleToolPermissionChange,
    handleToolPermissionReset,
    handleToolPermissionResolve,
    handleExtensionUiResolve
  } = useAppInteractionState({
    hasBridge,
    cwd: resourceCwd,
    sessionPath: resourceSessionPath,
    policyEnabled: policyResourcesEnabled,
    agentBusy: state.busy,
    statusPhase: state.status.phase,
    updateProjectTrust: actions.setProjectTrust
  })
  const sessionToolPermissionRequests = toolPermissionRequests.filter((request) =>
    isSessionInteractionRequest(request, resourceCwd, resourceSessionPath))
  const sessionExtensionUiRequests = extensionUiRequests.filter((request) =>
    isSessionInteractionRequest(request, resourceCwd, resourceSessionPath))
  const globalExtensionUiRequests = extensionUiRequests.filter((request) => request.scope === 'global')
  const hasSessionInteractions = sessionToolPermissionRequests.length > 0 || sessionExtensionUiRequests.length > 0
  const hasVisibleInteractions = hasSessionInteractions || globalExtensionUiRequests.length > 0
  const conversationShellRef = useConversationOverlays(Boolean(displayedRun), hasSessionInteractions && !viewingChild)
  const attentionSessionPathSet = useMemo(() => new Set([
    ...toolPermissionRequests,
    ...extensionUiRequests.filter((request) => request.scope !== 'global')
  ].flatMap((request) => request.sessionPath ? [request.sessionPath] : [])), [toolPermissionRequests, extensionUiRequests])

  const handleSessionPreviewDensityChange = useCallback((density: SessionPreviewDensity): void => {
    setSessionPreviewDensity(density)
    saveSessionPreviewDensity(density)
  }, [])
  const handleHistoryNavGapChange = useCallback((gap: number): void => {
    setHistoryNavGap(gap)
    localStorage.setItem('pion:history-nav-gap', String(gap))
  }, [])
  const handleHistoryNavMaxVisibleChange = useCallback((count: number): void => {
    setHistoryNavMaxVisible(saveHistoryNavMaxVisible(count))
  }, [])
  const [sessionQuery, setSessionQuery] = useState('')
  const [favoriteSessionPaths, setFavoriteSessionPaths] = useState<string[]>(readFavoriteSessionPaths)
  const [sessionPreviewDensity, setSessionPreviewDensity] = useState<SessionPreviewDensity>(readSessionPreviewDensity)
  const [historyNavGap, setHistoryNavGap] = useState<number>(() => {
    const raw = Number(localStorage.getItem('pion:history-nav-gap'))
    return Number.isFinite(raw) && raw >= 2 && raw <= 16 ? raw : 10
  })
  const [historyNavMaxVisible, setHistoryNavMaxVisible] = useState<number>(readHistoryNavMaxVisible)
  const gitWorkspace = useGitWorkspace({
    hasBridge,
    cwd: resourceCwd,
    enabled: gitResourcesEnabled
  })
  const reviewCodeKey = gitWorkspace.snapshot
    ? `${gitWorkspace.snapshot.root}\u0000${gitWorkspace.snapshot.snapshotId}`
    : ''
  const [readyReviewCodeKey, setReadyReviewCodeKey] = useState('')
  useEffect(() => {
    setReadyReviewCodeKey('')
    if (!gitResourcesEnabled || !reviewCodeKey) return
    // The snapshot render paints the directory tree first. Diff/conflict code
    // starts in a later task so it cannot contend with that file-list frame.
    const timer = window.setTimeout(() => setReadyReviewCodeKey(reviewCodeKey), 120)
    return () => window.clearTimeout(timer)
  }, [gitResourcesEnabled, reviewCodeKey])
  const reviewCodeEnabled = gitResourcesEnabled
    && reviewCodeKey !== ''
    && readyReviewCodeKey === reviewCodeKey
  const taskHistoryMounted = useDeferredMount(taskHistorySession !== null)
  const capabilitiesMounted = useDeferredMount(capabilitiesOpen)
  const pluginStoreMounted = useDeferredMount(pluginStoreOpen)
  const branchDialogMounted = useDeferredMount(branchDialogCwd !== null)
  const settingsMounted = useDeferredMount(settingsOpen)
  const usageOverviewMounted = useDeferredMount(operationsPanel === 'stats')
  const newSessionInFlight = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const agentTodos = useMemo(() => (state.tasks ?? []).filter((task) => task.status !== 'deleted'), [state.tasks])
  const { visibleHistoryEntryId, handleTimelineScroll, scrollSurfaceRef } = useConversationNavigation({
    scrollRef,
    timeline: state.timeline,
    timelineMutation: state.timelineMutation,
    busy: state.busy,
    timelineLoading: state.timelineLoading,
    projectCwd: resourceCwd,
    sessionPath: resourceSessionPath,
    historyIndexSessionPath: state.historyIndex?.sessionPath,
    historyIndex: state.historyIndex,
    historyJump: state.historyJump,
    historyResetRevision: state.historyResetRevision,
    panelsVisible: state.queuedMessages.steering.length > 0
      || state.queuedMessages.followUp.length > 0
      || (state.mode !== 'plan' && hasIncompleteTasks(agentTodos)),
    loadOlder: actions.loadOlder,
    loadNewer: actions.loadNewer,
    hasNewerHistory: actions.hasNewerHistory
  })
  const sessionSelectionId = useRef(0)
  const migrationSelection = useRef<{ id: number; generation: number; target: string } | null>(null)
  const migrationInFlight = useRef(false)

  // bootstrap: pick the most recent project (or home) and start the agent
  useEffect(() => {
    if (!hasBridge) return
    void actions.bootstrap()
  }, [hasBridge, actions])

  useEffect(() => {
    saveFavoriteSessionPaths(favoriteSessionPaths)
  }, [favoriteSessionPaths])

  const favoritePathSet = useMemo(() => new Set(favoriteSessionPaths), [favoriteSessionPaths])
  const runningSessionPathSet = useMemo(() => new Set(state.runningSessionPaths), [state.runningSessionPaths])
  const unreadSessionPathSet = useMemo(() => new Set(state.unreadSessionPaths), [state.unreadSessionPaths])
  const favoriteSessions = useMemo(() => {
    const sessions = Object.values(state.sessionsByProject).flat()
    return orderFavoriteSessions(sessions, favoriteSessionPaths)
  }, [favoriteSessionPaths, state.sessionsByProject])

  const messageRevert = useMessageRevert({
    scope: `${resourceCwd ?? ''}\u0000${selectedSession?.path ?? selectionRef.current.ownerPath ?? resourceSessionPath ?? ''}`,
    selectionRef,
    revertMessage: actions.revertMessage,
    disabledReason: !hasBridge || state.status.phase !== 'running' || !state.session?.sessionFile
      || resourceSessionPath !== state.session.sessionFile
      ? '请等待所选会话就绪'
      : state.busy || state.compacting || state.session.isStreaming || state.session.isCompacting
        || runningSessionPathSet.has(state.session.sessionFile) || rollbackBusy || migrationBusy
        || hasVisibleInteractions
        ? '请等待执行、压缩和收尾完成'
        : state.queued.steering > 0 || state.queued.followUp > 0 || (state.session.pendingMessageCount ?? 0) > 0
          ? '请先处理或移除排队消息'
          : state.timelineLoading || state.timelineError ? '请先等待会话历史加载完成' : undefined
  })

  const queueEditor = useQueuedMessageEdit({
    scope: JSON.stringify([state.status.cwd, state.session?.sessionId ?? state.session?.sessionFile]),
    selectionRef,
    disabled: viewingChild || messageRevert.draftFrozen || !state.status.cwd || !state.session,
    origin: state.liveSessionBackendId ?? state.session?.liveState?.backendId,
    validOwner: () => state.status.phase === 'running' && !!state.session
      && selectionRef.current.cwd === state.status.cwd
      && selectionRef.current.ownerPath === state.session.sessionFile
      && selectionRef.current.sessionPath === state.session.sessionFile
      && selectionRef.current.sessionId === state.session.sessionId,
    editQueuedMessage: actions.editQueuedMessage
  })
  const onDraftAvailabilityChange = useCallback((available: boolean): void => {
    messageRevert.onDraftAvailabilityChange(available)
    queueEditor.onDraftAvailabilityChange(available)
  }, [messageRevert.onDraftAvailabilityChange, queueEditor.onDraftAvailabilityChange])
  const onRestoreDraftConsumed = useCallback((id: string, restored: boolean): void => {
    messageRevert.onRestoreDraftConsumed(id, restored)
    queueEditor.onRestoreDraftConsumed(id, restored)
  }, [messageRevert.onRestoreDraftConsumed, queueEditor.onRestoreDraftConsumed])

  const handleToggleFavorite = useCallback((path: string): void => {
    setFavoriteSessionPaths((current) => current.includes(path)
      ? current.filter((favoritePath) => favoritePath !== path)
      : [...current, path])
  }, [])

  // Keep the user's selected row authoritative while the slower backend
  // switch and its state refreshes complete. Older state responses must not
  // make the sidebar highlight jump back to the previous session.

  const handleFork = useCallback(
    async (entryId: string) => {
      sessionSelectionId.current += 1
      setSelectedSession(null)
      const text = await actions.forkAt(entryId)
      if (text) setPrefill(`${text}`)
    },
    [actions]
  )

  const handleAddProject = useCallback(async () => {
    if (!hasBridge) return
    const cwd = await window.pion.pickWorkspace()
    if (!cwd) return
    sessionSelectionId.current += 1
    setSelectedSession(null)
    await actions.addProject(cwd)
    await actions.start(cwd)
  }, [hasBridge, actions])

  const handleSelectProject = useCallback(
    async (cwd: string) => {
      childSessions.close()
      sessionSelectionId.current += 1
      setSelectedSession(null)
      if (cwd === state.status.cwd) return
      await actions.start(cwd)
    },
    [actions, state.status.cwd, childSessions.close]
  )

  const activateProject = useCallback(
    async (cwd: string) => {
      if (cwd !== state.status.cwd) await actions.start(cwd)
    },
    [actions, state.status.cwd]
  )

  const requestProjectMigration = useCallback((cwd: string): void => {
    if (!cwd || cwd === state.status.cwd || migrationInFlight.current) return
    migrationSelection.current = { id: sessionSelectionId.current, generation: selectionRef.current.generation, target: cwd }
    setMigrationError('')
    setMigrationTarget(cwd)
  }, [selectionRef, state.status.cwd])

  const confirmProjectMigration = useCallback(async (): Promise<void> => {
    if (!migrationTarget || migrationInFlight.current) return
    const intent = migrationSelection.current
    if (!intent || intent.target !== migrationTarget || intent.id !== sessionSelectionId.current
      || intent.generation !== selectionRef.current.generation) {
      setMigrationTarget(null)
      return
    }
    const targetCwd = migrationTarget
    const requestId = ++sessionSelectionId.current
    migrationInFlight.current = true
    childSessions.close()
    setMigrationBusy(true)
    setMigrationError('')
    try {
      const movedPath = await actions.migrateSessionToProject(targetCwd)
      // Migration itself changes the backend selection generation. Explicit
      // App selection intent fences the response without mistaking that expected
      // lifecycle change (or a missing SDK id) for another user selection.
      if (requestId !== sessionSelectionId.current) return
      setMigrationTarget(null)
      setSelectedSession({ cwd: targetCwd, path: movedPath })
      // Main already activated the target. The ordinary history switch remains
      // responsible for selected timeline/index ownership; the retained backend
      // makes this idempotent rather than a second SDK activation.
      if (movedPath) await actions.switchSession(movedPath, targetCwd)
      // start also clears the old history owner before reading a fresh session.
      // Main's already-selected target makes startAgent a no-op selection, not
      // another SDK launch. reloadTimeline alone would reuse the source owner.
      else await actions.start(targetCwd, { fresh: true })
    } catch (error) {
      if (requestId === sessionSelectionId.current) {
        setMigrationError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      migrationInFlight.current = false
      setMigrationBusy(false)
    }
  }, [actions, childSessions.close, migrationTarget, selectionRef])

  const handleNewSession = useCallback(
    async (cwd?: string, reportFailure = false) => {
      if (newSessionInFlight.current) {
        if (reportFailure) throw new Error('正在新建会话，请稍后重试')
        return
      }
      newSessionInFlight.current = true
      childSessions.close()
      try {
        const targetCwd = cwd ?? state.status.cwd
        sessionSelectionId.current += 1
        setSelectedSession(null)
        if (targetCwd) {
          const trust = await window.pion.getProjectTrust(targetCwd)
          await activateProject(targetCwd)
          if (trust.decision === 'ask') {
            setProjectTrust(trust)
            return
          }
        }
        await actions.newSession()
      } catch (error) {
        console.error('[pion] 新建会话失败', error)
        if (reportFailure) throw error
      } finally {
        newSessionInFlight.current = false
      }
    },
    [actions, activateProject, state.status.cwd, childSessions.close]
  )

  const handleNewBranch = useCallback((cwd: string) => {
    setBranchDialogCwd(cwd)
  }, [])

  const handleCreateBranch = useCallback(
    async (name: string): Promise<void> => {
      if (!branchDialogCwd) return
      await actions.createBranch(branchDialogCwd, name)
      setBranchDialogCwd(null)
    },
    [actions, branchDialogCwd]
  )

  const handleRenameBranch = useCallback(
    async (cwd: string, branch: BranchInfo, name: string): Promise<void> => {
      if (!branch.gitBranch) throw new Error('该工作区没有可重命名的本地 Git 分支')
      await actions.renameBranch(branch.cwd, branch.gitBranch, name, cwd)
    },
    [actions]
  )

  const handleDeleteBranch = useCallback(
    async (cwd: string, branch: BranchInfo): Promise<void> => {
      setBranchNotice('')
      const result = await actions.deleteBranch(cwd, branch)
      if (result.warning || !result.branchDeleted) {
        setBranchNotice(result.warning || '工作树已移除，但分支未确认删除，请检查 Git 分支列表。')
      }
    },
    [actions]
  )

  const closeBranchDialog = useCallback(() => {
    setBranchDialogCwd(null)
  }, [])

  // Keep modal callbacks stable while streaming events rerender the app. Some
  // panels load resources on open and must not interpret every token as reopen.
  const closeTaskHistory = useCallback(() => setTaskHistorySession(null), [])
  const closeOperationsPanel = useCallback(() => setOperationsPanel(null), [])
  const closeCapabilities = useCallback(() => setCapabilitiesOpen(false), [])
  const closePluginStore = useCallback(() => setPluginStoreOpen(false), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const handleSelectSession = useCallback(
    async (cwd: string, path: string) => {
      // Selecting the already active parent is a view change, not an SDK switch.
      const requestId = ++sessionSelectionId.current
      const wasViewingChild = viewingChild
      childSessions.close()
      if (wasViewingChild && cwd === state.status.cwd && path === state.session?.sessionFile) {
        setSelectedSession(null)
        return
      }
      if (
        cwd === state.status.cwd &&
        path === state.session?.sessionFile &&
        selectionRef.current.ownerPath === path && !state.timelineError &&
        (state.timelineReady || state.timelineLoading) &&
        (state.status.phase === 'running' || state.status.phase === 'starting')
      ) {
        setSelectedSession(null)
        return
      }
      const previousSelection = selectedSession
      const previousReviewPath = reviewPath
      setReviewPath(null)
      setSelectedSession({ cwd, path })
      try {
        // Persisted sessions are global pool entries. switchSession resolves the
        // session's cwd and activates its retained backend; starting the project
        // first would blank the timeline and create a throwaway logical session.
        const result = await actions.switchSession(path, cwd)
        if (result.cancelled && requestId === sessionSelectionId.current) {
          setSelectedSession(previousSelection)
          setReviewPath(previousReviewPath)
          return
        }
      } catch (error) {
        if (requestId === sessionSelectionId.current) {
          setSelectedSession(previousSelection)
          setReviewPath(previousReviewPath)
        }
        console.error('[pion] 切换会话失败', error)
      }
    },
    [actions, reviewPath, selectedSession, selectionRef, state.session?.sessionFile, state.status.cwd, state.status.phase, state.timelineError, state.timelineReady, state.timelineLoading, childSessions.close, viewingChild]
  )

  const handleDeleteSession = useCallback(
    async (cwd: string, path: string) => {
      if (selectedSession?.path === path || selectionRef.current.ownerPath === path) {
        sessionSelectionId.current += 1
        setSelectedSession(null)
      }
      setFavoriteSessionPaths((current) => current.includes(path)
        ? current.filter((favoritePath) => favoritePath !== path)
        : current)
      await actions.deleteSession(path)
      await actions.refreshProjectSessions(cwd)
    },
    [actions, selectedSession?.path, selectionRef]
  )

  const handleCopySession = useCallback(
    async (_cwd: string, path: string) => {
      sessionSelectionId.current += 1
      setSelectedSession(null)
      await actions.copySession(path)
    },
    [actions]
  )

  const handleRenameSession = useCallback(
    async (cwd: string, path: string, name: string) => {
      await actions.renameSession(name, path)
      await actions.refreshProjectSessions(cwd)
    },
    [actions]
  )

  const handleGetForkMessages = useCallback(
    async (_cwd: string, path: string) => actions.getSessionForkMessages(path),
    [actions]
  )

  const handleForkSession = useCallback(
    async (_cwd: string, path: string, entryId: string) => {
      sessionSelectionId.current += 1
      setSelectedSession(null)
      const text = await actions.forkSession(path, entryId)
      if (text) setPrefill(text)
      return text
    },
    [actions]
  )

  const {
    handleModeChange,
    requestYoloMode,
    planModeExitDialog,
    yoloDialog
  } = useSessionModes({
    busy: state.busy,
    mode: state.mode,
    yolo: state.yolo,
    setMode: actions.setMode,
    setYoloMode: actions.setYoloMode
  })

  const slashCommands = useSlashCommands({
    api: hasBridge ? window.pion : undefined,
    state, selectionRef, enabled: !viewingChild, actions,
    onOpenSettings: openCommandSettings,
    onNewSession: () => handleNewSession(undefined, true),
    onCloneSession: async () => {
      const path = state.session?.sessionFile
      if (!path) throw new Error('当前会话尚未持久化，无法复制')
      await handleCopySession(state.status.cwd ?? '', path)
    },
    onSelectSession: handleSelectSession,
    onOpenOperations: setOperationsPanel,
    onModeChange: handleModeChange,
    onRequestYolo: requestYoloMode
  })
  const commandDialogMounted = useDeferredMount(slashCommands.dialog !== null)
  const handleComposerSend = useCallback(async (
    text: string,
    images: ImageContent[]
  ): Promise<void> => {
    if (viewingChild || slashCommands.execute(text, images)) return
    try {
      await actions.send(text, images)
    } catch (error) {
      console.error('[pion] 发送消息失败', error)
    }
  }, [actions, slashCommands.execute, viewingChild])

  const composerCommands = useMemo<SlashCommandInfo[]>(() => {
    const merged = new Map(state.commands.map((command) => [command.name, command]))
    for (const command of slashCommands.commands) merged.set(command.name, command)
    return [...merged.values()]
  }, [state.commands, slashCommands.commands])
  const taskSessionKey = state.session?.sessionFile || state.session?.sessionId || state.status.cwd || 'default'
  const hasTaskPanel = state.mode !== 'plan' && hasIncompleteTasks(agentTodos)
  const queuedMessages = state.queuedMessages
  const hasQueuedMessages = queuedMessages.steering.length > 0 || queuedMessages.followUp.length > 0
  const agentActivity = state.busy || state.compacting
  const [workingCycle, setWorkingCycle] = useState(0)
  useEffect(() => {
    if (!agentActivity) {
      setWorkingCycle(0)
      return
    }
    setWorkingCycle(0)
    const timer = window.setInterval(() => setWorkingCycle((value) => value + 1), 7_000)
    return () => window.clearInterval(timer)
  }, [agentActivity, state.session?.sessionId])
  const workingStatus = useMemo(() => deriveWorkingStatus({
    timeline: state.timeline,
    mode: state.mode,
    thinkingLevel: state.session?.thinkingLevel,
    compacting: state.compacting,
    cycle: workingCycle
  }), [state.compacting, state.mode, state.session?.thinkingLevel, state.timeline, workingCycle])
  const messageHistory = useMemo(
    () => state.timeline.flatMap((item) => (
      item.kind === 'user' && item.text.trim() ? [item.text] : []
    )),
    [state.timeline]
  )

  const handleToggleReview = useCallback(() => {
    setReviewOpen((open) => !open)
    setReviewPath(null)
  }, [])

  const handleSelectReviewPath = useCallback((path: string | null) => {
    setReviewPath(path)
  }, [])

  useEffect(() => {
    setRollbackError('')
    if (state.runCheckpoint?.state === 'rolled-back') {
      setReviewPath(null)
      setRollbackConfirmOpen(false)
    }
  }, [state.runCheckpoint?.id, state.runCheckpoint?.state])

  const handleRollbackRun = useCallback((): void => {
    const checkpoint = state.runCheckpoint
    if (!checkpoint || checkpoint.state !== 'ready' || !checkpoint.hasChanges || state.busy) return
    setRollbackError('')
    setRollbackConfirmOpen(true)
  }, [state.busy, state.runCheckpoint])

  const confirmRollbackRun = useCallback(async (): Promise<void> => {
    const checkpoint = state.runCheckpoint
    if (!checkpoint || checkpoint.state !== 'ready' || !checkpoint.hasChanges || state.busy) return
    setRollbackBusy(true)
    setRollbackError('')
    try {
      await actions.rollbackRunCheckpoint()
      setReviewPath(null)
      await gitWorkspace.refresh()
      setRollbackConfirmOpen(false)
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error))
    } finally {
      setRollbackBusy(false)
    }
  }, [actions, gitWorkspace, state.busy, state.runCheckpoint])

  const activeCwd = selectedSession?.cwd ?? state.status.cwd
  const activePath = viewingChild ? undefined : resourceSessionPath
  const historyNavigatorVisible = (state.historyIndex?.landmarks.length ?? 0) >= 2

  if (!hasBridge) {
    return (
      <div className="boot-error">
        <h1>Pion</h1>
        <p>preload 桥未加载（window.pion 缺失），请检查 preload 脚本配置。</p>
      </div>
    )
  }

  return (
    <BrowserNavigationContext.Provider value={openBrowserUrl}>
    <div className="app">
      {/* Keep this resource mounted for overlay backplates and scrollable leaf
          popovers. Separate backplates let the floating input/summary and
          their nested menus sample the conversation independently. */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" className="surface-filter-definitions">
        <defs>
          <filter id="pion-panel-frost" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="12" edgeMode="duplicate" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0" intercept="1" />
            </feComponentTransfer>
          </filter>
        </defs>
      </svg>
      <TitleBar
        cwd={state.status.cwd}
        sessionName={state.session?.sessionName}
        maximized={maximized}
        sidebarOpen={sidebarOpen}
        sidebarWidth={160}
        reviewOpen={reviewOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleReview={handleToggleReview}
      />

      <div className="dock-toolbar" aria-label="工作区面板">
        <span className="dock-toolbar-label"><PanelsTopLeft size={13} />工作区</span>
        <button type="button" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}><PanelLeft size={13} />项目</button>
        <button type="button" aria-pressed={reviewOpen} onClick={handleToggleReview}><PanelRight size={13} />审查</button>
        <button type="button" aria-pressed={terminalOpen} disabled={!resourceCwd} onClick={() => {
          if (terminalOpen && terminalCwd === resourceCwd) setTerminalOpen(false)
          else { setTerminalCwd(resourceCwd); setTerminalOpen(true) }
        }}><TerminalSquare size={13} />终端</button>
        <button type="button" aria-pressed={browserOpen} onClick={() => {
          setBrowserMounted(true)
          setBrowserOpen((open) => !open)
        }}><Globe size={13} />浏览器</button>
        <button type="button" aria-pressed={gitCommitTreeOpen} disabled={!resourceCwd} onClick={() => {
          setGitCommitTreeMounted(true)
          setGitCommitTreeOpen((open) => !open)
        }}><GitBranch size={13} />{DOCK_LABELS.gitCommitTree}</button>
        <button type="button" aria-haspopup="dialog" onClick={() => setOperationsPanel('stats')}><ChartColumn size={13} />使用总览</button>
        <span className="dock-toolbar-spacer" />
        <button type="button" className="dock-reset" aria-label="重置布局" title="恢复默认布局" onClick={() => { dock.reset(); resetPanelVisibility() }}><RotateCcw size={13} /></button>
      </div>
      <div className="app-body dock-workspace" ref={dock.rootRef} data-dock-active={Boolean(dock.dragged) || undefined}
        onDragOver={dock.clearDrop} onDragLeave={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dock.clearDrop()
        }}>
        <aside className="sidebar" {...dock.panelProps('projects')}>
          {dockHeader('projects', () => setSidebarOpen(false))}
          <div className="sidebar-scroll">
            <SidebarToolbar
              searchQuery={sessionQuery}
              onSearch={setSessionQuery}
              onNewSession={() => void handleNewSession()}
              onOpenCapabilities={() => setCapabilitiesOpen(true)}
            />
            <FavoriteSessions
              sessions={favoriteSessions}
              searchQuery={sessionQuery}
              previewDensity={sessionPreviewDensity}
              activePath={activePath}
              runningSessionPaths={runningSessionPathSet}
              unreadSessionPaths={unreadSessionPathSet}
              attentionSessionPaths={attentionSessionPathSet}
              favoritePaths={favoritePathSet}
              onToggleFavorite={handleToggleFavorite}
              onSelectSession={(session) => void handleSelectSession(session.projectCwd ?? state.status.cwd ?? '', session.path)}
              onDelete={(session) => handleDeleteSession(session.projectCwd ?? state.status.cwd ?? '', session.path)}
              onCopy={(session) => handleCopySession(session.projectCwd ?? state.status.cwd ?? '', session.path)}
              onRename={(session, name) => handleRenameSession(session.projectCwd ?? state.status.cwd ?? '', session.path, name)}
              onOpenTaskHistory={setTaskHistorySession}
              getForkMessages={(session) => handleGetForkMessages(session.projectCwd ?? state.status.cwd ?? '', session.path)}
              onFork={(session, entryId) => handleForkSession(session.projectCwd ?? state.status.cwd ?? '', session.path, entryId)}
            />
            <ProjectList
              projects={state.projects}
              sessionsByProject={state.sessionsByProject}
              branchesByProject={state.branchesByProject}
              searchQuery={sessionQuery}
              previewDensity={sessionPreviewDensity}
              activeCwd={activeCwd}
              activePath={activePath}
              runningSessionPaths={runningSessionPathSet}
              unreadSessionPaths={unreadSessionPathSet}
              attentionSessionPaths={attentionSessionPathSet}
              onSelect={(cwd) => void handleSelectProject(cwd)}
              onAdd={() => void handleAddProject()}
              onRemove={(cwd) => void actions.removeProject(cwd)}
              onNewSession={(cwd) => void handleNewSession(cwd)}
              onNewBranch={(cwd) => void handleNewBranch(cwd)}
              onRenameBranch={handleRenameBranch}
              onDeleteBranch={handleDeleteBranch}
              subagentSessions={childSessions.sessions}
              selectedSubagent={childSessions.selectedTarget}
              onViewSubagent={childSessions.open}
              onReorder={(cwd, paths) => actions.reorderSessions(cwd, paths)}
              onSelectSession={(cwd, path) => void handleSelectSession(cwd, path)}
              onDelete={handleDeleteSession}
              onCopy={handleCopySession}
              onRename={handleRenameSession}
              onOpenTaskHistory={setTaskHistorySession}
              getForkMessages={handleGetForkMessages}
              onFork={handleForkSession}
              favoritePaths={favoritePathSet}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>
          {branchNotice && <div className="banner" role="status">
            <span>{branchNotice}</span>
            <button type="button" onClick={() => setBranchNotice('')} aria-label="关闭分支操作提示">关闭</button>
          </div>}
          <div className="sidebar-footer">
            <PendingInteractionSessions
              toolPermissionRequests={toolPermissionRequests}
              extensionUiRequests={extensionUiRequests}
              sessionsByProject={state.sessionsByProject}
              sessions={state.sessions}
              onSelectSession={(cwd, path) => void handleSelectSession(cwd, path)}
            />
            <button className="sidebar-settings" onClick={() => {
              setSettingsNavigation(undefined)
              setSettingsOpen(true)
            }}>
              <Settings size={14} />
              <span>设置</span>
            </button>
            <button
              className="sidebar-settings sidebar-plugin-store"
              title="打开 pi 官方插件商店"
              onClick={() => setPluginStoreOpen(true)}
            >
              <Store size={14} />
              <span>插件商店</span>
            </button>
          </div>
        </aside>

        <div className="main" {...dock.panelProps('chat')}>
          {dockHeader('chat')}
          {!viewingChild && state.status.phase === 'error' && (
            <div className="banner banner-error">
              <span>agent 启动失败：{state.status.error}</span>
            </div>
          )}
          {(viewingChild ? childSessions.error : state.timelineError) && (
            <div className="banner banner-error session-load-error">
              <span>{viewingChild ? childSessions.error : state.timelineError}</span>
            </div>
          )}

          <ProjectTrustBanner
            trust={projectTrust}
            busy={projectTrustBusy || state.busy || state.status.phase === 'starting'}
            error={projectTrustError}
            onDecision={(decision) => void handleProjectTrustChange(decision)}
          />

          <div ref={conversationShellRef} className={`conversation-shell${viewingChild ? ' is-subagent-view' : ''}${historyNavigatorVisible ? ' has-history-navigator' : ''}${(hasTaskPanel || hasQueuedMessages) ? ' has-composer-panels' : ''}`}>
            <div className="parent-conversation-chrome" aria-hidden={viewingChild || undefined} inert={viewingChild || undefined}
              style={viewingChild ? { visibility: 'hidden' } : undefined}>
            <RunMetricsStrip
              run={displayedRun}
              sessionTotals={sessionTotals}
              showDuration={showMetricDuration}
              showCost={showMetricCost}
            />
            <HistoryNavigator
              index={state.historyIndex}
              activeEntryId={visibleHistoryEntryId}
              busy={state.timelineLoading}
              gap={historyNavGap}
              maxVisible={historyNavMaxVisible}
              onJump={(landmark) => void actions.jumpToHistoryLandmark(landmark)}
            />
            </div>
            <div className="chat-stage">
              {viewingChild && <ChatTimeline
                scopeKey={JSON.stringify([childSessions.selectedTarget?.backendId, childSessions.selectedTarget?.id])}
                readOnly className="child-chat-scroll"
                scrollRef={childScrollRef} scrollSurfaceRef={childSurfaceRef} onScroll={handleChildScroll}
                timeline={childTimeline} timelineLoading={childSessions.loading} timelineReady={!childSessions.loading}
                historySelected timelineError={childSessions.error} busy={childBusy} starting={false}
                notice={childSessions.selected?.truncated ? '较早或过长的内容已省略。' : undefined}
                cwd={childSummary?.cwd} hasSessions canFork={false} onFork={() => {}}
                agentActivity={childBusy} workingStatus={{ label: childSummary?.status === 'cancelling' ? '停止中' : '运行中' }}
              />}
              <ChatTimeline
                scopeKey={JSON.stringify([resourceKey, state.historyResetRevision])}
                hidden={viewingChild}
                scrollRef={scrollRef}
                scrollSurfaceRef={scrollSurfaceRef}
                onScroll={handleTimelineScroll}
                timeline={state.timeline}
                timelineLoading={state.timelineLoading}
                timelineReady={state.timelineReady}
                hasNewerHistory={actions.hasNewerHistory()}
                historySelected={Boolean(selectedSession?.path)}
                timelineError={state.timelineError}
                onReloadHistory={() => { void actions.reloadTimeline() }}
                busy={state.busy}
                starting={state.status.phase === 'starting'}
                cwd={state.status.cwd}
                hasSessions={state.sessions.length > 1}
                canFork={!queueEditor.frozen && !messageRevert.draftFrozen && state.status.phase !== 'error' && state.status.phase !== 'stopped' && Boolean(state.status.cwd)}
                onFork={handleFork}
                canRevert={!queueEditor.frozen && messageRevert.canRevert}
                onRevert={(entryId) => { if (!queueEditor.frozen) messageRevert.requestRevert(entryId) }}
                revertDisabledReason={messageRevert.disabledReason}

                agentActivity={agentActivity}
                workingStatus={workingStatus}
              />
            <div className="session-interaction-panels"
              hidden={viewingChild || !hasSessionInteractions}
              inert={viewingChild || undefined}>
              {toolPermissionRequests.map((request) => (
                <ToolPermissionModal
                  key={request.id}
                  request={request}
                  active={!viewingChild && request.id === sessionToolPermissionRequests[0]?.id}
                  queueLength={sessionToolPermissionRequests.length}
                  busy={toolPermissionResolutions.get(request.id)?.busy ?? false}
                  error={toolPermissionResolutions.get(request.id)?.error ?? ''}
                  onResolve={(resolution) => void handleToolPermissionResolve(request.id, resolution)}
                />
              ))}
              {extensionUiRequests.filter((request) => request.scope !== 'global').map((request) => (
                <ExtensionUiModal
                  key={request.id}
                  request={request}
                  active={!viewingChild && request.id === sessionExtensionUiRequests[0]?.id}
                  queueLength={sessionExtensionUiRequests.length}
                  busy={extensionUiResolutions.get(request.id)?.busy ?? false}
                  error={extensionUiResolutions.get(request.id)?.error ?? ''}
                  onResolve={(response) => void handleExtensionUiResolve(request.id, response)}
                />
              ))}
            </div>
            {globalExtensionUiRequests.map((request, index) => (
              <ExtensionUiModal
                key={request.id}
                request={request}
                active={index === 0}
                queueLength={globalExtensionUiRequests.length}
                busy={extensionUiResolutions.get(request.id)?.busy ?? false}
                error={extensionUiResolutions.get(request.id)?.error ?? ''}
                onResolve={(response) => void handleExtensionUiResolve(request.id, response)}
              />
            ))}
          </div>

          <div className="composer-dock" aria-hidden={viewingChild || undefined} inert={viewingChild || undefined}
            style={viewingChild ? { visibility: 'hidden' } : undefined}>
            <ComposerSupportPanels hasTasks={hasTaskPanel} agentTodos={agentTodos} hasQueue={hasQueuedMessages}
              task={<TaskPanel
                  key={taskSessionKey}
                  sessionKey={taskSessionKey}
                  agentTodos={hasTaskPanel ? agentTodos : null}
                  agentBusy={state.busy}
                />}
              queue={<QueuedMessagesCard
                  key={`queue-${taskSessionKey}`}
                  sessionKey={taskSessionKey}
                  steering={queuedMessages.steering}
                  followUp={queuedMessages.followUp}
                  nativeFollowUpCount={queuedMessages.nativeFollowUpCount}
                  followUpRunIds={queuedMessages.followUpRunIds}
                  controlsDisabled={queueEditor.frozen}
                  agentBusy={state.busy}
                  onSendItem={(kind, index) => actions.sendQueuedMessage(kind, index).catch((error: unknown) => {
                    console.error('[pion] 直接发送排队消息失败', error)
                  })}
                  onEditItem={(item) => {
                    if (item.runId) flushSync(() => { void queueEditor.edit(item.runId!) })
                  }}
                  onRemoveItem={(kind, index) => actions.removeQueuedMessage(kind, index).catch((error: unknown) => {
                    console.error('[pion] 删除排队消息失败', error)
                  })}
                />}
            />
            <div className="composer-input-scroll">
            {queueEditor.error && <div className="queue-edit-notice" role="status">
              <span>{queueEditor.error}</span>
              {queueEditor.canRestore && <button type="button" onClick={queueEditor.restoreRetained}>
                恢复编辑内容
              </button>}
              {queueEditor.canRetry && <button type="button" onClick={() => {
                flushSync(() => { void queueEditor.retry() })
              }}>重试取回</button>}
              {queueEditor.canClose && <button type="button" onClick={queueEditor.requestClose}>放弃本次取回</button>}
            </div>}
            <ConfirmDialog {...queueEditor.closeConfirmation} />
            <Composer
              busy={state.busy}
              disabled={viewingChild || !state.status.cwd || messageRevert.draftFrozen || queueEditor.frozen}
              sendDisabled={state.status.phase === 'starting' || state.status.phase === 'error' || projectTrust?.decision === 'ask'}
              prefill={prefill}
              restoreDraft={messageRevert.restoreDraft ?? queueEditor.restoreDraft}
              referenceScopeKey={JSON.stringify([resourceKey, state.historyResetRevision])}
              onDraftAvailabilityChange={onDraftAvailabilityChange}
              onRestoreDraftConsumed={onRestoreDraftConsumed}
              history={messageHistory}
              commands={composerCommands}
              contextPressure={displayedRun?.contextPressure}
              contextUsagePending={displayedRun?.contextUsagePending}
              contextTokens={displayedRun?.contextTokens}
              contextWindow={displayedRun?.contextWindow}
              localCommandNames={PREPARATION_SLASH_COMMAND_NAMES}
              nativeCommandNames={DESKTOP_SLASH_COMMAND_NAMES}
              mode={state.mode}
              yolo={state.yolo}
              onYoloDisable={() => requestYoloMode(false)}
              onModeChange={handleModeChange}
              projectSelector={
                <ProjectPicker
                  projects={state.projects}
                  branchesByProject={state.branchesByProject}
                  value={state.status.cwd ?? ''}
                  disabled={state.projects.length === 0}
                  onChange={requestProjectMigration}
                />
              }
              controls={
                <>
                  <SubagentsToggle
                    key={`${activeCwd}:${state.session?.sessionId ?? ''}`}
                    enabled={state.mode === 'plan' ? false : state.session?.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED}
                    disabled={!state.session?.sessionId || state.status.phase === 'starting' || state.status.phase === 'error' || state.mode === 'plan' || projectTrust?.decision === 'ask' || (state.busy && !(state.session?.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED))}
                    onChange={(enabled) => actions.setSubagentsMode(enabled, state.session?.sessionId ?? '')}
                  />
                  <ModelPicker
                    compact
                    models={state.models}
                    currentProvider={state.session?.provider}
                    currentModelId={state.session?.modelId}
                    onSelect={(provider, modelId) => void actions.setModel(provider, modelId)}
                  />
                  <ThinkingPicker
                    levels={state.thinkingLevels}
                    current={state.session?.thinkingLevel}
                    onSelect={(level) => void actions.setThinkingLevel(level)}
                  />
                </>
              }
              onSend={(text, images) => void handleComposerSend(text, images)}
              onQueue={(text, images) => void actions.queue(text, images).catch((error: unknown) => {
                console.error('[pion] 排队消息失败', error)
              })}
              onAbort={() => void actions.abort()}
            />
            </div>
          </div>
          </div>
        </div>

        <div className="dock-review" {...dock.panelProps('review')}>
          {dockHeader('review', () => setReviewOpen(false))}
          {reviewOpen && <ReviewPanel
            snapshot={gitResourcesEnabled ? gitWorkspace.snapshot : null}
            diff={reviewCodeEnabled ? gitWorkspace.diff : null}
            conflict={reviewCodeEnabled ? gitWorkspace.conflict : null}
            selectedPath={reviewPath}
            capturedChange={null}
            scope={reviewScope}
            checkpoint={state.runCheckpoint}
            agentBusy={state.busy}
            loading={gitWorkspace.loading || !gitResourcesEnabled}
            codeEnabled={reviewCodeEnabled}
            diffLoading={gitWorkspace.diffLoading}
            gitBusy={gitWorkspace.busy}
            gitError={gitWorkspace.error}
            gitResult={gitWorkspace.result}
            rollbackBusy={rollbackBusy}
            rollbackError={rollbackError}
            onSelect={handleSelectReviewPath}
            onScopeChange={setReviewScope}
            onLoadDiff={(path, scope) => void gitWorkspace.loadDiff(path, scope)}
            onStage={(paths) => void gitWorkspace.stage(paths)}
            onUnstage={(paths) => void gitWorkspace.unstage(paths)}
            onDiscard={(paths) => void gitWorkspace.discard(paths)}
            onApplySelection={(request) => void gitWorkspace.applySelection(request)}
            onCommit={async (message) => Boolean(await gitWorkspace.commit(message))}
            onReadConflict={(path) => void gitWorkspace.readConflict(path)}
            onResolveConflict={(path, strategy, content) => void gitWorkspace.resolveConflict(path, strategy, content)}
            onContinueOperation={() => void gitWorkspace.continueOperation()}
            onAbortOperation={() => void gitWorkspace.abortOperation()}
            onRollback={() => void handleRollbackRun()}
            onClose={handleToggleReview}
          />}
        </div>
        <div className="dock-terminal" {...dock.panelProps('terminal')}>
          {dockHeader('terminal', () => setTerminalOpen(false))}
          {terminalCwd && <Suspense fallback={<div className="side-empty">终端加载中…</div>}><TerminalPanel cwd={terminalCwd} visible={terminalOpen} /></Suspense>}
        </div>
        <div className="dock-browser" {...dock.panelProps('browser')}>
          {dockHeader('browser', () => setBrowserOpen(false))}
          {browserMounted && <Suspense fallback={<div className="side-empty">浏览器加载中…</div>}><BrowserPanel visible={browserOpen} navigation={browserNavigation} /></Suspense>}
        </div>
        <div className="dock-git-commit-tree" {...dock.panelProps('gitCommitTree')}>
          {dockHeader('gitCommitTree', () => setGitCommitTreeOpen(false))}
          {gitCommitTreeMounted && <Suspense fallback={<div className="side-empty">提交图加载中…</div>}><GitCommitTree cwd={resourceCwd} visible={gitCommitTreeOpen} /></Suspense>}
        </div>
        {dock.dividers.map((divider, index) => <div key={divider.path} className={`dock-divider dock-divider-${divider.axis}`}
          role="separator" aria-label={`调整分栏 ${index + 1}`} {...dock.dividerProps(divider)} />)}
        {dock.previewStyle && dock.drop && <div className="dock-drop-preview" style={dock.previewStyle} aria-hidden="true">
          <span>{dock.drop.edge === 'center' ? `与${DOCK_LABELS[dock.drop.panel]}交换位置` : `放到${DOCK_LABELS[dock.drop.panel]}${DOCK_EDGE_LABELS[dock.drop.edge]}`}</span>
        </div>}
      </div>

      <WorkbenchDialogs
        operations={{
          kind: operationsPanel,
          onClose: closeOperationsPanel,
          usage: { mounted: usageOverviewMounted, api: hasBridge ? window.pion : undefined },
          workflow: {
            cwd: state.status.cwd,
            workflows: workflows.workflows,
            selected: workflows.selected,
            loading: workflows.loading,
            busy: workflows.busy,
            error: workflows.error,
            onSelect: workflows.select,
            onCreate: workflows.create,
            onStart: workflows.start,
            onApprovePlan: workflows.approvePlan,
            onRepair: workflows.repair,
            onWaiveTests: workflows.waiveTests,
            onResume: workflows.resume,
            onCancel: workflows.cancel,
            onMerge: workflows.merge,
            onCleanup: workflows.cleanup
          },
          verification: {
            plan: verification.plan,
            policy: verification.policy,
            run: verification.latestRun,
            activeRun: verification.activeRun,
            liveLog: verification.liveLog,
            loading: verification.loading,
            busy: verification.busy,
            error: verification.error,
            onStart: (kinds) => void verification.start(kinds),
            onRerun: (runId) => void verification.rerun(runId),
            onCancel: (runId) => void verification.cancel(runId),
            onPolicyChange: (updates) => void verification.updatePolicy(updates),
            onRepair: (prompt) => {
              setPrefill(prompt)
              closeOperationsPanel()
            }
          }
        }}
        confirmations={{
          messageRevert: messageRevert.confirmation && {
            ...messageRevert.confirmation,
            onConfirm: () => { if (!queueEditor.frozen) messageRevert.confirmation?.onConfirm() }
          },
          rollback: {
            open: rollbackConfirmOpen,
            error: rollbackError,
            busy: rollbackBusy,
            onConfirm: () => void confirmRollbackRun(),
            onCancel: () => {
              if (!rollbackBusy) setRollbackConfirmOpen(false)
            }
          },
          planModeExit: planModeExitDialog,
          yolo: yoloDialog,
          migration: {
            open: migrationTarget !== null,
            projectName: state.projects.find((project) => project.cwd === migrationTarget)?.name ?? migrationTarget,
            error: migrationError,
            busy: migrationBusy,
            onConfirm: () => void confirmProjectMigration(),
            onCancel: () => {
              if (!migrationBusy) setMigrationTarget(null)
            }
          }
        }}
        taskHistory={{
          mounted: taskHistoryMounted,
          dialog: { session: taskHistorySession, onClose: closeTaskHistory }
        }}
        capabilities={{
          mounted: capabilitiesMounted,
          dialog: {
            open: capabilitiesOpen,
            onClose: closeCapabilities,
            target: {
              cwd: resourceCwd,
              sessionPath: resourceSessionPath,
              ...(mcpBackendId ? { backendId: mcpBackendId } : {})
            },
            scope: mcpScope,
            selectionRef
          }
        }}
        pluginStore={{
          mounted: pluginStoreMounted,
          dialog: { open: pluginStoreOpen, onClose: closePluginStore }
        }}
        branch={{
          mounted: branchDialogMounted,
          dialog: {
            open: branchDialogCwd !== null,
            projectName: state.projects.find((project) => project.cwd === branchDialogCwd)?.name,
            projectCwd: branchDialogCwd ?? '',
            onClose: closeBranchDialog,
            onSubmit: handleCreateBranch
          }
        }}
        command={{
          mounted: commandDialogMounted,
          dialog: slashCommands.dialog ? { ...slashCommands.dialog,
            open: !settingsOpen && !viewingChild && !hasVisibleInteractions }
            : { open: false, requestId: 0, title: '', onClose: () => {} }
        }}
        settings={{
          mounted: settingsMounted,
          dialog: {
            open: settingsOpen,
            cwd: resourceCwd,
            capabilityScope: mcpScope,
            navigationRequest: settingsNavigation,
            session: state.session,
            models: state.models,
            modelProviderAuthState,
            agentBusy: state.busy,
            completionNotificationsEnabled,
            onCompletionNotificationsChange: (enabled) => void handleCompletionNotificationsChange(enabled),
            sessionPreviewDensity,
            onSessionPreviewDensityChange: handleSessionPreviewDensityChange,
            historyNavGap,
            onHistoryNavGapChange: handleHistoryNavGapChange,
            historyNavMaxVisible,
            onHistoryNavMaxVisibleChange: handleHistoryNavMaxVisibleChange,
            showMetricDuration,
            showMetricCost,
            onMetricDurationChange: (value) => {
              setShowMetricDuration(value)
              saveShowMetricDuration(value)
            },
            onMetricCostChange: (value) => {
              setShowMetricCost(value)
              saveShowMetricCost(value)
            },
            projectTrust,
            projectTrustBusy: projectTrustBusy || state.busy || state.status.phase === 'starting',
            projectTrustError,
            onProjectTrustChange: (decision) => void handleProjectTrustChange(decision),
            toolPermissionPolicy,
            toolPermissionBusy,
            toolPermissionError,
            onToolPermissionChange: (category, decision) => void handleToolPermissionChange(category, decision),
            onToolPermissionReset: () => void handleToolPermissionReset(),
            onClose: closeSettings,
            actions: {
              setModel: actions.setModel,
              listModelProviders: actions.listModelProviders,
              setModelProviderEnabled: actions.setModelProviderEnabled,
              loginModelProvider: actions.loginModelProvider,
              logoutModelProvider: actions.logoutModelProvider,
              cancelModelProviderAuth: actions.cancelModelProviderAuth,
              openModelProviderAuthUrl: actions.openModelProviderAuthUrl,
              addModelProvider: actions.addModelProvider,
              setAutoCompaction: actions.setAutoCompaction,
              setAutoRetry: actions.setAutoRetry,
              compactNow: actions.compactNow,
              exportSessionHtml: actions.exportHtml,
              renameSession: actions.renameSession,
              setSteeringMode: actions.setSteeringMode,
              setFollowUpMode: actions.setFollowUpMode
            }
          }
        }}
      />
    </div>
    </BrowserNavigationContext.Provider>
  )
}
