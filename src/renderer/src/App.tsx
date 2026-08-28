import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { FolderOpen, Settings, Sparkles } from 'lucide-react'
import { useAgent, deriveChanges } from './hooks/useAgent'
import type { FileChange } from './hooks/useAgent'
import { ChatMessage } from './components/ChatMessage'
import { ToolCallItem } from './components/ToolCallItem'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import { ProjectList, SessionList, BranchTree, ChangeList } from './components/Sidebar'
import { ChangesDrawer } from './components/ChangesDrawer'
import { ReviewPanel } from './components/ReviewPanel'
import { ModelPicker, ThinkingPicker } from './components/ModelPicker'
import { TitleBar } from './components/TitleBar'
import { SettingsModal } from './components/SettingsModal'

export function App(): ReactElement {
  const { state, actions, hasBridge } = useAgent()
  const [prefill, setPrefill] = useState('')
  const [drawerChange, setDrawerChange] = useState<FileChange | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // bootstrap: pick the most recent project (or home) and start the agent
  useEffect(() => {
    if (!hasBridge) return
    void actions.bootstrap()
  }, [hasBridge, actions])

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
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [timelineLength, lastGrow])

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

  const changes = useMemo(() => deriveChanges(state.timeline), [state.timeline])

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
        reviewOpen={reviewOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleReview={handleToggleReview}
      />

      <div className="app-body">
        {sidebarOpen && <aside className="sidebar">
          <div className="sidebar-scroll">
            <ProjectList
              projects={state.projects}
              activeCwd={state.status.cwd}
              onSelect={(cwd) => void handleSelectProject(cwd)}
              onAdd={() => void handleAddProject()}
              onRemove={(cwd) => void actions.removeProject(cwd)}
            />
            <SessionList
              sessions={state.sessions}
              activePath={state.session?.sessionFile}
              onSelect={(path) => void actions.switchSession(path)}
              onNew={() => void actions.newSession()}
              onDelete={(path) => actions.deleteSession(path)}
              onCopy={(path) => actions.copySession(path)}
              getForkMessages={(path) => actions.getSessionForkMessages(path)}
              onFork={async (path, entryId) => {
                const text = await actions.forkSession(path, entryId)
                if (text) setPrefill(text)
                return text
              }}
            />
            <BranchTree
              tree={state.tree?.tree ?? null}
              leafId={state.tree?.leafId ?? null}
              onFork={(id) => void handleFork(id)}
            />
            <ChangeList changes={changes} onSelect={(change) => setDrawerChange(change)} />
          </div>
          <div className="sidebar-footer">
            <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
              <Settings size={14} />
              <span>设置</span>
            </button>
          </div>
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
                    <ToolCallItem key={item.id} tool={item.tool} />
                  ) : item.kind === 'compaction' ? (
                    <div key={item.id} className="compaction-marker">
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

          <Composer
            busy={state.busy}
            queued={state.queued}
            disabled={state.status.phase !== 'running'}
            prefill={prefill}
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
            onAbort={() => void actions.abort()}
          />
          <StatusBar status={state.status} session={state.session} />
        </div>

        {reviewOpen && (
          <ReviewPanel
            changes={changes}
            selectedChange={drawerChange}
            onSelect={setDrawerChange}
            onClose={handleToggleReview}
          />
        )}
      </div>

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
        <span>消息可分叉</span>
        <span>设置 ⚙ 调整行为</span>
      </div>
    </div>
  )
}
