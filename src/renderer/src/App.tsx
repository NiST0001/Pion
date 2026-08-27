import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { TimelineItem } from './hooks/useAgent'
import { useAgent } from './hooks/useAgent'
import { ChatMessage } from './components/ChatMessage'
import { ToolCallItem } from './components/ToolCallItem'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'

export function App(): ReactElement {
  const { state, actions, hasBridge } = useAgent()
  const [workspace, setWorkspace] = useState<string>('')
  const [bootstrapped, setBootstrapped] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // default workspace on first launch, then auto-start the agent
  useEffect(() => {
    if (!hasBridge || bootstrapped) return
    setBootstrapped(true)
    void window.pion.getState().then(async (info) => {
      if (info) return
      const stored = window.sessionStorage.getItem('pion:workspace')
      const cwd = stored ?? (await window.pion.defaultWorkspace())
      if (cwd) {
        setWorkspace(cwd)
        await actions.start(cwd)
      }
    })
  }, [hasBridge, bootstrapped, actions])

  // remember the workspace across reloads (HMR friendly)
  useEffect(() => {
    if (workspace) window.sessionStorage.setItem('pion:workspace', workspace)
  }, [workspace])

  // auto-scroll while the conversation grows
  const timelineLength = state.timeline.length
  const lastText = (() => {
    const last = state.timeline[timelineLength - 1]
    return last && last.kind === 'assistant' ? last.text.length : 0
  })()
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [timelineLength, lastText])

  const chooseWorkspace = async (): Promise<void> => {
    const cwd = await actions.pickWorkspace()
    if (!cwd) return
    setWorkspace(cwd)
    await actions.start(cwd)
  }

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
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">π</span>
          <span className="brand-name">Pion</span>
        </div>
        <div className="header-meta">
          {state.session?.model && (
            <span className="chip" title={state.session.provider}>
              {state.session.model}
            </span>
          )}
          {state.session?.thinkingLevel && (
            <span className="chip chip-dim">{state.session.thinkingLevel}</span>
          )}
          <span className={`dot dot-${state.status.phase}`} title={state.status.phase} />
          <button className="ghost-button" onClick={() => void chooseWorkspace()} title={workspace}>
            {workspace ? `📁 ${shorten(workspace)}` : '📁 选择目录'}
          </button>
        </div>
      </header>

      {state.status.phase === 'error' && (
        <div className="banner banner-error">
          <span>agent 启动失败：{state.status.error}</span>
        </div>
      )}

      <main className="chat-scroll" ref={scrollRef}>
        {state.timeline.length === 0 ? (
          <EmptyState workspace={workspace} />
        ) : (
          <div className="timeline">
            {state.timeline.map((item) => (
              <TimelineRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </main>

      <Composer
        busy={state.busy}
        queued={state.queued}
        disabled={state.status.phase !== 'running'}
        onSend={(text) => void actions.send(text)}
        onAbort={() => void actions.abort()}
      />
      <StatusBar status={state.status} session={state.session} />
    </div>
  )
}

function TimelineRow({ item }: { item: TimelineItem }): ReactElement {
  if (item.kind === 'tool') return <ToolCallItem tool={item.tool} />
  return <ChatMessage item={item} />
}

function EmptyState({ workspace }: { workspace: string }): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-mark">π⁺</div>
      <h2>Pion 已就绪</h2>
      <p>
        {workspace
          ? `工作目录：${workspace}。发送一条消息开始对话。`
          : '点击右上角「选择目录」设定工作目录后开始对话。'}
      </p>
    </div>
  )
}

function shorten(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 3) return path
  return `…/${parts.slice(-2).join('/')}`
}
