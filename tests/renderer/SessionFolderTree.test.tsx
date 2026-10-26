// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { validateSessionOrganizationChange, type SessionOrganization, type SessionOrganizationChange } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { SessionFolderTree } from '../../src/renderer/src/features/session/SessionFolderTree'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const cwd = '/project'
const session = (id: string): SessionMeta => ({ id, path: `/sessions/${id}.jsonl`, projectCwd: cwd,
  timestamp: '2026-01-01', mtime: 1, preview: id, messageCount: 2 })
const a = session('a'), b = session('b'), root = session('root')
function items(sessions = [a, root, b]): ComponentProps<typeof SessionItems> {
  return { sessions, previewDensity: 'compact', runningSessionPaths: new Set([a.path]),
    attentionSessionPaths: new Set([a.path]), favoritePaths: new Set(), onSelect: vi.fn(), onReorder: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined), onCopy: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined), onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]),
    onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn() }
}
function organization(): SessionOrganization {
  return { version: 1, revision: 1, folders: [
    { id: 'parent', cwd, name: '父目录' }, { id: 'child', cwd, name: '子目录', parentId: 'parent', collapsed: true },
    { id: 'other', cwd: '/project/worktree', name: '其他工作树' }
  ], sessions: [{ cwd, path: a.path, folderId: 'child' }, { cwd, path: b.path, folderId: 'child' }] }
}
function row(container: HTMLElement, path: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('[data-session-path]')].find((element) => element.dataset.sessionPath === path)!
}

