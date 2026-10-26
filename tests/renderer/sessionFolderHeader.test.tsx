// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectList } from '../../src/renderer/src/features/project/Sidebar'
import type { SessionOrganization } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { SESSION_DRAG_MIME } from '../../src/renderer/src/utils/sessionDrag'

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })
const cwd = '/project'
const featureCwd = '/project/.pion-worktrees/feature'
const session = (id: string, projectCwd = cwd): SessionMeta => ({ id, path: `/sessions/${id}.jsonl`, projectCwd,
  name: id, timestamp: '2026-01-01', mtime: 1, preview: '', messageCount: 1 })
const root = session('root'), nested = session('nested'), feature = session('feature', featureCwd)
function props(): ComponentProps<typeof ProjectList> {
  const organization: SessionOrganization = { version: 1, revision: 1, folders: [
    { id: 'parent', cwd, name: '父目录' }, { id: 'child', cwd, name: '子目录', parentId: 'parent' }
  ], sessions: [{ cwd, path: nested.path, folderId: 'child' }] }
  return {
    projects: [{ cwd, name: '项目', addedAt: 1, lastUsedAt: 1 }],
    branchesByProject: { [cwd]: [
      { name: 'main', gitBranch: 'main', cwd, isMain: true },
      { name: 'feature', gitBranch: 'feature', cwd: featureCwd, isMain: false }
    ] }, sessionsByProject: { [cwd]: [root, nested], [featureCwd]: [feature] }, organization,
    onOrganizationChange: vi.fn().mockResolvedValue(undefined), searchQuery: '', previewDensity: 'compact',
    runningSessionPaths: new Set(), favoritePaths: new Set(), onToggleFavorite: vi.fn(),
    onSelect: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onNewSession: vi.fn(), onNewBranch: vi.fn(),
    onRenameBranch: vi.fn().mockResolvedValue(undefined), onDeleteBranch: vi.fn().mockResolvedValue(undefined),
    onReorder: vi.fn(), onSelectSession: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined),
    onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue('')
  }
}
function header(name: string): HTMLElement {
  return screen.getByRole('button', { name: `在 ${name} 分支中新建文件夹` }).closest<HTMLElement>('.project-branch-head')!
}
function row(container: HTMLElement, path: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('[data-session-path]')].find((element) => element.dataset.sessionPath === path)!
}
function drag(source: HTMLElement) {
  const values = new Map<string, string>()
  const dataTransfer = { effectAllowed: '', dropEffect: '',
    get types() { return [...values.keys()] },
    setData: (type: string, value: string) => { values.set(type, value) },
    getData: (type: string) => values.get(type) ?? '' }
  fireEvent.dragStart(source, { dataTransfer })
  expect(dataTransfer.types).toContain(SESSION_DRAG_MIME)
  return dataTransfer
}

it('places one folder action beside each branch’s new-session action and creates in the expanded owning worktree', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'created-folder' })
  const callbacks = props(), view = render(<ProjectList {...callbacks} />)
  expect(screen.queryByRole('group', { name: '会话根目录' })).not.toBeInTheDocument()
  expect(screen.queryByText('根目录', { exact: true })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '新建文件夹', exact: true })).not.toBeInTheDocument()
  expect(view.container.querySelectorAll('.project-branch-new-folder')).toHaveLength(2)
  expect(row(view.container, root.path).closest('[data-folder-id]')).toBeNull()
  for (const [name, branchCwd] of [['main', cwd], ['feature', featureCwd]]) {
    const head = header(name)
    const create = within(head).getByRole('button', { name: `在 ${name} 分支中新建文件夹` })
    const newSession = within(head).getByTitle(`在 ${name} 分支中新建会话`)
    expect(newSession.nextElementSibling).toBe(create)
    expect(create).toHaveAttribute('title', `在 ${name} 分支中新建文件夹`)
    expect(create).toHaveClass('project-branch-new', 'project-branch-new-folder')
    expect(head).toHaveAttribute('draggable', 'true')
    expect(head).toHaveAttribute('data-sidebar-drag-kind', 'branch')
    expect(head.closest('.session-folder-tree')).toBeNull()
    const tree = head.parentElement!.querySelector('.session-folder-tree')!
    expect(tree).toHaveClass('project-branch-sessions')
    expect(tree.querySelector('.session-folder-create')).toBeNull()
    fireEvent.click(newSession)
    expect(callbacks.onNewSession).toHaveBeenLastCalledWith(branchCwd)
    fireEvent.click(within(head).getByRole('button', { name: `收起 ${name} 分支` }))
    expect(tree).toHaveAttribute('hidden')
    expect(tree).toHaveAttribute('inert')
    fireEvent.click(create)
    expect(tree).not.toHaveAttribute('hidden')
    expect(tree).not.toHaveAttribute('inert')
    expect(screen.getByRole('dialog', { name: '新建文件夹' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: '文件夹名称' }), { target: { value: `${name}目录` } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(callbacks.onOrganizationChange).toHaveBeenLastCalledWith({
      type: 'createFolder', cwd: branchCwd, id: 'created-folder', name: `${name}目录`
    })
    expect(header(name)).toBe(head)
    expect(head.parentElement!.querySelector('.session-folder-tree')).toBe(tree)
  }
  expect(callbacks.onOrganizationChange).toHaveBeenCalledTimes(2)
})

