// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatTimeline, type ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

const tool = (id: number, name = 'read'): TimelineItem => ({ kind: 'tool', id,
  tool: { id: `call-${id}`, name, path: `file-${id}.ts`, status: 'done', isError: false, outputText: `output-${id}` } })
const props = (timeline: TimelineItem[]): ChatTimelineProps => ({
  scopeKey: 'session-a', scrollRef: createRef(), onScroll: vi.fn(), timeline, timelineLoading: false,
  busy: false, starting: false, hasSessions: true, canFork: false, onFork: vi.fn(), agentActivity: false,
  workingStatus: { label: '' }, latestRunChanges: [], runCheckpoint: null, rollbackBusy: false,
  rollbackError: '', onUndo: vi.fn(), onReview: vi.fn(), onSelectChange: vi.fn()
})
afterEach(cleanup)

describe('tool activity timeline integration', () => {
  it('starts as one compact row and mounts ordinary tool cards only when opened', () => {
    const view = render(<ChatTimeline {...props([tool(1), tool(2), tool(3, 'bash')])} />)
    expect(view.getByRole('button', { name: '展开工具调用（3次）' })).toHaveTextContent('读取2个文件 · 终端1次')
    expect(view.container.querySelector('.tool-call')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（3次）' }))
    expect(view.getAllByRole('button', { name: '展开读取工具详情' })).toHaveLength(2)
    expect(view.container.querySelectorAll('.tool-call')).toHaveLength(3)
  })

  it('keeps group and tool detail DOM/state on collapse, growth, status changes and older prepend', () => {
    const p = props([tool(2), tool(3)])
    const view = render(<ChatTimeline {...p} />)
    const group = view.getByRole('button', { name: '展开工具调用（2次）' })
    fireEvent.click(group)
    const head = view.getAllByRole('button', { name: '展开读取工具详情' })[0]
    fireEvent.click(head)
    const body = view.container.querySelector('.tool-body')
    fireEvent.click(group)
    expect(head.isConnected).toBe(true)
    expect(head).not.toBeVisible()
    expect(view.container.querySelector('.tool-body')).toBe(body)
    fireEvent.click(group)
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(head)
    view.rerender(<ChatTimeline {...p} timeline={[tool(1), tool(2), tool(3), tool(4)]} />)
    expect(view.getByRole('button', { name: '收起工具调用（4次）' })).toBe(group)
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(head)
    expect(view.container.querySelector('.tool-body')).toBe(body)
    view.rerender(<ChatTimeline {...p} timeline={[tool(1), { ...tool(2), kind: 'tool',
      tool: { id: 'call-2', name: 'read', path: 'file-2.ts', status: 'error', isError: true } }, tool(3), tool(4)]} />)
    expect(group).toHaveTextContent('1项失败')
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(head)
  })

  it('does not join across messages or compaction and opens each group independently', () => {
    const p = props([tool(1), { kind: 'user', id: 2, text: 'next' }, tool(3, 'bash')])
    const view = render(<ChatTimeline {...p} readOnly />)
    const groups = view.getAllByRole('button', { name: '展开工具调用（1次）' })
    fireEvent.click(groups[1])
    expect(groups[0]).toHaveAttribute('aria-expanded', 'false')
    expect(view.queryByRole('button', { name: '展开读取工具详情' })).toBeNull()
    expect(view.container.querySelectorAll('.tool-call')).toHaveLength(1)
    for (const callback of [p.onFork, p.onUndo, p.onReview, p.onSelectChange]) expect(callback).not.toHaveBeenCalled()
  })

  it('resets disclosure for a different real transcript even when display IDs collide', () => {
    const p = props([tool(1)])
    const view = render(<ChatTimeline {...p} />)
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（1次）' }))
    view.rerender(<ChatTimeline {...p} scopeKey="session-b" />)
    expect(view.getByRole('button', { name: '展开工具调用（1次）' })).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelector('.tool-call')).toBeNull()
  })
})
