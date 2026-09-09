// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SubagentsToggle } from '../../src/renderer/src/features/chat/SubagentsToggle'
import { readFileSync } from 'node:fs'

it('uses a neutral off-hover and a solid accent for enabled state', () => {
  const css = readFileSync('src/renderer/src/styles/composer.css', 'utf8')
  expect(css).toMatch(/\.composer-subagents-toggle\[aria-pressed='false'\]:hover:not\(:disabled\)\s*\{[^}]*background: var\(--bg-hover\)/)
  expect(css).toMatch(/\.composer-subagents-toggle\[aria-pressed='true'\]\s*\{[^}]*background: var\(--accent\)/)
})

it('keeps hover distinct from the reported on/off state and prevents duplicate toggles', async () => {
  let resolve!: () => void
  const onChange = vi.fn(() => new Promise<void>((done) => { resolve = done }))
  const { rerender } = render(<SubagentsToggle enabled={false} disabled={false} onChange={onChange} />)
  const button = screen.getByRole('button', { name: '子代理' })
  expect(button).toHaveAttribute('aria-pressed', 'false')
  fireEvent.mouseEnter(button)
  expect(button).toHaveTextContent('已关闭')
  expect(button).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(button)
  fireEvent.click(button)
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
  expect(button).toBeDisabled()
  expect(button).toHaveTextContent('切换中…')
  await act(async () => resolve())
  rerender(<SubagentsToggle enabled disabled={false} onChange={onChange} />)
  expect(button).toHaveAttribute('aria-pressed', 'true')
  expect(button).toHaveTextContent('已开启')
  expect(button).not.toBeDisabled()
})

it('keeps the reported mode unchanged on failure and renders the error', async () => {
  render(<SubagentsToggle enabled disabled={false} onChange={async () => { throw new Error('会话已切换') }} />)
  fireEvent.click(screen.getByRole('button', { name: '子代理' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('会话已切换')
  expect(screen.getByRole('button', { name: '子代理' })).toHaveAttribute('aria-pressed', 'true')
})

it('does not carry an old session failure into a new control', async () => {
  let reject!: (error: Error) => void
  const onChange = () => new Promise<void>((_resolve, fail) => { reject = fail })
  const { rerender } = render(<SubagentsToggle key="a" enabled disabled={false} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: '子代理' }))
  rerender(<SubagentsToggle key="b" enabled={false} disabled={false} onChange={onChange} />)
  await act(async () => reject(new Error('old failure')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '子代理' })).toHaveAttribute('aria-pressed', 'false')
})
