// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'
import type { SessionMeta } from '../../src/shared/types'

const optimistic: SessionMeta = {
  projectCwd: '/tmp/project',
  path: 'pion:pending:new-session',
  id: 'new-session',
  timestamp: '2026-01-01T00:00:00Z',
  mtime: 1,
  preview: 'first prompt',
  messageCount: 1,
  optimistic: true
}

describe('SessionItems optimistic projection', () => {
  it('shows persistence state without exposing path actions or reorder', () => {
    const onSelect = vi.fn()
    const onToggleFavorite = vi.fn()
    const { container } = render(
      <SessionItems
        sessions={[optimistic]}
        runningSessionPaths={new Set()}
        previewDensity="compact"
        favoritePaths={new Set()}
        onSelect={onSelect}
        onReorder={vi.fn()}
        onDelete={vi.fn()}
        onCopy={vi.fn()}
        onRename={vi.fn()}
        onOpenTaskHistory={vi.fn()}
        getForkMessages={vi.fn().mockResolvedValue([])}
        onFork={vi.fn().mockResolvedValue('')}
        onToggleFavorite={onToggleFavorite}
      />
    )

    const row = container.querySelector<HTMLElement>('.side-session')
    expect(row).toHaveClass('optimistic', 'running')
    expect(row).toHaveAttribute('aria-busy', 'true')
    expect(row?.draggable).toBe(false)
    expect(screen.getByLabelText('正在保存新会话')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '收藏会话' })).not.toBeInTheDocument()

    fireEvent.click(row as HTMLElement)
    fireEvent.contextMenu(row as HTMLElement)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onToggleFavorite).not.toHaveBeenCalled()
    expect(container.querySelector('.context-menu')).not.toBeInTheDocument()
  })

  it('highlights a session with unread output', () => {
    const session: SessionMeta = {
      projectCwd: '/tmp/project',
      path: '/tmp/project/session.jsonl',
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00Z',
      mtime: 1,
      preview: 'completed task',
      messageCount: 2
    }
    const { container } = render(
      <SessionItems
        sessions={[session]}
        runningSessionPaths={new Set()}
        unreadSessionPaths={new Set([session.path])}
        previewDensity="compact"
        favoritePaths={new Set()}
        onSelect={vi.fn()}
        onDelete={vi.fn(async () => undefined)}
        onCopy={vi.fn(async () => undefined)}
        onRename={vi.fn(async () => undefined)}
        onOpenTaskHistory={vi.fn()}
        getForkMessages={vi.fn().mockResolvedValue([])}
        onFork={vi.fn().mockResolvedValue('')}
        onToggleFavorite={vi.fn()}
      />
    )

    expect(container.querySelector('.side-session')).toHaveClass('unread')
    expect(screen.getByLabelText('未读会话')).toBeInTheDocument()
  })
})
