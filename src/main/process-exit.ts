import type { ChildProcess } from 'node:child_process'
import type { RpcClient } from '@earendil-works/pi-coding-agent'

const PROCESS_STOP_TIMEOUT_MS = 5_000
type ProcessHandle = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once' | 'removeListener'> & {
  readonly stdio: ReadonlyArray<{ readonly closed: boolean }>
}
type StopResult = { ok: true } | { ok: false; error: unknown }
type ProcessStop = {
  /** Undefined records a failed capture, so a later start cannot erase unknown ownership. */
  child: ProcessHandle | null | undefined
  promise: Promise<void>
  result?: StopResult
  waiters: Set<(result: StopResult) => void>
}
const processStops = new WeakMap<RpcClient, ProcessStop>()

class ProcessExitError extends Error {
  readonly closeUnknown = true

  constructor(message: string, readonly cause?: unknown) { super(message) }
}

function unknownClose(error: unknown): ProcessExitError {
  return error instanceof ProcessExitError ? error
    : new ProcessExitError(error instanceof Error ? error.message : String(error), error)
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

/** Before each SDK start, use the same client/adapter identity passed to the stop helpers. */
export function prepareProcessStart(client: RpcClient): void {
  const previous = processStops.get(client)
  if (previous && !previous.result?.ok) {
    throw new ProcessExitError('Agent process shutdown is still unconfirmed before start')
  }
  // SDK stop clears process to null. Retire its receipt before another start so
  // a missing new handle can never inherit the previous child's successful exit.
  processStops.delete(client)
}

/**
 * Shared, deadline-free SDK stop/exit/stdio barrier for this client's captured
 * child. A UI timeout leaves this promise and its listeners alive. Callers may
 * release their reservation only after this barrier and their own RPCs settle.
 * Pass started=false only with independent proof start never created a child;
 * a missing started writer handle requires an existing captured-child barrier.
 */
export function stopWithProcessExitBarrier(client: RpcClient, started: boolean): Promise<void> {
  let previous: ProcessStop | undefined
  try {
    previous = processStops.get(client)
    if (previous && previous.child === undefined) return previous.promise
    const child = processHandle(client)
    if (previous && (child === previous.child || child === null && previous.child !== null)) {
      if (child === null && previous.child === null && started !== false) {
        throw new Error('Agent process handle missing after start; shutdown is unknown')
      }
      return previous.promise
    }
    if (previous && !previous.result?.ok) throw new Error('Agent process changed while shutdown is unconfirmed')
    if (child === null && started !== false) throw new Error('Agent process handle missing after start; shutdown is unknown')
    return retainProcessStop(client, child, stopCapturedProcess(client, child))
  } catch (error) {
    const rejected = Promise.reject(unknownClose(error))
    // Failed capture has no child receipt to retry against. Keep that failure
    // weakly keyed as well; prepareProcessStart must preserve its admission gate.
    if (client && typeof client === 'object' && (!previous || previous.result?.ok)) {
      return retainProcessStop(client, undefined, rejected)
    }
    return rejected
  }
}

function retainProcessStop(client: RpcClient, child: ProcessStop['child'], promise: Promise<void>): Promise<void> {
  const state: ProcessStop = {
    child, promise: promise.catch((error: unknown) => { throw unknownClose(error) }), waiters: new Set()
  }
  processStops.set(client, state)
  const finish = (result: StopResult): void => {
    state.result = result
    for (const waiter of state.waiters) waiter(result)
    state.waiters.clear()
  }
  void state.promise.then(() => finish({ ok: true }), error => finish({ ok: false, error }))
  return state.promise
}

async function stopCapturedProcess(client: RpcClient, child: ProcessHandle | null): Promise<void> {
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
      void Promise.resolve().then(() => {
        if (processHandle(client) !== child) throw new Error('Agent process changed before SDK stop')
        return client.stop()
      }).then(() => {
        const current = processHandle(client)
        if (current !== null && current !== child) throw new Error('Agent process changed during SDK stop')
        stopped = true
        exited ||= child === null || child.exitCode !== null || child.signalCode !== null
        closed ||= child === null || child.stdio.every((stream) => stream.closed)
        finish()
      }).catch(reject)
    })
  } finally {
    child?.removeListener('exit', onExit)
    child?.removeListener('close', onClose)
    child?.removeListener('error', onError)
  }
}

/** Bounded caller wait; a deadline retires only this wait, never the barrier. */
export function stopWithProcessExit(client: RpcClient, started: boolean): Promise<void> {
  const barrier = stopWithProcessExitBarrier(client, started)
  const state = processStops.get(client)
  if (!state || state.promise !== barrier || state.result) return barrier
  // Subscribe once per active wait. Expired UI waits remove themselves instead
  // of accumulating Promise.race reactions on a possibly indefinite barrier.
  return new Promise<void>((resolve, reject) => {
    const finish = (result: StopResult): void => {
      clearTimeout(timer)
      state.waiters.delete(finish)
      if (result.ok) resolve()
      else reject(result.error)
    }
    const timer = setTimeout(() => finish({
      ok: false,
      error: new ProcessExitError('Timed out waiting for Agent process exit and stdio close')
    }), PROCESS_STOP_TIMEOUT_MS)
    state.waiters.add(finish)
  })
}
