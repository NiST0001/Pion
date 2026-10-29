import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../shared/ipc'
import { ensureProjectWorktreeDirectory } from './git'
import { parseDeletionWorktrees } from './git/branch-delete'
import { PiWorkflowWorkerRunner, VerificationWorkflowRunner } from './workflow/runners'
import { MAX_PROMPT_CONTEXT } from './workflow/constants'
import { clip } from './workflow/utils'
import type {
  WorkflowVerificationResult,
  WorkflowVerificationRunner,
  WorkflowWorkerRunner
} from './workflow/types'
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

export { PiWorkflowWorkerRunner, VerificationWorkflowRunner }
export type {
  WorkflowVerificationResult,
  WorkflowWorkerInput,
  WorkflowWorkerResult,
  WorkflowWorkerRunner,
  WorkflowVerificationRunner
} from './workflow/types'

const execFileAsync = promisify(execFile)
const MAX_GOAL = 8_000
const WORKFLOW_DIRECTORY = '.pion-workflow-worktrees' as const
const WORKFLOW_ROLES: WorkflowRole[] = ['planner', 'implementer', 'reviewer', 'tester']
const WORKFLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

interface WorkflowWorktreeLocation {
  path: string
  project: boolean
  identities: Map<string, string>
  head?: string
}

function validateWorkflowRole(id: string, role: WorkflowRole): void {
  if (!WORKFLOW_ID.test(id) || !WORKFLOW_ROLES.includes(role)) throw new Error('工作流 ID 或角色路径无效')
}

async function pathIdentity(path: string, directory = true): Promise<string> {
  const stat = await lstat(path, { bigint: true })
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(path) !== path) {
    throw new Error('工作流路径含符号链接、别名或非预期文件')
  }
  return `${stat.dev}:${stat.ino}`
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

interface WorkflowFile {
  version: 1
  workflows: WorkflowSnapshot[]
}

