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
    let settled = false
    const finishError = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(message))
    }
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      finishError(`Git 命令超时：git ${args.join(' ')}`)
    }, options.timeoutMs ?? GIT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_GIT_OUTPUT) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        finishError('Git 输出超过 32 MiB 限制，请缩小审查范围')
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => finishError(error.message))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const allowed = options.allowExitCodes ?? [0]
      if (!allowed.includes(code ?? -1)) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(detail || `git ${args[0] ?? ''} 失败（${code ?? 'unknown'}）`))
        return
      }
      resolvePromise(Buffer.concat(stdout))
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
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

