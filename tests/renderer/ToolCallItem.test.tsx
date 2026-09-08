// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallItem } from '../../src/renderer/src/features/chat/ToolCallItem'
import type { ToolItem } from '../../src/renderer/src/agent/types'

const liveTool: ToolItem = {
  id: 'tool-1',
  name: 'bash',
  status: 'running',
  isError: false,
  command: 'printf output',
  outputText: 'output',
  live: true
}

describe('ToolCallItem', () => {
  it('labels the built-in question tool without requiring a plugin renderer', () => {
    render(<ToolCallItem tool={{ ...liveTool, name: 'pion_ask_user', command: undefined }} noReveal />)
    expect(screen.getByRole('button', { name: '展开提问工具详情' })).toBeInTheDocument()
  })

  it('reveals live tool headers and details as streamed text arrives', () => {
    const { container } = render(<ToolCallItem tool={liveTool} />)

    const head = screen.getByRole('button', { name: '展开终端工具详情' })
    fireEvent.click(head)
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
  })

  it('animates details closed before releasing their DOM', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<ToolCallItem tool={liveTool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
      expect(container.querySelector('.tool-body')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '收起终端工具详情' }))
      expect(container.querySelector('.animated-disclosure')).toHaveAttribute('aria-hidden', 'true')
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('.tool-body')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps paged history outside the live reveal path', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical />)

    expect(container.querySelector('[data-live-output="tool-head"]')).toBeInTheDocument()
    expect(container.querySelector('.tool-head')).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
  })
})
