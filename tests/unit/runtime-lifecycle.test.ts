import { describe, expect, it, vi } from 'vitest'
import { runRuntimeLifecycle } from '../../src/main/agent/runtime-lifecycle'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function setup() {
  const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const runtime = { dispose }
  const create = vi.fn<() => Promise<typeof runtime>>().mockResolvedValue(runtime)
  const run = vi.fn<(owner: typeof runtime) => Promise<void>>().mockResolvedValue(undefined)
  return { runtime, create, run, dispose }
}

// Pure ownership tests: no executable entry, process exit, SDK or real MCP.
describe('runRuntimeLifecycle', () => {
  it('closes the runtime once after a normally returning RPC run', async () => {
    const { runtime, create, run, dispose } = setup()
    await expect(runRuntimeLifecycle(create, run)).resolves.toEqual({ runFailed: false, cleanupFailed: false })
    expect(create).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledExactlyOnceWith(runtime)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('awaits shutdown before returning a startup rejection', async () => {
    const { create, run, dispose } = setup()
    const failure = new Error('bindExtensions rejected')
    run.mockRejectedValue(failure)
    const closing = deferred()
    const enteredCleanup = deferred()
    dispose.mockImplementation(() => {
      enteredCleanup.resolve()
      return closing.promise
    })
    const settled = vi.fn()
    const result = runRuntimeLifecycle(create, run).then((value) => { settled(); return value })
    await enteredCleanup.promise
    expect(dispose).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    closing.resolve()
    const outcome = await result
    expect(outcome).toEqual({ runFailed: true, error: failure, cleanupFailed: false })
    if (outcome.runFailed) expect(outcome.error).toBe(failure)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('also waits for cleanup after a successful RPC return', async () => {
    const { create, run, dispose } = setup()
    const closing = deferred()
    const enteredCleanup = deferred()
    dispose.mockImplementation(() => { enteredCleanup.resolve(); return closing.promise })
    const settled = vi.fn()
    const result = runRuntimeLifecycle(create, run).then((value) => { settled(); return value })
    await enteredCleanup.promise
    expect(settled).not.toHaveBeenCalled()
    closing.resolve()
    await expect(result).resolves.toEqual({ runFailed: false, cleanupFailed: false })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('preserves the primary failure and separately reports cleanup failure without its secret', async () => {
    const { create, run, dispose } = setup()
    const primary = new Error('original RPC diagnostic')
    run.mockRejectedValue(primary)
    dispose.mockRejectedValue(new Error('cleanup credential=secret'))
    const result = await runRuntimeLifecycle(create, run)
    expect(result).toEqual({ runFailed: true, error: primary, cleanupFailed: true })
    if (result.runFailed) expect(result.error).toBe(primary)
    expect(JSON.stringify(result)).not.toContain('credential')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('distinguishes cleanup-only failure and never retries shutdown', async () => {
    const { create, run, dispose } = setup()
    dispose.mockRejectedValue(new Error('private server details'))
    await expect(runRuntimeLifecycle(create, run)).resolves.toEqual({ runFailed: false, cleanupFailed: true })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not run or dispose an owner when creation fails', async () => {
    const { create, run, dispose } = setup()
    const failure = new Error('create failed')
    create.mockRejectedValue(failure)
    const result = await runRuntimeLifecycle(create, run)
    expect(result).toEqual({ runFailed: true, error: failure, cleanupFailed: false })
    if (result.runFailed) expect(result.error).toBe(failure)
    expect(run).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('cleans up once even when the run callback throws synchronously', async () => {
    const { create, run, dispose } = setup()
    const failure = new Error('synchronous failure')
    run.mockImplementation(() => { throw failure })
    await expect(runRuntimeLifecycle(create, run)).resolves.toEqual({ runFailed: true, error: failure, cleanupFailed: false })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
