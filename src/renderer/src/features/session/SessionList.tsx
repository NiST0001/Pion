import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import {
  Archive,
  ChevronRight,
  Copy,
  FolderInput,
  GitBranch,
  GripVertical,
  History,
  Loader2,
  PencilLine,
  Star,
  Trash2
} from 'lucide-react'
import type { ForkMessageOption, SessionMeta } from '../../../../shared/types'
import type { SubagentSessionSummary } from '../../../../shared/subagent-sessions'
import type { SessionPreviewDensity } from '../../utils/sessionPreview'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { TextInputDialog } from '../common/TextInputDialog'
import { PionSelect } from '../common/PionSelect'

const subagentStatusLabel: Record<SubagentSessionSummary['status'], string> = {
  starting: '准备中', running: '运行中', cancelling: '停止中', completed: '已完成', failed: '失败', aborted: '已停止'
}

export function sessionMatchesQuery(session: SessionMeta, query: string): boolean {
  const haystack = [session.name, session.preview, session.path]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
  return haystack.includes(query)
}

function formatTime(mtime: number): string {
  const date = new Date(mtime)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

interface SessionItemActions {
  subagentSessions?: readonly SubagentSessionSummary[]
  selectedSubagent?: Pick<SubagentSessionSummary, 'id' | 'backendId'> | null
  onViewSubagent?: (summary: SubagentSessionSummary) => void
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  unreadSessionPaths?: ReadonlySet<string>
  attentionSessionPaths?: ReadonlySet<string>
  onSelect: (path: string) => void
  onReorder?: (sessions: SessionMeta[]) => void
  onArchive?: (path: string) => Promise<void>
  folderOptions?: Array<{ value: string; label: string }>
  sessionFolderIds?: ReadonlyMap<string, string | undefined>
  onMoveToFolder?: (path: string, folderId: string | null) => Promise<void>
  organizationDisabled?: boolean
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  onRename: (path: string, name: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
  favoritePaths: ReadonlySet<string>
  onToggleFavorite: (path: string) => void
}

export function SessionItems({
  sessions,
  subagentSessions,
  selectedSubagent,
  onViewSubagent,
  activePath,
  runningSessionPaths,
  unreadSessionPaths,
  attentionSessionPaths,
  previewDensity,
  onSelect,
  onReorder,
  onDelete,
  onCopy,
  onRename,
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favoritePaths,
  onToggleFavorite,
  onArchive,
  folderOptions,
  sessionFolderIds,
  onMoveToFolder,
  organizationDisabled
}: { sessions: SessionMeta[]; previewDensity: SessionPreviewDensity } & SessionItemActions): ReactElement {
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null)
  const [draggedPath, setDraggedPath] = useState<string | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  useEffect(() => {
    if (contextMenu && !sessions.some((session) => session.path === contextMenu.session.path)) {
      setContextMenu(null)
    }
  }, [sessions, contextMenu])

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>, session: SessionMeta): void => {
    event.preventDefault()
    event.stopPropagation()
    const width = 246
    const height = 470
    setContextMenu({
      session,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - width)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - height))
    })
  }

  const clearDragState = (): void => {
    setDraggedPath(null)
    setDragOverPath(null)
  }

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>, session: SessionMeta): void => {
    setDraggedPath(session.path)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', session.path)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, targetPath: string): void => {
    event.preventDefault()
    const sourcePath = event.dataTransfer.getData('text/plain') || draggedPath
    if (!sourcePath || sourcePath === targetPath) {
      clearDragState()
      return
    }
    const fromIndex = sessions.findIndex((session) => session.path === sourcePath)
    const toIndex = sessions.findIndex((session) => session.path === targetPath)
    if (fromIndex < 0 || toIndex < 0) {
      clearDragState()
      return
    }
    const reordered = [...sessions]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    onReorder?.(reordered)
    clearDragState()
  }

  return (
    <>
      {sessions.map((session) => {
        const attention = attentionSessionPaths?.has(session.path)
        const children = subagentSessions?.filter((child) => child.parentSessionPath === session.path && child.cwd === session.projectCwd) ?? []
        return (
        <Fragment key={session.path}>
        <div
          data-session-path={session.path}
          className={`side-item side-session side-session-${previewDensity}${onReorder && !session.optimistic ? ' reorderable' : ''}${!selectedSubagent && session.path === activePath ? ' active' : ''}${runningSessionPaths.has(session.path) || session.optimistic ? ' running' : ''}${unreadSessionPaths?.has(session.path) ? ' unread' : ''}${session.optimistic ? ' optimistic' : ''}${session.path === draggedPath ? ' dragging' : ''}${session.path === dragOverPath ? ' drag-over' : ''}`}
          aria-current={!selectedSubagent && session.path === activePath ? 'true' : undefined}
          aria-busy={runningSessionPaths.has(session.path) || session.optimistic}
          draggable={Boolean(onReorder && !session.optimistic)}
          onDragStart={(event) => {
            if (onReorder && !session.optimistic) handleDragStart(event, session)
          }}
          onDragOver={(event) => {
            if (!onReorder || session.optimistic) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (session.path !== draggedPath) setDragOverPath(session.path)
          }}
          onDragLeave={() => {
            if (session.path === dragOverPath) setDragOverPath(null)
          }}
          onDrop={(event) => {
            if (!session.optimistic) handleDrop(event, session.path)
          }}
          onDragEnd={clearDragState}
          onClick={() => {
            setContextMenu(null)
            if (!session.optimistic) onSelect(session.path)
          }}
          onContextMenu={(event) => {
            if (!session.optimistic) openContextMenu(event, session)
          }}
          title={session.optimistic
            ? '正在保存新会话…'
            : `${attention ? '待处理：等待回答或权限确认\n' : ''}${unreadSessionPaths?.has(session.path) ? '未读：有新的运行结果\n' : ''}${session.path}\n${onReorder ? '拖拽调整顺序 · ' : ''}点击星标收藏 · 右键查看更多操作`}
        >
          <div className="side-session-content">
            {onReorder && !session.optimistic && <GripVertical size={13} className="side-session-drag" aria-hidden="true" />}
            <div className="side-session-main">
              <div className="side-session-title-row">
                {(attention || unreadSessionPaths?.has(session.path)) && (
                  <span
                    className={`side-session-unread-indicator${attention ? ' attention' : ''}`}
                    aria-label={attention ? '等待回答或权限确认' : '未读会话'}
                    title={attention ? '等待回答或权限确认' : '有新的运行结果'}
                  />
                )}
                <span className="side-item-label">
                  {session.name || session.preview || '未命名会话'}
                </span>
              </div>
              {previewDensity === 'detailed' && session.name && session.preview && (
                <span className="side-session-preview">{session.preview}</span>
              )}
              {previewDensity !== 'compact' && (
                <span className="side-session-meta">
                  {formatTime(session.mtime)} · {session.messageCount} 条消息
                </span>
              )}
            </div>
            {session.optimistic ? (
              <span className="side-session-persisting" aria-label="正在保存新会话">
                <Loader2 size={13} className="spin" aria-hidden="true" />
              </span>
            ) : (
              <button
                type="button"
                className={`side-session-favorite${favoritePaths.has(session.path) ? ' active' : ''}`}
                aria-label={favoritePaths.has(session.path) ? '取消收藏会话' : '收藏会话'}
                aria-pressed={favoritePaths.has(session.path)}
                title={favoritePaths.has(session.path) ? '取消收藏' : '收藏会话'}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleFavorite(session.path)
                }}
              >
                <Star size={13} fill={favoritePaths.has(session.path) ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
        </div>
        {onViewSubagent && children.length > 0 && (
          <details className="side-subagent-sessions" aria-label="临时子会话" open>
            <summary className="side-subagent-toggle" onClick={(event) => { event.stopPropagation(); setContextMenu(null) }}>
              <ChevronRight size={12} aria-hidden="true" />
              <span>子会话</span><span className="side-subagent-count">{children.length}</span>
            </summary>
            <div className="side-subagent-session-items">
            {children.map((child) => (
              <button key={`${child.backendId}:${child.id}`} type="button"
                className={`side-subagent-session${selectedSubagent?.id === child.id && selectedSubagent.backendId === child.backendId ? ' active' : ''}`} draggable={false}
                aria-current={selectedSubagent?.id === child.id && selectedSubagent.backendId === child.backendId ? 'true' : undefined}
                aria-label={`查看子会话 ${child.name} · ${subagentStatusLabel[child.status]}`}
                onClick={(event) => { event.stopPropagation(); setContextMenu(null); onViewSubagent(child) }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
                onDragStart={(event) => { event.preventDefault(); event.stopPropagation() }}>
                <span className="side-subagent-name">↳ {child.name}</span>
                <span className="side-subagent-status">{subagentStatusLabel[child.status]}</span>
              </button>
            ))}
            </div>
          </details>
        )}
        </Fragment>
        )
      })}
      {contextMenu && createPortal(
        <SessionContextMenu
          key={contextMenu.session.path}
          session={contextMenu.session}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu((current) => current === contextMenu ? null : current)}
          onDelete={onDelete}
          onCopy={onCopy}
          onRename={onRename}
          onOpenTaskHistory={onOpenTaskHistory}
          getForkMessages={getForkMessages}
          onFork={onFork}
          favorite={favoritePaths.has(contextMenu.session.path)}
          onToggleFavorite={onToggleFavorite}
          onArchive={onArchive}
          folderOptions={folderOptions}
          folderId={sessionFolderIds?.get(contextMenu.session.path)}
          onMoveToFolder={onMoveToFolder}
          organizationDisabled={organizationDisabled}
        />,
        document.body
      )}
    </>
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
  onRename,
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favorite,
  onToggleFavorite,
  onArchive,
  folderOptions,
  folderId,
  onMoveToFolder,
  organizationDisabled = false
}: SessionContextMenuState & {
  onClose: () => void
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  onRename: (path: string, name: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
  favorite: boolean
  onToggleFavorite: (path: string) => void
  onArchive?: (path: string) => Promise<void>
  folderOptions?: Array<{ value: string; label: string }>
  folderId?: string
  onMoveToFolder?: (path: string, folderId: string | null) => Promise<void>
  organizationDisabled?: boolean
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [forkMessages, setForkMessages] = useState<ForkMessageOption[] | null>(null)
  const [loadingForks, setLoadingForks] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const actionPending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (confirmDelete || renameOpen || moveOpen) return
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (confirmDelete || renameOpen || moveOpen) return
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
  }, [confirmDelete, onClose, renameOpen, moveOpen])

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    if (actionPending.current) return
    actionPending.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      setBusy(false)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    } finally {
      actionPending.current = false
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
        onClick={() => {
          onToggleFavorite(session.path)
          onClose()
        }}
      >
        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
        <span>{favorite ? '取消收藏' : '收藏会话'}</span>
      </button>
      <button
        className="context-menu-item"
        disabled={busy}
        onClick={() => {
          setError('')
          setRenameOpen(true)
        }}
      >
        <PencilLine size={14} />
        <span>重命名会话</span>
      </button>
      <button
        className="context-menu-item"
        disabled={busy}
        onClick={() => void runAction(() => onCopy(session.path))}
      >
        <Copy size={14} />
        <span>从会话复制</span>
      </button>
      <button
        className="context-menu-item"
        disabled={busy}
        onClick={() => {
          onOpenTaskHistory(session)
          onClose()
        }}
      >
        <History size={14} />
        <span>历史任务</span>
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
          setError('')
          setConfirmDelete(true)
        }}
      >
        <Trash2 size={14} />
        <span>删除会话</span>
      </button>
      {onMoveToFolder && folderOptions && (
        <button type="button" className="context-menu-item" disabled={busy || organizationDisabled}
          onClick={() => { setError(''); setMoveOpen(true) }}>
          <FolderInput size={14} /><span>移到文件夹</span>
        </button>
      )}
      {onArchive && (
        <button type="button" className="context-menu-item" disabled={busy || organizationDisabled}
          onClick={() => { if (!organizationDisabled) void runAction(() => onArchive(session.path)) }}>
          <Archive size={14} /><span>归档会话</span>
        </button>
      )}
      {error && !confirmDelete && !renameOpen && !moveOpen && <div className="context-menu-error" role="alert">{error}</div>}
      <SessionFolderMoveDialog
        open={moveOpen}
        title="移动会话"
        options={folderOptions ?? []}
        initialValue={folderId ?? ''}
        busy={busy}
        disabled={organizationDisabled || !onMoveToFolder}
        error={error}
        onConfirm={(value) => {
          if (!organizationDisabled && onMoveToFolder) void runAction(() => onMoveToFolder(session.path, value || null))
        }}
        onCancel={() => { if (!busy) { setMoveOpen(false); setError('') } }}
      />
      <TextInputDialog
        open={renameOpen}
        title="重命名会话"
        message={<>为 <strong>“{title}”</strong> 设置新的显示名称。</>}
        label="会话名称"
        initialValue={title}
        placeholder="输入会话名称"
        confirmLabel="保存名称"
        busy={busy}
        error={error}
        onConfirm={(value) => void runAction(() => onRename(session.path, value))}
        onCancel={() => {
          if (busy) return
          setRenameOpen(false)
          setError('')
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="删除会话"
        message={<>确定删除 <strong>“{title}”</strong>？</>}
        detail={error || '此操作不可撤销，会话文件及其历史任务入口将被移除。'}
        confirmLabel="确认删除"
        busy={busy}
        onConfirm={() => void runAction(() => onDelete(session.path))}
        onCancel={() => {
          if (busy) return
          setConfirmDelete(false)
          setError('')
        }}
      />
    </div>
  )
}

/** Shared folder picker for session and directory moves. Commits only on confirmation. */
export function SessionFolderMoveDialog({
  open, title, options, initialValue, busy = false, disabled = false, error, onConfirm, onCancel
}: {
  open: boolean
  title: string
  options: Array<{ value: string; label: string }>
  initialValue: string
  busy?: boolean
  disabled?: boolean
  error?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState(initialValue)
  useEffect(() => { if (open) setValue(initialValue) }, [open, initialValue])
  const valid = options.some((option) => option.value === value)
  return (
    <ConfirmDialog
      open={open}
      title={title}
      tone="accent"
      message="选择目标文件夹。"
      detail={<>
        <PionSelect value={value} options={options} ariaLabel="目标文件夹"
          disabled={busy || disabled} onValueChange={setValue} />
        {error && <div role="alert" className="session-organization-error">{error}</div>}
        {!valid && <div role="alert">请选择有效的目标文件夹。</div>}
      </>}
      confirmLabel="确认移动"
      busy={busy || disabled}
      onConfirm={() => { if (!busy && !disabled && valid) onConfirm(value) }}
      onCancel={onCancel}
    />
  )
}
