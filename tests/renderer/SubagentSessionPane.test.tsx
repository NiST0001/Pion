// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SubagentSessionPane } from '../../src/renderer/src/features/session/SubagentSessionPane'
import type { SubagentSessionSnapshot } from '../../src/shared/subagent-sessions'

const snapshot: SubagentSessionSnapshot = {
  id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool', parentSessionId: 'parent',
  cwd: '/project', parentSessionPath: '/parent.jsonl', name: '代码检查', status: 'completed', revision: 1, truncated: false,
  rows: [
    { id: 'a', kind: 'assistant', text: '<img src="https://example.test/image"> [链接](https://example.test) **原文**' },
    { id: 't', kind: 'thinking', text: '私有思考' },
    { id: 'tool', kind: 'tool', text: '<script>alert(1)</script>', toolName: 'read', state: 'completed' }
  ]
}
describe('SubagentSessionPane', () => {
  it('shows readonly child output as inert text with independent scrolling and collapsible details', () => {
    const onClose = vi.fn()
    const { container } = render(<SubagentSessionPane snapshot={snapshot} loading={false} error="" onClose={onClose} parentName="父任务" />)
    expect(screen.getByText('只读 · 临时会话 · 结束后保留 30 分钟')).toBeInTheDocument()
    expect(screen.getByText('父会话：父任务')).toBeInTheDocument()
    expect(screen.getByText(snapshot.rows[0].text)).toBeInTheDocument()
    expect(container.querySelector('img,a,script,textarea,input')).toBeNull()
    expect(container.querySelectorAll('details')).toHaveLength(2)
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    expect(screen.getByLabelText('子会话内容')).toHaveClass('subagent-session-pane-scroll')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '返回父会话' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('allows closing loading, error and empty states without any SDK action', () => {
    const onClose = vi.fn()
    const { rerender } = render(<SubagentSessionPane snapshot={null} loading error="" onClose={onClose} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在读取')
    fireEvent.click(screen.getByRole('button'))
    rerender(<SubagentSessionPane snapshot={null} loading={false} error="读取失败" onClose={onClose} />)
    expect(screen.getByRole('alert')).toHaveTextContent('读取失败')
    fireEvent.click(screen.getByRole('button'))
    rerender(<SubagentSessionPane snapshot={{ ...snapshot, rows: [] }} loading={false} error="" onClose={onClose} />)
    expect(screen.getByText('暂无可显示的子会话记录。')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
