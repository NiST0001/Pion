import { EventEmitter } from 'node:events'
import type { RpcClient } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopForHistory } from '../../src/main/agent/stop-for-history'

class MockChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

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
  expect(child.listenerCount('error')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}

describe('stopForHistory private SDK process adapter', () => {
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
    const { client, stop } = setup(child)
    await expect(stopForHistory(client)).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
    expectClean(child)
  })

  it('accepts an explicitly null SDK process as stopped without calling stop', async () => {
    const { client, stop } = setup(null)
    await expect(stopForHistory(client)).resolves.toBeUndefined()
    expect(stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the captured child when SDK stop resolves and clears process before SIGKILL exits', async () => {
    const child = new MockChild()
    const { client, stop, adapter } = setup(child)
    // Model pi 0.85.1's 1s escalation/null assignment, without spawning a process.
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
    child.emit('close', 0, null)
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
    expectClean(child)
    child.exit()
    await vi.advanceTimersByTimeAsync(0)
    expect(result.fulfilled).not.toHaveBeenCalled()
  })

  it.each([false, true])('bounds a hanging SDK stop even when actual exit=%s', async (exited) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    stop.mockReturnValue(new Promise<void>(() => {}))
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    if (exited) child.exit()
    await vi.advanceTimersByTimeAsync(5000)
    await result.settled
    expect(result.fulfilled).not.toHaveBeenCalled()
    expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Timed out/) }))
    expectClean(child)
  })

  it.each(['throw', 'reject'] as const)('fails closed on SDK stop %s and cleans up without an exit', async (kind) => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const error = new Error('SDK stop failed')
    if (kind === 'throw') stop.mockImplementation(() => { throw error })
    else stop.mockRejectedValue(error)
    await expect(stopForHistory(client)).rejects.toBe(error)
    expectClean(child)
  })

  it('rejects a failed SDK stop even after the captured child has exited', async () => {
    const child = new MockChild()
    const { client, stop } = setup(child)
    const error = new Error('SDK stop failed after exit')
    stop.mockImplementation(async () => { child.exit(); throw error })
    await expect(stopForHistory(client)).rejects.toBe(error)
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
      if (failure === 'error') expect(result.rejected).toHaveBeenCalledWith(error)
      else expect(result.rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Timed out/) }))
      expectClean(child)

      stopping.reject(new Error('late SDK failure'))
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
      expect(result.rejected).toHaveBeenCalledOnce()
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
    await expect(stopForHistory(client)).rejects.toBe(error)
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
    ['missing event cleanup', (stop) => ({ stop, process: Object.assign(new MockChild(), { removeListener: undefined }) })]
  ]
  it.each(incompatibleClients)('rejects incompatible adapter: %s', async (_name, makeClient) => {
    const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    await expect(stopForHistory(makeClient(stop) as RpcClient)).rejects.toThrow(/incompatible SDK RpcClient/)
    expect(stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['exit', 'timeout'] as const)('removes only its own child listeners after %s', async (outcome) => {
    const child = new MockChild()
    const existingExit = vi.fn()
    const existingError = vi.fn()
    child.on('exit', existingExit)
    child.on('error', existingError)
    const { client } = setup(child)
    const result = observe(stopForHistory(client))
    await vi.advanceTimersByTimeAsync(0)
    expect(child.listenerCount('exit')).toBe(2)
    expect(child.listenerCount('error')).toBe(2)
    if (outcome === 'exit') child.exit()
    else await vi.advanceTimersByTimeAsync(5000)
    await result.settled
    expect(result.fulfilled).toHaveBeenCalledTimes(outcome === 'exit' ? 1 : 0)
    expect(result.rejected).toHaveBeenCalledTimes(outcome === 'timeout' ? 1 : 0)
    expect(child.listeners('exit')).toEqual([existingExit])
    expect(child.listeners('error')).toEqual([existingError])
    expect(vi.getTimerCount()).toBe(0)
  })
})
