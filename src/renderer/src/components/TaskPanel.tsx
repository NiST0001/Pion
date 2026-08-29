import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { ArrowDown, Check, Circle, ListTodo } from 'lucide-react'

interface TaskTarget {
  id: string
  title: string
  done: boolean
}

const TASK_STORAGE_PREFIX = 'pion:session-tasks:'
const TASK_PANEL_STATE_PREFIX = 'pion:session-task-panel-state:'

function createDefaultTasks(): TaskTarget[] {
  return [
    { id: 'understand', title: '梳理任务目标与验收标准', done: true },
    { id: 'inspect', title: '检查项目结构与现有实现', done: true },
    { id: 'plan', title: '确定交互与技术方案', done: true },
    { id: 'implement', title: '实现核心功能与数据流', done: false },
    { id: 'polish', title: '完善界面细节和交互状态', done: false },
    { id: 'verify-types', title: '运行类型检查并修复问题', done: false },
    { id: 'verify-build', title: '执行构建与自动化验证', done: false },
    { id: 'review', title: '复查改动并整理交付说明', done: false },
    { id: 'document', title: '补充使用说明与注意事项', done: false },
    { id: 'finish', title: '确认任务完成并提交变更', done: false }
  ]
}

function taskStorageKey(sessionKey: string): string {
  return `${TASK_STORAGE_PREFIX}${encodeURIComponent(sessionKey)}`
}

function loadTasks(sessionKey: string): TaskTarget[] {
  const defaults = createDefaultTasks()
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(taskStorageKey(sessionKey))
    if (!raw) return defaults
    const saved = JSON.parse(raw) as unknown
    if (!Array.isArray(saved)) return defaults
    const tasks = saved.flatMap((task): TaskTarget[] => {
      if (!task || typeof task !== 'object') return []
      const record = task as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.title !== 'string' || typeof record.done !== 'boolean') {
        return []
      }
      return [{ id: record.id, title: record.title, done: record.done }]
    })
    return tasks.length === saved.length ? tasks : defaults
  } catch {
    return defaults
  }
}

function saveTasks(sessionKey: string, tasks: TaskTarget[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(taskStorageKey(sessionKey), JSON.stringify(tasks))
  } catch {
    // Task persistence is best effort and should never block the chat UI.
  }
}

function taskPanelStateKey(sessionKey: string): string {
  return `${TASK_PANEL_STATE_PREFIX}${encodeURIComponent(sessionKey)}`
}

function loadExpanded(sessionKey: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(taskPanelStateKey(sessionKey))
    if (raw === null) return true
    const saved = JSON.parse(raw) as unknown
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

/** Compact, expandable work-plan surface docked above the composer. */
export function TaskPanel({ sessionKey }: { sessionKey: string }): ReactElement {
  const [expanded, setExpanded] = useState(() => loadExpanded(sessionKey))
  const [tasks, setTasks] = useState(() => loadTasks(sessionKey))
  const completed = tasks.filter((task) => task.done).length

  useEffect(() => {
    saveTasks(sessionKey, tasks)
  }, [sessionKey, tasks])

  useEffect(() => {
    saveExpanded(sessionKey, expanded)
  }, [sessionKey, expanded])

  return (
    <section
      className={`task-panel${expanded ? ' expanded' : ' collapsed'}`}
      data-session-key={sessionKey}
    >
      <div className="task-panel-card">
        <div className="task-panel-head">
          <div className="task-panel-summary">
            <ListTodo size={15} />
            <span className="task-panel-title">任务目标</span>
            <span className="task-panel-count">{completed}/{tasks.length}</span>
          </div>
          <span className="task-panel-caption">工作计划</span>
        </div>

        <div className="task-panel-list-shell">
          <div id="task-target-list" className="task-panel-list" role="list" aria-label="任务目标列表">
            {tasks.map((task, index) => (
              <div
                key={task.id}
                className={`task-item${task.done ? ' done' : ''}`}
                role="listitem"
                data-task-index={index + 1}
              >
                <button
                  type="button"
                  className="task-check"
                  aria-label={task.done ? `标记任务未完成：${task.title}` : `标记任务完成：${task.title}`}
                  onClick={() => {
                    setTasks((current) => current.map((item) => (
                      item.id === task.id ? { ...item, done: !item.done } : item
                    )))
                  }}
                >
                  {task.done ? <Check size={12} /> : <Circle size={11} />}
                </button>
                <span className="task-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="task-title" title={task.title}>{task.title}</span>
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
        <ArrowDown size={18} className="task-panel-toggle-icon" />
      </button>
    </section>
  )
}
