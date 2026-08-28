import { useState } from 'react'
import type { ReactElement } from 'react'
import { ArrowDown, Check, Circle, ListTodo } from 'lucide-react'

interface TaskTarget {
  id: string
  title: string
  done: boolean
}

const DEFAULT_TASKS: TaskTarget[] = [
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

/** Compact, expandable work-plan surface docked above the composer. */
export function TaskPanel(): ReactElement {
  const [expanded, setExpanded] = useState(true)
  const [tasks, setTasks] = useState(DEFAULT_TASKS)
  const completed = tasks.filter((task) => task.done).length

  return (
    <section className={`task-panel${expanded ? ' expanded' : ' collapsed'}`}>
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
