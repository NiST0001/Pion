import { RpcClient } from '@earendil-works/pi-coding-agent'
import type { VerificationRun } from '../../shared/operations'
import type { VerificationService } from '../verification'
import { piCliPath } from '../pi-runtime'
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
  private readonly clients = new Map<string, RpcClient>()

  constructor(private readonly permissionExtensionPath: () => Promise<string>) {}

  async run(input: WorkflowWorkerInput, onProgress: (message: string) => void): Promise<WorkflowWorkerResult> {
    if (this.clients.size >= MAX_ACTIVE_WORKERS) throw new Error('多 Agent 并发上限为 2，请等待当前 worker 完成')
    const extensionPath = await this.permissionExtensionPath()
    const client = new RpcClient({
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
    this.clients.set(input.id, client)
    let output = ''
    let stopReason = ''
    const unsubscribe = client.onEvent((event) => {
      const value = event as unknown as {
        type?: string
        id?: string
        method?: string
        title?: string
        toolName?: string
        messages?: Array<{ role?: string; stopReason?: string; content?: unknown }>
      }
      if (value.type === 'extension_ui_request' && value.method === 'select' && value.id) {
        onProgress('已拒绝超出 worker 权限信封的工具请求')
        respondToUi(client, value.id, 'deny')
      }
      if (value.type === 'tool_execution_start' && value.toolName) {
        onProgress(`运行工具：${value.toolName}`)
      }
      if (value.type === 'agent_end') {
        const assistant = [...(value.messages ?? [])].reverse().find((message) => message.role === 'assistant')
        output = assistantText(assistant)
        stopReason = assistant?.stopReason ?? ''
      }
    })

    try {
      await client.start()
      await client.getState()
      onProgress('Agent 已启动')
      await client.prompt(input.prompt)
      await client.waitForIdle(WORKER_TIMEOUT_MS)
      const state = await client.getState().catch(() => null)
      if (!output && state?.sessionFile) onProgress('Agent 已结束，正在保存会话')
      if (stopReason === 'error') throw new Error(client.getStderr() || 'Agent 返回错误')
      if (stopReason === 'aborted') throw new Error('Agent 已取消')
      return { output: output || 'Agent 已完成，但没有返回文本输出。', sessionPath: state?.sessionFile }
    } finally {
      unsubscribe()
      this.clients.delete(input.id)
      await client.stop().catch(() => undefined)
    }
  }

  async cancel(workerId: string): Promise<void> {
    const client = this.clients.get(workerId)
    if (!client) return
    await client.abort().catch(() => undefined)
    await client.stop().catch(() => undefined)
  }
}

export class VerificationWorkflowRunner implements WorkflowVerificationRunner {
  constructor(private readonly service: VerificationService) {}

  async run(cwd: string, onProgress: (message: string, runId?: string) => void): Promise<WorkflowVerificationResult> {
    const plan = await this.service.discover(cwd, true)
    if (plan.steps.length === 0) {
      return { state: 'not-found', summary: '未发现 typecheck、lint、test 或 build 命令。' }
    }
    const kinds = [...new Set(plan.steps.map((step) => step.kind))]
    const started = await this.service.start(cwd, { kinds })
    onProgress(`已启动 ${started.steps.length} 个验证步骤`, started.id)
    const deadline = Date.now() + WORKER_TIMEOUT_MS
    let lastProgress = ''
    while (Date.now() < deadline) {
      const current = this.service.listRuns(cwd).find((run) => run.id === started.id)
      if (!current) throw new Error('验证记录在运行期间丢失')
      if (!ACTIVE_VERIFICATION.has(current.state)) return this.result(current)
      const active = current.steps.find((step) => step.state === 'running')
      const progress = active ? `正在运行：${active.label}` : ''
      if (progress && progress !== lastProgress) {
        lastProgress = progress
        onProgress(progress, current.id)
      }
      await new Promise((done) => setTimeout(done, 250))
    }
    await this.service.cancel(started.id)
    return { runId: started.id, state: 'infrastructure-error', summary: '验证超过 30 分钟，已取消。' }
  }

  async cancel(runId: string): Promise<void> {
    await this.service.cancel(runId).catch(() => undefined)
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
