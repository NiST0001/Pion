// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalLifecycle } from '../../src/renderer/src/hooks/useModalLifecycle'
import { TextInputDialog } from '../../src/renderer/src/features/common/TextInputDialog'
import { ConfirmDialog } from '../../src/renderer/src/features/common/ConfirmDialog'

const props = {
  open: true, title: '编辑名称', label: '名称', initialValue: '原名称', confirmLabel: '保存',
  onConfirm: vi.fn(), onCancel: vi.fn()
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('selects the initial text, retains composing drafts, uses current callbacks and restores the opener', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const onConfirm = vi.fn(), onCancel = vi.fn()
  const view = render(<TextInputDialog {...props} onConfirm={onConfirm} onCancel={onCancel} />)
  try {
    const input = screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement
    await waitFor(() => expect(input).toHaveFocus())
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3])
    fireEvent.change(input, { target: { value: '  新名称  ' } })
    fireEvent.compositionStart(input)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    fireEvent.submit(screen.getByRole('dialog'))
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith('新名称')
    const latest = vi.fn()
    view.rerender(<TextInputDialog {...props} busy onCancel={latest} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(latest).not.toHaveBeenCalled()
    view.rerender(<TextInputDialog {...props} onCancel={latest} />)
    expect(input).toHaveValue('  新名称  ')
    fireEvent.keyDown(window, { key: 'Escape', repeat: true })
    expect(latest).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(latest).toHaveBeenCalledOnce()
    view.rerender(<TextInputDialog {...props} open={false} />)
    expect(opener).toHaveFocus()
  } finally { view.unmount(); opener.remove() }
})

it('tracks an owned portal composition without requiring focus and releases its removed source', () => {
  const onClose = vi.fn()
  function Dialog({ portal }: { portal: boolean }) {
    const dialogRef = useRef<HTMLElement>(null)
    const initialFocusRef = useRef<HTMLInputElement>(null)
    const { dialogEvents } = useModalLifecycle({ open: true, dialogRef, initialFocusRef, onClose })
    return <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} {...dialogEvents}>
      <input ref={initialFocusRef} aria-label="dialog input" />
      {portal && createPortal(<input aria-label="portal input" />, document.body)}
    </section>
  }
  const view = render(<Dialog portal />)
  const source = screen.getByRole('textbox', { name: 'portal input' })
  expect(screen.getByRole('dialog').contains(source)).toBe(false)
  expect(source).not.toHaveFocus()
  fireEvent.compositionStart(source)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  view.rerender(<Dialog portal={false} />)
  expect(source.isConnected).toBe(false)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

it('releases a retired nested portal composition target without blocking the parent Escape', async () => {
  const closeParent = vi.fn(), closeChild = vi.fn()
  function Nested({ child }: { child: boolean }) {
    const dialogRef = useRef<HTMLElement>(null)
    const initialFocusRef = useRef<HTMLInputElement>(null)
    const { dialogEvents } = useModalLifecycle({ open: true, dialogRef, initialFocusRef, onClose: closeParent })
    return <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="parent" data-modal-layer="110" tabIndex={-1} {...dialogEvents}>
      <input ref={initialFocusRef} aria-label="parent input" />
      <TextInputDialog {...props} open={child} onCancel={closeChild} />
    </section>
  }
  const view = render(<Nested child={false} />)
  const parentInput = screen.getByRole('textbox', { name: 'parent input' })
  await waitFor(() => expect(parentInput).toHaveFocus())
  view.rerender(<Nested child />)
  const childInput = screen.getByRole('textbox', { name: '名称' })
  await waitFor(() => expect(childInput).toHaveFocus())
  fireEvent.compositionStart(childInput)
  fireEvent.keyDown(childInput, { key: 'Escape' })
  expect(closeChild).not.toHaveBeenCalled()
  expect(closeParent).not.toHaveBeenCalled()
  // A source replacement can unmount the nested input without compositionend.
  view.rerender(<Nested child={false} />)
  expect(parentInput).toHaveFocus()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(closeParent).toHaveBeenCalledOnce()
})

it('resolves the top layer once per key and keeps an upper dialog focused when the lower dialog closes', async () => {
  const onCancel = vi.fn(), onLowerCancel = vi.fn()
  const lower = render(<TextInputDialog {...props} onCancel={onLowerCancel} />)
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
  fireEvent.compositionStart(screen.getByRole('textbox'))
  const upper = render(<ConfirmDialog open title="确认操作" message="继续？" confirmLabel="继续" onConfirm={vi.fn()} onCancel={onCancel} />)
  const cancel = within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消' })
  await waitFor(() => expect(cancel).toHaveFocus())
  const query = vi.spyOn(document, 'querySelectorAll')
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(query.mock.calls.filter(([selector]) => selector.includes('[aria-modal="true"]'))).toHaveLength(1)
  expect(onCancel).toHaveBeenCalledOnce()
  expect(onLowerCancel).not.toHaveBeenCalled()
  query.mockRestore()
  lower.unmount()
  expect(cancel).toHaveFocus()
  upper.unmount()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onCancel).toHaveBeenCalledOnce()
})
