// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTodo } from '../../src/renderer/src/agent/types'
import { TaskPanel } from '../../src/renderer/src/features/session/TaskPanel'
import { ComposerSupportPanels } from '../../src/renderer/src/features/session/ComposerSupportPanels'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

it('keeps task state and stable grid slots when a queue arrives and leaves', () => {
  const mount = vi.fn()
  function Task() { useEffect(() => { mount() }, []); return <input aria-label="task draft" defaultValue="" /> }
  const content = { task: <Task />, queue: <button>queued action</button> }
  const { container, rerender } = render(<ComposerSupportPanels hasTasks hasQueue={false} {...content} />)
  const row = container.firstElementChild
  const taskSlot = container.querySelector('.composer-task-slot')
  const queueSlot = container.querySelector('.composer-queue-slot')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this' } })
  expect(queueSlot).toHaveAttribute('inert')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  rerender(<ComposerSupportPanels hasTasks hasQueue {...content} />)
  expect(row).toHaveClass('has-task-panel', 'has-queue-panel')
  expect(container.querySelector('.composer-task-slot')).toBe(taskSlot)
  expect(container.querySelector('.composer-queue-slot')).toBe(queueSlot)
  expect(screen.getByRole('button')).toHaveTextContent('queued action')
  rerender(<ComposerSupportPanels hasTasks hasQueue={false} {...content} />)
  expect(row).not.toHaveClass('has-queue-panel')
  expect(screen.getByRole('textbox')).toHaveValue('keep this')
  expect(mount).toHaveBeenCalledTimes(1)
})

it.each(([
  [],
  [{ id: 1, title: 'Finished', status: 'completed' }],
  [{ id: 1, title: 'Deleted', status: 'deleted' }]
] as AgentTodo[][]).map((agentTodos) => ({ agentTodos })))('does not reserve a floating slot for a finished or empty goal: %j', ({ agentTodos }) => {
  const { container } = render(<ComposerSupportPanels hasTasks agentTodos={agentTodos} hasQueue={false}
    task={<TaskPanel sessionKey="finished" agentTodos={agentTodos} />} queue={null} />)
  expect(container).toBeEmptyDOMElement()
})

it('collapses the task slot on live completion without remounting the queue or composer input', () => {
  const queueMount = vi.fn()
  function Queue() {
    useEffect(() => { queueMount() }, [])
    return <button>queued action</button>
  }
  const initial: AgentTodo[] = [
    { id: 1, title: 'Finished inspection', status: 'completed' },
    { id: 2, title: 'Waiting for authorization', status: 'pending' }
  ]
  function Content({ tasks, hasQueue = true }: { tasks: AgentTodo[]; hasQueue?: boolean }) {
    return <>
      <ComposerSupportPanels hasTasks agentTodos={tasks} hasQueue={hasQueue}
        task={<TaskPanel sessionKey="live-goal" agentBusy={false} agentTodos={tasks} />}
        queue={<Queue />} />
      <input aria-label="composer draft" defaultValue="" />
    </>
  }
  const { container, rerender } = render(<Content tasks={initial} />)
  const row = container.querySelector('.composer-support-row')
  const taskSlot = container.querySelector('.composer-task-slot')
  const queueSlot = container.querySelector('.composer-queue-slot')
  const queue = screen.getByRole('button', { name: 'queued action' })
  const input = screen.getByRole('textbox', { name: 'composer draft' })
  fireEvent.change(input, { target: { value: 'preserve my draft' } })
  fireEvent.click(screen.getByRole('button', { name: '展开目标任务' }))
  expect(row).toHaveClass('has-task-panel', 'has-queue-panel')
  expect(screen.getByText('1/2 已完成')).toBeInTheDocument()

  const completed = initial.map((task): AgentTodo => ({ ...task, status: 'completed' }))
  rerender(<Content tasks={completed} />)
  expect(container.querySelector('.composer-support-row')).toBe(row)
  expect(row).not.toHaveClass('has-task-panel')
  expect(row).toHaveClass('has-queue-panel')
  expect(container.querySelector('.composer-task-slot')).toBe(taskSlot)
  expect(taskSlot).toHaveAttribute('inert')
  expect(taskSlot).toHaveAttribute('aria-hidden', 'true')
  expect(taskSlot).toBeEmptyDOMElement()
  expect(container.querySelector('.composer-queue-slot')).toBe(queueSlot)
  expect(screen.getByRole('button', { name: 'queued action' })).toBe(queue)
  expect(screen.getByRole('textbox', { name: 'composer draft' })).toBe(input)
  expect(input).toHaveValue('preserve my draft')
  expect(queueMount).toHaveBeenCalledTimes(1)

  rerender(<Content tasks={initial} />)
  expect(row).toHaveClass('has-task-panel')
  expect(screen.getByRole('button', { name: '收起目标任务' })).toHaveAttribute('aria-expanded', 'true')
  expect(taskSlot).not.toHaveAttribute('inert')
  expect(screen.getByRole('textbox', { name: 'composer draft' })).toBe(input)

  rerender(<Content tasks={completed} hasQueue={false} />)
  expect(container.querySelector('.composer-support-row')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'composer draft' })).toBe(input)
  expect(input).toHaveValue('preserve my draft')

  rerender(<Content tasks={initial} hasQueue={false} />)
  expect(screen.getByRole('button', { name: '收起目标任务' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('textbox', { name: 'composer draft' })).toBe(input)
})
