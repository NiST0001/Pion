import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowManager,
  type WorkflowVerificationRunner,
  type WorkflowWorkerInput,
  type WorkflowWorkerResult,
  type WorkflowWorkerRunner
} from '../../src/main/workflow-manager'
import type { WorkflowSnapshot, WorkflowState } from '../../src/shared/workflows'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function repository(): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'pion-workflow-'))
  roots.push(temporary)
  const root = await realpath(temporary)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Pion Test')
  git(root, 'config', 'user.email', 'pion@example.invalid')
  // 固定行尾行为，避免 Windows 全局 core.autocrlf 把 LF 检出成 CRLF
  git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'README.md'), '# base\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-qm', 'base')
  return root
}

class FakeWorkers implements WorkflowWorkerRunner {
  reviewerVerdict: 'pass' | 'fail' = 'pass'

  async run(input: WorkflowWorkerInput): Promise<WorkflowWorkerResult> {
    if (input.role === 'planner') return { output: '1. implement feature\n2. verify behavior' }
    if (input.role === 'implementer') {
      await writeFile(join(input.cwd, 'feature.txt'), 'implemented\n')
      return { output: 'implemented feature.txt' }
    }
    return {
      output: `Review completed.\nPION_REVIEW_VERDICT: ${this.reviewerVerdict}`
    }
  }

  async cancel(): Promise<void> {}
}

class FakeVerification implements WorkflowVerificationRunner {
  constructor(private readonly state: 'passed' | 'not-found' = 'passed') {}

  async run(): Promise<{ runId?: string; state: 'passed' | 'not-found'; summary: string }> {
    return this.state === 'passed'
      ? { runId: 'verification-1', state: 'passed', summary: 'all checks passed' }
      : { state: 'not-found', summary: 'no commands' }
  }

  async cancel(): Promise<void> {}
}

async function waitForState(manager: WorkflowManager, id: string, state: WorkflowState): Promise<void> {
  // Await this workflow's actual task, including persistence and slot release.
  // The unchanged Vitest timeout bounds the wait; an interim state alone is insufficient.
  const running = (manager as unknown as { background: Map<string, Promise<void>> }).background.get(id)
  if (running) await running
  if (manager.get(id)?.state !== state) {
    throw new Error(`workflow did not reach ${state}; current=${manager.get(id)?.state}`)
  }
}

// 状态先在内存中可见，后台操作的收尾（状态持久化）可能尚未完成；
// Windows 文件写入较慢时该窗口更明显，遇到“操作正在进行”时短暂重试。
async function settle<T>(action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      return await action()
    } catch (error) {
      if (Date.now() > deadline || !String(error).includes('正在进行')) throw error
      await new Promise((done) => setTimeout(done, 25))
    }
  }
}

async function manager(_root: string, verification: WorkflowVerificationRunner): Promise<WorkflowManager> {
  const state = await mkdtemp(join(tmpdir(), 'pion-workflow-state-'))
  roots.push(state)
  const value = new WorkflowManager({
    filePath: join(state, 'workflows.json'),
    worktreeRoot: join(state, 'worktrees'),
    permissionExtensionPath: async () => join(state, 'permission.ts'),
    verification,
    workerRunner: new FakeWorkers()
  })
  await value.load()
  return value
}

afterEach(async () => {
  // Windows 上 git 子进程可能短暂占用 worktree 目录，需要重试清理
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })))
})

