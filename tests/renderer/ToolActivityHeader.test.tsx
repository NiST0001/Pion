// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolActivityHeader } from '../../src/renderer/src/features/chat/ToolActivityHeader'
import * as reveal from '../../src/renderer/src/utils/screenTextReveal'

const summary = { label: '读取2个文件，编辑1个文件，搜索3次，终端1次', total: 7, running: 1, errors: 2 }
const css = readFileSync(resolve('src/renderer/src/styles/tool-activity.css'), 'utf8')
const sharedCss = readFileSync(resolve('src/renderer/src/styles/refinements.css'), 'utf8')

beforeEach(() => reveal.resetLineRevealClock())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ToolActivityHeader', () => {
  it('uses a controlled whole-row native button and preserves visible failures while closed', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<ToolActivityHeader summary={summary} open={false} onToggle={onToggle} noReveal />)
    const button = screen.getByRole('button', { name: '展开工具调用（7次）' })
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('title', `${summary.label}；当前连续工具调用记录，文件按原始路径去重，含尝试/失败，不是Git净变动或文件修改成功保证`)
    expect(button).toHaveTextContent(summary.label)
    expect(screen.getByText('执行中')).toBeVisible()
    expect(screen.getByText('2项失败')).toBeVisible()
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByText(summary.label))
    fireEvent.click(screen.getByText('2项失败'))
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    rerender(<ToolActivityHeader summary={summary} open onToggle={onToggle} noReveal />)
    expect(screen.getByRole('button', { name: '收起工具调用（7次）' })).toBe(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('2项失败')).toBeVisible()
  })

  it('supports native Enter and Space and retains focused DOM in read-only presentation', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [open, setOpen] = useState(false)
      return <ToolActivityHeader summary={summary} open={open} onToggle={() => setOpen((value) => !value)} noReveal />
    }
    render(<Controlled />)
    const button = screen.getByRole('button')
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  it('keeps the live line ref, assigned delay and DOM stable across count/status and toggle changes', () => {
    const attach = vi.spyOn(reveal, 'assignLineRevealDelay')
    const onToggle = vi.fn()
    const { container, rerender } = render(<ToolActivityHeader summary={summary} open={false} onToggle={onToggle} />)
    const button = screen.getByRole('button')
    const caption = container.querySelector('.tool-activity-caption')
    const errors = screen.getByText('2项失败')
    expect(button).toHaveClass('screen-text-reveal-line', 'screen-text-reveal-line-live')
    expect(button).toHaveAttribute('data-line-reveal-ready', 'true')
    const delay = button.style.getPropertyValue('--screen-text-reveal-delay')
    expect(delay).toMatch(/^\d+ms$/)
    const attachments = attach.mock.calls.length
    rerender(<ToolActivityHeader summary={{ ...summary, label: '读取3个文件，终端2次', total: 8, running: 0, errors: 3 }} open onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: '收起工具调用（8次）' })).toBe(button)
    expect(container.querySelector('.tool-activity-caption')).toBe(caption)
    expect(screen.getByText('3项失败')).toBe(errors)
    expect(screen.queryByText('执行中')).not.toBeInTheDocument()
    expect(attach).toHaveBeenCalledTimes(attachments)
    expect(button.style.getPropertyValue('--screen-text-reveal-delay')).toBe(delay)
    expect(container.querySelector('[data-screen-reveal-character]')).toBeNull()
  })

  it('defers history to the shared DOM-order scan and does not requeue after updates', () => {
    const { container, rerender } = render(<ToolActivityHeader summary={summary} open={false} onToggle={() => {}} historical />)
    const button = screen.getByRole('button')
    expect(button).toHaveClass('screen-text-reveal-line-history')
    expect(button).not.toHaveAttribute('data-line-reveal-ready')
    reveal.assignPendingLineDelays(container)
    expect(button).toHaveAttribute('data-line-reveal-ready', 'true')
    const delay = button.style.getPropertyValue('--screen-text-reveal-delay')
    rerender(<ToolActivityHeader summary={{ ...summary, running: 0 }} open onToggle={() => {}} historical />)
    reveal.assignPendingLineDelays(container)
    expect(screen.getByRole('button')).toBe(button)
    expect(button.style.getPropertyValue('--screen-text-reveal-delay')).toBe(delay)
  })

  it('does not replay a live row on history backfill, or animate an initially static row later', () => {
    const view = render(<ToolActivityHeader summary={summary} open={false} onToggle={() => {}} />)
    const button = view.getByRole('button')
    const initialClass = button.className
    view.rerender(<ToolActivityHeader summary={summary} open onToggle={() => {}} historical />)
    expect(view.getByRole('button')).toBe(button)
    expect(button.className).toBe(initialClass)
    view.unmount()
    const raw = render(<ToolActivityHeader summary={summary} open={false} onToggle={() => {}} noReveal />)
    raw.rerender(<ToolActivityHeader summary={summary} open onToggle={() => {}} />)
    expect(raw.getByRole('button')).not.toHaveClass(reveal.SCREEN_TEXT_REVEAL_LINE_CLASS)
  })

  it('does not allocate a line or character reveal for noReveal', () => {
    const attach = vi.spyOn(reveal, 'assignLineRevealDelay')
    const { container, rerender } = render(<ToolActivityHeader summary={summary} open={false} onToggle={() => {}} historical noReveal />)
    const button = screen.getByRole('button')
    rerender(<ToolActivityHeader summary={{ ...summary, errors: 0, running: 0 }} open onToggle={() => {}} historical noReveal />)
    expect(button.className).toBe('tool-activity-header')
    expect(button).not.toHaveAttribute('data-line-reveal-ready')
    expect(attach).not.toHaveBeenCalled()
    expect(container.querySelector('[data-screen-reveal-character]')).toBeNull()
    expect(screen.queryByText('执行中')).not.toBeInTheDocument()
    expect(screen.queryByText(/项失败/)).not.toBeInTheDocument()
  })
})

