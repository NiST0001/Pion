// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormEvent } from 'react'
import { ComposerAttachments } from '../../src/renderer/src/features/chat/ComposerAttachments'
import type { ReferenceAttachment } from '../../src/renderer/src/features/chat/composerReferences'

const image: ReferenceAttachment = {
  id: 'image-a', kind: 'image', name: 'same.png', mimeType: 'image/png', size: 1,
  imageNumber: 1, image: { type: 'image', mimeType: 'image/png', data: 'YQ==' }
}
const text: ReferenceAttachment = {
  id: 'text-a', kind: 'text', name: 'notes.html', mimeType: 'text/html', size: 1,
  content: '<script>not executable</script>\nplain text'
}
const props = () => ({
  references: [image, text], pendingImages: [], reading: false, error: '', disabled: false, scopeKey: 'A',
  onInsertToken: vi.fn(), onRemove: vi.fn()
})
const advance = (ms = 500): void => { act(() => vi.advanceTimersByTime(ms)) }
const mouseClick = (button: HTMLElement, detail: number): void => {
  fireEvent.mouseDown(button, { detail })
  fireEvent.mouseUp(button, { detail })
  fireEvent.click(button, { detail })
}

// Native mouse double-click sequence, not just a synthetic dblclick.
const doubleClick = (button: HTMLElement, pointer: boolean): void => {
  mouseClick(button, 1)
  advance(450)
  if (pointer) {
    // jsdom may not expose PointerEvent; preserve the native detail on pointerdown.
    fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, detail: 2 }))
  } else fireEvent.mouseDown(button, { detail: 2 })
  advance(100) // Hold the second press across the original 500 ms deadline.
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.mouseUp(button, { detail: 2 })
  fireEvent.click(button, { detail: 2 })
  fireEvent.doubleClick(button, { detail: 2 })
}

describe('pending attachment previews', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('delays image preview without editing or sending, closes and restores focus', () => {
    const p = props()
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault())
    render(<form onSubmit={onSubmit}><textarea aria-label="草稿" defaultValue="unchanged" />
      <ComposerAttachments {...p} /></form>)
    const draft = screen.getByRole('textbox', { name: '草稿' })
    draft.focus()
    mouseClick(screen.getByRole('button', { name: '预览图像 1' }), 1)
    advance(499)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    advance(1)
    const dialog = screen.getByRole('dialog', { name: '图像 1 · same.png' })
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,YQ==')
    expect(screen.getByRole('button', { name: '关闭参考预览' })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(draft).toHaveFocus()
    expect(draft).toHaveValue('unchanged')
    expect(p.onInsertToken).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels on the second mouse/pointer press at 450 ms while held, and references once', () => {
    const p = props()
    const second: ReferenceAttachment = { ...image, id: 'image-b', imageNumber: 2 }
    const draft = document.createElement('textarea')
    document.body.append(draft)
    p.onInsertToken.mockImplementation(() => draft.focus())
    try {
      render(<ComposerAttachments {...p} references={[image, second, text]} />)
      for (const [label, id] of [['预览图像 2', 'image-b'], ['预览参考 notes.html', 'text-a']]) {
        doubleClick(screen.getByRole('button', { name: label }), id === 'text-a')
        advance()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(p.onInsertToken).toHaveBeenLastCalledWith(id)
        expect(draft).toHaveFocus()
      }
      expect(p.onInsertToken).toHaveBeenCalledTimes(2)
    } finally {
      draft.remove()
    }
  })

  it('previews keyboard button activation immediately, traps focus and renders text literally', () => {
    const p = props()
    render(<ComposerAttachments {...p} />)
    const button = screen.getByRole('button', { name: '预览参考 notes.html' })
    button.focus()
    // Native keyboard activation dispatches click with detail=0.
    fireEvent.click(button, { detail: 0 })
    const dialog = screen.getByRole('dialog', { name: 'notes.html' })
    expect(dialog.querySelector('pre')).toHaveTextContent('<script>not executable</script>')
    expect(dialog.querySelector('script')).toBeNull()
    const close = screen.getByRole('button', { name: '关闭参考预览' })
    const content = screen.getByLabelText('参考内容')
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(content).toHaveFocus()
    fireEvent.keyDown(content, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.click(close)
    expect(button).toHaveFocus()
    fireEvent.click(button, { detail: 0 })
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(p.onInsertToken).not.toHaveBeenCalled()
    expect(p.onRemove).not.toHaveBeenCalled()
  })

  it('cancels pending previews on scope, disable, deletion, replacement, other modal and unmount', () => {
    const p = props()
    const view = render(<ComposerAttachments {...p} />)
    const click = (): void => mouseClick(screen.getByRole('button', { name: '预览图像 1' }), 1)
    click()
    // Identical ids and bytes are still a different owner, including A → B → A.
    view.rerender(<ComposerAttachments {...p} scopeKey="B" />)
    view.rerender(<ComposerAttachments {...p} />)
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    click()
    const confirmation = document.createElement('section')
    confirmation.setAttribute('role', 'alertdialog')
    confirmation.setAttribute('aria-modal', 'true')
    const confirmButton = document.createElement('button')
    confirmation.append(confirmButton)
    document.body.append(confirmation)
    try {
      confirmButton.focus()
      advance()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(confirmButton).toHaveFocus()
    } finally {
      confirmation.remove()
    }
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    click()
    view.rerender(<ComposerAttachments {...p} disabled />)
    view.rerender(<ComposerAttachments {...p} />)
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    click()
    view.rerender(<ComposerAttachments {...p} references={[text]} />)
    view.rerender(<ComposerAttachments {...p} />)
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    click()
    view.rerender(<ComposerAttachments {...p} references={[{ ...image, id: 'replacement' }, text]} />)
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    click()
    view.rerender(<ComposerAttachments {...p} references={[{ ...image, id: 'replacement', image: { ...image.image, data: 'Yg==' } }]} />)
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    click()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    advance()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(p.onInsertToken).not.toHaveBeenCalled()
  })

  it('retires an open preview on scope, disable or replacement, never reviving it', () => {
    const p = props()
    const view = render(<ComposerAttachments {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '预览图像 1' }), { detail: 0 })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    view.rerender(<ComposerAttachments {...p} scopeKey="B" />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(<ComposerAttachments {...p} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '预览图像 1' }), { detail: 0 })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    view.rerender(<ComposerAttachments {...p} disabled />)
    view.rerender(<ComposerAttachments {...p} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '预览参考 notes.html' }), { detail: 0 })
    view.rerender(<ComposerAttachments {...p} references={[image, { ...text, id: 'new-text' }]} />)
    view.rerender(<ComposerAttachments {...p} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(p.onInsertToken).not.toHaveBeenCalled()
  })
})
