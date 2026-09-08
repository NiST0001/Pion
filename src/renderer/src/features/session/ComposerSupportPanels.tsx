import type { ReactNode } from 'react'

/** Stable grid slots let a queue ease in beside tasks without remounting either
 * panel or changing the conversation viewport's height. */
export function ComposerSupportPanels({ hasTasks, hasQueue, task, queue }: {
  hasTasks: boolean
  hasQueue: boolean
  task: ReactNode
  queue: ReactNode
}) {
  if (!hasTasks && !hasQueue) return null
  return <div className={`composer-support-row${hasTasks ? ' has-task-panel' : ''}${hasQueue ? ' has-queue-panel' : ''}`}>
    <div className="composer-task-slot" aria-hidden={!hasTasks} inert={!hasTasks}>{task}</div>
    <div className="composer-queue-slot" aria-hidden={!hasQueue} inert={!hasQueue}>{queue}</div>
  </div>
}
