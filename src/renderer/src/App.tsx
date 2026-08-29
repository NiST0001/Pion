import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { FolderOpen, Settings, Sparkles, Store } from 'lucide-react'
import { useAgent } from './hooks/useAgent'
import { deriveChanges } from './agent/timeline'
import type { FileChange } from './agent/types'
import type {
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  ToolPermissionCategory,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRules
} from '../../shared/types'
import { ChatMessage } from './components/ChatMessage'
import { ToolCallItem } from './components/ToolCallItem'
import { Composer } from './components/Composer'
import { BranchCreateModal } from './components/BranchCreateModal'
import { FavoriteSessions, ProjectList, SidebarToolbar } from './components/Sidebar'
import { ChangesDrawer } from './components/ChangesDrawer'
import { ReviewPanel } from './components/ReviewPanel'
import { ModelPicker, ThinkingPicker } from './components/ModelPicker'
import { TitleBar } from './components/TitleBar'
import { SettingsModal } from './components/SettingsModal'
import { SkillsToolsModal } from './components/SkillsToolsModal'
import { PluginStoreModal } from './components/PluginStoreModal'
import { ProjectPicker } from './components/ProjectPicker'
import { ProjectTrustBanner } from './components/ProjectTrustBanner'
import { HistoryNavigator } from './components/HistoryNavigator'
import { ToolPermissionModal } from './components/ToolPermissionModal'
import { readSessionPreviewDensity, saveSessionPreviewDensity } from './utils/sessionPreview'
import type { SessionPreviewDensity } from './utils/sessionPreview'
import { orderFavoriteSessions, readFavoriteSessionPaths, saveFavoriteSessionPaths } from './agent/sessionFavorites'

type ResizeTarget = 'sidebar' | 'review'

interface PanelResizeState {
  target: ResizeTarget
  startX: number
  startWidth: number
}

