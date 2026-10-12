// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'
import { ProjectList } from '../../src/renderer/src/features/project/Sidebar'
import type { SessionMeta } from '../../src/shared/types'
import type { SubagentSessionSummary } from '../../src/shared/subagent-sessions'

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

describe('SessionItems temporary children', () => {
  it('reserves intrinsic status width and makes only the title column shrink on sidebar resize', () => {
    // CSS contract only: jsdom does not prove real Electron geometry.
    const css = readFileSync('src/renderer/src/styles/subagent-sessions.css', 'utf8')
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{([^}]+)\\}`))?.[1] ?? ''
    expect(rule('side-subagent-session-items')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(rule('side-subagent-session')).toContain('grid-template-columns: minmax(0, 1fr) max-content')
    expect(rule('side-subagent-name')).toContain('min-width: 0')
    expect(rule('side-subagent-name')).toContain('text-overflow: ellipsis')
    expect(rule('side-subagent-status')).toContain('min-width: max-content')
    expect(rule('side-subagent-status')).toContain('white-space: nowrap')
  })
  it('passes child props through project, folder and worktree without adding to normal counts', () => {
    const session = { ...optimistic, path: '/parent.jsonl', optimistic: false }
    const child: SubagentSessionSummary = { id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool', parentSessionId: 'parent', parentSessionPath: session.path, cwd: session.projectCwd!, name: '项目子任务', status: 'running', revision: 1, truncated: false }
    const onViewSubagent = vi.fn()
    const onSelectSession = vi.fn()
    const { container } = render(<ProjectList
      projects={[{ cwd: session.projectCwd!, name: '项目', addedAt: 1, lastUsedAt: 1 }]}
      sessionsByProject={{ [session.projectCwd!]: [session] }} branchesByProject={{}} searchQuery=""
      runningSessionPaths={new Set()} previewDensity="compact" favoritePaths={new Set()}
      subagentSessions={[child]} selectedSubagent={child} activePath={session.path} onViewSubagent={onViewSubagent}
      onSelect={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onNewSession={vi.fn()} onNewBranch={vi.fn()}
      onRenameBranch={vi.fn()} onReorder={vi.fn()} onSelectSession={onSelectSession} onDelete={vi.fn()} onCopy={vi.fn()}
      onRename={vi.fn()} onOpenTaskHistory={vi.fn()} getForkMessages={vi.fn().mockResolvedValue([])} onFork={vi.fn().mockResolvedValue('')}
      onToggleFavorite={vi.fn()}
    />)
    expect(screen.getByRole('button', { name: '查看子会话 项目子任务 · 运行中' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: '查看子会话 项目子任务 · 运行中' })).toHaveAttribute('aria-current', 'true')
    expect(container.querySelector('.side-session')).not.toHaveClass('active')
    fireEvent.click(screen.getByRole('button', { name: '查看子会话 项目子任务 · 运行中' }))
    expect(onViewSubagent).toHaveBeenCalledWith(child)
    expect(onSelectSession).not.toHaveBeenCalled()
    expect(container.querySelector('.project-branch-count')).toHaveTextContent('1')
    expect(container.querySelector('.side-session')).not.toHaveClass('running')
  })
  it('selects the exact backend/child pair and returns through the parent row callback', () => {
    const parent = { ...optimistic, path: '/parent.jsonl', optimistic: false }
    const child: SubagentSessionSummary = { id: 'shared-id', backendId: 'backend-a', runtimeId: 'runtime', parentToolCallId: 'tool', parentSessionId: 'parent', parentSessionPath: parent.path, cwd: parent.projectCwd!, name: '子任务 A', status: 'running', revision: 1, truncated: false }
    const otherBackend = { ...child, backendId: 'backend-b', name: '子任务 B', status: 'completed' as const }
    const sibling = { ...parent, path: '/sibling.jsonl', id: 'sibling' }
    const onSelect = vi.fn()
    const onViewSubagent = vi.fn()
    function ListSelection() {
      const [selectedSubagent, setSelectedSubagent] = useState<Pick<SubagentSessionSummary, 'id' | 'backendId'> | null>(null)
      return <SessionItems
        sessions={[parent, sibling]} activePath={parent.path} selectedSubagent={selectedSubagent}
        subagentSessions={[child, otherBackend]} runningSessionPaths={new Set([parent.path])}
        previewDensity="compact" favoritePaths={new Set()}
        onSelect={(path) => { setSelectedSubagent(null); onSelect(path) }}
        onViewSubagent={(summary) => { setSelectedSubagent(summary); onViewSubagent(summary) }}
        onDelete={vi.fn()} onCopy={vi.fn()} onRename={vi.fn()} onOpenTaskHistory={vi.fn()}
        getForkMessages={vi.fn().mockResolvedValue([])} onFork={vi.fn().mockResolvedValue('')} onToggleFavorite={vi.fn()}
      />
    }
    const { container } = render(<ListSelection />)
    const parentRow = container.querySelector<HTMLElement>('[data-session-path="/parent.jsonl"]')!
    const siblingRow = container.querySelector<HTMLElement>('[data-session-path="/sibling.jsonl"]')!
    const childA = screen.getByRole('button', { name: '查看子会话 子任务 A · 运行中' })
    const childB = screen.getByRole('button', { name: '查看子会话 子任务 B · 已完成' })
    expect(parentRow).toHaveClass('active', 'running')
    expect(parentRow).toHaveAttribute('aria-current', 'true')
    expect(childA).not.toHaveClass('active')
    expect(childB).not.toHaveClass('active')

    fireEvent.click(childA)
    expect(onViewSubagent).toHaveBeenLastCalledWith(child)
    expect(onSelect).not.toHaveBeenCalled()
    expect(childA).toHaveClass('active')
    expect(childA).toHaveAttribute('aria-current', 'true')
    expect(childB).not.toHaveClass('active')
    expect(childB).not.toHaveAttribute('aria-current')
    expect(parentRow).not.toHaveClass('active')
    expect(parentRow).not.toHaveAttribute('aria-current')
    expect(parentRow).toHaveClass('running')
    expect(siblingRow).not.toHaveClass('running')
    expect(siblingRow).not.toHaveClass('active')

    fireEvent.click(childB)
    expect(onViewSubagent).toHaveBeenLastCalledWith(otherBackend)
    expect(childB).toHaveClass('active')
    expect(childB).toHaveAttribute('aria-current', 'true')
    expect(childA).not.toHaveClass('active')
    expect(childA).not.toHaveAttribute('aria-current')

    fireEvent.click(parentRow)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(parent.path)
    expect(onViewSubagent).toHaveBeenCalledTimes(2)
    expect(parentRow).toHaveClass('active', 'running')
    expect(parentRow).toHaveAttribute('aria-current', 'true')
    expect(childA).not.toHaveClass('active')
    expect(childB).not.toHaveClass('active')
    expect(screen.queryByRole('button', { name: '返回父会话' })).not.toBeInTheDocument()
  })
  it('folds each parent independently without selecting a session and keeps folds through child updates', () => {
    const parent = { ...optimistic, path: '/parent.jsonl', optimistic: false }
    const other = { ...parent, path: '/other.jsonl' }
    const child: SubagentSessionSummary = { id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool', parentSessionId: 'parent', parentSessionPath: parent.path, cwd: parent.projectCwd!, name: '检查', status: 'running', revision: 1, truncated: false }
    const sibling = { ...child, id: 'sibling', parentSessionPath: other.path, name: '另一项检查' }
    const props = {
      sessions: [parent, other], previewDensity: 'compact' as const, runningSessionPaths: new Set([parent.path]), favoritePaths: new Set<string>(),
      onSelect: vi.fn(), onDelete: vi.fn(), onCopy: vi.fn(), onRename: vi.fn(), onOpenTaskHistory: vi.fn(),
      getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue(''), onToggleFavorite: vi.fn(), onViewSubagent: vi.fn(),
      selectedSubagent: child
    }
    const view = render(<SessionItems {...props} subagentSessions={[child, sibling]} />)
    const [first, second] = Array.from(view.container.querySelectorAll<HTMLDetailsElement>('details.side-subagent-sessions'))
    const selected = view.getByRole('button', { name: '查看子会话 检查 · 运行中' })
    expect(first.open).toBe(true)
    expect(second.open).toBe(true)
    expect(first.querySelector('.side-subagent-count')).toHaveTextContent('1')
    fireEvent.click(first.querySelector('summary')!)
    // JSDOM's native summary activation varies; explicitly apply the browser
    // disclosure state, then verify React refreshes leave that state alone.
    first.open = false
    fireEvent(first, new Event('toggle'))
    expect(selected).not.toBeVisible()
    expect(selected).toHaveAttribute('aria-current', 'true')
    expect(second.open).toBe(true)
    expect(view.container.querySelector('[data-session-path="/parent.jsonl"]')).toHaveClass('running')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onViewSubagent).not.toHaveBeenCalled()

    view.rerender(<SessionItems {...props} sessions={[other, parent]} subagentSessions={[
      { ...child, revision: 2 }, sibling, { ...child, id: 'new-child', name: '新子任务' }
    ]} />)
    expect(view.container.querySelectorAll('details.side-subagent-sessions')[1]).toBe(first)
    expect(first.open).toBe(false)
    expect(first.querySelector('.side-subagent-count')).toHaveTextContent('2')
    expect(first.querySelector('.side-subagent-session')).toBe(selected)
    expect(second.open).toBe(true)
    first.open = true
    fireEvent(first, new Event('toggle'))
    expect(selected).toBeVisible()
    fireEvent.click(selected)
    expect(props.onViewSubagent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: child.id, revision: 2 }))
    expect(props.onSelect).not.toHaveBeenCalled()
    view.rerender(<SessionItems {...props} subagentSessions={[sibling]} />)
    expect(view.container.querySelectorAll('details.side-subagent-sessions')).toHaveLength(1)
    expect(view.container.querySelector('details.side-subagent-sessions')).toBe(second)
  })

  it('scopes children to exact cwd/path and isolates child actions while preserving the normal row', () => {
    const parent = { ...optimistic, path: '/parent.jsonl', optimistic: false }
    const child: SubagentSessionSummary = { id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool', parentSessionId: 'parent', parentSessionPath: parent.path, cwd: parent.projectCwd!, name: '检查', status: 'completed', revision: 1, truncated: false }
    const props = {
      sessions: [parent], previewDensity: 'compact' as const, runningSessionPaths: new Set<string>(), favoritePaths: new Set<string>(),
      onSelect: vi.fn(), onReorder: vi.fn(), onDelete: vi.fn(), onCopy: vi.fn(), onRename: vi.fn(), onOpenTaskHistory: vi.fn(),
      getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue(''), onToggleFavorite: vi.fn(), onViewSubagent: vi.fn()
    }
    const { container, rerender } = render(<SessionItems {...props} subagentSessions={[child, { ...child, id: 'wrong-cwd', cwd: '/other', name: '其他项目' }, { ...child, id: 'wrong-path', parentSessionPath: '/other.jsonl', name: '其他会话' }]} />)
    const row = container.querySelector('.side-session')
    const button = screen.getByRole('button', { name: '查看子会话 检查 · 已完成' })
    expect(container.querySelectorAll('.side-subagent-session')).toHaveLength(1)
    expect(button).toHaveAttribute('draggable', 'false')
    fireEvent.click(button)
    fireEvent.contextMenu(button)
    fireEvent.dragStart(button)
    expect(props.onViewSubagent).toHaveBeenCalledWith(child)
    for (const callback of [props.onSelect, props.onReorder, props.onDelete, props.onCopy, props.onRename, props.onFork, props.onToggleFavorite]) expect(callback).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    rerender(<SessionItems {...props} subagentSessions={[]} />)
    expect(container.querySelector('.side-session')).toBe(row)
    expect(container.querySelector('.side-subagent-session')).toBeNull()
    rerender(<SessionItems {...props} onViewSubagent={undefined} subagentSessions={[child]} />)
    expect(container.querySelector('.side-subagent-session')).toBeNull()
  })
})

describe('SessionItems running indicator state', () => {
  it('scopes the light to running rows without changing selection, unread or favorite actions', () => {
    const session: SessionMeta = {
      ...optimistic,
      path: '/tmp/project/running-session.jsonl',
      id: 'running-session',
      optimistic: false
    }
    const onToggleFavorite = vi.fn()
    const props = {
      sessions: [session],
      activePath: session.path,
      unreadSessionPaths: new Set([session.path]),
      previewDensity: 'compact' as const,
      favoritePaths: new Set([session.path]),
      onSelect: vi.fn(),
      onReorder: vi.fn(),
      onDelete: vi.fn(async () => undefined),
      onCopy: vi.fn(async () => undefined),
      onRename: vi.fn(async () => undefined),
      onOpenTaskHistory: vi.fn(),
      getForkMessages: vi.fn().mockResolvedValue([]),
      onFork: vi.fn().mockResolvedValue(''),
      onToggleFavorite
    }
    const { container, rerender } = render(
      <SessionItems {...props} runningSessionPaths={new Set([session.path])} />
    )
    const row = container.querySelector('.side-session')
    expect(row).toHaveClass('running', 'active', 'unread')
    expect(row?.querySelector('.side-item-label')).toHaveTextContent(session.preview!)
    expect(screen.getByLabelText('未读会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消收藏会话' }))
    expect(onToggleFavorite).toHaveBeenCalledWith(session.path)
    expect(props.onSelect).not.toHaveBeenCalled()

    rerender(<SessionItems {...props} runningSessionPaths={new Set()} />)
    expect(container.querySelector('.side-session')).toBe(row)
    expect(row).not.toHaveClass('running')
    expect(row).toHaveClass('active', 'unread')
    expect(row?.querySelector('.side-item-label')).toHaveTextContent(session.preview!)
  })
})

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
