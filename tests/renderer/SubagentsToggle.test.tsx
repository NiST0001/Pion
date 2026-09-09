// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SubagentsToggle } from '../../src/renderer/src/features/chat/SubagentsToggle'

it('starts off, reports the active state and prevents duplicate in-flight toggles', async () => {
  let resolve!: () => void
  const onChange = vi.fn(() => new Promise<void>((done) => { resolve = done }))
  const { rerender } = render(<SubagentsToggle enabled={false} disabled={false} onChange={onChange} />)
  const button = screen.getByRole('button', { name: '子 Agent' })
  expect(button).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(button)
  fireEvent.click(button)
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
  expect(button).toBeDisabled()
  await act(async () => resolve())
  rerender(<SubagentsToggle enabled disabled={false} onChange={onChange} />)
  expect(button).toHaveAttribute('aria-pressed', 'true')
  expect(button).not.toBeDisabled()
})

it('keeps the reported mode unchanged on failure and renders the error', async () => {
  render(<SubagentsToggle enabled disabled={false} onChange={async () => { throw new Error('会话已切换') }} />)
  fireEvent.click(screen.getByRole('button', { name: '子 Agent' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('会话已切换')
  expect(screen.getByRole('button', { name: '子 Agent' })).toHaveAttribute('aria-pressed', 'true')
})

it('does not carry an old session failure into a new control', async () => {
  let reject!: (error: Error) => void
  const onChange = () => new Promise<void>((_resolve, fail) => { reject = fail })
  const { rerender } = render(<SubagentsToggle key="a" enabled disabled={false} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: '子 Agent' }))
  rerender(<SubagentsToggle key="b" enabled={false} disabled={false} onChange={onChange} />)
  await act(async () => reject(new Error('old failure')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '子 Agent' })).toHaveAttribute('aria-pressed', 'false')
})
