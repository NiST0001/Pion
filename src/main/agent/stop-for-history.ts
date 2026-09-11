import type { ChildProcess } from 'node:child_process'
import type { RpcClient } from '@earendil-works/pi-coding-agent'

const HISTORY_STOP_TIMEOUT_MS = 5000

type HistoryProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once' | 'removeListener'>

/**
 * Private adapter for the lockfile-pinned pi SDK 0.85.1 RpcClient. Its `process`
 * field is ChildProcess | null; stop() sends SIGTERM, then SIGKILL after 1s, but
 * resolves and clears that field without waiting for SIGKILL's actual exit.
 * Like AgentBridge.respondToExtensionUi, this must be reviewed on SDK upgrades.
 * Missing/changed internals must fail closed, not be mistaken for a null handle.
 */
function historyProcess(client: RpcClient): HistoryProcess | null {
  const incompatible = () => new Error('Cannot stop agent for history: incompatible SDK RpcClient process adapter')
  if (!client || typeof client !== 'object' || typeof client.stop !== 'function'
    || !Object.prototype.hasOwnProperty.call(client, 'process')) {
    throw incompatible()
  }
  const child = (client as unknown as { process: unknown }).process
  if (child === null) return null
  if (!child || typeof child !== 'object') throw incompatible()
  const candidate = child as Partial<HistoryProcess>
  if ((candidate.exitCode !== null && !Number.isInteger(candidate.exitCode))
    || (candidate.signalCode !== null && (typeof candidate.signalCode !== 'string' || !candidate.signalCode))
    || typeof candidate.once !== 'function' || typeof candidate.removeListener !== 'function') {
    throw incompatible()
  }
  return candidate as HistoryProcess
}

function hasExited(child: HistoryProcess): boolean {
  return child.exitCode != null || child.signalCode != null
}

/**
 * Only call after the bridge's idle, owner, queue and in-flight gates are held.
 * Success allows the bridge to remove this backend before an exclusive SDK
 * history append. This neither acquires those gates nor changes global shutdown.
 */
export async function stopForHistory(client: RpcClient): Promise<void> {
  // Capture before stop(): rereading client.process afterwards can hide a live
  // process behind the SDK's early null assignment.
  const child = historyProcess(client)
  if (child === null) return

  let timer: ReturnType<typeof setTimeout> | undefined
  let onExit: (() => void) | undefined
  let onError: ((error: Error) => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let exited = false
      let stopped = false
      const finish = () => {
        if (exited && stopped) resolve()
      }
      onExit = () => {
        exited = true
        finish()
      }
      onError = reject
      child.once('exit', onExit)
      child.once('error', onError)
      exited ||= hasExited(child)

      // One deadline bounds BOTH SDK stop() and real exit, even if stop hangs.
      // Timeout/error only reject: they never confer history writer authority.
      timer = setTimeout(() => {
        reject(new Error('Timed out waiting for agent process shutdown; history write is not safe'))
      }, HISTORY_STOP_TIMEOUT_MS)

      // Observe synchronous throws and late rejection as well as early process
      // errors. There is no detached exit promise left to reject unhandled while
      // waiting for stop(), and listeners are installed before stop is invoked.
      void Promise.resolve().then(() => client.stop()).then(() => {
        stopped = true
        exited ||= hasExited(child)
        finish()
      }).catch(reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onExit) child.removeListener('exit', onExit)
    if (onError) child.removeListener('error', onError)
  }
}
