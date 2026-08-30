import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import {
  ChevronRight,
  Copy,
  GitBranch,
  GripVertical,
  History,
  Loader2,
  Star,
  Trash2
} from 'lucide-react'
import type { ForkMessageOption, SessionMeta } from '../../../shared/types'
import type { SessionPreviewDensity } from '../utils/sessionPreview'
import { ConfirmDialog } from './ConfirmDialog'

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
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  onSelect: (path: string) => void
  onReorder?: (sessions: SessionMeta[]) => void
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
  favoritePaths: ReadonlySet<string>
  onToggleFavorite: (path: string) => void
}

export function SessionItems({
  sessions,
  activePath,
  runningSessionPaths,
  previewDensity,
  onSelect,
  onReorder,
  onDelete,
  onCopy,
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favoritePaths,
  onToggleFavorite
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
    const height = 430
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
      {sessions.map((session) => (
        <div
          key={session.path}
          data-session-path={session.path}
          className={`side-item side-session side-session-${previewDensity}${onReorder && !session.optimistic ? ' reorderable' : ''}${session.path === activePath ? ' active' : ''}${runningSessionPaths.has(session.path) || session.optimistic ? ' running' : ''}${session.optimistic ? ' optimistic' : ''}${session.path === draggedPath ? ' dragging' : ''}${session.path === dragOverPath ? ' drag-over' : ''}`}
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
            : `${session.path}\n${onReorder ? '拖拽调整顺序 · ' : ''}点击星标收藏 · 右键查看更多操作`}
        >
          <div className="side-session-content">
            {onReorder && !session.optimistic && <GripVertical size={13} className="side-session-drag" aria-hidden="true" />}
            <div className="side-session-main">
              <span className="side-item-label">
                {session.name || session.preview || '未命名会话'}
              </span>
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
      ))}
      {contextMenu && createPortal(
        <SessionContextMenu
          session={contextMenu.session}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={onDelete}
          onCopy={onCopy}
          onOpenTaskHistory={onOpenTaskHistory}
          getForkMessages={getForkMessages}
          onFork={onFork}
          favorite={favoritePaths.has(contextMenu.session.path)}
          onToggleFavorite={onToggleFavorite}
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
  onOpenTaskHistory,
  getForkMessages,
  onFork,
  favorite,
  onToggleFavorite
}: SessionContextMenuState & {
  onClose: () => void
  onDelete: (path: string) => Promise<void>
  onCopy: (path: string) => Promise<void>
  onOpenTaskHistory: (session: SessionMeta) => void
  getForkMessages: (path: string) => Promise<ForkMessageOption[]>
  onFork: (path: string, entryId: string) => Promise<string>
  favorite: boolean
  onToggleFavorite: (path: string) => void
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [forkMessages, setForkMessages] = useState<ForkMessageOption[] | null>(null)
  const [loadingForks, setLoadingForks] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (confirmDelete) return
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (confirmDelete) return
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
  }, [confirmDelete, onClose])

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
      {error && !confirmDelete && <div className="context-menu-error">{error}</div>}
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
