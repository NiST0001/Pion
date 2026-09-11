import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { MessageRevertResult } from '../../../shared/types'

interface UseMessageRevertOptions {
  scope: string
  selectionRef: MutableRefObject<{ generation: number }>
  disabledReason: string | undefined
  revertMessage: (entryId: string) => Promise<MessageRevertResult | null>
}

type RestoredDraft = Pick<MessageRevertResult, 'text' | 'images'> & { id: string }

type PendingRevert = {
  entryId: string
  phase: 'confirm' | 'committing' | 'restoring' | 'restore-refused'
  result?: MessageRevertResult
  restoreDraft?: RestoredDraft
  error?: string
}

type Interaction = {
  scope: string
  generation: number
  selectionRef: UseMessageRevertOptions['selectionRef']
  draftAvailable: boolean
  pending: PendingRevert | null
}

const DRAFT_UNAVAILABLE = '请先清空输入框草稿和附件，并等待内容读取完成'
const HISTORY_DETAIL = '所选消息及之后的全部对话仍保留在原分支。这不是文件回滚，不会改动项目文件。'
const RESTORE_REFUSED = '输入框已有草稿、附件或正在读取内容，未覆盖现有草稿。请清空后重试恢复；关闭将放弃本次草稿恢复。'

/** Coordinate confirmation and one-shot Composer delivery, never file rollback. */
export function useMessageRevert({ scope, selectionRef, disabledReason, revertMessage }: UseMessageRevertOptions) {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0)
  const mounted = useRef(true)
  const options = useRef({ disabledReason, revertMessage })
  options.current = { disabledReason, revertMessage }
  const current = useRef<Interaction | null>(null)

  // A per-selection identity also distinguishes A -> B -> A. Ordinary busy,
  // starting or history-loading snapshots must not discard a committed result.
  if (!current.current || current.current.scope !== scope
    || current.current.selectionRef !== selectionRef
    || current.current.generation !== selectionRef.current.generation) {
    current.current = {
      scope, selectionRef, generation: selectionRef.current.generation,
      draftAvailable: false, pending: null
    }
  }
  const interaction = current.current
  const pending = interaction.pending

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const isCurrent = useCallback((): boolean => {
    if (!mounted.current || current.current !== interaction) return false
    if (interaction.generation === interaction.selectionRef.current.generation) return true
    // Selection intent is synchronous in useAgent, ahead of React's snapshot.
    // Even a late API reply with no intervening render must release the old UI.
    interaction.draftAvailable = false
    interaction.pending = null
    refresh()
    return false
  }, [interaction])

  const onDraftAvailabilityChange = useCallback((available: boolean): void => {
    if (!isCurrent() || interaction.draftAvailable === available) return
    // Do not wait for an effect: typing, whitespace, attachment changes and
    // asynchronous reads can race a confirmation in the same React batch.
    interaction.draftAvailable = available
    refresh()
  }, [interaction, isCurrent])

  const requestRevert = useCallback((entryId: string): void => {
    if (!isCurrent() || !entryId || interaction.pending
      || options.current.disabledReason !== undefined || !interaction.draftAvailable) return
    // The dialog's callbacks retain this interaction's scope and generation.
    interaction.pending = { entryId, phase: 'confirm' }
    refresh()
  }, [interaction, isCurrent])

  const onConfirm = useCallback(async (): Promise<void> => {
    if (!isCurrent() || !pending || interaction.pending !== pending
      || pending.phase === 'committing' || pending.phase === 'restoring') return

    // Once committed, this button can ONLY retry draft delivery. Backend
    // readiness changes no longer matter, but Composer must report empty.
    const reason = (pending.result ? undefined : options.current.disabledReason)
      ?? (interaction.draftAvailable ? undefined : DRAFT_UNAVAILABLE)
    if (reason !== undefined) {
      pending.error = pending.result ? `${RESTORE_REFUSED} ${reason}` : reason
      refresh()
      return
    }

    try {
      if (!pending.result) {
        // Ref state is the duplicate guard, set before invoking or awaiting API.
        pending.phase = 'committing'
        pending.error = undefined
        refresh()
        const result = await options.current.revertMessage(pending.entryId)
        if (!isCurrent() || interaction.pending !== pending) return
        if (!result) {
          pending.phase = 'confirm'
          pending.error = '未能撤销消息，请确认当前会话后重试。'
          refresh()
          return
        }
        pending.result = result
      }

      // The action owns history hydration and returns success even if refreshing
      // its UI failed. Preserve exact text, image order and duplicate images.
      pending.restoreDraft = {
        id: globalThis.crypto.randomUUID(),
        text: pending.result.text,
        images: pending.result.images.map((image) => ({ ...image }))
      }
      pending.phase = 'restoring'
      pending.error = undefined
      interaction.draftAvailable = false
      refresh()
    } catch (error) {
      if (!isCurrent() || interaction.pending !== pending) return
      pending.phase = pending.result ? 'restore-refused' : 'confirm'
      pending.restoreDraft = undefined
      const message = error instanceof Error ? error.message : String(error)
      pending.error = pending.result
        ? `消息已撤销，但草稿恢复失败：${message}。重试只恢复草稿，也可关闭。`
        : `撤销失败：${message}`
      refresh()
    }
  }, [interaction, isCurrent, pending])

  const onRestoreDraftConsumed = useCallback((id: string, restored: boolean): void => {
    if (!isCurrent()) return
    const request = interaction.pending
    if (!request || request.phase !== 'restoring' || request.restoreDraft?.id !== id) return
    interaction.draftAvailable = false
    if (restored) {
      interaction.pending = null
    } else {
      // Composer consumes a refused id too. Keep the successful result, not
      // that id, and unfreeze so the existing draft can be kept or cleared.
      request.phase = 'restore-refused'
      request.restoreDraft = undefined
      request.error = RESTORE_REFUSED
    }
    refresh()
  }, [interaction, isCurrent])

  const onCancel = useCallback((): void => {
    if (!isCurrent() || !pending || interaction.pending !== pending
      || pending.phase === 'committing' || pending.phase === 'restoring') return
    interaction.pending = null
    refresh()
  }, [interaction, isCurrent, pending])

  const busy = pending?.phase === 'committing' || pending?.phase === 'restoring'
  const reason = disabledReason ?? (busy ? '正在撤销或恢复消息'
    : pending ? '请先处理当前撤销'
      : interaction.draftAvailable ? undefined : DRAFT_UNAVAILABLE)

  return {
    canRevert: reason === undefined,
    disabledReason: reason,
    requestRevert,
    draftFrozen: busy,
    restoreDraft: pending?.restoreDraft,
    onDraftAvailabilityChange,
    onRestoreDraftConsumed,
    confirmation: {
      open: pending !== null,
      title: pending?.result ? '恢复撤销的消息' : '撤销这条消息？',
      message: pending?.result
        ? '消息已撤销。重试只恢复该消息的文字和图片，不会再次更改会话。'
        : '将会话回到所选用户消息之前，并将该消息的文字和图片恢复到输入框。',
      detail: pending?.error ? `${HISTORY_DETAIL}\n${pending.error}` : HISTORY_DETAIL,
      confirmLabel: pending?.result ? '重试恢复草稿' : '撤销并恢复到输入框',
      cancelLabel: pending?.result ? '关闭' : '取消',
      busy,
      onConfirm,
      onCancel
    }
  }
}
