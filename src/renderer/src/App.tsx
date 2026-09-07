import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { Settings, Store } from 'lucide-react'
import { useAgent } from './hooks/useAgent'
import { useRunTelemetry } from './hooks/useRunTelemetry'
import { useRunRecovery } from './hooks/useRunRecovery'
import { useVerification } from './hooks/useVerification'
import { useAppInteractionState } from './hooks/useAppInteractionState'
import { useConversationNavigation } from './hooks/useConversationNavigation'
import { useWorkflows } from './hooks/useWorkflows'
import { useGitWorkspace } from './hooks/useGitWorkspace'
import { usePanelLayout } from './hooks/usePanelLayout'
import { useDeferredMount } from './hooks/useDeferredMount'
import { useSessionResourceStage } from './hooks/useSessionResourceStage'
import { useSessionModes } from './hooks/useSessionModes'
import { deriveAgentTodos, deriveLatestRunChanges } from './agent/timeline'
import { deriveWorkingStatus } from './agent/workingStatus'
import type { FileChange } from './agent/types'
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
import { QueuedMessagesCard } from './features/session/QueuedMessagesCard'
import { ChatTimeline } from './features/chat/ChatTimeline'
import { Composer } from './features/chat/Composer'
import { FavoriteSessions, ProjectList, SidebarToolbar } from './features/project/Sidebar'
import { ReviewPanel } from './features/review/ReviewPanel'
import { ModelPicker, ThinkingPicker } from './features/settings/ModelPicker'
import { TitleBar } from './features/chrome/TitleBar'
import { ProjectPicker } from './features/project/ProjectPicker'
import { ProjectTrustBanner } from './features/project/ProjectTrustBanner'
import { HistoryNavigator } from './features/session/HistoryNavigator'
import { ToolPermissionModal } from './features/operations/ToolPermissionModal'
import { ExtensionUiModal } from './features/common/ExtensionUiModal'
import { ConfirmDialog } from './features/common/ConfirmDialog'
import { RunMetricsStrip } from './features/operations/RunMetricsStrip'
import { RunRecoveryBanner } from './features/operations/RunRecoveryBanner'
import { VerificationPanel } from './features/operations/VerificationPanel'
import { WorkflowPanel } from './features/operations/WorkflowPanel'
import { OperationsModal } from './features/operations/OperationsModal'
import type { OperationsPanelKind } from './features/operations/OperationsModal'
import { readSessionPreviewDensity, saveSessionPreviewDensity } from './utils/sessionPreview'
import type { SessionPreviewDensity } from './utils/sessionPreview'
import {
  readHistoryNavMaxVisible,
  saveHistoryNavMaxVisible
} from './utils/historyNavigatorSettings'
import { resolvePendingReviewFile, scopeForReviewFile } from './utils/reviewPaths'
import type { PendingReviewSelection } from './utils/reviewPaths'
import { orderFavoriteSessions, readFavoriteSessionPaths, saveFavoriteSessionPaths } from './agent/sessionFavorites'

const LazyBranchCreateModal = lazy(() => import('./features/project/BranchCreateModal')
  .then((module) => ({ default: module.BranchCreateModal })))
const LazySettingsModal = lazy(() => import('./features/settings/SettingsModal')
  .then((module) => ({ default: module.SettingsModal })))
const LazySkillsToolsModal = lazy(() => import('./features/capabilities/SkillsToolsModal')
  .then((module) => ({ default: module.SkillsToolsModal })))
const LazyPluginStoreModal = lazy(() => import('./features/capabilities/PluginStoreModal')
  .then((module) => ({ default: module.PluginStoreModal })))
const LazyTaskHistoryPanel = lazy(() => import('./features/session/TaskHistoryPanel')
  .then((module) => ({ default: module.TaskHistoryPanel })))

