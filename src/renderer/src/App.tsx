import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { FolderOpen, Settings, Sparkles, Store } from 'lucide-react'
import { useAgent } from './hooks/useAgent'
import { deriveChanges } from './agent/timeline'
import type { FileChange } from './agent/types'
import { ChatMessage } from './components/ChatMessage'
import { ToolCallItem } from './components/ToolCallItem'
import { Composer } from './components/Composer'
import { BranchCreateModal } from './components/BranchCreateModal'
import { ProjectList, SidebarToolbar } from './components/Sidebar'
import { ChangesDrawer } from './components/ChangesDrawer'
import { ReviewPanel } from './components/ReviewPanel'
import { ModelPicker, ThinkingPicker } from './components/ModelPicker'
import { TitleBar } from './components/TitleBar'
import { SettingsModal } from './components/SettingsModal'
import { SkillsToolsModal } from './components/SkillsToolsModal'
import { PluginStoreModal } from './components/PluginStoreModal'

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
  const [branchDialogCwd, setBranchDialogCwd] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(276)
  const [reviewWidth, setReviewWidth] = useState(390)
  const [sessionQuery, setSessionQuery] = useState('')
  const [newSessionCwd, setNewSessionCwd] = useState('')
  const [selectedSession, setSelectedSession] = useState<{ cwd: string; path: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelResizeRef = useRef<PanelResizeState | null>(null)
  const sessionSelectionId = useRef(0)

  // bootstrap: pick the most recent project (or home) and start the agent
  useEffect(() => {
    if (!hasBridge) return
    void actions.bootstrap()
  }, [hasBridge, actions])

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

  // The newest-window load may fit entirely inside the viewport, leaving the
  // container without a scrollbar (and therefore without scroll events). Keep
  // pulling older history until the timeline can actually scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight <= el.clientHeight + 16) void actions.loadOlder()
  }, [timelineLength, state.session?.sessionFile, actions])

  const handleTimelineScroll = useCallback(() => {
    const el = scrollRef.current
    if (el && el.scrollTop <= 96) void actions.loadOlder()
  }, [actions])

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
      const targetCwd = cwd ?? (newSessionCwd || state.status.cwd)
      sessionSelectionId.current += 1
      setSelectedSession(null)
      if (targetCwd) {
        setNewSessionCwd(targetCwd)
        await activateProject(targetCwd)
      }
      await actions.newSession()
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

  const changes = useMemo(() => deriveChanges(state.timeline), [state.timeline])
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

  const activeCwd = selectedSession?.cwd ?? state.status.cwd
  const activePath = selectedSession?.path ?? state.session?.sessionFile

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
        phase={state.status.phase}
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
              projects={state.projects}
              newSessionCwd={newSessionCwd}
              searchQuery={sessionQuery}
              onSearch={setSessionQuery}
              onNewSession={() => void handleNewSession(newSessionCwd || undefined)}
              onNewSessionProjectChange={setNewSessionCwd}
              onOpenCapabilities={() => setCapabilitiesOpen(true)}
            />
            <ProjectList
              projects={state.projects}
              sessionsByProject={state.sessionsByProject}
              branchesByProject={state.branchesByProject}
              searchQuery={sessionQuery}
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

          <main className="chat-scroll" ref={scrollRef} onScroll={handleTimelineScroll}>
            {state.timeline.length === 0 ? (
              <EmptyState
                cwd={state.status.cwd}
                starting={state.status.phase === 'starting'}
                hasSessions={state.sessions.length > 1}
              />
            ) : (
              <div className="timeline">
                {state.timeline.map((item) =>
                  item.kind === 'tool' ? (
                    <ToolCallItem key={item.id} tool={item.tool} historical={item.historical} />
                  ) : item.kind === 'compaction' ? (
                    <div key={item.id} className={`compaction-marker${item.historical ? ' history-reveal' : ''}`}>
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

          <div className="composer-dock">
            <Composer
              busy={state.busy}
              queued={state.queued}
              disabled={!state.status.cwd || state.status.phase === 'starting' || state.status.phase === 'error'}
              prefill={prefill}
              history={messageHistory}
              commands={state.commands}
              mode={state.mode}
              onModeChange={(mode) => void actions.setMode(mode)}
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
              onSend={(text) => void actions.send(text)}
              onQueue={(text) => void actions.queue(text)}
              onAbort={() => void actions.abort()}
            />
          </div>
        </div>

        {reviewOpen && (
          <ReviewPanel
            changes={changes}
            selectedChange={drawerChange}
            width={reviewWidth}
            onSelect={setDrawerChange}
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
      <SettingsModal
        open={settingsOpen}
        session={state.session}
        models={state.models}
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
  hasSessions
}: {
  cwd?: string
  starting: boolean
  hasSessions: boolean
}): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Sparkles size={40} />
      </div>
      <h2>{starting ? '正在启动 agent…' : 'Pion 已就绪'}</h2>
      <p>
        {cwd ? (
          <>
            工作目录 <code>{cwd}</code>
            {hasSessions ? '。左侧选择历史会话继续，或直接开始新对话。' : '。发送一条消息开始。'}
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