describe('WorkflowManager', () => {
  function isolatedManager() {
    const workflows = new WorkflowManager({
      filePath: join(tmpdir(), 'unused-workflow.json'),
      worktreeRoot: join(tmpdir(), 'unused-worktrees'),
      permissionExtensionPath: async () => 'unused',
      verification: new FakeVerification(), workerRunner: new FakeWorkers()
    })
    const internal = workflows as unknown as {
      workflows: Map<string, WorkflowSnapshot>
      changed(workflow: WorkflowSnapshot): Promise<void>
      launch(workflow: WorkflowSnapshot, operation: () => Promise<void>): void
      runAgent(workflow: WorkflowSnapshot, role: 'planner', cwd: string, prompt: string): Promise<string>
      runner: WorkflowWorkerRunner
    }
    vi.spyOn(internal, 'changed').mockResolvedValue(undefined)
    return { workflows, internal }
  }

  function snapshot(id: string, state: WorkflowState = 'awaiting_start'): WorkflowSnapshot {
    return { version: 1, id, cwd: '/project', goal: 'goal', state,
      createdAt: 1, updatedAt: 1, revision: 0, workers: [], worktrees: {},
      repairAttempts: 0, maxRepairAttempts: 2 }
  }

  it('waits for the owned task to settle before accepting its state and still rejects a wrong final state', async () => {
    const { workflows, internal } = isolatedManager()
    const value = snapshot('state-waiter', 'preparing')
    internal.workflows.set(value.id, value)
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    internal.launch(value, async () => {
      value.state = 'awaiting_plan'
      await pending
    })
    const task = (workflows as unknown as { background: Map<string, Promise<void>> }).background.get(value.id)
    await Promise.resolve()
    expect(workflows.get(value.id)?.state).toBe('awaiting_plan')
    let settled = false
    const waiting = waitForState(workflows, value.id, 'awaiting_plan').then(() => { settled = true })
    try {
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally {
      finish()
      await task
      await waiting
    }
    expect(settled).toBe(true)
    await expect(waitForState(workflows, value.id, 'awaiting_merge')).rejects.toThrow('current=awaiting_plan')
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('does not release a %s workflow worktree without real exit evidence', (state) => {
    const { workflows, internal } = isolatedManager()
    const value = snapshot('retained-worker', state)
    value.worktrees = { implementer: '/linked/feature' }
    internal.workflows.set(value.id, value)
    expect(() => workflows.assertWorktreeDeletionIdle('/linked/feature')).toThrow(/工作流管理/)
    expect(() => workflows.assertWorktreeDeletionIdle('/linked')).toThrow(/工作流管理/)
    expect(() => workflows.assertWorktreeDeletionIdle('/linked/feature/subdir')).toThrow(/工作流管理/)
    expect(() => workflows.assertWorktreeDeletionIdle('/linked/feature-other')).not.toThrow()
  })

  it('checks retained worker paths even without a worktrees map entry', () => {
    const { workflows, internal } = isolatedManager()
    const value = snapshot('retained-worker', 'completed')
    value.workers = [{ id: 'worker', role: 'implementer', kind: 'agent', status: 'completed',
      worktreePath: '/linked/feature', outputTail: '', outputTruncated: false,
      permission: { read: true, write: true, shell: true, network: false, external: false, note: 'mock' } }]
    internal.workflows.set(value.id, value)
    expect(() => workflows.assertWorktreeDeletionIdle('/linked/feature')).toThrow(/工作流管理/)
  })

  it('guards every mutation entry before discovery, workers or commands', async () => {
    const { workflows } = isolatedManager()
    workflows.setMutationGuard(() => { throw new Error('deletion active') })
    await expect(workflows.create({ cwd: '/project', goal: 'goal' })).rejects.toThrow('deletion active')
    for (const action of ['start', 'approvePlan', 'repair', 'waiveTests', 'resume', 'merge', 'cleanup'] as const) {
      await expect(workflows[action]('missing')).rejects.toThrow('deletion active')
    }
    expect(() => workflows.assertWorktreeDeletionIdle('/project')).not.toThrow()
  })

  it('checks all private snapshots rather than the bounded display list', () => {
    const { workflows, internal } = isolatedManager()
    internal.workflows.set('old', snapshot('old', 'planning'))
    for (let index = 0; index < 35; index += 1) {
      internal.workflows.set(`new-${index}`, { ...snapshot(`new-${index}`), updatedAt: index + 2 })
    }
    expect(workflows.list().some((value) => value.id === 'old')).toBe(false)
    expect(() => workflows.assertWorktreeDeletionIdle('/unrelated')).toThrow(/工作流/)
  })

  it('keeps cancelled background operations reserved until their real promises settle', async () => {
    const { workflows, internal } = isolatedManager()
    const value = snapshot('pending-worker', 'planning')
    internal.workflows.set(value.id, value)
    let finish!: () => void
    internal.launch(value, () => new Promise<void>((done) => { finish = done }))
    await Promise.resolve()
    await workflows.cancel(value.id)
    expect(workflows.get(value.id)?.state).toBe('cancelled')
    expect(() => workflows.assertWorktreeDeletionIdle('/project')).toThrow(/工作流/)
    finish()
    await vi.waitFor(() => expect(() => workflows.assertWorktreeDeletionIdle('/project')).not.toThrow())
  })

  it('keeps shutdown pending until cancelled background preparation actually settles', async () => {
    const { workflows, internal } = isolatedManager()
    vi.spyOn(workflows, 'flush').mockResolvedValue(undefined)
    const value = snapshot('pending-preparation', 'preparing')
    internal.workflows.set(value.id, value)
    let finish!: () => void
    internal.launch(value, () => new Promise<void>((done) => { finish = done }))
    await Promise.resolve()
    let closed = false
    const shutdown = workflows.shutdown().then(() => { closed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(value.state).toBe('interrupted')
    finish()
    await shutdown
    expect(closed).toBe(true)
  })

  it('does not invoke a worker cancelled while its running snapshot is still being saved', async () => {
    const { workflows, internal } = isolatedManager()
    const value = snapshot('12345678-1234-4234-8234-123456789abc', 'planning')
    internal.workflows.set(value.id, value)
    const run = vi.spyOn(internal.runner, 'run')
    const cancel = vi.spyOn(internal.runner, 'cancel')
    let finish!: () => void
    vi.mocked(internal.changed).mockImplementationOnce(() => new Promise<void>((done) => { finish = done }))
    const running = internal.runAgent(value, 'planner', '/isolated/planner', 'plan')
    const rejected = expect(running).rejects.toThrow(/已停止/)
    await workflows.cancel(value.id)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    finish()
    await rejected
    expect(run).not.toHaveBeenCalled()
    expect(workflows.get(value.id)?.state).toBe('cancelled')
  })

  it('reserves startup persistence and rechecks the guard before launch', async () => {
    const { workflows, internal } = isolatedManager()
    const value = snapshot('pending-start')
    internal.workflows.set(value.id, value)
    let finish!: () => void
    vi.mocked(internal.changed).mockImplementationOnce(() => new Promise<void>((done) => { finish = done }))
    let blocked = false
    workflows.setMutationGuard(() => { if (blocked) throw new Error('deletion active') })
    const starting = workflows.start(value.id)
    // Test the reservation independently of the snapshot's running-state gate.
    value.state = 'cancelled'
    expect(() => workflows.assertWorktreeDeletionIdle('/project')).toThrow(/工作流/)
    blocked = true
    finish()
    await starting
    await vi.waitFor(() => expect(() => workflows.assertWorktreeDeletionIdle('/project')).not.toThrow())
    expect(value.worktrees).toEqual({})
  })

  it('plans, implements, reviews, tests, and fast-forward merges only after approval', async () => {
    const root = await repository()
    const workflows = await manager(root, new FakeVerification())
    const created = await workflows.create({ cwd: root, goal: 'add feature.txt' })

    await workflows.start(created.id)
    await waitForState(workflows, created.id, 'awaiting_plan')
    expect(workflows.get(created.id)?.plan).toContain('implement feature')
    expect(workflows.get(created.id)?.worktrees.planner).toBe(join(root, '.pion-workflow-worktrees', created.id, 'planner'))
    expect(git(root, 'status', '--porcelain')).toBe('')

    await settle(() => workflows.approvePlan(created.id))
    await waitForState(workflows, created.id, 'awaiting_merge')
    const candidate = workflows.get(created.id)
    expect(candidate?.review?.verdict).toBe('pass')
    expect(candidate?.verification?.state).toBe('passed')
    for (const role of ['planner', 'implementer', 'reviewer', 'tester'] as const) {
      expect(candidate?.worktrees[role]).toBe(join(root, '.pion-workflow-worktrees', created.id, role))
    }
    const metadataRoot = (workflows as unknown as { worktreeRoot: string }).worktreeRoot
    const permissions = JSON.parse(await readFile(join(metadataRoot, created.id, 'permissions.json'), 'utf8'))
    expect(permissions.projects[candidate!.worktrees.implementer!].write).toBe('allow')
    expect(permissions.projects[candidate!.worktrees.reviewer!].write).toBe('deny')
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(git(root, 'check-ignore', '--', '.pion-workflow-worktrees/')).toBe('.pion-workflow-worktrees/')
    expect(git(root, 'show', `${candidate?.candidateOid}:feature.txt`)).toBe('implemented')
    await expect(readFile(join(root, 'feature.txt'), 'utf8')).rejects.toThrow()

    const merged = await settle(() => workflows.merge(created.id))
    expect(merged.state).toBe('completed')
    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('implemented\n')

    const cleaned = await settle(() => workflows.cleanup(created.id))
    expect(cleaned.cleanupCompletedAt).toBeTypeOf('number')
    expect(cleaned.worktrees).toEqual({})
  })

  it('rejects merge when the target advances after review', async () => {
    const root = await repository()
    const workflows = await manager(root, new FakeVerification())
    const created = await workflows.create({ cwd: root, goal: 'add feature.txt' })
    await workflows.start(created.id)
    await waitForState(workflows, created.id, 'awaiting_plan')
    await settle(() => workflows.approvePlan(created.id))
    await waitForState(workflows, created.id, 'awaiting_merge')

    await writeFile(join(root, 'target-change.txt'), 'advanced\n')
    git(root, 'add', 'target-change.txt')
    git(root, 'commit', '-qm', 'advance target')
    const result = await settle(() => workflows.merge(created.id))
    expect(result.state).toBe('stale')
    await expect(readFile(join(root, 'feature.txt'), 'utf8')).rejects.toThrow()
  })

  it('reconciles running workers as interrupted without invisible restart', async () => {
    const root = await repository()
    const state = await mkdtemp(join(tmpdir(), 'pion-workflow-recovery-'))
    roots.push(state)
    const filePath = join(state, 'workflows.json')
    await mkdir(state, { recursive: true })
    await writeFile(filePath, JSON.stringify({
      version: 1,
      workflows: [{
        version: 1,
        id: 'interrupted-1',
        cwd: root,
        goal: 'unfinished work',
        state: 'implementing',
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
        workers: [{
          id: 'worker-1', role: 'implementer', kind: 'agent', status: 'running',
          outputTail: '', outputTruncated: false,
          permission: { read: true, write: true, shell: false, network: false, external: false, note: 'bounded' }
        }],
        worktrees: {},
        repairAttempts: 0,
        maxRepairAttempts: 2
      }]
    }))
    const recovered = new WorkflowManager({
      filePath,
      worktreeRoot: join(state, 'worktrees'),
      permissionExtensionPath: async () => join(state, 'permission.ts'),
      verification: new FakeVerification(),
      workerRunner: new FakeWorkers()
    })

    await recovered.load()
    expect(recovered.get('interrupted-1')).toMatchObject({
      state: 'interrupted',
      interruptedFrom: 'implementing',
      workers: [{ status: 'interrupted' }]
    })
  })

  it('requires an explicit test waiver when no verification command exists', async () => {
    const root = await repository()
    const workflows = await manager(root, new FakeVerification('not-found'))
    const created = await workflows.create({ cwd: root, goal: 'add feature.txt' })
    await workflows.start(created.id)
    await waitForState(workflows, created.id, 'awaiting_plan')
    await settle(() => workflows.approvePlan(created.id))
    await waitForState(workflows, created.id, 'blocked')

    expect(workflows.get(created.id)?.blockedReason).toBe('no-verification')
    const waived = await settle(() => workflows.waiveTests(created.id))
    expect(waived.state).toBe('awaiting_merge')
    expect(waived.verification?.state).toBe('waived')
  })
})
