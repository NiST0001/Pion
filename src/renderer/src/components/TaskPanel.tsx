import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { ArrowDown, Check, Circle, ListTodo, Loader2 } from 'lucide-react'
import type { AgentTodo } from '../agent/types'

const TASK_PANEL_STATE_PREFIX = 'pion:session-task-panel-state:'

function taskPanelStateKey(sessionKey: string): string {
  return `${TASK_PANEL_STATE_PREFIX}${encodeURIComponent(sessionKey)}`
}

function loadExpanded(sessionKey: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(taskPanelStateKey(sessionKey))
    if (raw === null) return true
    const saved = JSON.parse(raw)
    return typeof saved === 'boolean' ? saved : true
  } catch {
    return true
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

/** The agent's real work plan, docked above the composer.
    Mirrors the todo tool: the agent plans and executes, the panel follows.
    Hidden entirely when the session has no AI task list. */
export function TaskPanel({ sessionKey, agentTodos }: { sessionKey: string; agentTodos?: AgentTodo[] | null }): ReactElement | null {
  const [expanded, setExpanded] = useState(() => loadExpanded(sessionKey))
  const todos = agentTodos ?? []
  const completed = todos.filter((task) => task.status === 'completed').length

  useEffect(() => {
    saveExpanded(sessionKey, expanded)
  }, [sessionKey, expanded])

  if (todos.length === 0) return null

  return (
    <section
      className={`task-panel task-panel-agent${expanded ? ' expanded' : ' collapsed'}`}
      data-session-key={sessionKey}
    >
      <div className="task-panel-card">
        <div className="task-panel-head">
          <div className="task-panel-summary">
            <ListTodo size={15} />
            <span className="task-panel-title">任务目标</span>
            <span className="task-panel-count">{completed}/{todos.length}</span>
          </div>
          <span className="task-panel-caption">AI 工作计划</span>
        </div>

        <div className="task-panel-list-shell">
          <div id="task-target-list" className="task-panel-list" role="list" aria-label="AI 任务目标列表">
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
