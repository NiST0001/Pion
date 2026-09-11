// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/renderer/src/features/chat/Composer'
import { ConfirmDialog } from '../../src/renderer/src/features/common/ConfirmDialog'
import { useMessageRevert } from '../../src/renderer/src/hooks/useMessageRevert'
import type { MessageRevertResult } from '../../src/shared/types'

type Options = Parameters<typeof useMessageRevert>[0]
const scopeA = '/project\u0000/project/a.jsonl\u0000a'
const scopeB = '/other-project\u0000/other-project/b.jsonl\u0000b'
const reverted: MessageRevertResult = {
  sessionPath: '/project/a.jsonl', sessionId: 'a', entryId: 'selected-user',
  previousLeafId: 'old-leaf', leafId: 'before-user',
  text: '  原文第一行\n第二行\t \n',
  images: [
    { type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=' },
    { type: 'image', mimeType: 'image/jpeg', data: 'c2Vjb25k' },
    { type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=' }
  ]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup(patch: Partial<Options> = {}) {
  const selectionRef = { current: { generation: 0 } }
  const revertMessage = vi.fn<Options['revertMessage']>().mockResolvedValue(reverted)
  let props: Options = { scope: scopeA, selectionRef, disabledReason: undefined, revertMessage, ...patch }
  const hook = renderHook((options: Options) => useMessageRevert(options), { initialProps: props })
  return {
    ...hook, selectionRef, revertMessage,
    update(next: Partial<Options> = {}) {
      props = { ...props, ...next }
      hook.rerender(props)
    }
  }
}

type Harness = ReturnType<typeof setup>
function open(h: Harness, entryId = 'selected-user'): void {
  act(() => {
    h.result.current.onDraftAvailabilityChange(true)
    h.result.current.requestRevert(entryId)
  })
}

function confirm(h: Harness): Promise<void> {
  let promise!: Promise<void>
  act(() => { promise = h.result.current.confirmation.onConfirm() })
  return promise
}

describe('message undo confirmation', () => {
  afterEach(cleanup)

  it('requires an explicit empty report from Composer, including after a selection reset', () => {
    const h = setup()
    expect(h.result.current.canRevert).toBe(false)
    expect(h.result.current.disabledReason).toContain('输入框')
    expect(h.result.current.draftFrozen).toBe(false)
    act(() => h.result.current.requestRevert('selected-user'))
    expect(h.result.current.confirmation.open).toBe(false)

    act(() => h.result.current.onDraftAvailabilityChange(true))
    expect(h.result.current.canRevert).toBe(true)
    expect(h.result.current.disabledReason).toBeUndefined()
    h.update()
    expect(h.result.current.canRevert).toBe(true)
    h.update({ scope: scopeB })
    expect(h.result.current.canRevert).toBe(false)
    expect(h.revertMessage).not.toHaveBeenCalled()
  })

  it('supplies ConfirmDialog props that explain before-message, branch preservation and no file rollback; cancel is inert', () => {
    const h = setup()
    open(h)
    const oldConfirm = h.result.current.confirmation.onConfirm
    const view = render(<ConfirmDialog {...h.result.current.confirmation} />)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('所选用户消息之前')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('文字和图片恢复到输入框')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('所选消息及之后的全部对话仍保留在原分支')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('这不是文件回滚，不会改动项目文件')
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.canRevert).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    view.rerender(<ConfirmDialog {...h.result.current.confirmation} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.result.current.canRevert).toBe(true)
    expect(h.revertMessage).not.toHaveBeenCalled()

    // A queued click from the cancelled dialog cannot act on a later request.
    act(() => h.result.current.requestRevert('another-user'))
    act(() => { void oldConfirm() })
    expect(h.revertMessage).not.toHaveBeenCalled()
    expect(h.result.current.confirmation.open).toBe(true)
  })

  it.each(['existing text', 'whitespace-only text', 'image-only draft', 'pending clipboard/file read'])(
    'uses Composer availability for %s and invalidates it before React commits', async () => {
      const h = setup()
      // The hook intentionally receives only this boolean, never trimmed text.
      act(() => h.result.current.onDraftAvailabilityChange(true))
      act(() => {
        h.result.current.onDraftAvailabilityChange(false)
        h.result.current.requestRevert('selected-user')
      })
      expect(h.result.current.canRevert).toBe(false)
      expect(h.result.current.confirmation.open).toBe(false)
      open(h)
      const onConfirm = h.result.current.confirmation.onConfirm
      await act(async () => {
        h.result.current.onDraftAvailabilityChange(false)
        await onConfirm()
      })
      expect(h.revertMessage).not.toHaveBeenCalled()
      expect(h.result.current.confirmation.open).toBe(true)
      expect(h.result.current.confirmation.detail).toContain('输入框')
      expect(h.result.current.draftFrozen).toBe(false)
    }
  )

  it('rechecks the latest disabled reason and action without invalidating an open dialog on ordinary snapshots', async () => {
    const h = setup({ disabledReason: '等待会话就绪' })
    open(h)
    expect(h.result.current.disabledReason).toBe('等待会话就绪')
    expect(h.result.current.confirmation.open).toBe(false)
    h.update({ disabledReason: undefined })
    act(() => h.result.current.requestRevert('selected-user'))
    const oldConfirm = h.result.current.confirmation.onConfirm
    const replacement = vi.fn<Options['revertMessage']>().mockResolvedValue(reverted)
    h.update({ disabledReason: '请等待会话空闲', revertMessage: replacement })
    expect(h.result.current.confirmation.open).toBe(true)
    await act(async () => { await oldConfirm() })
    expect(h.result.current.confirmation.detail).toContain('请等待会话空闲')
    expect(replacement).not.toHaveBeenCalled()
    expect(h.revertMessage).not.toHaveBeenCalled()
    h.update({ disabledReason: undefined })
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    expect(replacement).toHaveBeenCalledExactlyOnceWith('selected-user')
    expect(h.result.current.restoreDraft?.text).toBe(reverted.text)
  })

  it('guards repeated requests, double confirms and cancellation synchronously before the API settles', async () => {
    const api = deferred<MessageRevertResult | null>()
    const h = setup()
    h.revertMessage.mockReturnValueOnce(api.promise)
    act(() => {
      h.result.current.onDraftAvailabilityChange(true)
      h.result.current.requestRevert('selected-user')
      h.result.current.requestRevert('wrong-user')
    })
    const callbacks = h.result.current.confirmation
    let first!: Promise<void>, second!: Promise<void>
    act(() => {
      first = callbacks.onConfirm()
      second = callbacks.onConfirm()
      callbacks.onCancel()
      h.result.current.requestRevert('wrong-user')
    })
    expect(h.revertMessage).toHaveBeenCalledExactlyOnceWith('selected-user')
    expect(h.result.current.confirmation).toMatchObject({ open: true, busy: true })
    expect(h.result.current.draftFrozen).toBe(true)
    expect(h.result.current.canRevert).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    const dialog = render(<ConfirmDialog {...h.result.current.confirmation} />)
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(h.result.current.confirmation.open).toBe(true)
    dialog.unmount()
    await act(async () => { api.resolve(reverted); await Promise.all([first, second]) })
    expect(h.result.current.draftFrozen).toBe(true)
    act(() => callbacks.onCancel())
    expect(h.result.current.restoreDraft).toBeDefined()
    expect(h.result.current.confirmation.open).toBe(true)
  })

  it.each([
    ['an Error rejection', new Error('branch changed')],
    ['a non-Error rejection', 'backend unavailable']
  ])('exposes %s without an unhandled rejection, releases drafting and allows retry', async (_label, failure) => {
    const api = deferred<MessageRevertResult | null>()
    const h = setup()
    h.revertMessage.mockReturnValueOnce(api.promise)
    open(h)
    const action = confirm(h)
    await act(async () => { api.reject(failure); await expect(action).resolves.toBeUndefined() })
    expect(h.result.current.confirmation).toMatchObject({ open: true, busy: false })
    expect(h.result.current.confirmation.detail).toContain(failure instanceof Error ? failure.message : failure)
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    expect(h.revertMessage).toHaveBeenCalledTimes(2)
    expect(h.result.current.restoreDraft?.text).toBe(reverted.text)
  })

  it('handles synchronous action errors and null results as failures rather than restoration', async () => {
    const h = setup()
    h.revertMessage.mockImplementationOnce(() => { throw new Error('not ready') }).mockResolvedValueOnce(null)
    open(h)
    await act(async () => { await expect(h.result.current.confirmation.onConfirm()).resolves.toBeUndefined() })
    expect(h.result.current.confirmation.detail).toContain('not ready')
    expect(h.result.current.draftFrozen).toBe(false)
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    expect(h.result.current.confirmation.detail).toContain('未能撤销消息')
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    act(() => h.result.current.confirmation.onCancel())
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.canRevert).toBe(true)
  })
})

describe('Composer restoration handoff', () => {
  afterEach(cleanup)

  it('keeps exact text and attachments frozen until the matching one-shot acknowledgement, regardless of readiness snapshots', async () => {
    const api = deferred<MessageRevertResult | null>()
    const h = setup()
    h.revertMessage.mockReturnValueOnce(api.promise)
    open(h)
    const action = confirm(h)
    h.update({ disabledReason: '会话正在启动' })
    expect(h.result.current.confirmation).toMatchObject({ open: true, busy: true })
    expect(h.result.current.draftFrozen).toBe(true)
    // Successful mutation and a failed/incomplete UI refresh are independent.
    // Only the action reloads history; its successful reply still restores.
    await act(async () => { api.resolve(reverted); await action })
    const draft = h.result.current.restoreDraft!
    expect(draft).toEqual({ id: expect.any(String), text: reverted.text, images: reverted.images })
    expect(draft.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(h.result.current.draftFrozen).toBe(true)
    expect(h.result.current.confirmation.busy).toBe(true)
    h.update({ disabledReason: undefined })
    expect(h.result.current.restoreDraft).toBe(draft)
    act(() => h.result.current.onRestoreDraftConsumed('wrong-id', true))
    expect(h.result.current.draftFrozen).toBe(true)
    act(() => h.result.current.onRestoreDraftConsumed(draft.id, true))
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.result.current.canRevert).toBe(false)
    act(() => h.result.current.onRestoreDraftConsumed(draft.id, false))
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.revertMessage).toHaveBeenCalledTimes(1)
  })

  it('integrates with the real Composer: whitespace blocks undo, and restored text/images survive without remounting', async () => {
    const api = deferred<MessageRevertResult | null>()
    const h = setup()
    h.revertMessage.mockReturnValueOnce(api.promise)
    const onSend = vi.fn()
    const composer = () => <Composer
      busy={false} disabled={h.result.current.draftFrozen} sendDisabled={false}
      prefill="" history={[]} commands={[]} mode="build"
      onModeChange={() => undefined} onSend={onSend} onQueue={() => undefined} onAbort={() => undefined}
      restoreDraft={h.result.current.restoreDraft}
      onDraftAvailabilityChange={h.result.current.onDraftAvailabilityChange}
      onRestoreDraftConsumed={h.result.current.onRestoreDraftConsumed}
    />
    const view = render(composer())
    const input = screen.getByRole('textbox')
    expect(h.result.current.canRevert).toBe(true)
    fireEvent.change(input, { target: { value: '  \n\t ' } })
    expect(h.result.current.canRevert).toBe(false)
    act(() => h.result.current.requestRevert('selected-user'))
    expect(h.result.current.confirmation.open).toBe(false)
    fireEvent.change(input, { target: { value: '' } })
    expect(h.result.current.canRevert).toBe(true)
    act(() => h.result.current.requestRevert('selected-user'))
    const action = confirm(h)
    view.rerender(composer())
    expect(input).toBeDisabled()
    await act(async () => { api.resolve(reverted); await action })
    expect(h.result.current.draftFrozen).toBe(true)
    view.rerender(composer())
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    view.rerender(composer())
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input).toBeEnabled()
    expect(input).toHaveValue(reverted.text)
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.getByAltText('待发送图像 2')).toHaveAttribute('src', `data:image/jpeg;base64,${reverted.images[1].data}`)
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.canRevert).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith(reverted.text, reverted.images)
    expect(h.result.current.canRevert).toBe(true)
    expect(h.revertMessage).toHaveBeenCalledExactlyOnceWith('selected-user')
  })

  it('retains a refused result and retries only restoration with a fresh id after an explicit empty report', async () => {
    const h = setup()
    open(h)
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    const first = h.result.current.restoreDraft!
    act(() => h.result.current.onRestoreDraftConsumed(first.id, false))
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.confirmation).toMatchObject({ open: true, busy: false, cancelLabel: '关闭' })
    expect(h.result.current.confirmation.detail).toContain('未覆盖现有草稿')
    expect(h.result.current.confirmation.message).toContain('不会再次更改会话')
    expect(h.result.current.canRevert).toBe(false)
    act(() => h.result.current.requestRevert('different-user'))
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.revertMessage).toHaveBeenCalledTimes(1)

    act(() => h.result.current.onDraftAvailabilityChange(true))
    h.update({ disabledReason: '历史暂未就绪' })
    expect(h.result.current.restoreDraft).toBeUndefined() // Never an automatic overwrite.
    const retry = h.result.current.confirmation.onConfirm
    await act(async () => { await Promise.all([retry(), retry()]) })
    const second = h.result.current.restoreDraft!
    expect(second).toEqual({ ...first, id: expect.any(String) })
    expect(second.id).not.toBe(first.id)
    expect(h.result.current.draftFrozen).toBe(true)
    expect(h.revertMessage).toHaveBeenCalledTimes(1)
    act(() => h.result.current.onRestoreDraftConsumed(first.id, true))
    expect(h.result.current.restoreDraft).toBe(second)
    act(() => h.result.current.onRestoreDraftConsumed(second.id, true))
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.revertMessage).toHaveBeenCalledTimes(1)
  })

  it('can close a refused restoration without another history mutation or reviving its consumed id', async () => {
    const h = setup()
    open(h)
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    const draft = h.result.current.restoreDraft!
    act(() => h.result.current.onRestoreDraftConsumed(draft.id, false))
    const oldRetry = h.result.current.confirmation.onConfirm
    act(() => h.result.current.confirmation.onCancel())
    act(() => {
      h.result.current.onDraftAvailabilityChange(true)
      h.result.current.onRestoreDraftConsumed(draft.id, true)
    })
    await act(async () => { await oldRetry() })
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.canRevert).toBe(true)
    expect(h.revertMessage).toHaveBeenCalledTimes(1)
  })
})

