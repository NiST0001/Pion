import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  GitBranch,
  MessageSquarePlus,
  Search,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  BranchInfo,
  ForkMessageOption,
  ProjectMeta,
  SessionMeta
} from '../../../shared/types'
import { SessionItems, sessionMatchesQuery } from './SessionList'
import type { SessionPreviewDensity } from '../utils/sessionPreview'

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
  onNewSession,
  onOpenCapabilities
}: {
  searchQuery: string
  onSearch: (value: string) => void
  onNewSession: () => void
  onOpenCapabilities: () => void
}): ReactElement {
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
          className="sidebar-tools-button"
          onClick={onOpenCapabilities}
          title="打开技能与工具"
        >
          <Wrench size={14} />
          <span>技能与工具</span>
          <ChevronRight size={13} className="sidebar-tools-arrow" />
        </button>
      </div>

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

interface ProjectBranchView {
  branch: BranchInfo
  sessions: SessionMeta[]
  allSessions: SessionMeta[]
}

export function ProjectList({
  projects,
  sessionsByProject,
  branchesByProject,
  searchQuery,
  activeCwd,
  activePath,
  previewDensity,
  onSelect,
  onAdd,
  onRemove,
  onNewSession,
  onNewBranch,
  onReorder,
  onSelectSession,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  projects: ProjectMeta[]
  sessionsByProject: Record<string, SessionMeta[]>
  branchesByProject: Record<string, BranchInfo[]>
  searchQuery: string
  activeCwd?: string
  activePath?: string
  previewDensity: SessionPreviewDensity
  onSelect: (cwd: string) => void
  onAdd: () => void
  onRemove: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onNewBranch: (cwd: string) => void
  onReorder: (cwd: string, paths: string[]) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
}): ReactElement {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const visibleProjects = projects
    .map((project) => {
      const branches = branchesByProject[project.cwd] ?? [{
        name: 'main',
        cwd: project.cwd,
        isMain: true
      }]
      const branchViews: ProjectBranchView[] = branches.map((branch) => {
        const allSessions = sessionsByProject[branch.cwd] ?? []
        const sessions = normalizedQuery
          ? allSessions.filter((session) => sessionMatchesQuery(session, normalizedQuery))
          : allSessions
        return { branch, sessions, allSessions }
      })
      return { project, branches: branchViews }
    })
    .filter(({ branches }) => !normalizedQuery || branches.some(({ sessions }) => sessions.length > 0))

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
      {visibleProjects.map(({ project, branches }) => (
        <ProjectFolder
          key={project.cwd}
          project={project}
          branches={branches}
          activeCwd={activeCwd}
          activePath={activePath}
          previewDensity={previewDensity}
          searchActive={Boolean(normalizedQuery)}
          canRemove={projects.length > 1}
          onSelect={onSelect}
          onRemove={onRemove}
          onNewSession={onNewSession}
          onNewBranch={onNewBranch}
          onReorder={onReorder}
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
  branch,
  sessions,
  allSessions,
  activePath,
  previewDensity,
  onNewSession,
  onReorder,
  onSelectSession,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  branch: BranchInfo
  sessions: SessionMeta[]
  allSessions: SessionMeta[]
  activePath?: string
  previewDensity: SessionPreviewDensity
  onNewSession: (cwd: string) => void
  onReorder: (cwd: string, paths: string[]) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
}): ReactElement {
  const [open, setOpen] = useState(true)

  const handleReorder = (orderedVisible: SessionMeta[]): void => {
    const visiblePaths = new Set(sessions.map((session) => session.path))
    let visibleIndex = 0
    const orderedAll = allSessions.map((session) => {
      if (!visiblePaths.has(session.path)) return session
      const replacement = orderedVisible[visibleIndex]
      visibleIndex += 1
      return replacement ?? session
    })
    onReorder(branch.cwd, orderedAll.map((session) => session.path))
  }

  return (
    <div className="project-branch">
      <div
        className={`project-branch-head${sessions.some((session) => session.path === activePath) ? ' active' : ''}`}
        title={`${branch.name} · Git worktree：${branch.cwd}`}
      >
        <button
          type="button"
          className="project-branch-toggle"
          aria-expanded={open}
          aria-label={open ? `收起 ${branch.name} 分支` : `展开 ${branch.name} 分支`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <GitBranch size={13} className="project-branch-icon" />
        <span className="project-branch-name">{branch.name}</span>
        <span className="project-branch-count">{sessions.length}</span>
        <button
          type="button"
          className="project-branch-new"
          title={`在 ${branch.name} 分支中新建会话`}
          onClick={() => onNewSession(branch.cwd)}
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
              previewDensity={previewDensity}
              onSelect={(path) => onSelectSession(branch.cwd, path)}
              onReorder={handleReorder}
              onDelete={(path) => onDelete(branch.cwd, path)}
              onCopy={(path) => onCopy(branch.cwd, path)}
              getForkMessages={(path) => getForkMessages(branch.cwd, path)}
              onFork={(path, entryId) => onFork(branch.cwd, path, entryId)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ProjectFolder({
  project,
  branches,
  activeCwd,
  activePath,
  searchActive,
  canRemove,
  previewDensity,
  onSelect,
  onRemove,
  onNewSession,
  onNewBranch,
  onReorder,
  onSelectSession,
  onDelete,
  onCopy,
  getForkMessages,
  onFork
}: {
  project: ProjectMeta
  branches: ProjectBranchView[]
  activeCwd?: string
  activePath?: string
  searchActive: boolean
  canRemove: boolean
  previewDensity: SessionPreviewDensity
  onSelect: (cwd: string) => void
  onRemove: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onNewBranch: (cwd: string) => void
  onReorder: (cwd: string, paths: string[]) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
}): ReactElement {
  const [open, setOpen] = useState(true)
  const expanded = open || searchActive
  const active = branches.some(({ branch }) => branch.cwd === activeCwd)

  return (
    <div className={`project-folder${active ? ' active' : ''}`}>
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
        <span className="project-folder-count">{branches.length}</span>
        <button
          type="button"
          className="project-folder-new-branch"
          title="新建 Git 分支 worktree"
          aria-label={`在 ${project.name} 下新建 Git 分支`}
          onClick={(event) => {
            event.stopPropagation()
            onNewBranch(project.cwd)
          }}
        >
          <GitBranch size={12} />
          <span className="project-folder-new-branch-plus">+</span>
        </button>
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
          {branches.map(({ branch, sessions, allSessions }) => (
            <ProjectBranch
              key={branch.cwd}
              branch={branch}
              sessions={sessions}
              allSessions={allSessions}
              activePath={activePath}
              previewDensity={previewDensity}
              onNewSession={onNewSession}
              onReorder={onReorder}
              onSelectSession={onSelectSession}
              onDelete={onDelete}
              onCopy={onCopy}
              getForkMessages={getForkMessages}
              onFork={onFork}
            />
          ))}
        </div>
      )}
    </div>
  )
}