const PION_LOCAL_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: 'plan', description: '切换 Pion 只读计划模式，不直接执行实现', source: 'pion' },
  { name: 'yolo', description: '切换 YOLO 模式：自动批准本会话所有工具权限请求', source: 'pion' },
  { name: 'verify', description: '打开项目自动验证面板', source: 'pion' },
  { name: 'agents', description: '打开隔离多 Agent 工作流面板', source: 'pion' }
]
const LOCAL_SLASH_COMMAND_NAMES = PION_LOCAL_SLASH_COMMANDS.map((command) => command.name)

export function App(): ReactElement {
  const { state, actions, hasBridge } = useAgent()
  const [selectedSession, setSelectedSession] = useState<{ cwd: string; path: string } | null>(null)
  const [operationsPanel, setOperationsPanel] = useState<OperationsPanelKind | null>(null)
  const resourceCwd = selectedSession?.cwd ?? state.status.cwd
  const resourceSessionPath = selectedSession?.path ?? state.session?.sessionFile
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
  const runRecovery = useRunRecovery({
    hasBridge,
    enabled: policyResourcesEnabled,
    sessionPath: resourceSessionPath,
    cwd: resourceCwd
  })
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
  const [capturedReviewChange, setCapturedReviewChange] = useState<FileChange | null>(null)
  const [pendingReviewSelection, setPendingReviewSelection] = useState<PendingReviewSelection | null>(null)
  const [reviewScope, setReviewScope] = useState<GitDiffScope>('unstaged')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [pluginStoreOpen, setPluginStoreOpen] = useState(false)
  const [taskHistorySession, setTaskHistorySession] = useState<SessionMeta | null>(null)
  const [branchDialogCwd, setBranchDialogCwd] = useState<string | null>(null)
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false)
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [rollbackError, setRollbackError] = useState('')
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [migrationError, setMigrationError] = useState('')
  const {
    maximized,
    sidebarOpen,
    setSidebarOpen,
    reviewOpen,
    setReviewOpen,
    sidebarWidth,
    reviewWidth,
    handleResizeStart
  } = usePanelLayout(hasBridge)
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
    toolPermissionResolveBusy,
    toolPermissionResolveError,
    extensionUiRequests,
    modelProviderAuthState,
    extensionUiResolveBusy,
    extensionUiResolveError,
    handleCompletionNotificationsChange,
    handleProjectTrustChange,
    handleToolPermissionChange,
    handleToolPermissionReset,
    handleToolPermissionResolve,
    handleExtensionUiResolve
  } = useAppInteractionState({
    hasBridge,
    cwd: resourceCwd,
    policyEnabled: policyResourcesEnabled,
    agentBusy: state.busy,
    statusPhase: state.status.phase,
    updateProjectTrust: actions.setProjectTrust
  })
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
  useEffect(() => {
    const snapshot = gitWorkspace.snapshot
    if (!pendingReviewSelection || !snapshot) return
    const file = resolvePendingReviewFile(
      snapshot.files,
      pendingReviewSelection,
      resourceCwd,
      snapshot.root
    )
    if (!file) return
    setReviewOpen(true)
    setCapturedReviewChange(null)
    setReviewPath(file.path)
    setReviewScope(scopeForReviewFile(file, pendingReviewSelection.preferredScope))
    setPendingReviewSelection(null)
  }, [gitWorkspace.snapshot, pendingReviewSelection, resourceCwd])
  const taskHistoryMounted = useDeferredMount(taskHistorySession !== null)
  const capabilitiesMounted = useDeferredMount(capabilitiesOpen)
  const pluginStoreMounted = useDeferredMount(pluginStoreOpen)
  const branchDialogMounted = useDeferredMount(branchDialogCwd !== null)
  const settingsMounted = useDeferredMount(settingsOpen)
  const newSessionInFlight = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const agentTodos = useMemo(() => deriveAgentTodos(state.timeline) ?? [], [state.timeline])
  const { visibleHistoryEntryId, handleTimelineScroll } = useConversationNavigation({
    scrollRef,
    timeline: state.timeline,
    timelineMutation: state.timelineMutation,
    busy: state.busy,
    sessionPath: state.session?.sessionFile,
    historyIndexSessionPath: state.historyIndex?.sessionPath,
    historyJump: state.historyJump,
    panelsVisible: state.queuedMessages.steering.length > 0
      || state.queuedMessages.followUp.length > 0
      || (state.mode !== 'plan' && agentTodos.length > 0),
    loadOlder: actions.loadOlder,
    loadNewer: actions.loadNewer
  })
  const sessionSelectionId = useRef(0)

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
    await actions.addProject(cwd)
    await actions.start(cwd)
  }, [hasBridge, actions])

  const handleSelectProject = useCallback(
    async (cwd: string) => {
      sessionSelectionId.current += 1
      setSelectedSession(null)
      if (cwd === state.status.cwd) return
      await actions.start(cwd)
    },
    [actions, state.status.cwd]
  )

  const activateProject = useCallback(
    async (cwd: string) => {
      if (cwd !== state.status.cwd) await actions.start(cwd)
    },
    [actions, state.status.cwd]
  )

  const requestProjectMigration = useCallback((cwd: string): void => {
    if (!cwd || cwd === state.status.cwd) return
    setMigrationError('')
    setMigrationTarget(cwd)
  }, [state.status.cwd])

  const confirmProjectMigration = useCallback(async (): Promise<void> => {
    if (!migrationTarget) return
    setMigrationBusy(true)
    setMigrationError('')
    try {
      const movedPath = await actions.migrateSessionToProject(migrationTarget)
      setMigrationTarget(null)
      if (movedPath) await actions.switchSession(movedPath)
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationBusy(false)
    }
  }, [actions, migrationTarget])

  const handleNewSession = useCallback(
    async (cwd?: string) => {
      if (newSessionInFlight.current) return
      newSessionInFlight.current = true
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
      } finally {
        newSessionInFlight.current = false
      }
    },
    [actions, activateProject, state.status.cwd]
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
      if (
        cwd === state.status.cwd &&
        path === state.session?.sessionFile &&
        (state.status.phase === 'running' || state.status.phase === 'starting')
      ) {
        setSelectedSession(null)
        return
      }
      const requestId = ++sessionSelectionId.current
      const previousSelection = selectedSession
      const previousReviewPath = reviewPath
      const previousCapturedReviewChange = capturedReviewChange
      setReviewPath(null)
      setCapturedReviewChange(null)
      setPendingReviewSelection(null)
      setSelectedSession({ cwd, path })
      try {
        // Persisted sessions are global pool entries. switchSession resolves the
        // session's cwd and activates its retained backend; starting the project
        // first would blank the timeline and create a throwaway logical session.
        const result = await actions.switchSession(path)
        if (result.cancelled && requestId === sessionSelectionId.current) {
          setSelectedSession(previousSelection)
          setReviewPath(previousReviewPath)
          setCapturedReviewChange(previousCapturedReviewChange)
          return
        }
      } catch (error) {
        if (requestId === sessionSelectionId.current) {
          setSelectedSession(previousSelection)
          setReviewPath(previousReviewPath)
          setCapturedReviewChange(previousCapturedReviewChange)
        }
        console.error('[pion] 切换会话失败', error)
      }
    },
    [actions, capturedReviewChange, reviewPath, selectedSession, state.session?.sessionFile, state.status.cwd]
  )

  const handleDeleteSession = useCallback(
    async (cwd: string, path: string) => {
      if (selectedSession?.path === path) setSelectedSession(null)
      setFavoriteSessionPaths((current) => current.includes(path)
        ? current.filter((favoritePath) => favoritePath !== path)
        : current)
      await actions.deleteSession(path)
      await actions.refreshProjectSessions(cwd)
    },
    [actions, selectedSession?.path]
  )

  const handleCopySession = useCallback(
    async (_cwd: string, path: string) => {
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

  const handleComposerSend = useCallback(async (
    text: string,
    images: ImageContent[]
  ): Promise<void> => {
    const localMatch = text.trim().match(/^\/(verify|agents|plan|yolo)(?:\s+([\s\S]*))?$/i)
    const match = localMatch ?? (images.length === 0
      ? text.trim().match(/^\/(compact|new|name|clone)(?:\s+([\s\S]*))?$/i)
      : null)
    if (!match) {
      try {
        await actions.send(text, images)
      } catch (error) {
        console.error('[pion] 发送消息失败', error)
      }
      return
    }

    const command = match[1].toLowerCase()
    const argument = (match[2] ?? '').trim()
    try {
      if (command === 'compact') {
        await actions.compactNow(argument || undefined)
      } else if (command === 'new') {
        await handleNewSession()
      } else if (command === 'name') {
        await actions.renameSession(argument)
      } else if (command === 'clone') {
        const path = state.session?.sessionFile
        if (!path) throw new Error('当前会话尚未持久化，无法复制')
        await handleCopySession(state.status.cwd ?? '', path)
      } else if (command === 'verify') {
        setOperationsPanel('verification')
      } else if (command === 'agents') {
        setOperationsPanel('agents')
      } else if (command === 'plan') {
        const requested = argument.toLocaleLowerCase()
        if (requested === 'start') handleModeChange('plan')
        else if (requested === 'exit' || requested === 'off') handleModeChange('build')
        else if (!requested) handleModeChange(state.mode === 'plan' ? 'build' : 'plan')
        else throw new Error('用法：/plan start 或 /plan exit')
      } else if (command === 'yolo') {
        const requested = argument.toLocaleLowerCase()
        if (requested === 'on' || requested === 'start') requestYoloMode(true)
        else if (requested === 'off' || requested === 'exit') requestYoloMode(false)
        else if (!requested) requestYoloMode(!state.yolo)
        else throw new Error('用法：/yolo on 或 /yolo off')
      }
    } catch (error) {
      console.error(`[pion] /${command} 执行失败`, error)
    }
  }, [
    actions,
    handleCopySession,
    handleModeChange,
    handleNewSession,
    requestYoloMode,
    state.mode,
    state.session?.sessionFile,
    state.status.cwd,
    state.yolo
  ])

  const composerCommands = useMemo(() => {
    const merged = new Map(state.commands.map((command) => [command.name, command]))
    for (const command of PION_LOCAL_SLASH_COMMANDS) merged.set(command.name, command)
    return [...merged.values()]
  }, [state.commands])
  const latestRunChanges = useMemo<FileChange[]>(() => {
    // Use the same workspace snapshot as Review, not a partial tool transcript.
    if (gitWorkspace.snapshot) return gitWorkspace.snapshot.files.map((file) => ({
      path: file.path,
      kind: 'edit',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0
    }))
    return deriveLatestRunChanges(state.timeline)
  }, [gitWorkspace.snapshot, state.timeline])
  const taskSessionKey = state.session?.sessionFile || state.session?.sessionId || state.status.cwd || 'default'
  const hasTaskPanel = state.mode !== 'plan' && agentTodos.length > 0
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
    setCapturedReviewChange(null)
    setPendingReviewSelection(null)
  }, [])

  const openReviewChanges = useCallback((changes: FileChange[], fallbackToFirst: boolean) => {
    const pending: PendingReviewSelection = {
      paths: changes.map((change) => change.path).filter((path) => path.trim() !== ''),
      preferredScope: 'unstaged',
      fallbackToFirst
    }
    // Commit the split pane before resolving Git paths so an unavailable or
    // delayed snapshot can never make the user action look like a no-op.
    flushSync(() => setReviewOpen(true))
    const snapshot = gitWorkspace.snapshot
    const file = snapshot
      ? resolvePendingReviewFile(snapshot.files, pending, resourceCwd, snapshot.root)
      : null
    if (file) {
      setCapturedReviewChange(null)
      setReviewPath(file.path)
      setReviewScope(scopeForReviewFile(file, pending.preferredScope))
      setPendingReviewSelection(null)
      return
    }
    setCapturedReviewChange(changes[0] ?? null)
    setReviewScope(pending.preferredScope)
    setReviewPath(null)
    setPendingReviewSelection(pending.paths.length > 0 ? pending : null)
  }, [gitWorkspace.snapshot, resourceCwd])

  const handleReviewLatestChanges = useCallback(() => {
    openReviewChanges(latestRunChanges, true)
  }, [latestRunChanges, openReviewChanges])

  const handleSelectInlineChange = useCallback((change: FileChange) => {
    openReviewChanges([change], false)
  }, [openReviewChanges])

  const handleSelectReviewPath = useCallback((path: string | null) => {
    setCapturedReviewChange(null)
    setPendingReviewSelection(null)
    setReviewPath(path)
  }, [])

  useEffect(() => {
    setRollbackError('')
    if (state.runCheckpoint?.state === 'rolled-back') {
      setReviewPath(null)
      setCapturedReviewChange(null)
      setPendingReviewSelection(null)
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
      setCapturedReviewChange(null)
      setPendingReviewSelection(null)
      await gitWorkspace.refresh()
      setRollbackConfirmOpen(false)
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error))
    } finally {
      setRollbackBusy(false)
    }
  }, [actions, gitWorkspace, state.busy, state.runCheckpoint])

  const activeCwd = selectedSession?.cwd ?? state.status.cwd
  const activePath = selectedSession?.path ?? state.session?.sessionFile
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
    <div className="app">
      <TitleBar
        cwd={state.status.cwd}
        sessionName={state.session?.sessionName}
        maximized={maximized}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        reviewOpen={reviewOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleReview={handleToggleReview}
      />

      <div className="app-body">
        {sidebarOpen && <aside className="sidebar" style={{ width: sidebarWidth }}>
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
              onSelect={(cwd) => void handleSelectProject(cwd)}
              onAdd={() => void handleAddProject()}
              onRemove={(cwd) => void actions.removeProject(cwd)}
              onNewSession={(cwd) => void handleNewSession(cwd)}
              onNewBranch={(cwd) => void handleNewBranch(cwd)}
              onRenameBranch={handleRenameBranch}
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
          <div className="sidebar-footer">
            <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
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
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整会话栏宽度"
            onPointerDown={(event) => handleResizeStart('sidebar', event)}
          />
        </aside>}

        <div className="main">
          {state.status.phase === 'error' && (
            <div className="banner banner-error">
              <span>agent 启动失败：{state.status.error}</span>
            </div>
          )}
          {state.timelineError && (
            <div className="banner banner-error session-load-error">
              <span>{state.timelineError}</span>
            </div>
          )}

          <RunMetricsStrip
            run={displayedRun}
            sessionTotals={sessionTotals}
            showDuration={showMetricDuration}
            showCost={showMetricCost}
          />

          <ProjectTrustBanner
            trust={projectTrust}
            busy={projectTrustBusy || state.busy || state.status.phase === 'starting'}
            error={projectTrustError}
            onDecision={(decision) => void handleProjectTrustChange(decision)}
          />

          <RunRecoveryBanner
            candidates={runRecovery.candidates}
            busyId={runRecovery.busyId}
            agentBusy={state.busy}
            error={runRecovery.error}
            onResume={(runId) => void runRecovery.resume(runId)}
            onDiscard={(runId) => void runRecovery.discard(runId)}
            onRestoreCheckpoint={(runId) => void runRecovery.restoreCheckpoint(runId)}
          />

          <div className={`conversation-shell${historyNavigatorVisible ? ' has-history-navigator' : ''}${(hasTaskPanel || hasQueuedMessages) ? ' has-composer-panels' : ''}`}>
            <HistoryNavigator
              index={state.historyIndex}
              activeEntryId={visibleHistoryEntryId}
              busy={state.timelineLoading}
              gap={historyNavGap}
              maxVisible={historyNavMaxVisible}
              onJump={(landmark) => void actions.jumpToHistoryLandmark(landmark)}
            />
            <div className="chat-stage">
              <ChatTimeline
                scrollRef={scrollRef}
                onScroll={handleTimelineScroll}
                timeline={state.timeline}
                timelineLoading={state.timelineLoading}
                busy={state.busy}
                starting={state.status.phase === 'starting'}
                cwd={state.status.cwd}
                hasSessions={state.sessions.length > 1}
                canFork={state.status.phase !== 'error' && state.status.phase !== 'stopped' && Boolean(state.status.cwd)}
                onFork={handleFork}

                agentActivity={agentActivity}
                workingStatus={workingStatus}
                latestRunChanges={latestRunChanges}
                workspaceChanges={Boolean(gitWorkspace.snapshot)}
                runCheckpoint={state.runCheckpoint}
                rollbackBusy={rollbackBusy}
                rollbackError={rollbackError}
                onUndo={() => void handleRollbackRun()}
                onReview={handleReviewLatestChanges}
                onSelectChange={handleSelectInlineChange}
              />
            <ToolPermissionModal
              request={toolPermissionRequests[0] ?? null}
              queueLength={toolPermissionRequests.length}
              busy={toolPermissionResolveBusy}
              error={toolPermissionResolveError}
              onResolve={(resolution) => void handleToolPermissionResolve(resolution)}
            />
            {extensionUiRequests[0] && (
              <ExtensionUiModal
                request={extensionUiRequests[0]}
                queueLength={extensionUiRequests.length}
                busy={extensionUiResolveBusy}
                error={extensionUiResolveError}
                onResolve={handleExtensionUiResolve}
              />
            )}
          </div>

          <div className="composer-dock">
            {(hasTaskPanel || hasQueuedMessages) && (
              <div className={`composer-support-row${hasTaskPanel ? ' has-task-panel' : ''}${hasQueuedMessages ? ' has-queue-panel' : ''}`}>
                <TaskPanel
                  key={taskSessionKey}
                  sessionKey={taskSessionKey}
                  agentTodos={hasTaskPanel ? agentTodos : null}
                  agentBusy={state.busy}
                />
                <QueuedMessagesCard
                  key={`queue-${taskSessionKey}`}
                  sessionKey={taskSessionKey}
                  steering={queuedMessages.steering}
                  followUp={queuedMessages.followUp}
                  nativeFollowUpCount={queuedMessages.nativeFollowUpCount}
                  agentBusy={state.busy}
                  onSendItem={(kind, index) => actions.sendQueuedMessage(kind, index).catch((error: unknown) => {
                    console.error('[pion] 直接发送排队消息失败', error)
                  })}
                  onEditItem={(item) => actions.removeQueuedMessage(item.kind, item.index)
                    .then(() => setPrefill(item.text))
                    .catch((error: unknown) => {
                      console.error('[pion] 编辑排队消息失败', error)
                    })}
                  onRemoveItem={(kind, index) => actions.removeQueuedMessage(kind, index).catch((error: unknown) => {
                    console.error('[pion] 删除排队消息失败', error)
                  })}
                />
              </div>
            )}
            <Composer
              busy={state.busy}
              disabled={!state.status.cwd}
              sendDisabled={state.status.phase === 'starting' || state.status.phase === 'error' || projectTrust?.decision === 'ask'}
              prefill={prefill}
              history={messageHistory}
              commands={composerCommands}
              contextPressure={displayedRun?.contextPressure}
              contextTokens={displayedRun?.contextTokens}
              contextWindow={displayedRun?.contextWindow}
              localCommandNames={LOCAL_SLASH_COMMAND_NAMES}
              mode={state.mode}
              yolo={state.yolo}
              onYoloDisable={() => requestYoloMode(false)}
              onModeChange={handleModeChange}
              projectSelector={
                <ProjectPicker
                  projects={state.projects}
                  value={state.status.cwd ?? ''}
                  disabled={state.projects.length === 0}
                  onChange={requestProjectMigration}
                />
              }
              controls={
                <>
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

        {reviewOpen && (
          <ReviewPanel
            snapshot={gitResourcesEnabled ? gitWorkspace.snapshot : null}
            diff={reviewCodeEnabled ? gitWorkspace.diff : null}
            conflict={reviewCodeEnabled ? gitWorkspace.conflict : null}
            selectedPath={reviewPath}
            capturedChange={capturedReviewChange}
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
            width={reviewWidth}
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
            onResizeStart={(event) => handleResizeStart('review', event)}
          />
        )}
      </div>

      {operationsPanel && (
        <OperationsModal kind={operationsPanel} onClose={closeOperationsPanel}>
          {operationsPanel === 'agents' ? (
            <WorkflowPanel
              embedded
              cwd={state.status.cwd}
              workflows={workflows.workflows}
              selected={workflows.selected}
              loading={workflows.loading}
              busy={workflows.busy}
              error={workflows.error}
              onSelect={workflows.select}
              onCreate={workflows.create}
              onStart={workflows.start}
              onApprovePlan={workflows.approvePlan}
              onRepair={workflows.repair}
              onWaiveTests={workflows.waiveTests}
              onResume={workflows.resume}
              onCancel={workflows.cancel}
              onMerge={workflows.merge}
              onCleanup={workflows.cleanup}
            />
          ) : (
            <VerificationPanel
              embedded
              plan={verification.plan}
              policy={verification.policy}
              run={verification.latestRun}
              activeRun={verification.activeRun}
              liveLog={verification.liveLog}
              loading={verification.loading}
              busy={verification.busy}
              error={verification.error}
              onStart={(kinds) => void verification.start(kinds)}
              onRerun={(runId) => void verification.rerun(runId)}
              onCancel={(runId) => void verification.cancel(runId)}
              onPolicyChange={(updates) => void verification.updatePolicy(updates)}
              onRepair={(prompt) => {
                setPrefill(prompt)
                closeOperationsPanel()
              }}
            />
          )}
        </OperationsModal>
      )}

      <ConfirmDialog
        open={rollbackConfirmOpen}
        title="撤销本轮修改"
        message="工作区将恢复到发送本轮任务之前。"
        detail={rollbackError || '发送前已有的暂存、未暂存和未跟踪文件会保留；本轮开始后的手动修改也会一并撤销。'}
        confirmLabel="确认撤销"
        tone="accent"
        busy={rollbackBusy}
        onConfirm={() => void confirmRollbackRun()}
        onCancel={() => {
          if (!rollbackBusy) setRollbackConfirmOpen(false)
        }}
      />
      <ConfirmDialog
        open={planModeExitDialog.open}
        title="确认进入构建模式"
        message="计划模式只允许资料收集，不会修改文件或创建 Pion 任务。"
        detail={planModeExitDialog.error || '确认后将恢复编辑、写入和终端工具；此操作不会自动开始执行，仍需发送下一条执行请求。'}
        confirmLabel="切换到构建模式"
        tone="accent"
        busy={planModeExitDialog.busy}
        onConfirm={planModeExitDialog.onConfirm}
        onCancel={planModeExitDialog.onCancel}
      />
      <ConfirmDialog
        open={yoloDialog.open}
        title="确认开启 YOLO 模式"
        message="YOLO 模式会自动批准本会话的所有工具权限请求，包括写入文件和执行终端命令。"
        detail={yoloDialog.error || '开启后不再弹出权限确认，也不会写入项目权限规则；发送 /yolo off 或点击 YOLO 标识可随时关闭。'}
        confirmLabel="开启 YOLO"
        tone="danger"
        busy={yoloDialog.busy}
        onConfirm={yoloDialog.onConfirm}
        onCancel={yoloDialog.onCancel}
      />
      <ConfirmDialog
        open={migrationTarget !== null}
        title="迁移会话到项目"
        message={`将会话迁移到 ${state.projects.find((project) => project.cwd === migrationTarget)?.name ?? migrationTarget}？`}
        detail={migrationError || '会话文件会移动到目标项目的会话目录，并在那里继续。运行中的会话需要先等待完成。'}
        confirmLabel="迁移"
        tone="accent"
        busy={migrationBusy}
        onConfirm={() => void confirmProjectMigration()}
        onCancel={() => {
          if (!migrationBusy) setMigrationTarget(null)
        }}
      />
      {taskHistoryMounted && (
        <Suspense fallback={null}>
          <LazyTaskHistoryPanel
            session={taskHistorySession}
            onClose={closeTaskHistory}
          />
        </Suspense>
      )}
      {capabilitiesMounted && (
        <Suspense fallback={null}>
          <LazySkillsToolsModal
            open={capabilitiesOpen}
            onClose={closeCapabilities}
          />
        </Suspense>
      )}
      {pluginStoreMounted && (
        <Suspense fallback={null}>
          <LazyPluginStoreModal
            open={pluginStoreOpen}
            onClose={closePluginStore}
          />
        </Suspense>
      )}
      {branchDialogMounted && (
        <Suspense fallback={null}>
          <LazyBranchCreateModal
            open={branchDialogCwd !== null}
            projectName={state.projects.find((project) => project.cwd === branchDialogCwd)?.name ?? '当前项目'}
            projectCwd={branchDialogCwd ?? ''}
            onClose={closeBranchDialog}
            onSubmit={handleCreateBranch}
          />
        </Suspense>
      )}
      {settingsMounted && (
        <Suspense fallback={null}>
          <LazySettingsModal
            open={settingsOpen}
            session={state.session}
            models={state.models}
            modelProviderAuthState={modelProviderAuthState}
            agentBusy={state.busy}
            completionNotificationsEnabled={completionNotificationsEnabled}
            onCompletionNotificationsChange={(enabled) => void handleCompletionNotificationsChange(enabled)}
            sessionPreviewDensity={sessionPreviewDensity}
            onSessionPreviewDensityChange={handleSessionPreviewDensityChange}
            historyNavGap={historyNavGap}
            onHistoryNavGapChange={handleHistoryNavGapChange}
            historyNavMaxVisible={historyNavMaxVisible}
            onHistoryNavMaxVisibleChange={handleHistoryNavMaxVisibleChange}
            showMetricDuration={showMetricDuration}
            showMetricCost={showMetricCost}
            onMetricDurationChange={(value) => {
              setShowMetricDuration(value)
              saveShowMetricDuration(value)
            }}
            onMetricCostChange={(value) => {
              setShowMetricCost(value)
              saveShowMetricCost(value)
            }}
            projectTrust={projectTrust}
            projectTrustBusy={projectTrustBusy || state.busy || state.status.phase === 'starting'}
            projectTrustError={projectTrustError}
            onProjectTrustChange={(decision) => void handleProjectTrustChange(decision)}
            toolPermissionPolicy={toolPermissionPolicy}
            toolPermissionBusy={toolPermissionBusy}
            toolPermissionError={toolPermissionError}
            onToolPermissionChange={(category, decision) => void handleToolPermissionChange(category, decision)}
            onToolPermissionReset={() => void handleToolPermissionReset()}
            onClose={closeSettings}
            actions={{
              setModel: actions.setModel,
              listModelProviders: actions.listModelProviders,
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
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