describe('selection isolation', () => {
  afterEach(cleanup)

  it.each(['scope', 'generation'] as const)('invalidates a pending dialog on a %s change and ignores old Composer callbacks', async (change) => {
    const h = setup()
    open(h)
    const old = h.result.current
    if (change === 'generation') h.selectionRef.current.generation += 1
    h.update(change === 'scope' ? { scope: scopeB } : {})
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.canRevert).toBe(false)
    act(() => {
      old.onDraftAvailabilityChange(true)
      old.requestRevert('old-user')
    })
    await act(async () => { await old.confirmation.onConfirm() })
    expect(h.result.current.canRevert).toBe(false)
    expect(h.revertMessage).not.toHaveBeenCalled()
    open(h, 'new-user')
    act(() => old.confirmation.onCancel())
    expect(h.result.current.confirmation.open).toBe(true)
  })

  it('rechecks synchronous selection intent before confirmation, including A -> B -> A before React renders', async () => {
    const h = setup()
    open(h)
    const oldConfirm = h.result.current.confirmation.onConfirm
    h.selectionRef.current.generation += 2
    await act(async () => { await oldConfirm() })
    expect(h.revertMessage).not.toHaveBeenCalled()
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.canRevert).toBe(false)
    expect(h.result.current.draftFrozen).toBe(false)
  })

  it.each(['rendered scope round-trip', 'synchronous generation round-trip'] as const)(
    'drops a late success after a %s', async (change) => {
      const h = setup()
      const api = deferred<MessageRevertResult | null>()
      h.revertMessage.mockReturnValueOnce(api.promise)
      open(h)
      const action = confirm(h)
      if (change === 'rendered scope round-trip') {
        h.update({ scope: scopeB })
        h.update({ scope: scopeA })
      } else {
        h.selectionRef.current.generation += 2
      }
      await act(async () => { api.resolve(reverted); await action })
      expect(h.result.current.restoreDraft).toBeUndefined()
      expect(h.result.current.confirmation.open).toBe(false)
      expect(h.result.current.draftFrozen).toBe(false)
      expect(h.result.current.canRevert).toBe(false)
      expect(h.revertMessage).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['success', 'failure'] as const)('does not let an old API %s clear a new session commit or inject its draft', async (outcome) => {
    const h = setup()
    const oldApi = deferred<MessageRevertResult | null>()
    const newApi = deferred<MessageRevertResult | null>()
    h.revertMessage.mockReturnValueOnce(oldApi.promise).mockReturnValueOnce(newApi.promise)
    open(h)
    const oldAction = confirm(h)
    h.selectionRef.current.generation += 1
    h.update({ scope: scopeB })
    open(h, 'b-user')
    const newAction = confirm(h)
    await act(async () => {
      if (outcome === 'success') oldApi.resolve(reverted)
      else oldApi.reject(new Error('old session failure'))
      await oldAction
    })
    expect(h.result.current.confirmation).toMatchObject({ open: true, busy: true })
    expect(h.result.current.confirmation.detail).not.toContain('old session failure')
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.result.current.draftFrozen).toBe(true)
    const newResult = { ...reverted, sessionPath: '/other-project/b.jsonl', sessionId: 'b', entryId: 'b-user', text: 'B only' }
    await act(async () => { newApi.resolve(newResult); await newAction })
    expect(h.result.current.restoreDraft?.text).toBe('B only')
    expect(h.revertMessage.mock.calls).toEqual([['selected-user'], ['b-user']])
  })

  it('drops a delivered draft and refuses late acknowledgements when selection intent changes before Composer consumes it', async () => {
    const h = setup()
    open(h)
    await act(async () => { await h.result.current.confirmation.onConfirm() })
    const old = h.result.current
    const id = old.restoreDraft!.id
    h.selectionRef.current.generation += 1
    act(() => old.onRestoreDraftConsumed(id, true))
    expect(h.result.current.restoreDraft).toBeUndefined()
    expect(h.result.current.confirmation.open).toBe(false)
    expect(h.result.current.draftFrozen).toBe(false)
    expect(h.result.current.canRevert).toBe(false)
    open(h, 'new-user')
    act(() => old.onRestoreDraftConsumed(id, false))
    expect(h.result.current.confirmation.open).toBe(true)
    expect(h.result.current.confirmation.detail).not.toContain('未覆盖现有草稿')
  })

  it.each(['success', 'failure'] as const)('suppresses late %s after unmount without rejecting its event handler', async (outcome) => {
    const h = setup()
    const api = deferred<MessageRevertResult | null>()
    h.revertMessage.mockReturnValueOnce(api.promise)
    open(h)
    const action = confirm(h)
    h.unmount()
    if (outcome === 'success') api.resolve(reverted)
    else api.reject(new Error('unmounted'))
    await expect(action).resolves.toBeUndefined()
    expect(h.result.current.restoreDraft).toBeUndefined()
  })
})