it('keeps nested drop targets and uses the owning branch header for root drops while retaining save gating', async () => {
  const callbacks = props(), view = render(<ProjectList {...callbacks} />)
  const head = header('main'), foreignHead = header('feature')
  expect(head).toHaveAttribute('data-session-drop-target', 'root')
  expect(head.parentElement!.querySelector('.session-folder-tree')).not.toHaveAttribute('data-session-drop-target')
  const child = view.container.querySelector<HTMLElement>('[data-session-drop-target="child"]')!
  const rootDrag = drag(row(view.container, root.path))
  fireEvent.dragOver(child, { dataTransfer: rootDrag })
  expect(child).toHaveClass('session-folder-drop-target')
  expect(head).not.toHaveClass('session-folder-drop-target')
  await act(async () => { fireEvent.drop(child, { dataTransfer: rootDrag }) })
  expect(callbacks.onOrganizationChange).toHaveBeenLastCalledWith({ type: 'setSession', cwd, path: root.path, folderId: 'child' })
  const foreignDrag = drag(row(view.container, nested.path))
  fireEvent.dragOver(foreignHead, { dataTransfer: foreignDrag })
  expect(foreignHead).not.toHaveClass('session-folder-drop-target')
  await act(async () => { fireEvent.drop(foreignHead, { dataTransfer: foreignDrag }) })
  expect(callbacks.onOrganizationChange).toHaveBeenCalledTimes(1)
  let resolve!: () => void
  vi.mocked(callbacks.onOrganizationChange!).mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
  const source = row(view.container, nested.path), rootDrop = drag(source)
  fireEvent.dragOver(head, { dataTransfer: rootDrop })
  expect(head).toHaveClass('session-folder-drop-target')
  fireEvent.drop(head, { dataTransfer: rootDrop })
  expect(callbacks.onOrganizationChange).toHaveBeenLastCalledWith({ type: 'setSession', cwd, path: nested.path, folderId: null })
  expect(head).toHaveAttribute('aria-busy', 'true')
  expect(within(head).getByRole('button', { name: '在 main 分支中新建文件夹' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '在 子目录 中新建文件夹' })).toBeDisabled()
  expect(row(view.container, nested.path)).toBe(source)
  expect(source.closest('[data-folder-id]')).toHaveAttribute('data-folder-id', 'child')
  await act(async () => { resolve() })
  expect(head).toHaveAttribute('aria-busy', 'false')
  expect(within(head).getByRole('button', { name: '在 main 分支中新建文件夹' })).toBeEnabled()
  expect(callbacks.onReorder).not.toHaveBeenCalled()
  expect(callbacks.onSelectSession).not.toHaveBeenCalled()
})

it('gates root and nested folder actions with organization readiness and preserves the plain branch fallback', () => {
  const callbacks = props(), view = render(<ProjectList {...callbacks} organizationDisabled />)
  for (const name of ['main', 'feature']) {
    const head = header(name)
    const create = within(head).getByRole('button', { name: `在 ${name} 分支中新建文件夹` })
    expect(create).toBeDisabled()
    fireEvent.click(create)
    expect(within(head).getByTitle(`在 ${name} 分支中新建会话`)).toBeEnabled()
  }
  expect(screen.getByRole('button', { name: '在 子目录 中新建文件夹' })).toBeDisabled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(callbacks.onOrganizationChange).not.toHaveBeenCalled()
  view.rerender(<ProjectList {...callbacks} organization={undefined} />)
  expect(screen.queryByRole('button', { name: /分支中新建文件夹/ })).not.toBeInTheDocument()
  expect(view.container.querySelector('.session-folder-tree')).toBeNull()
  expect(row(view.container, root.path)).toBeVisible()
  fireEvent.click(screen.getByTitle('在 feature 分支中新建会话'))
  expect(callbacks.onNewSession).toHaveBeenCalledExactlyOnceWith(featureCwd)
  view.rerender(<ProjectList {...callbacks} onOrganizationChange={undefined} />)
  expect(screen.queryByRole('button', { name: /分支中新建文件夹/ })).not.toBeInTheDocument()
  expect(view.container.querySelector('[data-session-drop-target="root"]')).toBeNull()
})
