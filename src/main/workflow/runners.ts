import { RpcClient } from '@earendil-works/pi-coding-agent'
import { resolve, sep } from 'node:path'
import type { VerificationRun } from '../../shared/operations'
import type { VerificationService } from '../verification'
import { piCliPath } from '../pi-runtime'
import { stopWithProcessExit } from '../process-exit'
import { ACTIVE_VERIFICATION, MAX_ACTIVE_WORKERS, WORKER_TIMEOUT_MS } from './constants'
import { clip } from './utils'
import type {
  WorkflowVerificationResult,
  WorkflowVerificationRunner,
  WorkflowWorkerInput,
  WorkflowWorkerResult,
  WorkflowWorkerRunner
} from './types'

function workerTools(role: WorkflowWorkerInput['role']): string {
  return role === 'implementer'
    ? 'read,grep,find,ls,write,edit'
    : 'read,grep,find,ls'
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === 'object'))
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n')
}

function respondToUi(client: RpcClient, id: string, value: string): void {
  const process = (client as unknown as {
    process?: { stdin?: { destroyed?: boolean; writable?: boolean; write(value: string): unknown } } | null
  }).process
  const stdin = process?.stdin
  if (!stdin || stdin.destroyed || stdin.writable === false) return
  stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, value })}\n`)
}

/** Isolated Pi runner. Explicit CLI flags disable discovered extensions, skills and project resources. */
export class PiWorkflowWorkerRunner implements WorkflowWorkerRunner {
  private readonly clients = new Map<string, { cwd: string; cancel: () => void; stop: () => Promise<void> }>()

  constructor(private readonly permissionExtensionPath: () => Promise<string>) {}

  assertWorktreeDeletionIdle(cwd: string): void {
    const target = resolve(cwd)
    if ([...this.clients.values()].some((worker) => worker.cwd === target
      || worker.cwd.startsWith(`${target}${sep}`) || target.startsWith(`${worker.cwd}${sep}`))) {
      throw new Error('Agent 进程或收尾尚未确认，工作树已保留')
    }
  }

  async run(input: WorkflowWorkerInput, onProgress: (message: string) => void): Promise<WorkflowWorkerResult> {
    if (this.clients.has(input.id)) throw new Error('此 worker 的操作或收尾仍被保留')
    this.assertWorktreeDeletionIdle(input.cwd)
    if (this.clients.size >= MAX_ACTIVE_WORKERS) throw new Error('多 Agent 并发上限为 2，请等待当前 worker 完成')
    const deadline = Date.now() + WORKER_TIMEOUT_MS
    let client: RpcClient | undefined
    let operationError: Error | undefined
    let rejectFailure!: (error: Error) => void
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
    void failure.catch(() => undefined)
    const fail = (error: Error): void => {
      if (operationError) return
      operationError = error
      rejectFailure(error)
    }
    const timeoutError = (): Error => new Error(`Timeout waiting for Agent completion. Stderr: ${client?.getStderr() ?? ''}`)
    const check = (): void => {
      if (!operationError && Date.now() >= deadline) fail(timeoutError())
      if (operationError) throw operationError
    }
    const pending = new Set<Promise<unknown>>()
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise)
      void promise.then(() => pending.delete(promise), () => pending.delete(promise))
      return promise
    }
    const wait = async <T>(effect: () => Promise<T>): Promise<T> => {
      // A rejected race stops admission, while the original effect retains its
      // reservation until it actually settles.
      check()
      const result = await Promise.race([track(effect()), failure])
      check()
      return result
    }
    let stopped: Promise<void> | undefined
    let cleanedUp: Promise<void> | undefined
    let startInvoked = false
    const stop = (): Promise<void> => {
      const target = client
      // A preparation-stage cancellation must not cache a no-client stop.
      if (!target) return Promise.resolve()
      // SDK start spawns synchronously, before its initialization await. Do not
      // wait for start's promise here: it can remain pending indefinitely.
      return stopped ??= stopWithProcessExit(target, startInvoked)
    }
    const operation = {
      cwd: resolve(input.cwd),
      cancel: () => {
        if (operationError || this.clients.get(input.id) !== operation) return
        const error = new Error('Agent 已取消')
        error.name = 'AbortError'
        fail(error)
        // Abort is best effort and never delays stop, but its actual RPC still
        // retains the reservation alongside preparation/start/prompt/state.
        if (client && startInvoked) {
          try { track(client.abort()) } catch { /* Stop still owns process cleanup. */ }
        }
      },
      stop
    }
    const cleanup = (): Promise<void> => cleanedUp ??= (async () => {
      // Stop first: SDK initialization/RPC can otherwise remain pending forever.
      await stop()
      while (pending.size > 0) await Promise.allSettled([...pending])
      if (this.clients.get(input.id) === operation) this.clients.delete(input.id)
    })()
    // Preparation counts toward both concurrency and the operation deadline.
    this.clients.set(input.id, operation)
    const onAbort = (): void => operation.cancel()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) operation.cancel()
    const timer = setTimeout(() => fail(timeoutError()), Math.max(0, deadline - Date.now()))
    let output = ''
    let stopReason = ''
    let errorMessage = ''
    let sawFinalMessage = false
    let dispatched = false
    let disposition: Awaited<ReturnType<RpcClient['prompt']>> | undefined
    let active = false
    let settled = false
    let complete!: () => void
    const completion = new Promise<void>((resolve) => { complete = resolve })
    const finishIfReady = (): void => {
      // A handled input may still have started independent extension work.
      if (dispatched && !active && (settled || disposition === 'handled')) complete()
    }
    const record = (message: { content?: unknown; stopReason?: string; errorMessage?: string }): void => {
      output = assistantText(message)
      stopReason = message.stopReason ?? ''
      errorMessage = message.errorMessage ?? ''
    }
    let primaryFailure: unknown
    let failed = false
    let unsubscribe = (): void => {}
    try {
      const extensionPath = await wait(() => this.permissionExtensionPath())
      check()
      client = new RpcClient({
        cliPath: piCliPath(),
        cwd: input.cwd,
        args: [
          '--no-approve',
          '--no-extensions',
          '--no-skills',
          '--extension', extensionPath,
          '--tools', workerTools(input.role)
        ],
        env: {
          PION_TOOL_PERMISSION_CONFIG: input.permissionConfigPath,
          PION_WORKFLOW_ID: input.workflowId,
          PION_WORKFLOW_ROLE: input.role
        }
      })
      const currentClient = client
      check()
      unsubscribe = currentClient.onEvent((event) => {
        try { check() } catch { return }
        const value = event as unknown as {
          type?: string
          id?: string
          method?: string
          title?: string
          toolName?: string
          message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }
          messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string; content?: unknown }>
        }
        if (value.type === 'extension_ui_request' && value.method === 'select' && value.id) {
          onProgress('已拒绝超出 worker 权限信封的工具请求')
          // Progress callbacks can synchronously cancel this operation.
          try { check() } catch { return }
          respondToUi(currentClient, value.id, 'deny')
        }
        if (value.type === 'tool_execution_start' && value.toolName) {
          onProgress(`运行工具：${value.toolName}`)
          try { check() } catch { return }
        }
        if (value.type === 'agent_start' || value.type === 'run_started') {
          active = true
          settled = false
          sawFinalMessage = false
        }
        if (value.type === 'message_end' && value.message?.role === 'assistant') {
          sawFinalMessage = true
          record(value.message)
        }
        if (value.type === 'agent_end' && !sawFinalMessage) {
          const assistant = [...(value.messages ?? [])].reverse().find((message) => message.role === 'assistant')
          if (assistant) record(assistant)
        }
        if (value.type === 'agent_settled') {
          active = false
          settled = true
          finishIfReady()
        }
      })
      await wait(() => {
        startInvoked = true
        return currentClient.start()
      })
      await wait(() => currentClient.getState())
      check()
      onProgress('Agent 已启动')
      disposition = await wait(() => currentClient.prompt(input.prompt))
      dispatched = true
      finishIfReady()
      // This is a logical event gate, separate from the actual prompt RPC.
      await Promise.race([completion, failure])
      check()
      const state = await wait(() => currentClient.getState().catch(() => null))
      check()
      if (!output && state?.sessionFile) onProgress('Agent 已结束，正在保存会话')
      check()
      if (stopReason === 'error') {
        throw new Error([errorMessage || output || 'Agent 返回错误', currentClient.getStderr()].filter(Boolean).join('\n'))
      }
      // A provider's ordinary aborted final message is not a worker failure.
      if (stopReason === 'aborted' && !output) output = 'Agent 已取消'
      return { output: output || 'Agent 已完成，但没有返回文本输出。', sessionPath: state?.sessionFile }
    } catch (error) {
      failed = true
      primaryFailure = error
      throw error
    } finally {
      clearTimeout(timer)
      try {
        unsubscribe()
      } finally {
        try {
          await cleanup()
        } catch (cleanupError) {
          const diagnostic = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          const primary = primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure)
          throw Object.assign(new Error([
            ...(failed ? [primary] : []),
            `Agent 收尾未确认：${diagnostic}`
          ].join('\n')), { cause: failed ? primaryFailure : cleanupError, cleanupError })
        } finally {
          input.signal?.removeEventListener('abort', onAbort)
        }
        if (!failed && operationError) throw operationError
      }
    }
  }

  async cancel(workerId: string): Promise<void> {
    const worker = this.clients.get(workerId)
    if (!worker) return
    worker.cancel()
    // Acknowledges only the stop request/barrier. run() still owns all actual
    // preparation and RPC promises, and keeps id/cwd/capacity reserved.
    await worker.stop()
  }
}

export class VerificationWorkflowRunner implements WorkflowVerificationRunner {
  private readonly operations = new Set<{ cwd: string; runId?: string; cancel: () => Promise<void> }>()

  constructor(private readonly service: VerificationService) {}

  assertWorktreeDeletionIdle(cwd: string): void {
    const target = resolve(cwd)
    if ([...this.operations].some((operation) => operation.cwd === target
      || operation.cwd.startsWith(`${target}${sep}`) || target.startsWith(`${operation.cwd}${sep}`))) {
      throw new Error('验证准备或收尾尚未确认，工作树已保留')
    }
    this.service.assertWorktreeDeletionIdle(cwd)
  }

  async run(cwd: string, onProgress: (message: string, runId?: string) => void, signal?: AbortSignal): Promise<WorkflowVerificationResult> {
    this.assertWorktreeDeletionIdle(cwd)
    const controller = new AbortController()
    let cancelled = signal?.aborted === true
    let timedOut = false
    let cancellation: Promise<void> | undefined
    let startInvoked = false
    let unknown = false
    let executionSettled = false
    const deadline = Date.now() + WORKER_TIMEOUT_MS
    const operation = {
      cwd: resolve(cwd),
      runId: undefined as string | undefined,
      cancel: (): Promise<void> => {
        cancelled = true
        controller.abort()
        if (!operation.runId) return Promise.resolve()
        return cancellation ??= this.service.cancel(operation.runId).then(() => undefined)
      }
    }
    const onAbort = (): void => { void operation.cancel().catch(() => undefined) }
    const revoked = (): boolean => {
      if (!cancelled && Date.now() >= deadline) {
        timedOut = true
        onAbort()
      }
      return cancelled
    }
    const cancelledResult = (): WorkflowVerificationResult => timedOut
      ? { runId: operation.runId, state: 'infrastructure-error', summary: '验证超过 30 分钟，已请求取消。' }
      : { runId: operation.runId, state: 'cancelled', summary: '验证已取消。' }
    this.operations.add(operation)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      if (!cancelled) { timedOut = true; onAbort() }
    }, WORKER_TIMEOUT_MS)
    try {
      if (revoked()) return cancelledResult()
      const plan = await this.service.discover(cwd, true)
      if (revoked()) return cancelledResult()
      if (plan.steps.length === 0) {
        return { state: 'not-found', summary: '未发现 typecheck、lint、test 或 build 命令。' }
      }
      const kinds = [...new Set(plan.steps.map((step) => step.kind))]
      startInvoked = true
      const started = await this.service.start(cwd, { kinds }, controller.signal)
      operation.runId = started.id
      // The same private signal reaches start's own discovery, before a run ID
      // exists. A late start remains owned and never publishes stale progress.
      if (revoked()) { await operation.cancel(); return cancelledResult() }
      onProgress(`已启动 ${started.steps.length} 个验证步骤`, started.id)
      let lastProgress = ''
      while (!revoked()) {
        const current = this.service.listRuns(cwd).find((run) => run.id === started.id)
        if (revoked()) break
        if (!current) throw new Error('验证记录在运行期间丢失')
        if (!ACTIVE_VERIFICATION.has(current.state)) {
          await this.service.waitForRun(started.id)
          executionSettled = true
          if (revoked()) break
          const settled = this.service.listRuns(cwd).find((run) => run.id === started.id)
          if (!settled) throw new Error('验证记录在收尾期间丢失')
          return this.result(settled)
        }
        const active = current.steps.find((step) => step.state === 'running')
        const progress = active ? `正在运行：${active.label}` : ''
        if (progress && progress !== lastProgress) {
          lastProgress = progress
          onProgress(progress, current.id)
          if (revoked()) break
        }
        await new Promise((done) => setTimeout(done, 250))
      }
      await operation.cancel()
      return cancelledResult()
    } catch (error) {
      if (revoked() && error instanceof Error && error.name === 'AbortError') return cancelledResult()
      unknown = startInvoked
      if (startInvoked) await operation.cancel()
      throw error
    } finally {
      clearTimeout(timer)
      try {
        // Cancellation/terminal UI state never substitutes for the real
        // command, flush, repair and cancellation promises settling.
        if (operation.runId && !executionSettled) await this.service.waitForRun(operation.runId)
        if (cancellation) await cancellation
      } catch (error) {
        unknown = true
        throw error
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (!unknown) this.operations.delete(operation)
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    const operation = [...this.operations].find((item) => item.runId === runId)
    if (operation) await operation.cancel()
    else await this.service.cancel(runId)
  }

  private result(run: VerificationRun): WorkflowVerificationResult {
    const failed = run.steps.find((step) => step.state === 'failed' || step.state === 'infrastructure-error')
    const summary = failed
      ? `${failed.label}：${clip(failed.outputTail || failed.error || '验证失败', 4_000).text}`
      : run.state === 'passed'
        ? `${run.steps.length} 个验证步骤全部通过。`
        : run.error || `验证状态：${run.state}`
    return { runId: run.id, state: run.state, summary }
  }
}
