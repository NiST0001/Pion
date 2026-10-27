// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { applySessionOrganizationChange, sessionOrganizationItemKey, type SessionOrganization, type SessionOrganizationChange, type SessionOrganizationItem } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { SessionFolderTree } from '../../src/renderer/src/features/session/SessionFolderTree'

const cwd = '/project', SESSION = 'application/x-pion-session', FOLDER = 'application/x-pion-session-folder'
const originalApi = window.pion
const path = (id: string) => `/sessions/${id}.jsonl`
const session = (id: string): SessionMeta => ({ id, path: path(id), projectCwd: cwd,
  timestamp: '2026-01-01', mtime: 1, preview: id, messageCount: 2 })
const s = (id: string): SessionOrganizationItem => ({ kind: 'session', path: path(id) })
const f = (id: string): SessionOrganizationItem => ({ kind: 'folder', id })
const rootItems = [s('x'), s('y'), s('z'), f('a'), f('b')]
afterEach(() => { cleanup(); window.pion = originalApi; vi.restoreAllMocks() })
function props(): ComponentProps<typeof SessionFolderTree> {
  const organization: SessionOrganization = { version: 1, revision: 3, folders: [
    { id: 'a', cwd, name: 'A' }, { id: 'aa', cwd, name: 'AA', parentId: 'a', collapsed: true },
    { id: 'b', cwd, name: 'B' }, { id: 'foreign', cwd: '/foreign', name: 'Foreign' }
  ], sessions: [{ cwd, path: path('inner'), folderId: 'a' }, { cwd, path: path('deep'), folderId: 'aa' }] }
  return { cwd, organization, onOrganizationChange: vi.fn().mockResolvedValue(undefined),
    itemProps: { sessions: ['x', 'y', 'z', 'inner', 'deep'].map(session), previewDensity: 'compact',
      runningSessionPaths: new Set(), favoritePaths: new Set(), pendingDeletePaths: new Set([path('unlisted')]),
      onSelect: vi.fn(), onReorder: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
      onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined), onOpenTaskHistory: vi.fn(),
      getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn() } }
}
const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-session-path="${path(id)}"]`)!
const heading = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-folder-id="${id}"] > .session-folder-heading`)!
const element = (container: HTMLElement, item: SessionOrganizationItem) => item.kind === 'folder' ? heading(container, item.id)
  : container.querySelector<HTMLElement>(`[data-session-path="${item.path}"]`)!
