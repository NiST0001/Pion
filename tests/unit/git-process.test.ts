import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_GIT_OUTPUT } from '../../src/main/git/constants'
import { runGitBuffer } from '../../src/main/git/process'
import { stopWithProcessExit } from '../../src/main/process-exit'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../src/main/git/constants', () => ({ GIT_TIMEOUT_MS: 100, MAX_GIT_OUTPUT: 8 }))

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    kill: vi.fn(() => true)
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}

function observe(promise: Promise<unknown>) {
  const settled = vi.fn()
  void promise.then(settled, settled)
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(spawn).mockReset()
})
afterEach(() => vi.useRealTimers())

describe('RPC process exit and stdio barrier', () => {
  function rpcClient() {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdio: [{ closed: false }, { closed: false }, { closed: false }]
    })
    const client = { process: child as typeof child | null, stop: vi.fn(async (): Promise<void> => { client.process = null }) }
    const stop = (started = true) => stopWithProcessExit(client as unknown as Parameters<typeof stopWithProcessExit>[0], started)
    return { child, client, stop }
  }

  it('captures the SDK process before stop clears it and waits for exit plus pipe close', async () => {
    const { child, client, stop } = rpcClient()
    const promise = stop()
    const settled = observe(promise)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.process).toBeNull()
    expect(settled).not.toHaveBeenCalled()
    child.exitCode = 0
    child.emit('exit', 0, null)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    child.stdio.forEach((stream) => { stream.closed = true })
    child.emit('close', 0, null)
    await expect(promise).resolves.toBeUndefined()
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(child.eventNames()).toEqual([])
  })

  it('rejects missing pipe handles, including sparse stdio arrays, before stopping', async () => {
    const { child, client, stop } = rpcClient()
    delete child.stdio[1]
    await expect(stop()).rejects.toThrow(/^incompatible SDK RpcClient process\/stdio adapter$/)
    expect(client.stop).not.toHaveBeenCalled()
  })

  it('requires positive never-started state for a null SDK process handle', async () => {
    const { client, stop } = rpcClient()
    client.process = null
    await expect(stop()).rejects.toThrow(/handle missing after start/)
    expect(client.stop).not.toHaveBeenCalled()
    await expect(stop(false)).resolves.toBeUndefined()
    expect(client.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps a deadline failure rejected after a late exit and pipe close', async () => {
    const { child, stop } = rpcClient()
    const promise = stop()
    const rejected = expect(promise).rejects.toThrow(/Timed out waiting/)
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.stdio.forEach((stream) => { stream.closed = true })
    child.emit('close', 0, null)
    await expect(promise).rejects.toThrow(/Timed out waiting/)
    expect(child.eventNames()).toEqual([])
  })
})

describe('Git process actual close', () => {
  it('collects successful stdout and ends stdin while waiting for close', async () => {
    const child = mockChild()
    const promise = runGitBuffer('/repo', ['apply', '-'], { input: 'patch' })
    const settled = observe(promise)
    child.stdout.emit('data', Buffer.from('ok'))
    child.stderr.emit('data', Buffer.from('note'))
    child.emit('exit', 0)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith('patch')
    child.emit('close', 0)
    await expect(promise).resolves.toEqual(Buffer.from('ok'))
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps a timeout pending after a failed kill until a delayed close', async () => {
    const child = mockChild()
    child.kill.mockReturnValue(false)
    const promise = runGitBuffer('/repo', ['status'], { timeoutMs: 10 })
    const settled = observe(promise)
    await vi.advanceTimersByTimeAsync(10)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    child.stdout.emit('data', Buffer.alloc(MAX_GIT_OUTPUT + 1))
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('close', 0)
    await expect(promise).rejects.toThrow('Git 命令超时')
  })

  it.each(['child', 'stdin', 'stdout', 'stderr'] as const)('retains the first %s error until actual close', async (source) => {
    const child = mockChild()
    const promise = runGitBuffer('/repo', ['show', ':2:file.txt'])
    const settled = observe(promise)
    const failure = new Error(`${source} failed`)
    const emitter = source === 'child' ? child : child[source]
    emitter.emit('error', failure)
    child.emit('error', new Error('later failure'))
    child.stderr.emit('data', Buffer.alloc(MAX_GIT_OUTPUT + 1))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('close', 1)
    await expect(promise).rejects.toBe(failure)
  })

  it.each(['stdout', 'stderr'] as const)('shares the output budget with %s and waits for close on overflow', async (stream) => {
    const child = mockChild()
    const promise = runGitBuffer('/repo', ['status'])
    const settled = observe(promise)
    child[stream].emit('data', Buffer.alloc(MAX_GIT_OUTPUT))
    child[stream === 'stdout' ? 'stderr' : 'stdout'].emit('data', Buffer.from('x'))
    child[stream].emit('data', Buffer.alloc(MAX_GIT_OUTPUT))
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    child.emit('close', null, 'SIGKILL')
    await expect(promise).rejects.toThrow('Git 输出超过 32 MiB 限制')
  })

  it('holds synchronous stdin and kill errors until close', async () => {
    const child = mockChild()
    const failure = new Error('stdin write failed')
    child.stdin.end.mockImplementation(() => { throw failure })
    child.kill.mockImplementation(() => { throw new Error('kill failed') })
    const promise = runGitBuffer('/repo', ['apply', '-'], { input: Buffer.from('patch') })
    const settled = observe(promise)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).not.toHaveBeenCalled()
    child.emit('close', 1)
    await expect(promise).rejects.toBe(failure)
  })

  it('reports bounded stderr for a nonzero close and preserves allowed exit codes', async () => {
    const child = mockChild()
    const promise = runGitBuffer('/repo', ['status'])
    observe(promise)
    child.stderr.emit('data', Buffer.from('denied'))
    child.emit('close', 1)
    await expect(promise).rejects.toThrow('denied')

    const allowedChild = mockChild()
    const allowed = runGitBuffer('/repo', ['diff'], { allowExitCodes: [1] })
    allowedChild.stdout.emit('data', Buffer.from('diff'))
    allowedChild.emit('close', 1)
    await expect(allowed).resolves.toEqual(Buffer.from('diff'))
  })
})
