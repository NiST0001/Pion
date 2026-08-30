import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { getPackageDir, RpcClient } from '@earendil-works/pi-coding-agent'
import { IPC_EVENTS } from '../shared/ipc'
import type { VerificationRun, VerificationRunState } from '../shared/operations'
import {
  isWorkflowRunning,
  type CreateWorkflowRequest,
  type WorkflowPermissionEnvelope,
  type WorkflowRole,
  type WorkflowSnapshot,
  type WorkflowState,
  type WorkflowUpdate,
  type WorkflowWorker
} from '../shared/workflows'
import type { VerificationService } from './verification'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 24_000
const MAX_PROMPT_CONTEXT = 48_000
const MAX_GOAL = 8_000
const WORKER_TIMEOUT_MS = 30 * 60 * 1_000
const MAX_ACTIVE_WORKERS = 2
const ACTIVE_VERIFICATION = new Set<VerificationRunState>(['queued', 'running'])

interface WorkflowFile {
  version: 1
  workflows: WorkflowSnapshot[]
}

export interface WorkflowWorkerInput {
  id: string
  workflowId: string
  role: Exclude<WorkflowRole, 'tester'>
  cwd: string
  prompt: string
  permissionConfigPath: string
}

export interface WorkflowWorkerResult {
  output: string
  sessionPath?: string
}

export interface WorkflowWorkerRunner {
  run(input: WorkflowWorkerInput, onProgress: (message: string) => void): Promise<WorkflowWorkerResult>
  cancel(workerId: string): Promise<void>
}

export interface WorkflowVerificationResult {
  runId?: string
  state: VerificationRunState | 'not-found'
  summary: string
}

export interface WorkflowVerificationRunner {
  run(cwd: string, onProgress: (message: string, runId?: string) => void): Promise<WorkflowVerificationResult>
  cancel(runId: string): Promise<void>
}

interface WorkflowManagerOptions {
  filePath: string
  worktreeRoot: string
  permissionExtensionPath: () => Promise<string>
  verification: WorkflowVerificationRunner
  workerRunner?: WorkflowWorkerRunner
  projectTrusted?: (cwd: string) => boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function clip(value: string, max = MAX_OUTPUT): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false }
  return { text: `…${value.slice(value.length - max)}`, truncated: true }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function permissionFor(role: WorkflowRole): WorkflowPermissionEnvelope {
  if (role === 'implementer') {
    return {
      read: true,
      write: true,
      shell: false,
      network: false,
      external: false,
      note: '仅候选 worktree 的内置读写工具；Shell、网络、外部工具和项目插件均禁用。'
    }
  }
  return {
    read: true,
    write: false,
    shell: false,
    network: false,
    external: false,
    note: role === 'tester'
      ? '只运行 Pion 已发现的验证命令；不授予模型写入权限。'
      : '只读内置工具；项目插件、递归委派、Shell、网络和写入均禁用。'
  }
}

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
      cliPath: join(getPackageDir(), 'dist', 'cli.js'),
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }
    })
    return stdout.trim()
  } catch (error) {
    if (allowFailure) return ''
    const detail = error as { stderr?: string; stdout?: string; message?: string }
    throw new Error((detail.stderr || detail.stdout || detail.message || 'Git 命令失败').trim())
  }
}

function managedPath(root: string, path: string): boolean {
  const base = resolve(root)
  const target = resolve(path)
  return target === base || target.startsWith(`${base}${sep}`)
}

