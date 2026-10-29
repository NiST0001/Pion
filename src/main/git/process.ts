import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { GIT_TIMEOUT_MS, MAX_GIT_OUTPUT } from './constants'

export interface GitProcessOptions {
  input?: string | Buffer
  allowExitCodes?: number[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

function collectChild(
  child: ChildProcess,
  options: GitProcessOptions,
  args: string[]
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let closed = false
    let failure: Error | undefined
    const recordError = (error: Error): void => {
      if (closed || failure) return
      failure = error
      clearTimeout(timeout)
      stdout.length = 0
      stderr.length = 0
      // A signal request leaves the operation pending until the actual close.
      try { child.kill('SIGKILL') } catch { /* keep waiting for close */ }
    }
    const timeout = setTimeout(() => {
      recordError(new Error(`Git 命令超时：git ${args.join(' ')}`))
    }, options.timeoutMs ?? GIT_TIMEOUT_MS)
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (closed || failure) return
      if (chunk.length > MAX_GIT_OUTPUT - bytes) {
        recordError(new Error('Git 输出超过 32 MiB 限制，请缩小审查范围'))
        return
      }
      bytes += chunk.length
      chunks.push(chunk)
    }

    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.stdout?.on('error', recordError)
    child.stderr?.on('error', recordError)
    child.stdin?.on('error', recordError)
    child.on('error', recordError)
    child.once('close', (code) => {
      closed = true
      clearTimeout(timeout)
      if (failure) {
        reject(failure)
        return
      }
      const allowed = options.allowExitCodes ?? [0]
      if (!allowed.includes(code ?? -1)) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(detail || `git ${args[0] ?? ''} 失败（${code ?? 'unknown'}）`))
        return
      }
      resolvePromise(Buffer.concat(stdout))
    })
    try {
      if (options.input !== undefined) child.stdin?.end(options.input)
      else child.stdin?.end()
    } catch (error) {
      recordError(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function runGitBuffer(
  cwd: string,
  args: string[],
  options: GitProcessOptions = {}
): Promise<Buffer> {
  const child = spawn('git', args, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env }
  })
  return collectChild(child, options, args)
}

export async function runGitText(
  cwd: string,
  args: string[],
  options: GitProcessOptions = {}
): Promise<string> {
  return (await runGitBuffer(cwd, args, options)).toString('utf8').trim()
}

