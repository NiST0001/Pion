import type { RpcClient } from '@earendil-works/pi-coding-agent'
import { stopWithProcessExit } from '../process-exit'

/**
 * Only call after the bridge's idle, owner, queue and in-flight gates are held.
 * History callers own an already-started writer: a null SDK handle has no exit
 * receipt. Success requires SDK stop, actual exit and all stdio closes before
 * the caller retires its backend and acquires an exclusive history writer.
 */
export async function stopForHistory(client: RpcClient): Promise<void> {
  await stopWithProcessExit(client, true)
}
