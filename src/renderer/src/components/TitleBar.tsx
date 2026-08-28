import type { ReactElement } from 'react'
import {
  Maximize2,
  Minimize2,
  Minus,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  X
} from 'lucide-react'
import type { AgentPhase } from '../../../shared/types'

interface TitleBarProps {
  cwd?: string
  phase: AgentPhase
  sessionName?: string
  maximized: boolean
  sidebarOpen: boolean
  sidebarWidth: number
  reviewOpen: boolean
  onToggleSidebar: () => void
  onToggleReview: () => void
}

export function TitleBar({
  cwd,
  phase,
  sessionName,
  maximized,
  sidebarOpen,
  sidebarWidth,
  reviewOpen,
  onToggleSidebar,
  onToggleReview
}: TitleBarProps): ReactElement {
  const title = [shorten(cwd ?? ''), sessionName].filter(Boolean).join(' · ')
  return (
    <header className="titlebar">
      <div className="titlebar-brand" style={{ width: sidebarWidth }}>
        <button
          type="button"
          className="titlebar-panel-btn"
          title={sidebarOpen ? '关闭会话栏' : '打开会话栏'}
          aria-label={sidebarOpen ? '关闭会话栏' : '打开会话栏'}
          onClick={onToggleSidebar}
        >
          {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
        </button>
        <span className="brand-mark">π⁺</span>
        <span className="brand-name">Pion</span>
        <span className={`dot dot-${phase}`} title={phase} />
      </div>
      <div className="titlebar-path" title={cwd}>
        {title || 'Pion'}
      </div>
      <div className="titlebar-right">
        <button
          type="button"
          className={`titlebar-btn titlebar-review-btn${reviewOpen ? ' active' : ''}`}
          title={reviewOpen ? '关闭文件与审查栏' : '打开文件与审查栏'}
          aria-label={reviewOpen ? '关闭文件与审查栏' : '打开文件与审查栏'}
          onClick={onToggleReview}
        >
          {reviewOpen ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
        </button>
        <span className="titlebar-sep" />
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          onClick={() => window.pion.minimizeWindow()}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? '还原' : '最大化'}
          onClick={() => window.pion.toggleMaximizeWindow()}
        >
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={11} />}
        </button>
        <button type="button" className="titlebar-btn titlebar-close" title="关闭" onClick={() => window.pion.closeWindow()}>
          <X size={15} />
        </button>
      </div>
    </header>
  )
}

function shorten(path: string): string {
  if (!path) return ''
  const parts = path.replace(/^\/home\/[^/]+/, '~').split('/')
  if (parts.length <= 3) return parts.join('/')
  return `…/${parts.slice(-2).join('/')}`
}
