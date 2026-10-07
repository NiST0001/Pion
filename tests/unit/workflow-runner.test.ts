import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiWorkflowWorkerRunner } from '../../src/main/workflow/runners'
import { WORKER_TIMEOUT_MS } from '../../src/main/workflow/constants'
import type { WorkflowWorkerInput } from '../../src/main/workflow/types'

type Disposition = 'started' | 'queued' | 'handled'
type Event = { type: string; [key: string]: unknown }

const rpc = vi.hoisted(() => {
  class FakeRpc {
    static instances: FakeRpc[] = []
    static configure: (client: FakeRpc) => void = () => undefined
    beforeSubscribe = (): void => {}
    static dispatch: (client: FakeRpc) => Promise<'started' | 'queued' | 'handled'> = async () => 'handled'
    listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>()
    start = vi.fn(async (): Promise<void> => undefined)
    getState = vi.fn(async () => ({ sessionFile: '/fake/session.jsonl' }))
    getStderr = vi.fn(() => 'worker stderr diagnostic')
    stop = vi.fn(async (): Promise<void> => undefined)
    abort = vi.fn(async (): Promise<void> => undefined)
    prompt = vi.fn(async (_message: string) => FakeRpc.dispatch(this))
    waitForIdle = vi.fn(async () => { throw new Error('late waiter must not be used') })
    promptAndWait = vi.fn(async () => { throw new Error('SDK helper misses handled disposition') })
    constructor(_options: unknown) {
      FakeRpc.instances.push(this)
      FakeRpc.configure(this)
    }
    onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
      this.beforeSubscribe()
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    }
    emit(event: { type: string; [key: string]: unknown }): void {
      for (const listener of [...this.listeners]) listener(event)
    }
  }
  return { FakeRpc }
})

vi.mock('@earendil-works/pi-coding-agent', () => ({ RpcClient: rpc.FakeRpc }))
vi.mock('../../src/main/pi-runtime', () => ({ piCliPath: () => '/fake/pi.js' }))

const input: WorkflowWorkerInput = {
  id: 'worker-1', workflowId: 'workflow-1', role: 'planner', cwd: '/fake/project',
  prompt: 'plan this work', permissionConfigPath: '/fake/permissions.json'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function final(text: string, stopReason = 'stop', errorMessage?: string): Event {
  return { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, errorMessage } }
}

function runner(): PiWorkflowWorkerRunner {
  return new PiWorkflowWorkerRunner(async () => '/fake/permission-extension.ts')
}

function cleaned(client: InstanceType<typeof rpc.FakeRpc>): void {
  expect(client.listeners.size).toBe(0)
  expect(client.stop).toHaveBeenCalledTimes(1)
  expect(client.waitForIdle).not.toHaveBeenCalled()
  expect(client.promptAndWait).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  rpc.FakeRpc.instances = []
  rpc.FakeRpc.configure = () => undefined
  rpc.FakeRpc.dispatch = async () => 'handled'
})
afterEach(() => { vi.useRealTimers() })