function normalizeLoaded(value: unknown): WorkflowSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const workflow = value as Partial<WorkflowSnapshot>
  if (typeof workflow.id !== 'string' || typeof workflow.cwd !== 'string' || typeof workflow.goal !== 'string') return null
  if (typeof workflow.state !== 'string' || typeof workflow.createdAt !== 'number') return null
  return {
    version: 1,
    id: workflow.id,
    cwd: resolve(workflow.cwd),
    goal: workflow.goal,
    state: workflow.state as WorkflowState,
    createdAt: workflow.createdAt,
    updatedAt: typeof workflow.updatedAt === 'number' ? workflow.updatedAt : workflow.createdAt,
    revision: typeof workflow.revision === 'number' ? workflow.revision : 0,
    baseOid: workflow.baseOid,
    targetBranch: workflow.targetBranch,
    candidateBranch: workflow.candidateBranch,
    candidateOid: workflow.candidateOid,
    mergeOid: workflow.mergeOid,
    plan: workflow.plan,
    review: workflow.review,
    verification: workflow.verification,
    workers: Array.isArray(workflow.workers) ? workflow.workers : [],
    worktrees: workflow.worktrees ?? {},
    repairAttempts: typeof workflow.repairAttempts === 'number' ? workflow.repairAttempts : 0,
    maxRepairAttempts: typeof workflow.maxRepairAttempts === 'number' ? workflow.maxRepairAttempts : 2,
    blockedReason: workflow.blockedReason,
    interruptedFrom: workflow.interruptedFrom,
    error: workflow.error,
    testsWaivedAt: workflow.testsWaivedAt,
    cleanupCompletedAt: workflow.cleanupCompletedAt
  }
}

