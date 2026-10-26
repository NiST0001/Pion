// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'

afterEach(cleanup)
const A = '/sessions/a.jsonl', B = '/sessions/b.jsonl'
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function props(): ComponentProps<typeof SessionItems> {
  return { sessions: [A, B].map((path) => ({ path, id: path, projectCwd: '/project', name: path,
    timestamp: '', mtime: 1, preview: '', messageCount: 1 })), previewDensity: 'compact',
    runningSessionPaths: new Set(), favoritePaths: new Set([A]), onToggleFavorite: vi.fn(),
    onSelect: vi.fn(), onReorder: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn().mockResolvedValue(undefined), onRename: vi.fn().mockResolvedValue(undefined),
    onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]), onFork: vi.fn().mockResolvedValue('') }
}
function row(container: HTMLElement, path: string) {
  return [...container.querySelectorAll<HTMLElement>('[data-session-path]')].find((item) => item.dataset.sessionPath === path)!
}
function confirmDelete(target: HTMLElement) {
  fireEvent.contextMenu(target)
  fireEvent.click(screen.getByRole('button', { name: '删除会话' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认删除' }))
}

it('closes deletion confirmation immediately and only blocks the target while the real request waits', async () => {
  const callbacks = props(), deletion = deferred()
  callbacks.favoritePaths = new Set()
  vi.mocked(callbacks.onDelete).mockReturnValueOnce(deletion.promise)
  const view = render(<SessionItems {...callbacks} />)
  const target = row(view.container, A), sibling = row(view.container, B)
  const grip = sibling.querySelector('.side-session-drag')
  confirmDelete(target)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(row(view.container, A)).toBe(target)
  expect(target).toHaveAttribute('aria-busy', 'true')
  expect(within(target).getByRole('button', { name: '正在删除会话' })).toBeDisabled()
  fireEvent.click(target)
  fireEvent.contextMenu(target)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(callbacks.onDelete).toHaveBeenCalledExactlyOnceWith(A)
  fireEvent.click(sibling)
  expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith(B)
  expect(sibling.querySelector('.side-session-drag')).toBe(grip)
  await act(async () => { deletion.resolve(); await deletion.promise })
  expect(target).toBeInTheDocument()
  view.rerender(<SessionItems {...callbacks} sessions={[callbacks.sessions[1]]} />)
  expect(row(view.container, A)).toBeUndefined()
  expect(row(view.container, B)).toBe(sibling)
})

it('keeps a failed deletion visible with its original favorite and an inline error, without reopening a modal', async () => {
  const callbacks = props(), deletion = deferred()
  vi.mocked(callbacks.onDelete).mockReturnValueOnce(deletion.promise)
  const view = render(<SessionItems {...callbacks} />)
  const target = row(view.container, A)
  confirmDelete(target)
  await act(async () => { deletion.reject(new Error('后台拒绝删除')); await deletion.promise.catch(() => {}) })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('后台拒绝删除')
  expect(row(view.container, A)).toBe(target)
  expect(target).not.toHaveAttribute('aria-disabled', 'true')
  expect(within(target).getByRole('button', { name: '取消收藏会话' })).toBeEnabled()
  expect(callbacks.onToggleFavorite).not.toHaveBeenCalled()
})

it('retains row, favorite and drag DOM while reorder/pending gates change', () => {
  const callbacks = props()
  const view = render(<SessionItems {...callbacks} />)
  const target = row(view.container, A), sibling = row(view.container, B)
  const grip = target.querySelector('.side-session-drag'), favorite = target.querySelector('.side-session-favorite')
  view.rerender(<SessionItems {...callbacks} reorderDisabled pendingDeletePaths={new Set([A])} />)
  expect(row(view.container, A)).toBe(target)
  expect(target).toHaveClass('reorderable')
  expect(target.querySelector('.side-session-drag')).toBe(grip)
  expect(target.querySelector('.side-session-favorite')).toBe(favorite)
  expect(target).toHaveAttribute('draggable', 'false')
  const dataTransfer = { getData: () => B, setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  expect(fireEvent.dragStart(sibling, { dataTransfer })).toBe(false)
  fireEvent.drop(target, { dataTransfer })
  expect(callbacks.onReorder).not.toHaveBeenCalled()
  view.rerender(<SessionItems {...callbacks} pendingDeletePaths={new Set()} />)
  expect(target.querySelector('.side-session-drag')).toBe(grip)
  expect(target.querySelector('.side-session-favorite')).toBe(favorite)
  expect(target).toHaveAttribute('draggable', 'true')
})
