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

  it('releases live character spans and does not recreate them for a header-only update', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<ToolCallItem tool={liveTool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
      act(() => vi.advanceTimersByTime(300))
      const body = container.querySelector('.tool-output')
      expect(body?.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      rerender(<ToolCallItem tool={{ ...liveTool, status: 'done' }} />)
      expect(container.querySelector('.tool-output')).toBe(body)
      expect(body?.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      expect(body).toHaveTextContent('output')
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps noReveal detail content outside character animation too', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
    expect(container.querySelector('.tool-output')).toHaveTextContent('output')
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('keeps paged history outside the live reveal path', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical />)

    expect(container.querySelector('[data-live-output="tool-head"]')).toBeInTheDocument()
    expect(container.querySelector('.tool-head')).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
  })
})
