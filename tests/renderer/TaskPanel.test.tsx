// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TaskPanel } from '../../src/renderer/src/features/session/TaskPanel'

beforeEach(() => window.localStorage.clear())

describe('TaskPanel', () => {
  it('toggles from the full header without a separate fold button', () => {
    const { container } = render(
      <TaskPanel
        sessionKey="session-a"
        agentTodos={[{ id: 1, title: 'Inspect task panel', status: 'pending' }]}
      />
    )

    const header = screen.getByRole('button', { name: '展开本轮任务' })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.task-panel-toggle')).not.toBeInTheDocument()

    fireEvent.click(header)
    expect(screen.getByRole('button', { name: '收起本轮任务' })).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.task-panel')).toHaveClass('expanded')

    fireEvent.click(screen.getByRole('button', { name: '收起本轮任务' }))
    expect(container.querySelector('.task-panel')).toHaveClass('collapsed')
    expect(window.localStorage.getItem('pion:session-task-panel-state:session-a')).toBe('false')
  })

  it('keeps completed rows visible as the finished current turn', () => {
    const { container } = render(
      <TaskPanel
        sessionKey="session-completed"
        agentTodos={[{ id: 1, title: 'Finish this turn', status: 'completed' }]}
      />
    )

    expect(screen.getByText('本轮已完成')).toBeInTheDocument()
    expect(screen.getByText('Finish this turn').closest('.task-item')).toHaveClass('done')
    expect(container.querySelector('[data-task-status="completed"]')).toBeInTheDocument()
  })

})
