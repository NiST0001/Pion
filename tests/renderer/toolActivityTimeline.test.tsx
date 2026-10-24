// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatTimeline, type ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

const tool = (id: number, name = 'read'): TimelineItem => ({ kind: 'tool', id,
  tool: { id: `call-${id}`, name, path: `file-${id}.ts`, status: 'done', isError: false, outputText: `output-${id}` } })
// ToolDetails reads tool.outputText (not a timeline-level toolOutputText).
// Only live output or restored history enables character reveals; noReveal
// deliberately keeps ordinary text. Keep these real timeline shapes explicit.
const revealTool = (id: number, mode: 'live' | 'history', noReveal = false): TimelineItem => ({
  kind: 'tool', id, historical: mode === 'history', noReveal,
  tool: { id: `call-${id}`, name: 'read', path: `file-${id}.ts`, status: 'done', isError: false,
    outputText: `output-${id}`, live: mode === 'live' }
})
const props = (timeline: TimelineItem[]): ChatTimelineProps => ({
  scopeKey: 'session-a', scrollRef: createRef(), onScroll: vi.fn(), timeline, timelineLoading: false,
  busy: false, starting: false, hasSessions: true, canFork: false, onFork: vi.fn(), agentActivity: false,
  workingStatus: { label: '' }, latestRunChanges: [], runCheckpoint: null, rollbackBusy: false,
  rollbackError: '', onUndo: vi.fn(), onReview: vi.fn(), onSelectChange: vi.fn()
})
// Opt in only for reveal cases: JSDOM's zero rectangles otherwise prevent the
// managed root from admitting either lines or characters, regardless of gates.
function mockRevealFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const root = this.closest('.chat-scroll')
    const wrapper = this.closest('.tool-activity-item')
    if (root && wrapper) {
      const top = 60 + [...root.querySelectorAll('.tool-activity-item')].indexOf(wrapper) * 100
      if (this.closest('.animated-disclosure')) return new DOMRect(20, top + 32, 500, 60)
      if (this.classList.contains('tool-head')) return new DOMRect(20, top, 500, 24)
      return new DOMRect(10, top, 550, 92)
    }
    return this.classList.contains('tool-activity-header') ? new DOMRect(10, 20, 550, 28) : new DOMRect(0, 0, 600, 600)
  })
  const flushFrame = async () => {
    await act(async () => {
      await Promise.resolve() // Deliver gate/DOM mutations before taking the RAF snapshot.
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(performance.now()))
      await Promise.resolve() // Newly queued line/character work belongs to the next frame.
    })
  }
  return { flushFrame, frames }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

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
    expect(head.closest('.tool-activity-item')).toHaveAttribute('aria-hidden', 'true')
    expect(head.closest('.tool-activity-item')).toHaveAttribute('inert')
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

  it('keeps the closing layout briefly, then hides without dropping card state', () => {
    vi.useFakeTimers()
    const view = render(<ChatTimeline {...props([tool(1)])} />)
    const group = view.getByRole('button', { name: '展开工具调用（1次）' })
    fireEvent.click(group)
    const card = view.container.querySelector('.tool-call')
    const wrapper = card!.closest('.tool-activity-item')!
    fireEvent.click(group)
    expect(wrapper).toHaveAttribute('data-open', 'false')
    expect(wrapper).toHaveAttribute('inert')
    expect(wrapper).not.toHaveAttribute('hidden')
    act(() => vi.advanceTimersByTime(200))
    expect(wrapper).toHaveAttribute('hidden')
    expect(view.container.querySelector('.tool-call')).toBe(card)
    fireEvent.click(group)
    expect(wrapper).toHaveAttribute('data-open', 'true')
    expect(wrapper).not.toHaveAttribute('hidden')
    expect(view.container.querySelector('.tool-call')).toBe(card)
  })

  it('cancels the previous close on rapid reopening and cleans timers on unmount', () => {
    vi.useFakeTimers()
    const view = render(<ChatTimeline {...props([tool(1)])} />)
    const group = view.getByRole('button', { name: '展开工具调用（1次）' })
    fireEvent.click(group)
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(100))
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(200))
    expect(view.container.querySelector('.tool-activity-item')).not.toHaveAttribute('hidden')
    fireEvent.click(group)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hides immediately for reduced motion without introducing a close timer', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const view = render(<ChatTimeline {...props([tool(1)])} />)
    const group = view.getByRole('button', { name: '展开工具调用（1次）' })
    fireEvent.click(group)
    fireEvent.click(group)
    expect(view.container.querySelector('.tool-activity-item')).toHaveAttribute('hidden')
    expect(view.container.querySelector('.tool-call')).not.toBeNull()
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

  it.each(['live', 'history'] as const)('defers newly mounted %s tool headers until the outer group finishes expanding', async (mode) => {
    vi.useFakeTimers()
    const { flushFrame } = mockRevealFrames()
    const view = render(<ChatTimeline {...props([revealTool(1, mode), revealTool(2, mode)])} />)
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（2次）' }))
    const heads = view.getAllByRole('button', { name: '展开读取工具详情' })
    const gates = heads.map((head) => head.closest('.disclosure-reveal-gate')!)
    heads.forEach((head, index) => {
      expect(head).toHaveClass('screen-text-reveal-line')
      expect(gates[index]).toHaveAttribute('data-text-reveal-ready', 'false')
      expect(gates[index].parentElement).toHaveClass('tool-activity-inner')
      expect(head.closest('.tool-activity-item')).toHaveAttribute('data-open', 'true')
      expect(head.closest('.tool-activity-item')).not.toHaveAttribute('hidden')
    })
    act(() => vi.advanceTimersByTime(199))
    await flushFrame()
    gates.forEach((gate) => expect(gate).toHaveAttribute('data-text-reveal-ready', 'false'))
    heads.forEach((head) => expect(head).not.toHaveAttribute('data-line-reveal-ready'))
    act(() => vi.advanceTimersByTime(1))
    gates.forEach((gate) => expect(gate).toHaveAttribute('data-text-reveal-ready', 'true'))
    heads.forEach((head) => expect(head).not.toHaveAttribute('data-line-reveal-ready'))
    await flushFrame()
    heads.forEach((head) => expect(head).toHaveAttribute('data-line-reveal-ready', 'true'))
    expect(Number(heads[1].dataset.lineRevealStart)).toBeGreaterThan(Number(heads[0].dataset.lineRevealStart))
    view.getAllByRole('button', { name: '展开读取工具详情' }).forEach((head, index) => expect(head).toBe(heads[index]))
  })

  it.each([false, true])('uses one first-expansion waterfall for mixed history/live/noReveal heads and retains it on reopen (readOnly=%s)', async (readOnly) => {
    vi.useFakeTimers()
    const { flushFrame } = mockRevealFrames()
    const timeline = [revealTool(1, 'history'), revealTool(2, 'history', true), revealTool(3, 'live'), revealTool(4, 'live', true)]
    const p = props(timeline)
    const view = render(<ChatTimeline {...p} readOnly={readOnly} />)
    const group = view.getByRole('button', { name: '展开工具调用（4次）' })
    await flushFrame()
    fireEvent.click(group)
    const heads = view.getAllByRole('button', { name: '展开读取工具详情' })
    const tops = heads.map(head => head.getBoundingClientRect().top)
    expect(tops[0]).toBeGreaterThan(0)
    expect(new Set(tops).size).toBe(heads.length)
    heads.forEach(head => {
      expect(head).toHaveClass('screen-text-reveal-line', 'screen-text-reveal-line-history')
      expect(head).not.toHaveClass('screen-text-reveal-line-live')
      expect(head).not.toHaveAttribute('data-line-reveal-ready')
    })
    act(() => vi.advanceTimersByTime(199))
    await flushFrame()
    heads.forEach(head => expect(head).not.toHaveAttribute('data-line-reveal-ready'))
    act(() => vi.advanceTimersByTime(1))
    await flushFrame()
    const starts = heads.map(head => Number(head.dataset.lineRevealStart))
    heads.forEach((head, index) => {
      expect(head).toHaveAttribute('data-line-reveal-ready', 'true')
      if (index) expect(starts[index] - starts[index - 1]).toBe(20)
    })
    act(() => vi.advanceTimersByTime(600))
    // JSDOM does not run CSS animations. Deliver their actual completion, not
    // just elapsed timers, and require the animation to retire before hiding.
    for (const head of heads) {
      const event = new Event('animationend', { bubbles: true })
      Object.defineProperty(event, 'animationName', { value: 'screen-text-reveal' })
      fireEvent(head, event)
      expect(head).toHaveClass('screen-text-reveal-static')
    }
    const classes = heads.map(head => head.className)
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(200))
    heads.forEach(head => expect(head.closest('.tool-activity-item')).toHaveAttribute('hidden'))
    // Source flags can change after backfill; these already mounted heads cannot.
    view.rerender(<ChatTimeline {...p} readOnly={readOnly} timeline={timeline.map(item => ({ ...item, historical: false, noReveal: true }))} />)
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(200))
    await flushFrame()
    view.getAllByRole('button', { name: '展开读取工具详情' }).forEach((head, index) => {
      expect(head).toBe(heads[index])
      expect(head.className).toBe(classes[index])
      expect(Number(head.dataset.lineRevealStart)).toBe(starts[index])
    })
    for (const callback of [p.onFork, p.onUndo, p.onReview, p.onSelectChange]) expect(callback).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps passive history prepend/append static and freezes the retained group header (paged noReveal=%s)', async (noReveal) => {
    vi.useFakeTimers()
    const { flushFrame } = mockRevealFrames()
    const original = revealTool(2, 'history')
    const p = props([original])
    const view = render(<ChatTimeline {...p} />)
    const group = view.getByRole('button', { name: '展开工具调用（1次）' })
    await flushFrame()
    const groupClass = group.className
    const groupStart = group.dataset.lineRevealStart
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(200))
    await flushFrame()
    const retained = view.getByRole('button', { name: '展开读取工具详情' })
    const retainedStart = retained.dataset.lineRevealStart
    view.rerender(<ChatTimeline {...p} timeline={[
      revealTool(1, 'history', noReveal), { ...original, noReveal: true }, revealTool(3, 'live', true), revealTool(4, 'live')
    ]} />)
    expect(view.getByRole('button', { name: '收起工具调用（4次）' })).toBe(group)
    expect(group.className).toBe(groupClass)
    expect(group.dataset.lineRevealStart).toBe(groupStart)
    const heads = view.getAllByRole('button', { name: '展开读取工具详情' })
    expect(heads[1]).toBe(retained)
    expect(retained).toHaveClass('screen-text-reveal-line-history')
    expect(retained.dataset.lineRevealStart).toBe(retainedStart)
    for (const head of [heads[0], heads[2]]) expect(head).not.toHaveClass('screen-text-reveal-line')
    expect(heads[3]).toHaveClass('screen-text-reveal-line-live')
    expect(heads[3]).not.toHaveAttribute('data-line-reveal-ready')
    act(() => vi.advanceTimersByTime(200))
    await flushFrame()
    expect(heads[3]).toHaveAttribute('data-line-reveal-ready', 'true')
    const liveStart = heads[3].dataset.lineRevealStart
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(200))
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(200))
    await flushFrame()
    view.getAllByRole('button', { name: '展开读取工具详情' }).forEach((head, index) => expect(head).toBe(heads[index]))
    for (const head of [heads[0], heads[2]]) expect(head).not.toHaveClass('screen-text-reveal-line')
    expect(heads[3]).toHaveClass('screen-text-reveal-line-live')
    expect(heads[3].dataset.lineRevealStart).toBe(liveStart)
    expect(group.className).toBe(groupClass)
    expect(group.dataset.lineRevealStart).toBe(groupStart)
  })

  it.each(['live', 'history'] as const)('waits for both outer and nested gates before allocating %s detail characters, preserving DOM', async (mode) => {
    vi.useFakeTimers()
    const { flushFrame } = mockRevealFrames()
    const view = render(<ChatTimeline {...props([revealTool(1, mode), revealTool(2, mode)])} />)
    expect(view.container.querySelector('.chat-scroll')).toHaveAttribute('data-line-reveal-owner', 'true')
    await flushFrame()
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（2次）' }))
    const heads = view.getAllByRole('button', { name: '展开读取工具详情' })
    const outerGate = heads[0].closest('.disclosure-reveal-gate')!
    // The outer gate settles first; the nested gate still owns its full 200ms.
    act(() => vi.advanceTimersByTime(50))
    fireEvent.click(heads[0])
    const first = view.container.querySelector('.tool-output')!
    const firstGate = first.closest('.disclosure-reveal-gate')!
    expect(first).toHaveTextContent('output-1')
    expect(firstGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(first.closest('.animated-disclosure')).toHaveAttribute('data-open', 'true')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(149))
    await flushFrame()
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(firstGate).toHaveAttribute('data-text-reveal-ready', 'false')
    await flushFrame() // The visible opening detail blocks the following head.
    expect(heads[0]).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(heads[1]).not.toHaveAttribute('data-line-reveal-ready')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(49))
    expect(firstGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    expect(firstGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    await flushFrame() // Character admission follows its own gate and RAF.
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength('output-1'.length)
    await flushFrame() // Only the actual character commit releases the next head.
    expect(heads[1]).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(Number(heads[1].dataset.lineRevealStart)).toBeGreaterThan(Number(heads[0].dataset.lineRevealStart))

    // A later detail owns a new 200ms deadline, independent of the settled group.
    act(() => vi.advanceTimersByTime(50))
    fireEvent.click(heads[1])
    const second = view.container.querySelectorAll('.tool-output')[1]
    const secondGate = second.closest('.disclosure-reveal-gate')!
    expect(heads[1].closest('.disclosure-reveal-gate')).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(secondGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    await flushFrame()
    act(() => vi.advanceTimersByTime(199))
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    expect(secondGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    await flushFrame()
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength('output-2'.length)
    expect(view.container.querySelectorAll('.tool-output')[0]).toBe(first)
    expect(view.container.querySelectorAll('.tool-output')[1]).toBe(second)
    expect(view.getAllByRole('button', { name: '收起读取工具详情' })[0]).toBe(heads[0])
    expect(view.getAllByRole('button', { name: '收起读取工具详情' })[1]).toBe(heads[1])
  })

  it('cancels a pending group reveal on close without late character allocation or reopening', async () => {
    vi.useFakeTimers()
    const { flushFrame, frames } = mockRevealFrames()
    const view = render(<ChatTimeline {...props([revealTool(1, 'live'), revealTool(2, 'live')])} />)
    const group = view.getByRole('button', { name: '展开工具调用（2次）' })
    fireEvent.click(group)
    const head = view.getAllByRole('button', { name: '展开读取工具详情' })[0]
    fireEvent.click(head)
    const wrapper = head.closest('.tool-activity-item')!
    const output = view.container.querySelector('.tool-output')!
    const gate = head.closest('.disclosure-reveal-gate')!
    act(() => vi.advanceTimersByTime(100))
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(100)) // The abandoned opening deadline.
    await flushFrame()
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(wrapper).toHaveAttribute('data-open', 'false')
    expect(wrapper).toHaveAttribute('inert')
    expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(output.closest('.disclosure-reveal-gate')).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1000))
    await flushFrame()
    expect(wrapper).toHaveAttribute('hidden')
    expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(view.container.querySelector('.tool-output')).toBe(output)
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('gives rapid group reopening its own reveal deadline and retains the existing detail nodes', async () => {
    vi.useFakeTimers()
    const { flushFrame, frames } = mockRevealFrames()
    const view = render(<ChatTimeline {...props([revealTool(1, 'live'), revealTool(2, 'live')])} />)
    const group = view.getByRole('button', { name: '展开工具调用（2次）' })
    fireEvent.click(group)
    const head = view.getAllByRole('button', { name: '展开读取工具详情' })[0]
    fireEvent.click(head)
    const output = view.container.querySelector('.tool-output')!
    const wrapper = head.closest('.tool-activity-item')!
    const outerGate = head.closest('.disclosure-reveal-gate')!
    const innerGate = output.closest('.disclosure-reveal-gate')!
    act(() => vi.advanceTimersByTime(100))
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(50))
    fireEvent.click(group)
    act(() => vi.advanceTimersByTime(50)) // Nested gate settled, but the reopened ancestor still blocks it.
    await flushFrame()
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(innerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(149)) // Also crosses the old close deadline.
    await flushFrame()
    expect(wrapper).toHaveAttribute('data-open', 'true')
    expect(wrapper).not.toHaveAttribute('hidden')
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    act(() => vi.advanceTimersByTime(1))
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(innerGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(head).not.toHaveAttribute('data-line-reveal-ready')
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    await flushFrame()
    expect(head).toHaveAttribute('data-line-reveal-ready', 'true')
    await flushFrame() // Preserve separately scheduled line/character RAF work.
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(head)
    expect(view.container.querySelector('.tool-output')).toBe(output)
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength('output-1'.length)
    fireEvent.click(group)
    fireEvent.click(group)
    view.unmount() // Pending reopen, RAF and character cleanup work is owned/cleared.
    expect(vi.getTimerCount()).toBe(0)
    expect(frames.size).toBe(0)
  })

  it.each(['live', 'history'] as const)('keeps %s noReveal output as ordinary text through nested expansion', async (mode) => {
    vi.useFakeTimers()
    const { flushFrame } = mockRevealFrames()
    const view = render(<ChatTimeline {...props([revealTool(1, mode, true), revealTool(2, mode, true)])} />)
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（2次）' }))
    const head = view.getAllByRole('button', { name: '展开读取工具详情' })[0]
    expect(head).toHaveClass('screen-text-reveal-line', 'screen-text-reveal-line-history')
    fireEvent.click(head)
    const output = view.container.querySelector('.tool-output')!
    expect(output).toHaveTextContent('output-1')
    act(() => vi.advanceTimersByTime(200))
    await flushFrame()
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    expect(view.container.querySelector('.tool-output')).toBe(output)
  })

  it('makes outer and nested reveals immediately ready with reduced motion and no reveal timers', async () => {
    vi.useFakeTimers()
    const { flushFrame, frames } = mockRevealFrames()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const view = render(<ChatTimeline {...props([revealTool(1, 'live'), revealTool(2, 'history')])} />)
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（2次）' }))
    const heads = view.getAllByRole('button', { name: '展开读取工具详情' })
    heads.forEach((head) => {
      expect(head.closest('.disclosure-reveal-gate')).toHaveAttribute('data-text-reveal-ready', 'true')
      fireEvent.click(head)
    })
    view.container.querySelectorAll('.tool-output').forEach((output) => {
      expect(output.closest('.disclosure-reveal-gate')).toHaveAttribute('data-text-reveal-ready', 'true')
      expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    })
    await flushFrame() // The managed root still owns a line frame, not a gate timer.
    await flushFrame() // Drain the line writes' mutation wakeup without advancing time.
    expect(vi.getTimerCount()).toBe(0)
    expect(frames.size).toBe(0)
  })

  it.each([false, true])('resets gated card margins without changing adjacent-tool spacing (child=%s)', (child) => {
    const chatCss = readFileSync(resolve('src/renderer/src/styles/chat.css'), 'utf8')
    const refinementsCss = readFileSync(resolve('src/renderer/src/styles/refinements.css'), 'utf8')
    const groupCss = readFileSync(resolve('src/renderer/src/styles/tool-activity.css'), 'utf8')
    const rule = (css: string, selector: string) => {
      const start = css.indexOf(`${selector} {`)
      expect(start).toBeGreaterThanOrEqual(0)
      return css.slice(start, css.indexOf('}', start) + 1)
    }
    const resetRule = groupCss.match(/\.tool-activity-inner > \.tool-call[^{}]*\{\s*margin:\s*0;\s*\}/)![0]
    const style = document.createElement('style')
    // Project the real spacing rules, avoiding unsupported theme/@starting-style
    // syntax in JSDOM. Higher-specificity owned rules follow global defaults;
    // selectors must also match the actual gated DOM, not just source strings.
    style.textContent = [rule(chatCss, '.timeline'), rule(chatCss, '.tool-call'),
      rule(refinementsCss, '.timeline'), rule(refinementsCss, '.tool-call'),
      rule(groupCss, '.tool-activity-item'), rule(groupCss, ".tool-activity-item[data-open='true']"),
      resetRule, rule(groupCss, '.child-chat-scroll .timeline > .tool-activity-item + .tool-activity-item')].join('\n')
    document.head.append(style)
    try {
      vi.useFakeTimers()
      const view = render(<div className={child ? 'child-chat-scroll' : undefined}>
        <ChatTimeline {...props([tool(1, 'bash'), tool(2, 'bash'), tool(3, 'bash')])} readOnly={child} />
      </div>)
      fireEvent.click(view.getByRole('button', { name: '展开工具调用（3次）' }))
      const cards = [...view.container.querySelectorAll<HTMLElement>('.tool-call')]
      expect(cards).toHaveLength(3)
      const ownedReset = [...style.sheet!.cssRules].find((entry) =>
        'selectorText' in entry && (entry as CSSStyleRule).selectorText.includes('.tool-activity-inner > .tool-call')) as CSSStyleRule
      expect(ownedReset).toBeDefined()
      // CSSOM may serialize a zero length as 0px rather than the source's 0.
      expect(ownedReset.style.margin).toMatch(/^0(?:px)?$/)
      const checkSpacing = () => {
        cards.forEach((card, index) => {
          expect(view.container.querySelectorAll('.tool-call')[index]).toBe(card)
          expect(card.parentElement).toHaveClass('disclosure-reveal-gate')
          expect(card.parentElement!.parentElement).toHaveClass('tool-activity-inner')
          expect(card.matches(ownedReset.selectorText)).toBe(true)
          expect(getComputedStyle(card).marginTop).toBe('0px')
          expect(getComputedStyle(card).marginBottom).toBe('0px')
        })
        const first = cards[0].closest('.tool-activity-item')!
        const second = cards[1].closest('.tool-activity-item')!
        const gap = parseFloat(getComputedStyle(first.parentElement!).gap)
        expect(gap).toBe(24)
        expect(gap + parseFloat(getComputedStyle(first).marginBottom)
          + parseFloat(getComputedStyle(second).marginTop)).toBe(child ? 4 : 8)
      }
      checkSpacing() // Includes the 200ms layout-only phase.
      act(() => vi.advanceTimersByTime(200))
      fireEvent.click(view.getAllByRole('button', { name: '展开终端工具详情' })[0])
      act(() => vi.advanceTimersByTime(200))
      checkSpacing() // Opening a nested detail must not reinstate global margins.
    } finally {
      style.remove()
    }
  })

  it('keeps grid expansion independent of line-only reveal pausing in the CSS source contract', () => {
    // Source contracts only: JSDOM does not exercise GPU compositing or measure FPS.
    const motionCss = readFileSync(resolve('src/renderer/src/styles/motion.css'), 'utf8')
    const groupCss = readFileSync(resolve('src/renderer/src/styles/tool-activity.css'), 'utf8')
    expect(groupCss).toMatch(/\.tool-activity-item\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*0fr;/)
    expect(groupCss).toMatch(/\.tool-activity-item\[data-open='true'\]\s*\{[^}]*grid-template-rows:\s*1fr;/)
    expect(motionCss).toMatch(/\.disclosure-reveal-gate\s*\{\s*display:\s*block;\s*\}/)
    expect(motionCss).toMatch(/\.disclosure-reveal-gate\[data-text-reveal-ready='false'\] \.screen-text-reveal-line\s*\{[^}]*animation-play-state:\s*paused !important;[^}]*opacity:\s*0 !important;/)
    const pausedRules = [...motionCss.matchAll(/([^{}]+)\{([^{}]*animation-play-state:\s*paused[^{}]*)\}/g)]
    expect(pausedRules).toHaveLength(1)
    expect(pausedRules[0][1].trim()).toBe(".disclosure-reveal-gate[data-text-reveal-ready='false'] .screen-text-reveal-line")
    expect(pausedRules[0][1]).not.toMatch(/screen-text-reveal-(?:char|live|history)|data-screen-reveal-character/)
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