function order(container: HTMLElement) {
  return [...container.querySelector('.session-folder-tree')!.children].flatMap((entry) => entry.hasAttribute('data-folder-id')
    ? [sessionOrganizationItemKey({ kind: 'folder', id: entry.getAttribute('data-folder-id')! })]
    : entry.hasAttribute('data-session-path') ? [sessionOrganizationItemKey({ kind: 'session', path: entry.getAttribute('data-session-path')! })] : [])
}
function transfer() {
  const values = new Map<string, string>()
  return { effectAllowed: 'none', dropEffect: 'none', protectedMode: false,
    get types() { return [...values.keys()] },
    setData: vi.fn((type: string, value: string) => { values.set(type, value) }),
    getData: vi.fn(function (this: { protectedMode: boolean }, type: string) { return this.protectedMode ? '' : values.get(type) ?? '' }) }
}
function start(source: HTMLElement) {
  const dataTransfer = transfer()
  fireEvent.dragStart(source.matches('.session-folder-heading') ? source.querySelector('.session-folder-toggle')! : source, { dataTransfer })
  return dataTransfer
}
function dragEvent(kind: 'dragOver' | 'drop', target: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY: number) {
  const event = createEvent[kind](target, { dataTransfer, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(target, event)
}
function hover(target: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY = 102) {
  dataTransfer.protectedMode = true
  dragEvent('dragOver', target, dataTransfer, clientY)
  dataTransfer.protectedMode = false
}
async function drop(target: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY = 102) {
  await act(async () => { dragEvent('drop', target, dataTransfer, clientY) })
}
function geometry(target: HTMLElement) {
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, height: 40, left: 0, right: 200,
    width: 200, x: 0, y: 100, toJSON: () => ({}) })
}
function reorder(organization: SessionOrganization, items: SessionOrganizationItem[]): SessionOrganizationChange {
  return { type: 'reorderItems', cwd, expectedRevision: organization.revision, items }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function mount(current = props()) {
  let gate: ReturnType<typeof deferred> | undefined
  const update = vi.fn(async (change: SessionOrganizationChange) => {
    const pending = gate
    gate = undefined
    if (pending) await pending.promise
    current.organization = applySessionOrganizationChange(current.organization, change)
  })
  current.onOrganizationChange = update
  const view = render(<SessionFolderTree {...current} />)
  return { current, view, update,
    hold() { gate = deferred(); return gate },
    refresh(metadata = false) {
      current.itemProps = { ...current.itemProps,
        sessions: current.itemProps.sessions.map((entry) => ({ ...entry, ...(metadata ? {
          preview: `${entry.preview} refreshed`, name: `Name ${entry.id}`, mtime: entry.mtime + 1,
          messageCount: entry.messageCount + 1, totalTokens: (entry.totalTokens ?? 0) + 100
        } : {}) })), pendingDeletePaths: new Set(current.itemProps.pendingDeletePaths) }
      view.rerender(<SessionFolderTree {...current} />)
    } }
}

const pairs = [
  { name: 'folder→session', source: f('a'), target: s('y'), spacer: s('x') },
  { name: 'session→session', source: s('x'), target: s('z'), spacer: s('y') },
  { name: 'folder→folder', source: f('a'), target: f('b'), spacer: s('x') }
]

describe('session tree drag continuity', () => {
  it.each(['folder', 'session'] as const)('preserves a private %s drag across equivalent cloned list and metadata refreshes', async (kind) => {
    const tree = mount(), { current, view, update } = tree
    const sourceItem = kind === 'folder' ? f('a') : s('x'), targetItem = kind === 'folder' ? s('x') : s('z')
    const source = element(view.container, sourceItem), target = element(view.container, targetItem)
    const deep = row(view.container, 'deep'), nested = heading(view.container, 'aa').parentElement
    geometry(target)
    const dataTransfer = start(source), previous = current.itemProps.sessions, deleting = current.itemProps.pendingDeletePaths
    const revision = current.organization.revision
    expect(dataTransfer.types).toContain(kind === 'folder' ? FOLDER : SESSION)
    tree.refresh(true)
    expect(current.itemProps.sessions).not.toBe(previous)
    expect(current.itemProps.sessions[0]).not.toBe(previous[0])
    expect(current.itemProps.pendingDeletePaths).not.toBe(deleting)
    expect([...current.itemProps.pendingDeletePaths!]).toEqual([...deleting!])
    expect(element(view.container, sourceItem)).toBe(source)
    expect(element(view.container, targetItem)).toBe(target)
    hover(target, dataTransfer)
    expect(dataTransfer.getData).not.toHaveBeenCalled()
    expect(dataTransfer.dropEffect).toBe('move')
    await drop(target, dataTransfer)
    const items = kind === 'folder' ? [f('a'), s('x'), s('y'), s('z'), f('b')] : [s('y'), s('x'), s('z'), f('a'), f('b')]
    expect(update).toHaveBeenCalledExactlyOnceWith({ type: 'reorderItems', cwd, expectedRevision: revision, items })
    expect(dataTransfer.getData).toHaveBeenCalledExactlyOnceWith(kind === 'folder' ? FOLDER : SESSION)
    tree.refresh()
    expect(order(view.container)).toEqual(items.map(sessionOrganizationItemKey))
    expect(element(view.container, sourceItem)).toBe(source)
    expect(element(view.container, targetItem)).toBe(target)
    expect(row(view.container, 'deep')).toBe(deep)
    expect(heading(view.container, 'aa').parentElement).toBe(nested)
    expect(current.itemProps.onReorder).not.toHaveBeenCalled()
  })

  it.each(pairs.flatMap((pair) => ['above', 'below'].map((direction) => ({ ...pair, direction }))))(
    'keeps $name before→after→before stable with the source initially $direction', async ({ source: sourceItem, target: targetItem, spacer, direction }) => {
      const current = props(), occupied = new Set([sourceItem, targetItem, spacer].map(sessionOrganizationItemKey))
      const rest = rootItems.filter((item) => !occupied.has(sessionOrganizationItemKey(item)))
      const initial = direction === 'above' ? [sourceItem, spacer, targetItem, ...rest] : [targetItem, spacer, sourceItem, ...rest]
      current.organization = applySessionOrganizationChange(current.organization, reorder(current.organization, initial))
      const tree = mount(current), { view, update } = tree
      const source = element(view.container, sourceItem), target = element(view.container, targetItem)
      const deep = row(view.container, 'deep'), startingRevision = current.organization.revision
      geometry(target)
      expect(order(view.container)).toEqual(initial.map(sessionOrganizationItemKey))
      const transfers = new Set<ReturnType<typeof transfer>>()
      for (const [index, edge] of (['before', 'after', 'before'] as const).entries()) {
        const clientY = edge === 'before' ? 102 : 138, dataTransfer = start(source), pending = tree.hold()
        expect(transfers.has(dataTransfer)).toBe(false)
        transfers.add(dataTransfer)
        expect(dataTransfer.types).toContain(sourceItem.kind === 'folder' ? FOLDER : SESSION)
        hover(target, dataTransfer, clientY)
        expect(dataTransfer.getData).not.toHaveBeenCalled()
        expect(dataTransfer.dropEffect).toBe('move')
        const items = direction === 'above'
          ? edge === 'before' ? [spacer, sourceItem, targetItem, ...rest] : [spacer, targetItem, sourceItem, ...rest]
          : edge === 'before' ? [sourceItem, targetItem, spacer, ...rest] : [targetItem, sourceItem, spacer, ...rest]
        const previousOrder = order(view.container), previousOrganization = current.organization
        await drop(target, dataTransfer, clientY)
        expect(update).toHaveBeenCalledTimes(index + 1)
        expect(update).toHaveBeenNthCalledWith(index + 1, { type: 'reorderItems', cwd, expectedRevision: startingRevision + index, items })
        expect(dataTransfer.getData).toHaveBeenCalledExactlyOnceWith(sourceItem.kind === 'folder' ? FOLDER : SESSION)
        expect(order(view.container)).toEqual(previousOrder)
        expect(source.matches('.session-folder-heading') ? source.querySelector('button')! : source).not.toHaveAttribute('draggable', 'true')
        await act(async () => { pending.resolve() })
        expect(current.organization).not.toBe(previousOrganization)
        expect(current.organization.revision).toBe(startingRevision + index + 1)
        tree.refresh()
        expect(order(view.container)).toEqual(items.map(sessionOrganizationItemKey))
        expect(element(view.container, sourceItem)).toBe(source)
        expect(element(view.container, targetItem)).toBe(target)
        expect(row(view.container, 'deep')).toBe(deep)
        expect(current.organization.sessions.find((entry) => entry.path === path('deep'))?.folderId).toBe('aa')
      }
      expect(current.itemProps.onReorder).not.toHaveBeenCalled()
    })

  it('holds the real save gate and permits fresh drags after failure and success', async () => {
    const tree = mount(), { current, view, update } = tree
    const source = heading(view.container, 'a'), target = row(view.container, 'x'), snapshot = current.organization
    geometry(target)
    const failed = tree.hold(), first = start(source)
    hover(target, first)
    expect(first.getData).not.toHaveBeenCalled()
    await drop(target, first)
    expect(first.getData).toHaveBeenCalledExactlyOnceWith(FOLDER)
    expect(start(heading(view.container, 'b')).types).not.toContain(FOLDER)
    const blocked = start(row(view.container, 'y'))
    expect(blocked.types).not.toContain(SESSION)
    await drop(target, blocked)
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => { failed.reject(new Error('保存失败：只读')) })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：只读')
    expect(current.organization).toBe(snapshot)
    tree.refresh()
    const saved = tree.hold(), second = start(source)
    expect(second).not.toBe(first)
    expect(second.types).toContain(FOLDER)
    hover(target, second)
    expect(second.getData).not.toHaveBeenCalled()
    await drop(target, second)
    expect(second.getData).toHaveBeenCalledExactlyOnceWith(FOLDER)
    expect(update).toHaveBeenNthCalledWith(2, reorder(snapshot, [f('a'), s('x'), s('y'), s('z'), f('b')]))
    expect(start(row(view.container, 'y')).types).not.toContain(SESSION)
    await act(async () => { saved.resolve() })
    tree.refresh()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(heading(view.container, 'a')).toBe(source)
    expect(row(view.container, 'x')).toBe(target)
    const thirdTarget = row(view.container, 'z'), revision = current.organization.revision, third = start(target)
    geometry(thirdTarget)
    expect(third).not.toBe(second)
    expect(third.types).toContain(SESSION)
    hover(thirdTarget, third, 138)
    expect(third.getData).not.toHaveBeenCalled()
    await drop(thirdTarget, third, 138)
    const items = [f('a'), s('y'), s('z'), s('x'), f('b')]
    expect(update).toHaveBeenNthCalledWith(3, { type: 'reorderItems', cwd, expectedRevision: revision, items })
    expect(third.getData).toHaveBeenCalledExactlyOnceWith(SESSION)
    tree.refresh()
    expect(order(view.container)).toEqual(items.map(sessionOrganizationItemKey))
    expect(heading(view.container, 'a')).toBe(source)
    expect(row(view.container, 'x')).toBe(target)
  })

  it('retires a session receipt when the real SDK id changes at the same path', async () => {
    const tree = mount(), { current, view, update } = tree, source = row(view.container, 'x'), target = row(view.container, 'z')
    geometry(target)
    const dataTransfer = start(source)
    current.itemProps.sessions = current.itemProps.sessions.map((entry) => entry.path === path('x') ? { ...entry, id: 'replacement-id' } : entry)
    tree.refresh()
    hover(target, dataTransfer)
    expect(dataTransfer.getData).not.toHaveBeenCalled()
    expect(target).not.toHaveClass('drag-over')
    await drop(target, dataTransfer)
    expect(update).not.toHaveBeenCalled()
  })
})
