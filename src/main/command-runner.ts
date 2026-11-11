import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { getSystemErrorName } from 'node:util'

export interface CommandSpec {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

export interface CommandChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface CommandResult {
  exitCode?: number
  signal?: string
  durationMs: number
  cancelled: boolean
  timedOut: boolean
  spawnError?: string
  /** Actual exit/stdio close (or proven failed spawn), with termination helpers joined. */
  closeConfirmed?: boolean
  /** A recognized Node validation/spawn failure proves execution never began. */
  spawnNotExecuted?: true
}

interface ActiveCommand {
  child: ChildProcess
  cancelled: boolean
  timedOut: boolean
  closed: Promise<void>
  closeObserved: boolean
  termination?: Promise<void>
  terminationUnknown?: boolean
}

type SpawnFailure = NodeJS.ErrnoException & { spawnargs?: unknown }

function knownSpawnErrno(error: SpawnFailure): boolean {
  if (!['ENOENT', 'EACCES', 'EINVAL'].includes(error.code ?? '') || typeof error.errno !== 'number' || error.errno >= 0) return false
  try { return getSystemErrorName(error.errno) === error.code } catch { return false }
}

function synchronousSpawnNotExecuted(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const failure = error as SpawnFailure
  return (error instanceof TypeError || error instanceof RangeError)
    && ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE'].includes(failure.code ?? '')
    || failure.syscall === 'spawn' && knownSpawnErrno(failure)
}

function spawnNotExecuted(
  child: ChildProcess, failure: SpawnFailure | undefined, executable: string, args: string[],
  code: number | null, signal: string | null, spawned: boolean, output: boolean
): boolean {
  return Boolean(failure && knownSpawnErrno(failure) && !spawned && !output && child.pid === undefined
    && signal === null && code === failure.errno && failure.path === executable && failure.syscall === `spawn ${executable}`
    && Array.isArray(failure.spawnargs) && failure.spawnargs.length === args.length
    && failure.spawnargs.every((arg, index) => arg === args[index])
    && child.spawnfile === executable && child.spawnargs.length === args.length + 1
    && child.spawnargs[0] === executable && child.spawnargs.slice(1).every((arg, index) => arg === args[index]))
}

const TERMINATION_GRACE_MS = 2_000

/** Cancellable argv-only process runner shared by verification and workflows. */
export class CommandRunner {
  private readonly active = new Map<string, ActiveCommand>()

  isRunning(id: string): boolean {
    return this.active.has(id)
  }