describe('PiWorkflowWorkerRunner RPC completion', () => {
  it('observes fast final/settled events before prompt acceptance resolves', async () => {
    rpc.FakeRpc.dispatch = async (client) => {
      expect(client.listeners.size).toBeGreaterThan(0)
      client.emit({ type: 'agent_start' })
      client.emit(final('fast answer'))
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).resolves.toEqual({ output: 'fast answer', sessionPath: '/fake/session.jsonl' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('completes handled input with no run or settlement event', async () => {
    await expect(runner().run(input, vi.fn())).resolves.toMatchObject({ output: 'Agent 已完成，但没有返回文本输出。' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it.each(['agent_start', 'run_started'])('waits for independent extension work observed as %s despite handled disposition', async (start) => {
    rpc.FakeRpc.dispatch = async (client) => { client.emit({ type: start }); return 'handled' }
    const result = runner().run(input, vi.fn())
    await flush()
    const client = rpc.FakeRpc.instances[0]
    expect(client.stop).not.toHaveBeenCalled()
    client.emit(final('independent answer'))
    client.emit({ type: 'agent_end', messages: [] })
    await flush()
    expect(client.stop).not.toHaveBeenCalled()
    client.emit({ type: 'agent_settled' })
    await expect(result).resolves.toMatchObject({ output: 'independent answer' })
    cleaned(client)
  })

  it('does not resolve on agent_end, and final-only messages outrank contradictory compatibility messages', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const result = runner().run(input, vi.fn())
    await flush()
    const client = rpc.FakeRpc.instances[0]
    client.emit(final('authoritative answer'))
    client.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'stale error', stopReason: 'error' }] })
    await flush()
    expect(client.stop).not.toHaveBeenCalled()
    client.emit({ type: 'agent_settled' })
    await expect(result).resolves.toMatchObject({ output: 'authoritative answer' })
    cleaned(client)
  })

  it('keeps legacy agent_end output only when no final assistant message was observed', async () => {
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'legacy text', stopReason: 'stop' }] })
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).resolves.toMatchObject({ output: 'legacy text' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('preserves final provider errorMessage and worker stderr instead of stale agent_end diagnostics', async () => {
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit(final('', 'error', 'original provider diagnostic'))
      client.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'stale', stopReason: 'stop' }] })
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).rejects.toThrow('original provider diagnostic\nworker stderr diagnostic')
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('uses the latest authoritative final message after recovery rather than an earlier error', async () => {
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit({ type: 'agent_start' })
      client.emit(final('', 'error', 'retryable diagnostic'))
      client.emit({ type: 'agent_end', messages: [], willRetry: true })
      client.emit({ type: 'agent_start' })
      client.emit(final('recovered answer'))
      client.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'stale error', stopReason: 'error' }] })
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).resolves.toMatchObject({ output: 'recovered answer' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it.each(['agent_start', 'run_started'])('resets final authority for recovery %s with legacy-only output', async (start) => {
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit({ type: start })
      client.emit(final('', 'error', 'old provider diagnostic'))
      client.emit({ type: 'agent_end', messages: [], willRetry: true })
      client.emit({ type: start })
      client.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'legacy recovery answer', stopReason: 'stop' }] })
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).resolves.toMatchObject({ output: 'legacy recovery answer' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('does not turn a normal aborted final message into an error', async () => {
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit(final('', 'aborted', 'Request aborted'))
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).resolves.toMatchObject({ output: 'Agent 已取消' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('cleans the listener and deadline when dispatch rejects, even after an early settlement', async () => {
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit({ type: 'agent_settled' })
      throw new Error('dispatch diagnostic')
    }
    await expect(runner().run(input, vi.fn())).rejects.toThrow('dispatch diagnostic')
    cleaned(rpc.FakeRpc.instances[0])
  })

  it.each(['started', 'queued'])('bounds missing settlement after %s acceptance and actually stops the worker', async (disposition) => {
    rpc.FakeRpc.dispatch = async () => disposition as Disposition
    const result = runner().run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion. Stderr: worker stderr diagnostic')
    await flush()
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await rejected
    cleaned(rpc.FakeRpc.instances[0])
  })

  it.each(['start', 'getState'] as const)('bounds permanently pending initial %s before dispatch', async (stage) => {
    rpc.FakeRpc.configure = (client) => {
      if (stage === 'start') client.start.mockImplementationOnce(() => new Promise(() => {}))
      else client.getState.mockImplementationOnce(() => new Promise(() => {}))
    }
    const result = runner().run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    await flush()
    const client = rpc.FakeRpc.instances[0]
    expect(client[stage]).toHaveBeenCalledTimes(1)
    expect(client.prompt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await rejected
    cleaned(client)
  })

  it.each(['start', 'getState'] as const)('cancels permanently pending initial %s before dispatch', async (stage) => {
    rpc.FakeRpc.configure = (client) => {
      if (stage === 'start') client.start.mockImplementationOnce(() => new Promise(() => {}))
      else client.getState.mockImplementationOnce(() => new Promise(() => {}))
    }
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    expect(client[stage]).toHaveBeenCalledTimes(1)
    await worker.cancel(input.id)
    await rejected
    expect(client.prompt).not.toHaveBeenCalled()
    cleaned(client)
  })

  it.each(['cancel', 'timeout'] as const)('bounds permanently pending permission preparation on %s', async (reason) => {
    const permission = deferred<string>()
    const prepare = vi.fn(() => permission.promise)
    const worker = new PiWorkflowWorkerRunner(prepare)
    const result = worker.run(input, vi.fn())
    const rejected = reason === 'cancel'
      ? expect(result).rejects.toMatchObject({ name: 'AbortError' })
      : expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    // The cancellation gate and deadline exist before the first await.
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    if (reason === 'cancel') await worker.cancel(input.id)
    else await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await rejected
    expect(rpc.FakeRpc.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await worker.cancel(input.id)
    // No stuck operation entry: a fresh run can prepare and complete normally.
    prepare.mockImplementationOnce(async () => '/fake/permission-extension.ts')
    await expect(worker.run(input, vi.fn())).resolves.toMatchObject({ output: 'Agent 已完成，但没有返回文本输出。' })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it.each(['cancel', 'timeout'] as const)('ignores late permission resolution or rejection after %s', async (reason) => {
    for (const late of ['resolve', 'reject'] as const) {
      const permission = deferred<string>()
      const worker = new PiWorkflowWorkerRunner(() => permission.promise)
      const result = worker.run(input, vi.fn())
      const rejected = reason === 'cancel'
        ? expect(result).rejects.toMatchObject({ name: 'AbortError' })
        : expect(result).rejects.toThrow('Timeout waiting for Agent completion')
      if (reason === 'cancel') await worker.cancel(input.id)
      else await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
      await rejected
      if (late === 'resolve') permission.resolve('/fake/late-extension.ts')
      else permission.reject(new Error('late permission failure'))
      await flush()
      expect(rpc.FakeRpc.instances).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('keeps synchronous preparation cancellation from creating an RPC client', async () => {
    let cancellation: Promise<void> | undefined
    const worker = new PiWorkflowWorkerRunner(() => {
      cancellation = worker.cancel(input.id)
      return Promise.resolve('/fake/permission-extension.ts')
    })
    await expect(worker.run(input, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    await cancellation
    expect(rpc.FakeRpc.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the actual client if construction synchronously cancels before client assignment', async () => {
    const worker = runner()
    let cancellation: Promise<void> | undefined
    rpc.FakeRpc.configure = () => { cancellation = worker.cancel(input.id) }
    await expect(worker.run(input, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    await cancellation
    const client = rpc.FakeRpc.instances[0]
    expect(client.start).not.toHaveBeenCalled()
    expect(client.getState).not.toHaveBeenCalled()
    expect(client.prompt).not.toHaveBeenCalled()
    cleaned(client)
  })

  it('prevents start after synchronous cancellation in listener registration', async () => {
    const worker = runner()
    let cancellation: Promise<void> | undefined
    rpc.FakeRpc.configure = (client) => {
      client.start.mockImplementationOnce(() => new Promise(() => {}))
      client.beforeSubscribe = () => { cancellation = worker.cancel(input.id) }
    }
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    await cancellation
    await rejected
    const client = rpc.FakeRpc.instances[0]
    expect(client.start).not.toHaveBeenCalled()
    expect(client.getState).not.toHaveBeenCalled()
    expect(client.abort).not.toHaveBeenCalled()
    expect(client.prompt).not.toHaveBeenCalled()
    cleaned(client)
  })

  it('prevents prompt after the startup progress callback synchronously cancels', async () => {
    const worker = runner()
    let cancellation: Promise<void> | undefined
    const progress = vi.fn((message: string) => {
      if (message === 'Agent 已启动') cancellation = worker.cancel(input.id)
    })
    await expect(worker.run(input, progress)).rejects.toMatchObject({ name: 'AbortError' })
    await cancellation
    const client = rpc.FakeRpc.instances[0]
    expect(progress).toHaveBeenCalledWith('Agent 已启动')
    expect(client.start).toHaveBeenCalledTimes(1)
    expect(client.getState).toHaveBeenCalledTimes(1)
    expect(client.prompt).not.toHaveBeenCalled()
    cleaned(client)
  })

  it('prevents subsequent state and prompt effects after synchronous cancellation within start', async () => {
    const worker = runner()
    let cancellation: Promise<void> | undefined
    rpc.FakeRpc.configure = (client) => {
      client.start.mockImplementationOnce(async () => { cancellation = worker.cancel(input.id) })
    }
    await expect(worker.run(input, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    await cancellation
    const client = rpc.FakeRpc.instances[0]
    expect(client.start).toHaveBeenCalledTimes(1)
    expect(client.getState).not.toHaveBeenCalled()
    expect(client.prompt).not.toHaveBeenCalled()
    cleaned(client)
  })

  it('checks the elapsed deadline before constructing a client even before the timer callback runs', async () => {
    const permission = deferred<string>()
    const worker = new PiWorkflowWorkerRunner(() => permission.promise)
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    vi.setSystemTime(Date.now() + WORKER_TIMEOUT_MS)
    permission.resolve('/fake/permission-extension.ts')
    await rejected
    expect(rpc.FakeRpc.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks elapsed time after startup progress before dispatch without relying on the timer callback', async () => {
    await expect(runner().run(input, (message) => {
      if (message === 'Agent 已启动') vi.setSystemTime(Date.now() + WORKER_TIMEOUT_MS)
    })).rejects.toThrow('Timeout waiting for Agent completion')
    const client = rpc.FakeRpc.instances[0]
    expect(client.prompt).not.toHaveBeenCalled()
    cleaned(client)
  })

  it('handles late startup rejection after timeout', async () => {
    const startup = deferred<void>()
    rpc.FakeRpc.configure = (client) => { client.start.mockImplementationOnce(() => startup.promise) }
    const result = runner().run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    await flush()
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await rejected
    startup.reject(new Error('late startup rejection'))
    await flush()
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('bounds stalled dispatch and ignores its late disposition without leaking listeners', async () => {
    const dispatch = deferred<Disposition>()
    rpc.FakeRpc.dispatch = () => dispatch.promise
    const result = runner().run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    await flush()
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await rejected
    const client = rpc.FakeRpc.instances[0]
    cleaned(client)
    dispatch.resolve('handled')
    await flush()
    cleaned(client)
  })

  it('cancels and stops even if abort rejects and no agent_settled event arrives', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Agent 已取消' })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    client.abort.mockRejectedValueOnce(new Error('abort unavailable'))
    await worker.cancel(input.id)
    await rejected
    expect(client.abort).toHaveBeenCalledTimes(1)
    cleaned(client)
    await worker.cancel(input.id)
    expect(client.abort).toHaveBeenCalledTimes(1)
    cleaned(client)
  })

  it('does not let a permanently pending abort block cancellation and stop', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    const abort = deferred<void>()
    client.abort.mockImplementationOnce(() => abort.promise)
    await worker.cancel(input.id)
    await rejected
    cleaned(client)
    abort.reject(new Error('late abort rejection'))
    await flush()
    cleaned(client)
  })

  it('awaits real stop cleanup and shares it with cancellation instead of invoking stop twice', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    const stop = deferred<void>()
    client.stop.mockImplementationOnce(() => stop.promise)
    let cancelled = false
    const cancellation = worker.cancel(input.id).then(() => { cancelled = true })
    await flush()
    expect(cancelled).toBe(false)
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(client.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    stop.resolve(undefined)
    await cancellation
    await rejected
    cleaned(client)
  })

  it('does not report success when RPC stop rejects', async () => {
    const cleanupError = new Error('stop unavailable')
    rpc.FakeRpc.configure = (client) => { client.stop.mockRejectedValueOnce(cleanupError) }
    await expect(runner().run(input, vi.fn())).rejects.toMatchObject({
      message: 'Agent 收尾未确认：RPC stop 失败：stop unavailable', cause: cleanupError, cleanupError
    })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('retains primary provider diagnostics and cause when RPC stop also rejects', async () => {
    const cleanupError = new Error('stop unavailable')
    rpc.FakeRpc.configure = (client) => { client.stop.mockRejectedValueOnce(cleanupError) }
    rpc.FakeRpc.dispatch = async (client) => {
      client.emit(final('', 'error', 'original model diagnostic'))
      client.emit({ type: 'agent_settled' })
      return 'started'
    }
    await expect(runner().run(input, vi.fn())).rejects.toMatchObject({
      message: 'original model diagnostic\nworker stderr diagnostic\nAgent 收尾未确认：RPC stop 失败：stop unavailable',
      cause: expect.objectContaining({ message: 'original model diagnostic\nworker stderr diagnostic' }),
      cleanupError
    })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('shares a rejected stop during cancellation and handles both rejection paths', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({
      message: 'Agent 已取消\nAgent 收尾未确认：RPC stop 失败：stop unavailable',
      cause: expect.objectContaining({ name: 'AbortError' })
    })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    const cleanup = deferred<void>()
    client.stop.mockImplementationOnce(() => cleanup.promise)
    const cancellation = worker.cancel(input.id)
    const cancelRejected = expect(cancellation).rejects.toThrow('stop unavailable')
    await flush()
    cleanup.reject(new Error('stop unavailable'))
    await cancelRejected
    await rejected
    cleaned(client)
  })

  it('cancels during pending dispatch without waiting for dispatch or orphaning its rejection', async () => {
    const dispatch = deferred<Disposition>()
    rpc.FakeRpc.dispatch = () => dispatch.promise
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    await worker.cancel(input.id)
    await rejected
    const client = rpc.FakeRpc.instances[0]
    cleaned(client)
    dispatch.reject(new Error('late dispatch diagnostic'))
    await flush()
    cleaned(client)
  })
})
