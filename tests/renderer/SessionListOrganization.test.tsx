// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { SessionItems } from '../../src/renderer/src/features/session/SessionList'

afterEach(cleanup)
function props(): ComponentProps<typeof SessionItems> {
  return { sessions: [{ id: 'real-session-id', path: '/session.jsonl', projectCwd: '/project',
    name: '原会话', timestamp: '2026-01-01', mtime: 1, preview: '原预览', messageCount: 3 }],
    previewDensity: 'compact', favoritePaths: new Set(), runningSessionPaths: new Set(), onSelect: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined), onCopy: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined), onOpenTaskHistory: vi.fn(), getForkMessages: vi.fn().mockResolvedValue([]),
    onFork: vi.fn().mockResolvedValue('fork'), onToggleFavorite: vi.fn() }
}
function open(): void { fireEvent.contextMenu(screen.getByText('原会话').closest('[data-session-path]')!) }

describe('SessionItems optional organization actions', () => {
  it('keeps original menus intact when organization callbacks are absent', () => {
    render(<SessionItems {...props()} />)
    open()
    expect(screen.queryByRole('button', { name: '归档会话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '移到文件夹' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重命名会话' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '从会话分支' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '删除会话' })).toBeEnabled()
  })

  it('holds busy while archive settles, preserves row on failure and shows the actual error', async () => {
    const itemProps = props()
    let reject!: (reason: Error) => void
    const archive = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    render(<SessionItems {...itemProps} onArchive={archive} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: '归档会话' }))
    fireEvent.click(screen.getByRole('button', { name: '归档会话' }))
    expect(archive).toHaveBeenCalledTimes(1)
    expect(archive).toHaveBeenCalledWith('/session.jsonl')
    expect(screen.getByRole('button', { name: '归档会话' })).toBeDisabled()
    await act(async () => { reject(new Error('写入失败')) })
    expect(screen.getByRole('alert')).toHaveTextContent('写入失败')
    expect(screen.getByRole('button', { name: '归档会话' })).toBeEnabled()
    expect(itemProps.onDelete).not.toHaveBeenCalled()
    expect(itemProps.onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-session-path="/session.jsonl"]')).toBeInTheDocument()
  })

  it('picks folders locally and moves only after explicit confirmation; root is null', async () => {
    const move = vi.fn().mockResolvedValue(undefined)
    render(<SessionItems {...props()} folderOptions={[{ value: '', label: '根目录' }, { value: 'child', label: '父 / 子' }]}
      sessionFolderIds={new Map([['/session.jsonl', 'child']])} onMoveToFolder={move} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: '移到文件夹' }))
    expect(screen.getByRole('combobox', { name: '目标文件夹' })).toHaveTextContent('父 / 子')
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: '根目录' }))
    expect(move).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认移动' })) })
    expect(move).toHaveBeenCalledWith('/session.jsonl', null)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('gates an already-open move dialog when organization becomes disabled and preserves IME selection', () => {
    const move = vi.fn(), itemProps = props()
    const extra = { onMoveToFolder: move, onArchive: vi.fn(), folderOptions: [{ value: '', label: '根目录' }, { value: 'a', label: 'A' }] }
    const view = render(<SessionItems {...itemProps} {...extra} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: '移到文件夹' }))
    const select = screen.getByRole('combobox')
    fireEvent.compositionStart(select)
    fireEvent.keyDown(select, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(select).toHaveAttribute('aria-expanded', 'false')
    fireEvent.compositionEnd(select)
    view.rerender(<SessionItems {...itemProps} {...extra} organizationDisabled />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
    expect(move).not.toHaveBeenCalled()
  })
})