interface WorkflowManagerOptions {
  filePath: string
  /** Permission metadata and existing external roles only; new roles live in the primary project. */
  worktreeRoot: string
  permissionExtensionPath: () => Promise<string>
  verification: WorkflowVerificationRunner
  workerRunner?: WorkflowWorkerRunner
  projectTrusted?: (cwd: string) => boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
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

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }
    })
    if (args[0] === 'rev-parse' && (args.includes('--show-toplevel') || args.includes('--git-common-dir'))) {
      return stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '')
    }
    return stdout.trim()
  } catch (error) {
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
  if (!['draft', 'awaiting_start', 'preparing', 'planning', 'awaiting_plan', 'implementing', 'integrating',
    'reviewing', 'testing', 'awaiting_merge', 'merging', 'completed', 'waiting_permission', 'blocked',
    'failed', 'cancelling', 'cancelled', 'interrupted', 'stale'].includes(workflow.state ?? '')
    || typeof workflow.createdAt !== 'number' || !Number.isFinite(workflow.createdAt)) return null
  if (workflow.workers !== undefined && (!Array.isArray(workflow.workers)
    || workflow.workers.some((worker) => !worker || typeof worker.id !== 'string'
      || !WORKFLOW_ROLES.includes(worker.role) || !['agent', 'command'].includes(worker.kind)
      || !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(worker.status)
      || (worker.worktreePath !== undefined && typeof worker.worktreePath !== 'string')))) return null
  if (workflow.worktrees !== undefined && (!workflow.worktrees || typeof workflow.worktrees !== 'object'
    || Array.isArray(workflow.worktrees) || Object.entries(workflow.worktrees).some(([role, path]) =>
      !WORKFLOW_ROLES.includes(role as WorkflowRole) || typeof path !== 'string'))) return null
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
  private readonly background = new Map<string, Promise<void>>()
  private readonly cancellations = new Map<string, AbortController>()
  private readonly unconfirmedWorkers = new Map<string, string>()
  private storageError?: Error
  private pendingMutations = 0
  private mutationGuard?: () => void

  setMutationGuard(guard: () => void): void { this.mutationGuard = guard }

  assertWorktreeDeletionIdle(cwd: string): void {
    const target = resolve(cwd)
    // Worker RPC stop is not an OS-exit barrier. Never release registered
    // workflow worktrees merely because a snapshot says completed/cancelled.
    const related = (directory: string): boolean => {
      const path = resolve(directory)
      return path === target || path.startsWith(`${target}${sep}`) || target.startsWith(`${path}${sep}`)
    }
    if ([...this.workflows.values()].some((workflow) =>
      Object.values(workflow.worktrees).some(related)
      || workflow.workers.some((worker) => Boolean(worker.worktreePath && related(worker.worktreePath))))) {
      throw new Error('此目录由工作流管理，不能通过分支菜单删除')
    }
    if (this.pendingMutations || this.operations.size || this.unconfirmedWorkers.size
      || [...this.workflows.values()].some((workflow) => isWorkflowRunning(workflow.state)
        || workflow.state === 'waiting_permission'
        || workflow.workers.some((worker) => worker.status === 'running'))) {
      throw new Error('工作流操作尚未结束，不能删除工作树')
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.loading) await this.loading
    if (this.storageError) throw this.storageError
    this.mutationGuard?.()
    this.pendingMutations += 1
    try { return await operation() }
    finally { this.pendingMutations -= 1 }
  }

  private git(cwd: string, args: string[]): Promise<string> {
    this.mutationGuard?.()
    return git(cwd, args)
  }

  private async activeGit(workflow: WorkflowSnapshot, cwd: string, args: string[]): Promise<string> {
    this.checkWorktreeMutation(workflow)
    const result = await this.git(cwd, args)
    this.checkWorktreeMutation(workflow)
    return result
  }
  private win: BrowserWindow | null = null
  private loading?: Promise<void>
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

  load(): Promise<void> {
    return this.loading ??= this.loadStorage()
  }

  private async loadStorage(): Promise<void> {
    const recovered = new Map<string, WorkflowSnapshot>()
    let reconciled = false
    try {
      let text: string
      try { text = await readFile(this.filePath, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const parsed = JSON.parse(text) as Partial<WorkflowFile> | null
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.workflows)) throw new Error('工作流文件格式无效')
      for (const item of parsed.workflows) {
        const workflow = normalizeLoaded(item)
        if (!workflow || recovered.has(workflow.id)) throw new Error('工作流条目无效或重复')
        for (const worker of workflow.workers) {
          if (worker.status === 'running' || worker.status === 'interrupted') {
            this.unconfirmedWorkers.set(worker.id, worker.worktreePath ?? workflow.cwd)
          }
        }
        if (isWorkflowRunning(workflow.state) || workflow.state === 'waiting_permission') {
          workflow.interruptedFrom = workflow.state
          workflow.state = 'interrupted'
          workflow.error = 'Pion 在工作流完成前退出；不会自动恢复 Agent 或命令。'
          workflow.workers = workflow.workers.map((worker) => worker.status === 'running'
            ? { ...worker, status: 'interrupted', finishedAt: Date.now(), error: '应用退出' }
            : worker)
          workflow.updatedAt = Date.now()
          workflow.revision += 1
          reconciled = true
        }
        recovered.set(workflow.id, workflow)
      }
    } catch (error) {
      this.storageError = new Error(`工作流存储读取失败，已保留原文件：${errorMessage(error)}`)
      console.error('[pion] workflow storage unavailable:', this.storageError)
      return
    }
    for (const [id, workflow] of recovered) this.workflows.set(id, workflow)
    if (reconciled) await this.persist()
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
    return this.mutate(() => this.createReserved(request))
  }

  private async createReserved(request: CreateWorkflowRequest): Promise<WorkflowSnapshot> {
    const goal = request.goal.trim()
    if (!goal) throw new Error('请输入多 Agent 工作流目标')
    if (goal.length > MAX_GOAL) throw new Error(`工作流目标不能超过 ${MAX_GOAL} 个字符`)
    const root = resolve(await this.git(resolve(request.cwd), ['rev-parse', '--show-toplevel']))
    this.mutationGuard?.()
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
    return this.mutate(() => this.startReserved(id))
  }

  private async startReserved(id: string): Promise<WorkflowSnapshot> {
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
    return this.mutate(() => this.approvePlanReserved(id))
  }

  private async approvePlanReserved(id: string): Promise<WorkflowSnapshot> {
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
    return this.mutate(() => this.repairReserved(id))
  }

  private async repairReserved(id: string): Promise<WorkflowSnapshot> {
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
    return this.mutate(() => this.waiveTestsReserved(id))
  }

  private async waiveTestsReserved(id: string): Promise<WorkflowSnapshot> {
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
    return this.mutate(() => this.resumeReserved(id))
  }

  private async resumeReserved(id: string): Promise<WorkflowSnapshot> {
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
      const head = await this.git(workflow.cwd, ['rev-parse', 'HEAD'])
      if (workflow.state !== 'interrupted') return clone(workflow)
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
    // Revoke execution authority before storage or extension preparation waits.
    const cancellation = this.cancelWorkers(workflow)
    void cancellation.catch(() => undefined)
    await this.changed(workflow)
    await cancellation
    workflow.workers = workflow.workers.map((worker) => worker.status === 'running'
      ? { ...worker, status: 'cancelled', finishedAt: Date.now(), error: '用户取消' }
      : worker)
    workflow.state = 'cancelled'
    workflow.error = undefined
    await this.changed(workflow)
    return clone(workflow)
  }

  async merge(id: string): Promise<WorkflowSnapshot> {
    return this.mutate(() => this.mergeReserved(id))
  }

  private async mergeReserved(id: string): Promise<WorkflowSnapshot> {
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
        this.git(workflow.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        this.git(workflow.cwd, ['rev-parse', 'HEAD']),
        this.git(workflow.cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
        this.git(workflow.cwd, ['rev-parse', workflow.candidateBranch])
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
      await this.git(workflow.cwd, ['merge', '--ff-only', workflow.candidateBranch])
      workflow.mergeOid = await this.git(workflow.cwd, ['rev-parse', 'HEAD'])
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
    return this.mutate(() => this.cleanupReserved(id))
  }

  private async cleanupReserved(id: string): Promise<WorkflowSnapshot> {
    const workflow = this.require(id)
    if (isWorkflowRunning(workflow.state) || workflow.state === 'merging' || workflow.state === 'cancelling') {
      throw new Error('运行中的工作流不能清理，请先取消')
    }
    this.ensureIdle(workflow)
    validateWorkflowRole(workflow.id, 'planner')
    this.operations.add(workflow.id)
    workflow.cleanupCompletedAt = undefined
    const failures: string[] = []
    let removed = 0
    try {
      if (Object.keys(workflow.worktrees).some((role) => !WORKFLOW_ROLES.includes(role as WorkflowRole))) {
        failures.push('包含未知角色路径，已保留')
      }
      for (const role of WORKFLOW_ROLES) {
        const path = this.retainedRolePath(workflow, role)
        if (!path) continue
        try {
          const location = await this.inspectRoleWorktree(workflow, role, path)
          this.assertWorkersIdle(workflow)
          if (location.head) {
            await this.removeRoleWorktree(workflow, role, location, true)
            removed += 1
          }
          delete workflow.worktrees[role]
        } catch (error) {
          // Retain the exact failed/unknown target, including history-only paths.
          workflow.worktrees[role] = path
          failures.push(`${role}: ${errorMessage(error)}`)
        }
      }
      if (!failures.length && workflow.candidateBranch) {
        try {
          if (workflow.candidateBranch !== `pion/${workflow.id.slice(0, 8)}/candidate`) throw new Error('候选分支身份无效')
          const oid = await this.git(workflow.cwd, ['for-each-ref', '--format=%(objectname)', `refs/heads/${workflow.candidateBranch}`])
          if (oid) {
            if (oid !== (workflow.candidateOid ?? workflow.baseOid)) throw new Error('候选分支提交已变化')
            await this.git(workflow.cwd, ['merge-base', '--is-ancestor', oid, 'HEAD'])
            this.assertWorkersIdle(workflow)
            await this.git(workflow.cwd, ['branch', '-d', '--', workflow.candidateBranch])
            this.assertWorkersIdle(workflow)
          }
        } catch (error) {
          failures.push(`候选分支: ${errorMessage(error)}`)
        }
      }
      workflow.error = failures.length ? `清理未完成，已确认移除 ${removed} 个工作树；${failures.join('；')}` : undefined
      if (!failures.length) workflow.cleanupCompletedAt = Date.now()
      await this.changed(workflow)
      return clone(workflow)
    } finally {
      this.operations.delete(workflow.id)
    }
  }

  private cancelWorkers(workflow: WorkflowSnapshot): Promise<void> {
    this.cancellations.get(workflow.id)?.abort()
    return Promise.all(workflow.workers.filter((worker) => worker.status === 'running').map((worker) => {
      if (worker.kind === 'agent') return this.runner.cancel(worker.id)
      if (workflow.verification?.runId) return this.verification.cancel(workflow.verification.runId)
      return Promise.resolve()
    })).then(() => undefined)
  }

  async shutdown(): Promise<void> {
    const active = [...this.workflows.values()].filter((workflow) => isWorkflowRunning(workflow.state) || workflow.state === 'waiting_permission')
    for (const workflow of active) {
      workflow.interruptedFrom = workflow.state
      workflow.state = 'interrupted'
      workflow.error = 'Pion 退出时中断了工作流；不会自动续跑。'
      this.cancellations.get(workflow.id)?.abort()
    }
    for (const workflow of active) {
      await this.cancelWorkers(workflow)
      workflow.workers = workflow.workers.map((item) => item.status === 'running'
        ? { ...item, status: 'interrupted', finishedAt: Date.now(), error: '应用退出' }
        : item)
      if (!this.storageError) await this.changed(workflow)
    }
    await Promise.allSettled(this.background.values())
    if (!this.storageError) await this.flush()
  }

  flush(): Promise<void> {
    return this.loading ? this.loading.then(() => this.persist()) : this.persist()
  }

  private persist(): Promise<void> {
    if (this.storageError) return Promise.reject(this.storageError)
    const snapshot = `${JSON.stringify({ version: 1, workflows: [...this.workflows.values()] }, null, 2)}\n`
    const temp = `${this.filePath}.${randomUUID()}.tmp`
    const write = this.writeQueue.then(async () => {
      if (this.storageError) throw this.storageError
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, this.filePath)
    }).catch((error) => {
      this.storageError ??= new Error(`工作流存储保存失败，已停止后续写入并保留现场：${errorMessage(error)}`)
      throw this.storageError
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
    this.assertWorkersIdle(workflow)
  }

  private assertWorkersIdle(workflow: WorkflowSnapshot): void {
    if (workflow.workers.some((worker) => this.unconfirmedWorkers.has(worker.id))) {
      throw new Error('工作流 worker 退出尚未确认，工作树已隔离保留')
    }
    const paths = new Set([...Object.values(workflow.worktrees),
      ...workflow.workers.map((worker) => worker.worktreePath).filter((path): path is string => Boolean(path))])
    for (const path of paths) {
      const target = resolve(path)
      if ([...this.unconfirmedWorkers.values()].some((cwd) => cwd === target
        || cwd.startsWith(`${target}${sep}`) || target.startsWith(`${cwd}${sep}`))) {
        throw new Error('工作流 worker 退出尚未确认，工作树已隔离保留')
      }
      this.runner.assertWorktreeDeletionIdle?.(path)
      this.verification.assertWorktreeDeletionIdle?.(path)
    }
  }

  private launch(workflow: WorkflowSnapshot, operation: () => Promise<void>): void {
    this.operations.add(workflow.id)
    const running: Promise<void> = Promise.resolve().then(() => {
      if (this.wasStopped(workflow)) return
      this.mutationGuard?.()
      return operation()
    })
      .catch(async (error) => {
        if (workflow.state === 'cancelled' || workflow.state === 'cancelling' || workflow.state === 'interrupted') return
        workflow.state = 'failed'
        workflow.error = errorMessage(error)
        await this.changed(workflow)
      })
      .finally(() => {
        this.operations.delete(workflow.id)
        if (this.background.get(workflow.id) === running) this.background.delete(workflow.id)
      })
    this.background.set(workflow.id, running)
    void running.catch((error) => console.error('[pion] workflow finalization failed:', error))
  }

  private async plan(workflow: WorkflowSnapshot): Promise<void> {
    await this.prepare(workflow)
    if (this.wasStopped(workflow)) return
    workflow.state = 'planning'
    await this.changed(workflow)
    this.checkWorktreeMutation(workflow)
    const worktree = workflow.worktrees.planner
    if (!worktree) throw new Error('规划 worktree 未创建')
    const output = await this.runAgent(workflow, 'planner', worktree, [
      '你是 Pion 多 Agent 工作流中的 Planner。',
      '只读分析当前仓库，不修改文件，不运行 Shell，不委派其他 Agent。',
      `目标：${workflow.goal}`,
      '输出一份可执行计划：范围、文件、步骤、验证、风险与明确的完成条件。'
    ].join('\n\n'))
    this.checkWorktreeMutation(workflow)
    workflow.plan = clip(output, MAX_PROMPT_CONTEXT).text
    workflow.state = 'awaiting_plan'
    workflow.error = undefined
    await this.changed(workflow)
  }

  private async prepare(workflow: WorkflowSnapshot): Promise<void> {
    this.checkWorktreeMutation(workflow)
    this.assertWorkersIdle(workflow)
    validateWorkflowRole(workflow.id, 'planner')
    const root = resolve(await this.activeGit(workflow, workflow.cwd, ['rev-parse', '--show-toplevel']))
    workflow.cwd = root
    if (!workflow.baseOid) {
      const dirty = await this.activeGit(workflow, root, ['status', '--porcelain=v1', '--untracked-files=all'])
      if (dirty) throw new Error('启动多 Agent 工作流前，目标 Git 工作区必须干净')
      workflow.baseOid = await this.activeGit(workflow, root, ['rev-parse', 'HEAD'])
      workflow.targetBranch = await this.activeGit(workflow, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (!workflow.targetBranch) throw new Error('目标工作区处于 detached HEAD，无法安全合并')
      workflow.candidateBranch = `pion/${workflow.id.slice(0, 8)}/candidate`
    }

    if (!GIT_OID.test(workflow.baseOid) || workflow.candidateBranch !== `pion/${workflow.id.slice(0, 8)}/candidate`) {
      throw new Error('工作流基准提交或候选分支身份无效')
    }
    for (const role of ['planner', 'implementer'] as const) {
      const location = await this.roleWorktreeLocation(workflow, role)
      this.checkWorktreeMutation(workflow)
      workflow.worktrees[role] = location.path
      // Persist ownership before Git: a partial/failed add must remain visible.
      await this.changed(workflow)
      await this.checkLocationUnchanged(location)
      this.checkWorktreeMutation(workflow)
      if (!location.head) {
        await this.activeGit(workflow, root, role === 'planner'
          ? ['worktree', 'add', '--detach', location.path, workflow.baseOid]
          : ['worktree', 'add', '-b', workflow.candidateBranch!, location.path, workflow.baseOid])
        if ((await this.inspectRoleWorktree(workflow, role, location.path)).head !== workflow.baseOid) {
          throw new Error('新角色工作树的起点提交不一致')
        }
        await this.checkLocationUnchanged(location)
      }
    }
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
    const dirty = await this.activeGit(workflow, implementer, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (dirty) {
      await this.activeGit(workflow, implementer, ['add', '--all'])
      await this.activeGit(workflow, implementer, ['commit', '-m', `Pion workflow ${workflow.id.slice(0, 8)} implementation`])
    }
    workflow.candidateOid = await this.activeGit(workflow, implementer, ['rev-parse', 'HEAD'])
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
    const stat = await this.activeGit(workflow, workflow.cwd, ['diff', '--stat', `${workflow.baseOid}..${workflow.candidateOid}`])
    const diff = await this.activeGit(workflow, workflow.cwd, ['diff', '--no-ext-diff', '--unified=3', `${workflow.baseOid}..${workflow.candidateOid}`])
    const boundedDiff = diff.length > MAX_PROMPT_CONTEXT ? `${diff.slice(0, MAX_PROMPT_CONTEXT)}\n…差异已截断` : diff
    const output = await this.runAgent(workflow, 'reviewer', reviewer, [
      '你是 Pion 多 Agent 工作流中的 Reviewer。只读审查，不修改文件、不运行 Shell、不委派其他 Agent。',
      `目标：${workflow.goal}`,
      `计划：\n${workflow.plan ?? ''}`,
      `修改摘要：\n${stat}`,
      `候选差异：\n${boundedDiff}`,
      '检查正确性、安全性、回归风险和测试覆盖。最后单独输出 PION_REVIEW_VERDICT: pass 或 PION_REVIEW_VERDICT: fail。'
    ].join('\n\n'))
    this.checkWorktreeMutation(workflow)
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
    this.checkWorktreeMutation(workflow)
    const controller = new AbortController()
    this.cancellations.set(workflow.id, controller)
    const worker = this.newWorker('tester', 'command', tester)
    workflow.verification = undefined
    workflow.workers.push(worker)
    let invoked = false
    let result: WorkflowVerificationResult
    try {
      await this.changed(workflow)
      this.checkWorktreeMutation(workflow)
      invoked = true
      result = await this.verification.run(tester, (message, runId) => {
        if (this.wasStopped(workflow) || this.cancellations.get(workflow.id) !== controller) return
        if (runId) workflow.verification = { runId, state: 'running', summary: message }
        this.appendWorkerOutput(worker, message)
        void this.changed(workflow).catch((error) => {
          console.error('[pion] workflow progress persistence failed:', error)
        })
      }, controller.signal)
    } catch (error) {
      if (invoked) this.retainUnknownWorker(worker, this.verification)
      throw error
    } finally {
      if (this.cancellations.get(workflow.id) === controller) this.cancellations.delete(workflow.id)
    }
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
    this.checkWorktreeMutation(workflow)
    const controller = new AbortController()
    this.cancellations.set(workflow.id, controller)
    const worker = this.newWorker(role, 'agent', cwd)
    workflow.workers.push(worker)
    let invoked = false
    let finished = false
    try {
      await this.changed(workflow)
      this.checkWorktreeMutation(workflow)
      invoked = true
      const result = await this.runner.run({
        id: worker.id,
        workflowId: workflow.id,
        role,
        cwd,
        prompt,
        permissionConfigPath: this.permissionConfigPath(workflow),
        signal: controller.signal
      }, (message) => {
        if (this.wasStopped(workflow) || this.cancellations.get(workflow.id) !== controller) return
        this.appendWorkerOutput(worker, message)
        void this.changed(workflow).catch((error) => {
          console.error('[pion] workflow progress persistence failed:', error)
        })
      })
      finished = true
      this.checkWorktreeMutation(workflow)
      worker.status = 'completed'
      worker.finishedAt = Date.now()
      const output = clip(result.output)
      worker.outputTail = output.text
      worker.outputTruncated ||= output.truncated
      await this.changed(workflow)
      this.checkWorktreeMutation(workflow)
      return result.output
    } catch (error) {
      if (invoked && !finished) this.retainUnknownWorker(worker, this.runner)
      worker.status = workflow.state === 'interrupted'
        ? 'interrupted'
        : workflow.state === 'cancelling' || workflow.state === 'cancelled'
          ? 'cancelled'
          : 'failed'
      worker.finishedAt = Date.now()
      worker.error = errorMessage(error)
      await this.changed(workflow)
      throw error
    } finally {
      if (this.cancellations.get(workflow.id) === controller) this.cancellations.delete(workflow.id)
    }
  }

  private retainUnknownWorker(worker: WorkflowWorker, runner: { assertWorktreeDeletionIdle?(cwd: string): void }): void {
    if (!worker.worktreePath) return
    if (runner.assertWorktreeDeletionIdle) {
      try { runner.assertWorktreeDeletionIdle(worker.worktreePath); return } catch { /* Retain unknown shutdown. */ }
    }
    this.unconfirmedWorkers.set(worker.id, resolve(worker.worktreePath))
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

  private permissionConfigPath(workflow: WorkflowSnapshot): string {
    validateWorkflowRole(workflow.id, 'planner')
    return join(this.worktreeRoot, workflow.id, 'permissions.json')
  }

  private retainedRolePath(workflow: WorkflowSnapshot, role: WorkflowRole): string | undefined {
    return workflow.worktrees[role]
      ?? workflow.workers.findLast((worker) => worker.role === role && worker.worktreePath)?.worktreePath
  }

  private checkWorktreeMutation(workflow: WorkflowSnapshot): void {
    this.mutationGuard?.()
    if (this.wasStopped(workflow)) throw new Error('工作流已停止，未继续执行')
  }

  private async checkLocationUnchanged(location: WorkflowWorktreeLocation, removed = false): Promise<void> {
    for (const [path, identity] of location.identities) {
      if (removed && (path === location.path || path === join(location.path, '.git'))) continue
      if (await pathIdentity(path, path !== join(location.path, '.git')) !== identity) {
        throw new Error('工作流目录身份已改变')
      }
    }
  }

  private async inspectRoleWorktree(
    workflow: WorkflowSnapshot, role: WorkflowRole, path: string, owned = true
  ): Promise<WorkflowWorktreeLocation> {
    validateWorkflowRole(workflow.id, role)
    if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || path !== resolve(path)) {
      throw new Error('工作流工作树路径无效')
    }
    const records = parseDeletionWorktrees(await this.git(workflow.cwd, ['worktree', 'list', '--porcelain', '-z']))
    const primary = resolve(records[0].path)
    const project = path === join(primary, WORKFLOW_DIRECTORY, workflow.id, role)
    if (!project && path !== join(this.worktreeRoot, workflow.id, role)) throw new Error('路径不是此工作流的受管角色目录')
    if (path === primary || managedPath(path, workflow.cwd) || (managedPath(primary, path) && !project)) {
      throw new Error('不能操作主工作树、当前工作树或普通项目目录')
    }
    const identities = new Map<string, string>()
    for (const directory of [primary, dirname(dirname(path)), dirname(path)]) {
      if (directory === primary || await pathExists(directory)) identities.set(directory, await pathIdentity(directory))
    }
    const matches = records.filter((record) => resolve(record.path) === path)
    const present = await pathExists(path)
    if (!present && !matches.length) return { path, project, identities }
    const record = matches[0]
    if (!owned || !present || matches.length !== 1 || record === records[0] || record.locked || record.prunable
      || (role === 'implementer' ? record.detached || !workflow.candidateBranch || record.branch !== workflow.candidateBranch
        : !record.detached || Boolean(record.branch))) throw new Error('目标不是本工作流真实登记的角色工作树，已保留')
    if (records.slice(1).some((other) => other !== record
      && (managedPath(path, other.path) || managedPath(other.path, path)))) throw new Error('工作流工作树与其他登记目录嵌套')
    identities.set(path, await pathIdentity(path))
    identities.set(join(path, '.git'), await pathIdentity(join(path, '.git'), false))
    const common = await realpath(await this.git(workflow.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    identities.set(common, await pathIdentity(common))
    if (resolve(await this.git(path, ['rev-parse', '--show-toplevel'])) !== path
      || await realpath(await this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== common
      || await this.git(path, ['rev-parse', 'HEAD']) !== record.head) throw new Error('角色工作树的仓库或提交身份不一致')
    return { path, project, identities, head: record.head }
  }

  private async roleWorktreeLocation(workflow: WorkflowSnapshot, role: WorkflowRole): Promise<WorkflowWorktreeLocation> {
    this.checkWorktreeMutation(workflow)
    this.assertWorkersIdle(workflow)
    validateWorkflowRole(workflow.id, role)
    const retained = this.retainedRolePath(workflow, role)
    if (retained) {
      const location = await this.inspectRoleWorktree(workflow, role, retained)
      if (location.head) return location
    }
    // Only absent roles get a new destination. Metadata and live legacy roles
    // keep their original locations; never infer an external role from a sibling.
    this.checkWorktreeMutation(workflow)
    const root = await ensureProjectWorktreeDirectory(workflow.cwd, WORKFLOW_DIRECTORY)
    this.checkWorktreeMutation(workflow)
    const identity = await pathIdentity(root)
    const base = join(root, workflow.id)
    this.checkWorktreeMutation(workflow)
    try { await mkdir(base) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.checkWorktreeMutation(workflow)
    await pathIdentity(base)
    if (await pathIdentity(root) !== identity) throw new Error('工作流受管根目录身份已改变')
    this.checkWorktreeMutation(workflow)
    return this.inspectRoleWorktree(workflow, role, join(base, role), retained === join(base, role))
  }

  private async checkCleanRoleWorktree(
    workflow: WorkflowSnapshot, role: WorkflowRole, location: WorkflowWorktreeLocation
  ): Promise<void> {
    if (await this.git(location.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])) {
      throw new Error('角色工作树含修改、未跟踪或忽略文件，已保留')
    }
    const current = await this.inspectRoleWorktree(workflow, role, location.path)
    if (!current.head || current.head !== location.head) throw new Error('角色工作树登记或提交已改变')
    if (role !== 'implementer') {
      // A clean detached worktree can still be the only owner of a user commit.
      const retained = await this.git(workflow.cwd, ['for-each-ref', `--contains=${current.head}`,
        '--format=%(objectname)', 'refs/heads/', 'refs/remotes/', 'refs/tags/'])
      if (!retained || retained.split(/\r?\n/).some((oid) => !GIT_OID.test(oid))) {
        throw new Error('角色工作树含尚未被分支或标签保留的提交，已保留')
      }
    }
    await this.checkLocationUnchanged(location)
  }

  private async removeRoleWorktree(
    workflow: WorkflowSnapshot, role: WorkflowRole, location: WorkflowWorktreeLocation, cleanup = false
  ): Promise<void> {
    await this.checkCleanRoleWorktree(workflow, role, location)
    if (!cleanup) this.checkWorktreeMutation(workflow)
    this.assertWorkersIdle(workflow)
    await this.git(workflow.cwd, ['worktree', 'remove', '--', location.path])
    this.assertWorkersIdle(workflow)
    const records = parseDeletionWorktrees(await this.git(workflow.cwd, ['worktree', 'list', '--porcelain', '-z']))
    if (await pathExists(location.path) || records.some((record) => resolve(record.path) === location.path)) {
      throw new Error('工作树移除尚未确认，保留清理记录')
    }
    await this.checkLocationUnchanged(location, true)
  }

  private async recreateDetachedWorktree(
    workflow: WorkflowSnapshot,
    role: 'reviewer' | 'tester',
    oid: string
  ): Promise<string> {
    this.checkWorktreeMutation(workflow)
    if (!GIT_OID.test(oid)) throw new Error('角色工作树候选提交无效')
    const location = await this.roleWorktreeLocation(workflow, role)
    this.checkWorktreeMutation(workflow)
    workflow.worktrees[role] = location.path
    await this.changed(workflow)
    if (location.head && !location.project) {
      // Existing external roles stay registered in place; never create another
      // userData worktree or move their directory as a side effect of repair.
      await this.checkCleanRoleWorktree(workflow, role, location)
      this.checkWorktreeMutation(workflow)
      await this.activeGit(workflow, location.path, ['checkout', '--detach', oid, '--'])
    } else {
      if (location.head) await this.removeRoleWorktree(workflow, role, location)
      const vacant = await this.inspectRoleWorktree(workflow, role, location.path)
      if (vacant.head) throw new Error('工作流目标重新被登记，未重建')
      await this.checkLocationUnchanged(vacant)
      await this.checkLocationUnchanged(location, Boolean(location.head))
      this.checkWorktreeMutation(workflow)
      await this.activeGit(workflow, workflow.cwd, ['worktree', 'add', '--detach', location.path, oid])
    }
    if ((await this.inspectRoleWorktree(workflow, role, location.path)).head !== oid) throw new Error('角色工作树候选提交不一致')
    await this.checkLocationUnchanged(location, Boolean(location.head && location.project))
    await this.writePermissionConfig(workflow)
    await this.changed(workflow)
    return location.path
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
    const path = this.permissionConfigPath(workflow)
    this.checkWorktreeMutation(workflow)
    await mkdir(dirname(path), { recursive: true })
    this.checkWorktreeMutation(workflow)
    await writeFile(path, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, 'utf8')
    this.checkWorktreeMutation(workflow)
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
