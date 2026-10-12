// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolCallItem } from '../../src/renderer/src/features/chat/ToolCallItem'
import type { ToolItem } from '../../src/renderer/src/agent/types'
import type { ToolInfo } from '../../src/shared/types'
import { applyToolResult, parseToolArgs } from '../../src/renderer/src/agent/timeline'
import { collectToolImages } from '../../src/shared/tool-images'
import { CODEX_IMAGE_REQUEST_ALIAS, IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import { DIFF_PAGE_SIZE } from '../../src/renderer/src/features/review/DiffView'
import { REVIEW_REVEAL_CHUNK_SIZE } from '../../src/renderer/src/features/review/ReviewRevealText'
import { SkillsToolsModal } from '../../src/renderer/src/features/capabilities/SkillsToolsModal'
import {
  assignPendingLineDelays,
  resetLineRevealClock,
  SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS,
  SCREEN_TEXT_REVEAL_LINE_STAGGER_MS
} from '../../src/renderer/src/utils/screenTextReveal'

const chatCss = readFileSync(resolve('src/renderer/src/styles/chat.css'), 'utf8')
const previewPart = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const imageTool: ToolItem = {
  id: 'image-call', name: IMAGE_GENERATION_TOOL_NAME, status: 'done', isError: false, live: true,
  images: collectToolImages([previewPart]).images
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
  const batchTool: ToolItem = {
    id: 'batch-call', name: 'pion_subagents', status: 'done', isError: false,
    outputText: 'original aggregate output',
    subagentBatch: {
      version: 1,
      tasks: [
        { index: 0, name: '检查入口', status: 'completed', summary: '入口结果', summaryTruncated: true },
        { index: 1, name: '检查状态', status: 'running' },
        { index: 2, name: '检查样式', status: 'failed', summary: '样式结果' },
        { index: 3, name: '检查历史', status: 'pending' }
      ]
    }
  }

  it('shows all four real batch tasks and mixed states without expanding aggregate details', () => {
    const { container } = render(<ToolCallItem tool={batchTool} noReveal />)
    const head = screen.getByRole('button', { name: '展开子代理工具详情' })
    expect(head).toHaveTextContent('子代理 · 4 项')
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('list', { name: '子代理任务（4 项）' })).toBeVisible()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    for (const name of ['检查入口', '检查状态', '检查样式', '检查历史']) {
      expect(screen.getByText(name)).toBeVisible()
    }
    for (const status of ['已完成', '执行中', '失败', '待执行']) {
      expect(screen.getByText(status)).toBeVisible()
    }
    expect(container.querySelector('.tool-body')).not.toBeInTheDocument()
    expect(container.querySelector('.tool-subagent-summary')).not.toBeInTheDocument()
  })

  it.each([false, true])('defers whole historical batch frames to the header-first shared settle scan (readOnly=%s)', (readOnly) => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    const { container, rerender } = render(<ToolCallItem tool={batchTool} historical readOnly={readOnly} />)
    const head = container.querySelector<HTMLElement>('.tool-head')!
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.tool-subagent-row'))
    const lines = [head, ...rows]
    for (const line of lines) {
      expect(line).toHaveClass('screen-text-reveal-line', 'screen-text-reveal-line-history')
      expect(line).not.toHaveAttribute('data-line-reveal-ready')
      expect(line.style.getPropertyValue('--screen-text-reveal-delay')).toBe('')
    }
    // Name, state, summary button and background all belong to the same line,
    // not independently animated name characters or synthetic SDK calls.
    expect(rows[0].querySelectorAll('.screen-text-reveal-line')).toHaveLength(0)
    expect(rows[0]).toContainElement(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：检查入口' }))
    assignPendingLineDelays(container)
    lines.forEach((line, index) => {
      expect(line).toHaveAttribute('data-line-reveal-ready', 'true')
      expect(line.style.getPropertyValue('--screen-text-reveal-delay')).toBe(`${index * SCREEN_TEXT_REVEAL_LINE_STAGGER_MS}ms`)
    })
    const delayWrites = rows.map((row) => vi.spyOn(row.style, 'setProperty'))
    const toggle = screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：检查入口' })
    toggle.focus()
    fireEvent.click(toggle)
    rerender(<ToolCallItem tool={{ ...batchTool, status: 'running', subagentBatch: {
      version: 1, tasks: batchTool.subagentBatch!.tasks.map((task) => ({ ...task, status: 'completed' as const }))
    } }} historical readOnly={readOnly} />)
    assignPendingLineDelays(container)
    expect(container.querySelector('.tool-head')).toBe(head)
    Array.from(container.querySelectorAll('.tool-subagent-row')).forEach((row, index) => expect(row).toBe(rows[index]))
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    delayWrites.forEach((spy) => expect(spy).not.toHaveBeenCalled())
    expect(container.querySelector('.tool-subagent-summary')).toHaveTextContent('入口结果')
  })

  it.each([false, true])('suppresses all batch frame markers and delay refs with noReveal (historical=%s)', (historical) => {
    const { container } = render(<ToolCallItem tool={batchTool} historical={historical} readOnly noReveal />)
    assignPendingLineDelays(container)
    expect(container.querySelectorAll('.screen-text-reveal-line')).toHaveLength(0)
    expect(container.querySelectorAll('[data-line-reveal-ready]')).toHaveLength(0)
    expect(container.querySelectorAll('[style*="screen-text-reveal-delay"]')).toHaveLength(0)
    screen.getAllByRole('listitem').forEach((row) => expect(row).toBeVisible())
  })

  it('restores a freshly mounted cached batch on the history clock without replaying same-scope refreshes', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    const { container, rerender } = render(<ToolCallItem tool={batchTool} historical />)
    resetLineRevealClock()
    assignPendingLineDelays(container)
    const oldRows = Array.from(container.querySelectorAll<HTMLElement>('.tool-subagent-row'))
    rerender(<ToolCallItem tool={{ ...batchTool }} historical />)
    assignPendingLineDelays(container)
    expect(container.querySelector('.tool-subagent-row')).toBe(oldRows[0])
    expect(oldRows[0].style.getPropertyValue('--screen-text-reveal-delay')).toBe(`${SCREEN_TEXT_REVEAL_LINE_STAGGER_MS}ms`)
    // Timeline unmounts the old scope, then restores its cached historical tool.
    rerender(<></>)
    resetLineRevealClock()
    rerender(<ToolCallItem tool={{ ...batchTool }} historical />)
    const restoredRows = Array.from(container.querySelectorAll<HTMLElement>('.tool-subagent-row'))
    restoredRows.forEach((row, index) => {
      expect(row).not.toBe(oldRows[index])
      expect(row).not.toHaveAttribute('data-line-reveal-ready')
    })
    assignPendingLineDelays(container)
    restoredRows.forEach((row, index) => expect(row.style.getPropertyValue('--screen-text-reveal-delay'))
      .toBe(`${(index + 1) * SCREEN_TEXT_REVEAL_LINE_STAGGER_MS}ms`))
  })

  it('assigns live frame refs even for a newly received non-streaming final batch, without requeuing updates', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    const { container, rerender } = render(<ToolCallItem tool={batchTool} />)
    const head = container.querySelector<HTMLElement>('.tool-head')!
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.tool-subagent-row'))
    const lines = [head, ...rows]
    lines.forEach((line, index) => {
      expect(line).toHaveClass('screen-text-reveal-line-live')
      expect(line).toHaveAttribute('data-line-reveal-ready', 'true')
      expect(line.style.getPropertyValue('--screen-text-reveal-delay')).toBe(`${index * SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS}ms`)
    })
    const delayWrites = rows.map((row) => vi.spyOn(row.style, 'setProperty'))
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：检查入口' }))
    rerender(<ToolCallItem tool={{ ...batchTool, live: true, status: 'running' }} />)
    expect(container.querySelector('.tool-subagent-row')).toBe(rows[0])
    delayWrites.forEach((spy) => expect(spy).not.toHaveBeenCalled())
    expect(container.querySelector('.tool-subagent-summary')).toHaveTextContent('入口结果')
  })

  it('opens individual bounded summaries without opening or remounting aggregate details', () => {
    const { container } = render(<ToolCallItem tool={batchTool} noReveal />)
    const head = screen.getByRole('button', { name: '展开子代理工具详情' })
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：检查入口' }))
    expect(screen.getByText('入口结果')).toBeVisible()
    expect(screen.getByText('摘要已截断')).toBeVisible()
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.tool-body')).not.toBeInTheDocument()
    fireEvent.click(head)
    const body = container.querySelector('.tool-body')
    expect(body).toHaveTextContent('original aggregate output')
    fireEvent.click(screen.getByRole('button', { name: '展开第 3 项子代理结果摘要：检查样式' }))
    expect(screen.getByText('入口结果')).toBeVisible()
    expect(screen.getByText('样式结果')).toBeVisible()
    expect(container.querySelector('.tool-body')).toBe(body)
    expect(screen.getByRole('button', { name: '收起子代理工具详情' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keys duplicate names by real index and tool scope while preserving individual expansion', () => {
    const duplicate: ToolItem = {
      ...batchTool,
      subagentBatch: { version: 1, tasks: batchTool.subagentBatch!.tasks.map((task) => ({ ...task, name: '同名任务' })) }
    }
    const { container, rerender } = render(<ToolCallItem tool={duplicate} noReveal />)
    expect(screen.getAllByText('同名任务')).toHaveLength(4)
    const rows = Array.from(container.querySelectorAll('.tool-subagent-row'))
    expect(rows.map((row) => row.getAttribute('data-subagent-index'))).toEqual(['0', '1', '2', '3'])
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：同名任务' }))
    rerender(<ToolCallItem tool={{ ...duplicate, subagentBatch: {
      version: 1, tasks: duplicate.subagentBatch!.tasks.map((task) => task.index === 1 ? { ...task, status: 'completed' as const } : task)
    } }} noReveal />)
    Array.from(container.querySelectorAll('.tool-subagent-row')).forEach((row, index) => expect(row).toBe(rows[index]))
    expect(screen.getByText('入口结果')).toBeVisible()
    rerender(<ToolCallItem tool={{ ...duplicate, id: 'another-batch' }} noReveal />)
    expect(container.querySelector('.tool-subagent-summary')).not.toBeInTheDocument()
  })

  it('reveals only visible historical summary chunks and releases characters and closed DOM', () => {
    vi.useFakeTimers()
    const targets: Element[] = []
    let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback }
      observe(target: Element) { targets.push(target) }
      unobserve() {}
      disconnect() {}
    })
    try {
      const summary = '长🙂'.repeat(500)
      const tool: ToolItem = { ...batchTool, live: true, subagentBatch: { version: 1, tasks: [
        { index: 0, name: '历史摘要', status: 'completed', summary }
      ] } }
      const { container } = render(<div className="chat-scroll"><ToolCallItem tool={tool} historical /></div>)
      expect(targets).toHaveLength(0)
      expect(container.querySelector('.tool-subagent-summary')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：历史摘要' }))
      const body = container.querySelector('.tool-subagent-summary')!
      expect(body.textContent).toBe(summary)
      expect(targets).toHaveLength(Math.ceil(Array.from(summary).length / REVIEW_REVEAL_CHUNK_SIZE))
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      act(() => intersect([{ target: targets[0], isIntersecting: true }]))
      expect(body.querySelectorAll('.screen-text-reveal-history')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
      expect(body.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
      act(() => vi.advanceTimersByTime(468))
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: '收起第 1 项子代理结果摘要：历史摘要' }))
      expect(container.querySelector('.tool-subagent-summary')).toBe(body)
      expect(body.closest('.animated-disclosure')).toHaveAttribute('inert')
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('.tool-subagent-summary')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps task and summary surfaces transparent while preserving status, hover and focus colors', () => {
    expect(chatCss).toMatch(/\.tool-subagent-row\s*\{[^}]*background: transparent;/)
    expect(chatCss).toMatch(/\.tool-subagent-summary\s*\{[^}]*background: transparent;/)
    expect(chatCss).toMatch(/\.tool-subagent-summary pre\s*\{[^}]*background: transparent;/)
    expect(chatCss).toMatch(/\.tool-subagent-status\s*\{[^}]*background: var\(--bg-elev\);/)
    expect(chatCss).toContain('.tool-subagent-status-failed { color: var(--danger); }')
    expect(chatCss).toContain('.tool-subagent-summary-toggle:hover { background: var(--bg-elev); color: var(--fg); }')
    expect(chatCss).toContain('html.pion-keyboard-focus .tool-subagent-summary-toggle:focus-visible')
  })

  it('preserves unfinished summary fades through fast append and terminal status updates', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
    try {
      const task = { index: 0, name: '增量摘要', status: 'running' as const, summary: 'old' }
      const tool: ToolItem = { ...batchTool, status: 'running', live: true, subagentBatch: { version: 1, tasks: [task] } }
      const { container, rerender } = render(<ToolCallItem tool={tool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：增量摘要' }))
      const body = container.querySelector('.tool-subagent-summary pre')!
      const first = body.querySelector<HTMLElement>('.screen-text-reveal-live')!
      const delay = first.style.getPropertyValue('--screen-text-reveal-delay')
      act(() => vi.advanceTimersByTime(30))
      const updated: ToolItem = { ...tool, status: 'done', subagentBatch: { version: 1, tasks: [
        { ...task, status: 'completed', summary: 'old new' }
      ] } }
      rerender(<ToolCallItem tool={updated} />)
      expect(container.querySelector('.tool-subagent-summary pre')).toBe(body)
      expect(body.querySelector('.screen-text-reveal-live')).toBe(first)
      expect(first.style.getPropertyValue('--screen-text-reveal-delay')).toBe(delay)
      expect(Array.from(body.querySelectorAll('.screen-text-reveal-live'), (node) => node.textContent).join('')).toBe('old new')
      act(() => vi.advanceTimersByTime(868))
      expect(body.querySelector('[data-screen-reveal-character]')).toBeNull()
      expect(body.textContent).toBe('old new')
    } finally { cleanup(); vi.useRealTimers() }
  })

  it.each([false, true])('does not animate readonly live summary or reduced-motion summary: reduced=%s', (reduced) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    if (reduced) vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { container } = render(<ToolCallItem tool={{ ...batchTool, live: true }} readOnly={!reduced} />)
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：检查入口' }))
    expect(container.querySelector('.tool-subagent-summary pre')?.textContent).toBe('入口结果')
    expect(container.querySelector('.tool-subagent-summary [data-screen-reveal-character]')).toBeNull()
    cleanup()
  })

  it('animates only live summary suffixes and keeps completed content stable on status changes', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
    try {
      const summary = 'a'.repeat(REVIEW_REVEAL_CHUNK_SIZE) + 'old'
      const tool: ToolItem = { ...batchTool, status: 'running', live: true, subagentBatch: { version: 1, tasks: [
        { index: 0, name: '实时摘要', status: 'running', summary }
      ] } }
      const { container, rerender } = render(<ToolCallItem tool={tool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：实时摘要' }))
      const body = container.querySelector('.tool-subagent-summary pre')!
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(Array.from(summary).length)
      act(() => vi.advanceTimersByTime(868))
      const firstChunk = body.querySelector('span')
      const appended: ToolItem = { ...tool, subagentBatch: { version: 1, tasks: [
        { ...tool.subagentBatch!.tasks[0], summary: summary + 'new' }
      ] } }
      rerender(<ToolCallItem tool={appended} />)
      expect(container.querySelector('.tool-subagent-summary pre')).toBe(body)
      expect(body.querySelector('span')).toBe(firstChunk)
      expect(Array.from(body.querySelectorAll('.screen-text-reveal-live')).map((node) => node.textContent).join('')).toBe('new')
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(3)
      act(() => vi.advanceTimersByTime(600))
      rerender(<ToolCallItem tool={{ ...appended, status: 'done', subagentBatch: { version: 1, tasks: [
        { ...appended.subagentBatch!.tasks[0], status: 'completed' }
      ] } }} />)
      expect(container.querySelector('.tool-subagent-summary pre')).toBe(body)
      expect(body.querySelector('span')).toBe(firstChunk)
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      expect(body.textContent).toBe(summary + 'new')
    } finally { cleanup(); vi.useRealTimers() }
  })

  it.each([
    { historical: true, live: true, noReveal: true },
    { historical: false, live: true, noReveal: true },
    { historical: false, live: false, noReveal: false }
  ])('keeps suppressed or non-live summaries as raw text: %j', ({ historical, live, noReveal }) => {
    const tool = { ...batchTool, live }
    const { container } = render(<ToolCallItem tool={tool} historical={historical} noReveal={noReveal} />)
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：检查入口' }))
    expect(container.querySelector('.tool-subagent-summary pre')?.textContent).toBe('入口结果')
    expect(container.querySelector('.tool-subagent-summary pre > span')).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('uses a numbered display fallback for whitespace names without changing task identity', () => {
    const task = { index: 0, name: ' \t ', status: 'completed' as const, summary: '空白名称摘要' }
    const tool: ToolItem = { ...batchTool, subagentBatch: { version: 1, tasks: [task] } }
    const { container, rerender } = render(<ToolCallItem tool={tool} noReveal />)
    expect(screen.getByText('子代理 1')).toBeVisible()
    const row = container.querySelector('.tool-subagent-row')
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 项子代理结果摘要：子代理 1' }))
    rerender(<ToolCallItem tool={{ ...tool, subagentBatch: { version: 1, tasks: [{ ...task, status: 'unknown' }] } }} noReveal />)
    expect(container.querySelector('.tool-subagent-row')).toBe(row)
    expect(screen.getByText('空白名称摘要')).toBeVisible()
    expect(task.name).toBe(' \t ')
  })

  it.each([true, false])('renders historical read-only batch metadata as plain text without mounting images or links (noReveal=%s)', (noReveal) => {
    const tool: ToolItem = {
      ...batchTool, images: imageTool.images,
      subagentBatch: { version: 1, tasks: [
        { index: 0, name: '<img src="https://example.com/name.png">', status: 'aborted',
          summary: '![image](https://example.com/image.png) <img src="https://example.com/image.png"> <a href="https://example.com">link</a>' },
        { index: 1, name: '未知任务', status: 'unknown' }
      ] }
    }
    const { container } = render(<ToolCallItem tool={tool} historical readOnly noReveal={noReveal} />)
    expect(screen.getByText('已停止')).toBeVisible()
    expect(screen.getByText('未知')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /展开第 1 项子代理结果摘要/ }))
    expect(container.querySelector('.tool-subagent-summary pre')?.textContent).toBe(tool.subagentBatch!.tasks[0].summary)
    fireEvent.click(screen.getByRole('button', { name: '展开子代理工具详情' }))
    expect(container.querySelectorAll('img, a')).toHaveLength(0)
    expect(container).not.toHaveTextContent('张图片')
  })

  it('shows eight projected rows and marks omitted summary text without inventing content', () => {
    const tool: ToolItem = { ...batchTool, subagentBatch: {
      version: 1, tasks: Array.from({ length: 8 }, (_, index) => ({
        index, name: `任务 ${index + 1}`, status: 'unknown' as const,
        ...(index === 7 ? { summary: '', summaryTruncated: true } : {})
      }))
    } }
    const { container } = render(<ToolCallItem tool={tool} noReveal />)
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByText('任务 8')).toBeVisible()
    expect(screen.getByText('摘要已截断')).toBeVisible()
    expect(container.querySelector('.tool-subagent-summary-toggle')).not.toBeInTheDocument()
  })

  it('retains generic legacy subagent details without guessing a task count', () => {
    const { container } = render(<ToolCallItem tool={{ ...batchTool, subagentBatch: undefined }} historical readOnly noReveal />)
    const head = screen.getByRole('button', { name: '展开子代理工具详情' })
    expect(head).toHaveTextContent(/^子代理$/)
    expect(container.querySelector('.tool-subagent-batch')).not.toBeInTheDocument()
    fireEvent.click(head)
    expect(container.querySelector('.tool-body')).toHaveTextContent('original aggregate output')
  })

  it('preserves the ordinary aggregate detail cap and read-only image suppression', () => {
    const outputText = 'x'.repeat(4001) + '<img src="https://example.com/output.png">'
    const tool: ToolItem = { ...liveTool, outputText, images: imageTool.images }
    const { container } = render(<ToolCallItem tool={tool} historical readOnly noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
    expect(container.querySelector('.tool-output')?.textContent).toBe('x'.repeat(4000) + '…')
    expect(container.querySelector('.tool-command')).toHaveTextContent('$ printf output')
    expect(container.querySelectorAll('img, a, [data-screen-reveal-character]')).toHaveLength(0)
    expect(container.querySelector('.tool-subagent-batch')).not.toBeInTheDocument()
  })

  it('labels the built-in question tool without requiring a plugin renderer', () => {
    render(<ToolCallItem tool={{ ...liveTool, name: 'pion_ask_user', command: undefined }} noReveal />)
    expect(screen.getByRole('button', { name: '展开提问工具详情' })).toBeInTheDocument()
  })

  it('shows the restored running label immediately even for historical noReveal rows', () => {
    const { container, rerender } = render(<ToolCallItem tool={{ ...liveTool, status: 'done', resultReceived: false }} historical noReveal />)
    expect(container).not.toHaveTextContent('执行中…')
    rerender(<ToolCallItem tool={liveTool} historical noReveal />)
    expect(container).toHaveTextContent('执行中…')
    expect(container.querySelector('.tool-icon')).toHaveClass('spin')
    rerender(<ToolCallItem tool={{ ...liveTool, status: 'done', resultReceived: true }} historical noReveal />)
    expect(container).not.toHaveTextContent('执行中…')
    expect(container.querySelector('.tool-icon')).not.toHaveClass('spin')
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
      act(() => vi.advanceTimersByTime(600))
      const body = container.querySelector('.tool-output')
      expect(body?.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      rerender(<ToolCallItem tool={{ ...liveTool, status: 'done' }} />)
      expect(container.querySelector('.tool-output')).toBe(body)
      expect(body?.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      expect(body).toHaveTextContent('output')
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps unfinished tool output fades and their DOM identity across fast streamed updates', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', undefined)
    try {
      const { container, rerender } = render(<ToolCallItem tool={liveTool} />)
      fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
      const body = container.querySelector('.tool-output')!
      const first = body.querySelector<HTMLElement>('[data-screen-reveal-character]')!
      const delay = first.style.getPropertyValue('--screen-text-reveal-delay')
      act(() => vi.advanceTimersByTime(100))
      rerender(<ToolCallItem tool={{ ...liveTool, outputText: 'output new' }} />)
      act(() => vi.advanceTimersByTime(100))
      rerender(<ToolCallItem tool={{ ...liveTool, outputText: 'output newer' }} />)
      expect(body.querySelector('[data-screen-reveal-character]')).toBe(first)
      expect(first).toHaveClass('screen-text-reveal-live')
      expect(first.style.getPropertyValue('--screen-text-reveal-delay')).toBe(delay)
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(12)
      act(() => vi.advanceTimersByTime(900))
      expect(body.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
      rerender(<ToolCallItem tool={{ ...liveTool, outputText: 'output newer!', status: 'running' }} />)
      expect(Array.from(body.querySelectorAll('[data-screen-reveal-character]')).map((node) => node.textContent)).toEqual(['!'])
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps noReveal detail content outside character animation too', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开终端工具详情' }))
    expect(container.querySelector('.tool-output')).toHaveTextContent('output')
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('mounts image-only previews only while details are present and releases them after closing', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<ToolCallItem tool={imageTool} noReveal />)
      expect(container.querySelector('.tool-result-images')).not.toBeInTheDocument()
      expect(container.querySelector('img')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '展开生图工具详情' })).toHaveTextContent('1 张图片')
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      const image = screen.getByRole('img', { name: '工具结果预览 1' })
      expect(image).toHaveAttribute('src', `data:image/png;base64,${previewPart.data}`)
      expect(image).toHaveAttribute('width', '1')
      expect(image).toHaveAttribute('height', '1')
      expect(container.querySelector('.tool-empty')).not.toBeInTheDocument()
      expect(container.querySelector('.tool-output')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
      expect(container.querySelector('img')).toBe(image)
      expect(container.querySelector('.animated-disclosure')).toHaveAttribute('inert')
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('img')).not.toBeInTheDocument()
      expect(container.querySelector('.tool-result-images')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it.each([
    { metadata: { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS }, label: 'Codex 自动（官方别名）' },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' }, label: 'Images 2.5 Flare（实验性）' },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-sunburst' }, label: 'Images 2.5 Sunburst（实验性）' },
    { metadata: { version: 1, provider: 'openai-codex', model: 'unknown-sensitive-string' }, label: '未知请求型号' },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'unknown-sensitive-string' }, label: '未知请求型号' },
    { metadata: { version: 99, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' }, label: '未知请求型号' },
    { metadata: {}, label: '未知请求型号' }
  ])('shows only a short historical request label, never an actual engine claim: $label', ({ metadata, label }) => {
    const tool = applyToolResult({ ...imageTool, images: undefined, ...parseToolArgs(imageTool.name, {}) }, {
      content: [previewPart], details: { imageGeneration: { ...metadata,
        path: 'images/saved.png', resolvedModel: 'untrusted-actual-echo' } }
    }, false, 'history')
    const { container } = render(<ToolCallItem tool={tool} historical noReveal />)
    expect(container.querySelector('.tool-image-model-info')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText(`请求型号：${label}`)).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('unknown-sensitive-string')
    expect(container).not.toHaveTextContent('untrusted-actual-echo')
    expect(container).not.toHaveTextContent('已确认')
    expect(container.querySelector('.tool-path')).toHaveTextContent('images/saved.png')
    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${previewPart.data}`)
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('previews the default request alias while running and does not show image model fields for other tools', () => {
    const requested = { ...imageTool, status: 'running' as const, images: undefined,
      ...parseToolArgs(imageTool.name, {}) }
    const { container, rerender } = render(<ToolCallItem tool={requested} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText('请求型号：Codex 自动（官方别名）')).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    rerender(<ToolCallItem tool={{ ...requested, name: 'read', status: 'done' }} noReveal />)
    expect(container.querySelector('.tool-image-model-info')).not.toBeInTheDocument()
  })

  it('keeps loaded preview DOM and a single decode when final request model and output fields change', () => {
    const decode = vi.spyOn(globalThis, 'atob')
    const payload = { content: [{ type: 'text', text: '已保存' }, previewPart], details: {
      imageGeneration: { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
        path: 'images/saved.png' }
    } }
    const first = applyToolResult({ ...imageTool, images: undefined }, payload, false)
    const { container, rerender } = render(<ToolCallItem tool={first} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const image = screen.getByRole('img')
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    fireEvent.load(image)
    const second = applyToolResult(first, { ...payload, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare',
      resolvedModel: 'untrusted-actual-echo', path: 'images/saved.png'
    } } }, false, 'message')
    expect(second.images).toBe(first.images)
    rerender(<ToolCallItem tool={second} noReveal />)
    expect(screen.getByText('请求型号：Images 2.5 Flare（实验性）')).toBeInTheDocument()
    const third = applyToolResult(second, { ...payload,
      content: [{ type: 'text', text: 'final warning' }, previewPart],
      details: { imageGeneration: { version: 2, provider: 'openai-codex',
        requestedModel: 'gpt-image-2.5-sunburst', path: 'images/final.png' } }
    }, true, 'message')
    expect(third.images).toBe(first.images)
    rerender(<ToolCallItem tool={third} noReveal />)
    expect(screen.getByText('请求型号：Images 2.5 Sunburst（实验性）')).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    expect(container.querySelector('.tool-output')).toHaveTextContent('final warning')
    expect(container.querySelector('.tool-path')).toHaveTextContent('images/final.png')
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(screen.getByRole('img')).toBe(image)
    expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('shows explicit request settings and saved original dimensions separately from the bounded preview', () => {
    const requested: ToolItem = { ...imageTool, images: undefined, status: 'running', ...parseToolArgs(imageTool.name, {
      size: '2048x3072', quality: 'high', referenced_image_paths: ['images/private-source.png']
    }) }
    const { container, rerender } = render(<ToolCallItem tool={requested} historical noReveal />)
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText('操作请求：编辑')).toBeInTheDocument()
    expect(screen.getByText('请求尺寸：2048x3072')).toBeInTheDocument()
    expect(screen.getByText('请求质量：high')).toBeInTheDocument()
    expect(screen.getByText('参考图数量：1')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('原图保存尺寸')
    expect(container.querySelector('img')).not.toBeInTheDocument()
    const saved = applyToolResult(requested, { content: [previewPart], details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high', referenceCount: 1,
      path: 'images/edited.png', width: 1024, height: 1536, byteLength: 100_000,
      actualSize: '4096x4096', actualQuality: 'untrusted-quality-echo', resolvedModel: 'untrusted-engine-echo',
      referenced_image_paths: ['images/private-source.png'], referenceBytes: 'private-original-bytes'
    } } }, false, 'history')
    rerender(<ToolCallItem tool={saved} historical noReveal />)
    expect(screen.getByText('原图保存尺寸：1024 × 1536')).toBeInTheDocument()
    expect(screen.getByText('缩略图预览：每边最多 512 px')).toBeInTheDocument()
    expect(container.querySelector('figcaption')).toHaveTextContent('1 × 1 · 预览')
    expect(screen.getByRole('img')).toHaveAttribute('width', '1')
    expect(screen.getByRole('img')).toHaveAttribute('height', '1')
    expect(container).not.toHaveTextContent('4096x4096')
    expect(container).not.toHaveTextContent('untrusted')
    expect(container).not.toHaveTextContent('private-source')
    expect(container).not.toHaveTextContent('private-original-bytes')
    expect(container).not.toHaveTextContent('实际质量')
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    rerender(<ToolCallItem tool={{ ...saved, name: 'read' }} historical noReveal />)
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
  })

  it.each([
    { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS },
    { version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS },
    { version: 99, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS },
    { version: 2, provider: 'unknown-provider', requestedModel: CODEX_IMAGE_REQUEST_ALIAS },
    {}
  ])('does not invent auto settings or reference counts for old/unknown final metadata: %j', (metadata) => {
    const saved = applyToolResult({ ...imageTool, images: undefined, ...parseToolArgs(imageTool.name, {
      size: 'auto', quality: 'auto', referenced_image_paths: []
    }) }, { content: [previewPart], details: { imageGeneration: metadata } }, false, 'history')
    const { container } = render(<ToolCallItem tool={saved} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('请求尺寸')
    expect(container).not.toHaveTextContent('请求质量')
    expect(container).not.toHaveTextContent('操作请求')
    expect(container).not.toHaveTextContent('参考图数量')
    expect(container).not.toHaveTextContent('原图保存尺寸')
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('displays only independently validated settings without echoing arbitrary fields or unsupported values', () => {
    const saved = applyToolResult(imageTool, { content: [previewPart], details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: 'unknown-sensitive-model',
      operation: 'unknown-sensitive-operation', requestedSize: 'unknown-sensitive-size',
      requestedQuality: 'medium', referenceCount: 7, width: 1024, height: 1536,
      byteLength: 'unknown-sensitive-byteLength', sourcePaths: ['images/private-source.png'],
      actualQuality: 'unknown-sensitive-quality', mask: 'images/private-mask.png'
    } } }, false)
    const { container } = render(<ToolCallItem tool={saved} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByText('请求质量：medium')).toBeInTheDocument()
    expect(screen.getByText('原图保存尺寸：1024 × 1536')).toBeInTheDocument()
    expect(screen.getByText('请求型号：未知请求型号')).toBeInTheDocument()
    expect(screen.getByText('实际版本：服务未报告')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('unknown-sensitive')
    expect(container).not.toHaveTextContent('private-source')
    expect(container).not.toHaveTextContent('private-mask')
    expect(container).not.toHaveTextContent('操作请求')
    expect(container).not.toHaveTextContent('请求尺寸')
    expect(container).not.toHaveTextContent('参考图数量')
    expect(container).not.toHaveTextContent('实际质量')
  })

  it.each(['loaded', 'failed'] as const)('keeps a %s preview frame, DOM and decode stable through settings-only replacements/removals', (state) => {
    const decode = vi.spyOn(globalThis, 'atob')
    const metadata = { version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS,
      operation: 'generate', requestedSize: 'auto', requestedQuality: 'low', referenceCount: 0,
      path: 'images/saved.png', width: 1024, height: 1024, byteLength: 100_000 }
    const payload = { content: [previewPart], details: { imageGeneration: metadata } }
    const first = applyToolResult({ ...imageTool, images: undefined }, payload, false)
    const { container, rerender } = render(<ToolCallItem tool={first} noReveal />)
    container.scrollTop = 75
    const onScroll = vi.fn()
    container.addEventListener('scroll', onScroll)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const image = screen.getByRole('img')
    const frame = image.parentElement!
    const caption = container.querySelector('figcaption')
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    if (state === 'loaded') fireEvent.load(image)
    else fireEvent.error(image)
    const second = applyToolResult(first, { ...payload, details: { imageGeneration: {
      ...metadata, operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high',
      referenceCount: 2, width: 1024, height: 1536, byteLength: 120_000
    } } }, false, 'message')
    expect(second.images).toBe(first.images)
    rerender(<ToolCallItem tool={second} noReveal />)
    expect(screen.getByText('请求质量：high')).toBeInTheDocument()
    expect(screen.getByText('原图保存尺寸：1024 × 1536')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(container.querySelector('.tool-result-image-frame')).toBe(frame)
    expect(container.querySelector('figcaption')).toBe(caption)
    expect(frame).toHaveAttribute('data-image-state', state)
    if (state === 'loaded') expect(screen.getByRole('img')).toBe(image)
    else expect(container.querySelector('img')).not.toBeInTheDocument()
    const third = applyToolResult(second, { ...payload, details: { imageGeneration: {
      version: 2, provider: 'openai-codex', requestedModel: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/saved.png'
    } } }, false, 'message')
    expect(third.images).toBe(first.images)
    rerender(<ToolCallItem tool={third} noReveal />)
    expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(container.querySelector('.tool-result-image-frame')).toBe(frame)
    expect(frame).toHaveAttribute('data-image-state', state)
    expect(container.querySelector('figcaption')).toBe(caption)
    if (state === 'loaded') expect(screen.getByRole('img')).toBe(image)
    expect(container.scrollTop).toBe(75)
    expect(onScroll).not.toHaveBeenCalled()
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('releases image settings together with preview details after closing', () => {
    vi.useFakeTimers()
    try {
      const saved = applyToolResult(imageTool, { content: [previewPart], details: { imageGeneration: {
        version: 2, provider: 'openai-codex', operation: 'generate', requestedSize: 'auto',
        requestedQuality: 'auto', referenceCount: 0, width: 1024, height: 1536
      } } }, false)
      const { container } = render(<ToolCallItem tool={saved} noReveal />)
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      expect(screen.getByText('操作请求：生成')).toBeInTheDocument()
      expect(screen.getByText('参考图数量：0')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
      act(() => vi.advanceTimersByTime(200))
      expect(container.querySelector('.tool-image-settings-info')).not.toBeInTheDocument()
      expect(container.querySelector('img')).not.toBeInTheDocument()
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('keeps images out of character reveal while preserving mixed-result text animation', () => {
    const { container, rerender } = render(<ToolCallItem tool={{ ...imageTool, outputText: 'output' }} />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    const image = screen.getByRole('img')
    expect(container.querySelector('.tool-output [data-screen-reveal-character]')).toBeInTheDocument()
    expect(gallery.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    fireEvent.load(image)
    rerender(<ToolCallItem tool={{ ...imageTool, outputText: 'output', path: 'images/result.png' }} />)
    expect(screen.getByRole('group', { name: '工具结果图片预览' })).toBe(gallery)
    expect(screen.getByRole('img')).toBe(image)
    expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
    expect(container.querySelector('.tool-path')).toHaveTextContent('images/result.png')
  })

  it('preserves loaded image nodes on part reordering and quick disclosure reversal', () => {
    vi.useFakeTimers()
    try {
      const images = collectToolImages([previewPart, { type: 'text', text: 'between' }, previewPart]).images
      const { container, rerender } = render(<ToolCallItem tool={{ ...imageTool, images }} noReveal />)
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      const original = Array.from(container.querySelectorAll('img'))
      fireEvent.load(original[0])
      rerender(<ToolCallItem tool={{ ...imageTool, images: [...images].reverse() }} noReveal />)
      expect(Array.from(container.querySelectorAll('img'))).toEqual([original[1], original[0]])
      expect(original[0].parentElement).toHaveAttribute('data-image-state', 'loaded')
      fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
      act(() => vi.advanceTimersByTime(80))
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      act(() => vi.advanceTimersByTime(220))
      expect(Array.from(container.querySelectorAll('img'))).toEqual([original[1], original[0]])
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('retains a fixed frame on load and failure without scrolling the conversation', () => {
    const style = document.createElement('style')
    style.textContent = chatCss
    document.head.append(style)
    try {
      const { container, rerender } = render(<ToolCallItem tool={imageTool} noReveal />)
      container.scrollTop = 75
      const onScroll = vi.fn()
      container.addEventListener('scroll', onScroll)
      fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
      const image = screen.getByRole('img')
      const frame = image.parentElement!
      const caption = container.querySelector('figcaption')
      expect(getComputedStyle(frame).height).toBe('200px')
      expect(getComputedStyle(image).objectFit).toBe('contain')
      fireEvent.load(image)
      expect(frame).toHaveAttribute('data-image-state', 'loaded')
      expect(getComputedStyle(frame).height).toBe('200px')
      fireEvent.error(image)
      expect(container.querySelector('.tool-result-image-frame')).toBe(frame)
      expect(frame).toHaveAttribute('data-image-state', 'failed')
      expect(getComputedStyle(frame).height).toBe('200px')
      expect(frame).toHaveTextContent('预览加载失败，请查看工具输出中的原图路径。')
      expect(container.querySelector('figcaption')).toBe(caption)
      expect(container.scrollTop).toBe(75)
      expect(onScroll).not.toHaveBeenCalled()
      // A header rerender must not turn a failed frame back into a new decode.
      rerender(<ToolCallItem tool={{ ...imageTool, path: 'images/result.png' }} noReveal />)
      expect(frame).toHaveAttribute('data-image-state', 'failed')
    } finally { style.remove() }
  })

  it('displays rejected-image notices without a false empty result or character animation', () => {
    const result = collectToolImages([{ ...previewPart, data: 'not-base64!' }])
    const { container } = render(<ToolCallItem tool={{ ...imageTool, images: result.images, imageNotice: result.notice }} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    const gallery = screen.getByRole('group', { name: '工具结果图片预览' })
    expect(gallery).toHaveTextContent('部分图片因格式或大小限制未显示。')
    expect(gallery.querySelector('img')).not.toBeInTheDocument()
    expect(container.querySelector('.tool-empty')).not.toBeInTheDocument()
    expect(gallery.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  })

  it('immediately releases previews with reduced motion and keeps noReveal image details static', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { container } = render(<ToolCallItem tool={imageTool} historical noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '收起生图工具详情' }))
    expect(container.querySelector('img')).not.toBeInTheDocument()
    const css = chatCss
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.tool-result-image-frame\s*\{[^}]*border-color: CanvasText;[^}]*background: Canvas;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tool-result-images,[\s\S]*?animation: none;/)
    expect(css).toMatch(/\.tool-image-model-info,\s*\.tool-image-settings-info\s*\{[^}]*color: CanvasText;/)
  })

  it('preserves bounded diff paging alongside previews and header updates', () => {
    const diff = Array.from({ length: DIFF_PAGE_SIZE + 2 }, (_, index) => `+${index + 1} line-${index + 1}`).join('\n')
    const tool = { ...imageTool, name: 'edit', diff }
    const { container, rerender } = render(<ToolCallItem tool={tool} noReveal />)
    fireEvent.click(screen.getByRole('button', { name: '展开编辑工具详情' }))
    expect(container.querySelectorAll('tr')).toHaveLength(DIFF_PAGE_SIZE)
    const image = screen.getByRole('img')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(container.querySelectorAll('tr')).toHaveLength(2)
    rerender(<ToolCallItem tool={{ ...tool, path: 'new.ts' }} noReveal />)
    expect(container.querySelectorAll('tr')).toHaveLength(2)
    expect(screen.getByRole('img')).toBe(image)
  })

  it('advertises the built-in Codex image tool with its login, quota and mode requirements', async () => {
    vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [] }) })
    render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    expect(screen.getByText(IMAGE_GENERATION_TOOL_NAME)).toBeInTheDocument()
    const card = screen.getByText('Codex 生图').closest('article')
    expect(card).toHaveTextContent('Pion 内置')
    expect(card).toHaveTextContent('单张 PNG')
    expect(card).toHaveTextContent('需要 Codex 登录和账号额度')
    expect(card).toHaveTextContent('计划模式不可用')
    expect(card).toHaveTextContent('默认请求 Codex 自动（官方别名）')
    expect(card).toHaveTextContent('使用 2.5 Flare 生图')
    expect(card).toHaveTextContent('使用 2.5 Sunburst 生图')
    expect(card).toHaveTextContent('实验性请求型号')
    expect(card).toHaveTextContent('订阅兼容性未验证')
    expect(card).toHaveTextContent('不会自动降级')
    expect(card).toHaveTextContent('可通过消息指定 size（如 2048x3072）')
    expect(card).toHaveTextContent('quality（auto/low/medium/high）')
    expect(card).toHaveTextContent('referenced_image_paths')
    expect(card).toHaveTextContent('至多 5 张项目相对 PNG/JPEG')
    expect(card).toHaveTextContent('参考 images/source.png，high 质量，另存 images/edited.png')
    expect(card).toHaveTextContent('参考图连同文件元数据上传')
    expect(card).toHaveTextContent('需要 read + network + write 权限')
    expect(card).toHaveTextContent('编辑服务兼容性未验证')
    expect(card).toHaveTextContent('不保证服务接受请求尺寸或精确输出')
    expect(card).toHaveTextContent('暂不支持 mask')
    expect(card?.querySelector('input, select, [role="combobox"]')).toBeNull()
    expect(card).not.toHaveTextContent('免费')
  })

  it('shows native capabilities only from the actual builtin registration and does not claim MCP readiness', async () => {
    vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [
      { name: 'codemode', label: 'Native code', description: 'Execute JavaScript', source: 'builtin' },
      { name: 'tool_search', label: 'Native search', description: 'Search tools', source: 'builtin' },
      { name: 'mcp__server__read', label: 'MCP read', description: 'Read remote resource', source: 'builtin' }
    ] }) })
    render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    const code = screen.getByText('Native code').closest('article')
    expect(code).toHaveTextContent('Pi 原生')
    expect(code).toHaveTextContent('models 模型目录')
    expect(code).toHaveTextContent('classifier / image')
    expect(code).toHaveTextContent('可能产生提供商费用')
    expect(code).toHaveTextContent('计划模式禁用')
    expect(code).not.toHaveTextContent('已安装插件')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('全局和受信任项目')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('stdio / HTTP')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('MCP 页查看原生状态，/mcp 为文本状态')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).not.toHaveTextContent('/mcp status')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('login、logout、reconnect')
    expect(screen.getByText(/Pi 原生 MCP 使用 mcp.json/)).toHaveTextContent('配置不会自动迁移，插件不会自动卸载')
    expect(screen.getByText('MCP read').closest('article')).not.toHaveTextContent(/ready|已连接/)
    expect(code?.querySelector('button, input, select')).toBeNull()
  })

  it('keeps built-ins before native and plugin cards with their existing label, source and description fallbacks', async () => {
    vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [
      { name: 'codemode', label: 'Plugin code', description: 'Plugin-only description', source: 'npm:example-plugin' },
      { name: 'native_empty', source: 'builtin' },
      { name: 'plugin_empty', label: '', description: '', source: 'auto' },
      { name: 'tool_search', label: '', description: '', source: 'builtin' },
      { name: 'codemode', label: 'Native code', description: 'Execute JavaScript', source: 'builtin' },
      { name: 'unowned_plugin' }
    ] }) })
    const { container } = render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    const cards = Array.from(container.querySelectorAll('.capability-card-tool'))
    expect(cards.map((card) => card.querySelector('code')?.textContent)).toEqual([
      'read', 'write', 'edit', 'bash', 'pion_task', 'pion_ask_user', IMAGE_GENERATION_TOOL_NAME, 'pion_subagents',
      'native_empty', 'tool_search', 'codemode', 'codemode', 'plugin_empty', 'unowned_plugin'
    ])
    expect(cards.map((card) => card.querySelector('.capability-card-source')?.textContent)).toEqual([
      'Pi 内置', 'Pi 内置', 'Pi 内置', 'Pi 内置', 'Pion 内置', 'Pion 内置', 'Pion 内置', 'Pion 内置',
      'Pi 原生', 'Pi 原生', 'Pi 原生', 'example-plugin', '自动发现', undefined
    ])
    expect(screen.getByText('14 项工具')).toBeInTheDocument()
    expect(cards[8].querySelector('strong')).toHaveTextContent('native_empty')
    expect(cards[8].querySelector('p')).toHaveTextContent('运行时已注册的原生工具；连接与可执行状态以会话为准。')
    expect(cards[9].querySelector('strong')).toHaveTextContent('tool_search')
    expect(cards[9].querySelector('p')).toHaveTextContent('原生延迟工具检索；使用 query 搜索、limit 限制结果数。')
    expect(cards[10].querySelector('p')).toHaveTextContent(/^Execute JavaScript 原生 JavaScript 工具编排/)
    expect(cards[11].querySelector('p')).toHaveTextContent('Plugin-only description')
    expect(cards[12].querySelector('strong')).toHaveTextContent('plugin_empty')
    expect(cards[12].querySelector('p')).toHaveTextContent('已安装插件提供的工具。')
    expect(cards[13].querySelector('strong')).toHaveTextContent('unowned_plugin')
    expect(cards[13].querySelector('p')).toHaveTextContent('已安装插件提供的工具。')
    for (const card of cards.slice(8)) expect(card.querySelector('.capability-card-icon svg')).toHaveClass('lucide-wrench')
  })

  it('preserves separate native and plugin-source card nodes when same-name tools reorder or disappear', async () => {
    const alpha: ToolInfo = { name: 'codemode', label: 'Plugin alpha', source: 'npm:alpha' }
    const native: ToolInfo = { name: 'codemode', label: 'Native code', source: 'builtin' }
    const beta: ToolInfo = { name: 'codemode', label: 'Plugin beta', source: 'npm:beta' }
    const tools = [alpha, native, beta]
    const getCapabilities = vi.fn().mockResolvedValue({ skills: [], tools })
    vi.stubGlobal('pion', { getCapabilities })
    const { container, rerender } = render(<SkillsToolsModal open onClose={vi.fn()} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
    const builtinCard = screen.getByText('读取文件').closest('article')
    const nativeCard = screen.getByText('Native code').closest('article')
    const alphaCard = screen.getByText('Plugin alpha').closest('article')
    const betaCard = screen.getByText('Plugin beta').closest('article')
    expect(new Set([nativeCard, alphaCard, betaCard]).size).toBe(3)
    expect(alphaCard).toHaveTextContent('alpha')
    expect(betaCard).toHaveTextContent('beta')
    // Update only the in-memory loader fixture; reopening would remount the page
    // and could not verify the cards' key-based reconciliation.
    tools.splice(0, tools.length, beta, native, alpha)
    rerender(<SkillsToolsModal open onClose={vi.fn()} />)
    expect(Array.from(container.querySelectorAll('.capability-card-tool')).slice(8)).toEqual([
      nativeCard, betaCard, alphaCard
    ])
    expect(screen.getByText('读取文件').closest('article')).toBe(builtinCard)
    expect(screen.getByText('Native code').closest('article')).toBe(nativeCard)
    expect(screen.getByText('Plugin alpha').closest('article')).toBe(alphaCard)
    expect(screen.getByText('Plugin beta').closest('article')).toBe(betaCard)
    const replacement: ToolInfo = { ...beta, source: 'npm:gamma' }
    tools.splice(0, tools.length, replacement, native)
    rerender(<SkillsToolsModal open onClose={vi.fn()} />)
    expect(screen.getByText('Plugin beta').closest('article')).not.toBe(betaCard)
    expect(screen.getByText('Plugin beta').closest('article')).toHaveTextContent('gamma')
    expect(screen.getByText('Native code').closest('article')).toBe(nativeCard)
    expect(screen.getByText('读取文件').closest('article')).toBe(builtinCard)
    expect(screen.queryByText('Plugin alpha')).not.toBeInTheDocument()
    expect(alphaCard).not.toBeInTheDocument()
    expect(betaCard).not.toBeInTheDocument()
    expect(getCapabilities).toHaveBeenCalledTimes(1)
  })

  it.each(['codemode', 'mcp', 'tool_search', 'mcp__server__read'])(
    'does not advertise absent native capabilities or relabel same-name plugin tools as native: %s', async (name) => {
      vi.stubGlobal('pion', { getCapabilities: vi.fn().mockResolvedValue({ skills: [], tools: [
        { name, label: 'Plugin tool', description: 'Plugin supplied tool', source: 'npm:example-plugin' }
      ] }) })
      render(<SkillsToolsModal open onClose={vi.fn()} />)
      await act(async () => undefined)
      fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
      const plugin = screen.getByText('Plugin tool').closest('article')
      expect(plugin).toHaveTextContent('example-plugin')
      expect(plugin).toHaveTextContent('Plugin supplied tool')
      expect(plugin).not.toHaveTextContent('Pi 原生')
      expect(plugin).not.toHaveTextContent('models 模型目录')
      expect(plugin).not.toHaveTextContent('原生延迟工具检索')
      expect(screen.queryByText(/Pi 原生 MCP 使用 mcp.json/)).not.toBeInTheDocument()
      expect(screen.queryAllByText('tool_search')).toHaveLength(name === 'tool_search' ? 1 : 0)
    }
  )

  it('keeps paged history outside the live reveal path', () => {
    const { container } = render(<ToolCallItem tool={liveTool} historical />)

    expect(container.querySelector('[data-live-output="tool-head"]')).toBeInTheDocument()
    expect(container.querySelector('.tool-head')).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(0)
  })
})
