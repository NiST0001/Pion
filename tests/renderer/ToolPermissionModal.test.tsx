// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolPermissionModal } from '../../src/renderer/src/features/operations/ToolPermissionModal'
import type { ToolPermissionRequest } from '../../src/shared/types'

const request: ToolPermissionRequest = {
  id: 'once', cwd: '/project', toolName: 'codemode', category: 'external',
  policyCategories: ['external'], summary: '确认一次调用', detail: '可能产生额外用量',
  risks: [], canRemember: false, createdAt: 0, timeoutAt: Date.now() + 60_000
}

describe('tool permission allowance choices', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('hides all persistent choices for a risk-free once-only request', () => {
    const resolve = vi.fn()
    render(<ToolPermissionModal request={request} queueLength={1} busy={false} error="" onResolve={resolve} />)
    expect(screen.getByRole('button', { name: /工具授权/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '仅这一次' })).toBeEnabled()
    expect(resolve).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '当前会话允许' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '此项目始终允许' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '仅这一次' }))
    expect(resolve).toHaveBeenCalledExactlyOnceWith('allow-once')
  })

  it('shows both persistent choices only when the request permits remembering', () => {
    const resolve = vi.fn()
    render(<ToolPermissionModal request={{ ...request, canRemember: true }} queueLength={1} busy={false} error="" onResolve={resolve} />)
    fireEvent.click(screen.getByRole('button', { name: '当前会话允许' }))
    expect(resolve).toHaveBeenLastCalledWith('allow-session')
    fireEvent.click(screen.getByRole('button', { name: '此项目始终允许' }))
    expect(resolve).toHaveBeenLastCalledWith('allow-project')
  })

  it('also hides persistent choices for a flagged risk even with an inconsistent remember flag', () => {
    render(<ToolPermissionModal request={{ ...request, canRemember: true, risks: ['sensitive-path'] }} queueLength={1} busy={false} error="" onResolve={vi.fn()} />)
    expect(screen.getByText('有风险')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '当前会话允许' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '此项目始终允许' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '仅这一次' })).toBeEnabled()
  })

  it('retains expansion and the original deadline when hidden, with Escape only folding its own focused panel', () => {
    vi.useFakeTimers()
    const listeners = vi.spyOn(window, 'addEventListener')
    const resolve = vi.fn()
    const pending = { ...request, timeoutAt: Date.now() + 60_000 }
    const view = render(<ToolPermissionModal request={pending} queueLength={2} busy={false} error="" onResolve={resolve} />)
    const toggle = screen.getByRole('button', { name: /工具授权/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: request.summary })).not.toHaveAttribute('aria-modal')
    expect(listeners.mock.calls.some(([name]) => name === 'keydown')).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(resolve).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const allow = screen.getByRole('button', { name: '仅这一次' })
    allow.focus()
    fireEvent.keyDown(allow, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
    act(() => vi.advanceTimersByTime(10_000))
    view.rerender(<ToolPermissionModal active={false} request={pending} queueLength={2} busy={false} error="" onResolve={resolve} />)
    view.rerender(<ToolPermissionModal active request={pending} queueLength={2} busy={false} error="" onResolve={resolve} />)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '仅这一次' })).not.toBeInTheDocument()
    expect(resolve).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '仅这一次' })).toBe(allow)
    expect(screen.getByText('50 秒后自动拒绝')).toBeInTheDocument()

    view.rerender(<ToolPermissionModal active={false} request={pending} queueLength={2} busy={false} error="" onResolve={resolve} />)
    expect(view.container.querySelector('.tool-permission-backdrop')).toHaveAttribute('hidden')
    expect(view.container.querySelector('.tool-permission-backdrop')).toHaveAttribute('inert')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(15_000))
    fireEvent.keyDown(allow, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    view.rerender(<ToolPermissionModal active request={pending} queueLength={2} busy={false} error="提交失败详情" onResolve={resolve} />)
    expect(screen.getByRole('button', { name: '仅这一次' })).toBe(allow)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('35 秒后自动拒绝')).toBeInTheDocument()
    expect(screen.getByText('提交失败详情')).toBeInTheDocument()
    expect(resolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(resolve).toHaveBeenCalledExactlyOnceWith('deny')
  })

  it('lets the session stack own positioning and keeps details scroll-bounded', () => {
    const css = readFileSync('src/renderer/src/styles/permissions.css', 'utf8')
    const stack = css.match(/\.session-interaction-panels > \.tool-permission-backdrop\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(stack).toContain('position: static')
    expect(stack).toContain('inset: auto')
    expect(stack).toContain('bottom: auto')
    expect(stack).toContain('padding: 0')
    const common = readFileSync('src/renderer/src/styles/extension-ui.css', 'utf8')
    const details = common.match(/\.session-interaction-content\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(details).toContain('max-height: min(420px')
    expect(common).toContain('overscroll-behavior: contain')
  })
})
