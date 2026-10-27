// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps, DragEvent, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '../../src/shared/types'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'
import { getSessionDrag, SESSION_DRAG_MIME } from '../../src/renderer/src/utils/sessionDrag'

afterEach(cleanup)
const cwd = '/project'
const session = (id: string): SessionMeta => ({ id, path: `/sessions/${id}.jsonl`, projectCwd: cwd,
  timestamp: '2026-01-01', mtime: 1, preview: id, messageCount: 2 })
const first = session('first'), second = session('second')
function items(): ComponentProps<typeof SessionItems> {
  return { sessions: [first, second], previewDensity: 'compact', runningSessionPaths: new Set(),
    favoritePaths: new Set(), onSelect: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined),
    onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]),
    onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn(), onReorder: vi.fn() }
}
function row(container: HTMLElement, path: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('[data-session-path]')].find((element) => element.dataset.sessionPath === path)!
}
function transfer() {
  const values = new Map<string, string>()
  return { effectAllowed: 'none', dropEffect: 'none',
    get types() { return [...values.keys()] },
    setData: vi.fn((type: string, value: string) => { values.set(type, value) }),
    getData: vi.fn((type: string) => values.get(type) ?? '') }
}

describe('mixed session siblings', () => {
  it('interleaves folders in one flat list and keeps existing session DOM when reordered', () => {
    const props = items()
    const folder = <div key={JSON.stringify(['folder', first.path])} data-folder-id="folder">Folder</div>
    const before = (renderSession: (value: SessionMeta) => ReactElement) => [renderSession(first), folder, renderSession(second)]
    const after = (renderSession: (value: SessionMeta) => ReactElement) => [folder, renderSession(second), renderSession(first)]
    const view = render(<SessionItems {...props} renderWithSiblings={before} />)
    const firstRow = row(view.container, first.path), secondRow = row(view.container, second.path)
    const folderRow = view.container.querySelector('[data-folder-id]')
    expect([...view.container.children]).toEqual([firstRow, folderRow, secondRow])
    view.rerender(<SessionItems {...props} renderWithSiblings={after} />)
    expect([...view.container.children]).toEqual([folderRow, secondRow, firstRow])
    expect(row(view.container, first.path)).toBe(firstRow)
    expect(row(view.container, second.path)).toBe(secondRow)
  })

  it('delegates target events before the legacy path and leaves the real source receipt for one sibling consumption', () => {
    const props = items(), dataTransfer = transfer()
    const oldDrag = { onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() }
    const view = render(<SessionItems {...props} allowFolderDrag siblingDrag={oldDrag} />)
    fireEvent.dragStart(row(view.container, first.path), { dataTransfer })
    expect(dataTransfer.types).toContain(SESSION_DRAG_MIME)
    expect(JSON.parse(dataTransfer.getData(SESSION_DRAG_MIME))).toEqual({ version: 1, cwd, path: first.path })
    const siblingDrag = { targetPath: second.path, onDragOver: vi.fn(), onDragLeave: vi.fn(),
      onDrop: vi.fn((event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        event.stopPropagation()
        expect(getSessionDrag(event.dataTransfer, cwd, 'drop')).toEqual({ cwd, path: first.path })
      }) } satisfies NonNullable<ComponentProps<typeof SessionItems>['siblingDrag']>
    view.rerender(<SessionItems {...props} allowFolderDrag siblingDrag={siblingDrag} />)
    const target = row(view.container, second.path)
    expect(target).toHaveClass('drag-over')
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.dragLeave(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
    expect(siblingDrag.onDragOver).toHaveBeenCalledExactlyOnceWith(expect.anything(), second)
    expect(siblingDrag.onDragLeave).toHaveBeenCalledExactlyOnceWith(expect.anything(), second)
    expect(siblingDrag.onDrop).toHaveBeenCalledExactlyOnceWith(expect.anything(), second)
    expect(getSessionDrag(dataTransfer, cwd, 'drop')).toBeNull()
    expect(props.onReorder).not.toHaveBeenCalled()
    expect(oldDrag.onDragOver).not.toHaveBeenCalled()
    expect(oldDrag.onDragLeave).not.toHaveBeenCalled()
    expect(oldDrag.onDrop).not.toHaveBeenCalled()
  })

  it('keeps the source gate and grip while organization saving disables mixed-row dragging', () => {
    const props = items(), siblingDrag = { onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() }
    const view = render(<SessionItems {...props} allowFolderDrag siblingDrag={siblingDrag} />)
    const source = row(view.container, first.path), grip = source.querySelector('.side-session-drag')
    const original = transfer()
    fireEvent.dragStart(source, { dataTransfer: original })
    view.rerender(<SessionItems {...props} allowFolderDrag siblingDrag={siblingDrag} organizationDisabled />)
    expect(row(view.container, first.path)).toBe(source)
    expect(source.querySelector('.side-session-drag')).toBe(grip)
    expect(source).toHaveAttribute('draggable', 'false')
    expect(getSessionDrag(original, cwd, 'drop')).toBeNull()
    const blocked = transfer()
    fireEvent.dragStart(source, { dataTransfer: blocked })
    expect(blocked.types).not.toContain(SESSION_DRAG_MIME)
  })

  it.each([false, true])('preserves standalone sorting without sibling props (typed source: %s)', (allowFolderDrag) => {
    const props = items(), dataTransfer = transfer()
    const view = render(<SessionItems {...props} allowFolderDrag={allowFolderDrag} />)
    fireEvent.dragStart(row(view.container, first.path), { dataTransfer })
    const target = row(view.container, second.path)
    fireEvent.dragOver(target, { dataTransfer })
    expect(target).toHaveClass('drag-over')
    fireEvent.drop(target, { dataTransfer })
    expect(props.onReorder).toHaveBeenCalledExactlyOnceWith([second, first])
  })
})
