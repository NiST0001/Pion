// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectList, SidebarToolbar } from '../../src/renderer/src/features/project/Sidebar'
import type { SessionOrganization } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

it('places the archive entry directly after skills and tools and opens only on click', () => {
  const open = vi.fn()
  render(<SidebarToolbar searchQuery="" onSearch={vi.fn()} onNewSession={vi.fn()} onOpenCapabilities={vi.fn()}
    onOpenArchive={open} archiveCount={1} archiveAttention />)
  const tools = screen.getByRole('button', { name: '技能与工具' })
  const archive = screen.getByRole('button', { name: '归档会话' })
  expect(tools.nextElementSibling).toBe(archive)
  expect(archive).toHaveTextContent('归档')
  expect(screen.getByLabelText('等待回答或权限确认')).toBeInTheDocument()
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(archive)
  expect(open).toHaveBeenCalledOnce()
})

it('filters archived rows while retaining running worktree deletion guards and nested search state', () => {
  const cwd = '/project/worktree'
  const archived: SessionMeta = { id: 'archived', path: '/sessions/archived.jsonl', projectCwd: cwd,
    name: '归档运行', timestamp: '2026-01-01', mtime: 1, preview: '', messageCount: 1 }
  const visible: SessionMeta = { ...archived, id: 'visible', path: '/sessions/visible.jsonl', name: '可见会话' }
  const organization: SessionOrganization = { version: 1, revision: 1, folders: [
    { id: 'folder', cwd, name: '父目录', collapsed: true },
    { id: 'child', cwd, name: '子目录', parentId: 'folder', collapsed: true }
  ], sessions: [{ cwd, path: archived.path, archived: true }, { cwd, path: visible.path, folderId: 'child' }] }
  const props: ComponentProps<typeof ProjectList> = {
    projects: [{ cwd: '/project', name: '项目', addedAt: 1, lastUsedAt: 1 }],
    branchesByProject: { '/project': [{ name: 'feature', gitBranch: 'feature', cwd, isMain: false }] },
    sessionsByProject: { [cwd]: [archived, visible] }, organization,
    onOrganizationChange: vi.fn().mockResolvedValue(undefined), searchQuery: '', previewDensity: 'compact',
    runningSessionPaths: new Set([archived.path]), favoritePaths: new Set(), onToggleFavorite: vi.fn(),
    onSelect: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onNewSession: vi.fn(), onNewBranch: vi.fn(),
    onRenameBranch: vi.fn().mockResolvedValue(undefined), onDeleteBranch: vi.fn().mockResolvedValue(undefined),
    onReorder: vi.fn(), onSelectSession: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined),
    onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue('')
  }
  const view = render(<ProjectList {...props} />)
  expect(screen.queryByText('归档运行')).not.toBeInTheDocument()
  const row = screen.getByText('可见会话').closest('[data-session-path]')!
  expect(row).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '分支操作 feature' }))
  expect(screen.getByRole('menuitem', { name: '删除分支' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '删除分支' })).toHaveAttribute('title', '此分支有运行中的会话，请先停止')
  fireEvent.keyDown(window, { key: 'Escape' })
  view.rerender(<ProjectList {...props} searchQuery="可见" />)
  expect(screen.getByText('可见会话').closest('[data-session-path]')).toBe(row)
  expect(row).toBeVisible()
  expect(props.onOrganizationChange).not.toHaveBeenCalled()
  fireEvent.click(row)
  expect(props.onSelectSession).toHaveBeenCalledWith(cwd, visible.path)
  view.rerender(<ProjectList {...props} />)
  expect(row).not.toBeVisible()
})
