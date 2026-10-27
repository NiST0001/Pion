// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { applySessionOrganizationChange, type SessionOrganization, type SessionOrganizationChange, type SessionOrganizationItem } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { SessionFolderTree } from '../../src/renderer/src/features/session/SessionFolderTree'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'

const cwd = '/project', SESSION = 'application/x-pion-session', FOLDER = 'application/x-pion-session-folder'
const originalApi = window.pion
const path = (id: string) => `/sessions/${id}.jsonl`
const session = (id: string): SessionMeta => ({ id, path: path(id), projectCwd: cwd,
  timestamp: '2026-01-01', mtime: 1, preview: id, messageCount: 2 })
const s = (id: string): SessionOrganizationItem => ({ kind: 'session', path: path(id) })
const f = (id: string): SessionOrganizationItem => ({ kind: 'folder', id })
afterEach(() => { cleanup(); window.pion = originalApi; vi.restoreAllMocks() })
function props(): ComponentProps<typeof SessionFolderTree> {
  const organization: SessionOrganization = { version: 1, revision: 3, folders: [
    { id: 'a', cwd, name: 'A' }, { id: 'aa', cwd, name: 'AA', parentId: 'a', collapsed: true },
    { id: 'b', cwd, name: 'B' }, { id: 'foreign', cwd: '/foreign', name: 'Foreign' }
  ], sessions: [{ cwd, path: path('inner'), folderId: 'a' }, { cwd, path: path('deep'), folderId: 'aa' }] }
  return { cwd, organization, onOrganizationChange: vi.fn().mockResolvedValue(undefined),
    itemProps: { sessions: ['x', 'y', 'z', 'inner', 'deep'].map(session), previewDensity: 'compact',
      runningSessionPaths: new Set(), favoritePaths: new Set(), onSelect: vi.fn(), onReorder: vi.fn(),
      onDelete: vi.fn().mockResolvedValue(undefined), onCopy: vi.fn().mockResolvedValue(undefined),
      onRename: vi.fn().mockResolvedValue(undefined), onOpenTaskHistory: vi.fn(),
      getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn() } }
}
const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-session-path="${path(id)}"]`)!
const heading = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-folder-id="${id}"] > .session-folder-heading`)!
function order(container: HTMLElement, parentId?: string) {
  const parent = parentId ? container.querySelector(`[data-folder-id="${parentId}"] > .session-folder-content`)!
    : container.querySelector('.session-folder-tree')!
  return [...parent.children].flatMap((element) => element.hasAttribute('data-folder-id') ? [`f:${element.getAttribute('data-folder-id')}`]
    : element.hasAttribute('data-session-path') ? [`s:${element.getAttribute('data-session-path')!.split('/').pop()!.replace('.jsonl', '')}`] : [])
}
function transfer() {
  const values = new Map<string, string>()
  return { effectAllowed: 'none', dropEffect: 'none', protectedMode: false,
    get types() { return [...values.keys()] },
    setData: vi.fn((type: string, value: string) => { values.set(type, value) }),
    getData: vi.fn(function (this: { protectedMode: boolean }, type: string) { return this.protectedMode ? '' : values.get(type) ?? '' }) }
}
function start(element: HTMLElement) {
  const dataTransfer = transfer()
  fireEvent.dragStart(element.matches('.session-folder-heading') ? element.querySelector('.session-folder-toggle')! : element, { dataTransfer })
  return dataTransfer
}
function dragEvent(kind: 'dragOver' | 'drop', element: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY?: number) {
  const event = createEvent[kind](element, { dataTransfer, bubbles: true, cancelable: true })
  if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(element, event)
}
function hover(element: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY?: number) {
  dataTransfer.protectedMode = true
  dragEvent('dragOver', element, dataTransfer, clientY)
  dataTransfer.protectedMode = false
}
async function drop(element: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY?: number) {
  await act(async () => { dragEvent('drop', element, dataTransfer, clientY) })
}
function geometry(element: HTMLElement) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, height: 40, left: 0, right: 200,
    width: 200, x: 0, y: 100, toJSON: () => ({}) })
}
function reorder(items: SessionOrganizationItem[], parentId?: string): SessionOrganizationChange {
  return { type: 'reorderItems', cwd, expectedRevision: 3, ...(parentId ? { parentId } : {}), items }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('mixed session and folder sibling ordering', () => {
  it('moves a folder onto a session, saves the complete group and preserves keyed nested and child DOM', async () => {
    const current = props(), pending = deferred(), change = vi.fn(() => pending.promise), bubbling = vi.fn()
    current.itemProps.onViewSubagent = vi.fn()
    current.itemProps.subagentSessions = [{ id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool',
      parentSessionId: 'x', parentSessionPath: path('x'), cwd, name: 'Child', status: 'completed', revision: 1, truncated: false }]
    const wrap = (organization = current.organization) => <div onDragStart={bubbling} onDragOver={bubbling} onDrop={bubbling}>
      <SessionFolderTree {...current} organization={organization} onOrganizationChange={change} />
    </div>
    const view = render(wrap()), a = heading(view.container, 'a'), x = row(view.container, 'x'), deep = row(view.container, 'deep')
    const folder = a.parentElement, content = heading(view.container, 'aa').parentElement!.querySelector('.session-folder-content')!
    const childDetails = view.container.querySelector('details')!, child = screen.getByRole('button', { name: /查看子会话 Child/ })
    childDetails.open = false
    expect(content).toHaveAttribute('hidden')
    expect(content).toHaveAttribute('inert')
    expect(a.querySelector('.session-folder-actions button')!.closest('[draggable="true"]')).toBeNull()
    const dataTransfer = start(a)
    dataTransfer.getData.mockClear()
    hover(row(view.container, 'y'), dataTransfer)
    expect(dataTransfer.getData).not.toHaveBeenCalled()
    expect(row(view.container, 'y')).toHaveClass('drag-over')
    expect(dataTransfer.dropEffect).toBe('move')
    await drop(row(view.container, 'y'), dataTransfer)
    const expected = reorder([s('x'), f('a'), s('y'), s('z'), f('b')])
    expect(change).toHaveBeenCalledExactlyOnceWith(expected)
    expect(dataTransfer.getData).toHaveBeenCalledExactlyOnceWith(FOLDER)
    expect(order(view.container)).toEqual(['s:x', 's:y', 's:z', 'f:a', 'f:b'])
    expect(a.querySelector('button')).not.toHaveAttribute('draggable', 'true')
    expect(row(view.container, 'y')).not.toHaveAttribute('draggable', 'true')
    await drop(row(view.container, 'z'), dataTransfer)
    expect(change).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve() })
    expect(order(view.container)).toEqual(['s:x', 's:y', 's:z', 'f:a', 'f:b'])
    const saved = applySessionOrganizationChange(current.organization, expected)
    view.rerender(wrap(saved))
    expect(order(view.container)).toEqual(['s:x', 'f:a', 's:y', 's:z', 'f:b'])
    expect(heading(view.container, 'a').parentElement).toBe(folder)
    expect(row(view.container, 'x')).toBe(x)
    expect(row(view.container, 'deep')).toBe(deep)
    expect(heading(view.container, 'aa').parentElement!.querySelector('.session-folder-content')).toBe(content)
    expect(view.container.querySelector('details')).toBe(childDetails)
    expect(childDetails.open).toBe(false)
    expect(screen.getByRole('button', { name: /查看子会话 Child/, hidden: true })).toBe(child)
    expect(saved.sessions.find((entry) => entry.path === path('deep'))?.folderId).toBe('aa')
    expect(current.itemProps.onReorder).not.toHaveBeenCalled()
    expect(bubbling).not.toHaveBeenCalled()
    view.unmount()
    const reopened = render(wrap(saved))
    expect(order(reopened.container)).toEqual(['s:x', 'f:a', 's:y', 's:z', 'f:b'])
  })

  it.each([
    ['before', 102, [s('y'), s('z'), s('x'), f('a'), f('b')]],
    ['after', 138, [s('y'), s('z'), f('a'), s('x'), f('b')]]
  ] as const)('uses the folder heading %s edge for a session sibling move', async (edge, clientY, items) => {
    const current = props(), view = render(<SessionFolderTree {...current} />), target = heading(view.container, 'a')
    geometry(target)
    const dataTransfer = start(row(view.container, 'x'))
    dataTransfer.getData.mockClear()
    hover(target, dataTransfer, clientY)
    expect(target).toHaveAttribute('data-drop-edge', edge)
    expect(target).not.toHaveClass('session-folder-drop-target')
    expect(dataTransfer.getData).not.toHaveBeenCalled()
    await drop(target, dataTransfer, clientY)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith(reorder([...items]))
    expect(dataTransfer.getData).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it.each(['center', 'no-coordinate', 'zero-height'] as const)('keeps %s classification distinct from mixed ordering', async (kind) => {
    const current = props(), view = render(<SessionFolderTree {...current} />), target = heading(view.container, 'a')
    if (kind !== 'zero-height') geometry(target)
    const dataTransfer = start(row(view.container, 'x'))
    hover(target, dataTransfer, kind === 'center' ? 120 : undefined)
    expect(target).toHaveClass('session-folder-drop-target')
    expect(target).not.toHaveAttribute('data-drop-edge')
    await drop(target, dataTransfer, kind === 'center' ? 120 : undefined)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: path('x'), folderId: 'a' })
    expect(dataTransfer.getData).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('recomputes edge/center intent at the actual drop without consuming the receipt twice', async () => {
    const current = props(), view = render(<SessionFolderTree {...current} />), target = heading(view.container, 'a')
    geometry(target)
    const dataTransfer = start(row(view.container, 'x'))
    hover(target, dataTransfer, 102)
    expect(target).toHaveAttribute('data-drop-edge', 'before')
    await drop(target, dataTransfer, 120)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: path('x'), folderId: 'a' })
    expect(dataTransfer.getData).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it.each(['folder', 'session', 'nested'] as const)('supports %s sibling target-slot moves', async (kind) => {
    const current = props(), view = render(<SessionFolderTree {...current} />)
    const source = kind === 'folder' ? heading(view.container, 'a') : row(view.container, kind === 'nested' ? 'inner' : 'x')
    const target = kind === 'folder' ? heading(view.container, 'b') : kind === 'nested' ? heading(view.container, 'aa') : row(view.container, 'z')
    if (kind === 'nested') geometry(target)
    await drop(target, start(source), kind === 'nested' ? 138 : undefined)
    const expected = kind === 'folder' ? reorder([s('x'), s('y'), s('z'), f('b'), f('a')])
      : kind === 'session' ? reorder([s('y'), s('z'), s('x'), f('a'), f('b')]) : reorder([f('aa'), s('inner')], 'a')
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith(expected)
    const saved = applySessionOrganizationChange(current.organization, expected)
    view.rerender(<SessionFolderTree {...current} organization={saved} />)
    expect(order(view.container, kind === 'nested' ? 'a' : undefined)).toEqual(kind === 'folder'
      ? ['s:x', 's:y', 's:z', 'f:b', 'f:a'] : kind === 'session' ? ['s:y', 's:z', 's:x', 'f:a', 'f:b'] : ['f:aa', 's:inner'])
  })

  it('retains the snapshot and row DOM on save failure, holding the actual pending promise', async () => {
    const current = props(), pending = deferred(), change = vi.fn(() => pending.promise)
    const view = render(<SessionFolderTree {...current} onOrganizationChange={change} />), a = heading(view.container, 'a'), x = row(view.container, 'x')
    await drop(row(view.container, 'y'), start(a))
    expect(start(heading(view.container, 'b')).types).not.toContain(FOLDER)
    expect(x).not.toHaveAttribute('draggable', 'true')
    await act(async () => { pending.reject(new Error('保存失败：只读')) })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：只读')
    expect(order(view.container)).toEqual(['s:x', 's:y', 's:z', 'f:a', 'f:b'])
    expect(heading(view.container, 'a')).toBe(a)
    expect(row(view.container, 'x')).toBe(x)
    expect(x).toHaveAttribute('draggable', 'true')
  })

  it.each(['mode', 'membership', 'api', 'revision', 'search', 'disabled', 'hidden', 'reorderDisabled'] as const)('retires session and folder receipts after %s changes', async (kind) => {
    for (const sourceKind of ['session', 'folder'] as const) {
      const current = props(), view = render(<SessionFolderTree {...current} />)
      const dataTransfer = start(sourceKind === 'session' ? row(view.container, 'x') : heading(view.container, 'a'))
      const next = { ...current, itemProps: { ...current.itemProps } }
      if (kind === 'mode') next.manualOrder = false
      if (kind === 'membership') next.itemProps.sessions = [...current.itemProps.sessions, session('new')]
      if (kind === 'revision') next.organization = { ...current.organization, revision: 4 }
      if (kind === 'search') next.searchActive = true
      if (kind === 'disabled') next.organizationDisabled = true
      if (kind === 'hidden') next.hidden = true
      if (kind === 'reorderDisabled') next.itemProps.reorderDisabled = true
      if (kind === 'api') window.pion = { ...originalApi }
      else view.rerender(<SessionFolderTree {...next} />)
      hover(row(view.container, 'z'), dataTransfer)
      expect(row(view.container, 'z')).not.toHaveClass('drag-over')
      await drop(row(view.container, 'z'), dataTransfer)
      expect(current.onOrganizationChange).not.toHaveBeenCalled()
      view.unmount()
      window.pion = originalApi
    }
  })

  it.each(['cross-level-folder', 'cross-level-session', 'foreign', 'external', 'text', 'tampered', 'archived', 'deleting', 'optimistic'] as const)('rejects %s mixed sources and consumes rejected typed drops', async (kind) => {
    const current = props()
    if (kind === 'archived') current.organization.sessions.push({ cwd, path: path('x'), archived: true })
    if (kind === 'deleting') current.itemProps.pendingDeletePaths = new Set([path('z')])
    if (kind === 'optimistic') current.itemProps.sessions = current.itemProps.sessions.map((entry) => entry.id === 'z' ? { ...entry, optimistic: true } : entry)
    const view = render(<><SessionFolderTree {...current} />
      <SessionFolderTree {...current} cwd="/foreign" itemProps={{ ...current.itemProps, sessions: [ { ...session('foreign-session'), projectCwd: '/foreign' } ] }} />
    </>)
    const external = kind === 'text' || kind === 'external' || kind === 'archived'
    const source = kind === 'cross-level-folder' ? heading(view.container, 'aa')
      : kind === 'cross-level-session' ? row(view.container, 'inner')
      : kind === 'foreign' ? heading(view.container, 'foreign')
      : kind === 'deleting' || kind === 'optimistic' ? heading(view.container, 'a') : row(view.container, 'x')
    const dataTransfer = external ? transfer() : start(source)
    if (kind === 'text') dataTransfer.setData('text/plain', path('x'))
    if (kind === 'external' || kind === 'archived' || kind === 'tampered') dataTransfer.setData(SESSION, '{}')
    const target = row(view.container, 'y')
    hover(target, dataTransfer)
    if (kind !== 'tampered') expect(target).not.toHaveClass('drag-over')
    await drop(target, dataTransfer)
    if (kind === 'tampered') {
      dataTransfer.setData(SESSION, JSON.stringify({ version: 1, cwd, path: path('x') }))
      await drop(target, dataTransfer)
    }
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
    expect(current.itemProps.onReorder).not.toHaveBeenCalled()
  })

  it('rejects favorite mixed ordering across organization revisions while preserving fresh central classification', async () => {
    const current = props()
    const wrap = (organization = current.organization) => <>
      <div data-testid="favorites"><SessionItems {...current.itemProps} sessions={[session('x')]} allowFolderDrag /></div>
      <SessionFolderTree {...current} organization={organization} />
    </>
    const view = render(wrap()), favorite = row(screen.getByTestId('favorites'), 'x')
    const dataTransfer = start(favorite)
    expect(dataTransfer.types).toContain(SESSION)
    view.rerender(wrap({ ...current.organization, revision: 4 }))
    const target = row(view.container.querySelector<HTMLElement>('.session-folder-tree')!, 'y')
    hover(target, dataTransfer)
    expect(target).not.toHaveClass('drag-over')
    expect(dataTransfer.getData).not.toHaveBeenCalled()
    await drop(target, dataTransfer)
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
    const folder = heading(view.container, 'a')
    geometry(folder)
    await drop(folder, dataTransfer, 120)
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
    await drop(folder, start(favorite), 120)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: path('x'), folderId: 'a' })
    expect(current.itemProps.onReorder).not.toHaveBeenCalled()
  })

  it.each(['automatic', 'search'] as const)('preserves fresh central classification and branch-root moves in %s mode', async (kind) => {
    const current = props(), view = render(<SessionFolderTree {...current} manualOrder={kind !== 'automatic'} searchActive={kind === 'search'} />)
    const target = heading(view.container, 'a')
    geometry(target)
    await drop(target, start(row(view.container, 'x')), 120)
    expect(current.onOrganizationChange).toHaveBeenNthCalledWith(1, { type: 'setSession', cwd, path: path('x'), folderId: 'a' })
    await drop(view.container.querySelector<HTMLElement>('.session-folder-tree')!, start(row(view.container, 'inner')))
    expect(current.onOrganizationChange).toHaveBeenNthCalledWith(2, { type: 'setSession', cwd, path: path('inner'), folderId: null })
    await drop(row(view.container, 'y'), start(row(view.container, 'x')))
    expect(current.onOrganizationChange).toHaveBeenCalledTimes(2)
  })

  it('rejects a cross-level heading edge and keeps a fresh central move available', async () => {
    const current = props(), view = render(<SessionFolderTree {...current} />), target = heading(view.container, 'b')
    geometry(target)
    const rejected = start(row(view.container, 'inner'))
    hover(target, rejected, 102)
    expect(target).not.toHaveAttribute('data-drop-edge')
    await drop(target, rejected, 102)
    await drop(target, rejected, 120)
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
    await drop(target, start(row(view.container, 'inner')), 120)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: path('inner'), folderId: 'b' })
  })

  it('keeps central classification available while an unrelated sibling is still optimistic', async () => {
    const current = props()
    current.itemProps.sessions = current.itemProps.sessions.map((entry) => entry.id === 'z' ? { ...entry, optimistic: true } : entry)
    const view = render(<SessionFolderTree {...current} />), target = heading(view.container, 'a')
    geometry(target)
    await drop(target, start(row(view.container, 'x')), 102)
    expect(current.onOrganizationChange).not.toHaveBeenCalled()
    await drop(target, start(row(view.container, 'x')), 120)
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'setSession', cwd, path: path('x'), folderId: 'a' })
  })

  it('keeps legacy folder-only sorting available in automatic mode without changing mixed session ranks', async () => {
    const current = props(), view = render(<SessionFolderTree {...current} manualOrder={false} />)
    await drop(heading(view.container, 'b'), start(heading(view.container, 'a')))
    expect(current.onOrganizationChange).toHaveBeenCalledExactlyOnceWith({ type: 'reorderFolders', cwd, ids: ['b', 'a'] })
  })
})
