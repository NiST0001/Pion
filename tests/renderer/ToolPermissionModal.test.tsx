// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolPermissionModal } from '../../src/renderer/src/features/operations/ToolPermissionModal'
import type { ToolPermissionRequest } from '../../src/shared/types'

const request: ToolPermissionRequest = {
  id: 'once', cwd: '/project', toolName: 'codemode', category: 'external',
  policyCategories: ['external'], summary: '确认一次调用', detail: '可能产生额外用量',
  risks: [], canRemember: false, createdAt: 0, timeoutAt: Date.now() + 60_000
}

describe('tool permission allowance choices', () => {
  it('hides all persistent choices for a risk-free once-only request', () => {
    const resolve = vi.fn()
    render(<ToolPermissionModal request={request} queueLength={1} busy={false} error="" onResolve={resolve} />)
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
    expect(screen.queryByRole('button', { name: '当前会话允许' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '此项目始终允许' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '仅这一次' })).toBeEnabled()
  })
})
