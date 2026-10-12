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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

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

  it.each(['live', 'history'] as const)('defers newly mounted %s tool headers until the outer group finishes expanding', (mode) => {
    vi.useFakeTimers()
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
    gates.forEach((gate) => expect(gate).toHaveAttribute('data-text-reveal-ready', 'false'))
    act(() => vi.advanceTimersByTime(1))
    gates.forEach((gate) => expect(gate).toHaveAttribute('data-text-reveal-ready', 'true'))
    view.getAllByRole('button', { name: '展开读取工具详情' }).forEach((head, index) => expect(head).toBe(heads[index]))
  })

  it.each(['live', 'history'] as const)('waits for both outer and nested gates before allocating %s detail characters, preserving DOM', (mode) => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = render(<ChatTimeline {...props([revealTool(1, mode), revealTool(2, mode)])} />)
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（2次）' }))
    const heads = view.getAllByRole('button', { name: '展开读取工具详情' })
    // Open the first detail during the outer expansion, not after its deadline.
    fireEvent.click(heads[0])
    const first = view.container.querySelector('.tool-output')!
    const firstGate = first.closest('.disclosure-reveal-gate')!
    expect(first).toHaveTextContent('output-1')
    expect(firstGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(first.closest('.animated-disclosure')).toHaveAttribute('data-open', 'true')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(199))
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    expect(firstGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(first.querySelectorAll('[data-screen-reveal-character]')).toHaveLength('output-1'.length)

    // A later detail owns a new 200ms deadline, independent of the settled group.
    act(() => vi.advanceTimersByTime(50))
    fireEvent.click(heads[1])
    const second = view.container.querySelectorAll('.tool-output')[1]
    const secondGate = second.closest('.disclosure-reveal-gate')!
    expect(heads[1].closest('.disclosure-reveal-gate')).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(secondGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(199))
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    expect(secondGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(second.querySelectorAll('[data-screen-reveal-character]')).toHaveLength('output-2'.length)
    expect(view.container.querySelectorAll('.tool-output')[0]).toBe(first)
    expect(view.container.querySelectorAll('.tool-output')[1]).toBe(second)
    expect(view.getAllByRole('button', { name: '收起读取工具详情' })[0]).toBe(heads[0])
    expect(view.getAllByRole('button', { name: '收起读取工具详情' })[1]).toBe(heads[1])
  })

  it('cancels a pending group reveal on close without late character allocation or reopening', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
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
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(wrapper).toHaveAttribute('data-open', 'false')
    expect(wrapper).toHaveAttribute('inert')
    expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(output.closest('.disclosure-reveal-gate')).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1000))
    expect(wrapper).toHaveAttribute('hidden')
    expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(view.container.querySelector('.tool-output')).toBe(output)
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives rapid group reopening its own reveal deadline and retains the existing detail nodes', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
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
    act(() => vi.advanceTimersByTime(50)) // Old open timer would have fired here.
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(innerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(149)) // Also crosses the old close deadline.
    expect(wrapper).toHaveAttribute('data-open', 'true')
    expect(wrapper).not.toHaveAttribute('hidden')
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'false')
    act(() => vi.advanceTimersByTime(1))
    expect(outerGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(innerGate).toHaveAttribute('data-text-reveal-ready', 'true')
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(head)
    expect(view.container.querySelector('.tool-output')).toBe(output)
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength('output-1'.length)
    fireEvent.click(group)
    fireEvent.click(group)
    view.unmount() // Pending reopen and character cleanup timers are owned/cleared.
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['live', 'history'] as const)('keeps %s noReveal output as ordinary text through nested expansion', (mode) => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = render(<ChatTimeline {...props([revealTool(1, mode, true), revealTool(2, mode, true)])} />)
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（2次）' }))
    const head = view.getAllByRole('button', { name: '展开读取工具详情' })[0]
    expect(head).not.toHaveClass('screen-text-reveal-line')
    fireEvent.click(head)
    const output = view.container.querySelector('.tool-output')!
    expect(output).toHaveTextContent('output-1')
    act(() => vi.advanceTimersByTime(200))
    expect(output.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    expect(view.container.querySelector('.tool-output')).toBe(output)
  })

  it('makes outer and nested reveals immediately ready with reduced motion and no reveal timers', () => {
    vi.useFakeTimers()
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
    // ChatTimeline separately schedules its existing 120ms history-line scan.
    act(() => vi.advanceTimersByTime(120))
    expect(vi.getTimerCount()).toBe(0)
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
