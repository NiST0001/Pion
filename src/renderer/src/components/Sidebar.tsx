import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  Folder,
  FolderPlus,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  Search,
  Sparkles,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  ForkMessageOption,
  ProjectMeta,
  SessionMeta,
  TreeNodeLite
} from '../../../shared/types'
import type { FileChange } from '../hooks/useAgent'

// ---------------------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------------------

function Section({
  title,
  count,
  action,
  children,
  defaultOpen = true
}: {
  title: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="side-section">
      <div className="side-section-head">
        <button className="side-section-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="side-section-title">{title}</span>
          {count !== undefined && count > 0 && <span className="side-count">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="side-section-body">{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

export function SidebarToolbar({
  searchQuery,
  onSearch,
  onNewSession
}: {
  searchQuery: string
  onSearch: (value: string) => void
  onNewSession: () => void
}): ReactElement {
  const [toolsOpen, setToolsOpen] = useState(false)

  return (
    <div className="sidebar-toolbar">
      <div className="sidebar-quick-actions">
        <button
          type="button"
          className="sidebar-new-session"
          onClick={onNewSession}
          title="新建会话"
        >
          <MessageSquarePlus size={15} />
          <span>新建会话</span>
        </button>
        <button
          type="button"
          className={`sidebar-tools-button${toolsOpen ? ' active' : ''}`}
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((open) => !open)}
          title="技能与工具"
        >
          <Wrench size={14} />
          <span>技能与工具</span>
          <ChevronDown size={13} className="sidebar-tools-chevron" />
        </button>
      </div>

      {toolsOpen && (
        <div className="sidebar-tools-panel" role="region" aria-label="技能与工具">
          <div className="sidebar-tools-panel-head">
            <Sparkles size={13} />
            <span>当前工作区能力</span>
          </div>
          <div className="sidebar-tool-row">
            <FileDiff size={13} />
            <span>
              <strong>文件与终端</strong>
              <small>读取、编辑文件和运行命令</small>
            </span>
          </div>
          <div className="sidebar-tool-row">
            <GitBranch size={13} />
            <span>
              <strong>会话工作流</strong>
              <small>分支、压缩和导出会话</small>
            </span>
          </div>
        </div>
      )}

      <label className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={searchQuery}
          aria-label="搜索会话"
          placeholder="搜索会话"
          onChange={(event) => onSearch(event.target.value)}
        />
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function ProjectList({
  projects,
  sessionsByProject,
  searchQuery,
  activeCwd,
  activePath,
  onSelect,
  onAdd,
  onRemove,
  onNewSession,
  onSelectSession,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  projects: ProjectMeta[]
  sessionsByProject: Record<string, SessionMeta[]>
  searchQuery: string
  activeCwd?: string
  activePath?: string
  onSelect: (cwd: string) => void
  onAdd: () => void
  onRemove: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
}): ReactElement {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const visibleProjects = projects
    .map((project) => {
      const sessions = sessionsByProject[project.cwd] ?? []
      const visibleSessions = normalizedQuery
        ? sessions.filter((session) => sessionMatchesQuery(session, normalizedQuery))
        : sessions
      return { project, sessions: visibleSessions }
    })
    .filter(({ sessions }) => !normalizedQuery || sessions.length > 0)

  return (
    <Section
      title="项目"
      count={projects.length}
      action={
        <button className="icon-button" title="添加项目目录" onClick={onAdd}>
          <FolderPlus size={14} />
        </button>
      }
    >
      {visibleProjects.length === 0 && (
        <div className="side-empty">{normalizedQuery ? '没有匹配的会话' : '暂无项目'}</div>
      )}
      {visibleProjects.map(({ project, sessions }) => (
        <ProjectFolder
          key={project.cwd}
          project={project}
          sessions={sessions}
          activeCwd={activeCwd}
          activePath={activePath}
          searchActive={Boolean(normalizedQuery)}
          canRemove={projects.length > 1}
          onSelect={onSelect}
          onRemove={onRemove}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onDelete={onDelete}
          onCopy={onCopy}
          getForkMessages={getForkMessages}
          onFork={onFork}
        />
      ))}
    </Section>
  )
}

function ProjectBranch({
  projectCwd,
  sessions,
  activePath,
  onNewSession,
  onSelectSession,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  projectCwd: string
  sessions: SessionMeta[]
  activePath?: string
  onNewSession: (cwd: string) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
}): ReactElement {
  const [open, setOpen] = useState(true)

  return (
    <div className="project-branch">
      <div
        className="project-branch-head"
        title="main · Pion 会话分组，不会创建 Git worktree"
      >
        <button
          type="button"
          className="project-branch-toggle"
          aria-expanded={open}
          aria-label={open ? '收起 main 分支' : '展开 main 分支'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <GitBranch size={13} className="project-branch-icon" />
        <span className="project-branch-name">main</span>
        <span className="project-branch-count">{sessions.length}</span>
        <button
          type="button"
          className="project-branch-new"
          title="在 main 分支中新建会话"
          onClick={() => onNewSession(projectCwd)}
        >
          <MessageSquarePlus size={13} />
        </button>
      </div>
      {open && (
        <div className="project-branch-sessions">
          {sessions.length === 0 ? (
            <div className="project-folder-empty">暂无会话</div>
          ) : (
            <SessionItems
              sessions={sessions}
              activePath={activePath}
              onSelect={(path) => onSelectSession(projectCwd, path)}
              onDelete={(path) => onDelete(projectCwd, path)}
              onCopy={(path) => onCopy(projectCwd, path)}
              getForkMessages={(path) => getForkMessages(projectCwd, path)}
              onFork={(path, entryId) => onFork(projectCwd, path, entryId)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ProjectFolder({
  project,
  sessions,
  activeCwd,
  activePath,
  searchActive,
  canRemove,
  onSelect,
  onRemove,
  onNewSession,
  onSelectSession,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  project: ProjectMeta
  sessions: SessionMeta[]
  activeCwd?: string
  activePath?: string
  searchActive: boolean
  canRemove: boolean
  onSelect: (cwd: string) => void
  onRemove: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
}): ReactElement {
  const [open, setOpen] = useState(true)
  const expanded = open || searchActive

  return (
    <div className={`project-folder${project.cwd === activeCwd ? ' active' : ''}`}>
      <div
        className="project-folder-head"
        onClick={() => onSelect(project.cwd)}
        title={project.cwd}
      >
        <button
          type="button"
          className="project-folder-toggle"
          aria-label={expanded ? '收起项目会话' : '展开项目会话'}
          onClick={(event) => {
            event.stopPropagation()
            setOpen((value) => !value)
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <Folder size={14} className="project-folder-icon" />
        <span className="project-folder-name">{project.name}</span>
        <span className="project-folder-count">1</span>
        {canRemove && (
          <button
            type="button"
            className="project-folder-remove"
            title="从列表移除"
            onClick={(event) => {
              event.stopPropagation()
              onRemove(project.cwd)
            }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="project-folder-branches">
          <ProjectBranch
            projectCwd={project.cwd}
            sessions={sessions}
            activePath={activePath}
            onNewSession={onNewSession}
            onSelectSession={onSelectSession}
            onDelete={onDelete}
            onCopy={onCopy}
            getForkMessages={getForkMessages}
            onFork={onFork}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function formatTime(mtime: number): string {
  const date = new Date(mtime)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function sessionMatchesQuery(session: SessionMeta, query: string): boolean {
  const haystack = [session.name, session.preview, session.path]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
  return haystack.includes(query)
}

interface SessionItemActions {
  activePath?: string
  onSelect: (path: string) => void
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
}

function SessionItems({
  sessions,
  activePath,
  onSelect,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: { sessions: SessionMeta[] } & SessionItemActions): ReactElement {
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null)

  useEffect(() => {
    if (contextMenu && !sessions.some((session) => session.path === contextMenu.session.path)) {
      setContextMenu(null)
    }
  }, [sessions, contextMenu])

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>, session: SessionMeta): void => {
    event.preventDefault()
    event.stopPropagation()
    const width = 246
    const height = 340
    setContextMenu({
      session,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - width)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - height))
    })
  }

  return (
    <>
      {sessions.map((session) => (
        <div
          key={session.path}
          className={`side-item side-session${session.path === activePath ? ' active' : ''}`}
          onClick={() => {
            setContextMenu(null)
            onSelect(session.path)
          }}
          onContextMenu={(event) => openContextMenu(event, session)}
          title={`${session.path}\n右键查看更多操作`}
        >
          <div className="side-session-main">
            <span className="side-item-label">
              {session.name || session.preview || '未命名会话'}
            </span>
            <span className="side-session-meta">
              {formatTime(session.mtime)} · {session.messageCount} 条消息
            </span>
          </div>
        </div>
      ))}
      {contextMenu && createPortal(
        <SessionContextMenu
          session={contextMenu.session}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={onDelete}
          onCopy={onCopy}
          getForkMessages={getForkMessages}
          onFork={onFork}
        />,
        document.body
      )}
    </>
  )
}

export function SessionList({
  sessions,
  searchQuery,
  activePath,
  onSelect,
  onNew,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  sessions: SessionMeta[]
  searchQuery: string
  activePath?: string
  onSelect: (path: string) => void
  onNew: () => void
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
}): ReactElement {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const visibleSessions = normalizedQuery
    ? sessions.filter((session) => sessionMatchesQuery(session, normalizedQuery))
    : sessions

  return (
    <Section
      title="会话"
      count={normalizedQuery ? visibleSessions.length : sessions.length}
      action={
        <button className="icon-button" title="新建会话" onClick={onNew}>
          <MessageSquarePlus size={14} />
        </button>
      }
    >
      {visibleSessions.length === 0 && (
        <div className="side-empty">{normalizedQuery ? '没有匹配的会话' : '暂无会话'}</div>
      )}
      <SessionItems
        sessions={visibleSessions}
        activePath={activePath}
        onSelect={onSelect}
        onDelete={onDelete}
        onCopy={onCopy}
        getForkMessages={getForkMessages}
        onFork={onFork}
      />
    </Section>
  )
}

interface SessionContextMenuState {
  session: SessionMeta
  x: number
  y: number
}

function SessionContextMenu({
  session,
  x,
  y,
  onClose,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: SessionContextMenuState & {
  onClose: () => void
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [forkMessages, setForkMessages] = useState<ForkMessageOption[] | null>(null)
  const [loadingForks, setLoadingForks] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const handleResize = (): void => onClose()
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [onClose])

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const loadForkMessages = async (): Promise<void> => {
    if (busy || loadingForks) return
    if (forkMessages !== null) {
      setBranchOpen((open) => !open)
      return
    }
    setBranchOpen(true)
    setLoadingForks(true)
    setError('')
    try {
      setForkMessages(await getForkMessages(session.path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingForks(false)
    }
  }

  const title = session.name || session.preview || '未命名会话'

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="context-menu-header" title={session.path}>
        <span>{title}</span>
        <small>{session.messageCount} 条消息</small>
      </div>
      <div className="context-menu-divider" />
      <button
        className="context-menu-item"
        disabled={busy}
        onClick={() => void runAction(() => onCopy(session.path))}
      >
        <Copy size={14} />
        <span>从会话复制</span>
      </button>
      <button
        className={`context-menu-item${branchOpen ? ' active' : ''}`}
        disabled={busy}
        aria-expanded={branchOpen}
        onClick={() => void loadForkMessages()}
      >
        <GitBranch size={14} />
        <span>从会话分支</span>
        {loadingForks ? <Loader2 size={13} className="spin" /> : <ChevronRight size={13} />}
      </button>
      {branchOpen && (
        <div className="context-submenu">
          {forkMessages === null && loadingForks && (
            <div className="context-menu-empty"><Loader2 size={13} className="spin" /> 正在读取分支点…</div>
          )}
          {forkMessages?.length === 0 && (
            <div className="context-menu-empty">没有可用的用户消息</div>
          )}
          {forkMessages?.map((message, index) => (
            <button
              key={message.entryId}
              className="context-fork-item"
              disabled={busy}
              title={message.text}
              onClick={() => void runAction(() => onFork(session.path, message.entryId))}
            >
              <span className="context-fork-index">{index + 1}</span>
              <span>{message.text.replace(/\s+/g, ' ').slice(0, 110)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="context-menu-divider" />
      <button
        className="context-menu-item context-menu-danger"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`确定删除会话“${title}”？此操作不可撤销。`)) {
            void runAction(() => onDelete(session.path))
          }
        }}
      >
        <Trash2 size={14} />
        <span>删除会话</span>
      </button>
      {error && <div className="context-menu-error">{error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branch tree
// ---------------------------------------------------------------------------

function TreeRow({
  node,
  leafId,
  depth,
  onFork
}: {
  node: TreeNodeLite
  leafId: string | null
  depth: number
  onFork: (entryId: string) => void
}): ReactElement {
  const isLeaf = node.id === leafId
  const forkable = node.kind === 'user'
  return (
    <div className="tree-row-wrap">
      <div
        className={`tree-row tree-${node.kind}${isLeaf ? ' tree-current' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        {node.children.length > 0 ? (
          <GitBranch size={12} className="tree-icon" />
        ) : (
          <span className="tree-dot" />
        )}
        <span className="tree-snippet" title={node.snippet}>
          {node.snippet}
        </span>
        {isLeaf && <span className="tree-badge">当前</span>}
        {forkable && !isLeaf && (
          <button
            className="tree-fork"
            title="从此处分叉"
            onClick={() => onFork(node.id)}
          >
            <GitBranch size={11} />
          </button>
        )}
      </div>
      {node.children.map((child, i) => (
        <TreeRow key={`${child.id}-${i}`} node={child} leafId={leafId} depth={depth + 1} onFork={onFork} />
      ))}
    </div>
  )
}

export function BranchTree({
  tree,
  leafId,
  onFork
}: {
  tree: TreeNodeLite[] | null
  leafId: string | null
  onFork: (entryId: string) => void
}): ReactElement | null {
  if (!tree || tree.length === 0) return null
  return (
    <Section title="分支" defaultOpen={false}>
      <div className="tree">
        {tree.map((node, i) => (
          <TreeRow key={`${node.id}-${i}`} node={node} leafId={leafId} depth={0} onFork={onFork} />
        ))}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export function ChangeList({
  changes,
  onSelect
}: {
  changes: FileChange[]
  onSelect: (change: FileChange) => void
}): ReactElement {
  return (
    <Section title="变更" count={changes.length}>
      {changes.length === 0 && <div className="side-empty">本会话暂无文件改动</div>}
      {changes.map((change) => (
        <div
          key={change.path}
          className="side-item side-change"
          onClick={() => onSelect(change)}
          title={change.path}
        >
          <FileDiff size={14} className="side-item-icon" />
          <span className="side-item-label">{shortPath(change.path)}</span>
          <span className="tool-stats">
            <span className="stat-add">+{change.additions}</span>
            <span className="stat-del">−{change.deletions}</span>
          </span>
        </div>
      ))}
    </Section>
  )
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}
