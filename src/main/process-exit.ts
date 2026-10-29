import type { ChildProcess } from 'node:child_process'
import type { RpcClient } from '@earendil-works/pi-coding-agent'

const PROCESS_STOP_TIMEOUT_MS = 5_000
type ProcessHandle = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once' | 'removeListener'> & {
  readonly stdio: ReadonlyArray<{ readonly closed: boolean }>
}

/**
 * Private adapter for pinned pi SDK 1.4.0: start() assigns a ChildProcess with
 * exactly three pipes; stop() may clear it before SIGKILL's actual exit.
 * Re-review this layout and Node pipe close semantics on SDK upgrades.
 */
function processHandle(client: RpcClient): ProcessHandle | null {
  const incompatible = (): Error => new Error('incompatible SDK RpcClient process/stdio adapter')
  if (!client || typeof client !== 'object' || typeof client.stop !== 'function'
    || !Object.prototype.hasOwnProperty.call(client, 'process')) throw incompatible()
  const child = (client as unknown as { process: unknown }).process
  if (child === null) return null
  if (!child || typeof child !== 'object') throw incompatible()
  const value = child as Partial<ProcessHandle>
  if ((value.exitCode !== null && !Number.isInteger(value.exitCode))
    || (value.signalCode !== null && (typeof value.signalCode !== 'string' || !value.signalCode))
    || typeof value.once !== 'function' || typeof value.removeListener !== 'function'
    || !Array.isArray(value.stdio) || value.stdio.length !== 3
    || Array.from(value.stdio).some((stream) => !stream || typeof stream.closed !== 'boolean')) throw incompatible()
  return value as ProcessHandle
}

/**
 * Capture before SDK stop clears its handle. Success requires SDK stop, real
 * exit and all pipe closes. A deadline/error only rejects; callers retain their
 * reservation on unknown cleanup, including after a later close notification.
 * Pass started=false only with independent proof start never created a child;
 * null after a started/unknown writer is never an exit receipt.
 */
export async function stopWithProcessExit(client: RpcClient, started: boolean): Promise<void> {
  const child = processHandle(client)
  if (child === null && started !== false) throw new Error('Agent process handle missing after start; shutdown is unknown')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onExit!: () => void
  let onClose!: () => void
  let onError!: (error: Error) => void
  try {
    await new Promise<void>((resolve, reject) => {
      let stopped = false
      let exited = child === null || child.exitCode !== null || child.signalCode !== null
      let closed = child === null || child.stdio.every((stream) => stream.closed)
      const finish = (): void => { if (stopped && exited && closed) resolve() }
      onExit = () => { exited = true; finish() }
      onClose = () => { closed = true; finish() }
      onError = reject
      child?.once('exit', onExit)
      child?.once('close', onClose)
      child?.once('error', onError)
      timer = setTimeout(() => reject(new Error('Timed out waiting for Agent process exit and stdio close')), PROCESS_STOP_TIMEOUT_MS)
      void Promise.resolve().then(() => client.stop()).then(() => {
        stopped = true
        exited ||= child === null || child.exitCode !== null || child.signalCode !== null
        closed ||= child === null || child.stdio.every((stream) => stream.closed)
        finish()
      }).catch(reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    child?.removeListener('exit', onExit)
    child?.removeListener('close', onClose)
    child?.removeListener('error', onError)
  }
}