const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 2200
const MIN_REVIEW_WIDTH = 300
const MAX_REVIEW_WIDTH = 2800

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function App(): ReactElement {
  const { state, actions, hasBridge } = useAgent()
  const [prefill, setPrefill] = useState('')
  const [drawerChange, setDrawerChange] = useState<FileChange | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [pluginStoreOpen, setPluginStoreOpen] = useState(false)
  const [completionNotificationsEnabled, setCompletionNotificationsEnabled] = useState(true)
  const [projectTrust, setProjectTrust] = useState<ProjectTrustInfo | null>(null)
  const [projectTrustBusy, setProjectTrustBusy] = useState(false)
  const [projectTrustError, setProjectTrustError] = useState('')
  const [toolPermissionPolicy, setToolPermissionPolicy] = useState<ProjectToolPermissionPolicy | null>(null)
  const [toolPermissionBusy, setToolPermissionBusy] = useState(false)
  const [toolPermissionError, setToolPermissionError] = useState('')
  const [toolPermissionRequests, setToolPermissionRequests] = useState<ToolPermissionRequest[]>([])
  const [toolPermissionResolveBusy, setToolPermissionResolveBusy] = useState(false)
  const [toolPermissionResolveError, setToolPermissionResolveError] = useState('')
  const [branchDialogCwd, setBranchDialogCwd] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [rollbackError, setRollbackError] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(276)
  const [reviewWidth, setReviewWidth] = useState(390)
  const [sessionQuery, setSessionQuery] = useState('')
  const [favoriteSessionPaths, setFavoriteSessionPaths] = useState<string[]>(readFavoriteSessionPaths)
  const [sessionPreviewDensity, setSessionPreviewDensity] = useState<SessionPreviewDensity>(readSessionPreviewDensity)
  const [newSessionCwd, setNewSessionCwd] = useState('')
  const [selectedSession, setSelectedSession] = useState<{ cwd: string; path: string } | null>(null)
  const [visibleHistoryEntryId, setVisibleHistoryEntryId] = useState<string | undefined>()
  const newSessionInFlight = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelResizeRef = useRef<PanelResizeState | null>(null)
  const sessionSelectionId = useRef(0)
  const historyScrollFrame = useRef<number | null>(null)
  const highlightedHistoryRow = useRef<HTMLElement | null>(null)
  const historyHighlightTimer = useRef<number | null>(null)

  // bootstrap: pick the most recent project (or home) and start the agent
  useEffect(() => {
    if (!hasBridge) return
    void actions.bootstrap()
  }, [hasBridge, actions])

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    void window.pion.getCompletionNotificationsEnabled()
      .then((enabled) => {
        if (active) setCompletionNotificationsEnabled(enabled)
      })
      .catch((error: unknown) => {
        console.error('[pion] failed to load notification setting:', error)
      })
    return () => {
      active = false
    }
  }, [hasBridge])

  useEffect(() => {
    const cwd = state.status.cwd
    if (!hasBridge || !cwd) {
      setProjectTrust(null)
      setToolPermissionPolicy(null)
      return
    }
    let active = true
    setProjectTrustError('')
    setToolPermissionError('')
    void Promise.all([
      window.pion.getProjectTrust(cwd),
      window.pion.getToolPermissionPolicy(cwd)
    ])
      .then(([trust, policy]) => {
        if (!active) return
        setProjectTrust(trust)
        setToolPermissionPolicy(policy)
      })
      .catch((error: unknown) => {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        setProjectTrustError(message)
        setToolPermissionError(message)
      })
    return () => {
      active = false
    }
  }, [hasBridge, state.status.cwd])

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    const off = window.pion.onToolPermissionRequests((requests) => {
      if (active) setToolPermissionRequests(requests)
    })
    void window.pion.getPendingToolPermissionRequests().then((requests) => {
      if (active) setToolPermissionRequests(requests)
    })
    return () => {
      active = false
      off()
    }
  }, [hasBridge])

  useEffect(() => {
    setToolPermissionResolveError('')
  }, [toolPermissionRequests[0]?.id])

  const handleCompletionNotificationsChange = useCallback(async (enabled: boolean): Promise<void> => {
    if (!hasBridge) return
    try {
      await window.pion.setCompletionNotificationsEnabled(enabled)
      setCompletionNotificationsEnabled(enabled)
    } catch (error) {
      console.error('[pion] failed to update notification setting:', error)
    }
  }, [hasBridge])

  const handleSessionPreviewDensityChange = useCallback((density: SessionPreviewDensity): void => {
    setSessionPreviewDensity(density)
    saveSessionPreviewDensity(density)
  }, [])

  const handleProjectTrustChange = useCallback(async (decision: boolean | null): Promise<void> => {
    const cwd = state.status.cwd
    if (!cwd || projectTrustBusy || state.busy || state.status.phase === 'starting') return
    setProjectTrustBusy(true)
    setProjectTrustError('')
    try {
      const trust = await actions.setProjectTrust(cwd, decision)
      setProjectTrust(trust)
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectTrustBusy(false)
    }
  }, [actions, projectTrustBusy, state.busy, state.status.cwd, state.status.phase])

  const handleToolPermissionChange = useCallback(async (
    category: ToolPermissionCategory,
    decision: ToolPermissionDecision
  ): Promise<void> => {
    const cwd = state.status.cwd
    if (!cwd || toolPermissionBusy) return
    const updates: Partial<ToolPermissionRules> = { [category]: decision }
    setToolPermissionBusy(true)
    setToolPermissionError('')
    try {
      setToolPermissionPolicy(await window.pion.setToolPermissionPolicy(cwd, updates))
    } catch (error) {
      setToolPermissionError(error instanceof Error ? error.message : String(error))
    } finally {
      setToolPermissionBusy(false)
    }
  }, [state.status.cwd, toolPermissionBusy])

  const handleToolPermissionReset = useCallback(async (): Promise<void> => {
    const cwd = state.status.cwd
    if (!cwd || toolPermissionBusy) return
    setToolPermissionBusy(true)
    setToolPermissionError('')
    try {
      setToolPermissionPolicy(await window.pion.setToolPermissionPolicy(cwd, null))
    } catch (error) {
      setToolPermissionError(error instanceof Error ? error.message : String(error))
    } finally {
      setToolPermissionBusy(false)
    }
  }, [state.status.cwd, toolPermissionBusy])

  const handleToolPermissionResolve = useCallback(async (
    resolution: ToolPermissionResolution
  ): Promise<void> => {
    const request = toolPermissionRequests[0]
    if (!request || toolPermissionResolveBusy) return
    setToolPermissionResolveBusy(true)
    setToolPermissionResolveError('')
    try {
      await window.pion.resolveToolPermission(request.id, resolution)
      setToolPermissionRequests((current) => current.filter((item) => item.id !== request.id))
      if (state.status.cwd) {
        setToolPermissionPolicy(await window.pion.getToolPermissionPolicy(state.status.cwd))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToolPermissionResolveError(message)
      if (message.includes('已结束') || message.includes('已关闭')) {
        setToolPermissionRequests((current) => current.filter((item) => item.id !== request.id))
      }
    } finally {
      setToolPermissionResolveBusy(false)
    }
  }, [state.status.cwd, toolPermissionRequests, toolPermissionResolveBusy])

  useEffect(() => {
    saveFavoriteSessionPaths(favoriteSessionPaths)
  }, [favoriteSessionPaths])

  const favoritePathSet = useMemo(() => new Set(favoriteSessionPaths), [favoriteSessionPaths])
  const favoriteSessions = useMemo(() => {
    const sessions = Object.values(state.sessionsByProject).flat()
    return orderFavoriteSessions(sessions, favoriteSessionPaths)
  }, [favoriteSessionPaths, state.sessionsByProject])

  const handleToggleFavorite = useCallback((path: string): void => {
    setFavoriteSessionPaths((current) => current.includes(path)
      ? current.filter((favoritePath) => favoritePath !== path)
      : [...current, path])
  }, [])

  // Resize either side panel with its vertical drag handle.
  const handleResizeStart = useCallback(
    (target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      panelResizeRef.current = {
        target,
        startX: event.clientX,
        startWidth: target === 'sidebar' ? sidebarWidth : reviewWidth
      }
      document.body.classList.add('pion-resizing-panels')
    },
    [reviewWidth, sidebarWidth]
  )

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const resize = panelResizeRef.current
      if (!resize) return
      const delta = event.clientX - resize.startX
      if (resize.target === 'sidebar') {
        setSidebarWidth(clamp(resize.startWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH))
      } else {
        setReviewWidth(clamp(resize.startWidth - delta, MIN_REVIEW_WIDTH, MAX_REVIEW_WIDTH))
      }
    }
    const stopResize = (): void => {
      panelResizeRef.current = null
      document.body.classList.remove('pion-resizing-panels')
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      document.body.classList.remove('pion-resizing-panels')
    }
  }, [])

  // window maximize state (frameless window)
  useEffect(() => {
    if (!hasBridge) return
    const off = window.pion.onWindowState(setMaximized)
    void window.pion.getWindowState().then(setMaximized)
    return off
  }, [hasBridge])

  // Keep the new-session target valid as projects are added/removed. It follows
  // the active project initially, but remains independently selectable.
  useEffect(() => {
    setNewSessionCwd((current) => {
      if (current && state.projects.some((project) => project.cwd === current)) return current
      return state.projects.find((project) => project.cwd === state.status.cwd)?.cwd
        ?? state.projects[0]?.cwd
        ?? ''
    })
  }, [state.projects, state.status.cwd])

  // Keep the user's selected row authoritative while the slower backend
  // switch and its state refreshes complete. Older state responses must not
  // make the sidebar highlight jump back to the previous session.

  // auto-scroll while the conversation grows
  const timelineLength = state.timeline.length
  const lastItem = state.timeline[timelineLength - 1]
  const lastGrow = lastItem
    ? lastItem.kind === 'assistant'
      ? lastItem.text.length
      : lastItem.kind === 'tool'
        ? lastItem.tool.outputText?.length ?? 0
        : 0
    : 0
  const lastItemId = lastItem?.id ?? null
  const previousTimelineHeight = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const previousHeight = previousTimelineHeight.current
    if (state.timelineMutation === 'prepend' && previousHeight > 0) {
      // keep the reading position stable while older history is prepended
      el.scrollTop += el.scrollHeight - previousHeight
    } else if (state.timelineMutation === 'replace') {
      el.scrollTop = el.scrollHeight
    } else if (state.timelineMutation === 'append') {
      // follow the newest message only while the user is already near the
      // bottom; never yank someone away who is reading older history
      const wasNearBottom = previousHeight - el.scrollTop - el.clientHeight <= 80
      if (wasNearBottom || previousHeight === 0) el.scrollTop = el.scrollHeight
    }
    previousTimelineHeight.current = el.scrollHeight
  }, [lastGrow, lastItemId, state.timelineMutation, timelineLength])

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
  }, [])

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
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight <= el.clientHeight + 16) {
      void actions.loadOlder()
      void actions.loadNewer()
    }
    scheduleVisibleHistoryUpdate()
  }, [timelineLength, state.session?.sessionFile, actions, scheduleVisibleHistoryUpdate])

  useEffect(() => {
    setVisibleHistoryEntryId(undefined)
  }, [state.historyIndex?.sessionPath])

  useLayoutEffect(() => {
    const jump = state.historyJump
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
  }, [state.historyJump?.nonce])

  useEffect(() => () => {
    if (historyScrollFrame.current !== null) window.cancelAnimationFrame(historyScrollFrame.current)
    if (historyHighlightTimer.current !== null) window.clearTimeout(historyHighlightTimer.current)
    highlightedHistoryRow.current?.classList.remove('history-jump-target')
  }, [])

  const handleTimelineScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop <= 96) void actions.loadOlder()
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 96) void actions.loadNewer()
    scheduleVisibleHistoryUpdate()
  }, [actions, scheduleVisibleHistoryUpdate])

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
      setNewSessionCwd(cwd)
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

  const handleNewSession = useCallback(
    async (cwd?: string) => {
      if (newSessionInFlight.current) return
      newSessionInFlight.current = true
      try {
        const targetCwd = cwd ?? (newSessionCwd || state.status.cwd)
        sessionSelectionId.current += 1
        setSelectedSession(null)
        if (targetCwd) {
          setNewSessionCwd(targetCwd)
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
    [actions, activateProject, newSessionCwd, state.status.cwd]
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

  const closeBranchDialog = useCallback(() => {
    setBranchDialogCwd(null)
  }, [])

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
      setNewSessionCwd(cwd)
      setSelectedSession({ cwd, path })
      try {
        await activateProject(cwd)
        if (requestId !== sessionSelectionId.current) return
        const result = await actions.switchSession(path)
        if (result.cancelled && requestId === sessionSelectionId.current) {
          setSelectedSession(previousSelection)
          return
        }
      } catch (error) {
        if (requestId === sessionSelectionId.current) setSelectedSession(previousSelection)
        console.error('[pion] 切换会话失败', error)
      }
    },
    [actions, activateProject, selectedSession, state.session?.sessionFile, state.status.cwd]
  )

  const handleDeleteSession = useCallback(
    async (cwd: string, path: string) => {
      if (selectedSession?.path === path) setSelectedSession(null)
      setFavoriteSessionPaths((current) => current.includes(path)
        ? current.filter((favoritePath) => favoritePath !== path)
        : current)
      await activateProject(cwd)
      await actions.deleteSession(path)
    },
    [actions, activateProject, selectedSession?.path]
  )

  const handleCopySession = useCallback(
    async (cwd: string, path: string) => {
      setSelectedSession(null)
      await activateProject(cwd)
      await actions.copySession(path)
    },
    [actions, activateProject]
  )

  const handleGetForkMessages = useCallback(
    async (cwd: string, path: string) => {
      await activateProject(cwd)
      return actions.getSessionForkMessages(path)
    },
    [actions, activateProject]
  )

  const handleForkSession = useCallback(
    async (cwd: string, path: string, entryId: string) => {
      setSelectedSession(null)
      await activateProject(cwd)
      const text = await actions.forkSession(path, entryId)
      if (text) setPrefill(text)
      return text
    },
    [actions, activateProject]
  )

  const sessionChanges = useMemo(() => deriveChanges(state.timeline), [state.timeline])
  const changes = state.runCheckpoint?.state === 'rolled-back' ? [] : sessionChanges
  const messageHistory = useMemo(
    () => state.timeline.flatMap((item) => (
      item.kind === 'user' && item.text.trim() ? [item.text] : []
    )),
    [state.timeline]
  )

  const handleToggleReview = useCallback(() => {
    setReviewOpen((open) => !open)
    setDrawerChange(null)
  }, [])

  useEffect(() => {
    setRollbackError('')
    if (state.runCheckpoint?.state === 'rolled-back') setDrawerChange(null)
  }, [state.runCheckpoint?.id, state.runCheckpoint?.state])

  const handleRollbackRun = useCallback(async (): Promise<void> => {
    const checkpoint = state.runCheckpoint
    if (!checkpoint || checkpoint.state !== 'ready' || !checkpoint.hasChanges || state.busy) return
    const confirmed = window.confirm(
      '确定撤销本轮修改？\n\n工作区将恢复到发送本轮任务之前。发送前已有的暂存、未暂存和未跟踪文件会保留；本轮开始后的手动修改也会一并撤销。'
    )
    if (!confirmed) return
    setRollbackBusy(true)
    setRollbackError('')
    try {
      await actions.rollbackRunCheckpoint()
      setDrawerChange(null)
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error))
    } finally {
      setRollbackBusy(false)
    }
  }, [actions, state.busy, state.runCheckpoint])

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
              onNewSession={() => void handleNewSession(newSessionCwd || undefined)}
              onOpenCapabilities={() => setCapabilitiesOpen(true)}
            />
            <FavoriteSessions
              sessions={favoriteSessions}
              searchQuery={sessionQuery}
              previewDensity={sessionPreviewDensity}
              activePath={activePath}
              favoritePaths={favoritePathSet}
              onToggleFavorite={handleToggleFavorite}
              onSelectSession={(session) => void handleSelectSession(session.projectCwd ?? state.status.cwd ?? '', session.path)}
              onDelete={(session) => handleDeleteSession(session.projectCwd ?? state.status.cwd ?? '', session.path)}
              onCopy={(session) => handleCopySession(session.projectCwd ?? state.status.cwd ?? '', session.path)}
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
              onSelect={(cwd) => void handleSelectProject(cwd)}
              onAdd={() => void handleAddProject()}
              onRemove={(cwd) => void actions.removeProject(cwd)}
              onNewSession={(cwd) => void handleNewSession(cwd)}
              onNewBranch={(cwd) => void handleNewBranch(cwd)}
              onReorder={(cwd, paths) => actions.reorderSessions(cwd, paths)}
              onSelectSession={(cwd, path) => void handleSelectSession(cwd, path)}
              onDelete={handleDeleteSession}
              onCopy={handleCopySession}
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

          <ProjectTrustBanner
            trust={projectTrust}
            busy={projectTrustBusy || state.busy || state.status.phase === 'starting'}
            error={projectTrustError}
            onDecision={(decision) => void handleProjectTrustChange(decision)}
          />

          <div className={`chat-stage${historyNavigatorVisible ? ' has-history-navigator' : ''}`}>
            <HistoryNavigator
              index={state.historyIndex}
              activeEntryId={visibleHistoryEntryId}
              busy={state.timelineLoading || state.busy}
              onJump={(landmark) => void actions.jumpToHistoryLandmark(landmark)}
            />
            <main className="chat-scroll" ref={scrollRef} onScroll={handleTimelineScroll}>
              {state.timeline.length === 0 ? (
                <EmptyState
                  cwd={state.status.cwd}
                  starting={state.status.phase === 'starting'}
                  loadingHistory={state.timelineLoading}
                  hasSessions={state.sessions.length > 1}
                />
              ) : (
                <div className="timeline">
                  {state.timeline.map((item) =>
                    item.kind === 'tool' ? (
                      <ToolCallItem key={item.id} tool={item.tool} />
                    ) : item.kind === 'compaction' ? (
                      <div key={item.id} className="compaction-marker">
                        {item.summary}
                      </div>
                    ) : (
                      <ChatMessage
                        key={item.id}
                        item={item}
                        canFork={state.status.phase !== 'error' && state.status.phase !== 'stopped' && Boolean(state.status.cwd)}
                        onFork={(id) => void handleFork(id)}
                      />
                    )
                  )}
                </div>
              )}
            </main>
          </div>

          <div className="composer-dock">
            <Composer
              busy={state.busy}
              queued={state.queued}
              disabled={!state.status.cwd || state.status.phase === 'starting' || state.status.phase === 'error' || projectTrust?.decision === 'ask'}
              prefill={prefill}
              history={messageHistory}
              commands={state.commands}
              mode={state.mode}
              onModeChange={(mode) => void actions.setMode(mode)}
              projectSelector={
                <ProjectPicker
                  projects={state.projects}
                  value={newSessionCwd}
                  disabled={state.projects.length === 0}
                  onChange={setNewSessionCwd}
                />
              }
              controls={
                <>
                  <ModelPicker
                    compact
                    models={state.models}
                    currentModelId={state.session?.modelId}
                    disabled={state.status.phase !== 'running'}
                    onSelect={(provider, modelId) => void actions.setModel(provider, modelId)}
                  />
                  <ThinkingPicker
                    levels={state.thinkingLevels}
                    current={state.session?.thinkingLevel}
                    disabled={state.status.phase !== 'running'}
                    onSelect={(level) => void actions.setThinkingLevel(level)}
                  />
                </>
              }
              onSend={(text, images) => void actions.send(text, images)}
              onQueue={(text, images) => void actions.queue(text, images)}
              onAbort={() => void actions.abort()}
            />
          </div>
        </div>

        {reviewOpen && (
          <ReviewPanel
            changes={changes}
            selectedChange={drawerChange}
            checkpoint={state.runCheckpoint}
            agentBusy={state.busy}
            rollbackBusy={rollbackBusy}
            rollbackError={rollbackError}
            width={reviewWidth}
            onSelect={setDrawerChange}
            onRollback={() => void handleRollbackRun()}
            onClose={handleToggleReview}
            onResizeStart={(event) => handleResizeStart('review', event)}
          />
        )}
      </div>

      <SkillsToolsModal
        open={capabilitiesOpen}
        onClose={() => setCapabilitiesOpen(false)}
      />
      <PluginStoreModal
        open={pluginStoreOpen}
        onClose={() => setPluginStoreOpen(false)}
      />
      <BranchCreateModal
        open={branchDialogCwd !== null}
        projectName={state.projects.find((project) => project.cwd === branchDialogCwd)?.name ?? '当前项目'}
        projectCwd={branchDialogCwd ?? ''}
        onClose={closeBranchDialog}
        onSubmit={handleCreateBranch}
      />
      <ToolPermissionModal
        request={toolPermissionRequests[0] ?? null}
        queueLength={toolPermissionRequests.length}
        busy={toolPermissionResolveBusy}
        error={toolPermissionResolveError}
        onResolve={(resolution) => void handleToolPermissionResolve(resolution)}
      />
      <SettingsModal
        open={settingsOpen}
        session={state.session}
        models={state.models}
        completionNotificationsEnabled={completionNotificationsEnabled}
        onCompletionNotificationsChange={(enabled) => void handleCompletionNotificationsChange(enabled)}
        sessionPreviewDensity={sessionPreviewDensity}
        onSessionPreviewDensityChange={handleSessionPreviewDensityChange}
        projectTrust={projectTrust}
        projectTrustBusy={projectTrustBusy || state.busy || state.status.phase === 'starting'}
        projectTrustError={projectTrustError}
        onProjectTrustChange={(decision) => void handleProjectTrustChange(decision)}
        toolPermissionPolicy={toolPermissionPolicy}
        toolPermissionBusy={toolPermissionBusy}
        toolPermissionError={toolPermissionError}
        onToolPermissionChange={(category, decision) => void handleToolPermissionChange(category, decision)}
        onToolPermissionReset={() => void handleToolPermissionReset()}
        onClose={() => setSettingsOpen(false)}
        actions={{
          setModel: actions.setModel,
          setAutoCompaction: actions.setAutoCompaction,
          setAutoRetry: actions.setAutoRetry,
          compactNow: actions.compactNow,
          exportSessionHtml: actions.exportHtml,
          renameSession: actions.renameSession,
          setSteeringMode: actions.setSteeringMode,
          setFollowUpMode: actions.setFollowUpMode
        }}
      />
      <ChangesDrawer
        change={reviewOpen ? null : drawerChange}
        onClose={() => setDrawerChange(null)}
      />
    </div>
  )
}

function EmptyState({
  cwd,
  starting,
  loadingHistory,
  hasSessions
}: {
  cwd?: string
  starting: boolean
  loadingHistory: boolean
  hasSessions: boolean
}): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Sparkles size={40} />
      </div>
      <h2>{loadingHistory ? '正在加载会话…' : starting ? '正在启动 agent…' : 'Pion 已就绪'}</h2>
      <p>
        {cwd ? (
          <>
            工作目录 <code>{cwd}</code>
            {loadingHistory
              ? '。正在直接读取会话历史，无需等待 Agent 后台启动。'
              : hasSessions
                ? '。左侧选择历史会话继续，或直接开始新对话。'
                : '。发送一条消息开始。'}
          </>
        ) : (
          '点击左上角「+」添加项目目录'
        )}
      </p>
      <div className="empty-tips">
        <span>
          <FolderOpen size={11} /> 侧栏管理项目
        </span>
        <span>Enter 发送</span>
        <span>↑↓ 编辑历史</span>
        <span>消息可分叉</span>
        <span>设置 ⚙ 调整行为</span>
      </div>
    </div>
  )
}
