import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  Folder,
  FolderPlus,
  GitBranch,
  MessageSquarePlus,
  Trash2
} from 'lucide-react'
import type { ProjectMeta, SessionMeta, TreeNodeLite } from '../../../shared/types'
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
// Projects
// ---------------------------------------------------------------------------

export function ProjectList({
  projects,
  activeCwd,
  onSelect,
  onAdd,
  onRemove
}: {
  projects: ProjectMeta[]
  activeCwd?: string
  onSelect: (cwd: string) => void
  onAdd: () => void
  onRemove: (cwd: string) => void
}): ReactElement {
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
      {projects.map((project) => (
        <div
          key={project.cwd}
          className={`side-item${project.cwd === activeCwd ? ' active' : ''}`}
          onClick={() => onSelect(project.cwd)}
          title={project.cwd}
        >
          <Folder size={14} className="side-item-icon" />
          <span className="side-item-label">{project.name}</span>
          {projects.length > 1 && (
            <button
              className="side-item-remove"
              title="从列表移除"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(project.cwd)
              }}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ))}
    </Section>
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

export function SessionList({
  sessions,
  activePath,
  onSelect,
  onNew
}: {
  sessions: SessionMeta[]
  activePath?: string
  onSelect: (path: string) => void
  onNew: () => void
}): ReactElement {
  return (
    <Section
      title="会话"
      count={sessions.length}
      action={
        <button className="icon-button" title="新建会话" onClick={onNew}>
          <MessageSquarePlus size={14} />
        </button>
      }
    >
      {sessions.length === 0 && <div className="side-empty">暂无会话</div>}
      {sessions.map((session) => (
        <div
          key={session.path}
          className={`side-item side-session${session.path === activePath ? ' active' : ''}`}
          onClick={() => onSelect(session.path)}
          title={session.path}
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
    </Section>
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
