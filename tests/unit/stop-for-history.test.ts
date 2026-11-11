import { EventEmitter } from 'node:events'
import type { RpcClient } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopForHistory } from '../../src/main/agent/stop-for-history'
import { prepareProcessStart, stopWithProcessExit, stopWithProcessExitBarrier } from '../../src/main/process-exit'

class MockChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  stdio = [{ closed: false }, { closed: false }, { closed: false }]

  close(): void {
    this.stdio.forEach((stream) => { stream.closed = true })
    this.emit('close', this.exitCode, this.signalCode)
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function setup(child: MockChild | null = new MockChild()) {
  const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const adapter = { process: child, stop }
  return { adapter, stop, client: adapter as unknown as RpcClient }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function observe(promise: Promise<void>) {
  const fulfilled = vi.fn()
  const rejected = vi.fn()
  // Observe rejection before advancing timers or emitting synchronous errors.
  const settled = promise.then(fulfilled, rejected)
  return { fulfilled, rejected, settled }
}

function expectPending(result: ReturnType<typeof observe>) {
  expect(result.fulfilled).not.toHaveBeenCalled()
  expect(result.rejected).not.toHaveBeenCalled()
}

function expectClean(child: MockChild) {
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}

describe.each([
  { label: 'history', stopForHistory },
  { label: 'shared', stopForHistory: (client: RpcClient) => stopWithProcessExit(client, true) }
])('$label private SDK process adapter', ({ stopForHistory }) => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0) } finally { vi.useRealTimers() }
  })

  it('waits for a graceful exit and successful SDK stop', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    stop.mockImplementation(() => new Promise<void>((resolve) => {
      // These are the helper's listeners, installed before SDK stop executes.
      expect(child.listenerCount('exit')).toBe(1)
      expect(child.listenerCount('error')).toBe(1)
      child.once('exit', () => resolve())
    }))
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    expect(stop).toHaveBeenCalledOnce()
    expectPending(result)

    child.exit()
    child.close()
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledOnce()
    expect(result.rejected).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('does not miss an exit emitted synchronously inside stop', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    stop.mockImplementation(async () => {
      // The exit event alone is authoritative, even before fields are updated.
      child.emit('exit', 0, null)
      child.close()
    })
    await expect(stopForHistory(client)).resolves.toBeUndefined()
    expectClean(child)
  })

  it('keeps waiting for SDK stop after an actual exit', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const stopping = deferred()
    stop.mockReturnValue(stopping.promise)
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    child.exit()
    await vi.advanceTimersByTimeAsync(0)
    expectPending(result)

    child.close()
    stopping.resolve()
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledOnce()
    expect(result.rejected).not.toHaveBeenCalled()
    expectClean(child)
  })

  const exitStates: Array<[number | null, NodeJS.Signals | null]> = [
    [0, null], [9, null], [null, 'SIGTERM']
  ]
  it.each(exitStates)('accepts already-exited state code=%s signal=%s without another event', async (code, signal) => {
    const child = new MockChild()
    child.exitCode = code
    child.signalCode = signal
    child.close()
    const { client, stop } = setup(child)
    await expect(stopForHistory(client)).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it.each([0, null])('holds an exited writer until late pipe close (code=%s)', async (code) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    child.exit(code, code === null ? 'SIGTERM' : null)
    await vi.advanceTimersByTimeAsync(4999)
    expectPending(result)
    expect(stop).toHaveBeenCalledOnce()
    child.close()
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it('keeps the real barrier after a stdio deadline and lets a retry observe late close', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    stop.mockImplementation(async () => { child.exit(); adapter.process = null })
    const result = observe(stopForHistory(client))
    const barrier = stopWithProcessExitBarrier(client, true)
    const actual = observe(barrier)
    await vi.advanceTimersByTimeAsync(5000)
    await result.settled
    expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ closeUnknown: true }))
    expectPending(actual)
    expect(child.listenerCount('close')).toBe(1)
    expect(child.listenerCount('error')).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(stopWithProcessExitBarrier(client, true)).toBe(barrier)
    const retry = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    expectPending(retry)
    child.close()
    await Promise.all([actual.settled, retry.settled])
    expect(actual.fulfilled).toHaveBeenCalledOnce()
    expect(retry.fulfilled).toHaveBeenCalledOnce()
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it('creates a fresh barrier when the same client later owns a different child', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    const first = stopWithProcessExitBarrier(client, true)
    child.exit()
    child.close()
    await first
    const nextChild = new MockChild()
    adapter.process = nextChild
    const next = stopWithProcessExitBarrier(client, true)
    expect(next).not.toBe(first)
    const actual = observe(next)
    await vi.advanceTimersByTimeAsync(0)
    expectPending(actual)
    expect(stop).toHaveBeenCalledTimes(2)
    nextChild.exit()
    nextChild.close()
    await actual.settled
    expect(actual.fulfilled).toHaveBeenCalledOnce()
    expectClean(child)
    expectClean(nextChild)
  })

  it('retires an old null-handle receipt before reusing the client for another start', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    stop.mockImplementation(async () => { child.exit(); child.close(); adapter.process = null })
    await stopWithProcessExitBarrier(client, true)
    prepareProcessStart(client)
    await expect(stopForHistory(client)).rejects.toMatchObject({
      message: 'Agent process handle missing after start; shutdown is unknown', closeUnknown: true
    })
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it('retains a failed capture across later handles and never-started claims', async () => {
    const { client, stop, adapter } = setup(null)
    const failed = stopWithProcessExitBarrier(client, true)
    await expect(failed).rejects.toMatchObject({
      message: 'Agent process handle missing after start; shutdown is unknown', closeUnknown: true,
      cause: expect.objectContaining({ message: 'Agent process handle missing after start; shutdown is unknown' })
    })
    expect(() => prepareProcessStart(client)).toThrow(/unconfirmed before start/)
    adapter.process = new MockChild()
    expect(stopWithProcessExitBarrier(client, true)).toBe(failed)
    expect(stopWithProcessExitBarrier(client, false)).toBe(failed)
    await expect(stopForHistory(client)).rejects.toMatchObject({ closeUnknown: true })
    expect(() => prepareProcessStart(client)).toThrow(/unconfirmed before start/)
    expect(stop).not.toHaveBeenCalled()
    expectClean(adapter.process)
  })

  it.each(['pending', 'rejected'] as const)('preserves the old child identity when shutdown is %s', async (state) => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    const stopping = deferred()
    stop.mockReturnValue(stopping.promise)
    const original = observe(stopWithProcessExitBarrier(client, true))
    await vi.advanceTimersByTimeAsync(0)
    if (state === 'rejected') {
      stopping.reject(new Error('SDK stop failed'))
      await original.settled
    }
    expect(() => prepareProcessStart(client)).toThrow(/unconfirmed before start/)
    const nextChild = new MockChild()
    adapter.process = nextChild
    await expect(stopWithProcessExitBarrier(client, true)).rejects.toMatchObject({
      message: 'Agent process changed while shutdown is unconfirmed', closeUnknown: true
    })
    expect(stop).toHaveBeenCalledOnce()
    if (state === 'pending') {
      child.exit()
      child.close()
      stopping.resolve()
      await original.settled
      expect(original.rejected).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Agent process changed during SDK stop', closeUnknown: true
      }))
    }
    expectClean(child)
    expectClean(nextChild)
  })

  it('rejects a changed SDK handle before invoking stop on another child', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    const barrier = stopWithProcessExitBarrier(client, true)
    const nextChild = new MockChild()
    adapter.process = nextChild
    await expect(barrier).rejects.toMatchObject({ message: 'Agent process changed before SDK stop', closeUnknown: true })
    expect(stop).not.toHaveBeenCalled()
    expectClean(child)
    expectClean(nextChild)
  })

  it('keeps repeated bounded waits independent while sharing one listener set and SDK stop', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const barrier = stopWithProcessExitBarrier(client, true)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = observe(stopForHistory(client))
      await vi.advanceTimersByTimeAsync(5000)
      await result.settled
      expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ closeUnknown: true }))
      expect(child.listenerCount('exit')).toBe(1)
      expect(child.listenerCount('close')).toBe(1)
      expect(child.listenerCount('error')).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    }
    child.exit()
    child.close()
    await barrier
    expect(stop).toHaveBeenCalledOnce()
    await expect(stopForHistory(client)).resolves.toBeUndefined()
    expectClean(child)
  })

  it('rejects a null handle for an already-started writer without calling stop', async () => {
    const { client, stop } = setup(null)
    await expect(stopForHistory(client)).rejects.toThrow('shutdown is unknown')
    expect(stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the captured child when SDK stop resolves and clears process before SIGKILL exits', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    // Model pinned pi 1.4.0's 1s escalation/null assignment, without spawning a process.
    stop.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      child.killed = true
      adapter.process = null
    })
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(1000)
    expect(adapter.process).toBeNull()
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    expectPending(result)
    expect(child.listenerCount('exit')).toBe(1)
    expect(child.listenerCount('error')).toBe(1)

    // Neither a sent signal nor non-exit transport events establish real exit.
    child.emit('disconnect')
    child.close()
    await vi.advanceTimersByTimeAsync(1000)
    expectPending(result)
    child.exit(null, 'SIGKILL')
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledOnce()
    expect(result.rejected).not.toHaveBeenCalled()
    expectClean(child)
  })

  it.each(exitStates)('rechecks actual exit fields after stop: code=%s signal=%s', async (code, signal) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    stop.mockImplementation(async () => {
      child.exitCode = code
      child.signalCode = signal
      child.close()
    })
    await expect(stopForHistory(client)).resolves.toBeUndefined()
    expectClean(child)
  })

  it('rejects at the deadline if SDK stop resolved but no actual exit was confirmed', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    stop.mockImplementation(async () => { adapter.process = null; child.killed = true })
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(4999)
    expectPending(result)
    await vi.advanceTimersByTimeAsync(1)
    await result.settled
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Timed out/) }))
    const actual = observe(stopWithProcessExitBarrier(client, true))
    expect(child.listenerCount('exit')).toBe(1)
    child.exit()
    await vi.advanceTimersByTimeAsync(0)
    expectPending(actual)
    child.close()
    await actual.settled
    expect(actual.fulfilled).toHaveBeenCalledOnce()
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it.each([false, true])('bounds a hanging SDK stop while preserving its real barrier even when actual exit=%s', async (exited) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const stopping = deferred()
    stop.mockReturnValue(stopping.promise)
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    if (exited) { child.exit(); child.close() }
    await vi.advanceTimersByTimeAsync(5000)
    await result.settled
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Timed out/) }))
    const actual = observe(stopWithProcessExitBarrier(client, true))
    await vi.advanceTimersByTimeAsync(0)
    expectPending(actual)
    expect(child.listenerCount('error')).toBe(1)
    if (!exited) { child.exit(); child.close() }
    stopping.resolve()
    await actual.settled
    expect(actual.fulfilled).toHaveBeenCalledOnce()
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it.each(['throw', 'reject'] as const)('fails closed on SDK stop %s and cleans up without an exit', async (kind) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const error = Object.freeze(new Error('SDK stop failed'))
    if (kind === 'throw') stop.mockImplementation(() => { throw error })
    else stop.mockRejectedValue(error)
    await expect(stopForHistory(client)).rejects.toMatchObject({ message: error.message, cause: error, closeUnknown: true })
    expectClean(child)
  })

  it('rejects a failed SDK stop even after the captured child has exited', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const error = new Error('SDK stop failed after exit')
    stop.mockImplementation(async () => { child.exit(); throw error })
    await expect(stopForHistory(client)).rejects.toMatchObject({ message: error.message, cause: error, closeUnknown: true })
    expectClean(child)
  })

  it.each(['error', 'deadline'] as const)('observes a late SDK rejection after %s without leaking an exit promise', async (failure) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const stopping = deferred()
    stop.mockReturnValue(stopping.promise)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const result = observe(stopForHistory(client))
      await vi.advanceTimersByTimeAsync(0)
      const error = new Error('child could not stop')
      if (failure === 'error') child.emit('error', error)
      else await vi.advanceTimersByTimeAsync(5000)
      await result.settled
      expect(result.fulfilled).not.toHaveBeenCalled()
      if (failure === 'error') expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({
        message: error.message, cause: error, closeUnknown: true
      }))
      else expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Timed out/) }))
      if (failure === 'error') expectClean(child)
      else {
        expect(child.listenerCount('close')).toBe(1)
        expect(child.listenerCount('error')).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
      }

      stopping.reject(new Error('late SDK failure'))
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
      child.exit()
      child.close()
      await vi.advanceTimersByTimeAsync(0)
      expect(result.fulfilled).not.toHaveBeenCalled()
      expect(result.rejected).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledOnce()
      expectClean(child)
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })

  it('handles a synchronous child error inside stop before the stop promise settles', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const error = new Error('synchronous process error')
    stop.mockImplementation(() => {
      child.emit('error', error)
      return new Promise<void>(() => {})
    })
    await expect(stopForHistory(client)).rejects.toMatchObject({ message: error.message, cause: error, closeUnknown: true })
    expectClean(child)
  })

  const incompatibleClients: Array<[string, (stop: () => Promise<void>) => unknown]> = [
    ['null client', () => null],
    ['missing process property', (stop) => ({ stop })],
    ['undefined process property', (stop) => ({ stop, process: undefined })],
    ['inherited process property', (stop) => Object.assign(Object.create({ process: null }), { stop })],
    ['missing stop method', () => ({ process: null })],
    ['nonfunction stop method', () => ({ process: null, stop: true })],
    ['primitive process', (stop) => ({ stop, process: 1 })],
    ['missing exit state', (stop) => ({ stop, process: new EventEmitter() })],
    ['missing signalCode', (stop) => ({ stop, process: Object.assign(new MockChild(), { signalCode: undefined }) })],
    ['invalid exitCode', (stop) => ({ stop, process: Object.assign(new MockChild(), { exitCode: '0' }) })],
    ['nonfinite exitCode', (stop) => ({ stop, process: Object.assign(new MockChild(), { exitCode: NaN }) })],
    ['invalid signalCode', (stop) => ({ stop, process: Object.assign(new MockChild(), { signalCode: false }) })],
    ['empty signalCode', (stop) => ({ stop, process: Object.assign(new MockChild(), { signalCode: '' }) })],
    ['missing event registration', (stop) => ({ stop, process: Object.assign(new MockChild(), { once: undefined }) })],
    ['missing event cleanup', (stop) => ({ stop, process: Object.assign(new MockChild(), { removeListener: undefined }) })],
    ['missing stdio', (stop) => ({ stop, process: Object.assign(new MockChild(), { stdio: undefined }) })],
    ['wrong pipe count', (stop) => ({ stop, process: Object.assign(new MockChild(), { stdio: [] }) })],
    ['sparse pipes', (stop) => ({ stop, process: Object.assign(new MockChild(), { stdio: new Array(3) }) })],
    ['null pipe', (stop) => ({ stop, process: Object.assign(new MockChild(), { stdio: [null, null, null] }) })],
    ['unknown pipe close', (stop) => ({ stop, process: Object.assign(new MockChild(), { stdio: [{}, {}, {}] }) })]
  ]
  it.each(incompatibleClients)('rejects incompatible adapter: %s', async (_name, makeClient) => {
    const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    await expect(stopForHistory(makeClient(stop) as RpcClient)).rejects.toThrow(/incompatible SDK RpcClient/)
    expect(stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['exit', 'timeout'] as const)('removes only its own child listeners after real cleanup following %s', async (outcome) => {
    const child = new MockChild()
    const existingExit = vi.fn()
    const existingClose = vi.fn()
    const existingError = vi.fn()
    child.on('exit', existingExit)
    child.on('close', existingClose)
    child.on('error', existingError)
    const { client } = setup(child)
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    expect(child.listenerCount('exit')).toBe(2)
    expect(child.listenerCount('close')).toBe(2)
    expect(child.listenerCount('error')).toBe(2)
    if (outcome === 'exit') { child.exit(); child.close() }
    else await vi.advanceTimersByTimeAsync(5000)
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledTimes(outcome === 'exit' ? 1 : 0)
    expect(result.rejected).toHaveBeenCalledTimes(outcome === 'timeout' ? 1 : 0)
    if (outcome === 'timeout') {
      expect(child.listenerCount('exit')).toBe(2)
      expect(child.listenerCount('close')).toBe(2)
      expect(child.listenerCount('error')).toBe(2)
      child.exit()
      child.close()
      await stopWithProcessExitBarrier(client, true)
    }
    expect(child.listeners('exit')).toEqual([existingExit])
    expect(child.listeners('close')).toEqual([existingClose])
    expect(child.listeners('error')).toEqual([existingError])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('shared exit barrier with independently proven never-started client', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0) } finally { vi.useRealTimers() }
  })

  it('requires explicit never-started proof before accepting a null handle', async () => {
    const { client, stop } = setup(null)
    await expect(stopWithProcessExit(client, undefined as unknown as boolean)).rejects.toThrow('shutdown is unknown')
    expect(stop).not.toHaveBeenCalled()
  })

  it('waits for SDK stop even when no child was ever created', async () => {
    const { client, stop } = setup(null)
    const stopping = deferred()
    stop.mockReturnValue(stopping.promise)
    const result = observe(stopWithProcessExit(client, false))
    await vi.advanceTimersByTimeAsync(0)
    expectPending(result)
    stopping.resolve()
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('still requires exit and pipe close when a child exists despite a never-started claim', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const result = observe(stopWithProcessExit(client, false))
    await vi.advanceTimersByTimeAsync(0)
    expectPending(result)
    child.exit()
    await vi.advanceTimersByTimeAsync(0)
    expectPending(result)
    child.close()
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it('bounds a hung stop without inventing a successful negative receipt', async () => {
    const { client, stop } = setup(null)
    const stopping = deferred()
    stop.mockReturnValue(stopping.promise)
    const result = observe(stopWithProcessExit(client, false))
    await vi.advanceTimersByTimeAsync(5000)
    await result.settled
    expect(result.rejected).toHaveBeenCalledOnce()
    const actual = observe(stopWithProcessExitBarrier(client, false))
    await vi.advanceTimersByTimeAsync(0)
    expectPending(actual)
    stopping.resolve()
    await actual.settled
    expect(actual.fulfilled).toHaveBeenCalledOnce()
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    await expect(stopWithProcessExit(client, true)).rejects.toThrow('shutdown is unknown')
  })

  it('propagates rejected SDK stop even without a child', async () => {
    const { client, stop } = setup(null)
    const error = new Error('never-started stop failed')
    stop.mockRejectedValue(error)
    await expect(stopWithProcessExit(client, false)).rejects.toMatchObject({ message: error.message, cause: error, closeUnknown: true })
  })
})
