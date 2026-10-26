// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionOrganization } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { SessionFolderTree } from '../../src/renderer/src/features/session/SessionFolderTree'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'
import { SESSION_DRAG_MIME } from '../../src/renderer/src/utils/sessionDrag'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const cwd = '/project'
const session = (id: string): SessionMeta => ({ id, path: `/sessions/${id}.jsonl`, projectCwd: cwd,
  timestamp: '2026-01-01', mtime: 1, preview: id, messageCount: 2 })
const root = session('root'), nested = session('nested'), peer = session('peer')
function items(): ComponentProps<typeof SessionItems> {
  return { sessions: [root, nested, peer], previewDensity: 'compact', runningSessionPaths: new Set(),
    favoritePaths: new Set(), onSelect: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined),
    onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]),
    onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn() }
}
function organization(): SessionOrganization {
  return { version: 1, revision: 1, folders: [
    { id: 'parent', cwd, name: '父目录' }, { id: 'child', cwd, name: '子目录', parentId: 'parent' }
  ], sessions: [{ cwd, path: nested.path, folderId: 'child' }] }
}
function row(container: HTMLElement, path: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('[data-session-path]')].find((element) => element.dataset.sessionPath === path)!
}
function target(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-session-drop-target="${id}"]`)!
}
function transfer() {
  const values = new Map<string, string>()
  return { effectAllowed: 'none', dropEffect: 'none', protectedMode: false,
    get types() { return [...values.keys()] },
    setData: vi.fn((type: string, value: string) => { values.set(type, value) }),
    getData: vi.fn(function (this: { protectedMode: boolean }, type: string) {
      return this.protectedMode ? '' : values.get(type) ?? ''
    }) }
}
function start(element: HTMLElement) {
  const dataTransfer = transfer()
  fireEvent.dragStart(element, { dataTransfer })
  return dataTransfer
}
function hover(element: HTMLElement, dataTransfer: ReturnType<typeof transfer>) {
  dataTransfer.protectedMode = true
  fireEvent.dragOver(element, { dataTransfer })
  dataTransfer.protectedMode = false
}
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function expectNoSessionAction(itemProps: ComponentProps<typeof SessionItems>) {
  for (const callback of [itemProps.onSelect, itemProps.onReorder, itemProps.onDelete, itemProps.onCopy,
    itemProps.onRename, itemProps.onFork, itemProps.onToggleFavorite]) {
    if (callback) expect(callback).not.toHaveBeenCalled()
  }
}

describe('session folder drag interaction', () => {
  it('accepts an owned favorite row of the same cwd even when the project list is filtered', async () => {
    const favoriteProps = { ...items(), sessions: [root], favoritePaths: new Set([root.path]) }
    const change = vi.fn().mockResolvedValue(undefined)
    const view = render(<>
      <SessionItems {...favoriteProps} allowFolderDrag />
      <SessionFolderTree cwd={cwd} organization={organization()} itemProps={{ ...items(), sessions: [] }} onOrganizationChange={change} />
    </>)
    const source = row(view.container, root.path)
    const dataTransfer = start(source)
    hover(target(view.container, 'child'), dataTransfer)
    await act(async () => { fireEvent.drop(target(view.container, 'child'), { dataTransfer }) })
    expect(change).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: root.path, folderId: 'child' })
    expect(row(view.container, root.path)).toBe(source)
    expect(favoriteProps.onToggleFavorite).not.toHaveBeenCalled()
    expect(favoriteProps.onSelect).not.toHaveBeenCalled()
  })

  it('preserves manual row sorting without issuing a folder move', () => {
    const itemProps = { ...items(), onReorder: vi.fn() }, change = vi.fn()
    const view = render(<SessionFolderTree cwd={cwd} organization={organization()} itemProps={itemProps} onOrganizationChange={change} />)
    const dataTransfer = start(row(view.container, root.path))
    fireEvent.drop(row(view.container, peer.path), { dataTransfer })
    expect(itemProps.onReorder).toHaveBeenCalledExactlyOnceWith([peer, nested, root])
    expect(change).not.toHaveBeenCalled()
  })

  it('moves a real row without manual sorting, accepts protected hover and waits for the authoritative snapshot', async () => {
    const org = organization(), itemProps = items(), pending = deferred()
    const change = vi.fn(() => pending.promise)
    const props = { cwd, organization: org, itemProps, onOrganizationChange: change }
    const view = render(<SessionFolderTree {...props} />)
    const source = row(view.container, root.path), other = row(view.container, peer.path)
    const sourceParent = source.parentElement, grip = other.querySelector('.side-session-drag')
    expect(source).toHaveAttribute('draggable', 'true')
    const dataTransfer = start(source)
    expect(dataTransfer.types).toContain(SESSION_DRAG_MIME)
    expect(dataTransfer.getData(SESSION_DRAG_MIME)).toBeTruthy()
    const heading = target(view.container, 'child')
    hover(heading, dataTransfer)
    expect(heading).toHaveClass('session-folder-drop-target')
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(heading, { dataTransfer })
    expect(change).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: root.path, folderId: 'child' })
    expect(source.parentElement).toBe(sourceParent)
    expect(row(view.container, root.path)).toBe(source)
    expect(row(view.container, peer.path)).toBe(other)
    expect(other.querySelector('.side-session-drag')).toBe(grip)
    expect(other).not.toHaveAttribute('draggable', 'true')
    const blocked = start(other)
    hover(heading, blocked)
    fireEvent.drop(heading, { dataTransfer: blocked })
    expect(change).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve() })
    expect(source.parentElement).toBe(sourceParent)
    await act(async () => { fireEvent.drop(heading, { dataTransfer }) })
    expect(change).toHaveBeenCalledTimes(1)
    view.rerender(<SessionFolderTree {...props} organization={{ ...org, revision: 2,
      sessions: [...org.sessions, { cwd, path: root.path, folderId: 'child' }] }} />)
    expect(row(view.container, root.path).closest('[data-folder-id]')).toHaveAttribute('data-folder-id', 'child')
    expect(row(view.container, peer.path)).toBe(other)
    expectNoSessionAction(itemProps)
  })

  it('uses the standalone tree as the undecorated root target, treats existing placements as no-ops and moves nested rows to root', async () => {
    const itemProps = { ...items(), onReorder: vi.fn() }, change = vi.fn().mockResolvedValue(undefined)
    const view = render(<SessionFolderTree cwd={cwd} organization={organization()} itemProps={itemProps} onOrganizationChange={change} />)
    expect(target(view.container, 'root')).toBe(view.container.querySelector('.session-folder-tree'))
    expect(screen.queryByRole('group', { name: '会话根目录' })).not.toBeInTheDocument()
    expect(screen.queryByText('根目录', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建文件夹', exact: true })).not.toBeInTheDocument()
    for (const [path, id] of [[root.path, 'root'], [nested.path, 'child']]) {
      const dataTransfer = start(row(view.container, path))
      hover(target(view.container, id), dataTransfer)
      await act(async () => { fireEvent.drop(target(view.container, id), { dataTransfer }) })
    }
    expect(change).not.toHaveBeenCalled()
    const dataTransfer = start(row(view.container, nested.path))
    hover(target(view.container, 'root'), dataTransfer)
    await act(async () => { fireEvent.drop(target(view.container, 'root'), { dataTransfer }) })
    expect(change).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: nested.path, folderId: null })
    await act(async () => { fireEvent.drop(target(view.container, 'root'), { dataTransfer }) })
    expect(change).toHaveBeenCalledTimes(1)
    expect(row(view.container, nested.path).closest('[data-folder-id]')).toHaveAttribute('data-folder-id', 'child')
    expectNoSessionAction(itemProps)
  })

  it('keeps the original placement and sibling DOM when persistence fails, showing the original error', async () => {
    const itemProps = { ...items(), onReorder: vi.fn() }, pending = deferred(), change = vi.fn(() => pending.promise)
    const view = render(<SessionFolderTree cwd={cwd} organization={organization()} itemProps={itemProps} onOrganizationChange={change} />)
    const source = row(view.container, nested.path), other = row(view.container, peer.path)
    const grip = other.querySelector('.side-session-drag')
    expect(grip).toBeInTheDocument()
    const dataTransfer = start(source)
    hover(target(view.container, 'parent'), dataTransfer)
    fireEvent.drop(target(view.container, 'parent'), { dataTransfer })
    expect(other.querySelector('.side-session-drag')).toBe(grip)
    await act(async () => { pending.reject(new Error('原始保存错误：磁盘只读')) })
    expect(screen.getByRole('alert')).toHaveTextContent('原始保存错误：磁盘只读')
    expect(row(view.container, nested.path)).toBe(source)
    expect(source.closest('[data-folder-id]')).toHaveAttribute('data-folder-id', 'child')
    expect(row(view.container, peer.path)).toBe(other)
    expect(other.querySelector('.side-session-drag')).toBe(grip)
    expect(source).toHaveAttribute('draggable', 'true')
    expectNoSessionAction(itemProps)
  })

  it.each(['organization', 'delete', 'optimistic'] as const)('rejects a source that becomes %s-disabled and refuses a fresh drag', async (kind) => {
    const itemProps = items(), change = vi.fn().mockResolvedValue(undefined)
    const props = { cwd, organization: organization(), itemProps, onOrganizationChange: change }
    const view = render(<SessionFolderTree {...props} />)
    const dataTransfer = start(row(view.container, root.path))
    view.rerender(<SessionFolderTree {...props} organizationDisabled={kind === 'organization'} itemProps={{ ...itemProps,
      pendingDeletePaths: kind === 'delete' ? new Set([root.path]) : undefined,
      sessions: itemProps.sessions.map((entry) => entry.path === root.path && kind === 'optimistic' ? { ...entry, optimistic: true } : entry) }} />)
    const heading = target(view.container, 'child')
    hover(heading, dataTransfer)
    expect(heading).not.toHaveClass('session-folder-drop-target')
    await act(async () => { fireEvent.drop(heading, { dataTransfer }) })
    const blocked = start(row(view.container, root.path))
    expect(blocked.types).not.toContain(SESSION_DRAG_MIME)
    await act(async () => { fireEvent.drop(heading, { dataTransfer: blocked }) })
    expect(change).not.toHaveBeenCalled()
    expectNoSessionAction(itemProps)
  })

  it('rejects external text, forged payloads, folder headings and cross-worktree drops', async () => {
    const itemProps = items(), change = vi.fn().mockResolvedValue(undefined), foreignCwd = '/project/worktree'
    const org = organization()
    const foreignOrg: SessionOrganization = { version: 1, revision: 1,
      folders: [{ id: 'foreign', cwd: foreignCwd, name: '其他工作树' }], sessions: [] }
    const view = render(<>
      <SessionFolderTree cwd={cwd} organization={org} itemProps={itemProps} onOrganizationChange={change} />
      <SessionFolderTree cwd={foreignCwd} organization={foreignOrg} itemProps={{ ...items(), sessions: [] }} onOrganizationChange={change} />
    </>)
    const heading = target(view.container, 'child')
    const external = transfer(); external.setData('text/plain', root.path)
    hover(heading, external)
    expect(heading).not.toHaveClass('session-folder-drop-target')
    await act(async () => { fireEvent.drop(heading, { dataTransfer: external }) })
    const header = start(heading)
    expect(header.types).not.toContain(SESSION_DRAG_MIME)
    await act(async () => { fireEvent.drop(target(view.container, 'parent'), { dataTransfer: header }) })
    const tampered = start(row(view.container, root.path)), originalPayload = tampered.getData(SESSION_DRAG_MIME)
    tampered.setData(SESSION_DRAG_MIME, JSON.stringify({ version: 1, cwd, path: peer.path }))
    await act(async () => { fireEvent.drop(heading, { dataTransfer: tampered }) })
    tampered.setData(SESSION_DRAG_MIME, originalPayload)
    await act(async () => { fireEvent.drop(heading, { dataTransfer: tampered }) })
    const crossCwd = start(row(view.container, root.path)), foreign = target(view.container, 'foreign')
    hover(foreign, crossCwd)
    expect(foreign).not.toHaveClass('session-folder-drop-target')
    await act(async () => { fireEvent.drop(foreign, { dataTransfer: crossCwd }) })
    expect(change).not.toHaveBeenCalled()
    expectNoSessionAction(itemProps)
  })

  it.each(['api', 'callback', 'cwd', 'unmount'] as const)('retires a drag receipt after its %s scope changes', async (kind) => {
    vi.stubGlobal('pion', {})
    const itemProps = items(), change = vi.fn().mockResolvedValue(undefined), nextChange = vi.fn().mockResolvedValue(undefined)
    const org = organization(), props = { cwd, organization: org, itemProps, onOrganizationChange: change }
    const view = render(<SessionFolderTree {...props} />)
    const dataTransfer = start(row(view.container, root.path))
    if (kind === 'api') vi.stubGlobal('pion', {})
    if (kind === 'unmount') {
      view.unmount()
      const next = render(<SessionFolderTree {...props} />)
      hover(target(next.container, 'child'), dataTransfer)
      expect(target(next.container, 'child')).not.toHaveClass('session-folder-drop-target')
      await act(async () => { fireEvent.drop(target(next.container, 'child'), { dataTransfer }) })
    } else {
      const nextCwd = kind === 'cwd' ? '/project/other' : cwd
      view.rerender(<SessionFolderTree {...props} cwd={nextCwd}
        organization={kind === 'cwd' ? { ...org, folders: org.folders.map((entry) => ({ ...entry, cwd: nextCwd })) } : org}
        itemProps={kind === 'cwd' ? { ...itemProps, sessions: itemProps.sessions.map((entry) => ({ ...entry, projectCwd: nextCwd })) } : itemProps}
        onOrganizationChange={kind === 'callback' ? nextChange : change} />)
      const heading = target(view.container, 'child')
      hover(heading, dataTransfer)
      expect(heading).not.toHaveClass('session-folder-drop-target')
      await act(async () => { fireEvent.drop(heading, { dataTransfer }) })
    }
    expect(change).not.toHaveBeenCalled()
    expect(nextChange).not.toHaveBeenCalled()
    expectNoSessionAction(itemProps)
  })
})
