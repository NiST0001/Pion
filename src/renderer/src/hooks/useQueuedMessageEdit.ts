import { useCallback, useReducer, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { QueuedMessageEditResult } from '../../../shared/types'

type Draft = QueuedMessageEditResult & { id: string }
type Slot = {
  generation: number
  runId: string
  pending: boolean
  origin?: string
  draft?: Draft
  offered?: boolean
  error?: string
}
interface Options {
  scope: string
  selectionRef: MutableRefObject<{ generation: number }>
  disabled: boolean
  validOwner?: () => boolean
  origin?: string
  editQueuedMessage: (runId: string) => Promise<QueuedMessageEditResult>
}
const MAX_RETAINED_EDITS = 8
const DRAFT_BUSY = '请先清空输入框草稿和附件，并等待图片读取完成，再编辑排队消息。'

/** Retain taken content until Composer acknowledges it; never overwrite a draft or a new selection. */
export function useQueuedMessageEdit(options: Options) {
  const [, refresh] = useReducer(n => n + 1, 0)
  const latest = useRef(options)
  latest.current = options
  const available = useRef(false)
  const slots = useRef(new Map<string, Slot>())
  const notice = useRef<string | undefined>(undefined)
  const closing = useRef<{ scope: string; generation: number; slot: Slot } | undefined>(undefined)
  const current = slots.current.get(options.scope)

  const onDraftAvailabilityChange = useCallback((empty: boolean) => { available.current = empty }, [])
  const edit = useCallback(async (runId: string): Promise<void> => {
    const captured = latest.current
    const previous = slots.current.get(captured.scope)
    if (captured.disabled || captured.validOwner?.() === false || !available.current
      || previous?.pending || previous?.draft || (previous?.error && previous.runId !== runId)) {
      notice.current = DRAFT_BUSY
      refresh()
      return
    }
    if (!previous && slots.current.size >= MAX_RETAINED_EDITS) {
      notice.current = '请先恢复已取回的排队草稿，再编辑更多会话。'
      refresh()
      return
    }
    const slot: Slot = { generation: captured.selectionRef.current.generation,
      runId, origin: captured.origin, pending: true }
    slots.current.set(captured.scope, slot)
    notice.current = undefined
    refresh()
    try {
      const result = await captured.editQueuedMessage(runId)
      if (result.runId !== runId) throw new Error('取回消息身份不匹配，请重试原条目；未恢复当前草稿')
      slot.pending = false
      slot.draft = { ...result, images: result.images.map(image => ({ ...image })), id: crypto.randomUUID() }
      const owner = latest.current
      slot.offered = owner.scope === captured.scope
        && owner.selectionRef === captured.selectionRef
        && owner.selectionRef.current.generation === slot.generation
        && owner.origin === slot.origin && owner.validOwner?.() !== false
        && !owner.disabled && available.current
      if (!slot.offered) slot.error = '排队内容已取回并保留；未覆盖当前草稿。请在原会话恢复编辑内容。'
    } catch (error) {
      slot.pending = false
      slot.error = error instanceof Error ? error.message : String(error)
    }
    refresh()
  }, [])

  const restoreRetained = useCallback(() => {
    const owner = latest.current
    const slot = slots.current.get(owner.scope)
    if (!slot?.draft || slot.pending || owner.disabled || owner.validOwner?.() === false || !available.current) {
      notice.current = DRAFT_BUSY
      refresh()
      return
    }
    slot.generation = owner.selectionRef.current.generation
    slot.origin = owner.origin
    slot.draft = { ...slot.draft, id: crypto.randomUUID() }
    slot.offered = true
    slot.error = undefined
    notice.current = undefined
    refresh()
  }, [])

  const onRestoreDraftConsumed = useCallback((id: string, restored: boolean) => {
    const owner = latest.current
    const slot = slots.current.get(owner.scope)
    if (slot?.draft?.id !== id) return
    if (restored && owner.selectionRef.current.generation === slot.generation) {
      slots.current.delete(owner.scope)
      notice.current = undefined
    } else {
      slot.offered = false
      slot.error = '排队内容已取回并保留；输入框已有内容或会话已切换，未覆盖草稿。'
    }
    refresh()
  }, [])

  const requestClose = useCallback(() => {
    const owner = latest.current
    const slot = slots.current.get(owner.scope)
    if (!slot || slot.pending) return
    closing.current = { scope: owner.scope, generation: owner.selectionRef.current.generation, slot }
    refresh()
  }, [])
  const close = useCallback(() => {
    const captured = closing.current
    const owner = latest.current
    if (!captured || captured.scope !== owner.scope
      || captured.generation !== owner.selectionRef.current.generation
      || slots.current.get(captured.scope) !== captured.slot || captured.slot.pending) return
    slots.current.delete(captured.scope)
    closing.current = undefined
    notice.current = undefined
    refresh()
  }, [])
  const cancelClose = useCallback(() => { closing.current = undefined; refresh() }, [])
  const offeredDraft = current?.draft
  const offerGeneration = current?.generation
  const offerOrigin = current?.origin
  const eligible = offerGeneration === options.selectionRef.current.generation
    && offerOrigin === options.origin && options.validOwner?.() !== false && !options.disabled
  return {
    edit,
    onDraftAvailabilityChange,
    onRestoreDraftConsumed,
    restoreRetained,
    requestClose,
    canClose: Boolean(current && !current.pending && !current.offered),
    closeConfirmation: {
      open: closing.current?.scope === options.scope
        && closing.current?.generation === options.selectionRef.current.generation,
      title: '放弃本次排队编辑取回？',
      message: '这将关闭当前取回入口并丢弃其内存草稿，不会重发原消息。',
      detail: '若取回结果未确认，原消息可能已移出队列。仍需编辑时请取消并重试取回。',
      confirmLabel: '放弃本次取回', cancelLabel: '保留', onConfirm: close, onCancel: cancelClose
    },
    retry: () => current && edit(current.runId),
    canRetry: Boolean(current?.error && !current.pending && !current.draft),
    frozen: Boolean(current?.pending || (current?.offered && eligible)),
    restoreDraft: current?.offered && eligible && current.draft ? {
      ...current.draft,
      valid: () => latest.current.scope === options.scope
        && latest.current.selectionRef === options.selectionRef
        && latest.current.selectionRef.current.generation === offerGeneration
        && latest.current.origin === offerOrigin && current.origin === offerOrigin
        && latest.current.validOwner?.() !== false
        && current.generation === offerGeneration && current.draft?.id === offeredDraft?.id
        && !latest.current.disabled && slots.current.get(options.scope) === current && !!current.offered
    } : undefined,
    canRestore: Boolean(current?.draft && (!current.offered || !eligible)),
    error: current?.error ?? (current?.draft && !eligible
      ? '编辑内容已保留，请在原会话恢复到空输入框。' : notice.current)
  }
}
