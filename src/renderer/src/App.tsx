import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { FolderOpen, Settings, Sparkles, Store } from 'lucide-react'
import { useAgent, deriveChanges } from './hooks/useAgent'
import type { FileChange } from './hooks/useAgent'
import { ChatMessage } from './components/ChatMessage'
import { ToolCallItem } from './components/ToolCallItem'
import { Composer } from './components/Composer'
import { TaskPanel } from './components/TaskPanel'
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
  const [maximized, setMaximized] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(276)
  const [reviewWidth, setReviewWidth] = useState(390)
  const [sessionQuery, setSessionQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelResizeRef = useRef<PanelResizeState | null>(null)

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
      el.scrollTop += el.scrollHeight - previousHeight
    } else if (state.timelineMutation !== null) {
      el.scrollTop = el.scrollHeight
    }
    previousTimelineHeight.current = el.scrollHeight
  }, [lastGrow, lastItemId, state.timelineMutation, timelineLength])

  const handleFork = useCallback(
    async (entryId: string) => {
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
      if (cwd) await activateProject(cwd)
      await actions.newSession()
    },
    [actions, activateProject]
  )

  const handleNewBranch = useCallback(
    async (cwd: string) => {
      const name = window.prompt('新建 Git 分支', 'feature/new-branch')?.trim()
      if (!name) return
      try {
        await actions.createBranch(cwd, name)
      } catch (err) {
        window.alert(`创建分支失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [actions]
  )

  const handleSelectSession = useCallback(
    async (cwd: string, path: string) => {
      await activateProject(cwd)
      await actions.switchSession(path)
    },
    [actions, activateProject]
  )

  const handleDeleteSession = useCallback(
    async (cwd: string, path: string) => {
      await activateProject(cwd)
      await actions.deleteSession(path)
    },
    [actions, activateProject]
  )

  const handleCopySession = useCallback(
    async (cwd: string, path: string) => {
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
      await activateProject(cwd)
      const text = await actions.forkSession(path, entryId)
      if (text) setPrefill(text)
      return text
    },
    [actions, activateProject]
  )

  const changes = useMemo(() => deriveChanges(state.timeline), [state.timeline])
  const taskSessionKey = state.session?.sessionFile || state.session?.sessionId || state.status.cwd || 'default'
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
              searchQuery={sessionQuery}
              onSearch={setSessionQuery}
              onNewSession={() => void handleNewSession()}
              onOpenCapabilities={() => setCapabilitiesOpen(true)}
            />
            <ProjectList
              projects={state.projects}
              sessionsByProject={state.sessionsByProject}
              branchesByProject={state.branchesByProject}
              searchQuery={sessionQuery}
              activeCwd={state.status.cwd}
              activePath={state.session?.sessionFile}
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

          <main className="chat-scroll" ref={scrollRef}>
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
                      canFork={state.status.phase === 'running'}
                      onFork={(id) => void handleFork(id)}
                    />
                  )
                )}
              </div>
            )}
          </main>

          <div className="composer-dock">
            <TaskPanel key={taskSessionKey} sessionKey={taskSessionKey} />
            <Composer
              busy={state.busy}
              queued={state.queued}
              disabled={state.status.phase !== 'running'}
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
                    onSelect={(provider, modelId) => void actions.setModel(provider, modelId)}
                  />
                  <ThinkingPicker
                    levels={state.thinkingLevels}
                    current={state.session?.thinkingLevel}
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
