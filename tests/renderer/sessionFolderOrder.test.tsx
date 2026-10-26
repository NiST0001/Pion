// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { applySessionOrganizationChange, type SessionOrganization } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { SessionFolderTree } from '../../src/renderer/src/features/session/SessionFolderTree'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const cwd = '/project', MIME = 'application/x-pion-session-folder'
const session: SessionMeta = { id: 'nested', path: '/sessions/nested.jsonl', projectCwd: cwd,
  timestamp: '2026-01-01', mtime: 1, preview: 'nested', messageCount: 2 }
function organization(): SessionOrganization {
  return { version: 1, revision: 1, folders: [
    { id: 'a', cwd, name: 'A' }, { id: 'a1', cwd, name: 'A1', parentId: 'a' },
    { id: 'b', cwd, name: 'B' }, { id: 'foreign', cwd: '/foreign', name: 'Foreign' },
    { id: 'a2', cwd, name: 'A2', parentId: 'a' }, { id: 'c', cwd, name: 'C' },
    { id: 'a3', cwd, name: 'A3', parentId: 'a' }
  ], sessions: [{ cwd, path: session.path, folderId: 'a1' }] }
}
function props(): ComponentProps<typeof SessionFolderTree> {
  return { cwd, organization: organization(), onOrganizationChange: vi.fn().mockResolvedValue(undefined),
    itemProps: { sessions: [session], previewDensity: 'compact', runningSessionPaths: new Set(),
      favoritePaths: new Set(), onSelect: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
      onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined),
      onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]),
      onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn() } }
}
const heading = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-folder-id="${id}"] > .session-folder-heading`)!
function order(container: HTMLElement, parentId?: string) {
  const parent = parentId ? container.querySelector(`[data-folder-id="${parentId}"] > .session-folder-content`)! : container.querySelector('.session-folder-tree')!
  return [...parent.children].filter((node) => node.hasAttribute('data-folder-id')).map((node) => node.getAttribute('data-folder-id'))
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
  const source = element.matches('.session-folder-heading') ? element.querySelector<HTMLElement>('.session-folder-toggle')! : element
  fireEvent.dragStart(source, { dataTransfer })
  return dataTransfer
}
function hover(element: HTMLElement, dataTransfer: ReturnType<typeof transfer>) {
  dataTransfer.protectedMode = true
  fireEvent.dragOver(element, { dataTransfer })
  dataTransfer.protectedMode = false
}
const drop = async (element: HTMLElement, dataTransfer: ReturnType<typeof transfer>) => {
  await act(async () => { fireEvent.drop(element, { dataTransfer }) })
}
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('session folder sibling ordering', () => {
  it('waits for a saved snapshot, preserves keyed subtrees and consumes the receipt once', async () => {
    const pending = deferred(), initial = props(), change = vi.fn(() => pending.promise)
    const bubbling = vi.fn(), current = { ...initial, onOrganizationChange: change }
    const wrap = (organization = current.organization) => <div onDragStart={bubbling} onDragOver={bubbling} onDrop={bubbling}>
      <SessionFolderTree {...current} organization={organization} />
    </div>
    const view = render(wrap()), source = heading(view.container, 'a'), target = heading(view.container, 'c')
    const toggle = source.querySelector('.session-folder-toggle'), content = source.parentElement!.querySelector('.session-folder-content')
    const row = view.container.querySelector('[data-session-path]'), grip = heading(view.container, 'b').querySelector('.lucide-grip-vertical')
    expect(toggle).toHaveAttribute('draggable', 'true')
    expect(grip).toHaveAttribute('width', '13')
    const dataTransfer = start(source)
    expect(dataTransfer.types).toContain(MIME)
    expect(dataTransfer.types).not.toContain('application/x-pion-session')
    expect(source).toHaveClass('is-dragging')
    dataTransfer.getData.mockClear()
    hover(target, dataTransfer)
    expect(dataTransfer.getData).not.toHaveBeenCalled()
    expect(target).toHaveClass('is-drop-target')
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(target, { dataTransfer })
    expect(change).toHaveBeenCalledExactlyOnceWith({ type: 'reorderFolders', cwd, ids: ['b', 'c', 'a'] })
    expect(order(view.container)).toEqual(['a', 'b', 'c'])
    for (const element of view.container.querySelectorAll('.session-folder-toggle')) expect(element).not.toHaveAttribute('draggable', 'true')
    expect(heading(view.container, 'b').querySelector('.lucide-grip-vertical')).toBe(grip)
    const blocked = start(heading(view.container, 'b'))
    expect(blocked.types).not.toContain(MIME)
    await drop(target, blocked)
    await drop(target, dataTransfer)
    expect(change).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve() })
    expect(order(view.container)).toEqual(['a', 'b', 'c'])
    await drop(target, dataTransfer)
    expect(change).toHaveBeenCalledTimes(1)
    const rootIds = ['b', 'c', 'a']
    const saved = applySessionOrganizationChange(current.organization, { type: 'reorderFolders', cwd, ids: rootIds })
    expect(saved.folders.map((folder) => folder.id)).toEqual(['b', 'a1', 'c', 'foreign', 'a2', 'a', 'a3'])
    view.rerender(wrap(saved))
    expect(order(view.container)).toEqual(rootIds)
    expect(heading(view.container, 'a')).toBe(source)
    expect(source.querySelector('.session-folder-toggle')).toBe(toggle)
    expect(source.parentElement!.querySelector('.session-folder-content')).toBe(content)
    expect(view.container.querySelector('[data-session-path]')).toBe(row)
    expect(row!.closest('[data-folder-id]')).toHaveAttribute('data-folder-id', 'a1')
    expect(bubbling).not.toHaveBeenCalled()
    expect(initial.itemProps.onSelect).not.toHaveBeenCalled()
  })

  it('reorders only nested siblings using the upward target slot and the complete sibling IDs', async () => {
    const current = props(), view = render(<SessionFolderTree {...current} />)
    const dataTransfer = start(heading(view.container, 'a3'))
    hover(heading(view.container, 'a1'), dataTransfer)
    await drop(heading(view.container, 'a1'), dataTransfer)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'reorderFolders', cwd, parentId: 'a', ids: ['a3', 'a1', 'a2'] })
    expect(order(view.container, 'a')).toEqual(['a1', 'a2', 'a3'])
    expect(order(view.container)).toEqual(['a', 'b', 'c'])
  })

  it.each(['text', 'external', 'tampered', 'cross-cwd', 'cross-level', 'self', 'action'] as const)('rejects %s drags', async (kind) => {
    const current = props(), view = render(<><SessionFolderTree {...current} />
      <SessionFolderTree {...current} cwd="/foreign" itemProps={{ ...current.itemProps, sessions: [] }} /></>)
    const source = heading(view.container, 'a')
    const dataTransfer = kind === 'text' || kind === 'external' ? transfer()
      : start(kind === 'action' ? source.querySelector<HTMLElement>('.session-folder-actions button')! : source)
    const originalPayload = kind === 'tampered' ? dataTransfer.getData(MIME) : ''
    if (kind === 'text') dataTransfer.setData('text/plain', 'a')
    if (kind === 'external' || kind === 'tampered') dataTransfer.setData(MIME, '{}')
    if (kind === 'action') {
      const action = source.querySelector<HTMLElement>('.session-folder-actions button')!
      expect(action.closest('[draggable="true"]')).toBeNull()
      expect(action.closest('.session-folder-toggle')).toBeNull()
      expect(dataTransfer.types).not.toContain(MIME)
    }
    const target = heading(view.container, kind === 'cross-cwd' ? 'foreign' : kind === 'cross-level' ? 'a1' : kind === 'self' ? 'a' : 'b')
    hover(target, dataTransfer)
    if (kind !== 'tampered') expect(target).not.toHaveClass('is-drop-target')
    await drop(target, dataTransfer)
    if (kind === 'tampered') { dataTransfer.setData(MIME, originalPayload); await drop(target, dataTransfer) }
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
  })

  it.each(['organizationDisabled', 'searchActive', 'hidden'] as const)('rejects a current %s source at drop and at a fresh start', async (key) => {
    const current = props(), view = render(<SessionFolderTree {...current} />)
    const source = heading(view.container, 'a'), grip = source.querySelector('.lucide-grip-vertical'), dataTransfer = start(source)
    view.rerender(<SessionFolderTree {...current} {...{ [key]: true }} />)
    const target = heading(view.container, 'b')
    hover(target, dataTransfer)
    expect(target).not.toHaveClass('is-drop-target')
    await drop(target, dataTransfer)
    expect(source.querySelector('.session-folder-toggle')).not.toHaveAttribute('draggable', 'true')
    expect(source.querySelector('.lucide-grip-vertical')).toBe(grip)
    expect(start(source).types).not.toContain(MIME)
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
  })

  it.each(['revision', 'callback', 'cwd', 'parent', 'removed', 'unmount'] as const)('retires the source receipt after %s changes', async (kind) => {
    const current = props(), nextChange = vi.fn().mockResolvedValue(undefined)
    let view = render(<SessionFolderTree {...current} />)
    const dataTransfer = start(heading(view.container, 'a')), org = current.organization
    const nextCwd = kind === 'cwd' ? '/other' : cwd
    const next = { ...current, cwd: nextCwd, onOrganizationChange: kind === 'callback' ? nextChange : current.onOrganizationChange,
      organization: { ...org, revision: kind === 'revision' ? 2 : org.revision,
        folders: org.folders.filter((folder) => kind !== 'removed' || folder.id !== 'a').map((folder) => ({ ...folder,
          cwd: folder.cwd === cwd ? nextCwd : folder.cwd, ...(kind === 'parent' && folder.id === 'a' ? { parentId: 'b' } : {}) })) } }
    if (kind === 'unmount') { view.unmount(); view = render(<SessionFolderTree {...current} />) }
    else view.rerender(<SessionFolderTree {...next} />)
    const target = heading(view.container, 'c')
    hover(target, dataTransfer)
    expect(target).not.toHaveClass('is-drop-target')
    await drop(target, dataTransfer)
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
    expect(nextChange).not.toHaveBeenCalled()
  })

  it('retires the source receipt when the API changes without rerendering props', async () => {
    const originalApi = window.pion
    try {
      const current = props(), view = render(<SessionFolderTree {...current} />)
      const dataTransfer = start(heading(view.container, 'a'))
      expect(dataTransfer.types).toContain(MIME)
      window.pion = { ...originalApi }
      const target = heading(view.container, 'b')
      hover(target, dataTransfer)
      expect(target).not.toHaveClass('is-drop-target')
      await drop(target, dataTransfer)
      expect(current.onOrganizationChange).not.toHaveBeenCalled()
    } finally {
      window.pion = originalApi
    }
  })

  it('keeps the original order and DOM on save failure and releases the real pending gate', async () => {
    const pending = deferred(), current = props(), change = vi.fn(() => pending.promise)
    const view = render(<SessionFolderTree {...current} onOrganizationChange={change} />)
    const source = heading(view.container, 'a'), row = view.container.querySelector('[data-session-path]')
    await drop(heading(view.container, 'b'), start(source))
    expect(source.querySelector('.session-folder-toggle')).not.toHaveAttribute('draggable', 'true')
    await act(async () => { pending.reject(new Error('原始保存错误：磁盘只读')) })
    expect(screen.getByRole('alert')).toHaveTextContent('原始保存错误：磁盘只读')
    expect(order(view.container)).toEqual(['a', 'b', 'c'])
    expect(heading(view.container, 'a')).toBe(source)
    expect(view.container.querySelector('[data-session-path]')).toBe(row)
    expect(source.querySelector('.session-folder-toggle')).toHaveAttribute('draggable', 'true')
  })
})
