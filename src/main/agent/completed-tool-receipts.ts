import type { BackendRecord } from './types'
import type { ToolReceiptArchive } from './tool-receipt-archive'

export function reclaimCompletedToolReceipts(
  receipts: NonNullable<BackendRecord['nativeToolReceipts']>,
  scopeId: string,
  archive: ToolReceiptArchive
): number {
  const retained = new Set<string>()
  const pending: string[] = []
  for (const [id, receipt] of receipts) {
    if (receipt.state !== 'ended' || !receipt.usageConsumed || receipt.computerUseSource) pending.push(id)
  }
  // Keep the complete parent/root dependency closure of every live receipt.
  while (pending.length) {
    const id = pending.pop()!
    if (retained.has(id)) continue
    retained.add(id)
    const receipt = receipts.get(id)
    if (!receipt) continue
    if (receipt.parentId) pending.push(receipt.parentId)
    pending.push(receipt.rootId)
  }
  const completed: string[] = []
  for (const id of receipts.keys()) {
    if (!retained.has(id)) completed.push(id)
  }
  if (!completed.length) return 0
  // Publish replay protection for the entire batch before releasing any proof.
  archive.remember(scopeId, completed)
  for (const id of completed) receipts.delete(id)
  return completed.length
}