describe('tool activity style contracts (static, not GUI validation)', () => {
  it('keeps wrappers mounted but explicitly removes hidden wrappers from layout', () => {
    expect(css).toMatch(/\.tool-activity-item\s*\{\s*display:\s*grid;\s*grid-template-rows:\s*0fr;\s*margin:\s*-12px 0;/)
    expect(css).toMatch(/\.tool-activity-inner\s*>\s*\.tool-call\s*\{\s*margin:\s*0;/)
    expect(css).toContain('grid-template-rows 180ms var(--motion-ease-out)')
    expect(css).toContain('margin 180ms var(--motion-ease-out)')
    expect(css).toContain('@starting-style')
    expect(css).toMatch(/\.tool-activity-inner\s*\{\s*min-height:\s*0;\s*overflow:\s*hidden;/)
    expect(css).toMatch(/\.tool-activity-item\[hidden\]\s*\{\s*display:\s*none;/)
    expect(css).toMatch(/\.child-chat-scroll \.timeline > \.tool-activity-item \+ \.tool-activity-item\s*\{\s*margin-top:\s*-12px;/)
  })

  it('preserves a transparent, single-line caption and full native click target using theme tokens', () => {
    expect(css).toMatch(/button\.tool-activity-header\s*\{[^}]*display:\s*flex;/)
    expect(css).toContain('flex-wrap: nowrap;')
    expect(css).toContain('min-height: 28px;')
    expect(css).toContain('background: transparent;')
    expect(css).toContain('border-radius: var(--radius-sm);')
    expect(css).toContain('color: var(--fg-dim);')
    expect(css).toContain('color: var(--danger);')
    expect(css).toMatch(/\.tool-activity-caption\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap;/)
    expect(css).toMatch(/\.tool-activity-running,\s*\.tool-activity-errors\s*\{[^}]*flex:\s*0 0 auto;/)
  })

  it('uses gated keyboard focus, motion and high-contrast fallbacks with the shared linear line fade', () => {
    expect(css).toContain('html.pion-keyboard-focus .tool-activity-header:focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('transition: none;')
    expect(css).toContain('animation: none;')
    expect(css).toContain('opacity: 1;')
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toContain('color: ButtonText;')
    expect(css).toContain('outline-color: Highlight;')
    expect(sharedCss).toMatch(/\.screen-text-reveal-line\[data-line-reveal-ready="true"\]\s*\{[^}]*screen-text-reveal 280ms linear/)
    expect(sharedCss).toMatch(/\.screen-text-reveal-line-live\[data-line-reveal-ready="true"\]\s*\{[^}]*animation-duration:\s*560ms;/)
  })
})
