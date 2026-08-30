import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Check,
  ChevronRight,
  Circle,
  History,
  ListTodo,
  Loader2,
  X
} from 'lucide-react'
import type { SessionMeta } from '../../../shared/types'
import type { AgentTaskRun, AgentTodo } from '../agent/types'

function sessionTitle(session: SessionMeta): string {
  return session.name || session.preview || '未命名会话'
}

function formatRunTime(timestamp: string | undefined): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function TaskIcon({ task }: { task: AgentTodo }): ReactElement {
  if (task.status === 'completed') return <Check size={12} />
  if (task.status === 'in_progress') return <Loader2 size={12} className="spin" />
  return <Circle size={11} />
}

export function TaskHistoryPanel({
  session,
  onClose
}: {
  session: SessionMeta | null
  onClose: () => void
}): ReactElement | null {
  const [runs, setRuns] = useState<AgentTaskRun[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session) return
    let active = true
    setLoading(true)
    setRuns([])
    setExpanded(new Set())
    setError('')
    void window.pion.getSessionTaskHistory(session.path)
      .then((nextRuns) => {
        if (!active) return
        setRuns(nextRuns)
        const latest = nextRuns.at(-1)
        setExpanded(latest ? new Set([latest.key]) : new Set())
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [session?.path])

  useEffect(() => {
    if (!session) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [session, onClose])

  if (!session) return null

  const taskCount = runs.reduce((count, run) => count + run.tasks.length, 0)
  const completedCount = runs.reduce(
    (count, run) => count + run.tasks.filter((task) => task.status === 'completed').length,
    0
  )

  return (
    <div className="modal-backdrop task-history-backdrop" onClick={onClose}>
      <section
        className="modal task-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-history-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head task-history-head">
          <div className="task-history-heading">
            <div className="modal-kicker"><History size={11} /> SESSION TASKS</div>
            <h2 id="task-history-title">历史任务</h2>
            <span title={session.path}>{sessionTitle(session)}</span>
          </div>
          <button type="button" className="icon-button" title="关闭历史任务" aria-label="关闭历史任务" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="task-history-summary" aria-live="polite">
          <div><ListTodo size={14} /><strong>{runs.length}</strong><span>轮计划</span></div>
          <div><strong>{taskCount}</strong><span>项任务</span></div>
          <div><strong>{completedCount}</strong><span>项完成</span></div>
          {loading && <small>正在扫描会话记录…</small>}
        </div>

        <div className="task-history-body">
          {loading && runs.length === 0 && (
            <div className="task-history-state"><Loader2 size={17} className="spin" /> 正在整理会话任务…</div>
          )}
          {!loading && error && <div className="task-history-state task-history-error">{error}</div>}
          {!loading && !error && runs.length === 0 && (
            <div className="task-history-state">该会话还没有由 AI 创建的任务计划。</div>
          )}
          {runs.map((run) => {
            const open = expanded.has(run.key)
            const complete = run.tasks.filter((task) => task.status === 'completed').length
            const time = formatRunTime(run.timestamp)
            return (
              <section key={run.key} className={`task-history-run${open ? ' expanded' : ''}`}>
                <button
                  type="button"
                  className="task-history-run-toggle"
                  aria-expanded={open}
                  aria-controls={`task-history-run-${run.key}`}
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(run.key)) next.delete(run.key)
                    else next.add(run.key)
                    return next
                  })}
                >
                  <span className="task-history-run-index">{String(run.ordinal).padStart(2, '0')}</span>
                  <span className="task-history-run-copy">
                    <strong title={run.prompt}>{run.prompt.replace(/\s+/g, ' ').trim() || '(空消息)'}</strong>
                    <small>{time ? `${time} · ` : ''}{complete}/{run.tasks.length} 完成</small>
                  </span>
                  <ChevronRight size={15} className="task-history-run-chevron" />
                </button>
                {open && (
                  <div id={`task-history-run-${run.key}`} className="task-history-tasks" role="list">
                    {run.tasks.map((task, index) => (
                      <div
                        key={`${typeof task.id}:${String(task.id)}:${index}`}
                        className={`task-history-task task-history-task-${task.status}`}
                        role="listitem"
                      >
                        <span className="task-history-task-status" aria-hidden="true"><TaskIcon task={task} /></span>
                        <span className="task-history-task-index">{String(index + 1).padStart(2, '0')}</span>
                        <span className="task-history-task-copy">
                          <strong>{task.status === 'in_progress' && task.activeForm ? task.activeForm : task.title}</strong>
                          {task.description && <small>{task.description}</small>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </section>
    </div>
  )
}
