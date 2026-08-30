import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

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
}

interface ActiveCommand {
  child: ChildProcess
  cancelled: boolean
  timedOut: boolean
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
    const child = spawn(spec.executable, spec.args, {
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
    const active: ActiveCommand = { child, cancelled: false, timedOut: false }
    this.active.set(id, active)

    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    child.stdout?.on('data', (data: Buffer) => {
      const text = stdout.write(data)
      if (text) onChunk({ stream: 'stdout', text })
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = stderr.write(data)
      if (text) onChunk({ stream: 'stderr', text })
    })

    return new Promise<CommandResult>((resolve) => {
      let settled = false
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
        void this.terminate(child)
      }, Math.max(1_000, spec.timeoutMs))

      child.once('error', (error) => {
        finish({
          cancelled: active.cancelled,
          timedOut: active.timedOut,
          spawnError: error.message
        })
      })
      child.once('close', (code, signal) => {
        finish({
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
          cancelled: active.cancelled,
          timedOut: active.timedOut
        })
      })
    })
  }

  async cancel(id: string): Promise<boolean> {
    const active = this.active.get(id)
    if (!active) return false
    active.cancelled = true
    await this.terminate(active.child)
    return true
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return
    const pid = child.pid
    try {
      if (process.platform === 'win32' && pid) {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T'], {
          shell: false,
          stdio: 'ignore'
        })
        await new Promise<void>((resolve) => killer.once('close', () => resolve()))
      } else if (pid) {
        process.kill(-pid, 'SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      try { child.kill('SIGTERM') } catch { /* process already exited */ }
    }

    await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))
    if (child.exitCode !== null) return
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore' })
      } else if (pid) {
        process.kill(-pid, 'SIGKILL')
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      try { child.kill('SIGKILL') } catch { /* process already exited */ }
    }
  }
}