  async run(
    id: string,
    spec: CommandSpec,
    onChunk: (chunk: CommandChunk) => void
  ): Promise<CommandResult> {
    if (this.active.has(id)) throw new Error(`命令 ${id} 已在运行`)
    const startedAt = Date.now()
    let child: ChildProcess
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          ...spec.env
        }
      })
    } catch (error) {
      return {
        spawnError: error instanceof Error ? error.message : String(error),
        spawnNotExecuted: synchronousSpawnNotExecuted(error) ? true : undefined,
        durationMs: Math.max(0, Date.now() - startedAt),
        cancelled: false,
        timedOut: false
      }
    }
    let confirmClose!: () => void
    const active: ActiveCommand = { child, cancelled: false, timedOut: false, closeObserved: false,
      closed: new Promise<void>((done) => { confirmClose = done }) }
    this.active.set(id, active)

    let output = false
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    child.stdout?.on('data', (data: Buffer) => {
      output ||= data.length > 0
      const text = stdout.write(data)
      if (text) onChunk({ stream: 'stdout', text })
    })
    child.stderr?.on('data', (data: Buffer) => {
      output ||= data.length > 0
      const text = stderr.write(data)
      if (text) onChunk({ stream: 'stderr', text })
    })

    return new Promise<CommandResult>((resolve) => {
      let settled = false
      let spawnError: string | undefined
      let failure: SpawnFailure | undefined
      let errorCount = 0
      let spawned = false
      let exit: { code: number | null; signal: string | null } | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (result: Omit<CommandResult, 'durationMs'>): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        const stdoutRest = stdout.end()
        const stderrRest = stderr.end()
        if (stdoutRest) onChunk({ stream: 'stdout', text: stdoutRest })
        if (stderrRest) onChunk({ stream: 'stderr', text: stderrRest })
        this.active.delete(id)
        resolve({ ...result, durationMs: Math.max(0, Date.now() - startedAt) })
      }

      timeout = setTimeout(() => {
        active.timedOut = true
        void this.terminate(active)
      }, Math.max(1_000, spec.timeoutMs))

      // Node emits close after a failed spawn as well. Keep the command and
      // its listeners reserved until that receipt arrives; error alone may
      // also describe a failed kill of a process that is still running.
      child.once('spawn', () => { spawned = true })
      child.once('exit', (code, signal) => { exit = { code, signal } })
      child.on('error', (error: SpawnFailure) => {
        spawnError ??= error.message
        failure ??= error
        errorCount += 1
      })
      child.once('close', (code, signal) => {
        active.closeObserved = true
        confirmClose()
        if (timeout) clearTimeout(timeout)
        const notExecuted = !exit && errorCount === 1
          && spawnNotExecuted(child, failure, spec.executable, spec.args, code, signal, spawned, output)
        // The original child can close before taskkill. Retain this command
        // until both processes and their stdio have actually settled.
        void Promise.resolve().then(async () => {
          await active.termination
          finish({
            spawnError,
            closeConfirmed: !active.terminationUnknown && (notExecuted || Boolean(exit && exit.code === code && exit.signal === signal)),
            spawnNotExecuted: notExecuted && !active.terminationUnknown ? true : undefined,
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
            cancelled: active.cancelled,
            timedOut: active.timedOut
          })
        })
      })
    })
  }

  async cancel(id: string): Promise<boolean> {
    const active = this.active.get(id)
    if (!active) return false
    active.cancelled = true
    await this.terminate(active)
    return true
  }

  private taskkill(pid: number, force = false): Promise<void> {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
    let killer: ChildProcess
    try { killer = spawn('taskkill', args, { shell: false, stdio: 'ignore' }) }
    catch (error) {
      return Promise.reject(Object.assign(new Error(String(error)), { closeUnknown: !synchronousSpawnNotExecuted(error) }))
    }
    return new Promise<void>((resolve, reject) => {
      let failure: SpawnFailure | undefined
      let spawned = false
      let exited = false
      killer.once('spawn', () => { spawned = true })
      killer.once('exit', () => { exited = true })
      killer.on('error', (error: SpawnFailure) => { failure ??= error })
      killer.once('close', (code, signal) => {
        if (!exited && !spawnNotExecuted(killer, failure, 'taskkill', args, code, signal, spawned, false)) {
          reject(Object.assign(new Error('taskkill 实际收尾尚未确认'), { closeUnknown: true }))
        } else if (failure || code !== 0) reject(failure ?? new Error(`taskkill exited with ${code}`))
        else resolve()
      })
    })
  }

  private terminate(active: ActiveCommand): Promise<void> {
    return active.termination ??= this.terminateReserved(active)
  }

  private async terminateReserved(active: ActiveCommand): Promise<void> {
    const { child } = active
    if (active.closeObserved) return
    const pid = child.pid
    const recordFailure = (error: unknown): void => {
      if ((error as { closeUnknown?: boolean } | null)?.closeUnknown) active.terminationUnknown = true
    }
    try {
      if (process.platform === 'win32' && pid) {
        await this.taskkill(pid)
      } else if (pid) {
        process.kill(-pid, 'SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
    } catch (error) {
      recordFailure(error)
      try { child.kill('SIGTERM') } catch { /* The real close still owns completion. */ }
    }

    let grace: ReturnType<typeof setTimeout> | undefined
    await Promise.race([active.closed, new Promise<void>((done) => { grace = setTimeout(done, TERMINATION_GRACE_MS) })])
    if (grace) clearTimeout(grace)
    if (active.closeObserved) return
    try {
      if (process.platform === 'win32' && pid) {
        await this.taskkill(pid, true)
      } else if (pid) {
        process.kill(-pid, 'SIGKILL')
      } else {
        child.kill('SIGKILL')
      }
    } catch (error) {
      recordFailure(error)
      try { child.kill('SIGKILL') } catch { /* The real close still owns completion. */ }
    }
    await active.closed
  }
}