describe('SessionFolderTree organization projection', () => {
  it('creates root folders with a valid omitted parent and preserves IME drafts on Escape', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'root-created' })
    const change = vi.fn(async (patch: SessionOrganizationChange) => { validateSessionOrganizationChange(patch) })
    render(<SessionFolderTree cwd={cwd} organization={organization()} itemProps={items()} onOrganizationChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    const input = screen.getByRole('textbox', { name: '文件夹名称' })
    fireEvent.change(input, { target: { value: '新根目录' } })
    fireEvent.compositionStart(input)
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
    expect(change).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(input).toHaveValue('新根目录')
    fireEvent.compositionEnd(input)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(change).toHaveBeenCalledExactlyOnceWith({ type: 'createFolder', cwd, id: 'root-created', name: '新根目录' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps exact cwd, real row state and sub-sessions, and temporarily opens search without saving collapse', () => {
    const org = organization(), itemProps = items()
    const archived = session('archived')
    itemProps.sessions.push(archived, { ...session('foreign'), projectCwd: '/project/worktree' })
    org.sessions.push({ cwd, path: archived.path, archived: true }, { cwd: '/project/worktree', path: root.path, archived: true })
    const child = { id: 'child-view', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool',
      parentSessionId: a.id, parentSessionPath: a.path, cwd, name: '子任务', status: 'running' as const, revision: 1, truncated: false }
    itemProps.subagentSessions = [child]
    itemProps.onViewSubagent = vi.fn()
    const change = vi.fn().mockResolvedValue(undefined)
    const props = { cwd, organization: org, onOrganizationChange: change, itemProps }
    const view = render(<SessionFolderTree {...props} />)
    expect(screen.queryByText('其他工作树')).not.toBeInTheDocument()
    expect(row(view.container, archived.path)).toBeUndefined()
    expect(row(view.container, '/sessions/foreign.jsonl')).toBeUndefined()
    expect(row(view.container, root.path)).toBeVisible()
    expect(row(view.container, a.path)).not.toBeVisible()
    view.rerender(<SessionFolderTree {...props} searchActive />)
    expect(row(view.container, a.path)).toBeVisible()
    expect(row(view.container, a.path)).toHaveClass('running')
    expect(within(row(view.container, a.path)).getByLabelText('等待回答或权限确认')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看子会话 子任务 · 运行中' }))
    expect(itemProps.onViewSubagent).toHaveBeenCalledWith(child)
    expect(itemProps.onSelect).not.toHaveBeenCalled()
    view.rerender(<SessionFolderTree {...props} />)
    expect(row(view.container, a.path)).not.toBeVisible()
    expect(change).not.toHaveBeenCalled()
  })

  it('merges folder reorder into only that group’s original slots', () => {
    const org = organization(); org.folders[1].collapsed = false
    const itemProps = items()
    const view = render(<SessionFolderTree cwd={cwd} organization={org} itemProps={itemProps} onOrganizationChange={vi.fn()} />)
    const dataTransfer = { getData: () => b.path, setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.drop(row(view.container, a.path), { dataTransfer })
    expect(itemProps.onReorder).toHaveBeenCalledWith([b, root, a])
    expect(itemProps.onSelect).not.toHaveBeenCalled()
  })

  it('awaits collapse persistence, keeps failure visible, and gates every organization control when disabled', async () => {
    const org = organization(), itemProps = items()
    let reject!: (reason: Error) => void
    const change = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const props = { cwd, organization: org, itemProps, onOrganizationChange: change }
    const view = render(<SessionFolderTree {...props} />)
    const toggle = screen.getByRole('button', { name: '文件夹 子目录' })
    fireEvent.click(toggle)
    expect(change).toHaveBeenCalledWith({ type: 'setFolderCollapsed', id: 'child', collapsed: false })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toBeDisabled()
    await act(async () => { reject(new Error('保存失败')) })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    view.rerender(<SessionFolderTree {...props} organizationDisabled />)
    for (const button of view.container.querySelectorAll<HTMLButtonElement>('.session-folder-heading button, .session-folder-create')) expect(button).toBeDisabled()
    expect(row(view.container, root.path)).not.toHaveAttribute('draggable', 'true')
  })

  it('excludes a folder and descendants from move choices, and explains delete promotion', () => {
    const view = render(<SessionFolderTree cwd={cwd} organization={organization()} itemProps={items()} onOrganizationChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '移动文件夹 父目录' }))
    fireEvent.click(screen.getByRole('combobox', { name: '目标文件夹' }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['根目录'])
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '删除文件夹 父目录' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('会话和子文件夹将移到父目录，会话历史保留')
    expect(view.container.querySelectorAll('[data-folder-id]')).toHaveLength(2)
  })

  it('creates nested folders, renames and moves through explicit dialogs with snapshot-only display', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'new-folder' })
    const org = organization(), change = vi.fn().mockResolvedValue(undefined)
    render(<SessionFolderTree cwd={cwd} organization={org} itemProps={items()} onOrganizationChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: '在 父目录 中新建文件夹' }))
    fireEvent.change(screen.getByRole('textbox', { name: '文件夹名称' }), { target: { value: '新目录' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(change).toHaveBeenLastCalledWith({ type: 'createFolder', cwd, id: expect.any(String), name: '新目录', parentId: 'parent' })
    expect(screen.queryByRole('button', { name: '文件夹 新目录' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重命名文件夹 子目录' }))
    fireEvent.change(screen.getByRole('textbox', { name: '文件夹名称' }), { target: { value: '新名称' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(change).toHaveBeenLastCalledWith({ type: 'renameFolder', id: 'child', name: '新名称' })
    expect(screen.getByRole('button', { name: '文件夹 子目录' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移动文件夹 子目录' }))
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: '根目录' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认移动' })) })
    expect(change).toHaveBeenLastCalledWith({ type: 'moveFolder', id: 'child' })
  })

  it.each(['worktree', 'callback'])('ignores a late old-owner failure after %s change and holds its actual pending slot', async (kind) => {
    let reject!: (reason: Error) => void
    const change = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const props = { organization: organization(), itemProps: items(), onOrganizationChange: change }
    const view = render(<SessionFolderTree {...props} cwd={cwd} />)
    fireEvent.click(screen.getByRole('button', { name: '文件夹 子目录' }))
    view.rerender(<SessionFolderTree {...props} cwd={kind === 'worktree' ? '/other' : cwd}
      onOrganizationChange={kind === 'callback' ? vi.fn().mockResolvedValue(undefined) : change} />)
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeDisabled()
    await act(async () => { reject(new Error('旧目录错误')) })
    expect(screen.queryByText('旧目录错误')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeEnabled()
  })

  it('handles cycles/missing parents and orphaned placement without losing session rows', () => {
    const org = organization()
    org.folders = [{ id: 'x', cwd, name: 'X', parentId: 'y' }, { id: 'y', cwd, name: 'Y', parentId: 'x' },
      { id: 'z', cwd, name: 'Z', parentId: 'missing' }]
    const view = render(<SessionFolderTree cwd={cwd} organization={org} itemProps={items()} onOrganizationChange={vi.fn()} />)
    expect(view.container.querySelectorAll('[data-folder-id]')).toHaveLength(3)
    expect(view.container.querySelectorAll('[data-session-path]')).toHaveLength(3)
  })

  it('sends archive metadata with the owning cwd and original title; display follows only snapshots', async () => {
    const org = organization(); org.folders[1].collapsed = false
    const change = vi.fn().mockResolvedValue(undefined)
    const view = render(<SessionFolderTree cwd={cwd} organization={org} itemProps={items()} onOrganizationChange={change} />)
    fireEvent.contextMenu(row(view.container, a.path))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '归档会话' })) })
    expect(change).toHaveBeenCalledWith({ type: 'setSession', cwd, path: a.path, archived: true, title: 'a' })
    expect(row(view.container, a.path)).toBeVisible()
  })
})
