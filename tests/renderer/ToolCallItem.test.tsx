// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
  it('reveals live tool headers and details as streamed text arrives', () => {
    const { container } = render(<ToolCallItem tool={liveTool} />)

    const head = screen.getByRole('button', { name: '展开终端工具详情' })
    fireEvent.click(head)
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
  })

  it('keeps paged history outside the live reveal path', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical />)

    expect(container.querySelector('[data-live-output="tool-head"]')).toBeInTheDocument()
    expect(container.querySelector('.tool-head')).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
  })
})
