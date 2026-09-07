import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  GitBranch,
  MessageSquarePlus,
  PencilLine,
  Search,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  BranchInfo,
  ForkMessageOption,
  ProjectMeta,
  SessionMeta
} from '../../../../shared/types'
import { SessionItems, sessionMatchesQuery } from '../session/SessionList'
import type { SessionPreviewDensity } from '../../utils/sessionPreview'
import { TextInputDialog } from '../common/TextInputDialog'

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
// Favorites
// ---------------------------------------------------------------------------

export function FavoriteSessions({
  sessions,
  searchQuery,
  activePath,
  runningSessionPaths,
  unreadSessionPaths,
  previewDensity,
  favoritePaths,
  onToggleFavorite,
  onSelectSession,
  onDelete,
  onCopy,
  onRename,
  onOpenTaskHistory,
  getForkMessages,
  onFork
}: {
  sessions: SessionMeta[]
  searchQuery: string
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  unreadSessionPaths?: ReadonlySet<string>
  previewDensity: SessionPreviewDensity
  favoritePaths: ReadonlySet<string>
  onToggleFavorite: (path: string) => void
  onSelectSession: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => Promise<void>
  onCopy: (session: SessionMeta) => Promise<void>
  onRename: (session: SessionMeta, name: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (session: SessionMeta) => Promise<ForkMessageOption[]>
  onFork: (session: SessionMeta, entryId: string) => Promise<string>
}): ReactElement {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const visibleSessions = normalizedQuery
    ? sessions.filter((session) => sessionMatchesQuery(session, normalizedQuery))
    : sessions
  const findSession = (path: string): SessionMeta | undefined => sessions.find((session) => session.path === path)

  return (
    <Section title="收藏" count={visibleSessions.length}>
      {visibleSessions.length === 0 ? (
        <div className="side-empty">{normalizedQuery ? '没有匹配的收藏会话' : '暂无收藏的会话'}</div>
      ) : (
        <SessionItems
          sessions={visibleSessions}
          activePath={activePath}
          runningSessionPaths={runningSessionPaths}
          unreadSessionPaths={unreadSessionPaths}
          previewDensity={previewDensity}
          favoritePaths={favoritePaths}
          onToggleFavorite={onToggleFavorite}
          onSelect={(path) => {
            const session = findSession(path)
            if (session) onSelectSession(session)
          }}
          onDelete={(path) => {
            const session = findSession(path)
            return session ? onDelete(session) : Promise.resolve()
          }}
          onCopy={(path) => {
            const session = findSession(path)
            return session ? onCopy(session) : Promise.resolve()
          }}
          onRename={(path, name) => {
            const session = findSession(path)
            return session ? onRename(session, name) : Promise.resolve()
          }}
          onOpenTaskHistory={onOpenTaskHistory}
          getForkMessages={(path) => {
            const session = findSession(path)
            return session ? getForkMessages(session) : Promise.resolve([])
          }}
          onFork={(path, entryId) => {
            const session = findSession(path)
            return session ? onFork(session, entryId) : Promise.resolve('')
          }}
        />
      )}
    </Section>
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
  runningSessionPaths,
  unreadSessionPaths,
  previewDensity,
  onSelect,
  onAdd,
  onRemove,
  onNewSession,
  onNewBranch,
  onRenameBranch,
  onReorder,
  onSelectSession,
  onDelete,
  onCopy,
  onRename,
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favoritePaths,
  onToggleFavorite
}: {
  projects: ProjectMeta[]
  sessionsByProject: Record<string, SessionMeta[]>
  branchesByProject: Record<string, BranchInfo[]>
  searchQuery: string
  activeCwd?: string
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  unreadSessionPaths?: ReadonlySet<string>
  previewDensity: SessionPreviewDensity
  onSelect: (cwd: string) => void
  onAdd: () => void
  onRemove: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onNewBranch: (cwd: string) => void
  onRenameBranch: (cwd: string, branch: BranchInfo, name: string) => Promise<void>
  onReorder: (cwd: string, paths: string[]) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  onRename: (cwd: string, path: string, name: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
  favoritePaths: ReadonlySet<string>
  onToggleFavorite: (path: string) => void
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
          runningSessionPaths={runningSessionPaths}
          unreadSessionPaths={unreadSessionPaths}
          previewDensity={previewDensity}
          searchActive={Boolean(normalizedQuery)}
          canRemove={projects.length > 1}
          onSelect={onSelect}
          onRemove={onRemove}
          onNewSession={onNewSession}
          onNewBranch={onNewBranch}
          onRenameBranch={onRenameBranch}
          onReorder={onReorder}
          onSelectSession={onSelectSession}
          onDelete={onDelete}
          onCopy={onCopy}
          onRename={onRename}
          onOpenTaskHistory={onOpenTaskHistory}
          getForkMessages={getForkMessages}
          onFork={onFork}
          favoritePaths={favoritePaths}
          onToggleFavorite={onToggleFavorite}
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
  runningSessionPaths,
  unreadSessionPaths,
  previewDensity,
  onNewSession,
  onRenameBranch,
  onReorder,
  onSelectSession,
  onDelete,
  onCopy,
  onRename,
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favoritePaths,
  onToggleFavorite
}: {
  branch: BranchInfo
  sessions: SessionMeta[]
  allSessions: SessionMeta[]
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  unreadSessionPaths?: ReadonlySet<string>
  previewDensity: SessionPreviewDensity
  onNewSession: (cwd: string) => void
  onRenameBranch: (branch: BranchInfo, name: string) => Promise<void>
  onReorder: (cwd: string, paths: string[]) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  onRename: (cwd: string, path: string, name: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
  favoritePaths: ReadonlySet<string>
  onToggleFavorite: (path: string) => void
}): ReactElement {
  const [open, setOpen] = useState(true)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState('')

  const handleRename = async (name: string): Promise<void> => {
    if (!branch.gitBranch || renameBusy) return
    setRenameBusy(true)
    setRenameError('')
    try {
      await onRenameBranch(branch, name)
      setRenameOpen(false)
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      setRenameBusy(false)
    }
  }

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
        {branch.gitBranch && (
          <button
            type="button"
            className="project-branch-rename"
            title={`重命名 ${branch.name} 分支`}
            aria-label={`重命名 ${branch.name} 分支`}
            onClick={(event) => {
              event.stopPropagation()
              setRenameError('')
              setRenameOpen(true)
            }}
          >
            <PencilLine size={12} />
          </button>
        )}
        <button
          type="button"
          className="project-branch-new"
          title={`在 ${branch.name} 分支中新建会话`}
          onClick={(event) => {
            event.stopPropagation()
            onNewSession(branch.cwd)
          }}
        >
          <MessageSquarePlus size={13} />
        </button>
      </div>
      <TextInputDialog
        open={renameOpen}
        title="重命名 Git 分支"
        message={<>为 <strong>“{branch.name}”</strong> 设置新的分支名称。</>}
        label="分支名称"
        initialValue={branch.name}
        placeholder="feature/my-branch"
        confirmLabel="保存名称"
        busy={renameBusy}
        error={renameError}
        onConfirm={(name) => void handleRename(name)}
        onCancel={() => {
          if (renameBusy) return
          setRenameOpen(false)
          setRenameError('')
        }}
      />
      {open && (
        <div className="project-branch-sessions">
          {sessions.length === 0 ? (
            <div className="project-folder-empty">暂无会话</div>
          ) : (
            <SessionItems
              sessions={sessions}
              activePath={activePath}
              runningSessionPaths={runningSessionPaths}
              unreadSessionPaths={unreadSessionPaths}
              previewDensity={previewDensity}
              favoritePaths={favoritePaths}
              onToggleFavorite={onToggleFavorite}
              onSelect={(path) => onSelectSession(branch.cwd, path)}
              onReorder={sessions.some((session) => session.optimistic) ? undefined : handleReorder}
              onDelete={(path) => onDelete(branch.cwd, path)}
              onCopy={(path) => onCopy(branch.cwd, path)}
              onRename={(path, name) => onRename(branch.cwd, path, name)}
              onOpenTaskHistory={onOpenTaskHistory}
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
  runningSessionPaths,
  unreadSessionPaths,
  searchActive,
  canRemove,
  previewDensity,
  onSelect,
  onRemove,
  onNewSession,
  onNewBranch,
  onRenameBranch,
  onReorder,
  onSelectSession,
  onDelete,
  onCopy,
  onRename,
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favoritePaths,
  onToggleFavorite
}: {
  project: ProjectMeta
  branches: ProjectBranchView[]
  activeCwd?: string
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  unreadSessionPaths?: ReadonlySet<string>
  searchActive: boolean
  canRemove: boolean
  previewDensity: SessionPreviewDensity
  onSelect: (cwd: string) => void
  onRemove: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onNewBranch: (cwd: string) => void
  onRenameBranch: (cwd: string, branch: BranchInfo, name: string) => Promise<void>
  onReorder: (cwd: string, paths: string[]) => void
  onSelectSession: (cwd: string, path: string) => void
  onDelete: (cwd: string, path: string) => Promise<void>
  onCopy: (cwd: string, path: string) => Promise<void>
  onRename: (cwd: string, path: string, name: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (cwd: string, path: string) => Promise<ForkMessageOption[]>
  onFork: (cwd: string, path: string, entryId: string) => Promise<string>
  favoritePaths: ReadonlySet<string>
  onToggleFavorite: (path: string) => void
}): ReactElement {
  const [open, setOpen] = useState(true)
  const expanded = open || searchActive
  const active = branches.some(({ branch }) => branch.cwd === activeCwd)

  return (
    <div className={`project-folder project-folder-${previewDensity}${active ? ' active' : ''}`}>
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
              runningSessionPaths={runningSessionPaths}
              unreadSessionPaths={unreadSessionPaths}
              previewDensity={previewDensity}
              onNewSession={onNewSession}
              onRenameBranch={(branch, name) => onRenameBranch(project.cwd, branch, name)}
              onReorder={onReorder}
              onSelectSession={onSelectSession}
              onDelete={onDelete}
              onCopy={onCopy}
              onRename={onRename}
              onOpenTaskHistory={onOpenTaskHistory}
              getForkMessages={getForkMessages}
              onFork={onFork}
              favoritePaths={favoritePaths}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>
      )}
    </div>
  )
}
