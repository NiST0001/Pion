// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TaskPanel } from '../../src/renderer/src/components/TaskPanel'

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
})
