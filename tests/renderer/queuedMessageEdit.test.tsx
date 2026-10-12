// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useQueuedMessageEdit } from '../../src/renderer/src/hooks/useQueuedMessageEdit'
import type { QueuedMessageEditResult } from '../../src/shared/types'

type Options = Parameters<typeof useQueuedMessageEdit>[0]
type Editor = ReturnType<typeof useQueuedMessageEdit>
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function deferred() {
  let resolve!: (value: QueuedMessageEditResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<QueuedMessageEditResult>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const request = deferred()
  const editQueuedMessage = vi.fn(() => request.promise)
  const selectionRef = { current: { generation: 1 } }
  let options: Options = { scope: 'a', selectionRef, disabled: false, editQueuedMessage }
  let editor!: Editor
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function View() { editor = useQueuedMessageEdit(options); return null }
  act(() => root.render(<View />))
  cleanups.push(() => { act(() => root.unmount()); container.remove() })
  return {
    request, editQueuedMessage, selectionRef,
    get editor() { return editor },
    update(next: Partial<Options>) { options = { ...options, ...next }; act(() => root.render(<View />)) }
  }
}
const payload: QueuedMessageEditResult = { runId: 'real-id', text: 'original',
  images: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }] }

describe('queue draft edit delivery', () => {
  it('takes by identity, freezes editing until acknowledgment and retains original images', async () => {
    const h = harness()
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    expect(h.editor.frozen).toBe(true)
    await act(async () => h.request.resolve(payload))
    expect(h.editQueuedMessage).toHaveBeenCalledExactlyOnceWith('real-id')
    expect(h.editor.restoreDraft).toMatchObject(payload)
    expect(h.editor.restoreDraft?.images[0]).not.toBe(payload.images[0])
    expect(h.editor.restoreDraft?.valid()).toBe(true)
    const id = h.editor.restoreDraft!.id
    act(() => h.editor.onRestoreDraftConsumed(id, true))
    expect(h.editor.frozen).toBe(false)
    expect(h.editor.restoreDraft).toBeUndefined()
    expect(h.editor.canRestore).toBe(false)
  })

  it('does not take a queue item over a draft, attachment or in-flight image read', async () => {
    const h = harness()
    await act(async () => { h.editor.onDraftAvailabilityChange(false); await h.editor.edit('real-id') })
    expect(h.editQueuedMessage).not.toHaveBeenCalled()
    expect(h.editor.error).toContain('清空')
  })

  it('retains a result when a newer draft appears and restores only on explicit retry', async () => {
    const h = harness()
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    act(() => h.editor.onDraftAvailabilityChange(false))
    await act(async () => h.request.resolve(payload))
    expect(h.editor.restoreDraft).toBeUndefined()
    expect(h.editor.canRestore).toBe(true)
    act(() => { h.editor.onDraftAvailabilityChange(true); h.editor.restoreRetained() })
    expect(h.editor.restoreDraft).toMatchObject(payload)
    expect(h.editQueuedMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects late A-B-A delivery by selection generation without discarding the taken draft', async () => {
    const h = harness()
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    h.selectionRef.current.generation++
    h.update({ scope: 'b' })
    await act(async () => h.request.resolve(payload))
    expect(h.editor.restoreDraft).toBeUndefined()
    h.selectionRef.current.generation++
    h.update({ scope: 'a' })
    expect(h.editor.restoreDraft).toBeUndefined()
    expect(h.editor.canRestore).toBe(true)
    act(() => h.editor.restoreRetained())
    expect(h.editor.restoreDraft?.valid()).toBe(true)
  })

  it('invalidates an already offered draft synchronously before a new React commit', async () => {
    const h = harness()
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    await act(async () => h.request.resolve(payload))
    const draft = h.editor.restoreDraft!
    h.selectionRef.current.generation++
    expect(draft.valid()).toBe(false)
    h.update({})
    act(() => h.editor.restoreRetained())
    expect(draft.valid()).toBe(false)
    expect(h.editor.restoreDraft?.valid()).toBe(true)
  })

  it('does not treat an old session snapshot as the selected owner during a switch', async () => {
    const h = harness()
    h.update({ validOwner: () => false })
    await act(async () => { h.editor.onDraftAvailabilityChange(true); await h.editor.edit('real-id') })
    expect(h.editQueuedMessage).not.toHaveBeenCalled()
  })

  it('keeps an unconfirmed first identity retryable instead of replacing it with another item', async () => {
    const h = harness()
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    await act(async () => h.request.reject(new Error('lost response')))
    await act(async () => h.editor.edit('different-id'))
    expect(h.editQueuedMessage).toHaveBeenCalledTimes(1)
    expect(h.editor.canRetry).toBe(true)
    act(() => h.editor.requestClose())
    expect(h.editor.closeConfirmation.open).toBe(true)
    act(() => h.editor.closeConfirmation.onCancel())
    expect(h.editor.canRetry).toBe(true)
    act(() => h.editor.requestClose())
    act(() => h.editor.closeConfirmation.onConfirm())
    expect(h.editor.canRetry).toBe(false)
  })

  it('invalidates automatic delivery on a backend-origin change without dropping taken contents', async () => {
    const h = harness()
    h.update({ origin: 'backend-a' })
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    h.update({ origin: 'backend-b' })
    await act(async () => h.request.resolve(payload))
    expect(h.editor.restoreDraft).toBeUndefined()
    expect(h.editor.canRestore).toBe(true)
  })

  it('retains content on Composer refusal rather than calling take again', async () => {
    const h = harness()
    act(() => { h.editor.onDraftAvailabilityChange(true); void h.editor.edit('real-id') })
    await act(async () => h.request.resolve(payload))
    const id = h.editor.restoreDraft!.id
    act(() => h.editor.onRestoreDraftConsumed(id, false))
    expect(h.editor.canRestore).toBe(true)
    expect(h.editor.restoreDraft).toBeUndefined()
    expect(h.editQueuedMessage).toHaveBeenCalledTimes(1)
  })
})
