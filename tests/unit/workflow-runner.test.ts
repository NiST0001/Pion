import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowManager } from '../../src/main/workflow-manager'
import type { WorkflowSnapshot } from '../../src/shared/workflows'
import { PiWorkflowWorkerRunner, VerificationWorkflowRunner } from '../../src/main/workflow/runners'
import { CommandRunner } from '../../src/main/command-runner'
import { VerificationService } from '../../src/main/verification'
import type { StartVerificationOptions, VerificationPlan, VerificationRun } from '../../src/shared/operations'
import { WORKER_TIMEOUT_MS } from '../../src/main/workflow/constants'
import type { WorkflowWorkerInput } from '../../src/main/workflow/types'

type Disposition = 'started' | 'queued' | 'handled'
type Event = { type: string; [key: string]: unknown }

const rpc = vi.hoisted(() => {
  class FakeProcess {
    exitCode: number | null = null
    signalCode: string | null = null
    stdio = [{ closed: false }, { closed: false }, { closed: false }]
    listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    once(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? new Set()
      listeners.add(listener)
      this.listeners.set(event, listeners)
      return this
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener)
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      const listeners = this.listeners.get(event)
      this.listeners.delete(event)
      for (const listener of listeners ?? []) listener(...args)
    }
    close(): void {
      this.exitCode = 0
      this.emit('exit')
      this.stdio.forEach((stream) => { stream.closed = true })
      this.emit('close')
    }
  }
  class FakeRpc {
    static instances: FakeRpc[] = []
    static configure: (client: FakeRpc) => void = () => undefined
    beforeSubscribe = (): void => {}
    static dispatch: (client: FakeRpc) => Promise<'started' | 'queued' | 'handled'> = async () => 'handled'
    listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>()
    start = vi.fn(async (): Promise<void> => { this.process = this.child })
    getState = vi.fn(async () => ({ sessionFile: '/fake/session.jsonl' }))
    getStderr = vi.fn(() => 'worker stderr diagnostic')
    child = new FakeProcess()
    process: FakeProcess | null = null
    stop = vi.fn(async (): Promise<void> => { this.process?.close(); this.process = null })
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

  it.each((['permission', 'start', 'getState'] as const).flatMap((stage) =>
    (['cancel', 'timeout'] as const).map((reason) => ({ stage, reason }))
  ))('retains actual $stage preparation until settlement after $reason', async ({ stage, reason }) => {
    const preparation = deferred<void>()
    const prepare = vi.fn(async () => '/fake/permission-extension.ts')
    if (stage === 'permission') prepare.mockImplementationOnce(() => preparation.promise.then(() => '/fake/permission-extension.ts'))
    rpc.FakeRpc.configure = (client) => {
      if (stage === 'start') client.start.mockImplementationOnce(() => {
        client.process = client.child
        return preparation.promise
      })
      if (stage === 'getState') client.getState.mockImplementationOnce(() => preparation.promise.then(() => ({ sessionFile: '/fake/late.jsonl' })))
    }
    const worker = new PiWorkflowWorkerRunner(prepare)
    const progress = vi.fn()
    const result = worker.run(input, progress)
    const rejected = reason === 'cancel'
      ? expect(result).rejects.toMatchObject({ name: 'AbortError' })
      : expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    let finished = false
    void result.catch(() => { finished = true })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await flush()
    const client = rpc.FakeRpc.instances[0]
    if (stage === 'permission') expect(client).toBeUndefined()
    else expect(client[stage]).toHaveBeenCalledTimes(1)
    if (reason === 'cancel') await worker.cancel(input.id)
    else await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await flush()
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    await expect(worker.run(input, vi.fn())).rejects.toThrow(/仍被保留/)
    await expect(worker.run({ ...input, id: 'same-cwd' }, vi.fn())).rejects.toThrow(/尚未确认/)
    await worker.cancel(input.id)
    if (client) {
      expect(client.stop).toHaveBeenCalledTimes(1)
      expect(client.prompt).not.toHaveBeenCalled()
      expect(client.listeners.size).toBe(0)
    }
    expect(vi.getTimerCount()).toBe(0)
    preparation.resolve(undefined)
    await rejected
    expect(progress).not.toHaveBeenCalled()
    if (stage === 'permission') expect(rpc.FakeRpc.instances).toHaveLength(0)
    else {
      expect(client.prompt).not.toHaveBeenCalled()
      if (stage === 'start') expect(client.getState).not.toHaveBeenCalled()
      cleaned(client)
    }
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    rpc.FakeRpc.configure = () => undefined
    await expect(worker.run(input, vi.fn())).resolves.toMatchObject({ output: 'Agent 已完成，但没有返回文本输出。' })
    cleaned(rpc.FakeRpc.instances.at(-1)!)
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
      client.start.mockImplementationOnce(async () => {
        client.process = client.child
        cancellation = worker.cancel(input.id)
      })
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
    rpc.FakeRpc.configure = (client) => {
      client.start.mockImplementationOnce(() => { client.process = client.child; return startup.promise })
    }
    const result = runner().run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    await flush()
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    startup.reject(new Error('late startup rejection'))
    await rejected
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('bounds stalled dispatch and ignores its late disposition without leaking listeners', async () => {
    const dispatch = deferred<Disposition>()
    rpc.FakeRpc.dispatch = () => dispatch.promise
    const result = runner().run(input, vi.fn())
    const rejected = expect(result).rejects.toThrow('Timeout waiting for Agent completion')
    await flush()
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    const client = rpc.FakeRpc.instances[0]
    cleaned(client)
    dispatch.resolve('handled')
    await rejected
    expect(client.getState).toHaveBeenCalledTimes(1)
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

  it('acknowledges stop without releasing the reservation of a pending abort RPC', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    const abort = deferred<void>()
    client.abort.mockImplementationOnce(() => abort.promise)
    let finished = false
    void result.catch(() => { finished = true })
    await worker.cancel(input.id)
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    cleaned(client)
    abort.reject(new Error('late abort rejection'))
    await rejected
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
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
    expect(vi.getTimerCount()).toBe(1)
    client.child.close()
    stop.resolve(undefined)
    await cancellation
    await rejected
    cleaned(client)
  })

  it.each(['cancel', 'signal'] as const)('keeps %s during cleanup effective until late abort and stop both settle', async (reason) => {
    const stop = deferred<void>()
    const abort = deferred<void>()
    rpc.FakeRpc.configure = (client) => {
      client.stop.mockImplementationOnce(() => stop.promise)
      client.abort.mockImplementationOnce(() => abort.promise)
    }
    const controller = new AbortController()
    const worker = runner()
    const result = worker.run({ ...input, signal: controller.signal }, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    let finished = false
    void result.then(() => { finished = true }, () => { finished = true })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    expect(client.stop).toHaveBeenCalledTimes(1)
    let cancellation: Promise<void> | undefined
    if (reason === 'cancel') cancellation = worker.cancel(input.id)
    else controller.abort()
    expect(client.abort).toHaveBeenCalledTimes(1)
    client.child.close()
    stop.resolve(undefined)
    await cancellation
    await flush()
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    abort.resolve(undefined)
    await rejected
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    cleaned(client)
  })

  it('retains failed SDK stop isolation after late exit/close and shares the same rejection on cancel', async () => {
    const cleanupError = new Error('stop unavailable')
    rpc.FakeRpc.configure = (client) => { client.stop.mockRejectedValueOnce(cleanupError) }
    const worker = runner()
    await expect(worker.run(input, vi.fn())).rejects.toMatchObject({
      message: 'Agent 收尾未确认：stop unavailable',
      cause: expect.objectContaining({ message: cleanupError.message, cause: cleanupError, closeUnknown: true }),
      cleanupError: expect.objectContaining({ message: cleanupError.message, cause: cleanupError, closeUnknown: true }),
      closeUnknown: true
    })
    const client = rpc.FakeRpc.instances[0]
    client.child.close()
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    await expect(worker.run(input, vi.fn())).rejects.toThrow(/仍被保留/)
    await expect(worker.run({ ...input, id: 'new-id' }, vi.fn())).rejects.toThrow(/尚未确认/)
    await expect(worker.cancel(input.id)).rejects.toMatchObject({ message: cleanupError.message, cause: cleanupError, closeUnknown: true })
    expect(client.child.listeners.get('exit')?.size ?? 0).toBe(0)
    expect(client.child.listeners.get('close')?.size ?? 0).toBe(0)
    expect(client.child.listeners.get('error')?.size ?? 0).toBe(0)
    cleaned(client)
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
      message: 'original model diagnostic\nworker stderr diagnostic\nAgent 收尾未确认：stop unavailable',
      cause: expect.objectContaining({ message: 'original model diagnostic\nworker stderr diagnostic' }),
      cleanupError: expect.objectContaining({ message: cleanupError.message, cause: cleanupError, closeUnknown: true }),
      closeUnknown: true
    })
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('shares a rejected stop during cancellation and handles both rejection paths', async () => {
    rpc.FakeRpc.dispatch = async () => 'started'
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({
      message: 'Agent 已取消\nAgent 收尾未确认：stop unavailable',
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

  it('stops during pending dispatch and holds its reservation until the original RPC rejects', async () => {
    const dispatch = deferred<Disposition>()
    rpc.FakeRpc.dispatch = () => dispatch.promise
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    let finished = false
    void result.catch(() => { finished = true })
    await worker.cancel(input.id)
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    const client = rpc.FakeRpc.instances[0]
    cleaned(client)
    dispatch.reject(new Error('late dispatch diagnostic'))
    await rejected
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    cleaned(client)
  })

  it('counts both cancelled startups against capacity until each settles', async () => {
    const preparation = [deferred<void>(), deferred<void>()]
    let next = 0
    rpc.FakeRpc.configure = (client) => {
      const pending = preparation[next++]
      client.start.mockImplementationOnce(() => {
        client.process = client.child
        return pending.promise
      })
    }
    const worker = runner()
    const progress = vi.fn()
    const first = worker.run({ ...input, id: 'first', cwd: '/fake/first' }, progress)
    const second = worker.run({ ...input, id: 'second', cwd: '/fake/second' }, progress)
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    await Promise.all([worker.cancel('first'), worker.cancel('second')])
    await flush()
    await expect(worker.run({ ...input, id: 'third', cwd: '/fake/third' }, vi.fn())).rejects.toThrow(/并发上限/)
    expect(() => worker.assertWorktreeDeletionIdle('/fake/first')).toThrow(/尚未确认/)
    expect(() => worker.assertWorktreeDeletionIdle('/fake/second')).toThrow(/尚未确认/)
    expect(progress).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const retainedClients = [...rpc.FakeRpc.instances]
    preparation[0].resolve(undefined)
    await firstRejected
    expect(() => worker.assertWorktreeDeletionIdle('/fake/first')).not.toThrow()
    expect(() => worker.assertWorktreeDeletionIdle('/fake/second')).toThrow(/尚未确认/)
    rpc.FakeRpc.configure = () => undefined
    await expect(worker.run({ ...input, id: 'third', cwd: '/fake/third' }, vi.fn())).resolves.toMatchObject({ sessionPath: '/fake/session.jsonl' })
    preparation[1].reject(new Error('late preparation failure'))
    await secondRejected
    expect(() => worker.assertWorktreeDeletionIdle('/fake/second')).not.toThrow()
    expect(progress).not.toHaveBeenCalled()
    expect(rpc.FakeRpc.instances).toHaveLength(3)
    for (const client of retainedClients) {
      expect(client.prompt).not.toHaveBeenCalled()
      cleaned(client)
    }
  })

  it('retains a pending final state RPC after cancellation without publishing its late result', async () => {
    const state = deferred<{ sessionFile: string }>()
    rpc.FakeRpc.configure = (client) => {
      client.getState.mockResolvedValueOnce({ sessionFile: '/fake/session.jsonl' })
        .mockImplementationOnce(() => state.promise)
    }
    const worker = runner()
    const progress = vi.fn()
    const result = worker.run(input, progress)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    expect(client.getState).toHaveBeenCalledTimes(2)
    await worker.cancel(input.id)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    state.resolve({ sessionFile: '/fake/late.jsonl' })
    await rejected
    expect(progress).toHaveBeenCalledExactlyOnceWith('Agent 已启动')
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    cleaned(client)
  })

  it('retains both slots after stop deadlines and recovers each id/cwd only after real close', async () => {
    rpc.FakeRpc.configure = (client) => {
      client.stop.mockImplementationOnce(async () => { client.process = null })
    }
    const worker = runner()
    const first = worker.run(input, vi.fn())
    const second = worker.run({ ...input, id: 'second', cwd: '/fake/second' }, vi.fn())
    const firstRejected = expect(first).rejects.toThrow(/process exit and stdio close/)
    const secondRejected = expect(second).rejects.toThrow(/process exit and stdio close/)
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([firstRejected, secondRejected])
    const [firstClient, secondClient] = rpc.FakeRpc.instances
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    await expect(worker.run(input, vi.fn())).rejects.toThrow(/仍被保留/)
    await expect(worker.run({ ...input, id: 'new-id' }, vi.fn())).rejects.toThrow(/尚未确认/)
    await expect(worker.run({ ...input, id: 'third', cwd: '/fake/third' }, vi.fn())).rejects.toThrow(/并发上限/)
    firstClient.child.exitCode = 0
    firstClient.child.emit('exit')
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    firstClient.child.close()
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(() => worker.assertWorktreeDeletionIdle('/fake/second')).toThrow(/尚未确认/)
    rpc.FakeRpc.configure = () => undefined
    await expect(worker.run(input, vi.fn())).resolves.toMatchObject({ sessionPath: '/fake/session.jsonl' })
    secondClient.child.close()
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle('/fake/second')).not.toThrow()
    for (const client of [firstClient, secondClient]) {
      expect(client.child.listeners.get('exit')?.size ?? 0).toBe(0)
      expect(client.child.listeners.get('close')?.size ?? 0).toBe(0)
      expect(client.child.listeners.get('error')?.size ?? 0).toBe(0)
      cleaned(client)
    }
  })

  it.each(['close-first', 'rpc-first'] as const)('retains the worker until late close plus original RPC both settle (%s)', async (order) => {
    const dispatch = deferred<Disposition>()
    rpc.FakeRpc.dispatch = () => dispatch.promise
    rpc.FakeRpc.configure = (client) => {
      client.stop.mockImplementationOnce(async () => { client.process = null })
    }
    const worker = runner()
    const progress = vi.fn()
    const result = worker.run(input, progress)
    const rejected = expect(result).rejects.toMatchObject({
      message: expect.stringMatching(/Agent 已取消\nAgent 收尾未确认/), closeUnknown: true
    })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    const cancellation = worker.cancel(input.id)
    const cancelRejected = expect(cancellation).rejects.toThrow(/process exit and stdio close/)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([rejected, cancelRejected])
    if (order === 'close-first') {
      client.child.close()
      await flush()
      expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
      await worker.cancel(input.id)
      expect(client.stop).toHaveBeenCalledTimes(1)
      dispatch.resolve('handled')
    } else {
      dispatch.resolve('handled')
      await flush()
      expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
      client.child.close()
    }
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(client.getState).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledExactlyOnceWith('Agent 已启动')
    cleaned(client)
  })

  it('rechecks shutdown after late process/RPC cleanup without repeating stop or dispatch', async () => {
    const dispatch = deferred<Disposition>()
    rpc.FakeRpc.dispatch = () => dispatch.promise
    rpc.FakeRpc.configure = (client) => { client.stop.mockImplementationOnce(async () => { client.process = null }) }
    const workflows = new WorkflowManager({
      filePath: '/fake/workflows.json', worktreeRoot: '/fake/worktrees', workerRunner: runner(),
      permissionExtensionPath: async () => '/fake/permission-extension.ts', verification: { run: vi.fn(), cancel: vi.fn() }
    })
    const internal = workflows as unknown as {
      workflows: Map<string, WorkflowSnapshot>
      changed(workflow: WorkflowSnapshot): Promise<void>
      launch(workflow: WorkflowSnapshot, operation: () => Promise<void>): void
      runAgent(workflow: WorkflowSnapshot, role: 'planner', cwd: string, prompt: string): Promise<string>
    }
    vi.spyOn(internal, 'changed').mockResolvedValue(undefined)
    const save = vi.spyOn(workflows, 'flush').mockResolvedValue(undefined)
    const value: WorkflowSnapshot = { version: 1, id: '12345678-1234-4234-8234-123456789abc', cwd: input.cwd, goal: input.prompt,
      state: 'planning', createdAt: 1, updatedAt: 1, revision: 0, workers: [], worktrees: {}, repairAttempts: 0, maxRepairAttempts: 2 }
    internal.workflows.set(value.id, value)
    internal.launch(value, async () => { await internal.runAgent(value, 'planner', input.cwd, input.prompt) })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    expect(client.prompt).toHaveBeenCalledOnce()
    const rejected = expect(workflows.shutdown()).rejects.toMatchObject({ closeUnknown: true })
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(value.workers[0]).toMatchObject({ status: 'interrupted', exitConfirmed: false })
    client.child.close()
    await flush()
    await expect(workflows.shutdown()).rejects.toMatchObject({ closeUnknown: true })
    dispatch.resolve('handled')
    await flush()
    save.mockRejectedValueOnce(new Error('shutdown save failed'))
    await expect(workflows.shutdown()).rejects.toThrow('shutdown save failed')
    await expect(workflows.shutdown()).resolves.toBeUndefined()
    expect(value.workers[0]).toMatchObject({ status: 'interrupted', exitConfirmed: true })
    await expect(workflows.start(value.id)).rejects.toThrow(/已关闭/)
    expect(rpc.FakeRpc.instances).toHaveLength(1)
    expect(client.prompt).toHaveBeenCalledOnce()
    cleaned(client)
  })

  it('marks a started client with no process handle as unknown and retains its reservation', async () => {
    rpc.FakeRpc.configure = (client) => { client.start.mockResolvedValueOnce(undefined) }
    const worker = runner()
    await expect(worker.run(input, vi.fn())).rejects.toMatchObject({
      message: expect.stringContaining('process handle missing after start'), closeUnknown: true
    })
    const client = rpc.FakeRpc.instances[0]
    expect(client.stop).not.toHaveBeenCalled()
    expect(client.listeners.size).toBe(0)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    await expect(worker.cancel(input.id)).rejects.toMatchObject({ closeUnknown: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks process errors as unknown even after the SDK stop later rejects and the child closes', async () => {
    const stop = deferred<void>()
    rpc.FakeRpc.configure = (client) => { client.stop.mockImplementationOnce(() => stop.promise) }
    const worker = runner()
    const result = worker.run(input, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({
      message: 'Agent 收尾未确认：process failure', closeUnknown: true,
      cleanupError: expect.objectContaining({ message: 'process failure', closeUnknown: true })
    })
    await flush()
    const client = rpc.FakeRpc.instances[0]
    client.child.emit('error', new Error('process failure'))
    await rejected
    stop.reject(new Error('late SDK rejection'))
    client.child.close()
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    expect(client.child.listeners.get('error')?.size ?? 0).toBe(0)
    cleaned(client)
  })

  it('releases ordinary provider errors after actual cleanup without marking unknown close', async () => {
    rpc.FakeRpc.dispatch = async () => { throw new Error('ordinary provider failure') }
    const worker = runner()
    const result = await worker.run(input, vi.fn()).then(
      () => { throw new Error('expected provider failure') },
      (error: unknown) => error
    )
    expect(result).toMatchObject({ message: 'ordinary provider failure' })
    expect(result).not.toHaveProperty('closeUnknown')
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    cleaned(rpc.FakeRpc.instances[0])
  })

  it('honors an already revoked signal before permission preparation', async () => {
    const controller = new AbortController()
    controller.abort()
    const prepare = vi.fn(async () => '/fake/extension.ts')
    await expect(new PiWorkflowWorkerRunner(prepare).run({ ...input, signal: controller.signal }, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    expect(prepare).not.toHaveBeenCalled()
    expect(rpc.FakeRpc.instances).toHaveLength(0)
  })
})

describe('VerificationWorkflowRunner cancellation ownership', () => {
  function service() {
    return {
      discover: vi.fn(async () => ({ steps: [{ kind: 'test' }] })),
      start: vi.fn(async (_cwd: string, _options: StartVerificationOptions, _signal?: AbortSignal) => ({ id: 'verification-1', steps: [{}] })),
      cancel: vi.fn(async (): Promise<void> => undefined),
      listRuns: vi.fn((): VerificationRun[] => []),
      waitForRun: vi.fn(async (_runId: string): Promise<void> => undefined),
      assertWorktreeDeletionIdle: vi.fn()
    }
  }

  it('releases normal discovery without commands and permits another run', async () => {
    const fake = service()
    fake.discover.mockResolvedValue({ steps: [] })
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    for (let index = 0; index < 2; index += 1) {
      await expect(worker.run(input.cwd, vi.fn())).resolves.toMatchObject({ state: 'not-found' })
      expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    }
    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.cancel).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases successful verification only after its real terminal barrier settles', async () => {
    const fake = service()
    fake.listRuns.mockReturnValue([{ id: 'verification-1', cwd: input.cwd, state: 'passed', createdAt: 1,
      steps: [], selectedKinds: [], repairAttempt: 0, revision: 0 }])
    const settlement = deferred<void>()
    fake.waitForRun.mockImplementationOnce(() => settlement.promise)
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const result = worker.run(input.cwd, vi.fn())
    await flush()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    settlement.resolve(undefined)
    await expect(result).resolves.toMatchObject({ state: 'passed', runId: 'verification-1' })
    expect(fake.waitForRun).toHaveBeenCalledExactlyOnceWith('verification-1')
    expect(fake.cancel).not.toHaveBeenCalled()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains unknown verification shutdown even after the service later appears idle', async () => {
    const fake = service()
    fake.listRuns.mockReturnValue([{ id: 'verification-1', cwd: input.cwd, state: 'passed', createdAt: 1,
      steps: [], selectedKinds: [], repairAttempt: 0, revision: 0 }])
    fake.waitForRun.mockRejectedValueOnce(Object.assign(new Error('command close unknown'), { closeUnknown: true }))
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    await expect(worker.run(input.cwd, vi.fn())).rejects.toThrow('command close unknown')
    expect(fake.cancel).toHaveBeenCalledExactlyOnceWith('verification-1')
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    await expect(worker.run(input.cwd, vi.fn())).rejects.toThrow(/尚未确认/)
    expect(fake.start).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['discover', 'start', 'execution'] as const)('releases an ordinary settled %s error without retaining unknown close', async (stage) => {
    const fake = service()
    const error = new Error(`ordinary ${stage} error`)
    if (stage === 'discover') fake.discover.mockRejectedValueOnce(error)
    if (stage === 'start') fake.start.mockRejectedValueOnce(error)
    if (stage === 'execution') {
      fake.listRuns.mockReturnValue([{ id: 'verification-1', cwd: input.cwd, state: 'passed', createdAt: 1,
        steps: [], selectedKinds: [], repairAttempt: 0, revision: 0 }])
      fake.waitForRun.mockRejectedValueOnce(error)
    }
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const failure = await worker.run(input.cwd, vi.fn()).catch((reason: unknown) => reason)
    expect(failure).toMatchObject({ message: error.message })
    expect(failure).not.toHaveProperty('closeUnknown')
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    fake.discover.mockResolvedValue({ steps: [] })
    await expect(worker.run(input.cwd, vi.fn())).resolves.toMatchObject({ state: 'not-found' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins a pending cancellation after an ordinary execution error and preserves that error', async () => {
    const fake = service()
    const error = new Error('verification save failed')
    fake.listRuns.mockReturnValue([{ id: 'verification-1', cwd: input.cwd, state: 'passed', createdAt: 1,
      steps: [], selectedKinds: [], repairAttempt: 0, revision: 0 }])
    fake.waitForRun.mockRejectedValueOnce(error)
    const cancellation = deferred<void>()
    fake.cancel.mockImplementationOnce(() => cancellation.promise)
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const result = worker.run(input.cwd, vi.fn())
    const rejected = expect(result).rejects.toMatchObject({ message: error.message })
    let finished = false
    void result.catch(() => { finished = true })
    await flush()
    expect(fake.waitForRun).toHaveBeenCalledExactlyOnceWith('verification-1')
    expect(fake.cancel).toHaveBeenCalledExactlyOnceWith('verification-1')
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    cancellation.reject(new Error('ordinary cancellation save failure'))
    await rejected
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps real execution pending after ordinary cancellation failure', async () => {
    const fake = service()
    const controller = new AbortController()
    const cancellationError = new Error('cancellation save failed')
    fake.cancel.mockRejectedValueOnce(cancellationError)
    const execution = deferred<void>()
    fake.waitForRun.mockImplementationOnce(() => execution.promise)
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const result = worker.run(input.cwd, () => controller.abort(), controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ message: cancellationError.message })
    let finished = false
    void result.catch(() => { finished = true })
    await flush()
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    execution.resolve(undefined)
    await rejected
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a real close failure visible alongside an earlier task failure', async () => {
    const fake = service()
    const error = new Error('progress callback failed')
    const closeError = Object.assign(new Error('command close unknown'), { closeUnknown: true })
    fake.waitForRun.mockRejectedValueOnce(closeError)
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    await expect(worker.run(input.cwd, () => { throw error })).rejects.toMatchObject({
      message: 'progress callback failed\n验证收尾未确认：command close unknown',
      cause: error, cleanupError: closeError, closeUnknown: true
    })
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    expect(fake.cancel).toHaveBeenCalledExactlyOnceWith('verification-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start verification after cancellation during discovery', async () => {
    const fake = service()
    const discovery = deferred<{ steps: Array<{ kind: string }> }>()
    fake.discover.mockImplementationOnce(() => discovery.promise)
    const controller = new AbortController()
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const result = worker.run(input.cwd, vi.fn(), controller.signal)
    controller.abort()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    discovery.resolve({ steps: [{ kind: 'test' }] })
    await expect(result).resolves.toMatchObject({ state: 'cancelled' })
    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.cancel).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'timeout'] as const)('revokes the service second discovery on %s before it can issue a command', async (reason) => {
    const command = new CommandRunner()
    const execute = vi.spyOn(command, 'run').mockRejectedValue(new Error('unexpected command'))
    const verification = new VerificationService('/fake/verification.json', command)
    vi.spyOn(verification, 'flush').mockResolvedValue(undefined)
    const plan: VerificationPlan = {
      cwd: input.cwd, discoveredAt: 1, warnings: [],
      steps: [{ id: 'test', kind: 'test', label: 'test', executable: '/fake/command',
        args: [], cwd: input.cwd, source: 'fixture', timeoutMs: 1000 }]
    }
    const discovery = deferred<VerificationPlan>()
    const discover = vi.spyOn(verification, 'discover').mockResolvedValueOnce(plan)
      .mockImplementationOnce(() => discovery.promise)
    const controller = new AbortController()
    const progress = vi.fn()
    const worker = new VerificationWorkflowRunner(verification)
    const result = worker.run(input.cwd, progress, controller.signal)
    let finished = false
    void result.then(() => { finished = true }, () => undefined)
    await flush()
    expect(discover).toHaveBeenCalledTimes(2)
    if (reason === 'cancel') controller.abort()
    else await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    expect(execute).not.toHaveBeenCalled()
    discovery.resolve(plan)
    await expect(result).resolves.toMatchObject({ state: reason === 'cancel' ? 'cancelled' : 'infrastructure-error' })
    expect(execute).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
    expect(verification.listRuns()).toEqual([])
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'timeout'] as const)('retains a terminal snapshot actual settlement barrier during %s', async (reason) => {
    const fake = service()
    fake.listRuns.mockReturnValue([{ id: 'verification-1', cwd: input.cwd, state: 'passed', createdAt: 1,
      steps: [], selectedKinds: [], repairAttempt: 0, revision: 0 }])
    const settlement = deferred<void>()
    fake.waitForRun.mockImplementation(() => settlement.promise)
    const controller = new AbortController()
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const result = worker.run(input.cwd, vi.fn(), controller.signal)
    let finished = false
    void result.then(() => { finished = true }, () => undefined)
    await flush()
    expect(fake.waitForRun).toHaveBeenCalledWith('verification-1')
    const privateSignal = fake.start.mock.calls[0][2]
    expect(privateSignal).toBeInstanceOf(AbortSignal)
    if (reason === 'cancel') controller.abort()
    else await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(privateSignal?.aborted).toBe(true)
    expect(finished).toBe(false)
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    settlement.resolve(undefined)
    await expect(result).resolves.toMatchObject({ state: reason === 'cancel' ? 'cancelled' : 'infrastructure-error' })
    expect(fake.cancel).toHaveBeenCalledExactlyOnceWith('verification-1')
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('owns a pending start, cancels its late run once, and suppresses stale progress', async () => {
    const fake = service()
    const startup = deferred<{ id: string; steps: object[] }>()
    fake.start.mockImplementationOnce(() => startup.promise)
    const controller = new AbortController()
    const progress = vi.fn()
    const worker = new VerificationWorkflowRunner(fake as unknown as VerificationService)
    const result = worker.run(input.cwd, progress, controller.signal)
    await flush()
    expect(fake.start).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow(/尚未确认/)
    startup.resolve({ id: 'late-run', steps: [{}] })
    await expect(result).resolves.toMatchObject({ state: 'cancelled', runId: 'late-run' })
    expect(fake.cancel).toHaveBeenCalledExactlyOnceWith('late-run')
    expect(progress).not.toHaveBeenCalled()
    expect(fake.listRuns).not.toHaveBeenCalled()
    fake.assertWorktreeDeletionIdle.mockImplementation(() => { throw new Error('command close unknown') })
    expect(() => worker.assertWorktreeDeletionIdle(input.cwd)).toThrow('command close unknown')
  })
})
