// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTodo } from '../../src/renderer/src/agent/types'
import { TaskPanel } from '../../src/renderer/src/features/session/TaskPanel'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('TaskPanel', () => {
  it('toggles from the full header without a separate fold button', () => {
    const { container } = render(
      <TaskPanel
        sessionKey="session-a"
        agentTodos={[{ id: 1, title: 'Inspect task panel', status: 'pending' }]}
      />
    )

    const header = screen.getByRole('button', { name: '展开目标任务' })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.task-panel-toggle')).not.toBeInTheDocument()

    fireEvent.click(header)
    expect(screen.getByRole('button', { name: '收起目标任务' })).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.task-panel')).toHaveClass('expanded')

    fireEvent.click(screen.getByRole('button', { name: '收起目标任务' }))
    expect(container.querySelector('.task-panel')).toHaveClass('collapsed')
    expect(window.localStorage.getItem('pion:session-task-panel-state:session-a')).toBe('false')
  })

  it('hides completed goals without deleting the task snapshot', () => {
    const tasks: AgentTodo[] = [{ id: 1, title: 'Finish this goal', status: 'completed' }]
    const { container } = render(
      <TaskPanel sessionKey="session-completed" agentBusy agentTodos={tasks} />
    )

    expect(container).toBeEmptyDOMElement()
    expect(tasks).toEqual([{ id: 1, title: 'Finish this goal', status: 'completed' }])
  })

  it('retains completed progress alongside pending authorization even when idle', () => {
    const { container } = render(
      <TaskPanel sessionKey="session-waiting" agentBusy={false} agentTodos={[
        { id: 1, title: 'Inspected', status: 'completed' },
        { id: 2, title: 'Waiting for authorization', status: 'pending' },
        { id: 3, title: 'Discarded', status: 'deleted' }
      ]} />
    )

    expect(screen.getByText('1/2 已完成')).toBeInTheDocument()
    expect(screen.getByText('Inspected').closest('.task-item')).toHaveClass('done')
    expect(screen.getByText('Waiting for authorization')).toBeInTheDocument()
    expect(screen.queryByText('Discarded')).not.toBeInTheDocument()
    expect(container.querySelector('.task-panel')).not.toHaveClass('running')
  })

  it.each(([[], [{ id: 1, title: 'Discarded', status: 'deleted' }], [
    { id: 1, title: 'Finished', status: 'completed' },
    { id: 2, title: 'Discarded', status: 'deleted' }
  ]] as AgentTodo[][]).map((tasks) => ({ tasks })))('hides an empty or finished remaining plan: %j', ({ tasks }) => {
    const { container } = render(<TaskPanel sessionKey="session-empty" agentTodos={tasks} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['in_progress', 'waiting', undefined])('keeps active or unknown status %s visible even when idle', (status) => {
    const tasks = [{ id: 1, title: 'Unknown task', status }] as unknown as AgentTodo[]
    render(<TaskPanel sessionKey="session-unknown" agentBusy={false} agentTodos={tasks} />)
    expect(screen.getByText('Unknown task')).toBeInTheDocument()
    expect(screen.getByText('当前目标')).toBeInTheDocument()
  })

  it('preserves expansion when a completed goal is resumed in the same session', () => {
    const tasks: AgentTodo[] = [{ id: 1, title: 'Continue this goal', status: 'pending' }]
    const { container, rerender } = render(<TaskPanel sessionKey="session-resume" agentTodos={tasks} />)
    fireEvent.click(screen.getByRole('button', { name: '展开目标任务' }))

    rerender(<TaskPanel sessionKey="session-resume" agentTodos={[{ ...tasks[0], status: 'completed' }]} />)
    expect(container).toBeEmptyDOMElement()
    expect(window.localStorage.getItem('pion:session-task-panel-state:session-resume')).toBe('true')

    rerender(<TaskPanel sessionKey="session-resume" agentBusy={false} agentTodos={tasks} />)
    expect(screen.getByRole('button', { name: '收起目标任务' })).toHaveAttribute('aria-expanded', 'true')
  })
})
