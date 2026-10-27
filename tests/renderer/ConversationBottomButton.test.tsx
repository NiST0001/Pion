// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationBottomButton } from '../../src/renderer/src/features/chat/ConversationBottomButton'

afterEach(cleanup)

it('provides an accessible native button and explicitly navigates on click', () => {
  const onClick = vi.fn()
  const view = render(<ConversationBottomButton visible onClick={onClick} />)
  const button = view.getByRole('button', { name: '回到底部' })
  expect(button).toHaveAttribute('type', 'button')
  expect(button).toHaveAttribute('title', '回到底部')
  expect(button).toHaveClass('icon-button', 'conversation-bottom-button')
  expect(button).not.toHaveAttribute('hidden')
  expect(button).not.toHaveAttribute('inert')
  expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  expect(button.querySelector('svg')).toHaveAttribute('width', '16')
  expect(onClick).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledOnce()
})

it('keeps the same button hidden and inert when visibility is off or the parent view is hidden', () => {
  const onClick = vi.fn()
  const view = render(<ConversationBottomButton visible={false} onClick={onClick} />)
  const button = view.container.querySelector('button')!
  expect(button).toHaveAttribute('hidden')
  expect(button).toHaveAttribute('inert')
  expect(view.queryByRole('button', { name: '回到底部' })).toBeNull()
  view.rerender(<ConversationBottomButton visible hidden onClick={onClick} />)
  expect(view.container.querySelector('button')).toBe(button)
  expect(button).toHaveAttribute('hidden')
  expect(button).toHaveAttribute('inert')
  view.rerender(<ConversationBottomButton visible onClick={onClick} />)
  expect(view.getByRole('button', { name: '回到底部' })).toBe(button)
  expect(button).not.toHaveAttribute('hidden')
  expect(button).not.toHaveAttribute('inert')
  expect(onClick).not.toHaveBeenCalled()
})

it('respects disabled without dispatching navigation', () => {
  const onClick = vi.fn()
  const view = render(<ConversationBottomButton visible disabled onClick={onClick} />)
  const button = view.getByRole('button', { name: '回到底部' })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()
})
