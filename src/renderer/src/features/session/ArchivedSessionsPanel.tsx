import { useEffect, useMemo, useRef, useState } from 'react'
import { ArchiveRestore, Search } from 'lucide-react'
import type { SessionMeta } from '../../../../shared/types'
import { sessionPlacementKey, type SessionOrganization } from '../../../../shared/session-organization'
import { OperationsModal } from '../operations/OperationsModal'

export function ArchivedSessionsPanel({
  organization, sessionsByProject, ready, loading, saving, error, activePath,
  runningSessionPaths, unreadSessionPaths, attentionSessionPaths, onRefresh, onSelect, onRestore, onClose
}: {
  organization: SessionOrganization
  sessionsByProject: Record<string, SessionMeta[]>
  ready: boolean
  loading: boolean
  saving: boolean
  error: string
  activePath?: string
  runningSessionPaths: ReadonlySet<string>
  unreadSessionPaths: ReadonlySet<string>
  attentionSessionPaths: ReadonlySet<string>
  onRefresh: () => Promise<void>
  onSelect: (cwd: string, path: string) => Promise<void>
  onRestore: (cwd: string, path: string) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [failure, setFailure] = useState('')
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const entries = useMemo(() => {
    const known = new Map<string, SessionMeta>()
    for (const [cwd, sessions] of Object.entries(sessionsByProject)) {
      for (const session of sessions) {
        if (!session.projectCwd || session.projectCwd === cwd) known.set(sessionPlacementKey(cwd, session.path), session)
      }
    }
    return organization.sessions.filter((placement) => placement.archived).map((placement) => {
      const session = known.get(sessionPlacementKey(placement.cwd, placement.path))
      return { ...placement, title: session?.name || session?.preview || placement.title || '未命名会话' }
    })
  }, [organization.sessions, sessionsByProject])
  const normalized = query.trim().toLocaleLowerCase()
  const visible = entries.filter((entry) => !normalized || [entry.title, entry.cwd, entry.path].join(' ').toLocaleLowerCase().includes(normalized))
  const act = async (cwd: string, path: string, restore: boolean): Promise<void> => {
    if (pending.current || saving || !ready) return
    pending.current = true
    setPendingPath(sessionPlacementKey(cwd, path))
    setFailure('')
    try {
      await (restore ? onRestore(cwd, path) : onSelect(cwd, path))
      if (!restore && mounted.current) onClose()
    } catch (err) {
      if (mounted.current) setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
      if (mounted.current) setPendingPath(null)
    }
  }

  return <OperationsModal kind="archive" onClose={onClose}>
    <div className="archived-sessions-panel">
      <div className="archived-sessions-toolbar">
        <label className="sidebar-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" aria-label="搜索归档会话" placeholder="搜索归档会话" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <span>{ready ? `${entries.length} 个归档会话` : '归档会话待加载'}</span>
        <button type="button" disabled={loading || saving || pendingPath !== null} onClick={() => void onRefresh()}>刷新</button>
      </div>
      <p className="archived-sessions-hint">恢复后回到原文件夹；归档会话的后台任务会继续运行。</p>
      {(failure || error) && <div className="session-organization-error" role="alert">{failure || error}</div>}
      {!ready ? <div className="side-empty">{loading ? '正在读取归档会话…' : '归档会话读取失败，请刷新重试。'}</div>
        : visible.length === 0 ? <div className="side-empty">{normalized ? '没有匹配的归档会话' : '暂无归档会话'}</div>
          : <div className="archived-sessions-list">
            {visible.map((entry) => {
              const key = sessionPlacementKey(entry.cwd, entry.path)
              const attention = attentionSessionPaths.has(entry.path)
              const unread = unreadSessionPaths.has(entry.path)
              const running = runningSessionPaths.has(entry.path)
              return <div key={key} className={`archived-session${entry.path === activePath ? ' active' : ''}`}>
                <button type="button" className="archived-session-open" title={`${entry.cwd}\n${entry.path}`}
                  aria-current={entry.path === activePath ? 'true' : undefined}
                  disabled={saving || pendingPath !== null} onClick={() => void act(entry.cwd, entry.path, false)}>
                  <span className="archived-session-title">
                    {(attention || unread) && <span className={`side-session-unread-indicator${attention ? ' attention' : ''}`}
                      aria-label={attention ? '等待回答或权限确认' : '未读会话'} />}
                    <strong>{entry.title}</strong>
                    {running && <small>运行中</small>}
                  </span>
                  <small>{entry.cwd}</small>
                </button>
                <button type="button" className="archived-session-restore" aria-label={`恢复会话 ${entry.title}`}
                  title="恢复到原文件夹" disabled={saving || pendingPath !== null}
                  onClick={() => void act(entry.cwd, entry.path, true)}><ArchiveRestore size={14} />恢复</button>
              </div>
            })}
          </div>}
    </div>
  </OperationsModal>
}
