// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders in a portal and confirms explicitly', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmDialog
        open
        title="Discard changes?"
        message="This cannot be undone."
        confirmLabel="Discard"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />
    )

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('allows Escape and backdrop cancellation only while idle', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Delete session?"
        message="Confirm deletion."
        confirmLabel="Delete"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()

    rerender(
      <ConfirmDialog
        open
        busy
        title="Delete session?"
        message="Confirm deletion."
        confirmLabel="Delete"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
