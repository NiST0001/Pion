// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComposerSupportPanels } from '../../src/renderer/src/features/session/ComposerSupportPanels'

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
