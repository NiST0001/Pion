// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog'
import { OperationsModal } from '../../src/renderer/src/components/OperationsModal'

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