export class WorkflowManager {
  private readonly filePath: string
  private readonly worktreeRoot: string
  private readonly verification: WorkflowVerificationRunner
  private readonly runner: WorkflowWorkerRunner
  private readonly projectTrusted: (cwd: string) => boolean
  private readonly workflows = new Map<string, WorkflowSnapshot>()
  private readonly operations = new Set<string>()
  private win: BrowserWindow | null = null
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: WorkflowManagerOptions) {
    this.filePath = resolve(options.filePath)
    this.worktreeRoot = resolve(options.worktreeRoot)
    this.verification = options.verification
    this.runner = options.workerRunner ?? new PiWorkflowWorkerRunner(options.permissionExtensionPath)
    this.projectTrusted = options.projectTrusted ?? (() => true)
  }

  bind(win: BrowserWindow): void {
    this.win = win
  }

  unbind(win: BrowserWindow): void {
    if (this.win === win) this.win = null
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<WorkflowFile>
      for (const item of parsed.workflows ?? []) {
        const workflow = normalizeLoaded(item)
        if (!workflow) continue
        if (isWorkflowRunning(workflow.state) || workflow.state === 'waiting_permission') {
          workflow.interruptedFrom = workflow.state
          workflow.state = 'interrupted'
          workflow.error = 'Pion 在工作流完成前退出；不会自动恢复 Agent 或命令。'
          workflow.workers = workflow.workers.map((worker) => worker.status === 'running'
            ? { ...worker, status: 'interrupted', finishedAt: Date.now(), error: '应用退出' }
            : worker)
          workflow.updatedAt = Date.now()
          workflow.revision += 1
        }
        this.workflows.set(workflow.id, workflow)
      }
    } catch {
      // Missing or malformed storage starts empty.
    }
    await this.flush()
  }

  list(cwd?: string): WorkflowSnapshot[] {
    const root = cwd ? resolve(cwd) : undefined
    return [...this.workflows.values()]
      .filter((workflow) => !root || workflow.cwd === root || root.startsWith(`${workflow.cwd}${sep}`))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 30)
      .map(clone)
  }

  get(id: string): WorkflowSnapshot | null {
    const workflow = this.workflows.get(id)
    return workflow ? clone(workflow) : null
  }

  async create(request: CreateWorkflowRequest): Promise<WorkflowSnapshot> {
    const goal = request.goal.trim()
    if (!goal) throw new Error('请输入多 Agent 工作流目标')
    if (goal.length > MAX_GOAL) throw new Error(`工作流目标不能超过 ${MAX_GOAL} 个字符`)
    const root = resolve(await git(resolve(request.cwd), ['rev-parse', '--show-toplevel']))
    const now = Date.now()
    const workflow: WorkflowSnapshot = {
      version: 1,
      id: randomUUID(),
      cwd: root,
      goal,
      state: 'awaiting_start',
      createdAt: now,
      updatedAt: now,
      revision: 0,
      workers: [],
      worktrees: {},
      repairAttempts: 0,
      maxRepairAttempts: 2
    }
    this.workflows.set(workflow.id, workflow)
    await this.changed(workflow)
    return clone(workflow)
  }

  async start(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state !== 'awaiting_start' && workflow.state !== 'draft') {
      throw new Error('此工作流当前不能启动')
    }
    this.ensureIdle(workflow)
    if (!this.projectTrusted(workflow.cwd)) {
      throw new Error('多 Agent 与自动验证会执行仓库代码；请先信任项目资源或移除不受信任的项目配置')
    }
    workflow.state = 'preparing'
    workflow.error = undefined
    await this.changed(workflow)
    this.launch(workflow, () => this.plan(workflow))
    return clone(workflow)
  }

  async approvePlan(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state !== 'awaiting_plan' || !workflow.plan) throw new Error('没有可批准的计划')
    this.ensureIdle(workflow)
    workflow.state = 'implementing'
    workflow.error = undefined
    await this.changed(workflow)
    this.launch(workflow, () => this.implementReviewTest(workflow, false))
    return clone(workflow)
  }

  async repair(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state !== 'blocked') throw new Error('只有被阻塞的工作流可以修复')
    if (workflow.repairAttempts >= workflow.maxRepairAttempts) throw new Error('此工作流已达到自动修复上限')
    if (!workflow.worktrees.implementer || !workflow.plan) throw new Error('候选 worktree 不可用')
    this.ensureIdle(workflow)
    workflow.repairAttempts += 1
    workflow.state = 'implementing'
    workflow.error = undefined
    await this.changed(workflow)
    this.launch(workflow, () => this.implementReviewTest(workflow, true))
    return clone(workflow)
  }

  async waiveTests(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state !== 'blocked' || workflow.blockedReason !== 'no-verification') {
      throw new Error('当前工作流没有可豁免的缺失验证')
    }
    workflow.testsWaivedAt = Date.now()
    workflow.verification = {
      ...workflow.verification,
      state: 'waived',
      summary: '用户明确豁免：项目未发现自动验证命令。',
      finishedAt: Date.now()
    }
    workflow.state = 'awaiting_merge'
    workflow.blockedReason = undefined
    workflow.error = undefined
    await this.changed(workflow)
    return clone(workflow)
  }

  async resume(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state !== 'interrupted') throw new Error('此工作流不处于中断状态')
    this.ensureIdle(workflow)
    const previous = workflow.interruptedFrom
    workflow.error = undefined
    if (!workflow.baseOid || previous === 'preparing' || previous === 'planning') {
      workflow.state = 'preparing'
      await this.changed(workflow)
      this.launch(workflow, () => this.plan(workflow))
    } else if (previous === 'merging') {
      const head = await git(workflow.cwd, ['rev-parse', 'HEAD'])
      workflow.state = head === workflow.candidateOid ? 'completed' : 'awaiting_merge'
      if (head === workflow.candidateOid) workflow.mergeOid = head
      await this.changed(workflow)
    } else {
      workflow.state = 'implementing'
      await this.changed(workflow)
      this.launch(workflow, () => this.implementReviewTest(workflow, true))
    }
    return clone(workflow)
  }

  async cancel(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state === 'merging') throw new Error('快进合并已开始，不能安全中断 Git 操作')
    if (!isWorkflowRunning(workflow.state) && workflow.state !== 'waiting_permission') {
      if (workflow.state === 'awaiting_start' || workflow.state === 'awaiting_plan' || workflow.state === 'blocked' || workflow.state === 'interrupted') {
        workflow.state = 'cancelled'
        workflow.error = undefined
        await this.changed(workflow)
      }
      return clone(workflow)
    }
    workflow.state = 'cancelling'
    await this.changed(workflow)
    const active = workflow.workers.find((worker) => worker.status === 'running')
    if (active?.kind === 'agent') await this.runner.cancel(active.id)
    if (active?.kind === 'command' && workflow.verification?.runId) {
      await this.verification.cancel(workflow.verification.runId)
    }
    workflow.workers = workflow.workers.map((worker) => worker.status === 'running'
      ? { ...worker, status: 'cancelled', finishedAt: Date.now(), error: '用户取消' }
      : worker)
    workflow.state = 'cancelled'
    workflow.error = undefined
    await this.changed(workflow)
    return clone(workflow)
  }

  async merge(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (workflow.state !== 'awaiting_merge') throw new Error('工作流尚未到达可合并状态')
    if (!workflow.baseOid || !workflow.candidateOid || !workflow.candidateBranch || !workflow.targetBranch) {
      throw new Error('工作流缺少 Git 合并元数据')
    }
    if (workflow.review?.verdict !== 'pass') throw new Error('审查尚未通过')
    if (workflow.verification?.state !== 'passed' && workflow.verification?.state !== 'waived') {
      throw new Error('验证尚未通过或明确豁免')
    }
    this.ensureIdle(workflow)
    workflow.state = 'merging'
    workflow.error = undefined
    await this.changed(workflow)
    try {
      const [branch, head, dirty, candidate] = await Promise.all([
        git(workflow.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        git(workflow.cwd, ['rev-parse', 'HEAD']),
        git(workflow.cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
        git(workflow.cwd, ['rev-parse', workflow.candidateBranch])
      ])
      if (branch !== workflow.targetBranch || head !== workflow.baseOid || dirty) {
        workflow.state = 'stale'
        workflow.error = '目标分支、基准提交或工作区已变化；Pion 拒绝自动调整目标。'
        await this.changed(workflow)
        return clone(workflow)
      }
      if (candidate !== workflow.candidateOid) {
        workflow.state = 'stale'
        workflow.error = '候选分支在审查后发生变化。'
        await this.changed(workflow)
        return clone(workflow)
      }
      await git(workflow.cwd, ['merge', '--ff-only', workflow.candidateBranch])
      workflow.mergeOid = await git(workflow.cwd, ['rev-parse', 'HEAD'])
      workflow.state = 'completed'
      await this.changed(workflow)
      return clone(workflow)
    } catch (error) {
      workflow.state = 'failed'
      workflow.error = errorMessage(error)
      await this.changed(workflow)
      return clone(workflow)
    }
  }

  async cleanup(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (isWorkflowRunning(workflow.state) || workflow.state === 'merging' || workflow.state === 'cancelling') {
      throw new Error('运行中的工作流不能清理，请先取消')
    }
    this.ensureIdle(workflow)
    for (const path of Object.values(workflow.worktrees)) {
      if (!path || !managedPath(this.worktreeRoot, path)) continue
      await git(workflow.cwd, ['worktree', 'remove', '--force', path], true)
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
    await git(workflow.cwd, ['worktree', 'prune'], true)
    if (workflow.candidateBranch) {
      await git(workflow.cwd, ['branch', '-D', workflow.candidateBranch], true)
    }
    workflow.worktrees = {}
    workflow.cleanupCompletedAt = Date.now()
    await this.changed(workflow)
    return clone(workflow)
  }

  async shutdown(): Promise<void> {
    const active = [...this.workflows.values()].filter((workflow) => isWorkflowRunning(workflow.state))
    for (const workflow of active) {
      workflow.interruptedFrom = workflow.state
      workflow.state = 'interrupted'
      workflow.error = 'Pion 已退出；Agent 和命令不会在后台继续。'
      const worker = workflow.workers.find((item) => item.status === 'running')
      if (worker?.kind === 'agent') await this.runner.cancel(worker.id)
      if (worker?.kind === 'command' && workflow.verification?.runId) {
        await this.verification.cancel(workflow.verification.runId)
      }
      workflow.workers = workflow.workers.map((item) => item.status === 'running'
        ? { ...item, status: 'interrupted', finishedAt: Date.now(), error: '应用退出' }
        : item)
      await this.changed(workflow)
    }
    await this.flush()
  }

  flush(): Promise<void> {
    const snapshot = `${JSON.stringify({ version: 1, workflows: [...this.workflows.values()] }, null, 2)}\n`
    const temp = `${this.filePath}.${randomUUID()}.tmp`
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, this.filePath)
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  private require(id: string): WorkflowSnapshot {
    const workflow = this.workflows.get(id)
    if (!workflow) throw new Error('多 Agent 工作流不存在')
    return workflow
  }

  private ensureIdle(workflow: WorkflowSnapshot): void {
    if (this.operations.has(workflow.id)) throw new Error('此工作流已有操作正在进行')
  }

  private launch(workflow: WorkflowSnapshot, operation: () => Promise<void>): void {
    this.operations.add(workflow.id)
    void operation()
      .catch(async (error) => {
        if (workflow.state === 'cancelled' || workflow.state === 'cancelling' || workflow.state === 'interrupted') return
        workflow.state = 'failed'
        workflow.error = errorMessage(error)
        await this.changed(workflow)
      })
      .finally(() => this.operations.delete(workflow.id))
  }

  private async plan(workflow: WorkflowSnapshot): Promise<void> {
    await this.prepare(workflow)
    if (workflow.state === 'cancelled' || workflow.state === 'cancelling') return
    workflow.state = 'planning'
    await this.changed(workflow)
    const worktree = workflow.worktrees.planner
    if (!worktree) throw new Error('规划 worktree 未创建')
    const output = await this.runAgent(workflow, 'planner', worktree, [
      '你是 Pion 多 Agent 工作流中的 Planner。',
      '只读分析当前仓库，不修改文件，不运行 Shell，不委派其他 Agent。',
      `目标：${workflow.goal}`,
      '输出一份可执行计划：范围、文件、步骤、验证、风险与明确的完成条件。'
    ].join('\n\n'))
    workflow.plan = clip(output, MAX_PROMPT_CONTEXT).text
    workflow.state = 'awaiting_plan'
    workflow.error = undefined
    await this.changed(workflow)
  }

  private async prepare(workflow: WorkflowSnapshot): Promise<void> {
    const root = resolve(await git(workflow.cwd, ['rev-parse', '--show-toplevel']))
    workflow.cwd = root
    if (!workflow.baseOid) {
      const dirty = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
      if (dirty) throw new Error('启动多 Agent 工作流前，目标 Git 工作区必须干净')
      workflow.baseOid = await git(root, ['rev-parse', 'HEAD'])
      workflow.targetBranch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (!workflow.targetBranch) throw new Error('目标工作区处于 detached HEAD，无法安全合并')
      workflow.candidateBranch = `pion/${workflow.id.slice(0, 8)}/candidate`
    }

    const baseDir = join(this.worktreeRoot, workflow.id)
    await mkdir(baseDir, { recursive: true })
    const planner = workflow.worktrees.planner ?? join(baseDir, 'planner')
    const implementer = workflow.worktrees.implementer ?? join(baseDir, 'implementer')
    if (!(await exists(join(planner, '.git')))) {
      await rm(planner, { recursive: true, force: true })
      await git(root, ['worktree', 'add', '--detach', planner, workflow.baseOid])
    }
    if (!(await exists(join(implementer, '.git')))) {
      await rm(implementer, { recursive: true, force: true })
      await git(root, ['worktree', 'add', '-b', workflow.candidateBranch!, implementer, workflow.baseOid])
    }
    workflow.worktrees.planner = planner
    workflow.worktrees.implementer = implementer
    await this.writePermissionConfig(workflow)
    await this.changed(workflow)
  }

  private async implementReviewTest(workflow: WorkflowSnapshot, repair: boolean): Promise<void> {
    const implementer = workflow.worktrees.implementer
    if (!implementer || !workflow.plan || !workflow.baseOid) throw new Error('实现阶段缺少工作树或计划')
    workflow.state = 'implementing'
    await this.changed(workflow)
    const feedback = repair
      ? `\n\n上一轮阻塞原因：${workflow.error || workflow.review?.summary || workflow.verification?.summary || '未知'}\n请保留正确修改并修复剩余问题。`
      : ''
    await this.runAgent(workflow, 'implementer', implementer, [
      '你是 Pion 多 Agent 工作流中的 Implementer。',
      '只能通过内置读写工具修改当前隔离 worktree。禁止 Shell、递归委派、安装插件、网络访问、push、merge、rebase、reset --hard 或清理其他工作树。',
      `目标：${workflow.goal}`,
      `已批准计划：\n${workflow.plan}`,
      '实现计划并在结束前检查修改。不要提交；Pion 会在候选分支上创建可审查提交。',
      feedback
    ].join('\n\n'))
    if (this.wasStopped(workflow)) return

    workflow.state = 'integrating'
    await this.changed(workflow)
    const dirty = await git(implementer, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (dirty) {
      await git(implementer, ['add', '--all'])
      await git(implementer, ['commit', '-m', `Pion workflow ${workflow.id.slice(0, 8)} implementation`])
    }
    workflow.candidateOid = await git(implementer, ['rev-parse', 'HEAD'])
    if (this.wasStopped(workflow)) return
    if (workflow.candidateOid === workflow.baseOid) {
      workflow.state = 'blocked'
      workflow.blockedReason = 'no-changes'
      workflow.error = 'Implementer 没有产生候选提交。'
      await this.changed(workflow)
      return
    }

    if (!await this.review(workflow)) return
    await this.test(workflow)
  }

  private async review(workflow: WorkflowSnapshot): Promise<boolean> {
    if (this.wasStopped(workflow)) return false
    if (!workflow.candidateOid || !workflow.baseOid) throw new Error('缺少候选提交')
    workflow.state = 'reviewing'
    workflow.blockedReason = undefined
    await this.changed(workflow)
    const reviewer = await this.recreateDetachedWorktree(workflow, 'reviewer', workflow.candidateOid)
    const stat = await git(workflow.cwd, ['diff', '--stat', `${workflow.baseOid}..${workflow.candidateOid}`])
    const diff = await git(workflow.cwd, ['diff', '--no-ext-diff', '--unified=3', `${workflow.baseOid}..${workflow.candidateOid}`])
    const boundedDiff = diff.length > MAX_PROMPT_CONTEXT ? `${diff.slice(0, MAX_PROMPT_CONTEXT)}\n…差异已截断` : diff
    const output = await this.runAgent(workflow, 'reviewer', reviewer, [
      '你是 Pion 多 Agent 工作流中的 Reviewer。只读审查，不修改文件、不运行 Shell、不委派其他 Agent。',
      `目标：${workflow.goal}`,
      `计划：\n${workflow.plan ?? ''}`,
      `修改摘要：\n${stat}`,
      `候选差异：\n${boundedDiff}`,
      '检查正确性、安全性、回归风险和测试覆盖。最后单独输出 PION_REVIEW_VERDICT: pass 或 PION_REVIEW_VERDICT: fail。'
    ].join('\n\n'))
    const matches = [...output.matchAll(/PION_REVIEW_VERDICT\s*:\s*(pass|fail)\b/ig)]
    const conclusion = matches.at(-1)?.[1]?.toLowerCase()
    const verdict = conclusion === 'pass' ? 'pass' : conclusion === 'fail' ? 'fail' : 'unknown'
    workflow.review = { verdict, summary: clip(output).text, reviewedAt: Date.now() }
    if (verdict !== 'pass') {
      workflow.state = 'blocked'
      workflow.blockedReason = 'review'
      workflow.error = verdict === 'unknown'
        ? 'Reviewer 未返回有效的结构化结论。'
        : 'Reviewer 发现必须修复的问题。'
      await this.changed(workflow)
      return false
    }
    return true
  }

  private async test(workflow: WorkflowSnapshot): Promise<void> {
    if (this.wasStopped(workflow)) return
    if (!workflow.candidateOid) throw new Error('缺少候选提交')
    workflow.state = 'testing'
    await this.changed(workflow)
    const tester = await this.recreateDetachedWorktree(workflow, 'tester', workflow.candidateOid)
    const worker = this.newWorker('tester', 'command', tester)
    workflow.workers.push(worker)
    await this.changed(workflow)
    const result = await this.verification.run(tester, (message, runId) => {
      if (runId) workflow.verification = { runId, state: 'running', summary: message }
      this.appendWorkerOutput(worker, message)
      void this.changed(workflow).catch((error) => {
        console.error('[pion] workflow progress persistence failed:', error)
      })
    })
    if (this.wasStopped(workflow)) return
    worker.status = result.state === 'passed' ? 'completed' : result.state === 'cancelled' ? 'cancelled' : 'failed'
    worker.finishedAt = Date.now()
    this.appendWorkerOutput(worker, result.summary)
    workflow.verification = {
      runId: result.runId,
      state: result.state,
      summary: result.summary,
      finishedAt: Date.now()
    }
    if (result.state === 'not-found') {
      workflow.state = 'blocked'
      workflow.blockedReason = 'no-verification'
      workflow.error = '项目未发现自动验证命令；必须明确豁免后才能合并。'
    } else if (result.state !== 'passed') {
      workflow.state = 'blocked'
      workflow.blockedReason = 'verification'
      workflow.error = '候选提交未通过自动验证。'
    } else {
      workflow.state = 'awaiting_merge'
      workflow.blockedReason = undefined
      workflow.error = undefined
    }
    await this.changed(workflow)
  }

  private async runAgent(
    workflow: WorkflowSnapshot,
    role: Exclude<WorkflowRole, 'tester'>,
    cwd: string,
    prompt: string
  ): Promise<string> {
    const worker = this.newWorker(role, 'agent', cwd)
    workflow.workers.push(worker)
    await this.changed(workflow)
    try {
      const result = await this.runner.run({
        id: worker.id,
        workflowId: workflow.id,
        role,
        cwd,
        prompt,
        permissionConfigPath: join(this.worktreeRoot, workflow.id, 'permissions.json')
      }, (message) => {
        this.appendWorkerOutput(worker, message)
        void this.changed(workflow).catch((error) => {
          console.error('[pion] workflow progress persistence failed:', error)
        })
      })
      worker.status = 'completed'
      worker.finishedAt = Date.now()
      const output = clip(result.output)
      worker.outputTail = output.text
      worker.outputTruncated ||= output.truncated
      await this.changed(workflow)
      return result.output
    } catch (error) {
      worker.status = workflow.state === 'interrupted'
        ? 'interrupted'
        : workflow.state === 'cancelling' || workflow.state === 'cancelled'
          ? 'cancelled'
          : 'failed'
      worker.finishedAt = Date.now()
      worker.error = errorMessage(error)
      await this.changed(workflow)
      throw error
    }
  }

  private newWorker(role: WorkflowRole, kind: 'agent' | 'command', worktreePath: string): WorkflowWorker {
    return {
      id: randomUUID(),
      role,
      status: 'running',
      kind,
      worktreePath,
      startedAt: Date.now(),
      outputTail: '',
      outputTruncated: false,
      permission: permissionFor(role)
    }
  }

  private appendWorkerOutput(worker: WorkflowWorker, message: string): void {
    const next = clip(worker.outputTail ? `${worker.outputTail}\n${message}` : message)
    worker.outputTail = next.text
    worker.outputTruncated ||= next.truncated
  }

  private async recreateDetachedWorktree(
    workflow: WorkflowSnapshot,
    role: 'reviewer' | 'tester',
    oid: string
  ): Promise<string> {
    const path = join(this.worktreeRoot, workflow.id, role)
    if (await exists(path)) {
      await git(workflow.cwd, ['worktree', 'remove', '--force', path], true)
      await rm(path, { recursive: true, force: true })
    }
    await git(workflow.cwd, ['worktree', 'add', '--detach', path, oid])
    workflow.worktrees[role] = path
    await this.writePermissionConfig(workflow)
    await this.changed(workflow)
    return path
  }

  private async writePermissionConfig(workflow: WorkflowSnapshot): Promise<void> {
    const projects: Record<string, Record<string, 'allow' | 'deny'>> = {}
    for (const [role, path] of Object.entries(workflow.worktrees) as Array<[WorkflowRole, string | undefined]>) {
      if (!path) continue
      const permission = permissionFor(role)
      projects[resolve(path)] = {
        read: permission.read ? 'allow' : 'deny',
        write: permission.write ? 'allow' : 'deny',
        shell: permission.shell ? 'allow' : 'deny',
        network: 'deny',
        external: 'deny'
      }
    }
    const path = join(this.worktreeRoot, workflow.id, 'permissions.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, 'utf8')
  }

  private wasStopped(workflow: WorkflowSnapshot): boolean {
    return workflow.state === 'cancelling' || workflow.state === 'cancelled' || workflow.state === 'interrupted'
  }

  private async changed(workflow: WorkflowSnapshot): Promise<void> {
    workflow.updatedAt = Date.now()
    workflow.revision += 1
    await this.flush()
    if (this.win && !this.win.isDestroyed()) {
      const update: WorkflowUpdate = { workflow: clone(workflow) }
      this.win.webContents.send(IPC_EVENTS.WorkflowUpdated, update)
    }
  }
}
