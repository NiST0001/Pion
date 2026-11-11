import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { getSystemErrorMap } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRunner } from '../../src/main/command-runner'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

function child(executable = spec.executable, args: string[] = []): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), spawnfile: executable, spawnargs: [executable, ...args],
    exitCode: null, signalCode: null, killed: false, kill: vi.fn()
  }) as unknown as ChildProcess
}

const enoent = [...getSystemErrorMap()].find(([, [code]]) => code === 'ENOENT')![0]
function missingError() {
  return Object.assign(new Error('spawn missing-command ENOENT'), {
    code: 'ENOENT', errno: enoent, syscall: `spawn ${spec.executable}`, path: spec.executable, spawnargs: []
  })
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks() })

const spec = { executable: 'missing-command', args: [], cwd: process.cwd(), timeoutMs: 60_000 }

describe('CommandRunner close receipts', () => {
  it('records a synchronous spawn rejection as unexecuted without inventing close', async () => {
    mocks.spawn.mockImplementationOnce(() => { throw Object.assign(new TypeError('invalid argv'), { code: 'ERR_INVALID_ARG_VALUE' }) })
    const runner = new CommandRunner()
    const result = await runner.run('invalid', spec, vi.fn())
    expect(result).toMatchObject({ spawnError: 'invalid argv', spawnNotExecuted: true })
    expect(result.closeConfirmed).toBeUndefined()
    expect(runner.isRunning('invalid')).toBe(false)
    mocks.spawn.mockImplementationOnce(() => { throw new Error('unclassified spawn failure') })
    const unknown = await runner.run('unknown', spec, vi.fn())
    expect(unknown.spawnNotExecuted).toBeUndefined()
    expect(unknown.closeConfirmed).toBeUndefined()
  })

  it('retains errors and late output until the actual close event', async () => {
    const process = child()
    mocks.spawn.mockReturnValueOnce(process)
    const runner = new CommandRunner()
    const onChunk = vi.fn()
    const pending = runner.run('command', spec, onChunk)
    let settled = false
    void pending.then(() => { settled = true })
    process.emit('spawn')
    process.emit('error', new Error('kill failed'))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(runner.isRunning('command')).toBe(true)
    await expect(runner.run('command', spec, onChunk)).rejects.toThrow('已在运行')
    process.stdout!.emit('data', Buffer.from('late output'))
    process.emit('exit', 1, null)
    process.emit('close', 1, null)
    await expect(pending).resolves.toMatchObject({
      exitCode: 1, spawnError: 'kill failed', closeConfirmed: true
    })
    expect(onChunk).toHaveBeenCalledWith({ stream: 'stdout', text: 'late output' })
    expect(runner.isRunning('command')).toBe(false)
  })

  it('records a failed spawn only after its real negative-errno close', async () => {
    const process = child()
    mocks.spawn.mockReturnValueOnce(process)
    const runner = new CommandRunner()
    const pending = runner.run('missing', spec, vi.fn())
    process.emit('error', missingError())
    expect(runner.isRunning('missing')).toBe(true)
    process.emit('close', enoent, null)
    await expect(pending).resolves.toMatchObject({
      exitCode: enoent, spawnError: 'spawn missing-command ENOENT', closeConfirmed: true, spawnNotExecuted: true,
      cancelled: false, timedOut: false
    })
    expect(runner.isRunning('missing')).toBe(false)
  })

  it.each(['ordinary-error', 'wrong-path', 'spawned', 'output'] as const)('retains unknown no-pid closure with %s', async (invalid) => {
    const process = child()
    mocks.spawn.mockReturnValueOnce(process)
    const runner = new CommandRunner()
    const pending = runner.run('unknown', spec, vi.fn())
    if (invalid === 'spawned') process.emit('spawn')
    if (invalid === 'output') process.stdout!.emit('data', Buffer.from('unexpected'))
    const error = invalid === 'ordinary-error' ? new Error('failed') : missingError()
    if (invalid === 'wrong-path') Object.assign(error, { path: 'other-command' })
    process.emit('error', error)
    process.emit('close', enoent, null)
    await expect(pending).resolves.toMatchObject({ closeConfirmed: false })
    expect((await pending).spawnNotExecuted).toBeUndefined()
  })

  it.each(['original-first', 'helper-first'] as const)('joins both Windows closes: %s', async (order) => {
    vi.useFakeTimers()
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
    const original = Object.assign(child(), { pid: 42 })
    const gentle = child('taskkill', ['/PID', '42', '/T'])
    const force = child('taskkill', ['/PID', '42', '/T', '/F'])
    mocks.spawn.mockReturnValueOnce(original).mockReturnValueOnce(gentle).mockReturnValueOnce(force)
    const runner = new CommandRunner()
    const pending = runner.run('windows', spec, vi.fn())
    let cancelled = false
    let settled = false
    const cancellation = runner.cancel('windows').then(() => { cancelled = true })
    void pending.then(() => { settled = true })
    gentle.emit('exit', 0, null)
    gentle.emit('close', 0, null)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.spawn).toHaveBeenCalledTimes(3)
    const closeOriginal = (): void => { original.emit('exit', null, 'SIGTERM'); original.emit('close', null, 'SIGTERM') }
    const closeHelper = (): void => { force.emit('exit', 0, null); force.emit('close', 0, null) }
    if (order === 'original-first') closeOriginal()
    else closeHelper()
    await Promise.resolve()
    expect(cancelled).toBe(false)
    expect(settled).toBe(false)
    expect(runner.isRunning('windows')).toBe(true)
    if (order === 'original-first') closeHelper()
    else closeOriginal()
    await cancellation
    await expect(pending).resolves.toMatchObject({ cancelled: true, closeConfirmed: true })
    expect(runner.isRunning('windows')).toBe(false)
  })
})
