import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { ArrowDown, Check, Circle, ListTodo, Loader2 } from 'lucide-react'
import type { AgentTodo } from '../agent/types'

const TASK_PANEL_STATE_PREFIX = 'pion:session-task-panel-state:'

function taskPanelStateKey(sessionKey: string): string {
  return `${TASK_PANEL_STATE_PREFIX}${encodeURIComponent(sessionKey)}`
}

function loadExpanded(sessionKey: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(taskPanelStateKey(sessionKey))
    if (raw === null) return false
    const saved = JSON.parse(raw)
    return typeof saved === 'boolean' ? saved : false
  } catch {
    return false
  }
}

function saveExpanded(sessionKey: string, expanded: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(taskPanelStateKey(sessionKey), JSON.stringify(expanded))
  } catch {
    // Panel state persistence is best effort and should never block the chat UI.
  }
}

/** The latest user message's unfinished AI plan, docked above the composer.
    Completed tasks leave this live panel immediately and remain available in
    the session's task-history view. */
export function TaskPanel({ sessionKey, agentTodos }: { sessionKey: string; agentTodos?: AgentTodo[] | null }): ReactElement | null {
  const [expanded, setExpanded] = useState(() => loadExpanded(sessionKey))
  const todos = agentTodos ?? []
  const expandedHeight = Math.min(265, Math.max(102, 52 + todos.length * 30))
  const panelStyle = {
    '--task-panel-expanded-height': `${expandedHeight}px`
  } as CSSProperties

  useEffect(() => {
    saveExpanded(sessionKey, expanded)
  }, [sessionKey, expanded])

  if (todos.length === 0) return null

  return (
    <section
      className={`task-panel task-panel-agent${expanded ? ' expanded' : ' collapsed'}`}
      data-session-key={sessionKey}
      style={panelStyle}
    >
      <div className="task-panel-card">
        <div className="task-panel-head">
          <div className="task-panel-summary">
            <ListTodo size={15} />
            <span className="task-panel-title">本轮任务</span>
            <span className="task-panel-count">{todos.length} 项</span>
          </div>
          <span className="task-panel-caption">当前对话</span>
        </div>

        <div className="task-panel-list-shell">
          <div id="task-target-list" className="task-panel-list" role="list" aria-label="本轮 AI 任务列表">
            {todos.map((task, index) => (
              <div
                key={task.id}
                className={`task-item task-agent${task.status === 'completed' ? ' done' : ''}${task.status === 'in_progress' ? ' active' : ''}`}
                role="listitem"
                data-task-index={index + 1}
                data-task-status={task.status}
              >
                <span className="task-check task-status" aria-hidden="true">
                  {task.status === 'completed'
                    ? <Check size={12} />
                    : task.status === 'in_progress'
                      ? <Loader2 size={11} className="spin" />
                      : <Circle size={11} />}
                </span>
                <span className="task-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="task-title" title={task.description ?? task.title}>
                  {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`task-panel-toggle${expanded ? ' expanded' : ' collapsed'}`}
        aria-label={expanded ? '收起任务目标' : '展开任务目标'}
        aria-expanded={expanded}
        aria-controls="task-target-list"
        onClick={() => setExpanded((value) => !value)}
      >
        <ArrowDown size={16} className="task-panel-toggle-icon" />
      </button>
    </section>
  )
}
