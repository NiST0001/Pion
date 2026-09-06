import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkflowManager,
  type WorkflowVerificationRunner,
  type WorkflowWorkerInput,
  type WorkflowWorkerResult,
  type WorkflowWorkerRunner
} from '../../src/main/workflow-manager'
import type { WorkflowState } from '../../src/shared/workflows'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pion-workflow-'))
  roots.push(root)
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
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (manager.get(id)?.state === state) return
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`workflow did not reach ${state}; current=${manager.get(id)?.state}`)
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
  it('plans, implements, reviews, tests, and fast-forward merges only after approval', async () => {
    const root = await repository()
    const workflows = await manager(root, new FakeVerification())
    const created = await workflows.create({ cwd: root, goal: 'add feature.txt' })

    await workflows.start(created.id)
    await waitForState(workflows, created.id, 'awaiting_plan')
    expect(workflows.get(created.id)?.plan).toContain('implement feature')
    expect(git(root, 'status', '--porcelain')).toBe('')

    await settle(() => workflows.approvePlan(created.id))
    await waitForState(workflows, created.id, 'awaiting_merge')
    const candidate = workflows.get(created.id)
    expect(candidate?.review?.verdict).toBe('pass')
    expect(candidate?.verification?.state).toBe('passed')
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
