// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../../src/renderer/src/features/common/ConfirmDialog'
import { PionSelect } from '../../src/renderer/src/features/common/PionSelect'
import { OperationsModal } from '../../src/renderer/src/features/operations/OperationsModal'

const choices = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]

function openSelect(button: HTMLElement): void {
  act(() => button.focus({ preventScroll: true }))
  fireEvent.click(button)
}

describe('OperationsModal', () => {
  it('opens a command-labelled portal and closes with Escape', () => {
    const onClose = vi.fn()
    render(
      <OperationsModal kind="agents" onClose={onClose}>
        <div>workflow content</div>
      </OperationsModal>
    )

    expect(screen.getByRole('dialog', { name: '隔离多 Agent' })).toHaveTextContent('/agents')
    expect(screen.getByText('workflow content')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('contains Tab focus inside the topmost modal', () => {
    render(
      <>
        <button type="button">background</button>
        <OperationsModal kind="agents" onClose={vi.fn()}>
          <button type="button">last action</button>
        </OperationsModal>
      </>
    )

    const close = screen.getByRole('button', { name: '关闭隔离多 Agent' })
    const last = screen.getByRole('button', { name: 'last action' })
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(close).toHaveFocus()
    screen.getByRole('button', { name: 'background' }).focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(close).toHaveFocus()
  })

  it('leaves Escape to a nested confirmation dialog', () => {
    const closeOperations = vi.fn()
    const closeConfirmation = vi.fn()
    render(
      <OperationsModal kind="agents" onClose={closeOperations}>
        <ConfirmDialog
          open
          title="确认操作"
          message="nested"
          confirmLabel="确认"
          onConfirm={vi.fn()}
          onCancel={closeConfirmation}
        />
      </OperationsModal>
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeConfirmation).toHaveBeenCalledTimes(1)
    expect(closeOperations).not.toHaveBeenCalled()
  })

  it.each(['stats', 'archive'] as const)('lets %s select Escape close only its own portal and retain trigger focus', (kind) => {
    const onClose = vi.fn()
    render(<OperationsModal kind={kind} onClose={onClose}>
      <PionSelect value="a" options={choices} ariaLabel="Choice" onValueChange={vi.fn()} />
    </OperationsModal>)
    const button = screen.getByRole('combobox', { name: 'Choice' })
    openSelect(button)
    const list = screen.getByRole('listbox', { name: 'Choice' })
    expect(list.parentElement).toBe(document.body)
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it.each(['stats', 'archive'] as const)('lets %s select Enter open and commit without reaching global shortcuts', (kind) => {
    const onClose = vi.fn(), change = vi.fn(), globalKey = vi.fn()
    render(<OperationsModal kind={kind} onClose={onClose}>
      <PionSelect value="a" options={choices} ariaLabel="Choice" onValueChange={change} />
    </OperationsModal>)
    const button = screen.getByRole('combobox', { name: 'Choice' })
    window.addEventListener('keydown', globalKey)
    try {
      act(() => button.focus())
      fireEvent.keyDown(button, { key: 'Enter' })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      fireEvent.keyDown(button, { key: 'End' })
      fireEvent.keyDown(button, { key: 'Enter' })
      expect(change).toHaveBeenCalledExactlyOnceWith('b')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(button).toHaveFocus()
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(globalKey).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', globalKey) }
  })

  it.each(['stats', 'archive'] as const)('keeps %s IME keys inside the modal without selecting or closing', (kind) => {
    const onClose = vi.fn(), change = vi.fn(), globalKey = vi.fn()
    render(<OperationsModal kind={kind} onClose={onClose}>
      <PionSelect value="a" options={choices} ariaLabel="Choice" onValueChange={change} />
    </OperationsModal>)
    const button = screen.getByRole('combobox', { name: 'Choice' })
    openSelect(button)
    window.addEventListener('keydown', globalKey)
    try {
      fireEvent.keyDown(button, { key: 'End' })
      fireEvent.compositionStart(button)
      fireEvent.keyDown(button, { key: 'Enter' })
      fireEvent.keyDown(button, { key: 'Escape' })
      fireEvent.compositionEnd(button)
      fireEvent.keyDown(button, { key: 'Enter', isComposing: true })
      fireEvent.keyDown(button, { key: 'Escape', keyCode: 229 })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      expect(change).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(globalKey).not.toHaveBeenCalled()
      fireEvent.keyDown(button, { key: 'Enter' })
      expect(change).toHaveBeenCalledExactlyOnceWith('b')
    } finally { window.removeEventListener('keydown', globalKey) }
  })

  it('keeps select keyboard ownership with the topmost nested modal and restores the parent trigger', () => {
    const closeParent = vi.fn(), closeChild = vi.fn(), parentChange = vi.fn(), childChange = vi.fn()
    const panel = (nested: boolean) => <OperationsModal kind="stats" onClose={closeParent}>
      <PionSelect value="a" options={choices} ariaLabel="Parent choice" onValueChange={parentChange} />
      {nested && <OperationsModal kind="archive" onClose={closeChild}>
        <PionSelect value="a" options={choices} ariaLabel="Child choice" onValueChange={childChange} />
      </OperationsModal>}
    </OperationsModal>
    const { rerender } = render(panel(false))
    const parent = screen.getByRole('combobox', { name: 'Parent choice' })
    openSelect(parent)
    rerender(panel(true))
    const child = screen.getByRole('combobox', { name: 'Child choice' })
    expect(screen.getByRole('button', { name: '关闭归档会话' })).toHaveFocus()
    fireEvent.keyDown(parent, { key: 'Enter' })
    expect(parentChange).not.toHaveBeenCalled()
    openSelect(child)
    fireEvent.keyDown(child, { key: 'End' })
    fireEvent.keyDown(child, { key: 'Enter' })
    expect(childChange).toHaveBeenCalledExactlyOnceWith('b')
    openSelect(child)
    fireEvent.keyDown(child, { key: 'Escape' })
    expect(closeChild).not.toHaveBeenCalled()
    expect(child).toHaveFocus()
    fireEvent.keyDown(child, { key: 'Escape' })
    expect(closeChild).toHaveBeenCalledTimes(1)
    expect(closeParent).not.toHaveBeenCalled()
    rerender(panel(false))
    expect(parent).toHaveFocus()
    expect(screen.getByRole('dialog', { name: '使用总览' })).toBeInTheDocument()
  })

  it('ignores unrelated popup classes while containing Tab and restoring the previous focus', () => {
    const onClose = vi.fn()
    const { rerender } = render(<><button type="button">Composer</button></>)
    const composer = screen.getByRole('button', { name: 'Composer' })
    act(() => composer.focus())
    rerender(<><button type="button">Composer</button><OperationsModal kind="stats" onClose={onClose}>
      <PionSelect value="a" options={choices} ariaLabel="Choice" onValueChange={vi.fn()} />
      <div className="pion-select-popup" role="listbox" />
    </OperationsModal></>)
    const close = screen.getByRole('button', { name: '关闭使用总览' })
    const button = screen.getByRole('combobox', { name: 'Choice' })
    openSelect(button)
    fireEvent.keyDown(button, { key: 'Tab' })
    expect(close).toHaveFocus()
    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeInTheDocument()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(button).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<><button type="button">Composer</button></>)
    expect(composer).toHaveFocus()
  })

  it('closes only when the modal backdrop itself is pressed', () => {
    const onClose = vi.fn()
    render(
      <OperationsModal kind="verification" onClose={onClose}>
        <button type="button">inside</button>
      </OperationsModal>
    )

    fireEvent.mouseDown(screen.getByRole('button', { name: 'inside' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.querySelector('.operations-modal-backdrop') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
