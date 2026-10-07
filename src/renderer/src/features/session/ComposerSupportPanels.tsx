import type { ReactNode } from 'react'
import type { AgentTodo } from '../../agent/types'
import { hasIncompleteTasks } from '../../../../shared/task-history'

/** Stable grid slots let a queue ease in beside tasks without remounting either
 * panel or changing the conversation viewport's height. */
export function ComposerSupportPanels({ hasTasks, agentTodos, hasQueue, task, queue }: {
  hasTasks: boolean
  agentTodos?: AgentTodo[] | null
  hasQueue: boolean
  task: ReactNode
  queue: ReactNode
}) {
  const showTasks = hasTasks && (agentTodos === undefined || hasIncompleteTasks(agentTodos))
  if (!showTasks && !hasQueue) return null
  return <div className={`composer-support-row${showTasks ? ' has-task-panel' : ''}${hasQueue ? ' has-queue-panel' : ''}`}>
    <div className="composer-task-slot" aria-hidden={!showTasks} inert={!showTasks}>{task}</div>
    <div className="composer-queue-slot" aria-hidden={!hasQueue} inert={!hasQueue}>{queue}</div>
  </div>
}
