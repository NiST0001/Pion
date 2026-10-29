// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatTimeline, type ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import * as activity from '../../src/renderer/src/agent/toolActivityGroups'
import type { TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'

const tool = (id: number, extra: Partial<ToolItem> = {}): activity.ToolTimelineItem => ({ kind: 'tool', id,
  tool: { id: `call-${id}`, name: 'read', path: 'same.ts', outputText: 'same output', status: 'done', isError: false, ...extra } })
const boundary: TimelineItem = { kind: 'assistant', id: 100, text: '', thinking: '', streaming: false, noReveal: true }
const props = (timeline: TimelineItem[]): ChatTimelineProps => ({
  scopeKey: 'session-a', scrollRef: createRef(), onScroll: vi.fn(), timeline, timelineLoading: false,
  busy: false, starting: false, hasSessions: true, canFork: false, onFork: vi.fn(), agentActivity: false,
  workingStatus: { label: '' }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('tool group indexed identity and memoized projection', () => {
  it('keeps the earliest old header on merge, then retains flat tool DOM/detail state through split and prepend', () => {
    vi.useFakeTimers()
    const a = tool(1), b = tool(2), c = tool(3)
    const p = props([a, boundary, b, c])
    const view = render(<ChatTimeline {...p} />)
    const first = view.getByRole('button', { name: '展开工具调用（1次）' })
    const second = view.getByRole('button', { name: '展开工具调用（2次）' })
    fireEvent.click(second)
    const detail = view.getAllByRole('button', { name: '展开读取工具详情' })[0]
    fireEvent.click(detail)
    const body = view.container.querySelector('.tool-body')
    const wrapper = detail.closest('.tool-activity-item')!
    // Current ID order starts in the second old group; the first old group wins.
    view.rerender(<ChatTimeline {...p} timeline={[b, a, c]} />)
    expect(view.getByRole('button', { name: '展开工具调用（3次）' })).toBe(first)
    expect(second.isConnected).toBe(false)
    expect(wrapper).toHaveAttribute('inert')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    expect(view.container.querySelector('.tool-body')).toBe(body)
    fireEvent.click(first)
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(detail)

    view.rerender(<ChatTimeline {...p} timeline={[a, boundary, b, c]} />)
    expect(view.getByRole('button', { name: '收起工具调用（1次）' })).toBe(first)
    const split = view.getByRole('button', { name: '展开工具调用（2次）' })
    expect(split).not.toBe(second)
    expect(wrapper).toHaveAttribute('data-open', 'false')
    act(() => vi.advanceTimersByTime(200))
    expect(wrapper).toHaveAttribute('hidden')
    expect(view.container.querySelector('.tool-body')).toBe(body)
    fireEvent.click(split)
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(detail)

    view.rerender(<ChatTimeline {...p} timeline={[tool(0), a, boundary, b, c]} />)
    expect(view.getAllByRole('button', { name: '收起工具调用（2次）' })).toEqual([first, split])
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(detail)
    expect(view.container.querySelector('.tool-body')).toBe(body)
    expect(p.onFork).not.toHaveBeenCalled()
    expect(p.onScroll).not.toHaveBeenCalled()
  })

  it('keeps equivalent same-text refreshes mounted and never transfers openness to a new real call ID', () => {
    const p = props([tool(1)])
    const view = render(<ChatTimeline {...p} />)
    const group = view.getByRole('button', { name: '展开工具调用（1次）' })
    fireEvent.click(group)
    const head = view.getByRole('button', { name: '展开读取工具详情' })
    const classes = [group.className, head.className]
    view.rerender(<ChatTimeline {...p} timeline={[{ ...tool(1), historical: true, noReveal: true }]} />)
    expect(view.getByRole('button', { name: '收起工具调用（1次）' })).toBe(group)
    expect(view.getByRole('button', { name: '展开读取工具详情' })).toBe(head)
    expect([group.className, head.className]).toEqual(classes)
    view.rerender(<ChatTimeline {...p} timeline={[tool(2)]} />)
    expect(view.getByRole('button', { name: '展开工具调用（1次）' })).not.toBe(group)
    expect(view.container.querySelector('.tool-call')).toBeNull()
  })

  it('reuses summaries on unrelated state/disclosure updates and invalidates on new timeline fields/objects and final results', () => {
    const summarize = vi.spyOn(activity, 'summarizeToolActivity')
    const project = vi.spyOn(activity, 'retainToolActivityGroups')
    const first = tool(1, { status: 'running' }), second = tool(2)
    const p = props([first, second])
    const view = render(<ChatTimeline {...p} />)
    const group = view.getByRole('button', { name: '展开工具调用（2次）' })
    expect(group).toHaveTextContent('读取1个文件执行中')
    expect(summarize).toHaveBeenCalledTimes(1)
    view.rerender(<ChatTimeline {...p} busy agentActivity workingStatus={{ label: 'working' }} />)
    fireEvent.click(group)
    fireEvent.click(group)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(project).toHaveBeenCalledTimes(1)

    // A new timeline also invalidates field revisions on a retained tool object.
    first.tool.status = 'done'
    first.tool.outputText = ''
    view.rerender(<ChatTimeline {...p} timeline={[first, second]} />)
    expect(group).not.toHaveTextContent('执行中')
    expect(summarize).toHaveBeenCalledTimes(2)
    view.rerender(<ChatTimeline {...p} timeline={[tool(1, { status: 'error', isError: true }), second]} />)
    expect(group).toHaveTextContent('1项失败')
    view.rerender(<ChatTimeline {...p} timeline={[tool(1, { path: 'other.ts' }), second]} />)
    expect(group).toHaveTextContent('读取2个文件')
    expect(group).not.toHaveTextContent('1项失败')
    view.rerender(<ChatTimeline {...p} timeline={[tool(1, { name: 'grep' }), second]} />)
    expect(group).toHaveTextContent('读取1个文件 · 搜索1次')
  })

  it('keeps read-only/hidden transcript disclosure local without media elements or scroll callbacks', () => {
    const p = props([tool(1, { images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png', width: 1, height: 1, partIndex: 0 }] })])
    const view = render(<ChatTimeline {...p} readOnly />)
    const group = view.getByRole('button', { name: '展开工具调用（1次）' })
    fireEvent.click(group)
    fireEvent.click(view.getByRole('button', { name: '展开读取工具详情' }))
    const body = view.container.querySelector('.tool-body')
    expect(view.container.querySelector('img')).toBeNull()
    view.rerender(<ChatTimeline {...p} readOnly hidden />)
    expect(view.container.querySelector('.chat-scroll')).toHaveAttribute('inert')
    expect(view.container.querySelector('.tool-body')).toBe(body)
    view.rerender(<ChatTimeline {...p} readOnly />)
    expect(view.getByRole('button', { name: '收起工具调用（1次）' })).toBe(group)
    expect(view.container.querySelector('.tool-body')).toBe(body)
    expect(view.container.querySelector('img')).toBeNull()
    expect(p.onFork).not.toHaveBeenCalled()
    expect(p.onScroll).not.toHaveBeenCalled()
  })
})
