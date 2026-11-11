import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowManager,
  type WorkflowVerificationRunner,
  type WorkflowWorkerInput,
  type WorkflowWorkerResult,
  type WorkflowWorkerRunner
} from '../../src/main/workflow-manager'
import type { WorkflowSnapshot, WorkflowState } from '../../src/shared/workflows'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) }
})

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

async function storedManager(verification: WorkflowVerificationRunner = new FakeVerification()) {
  const state = await mkdtemp(join(tmpdir(), 'pion-workflow-state-'))
  roots.push(state)
  const value = new WorkflowManager({
    filePath: join(state, 'workflows.json'),
    worktreeRoot: join(state, 'worktrees'),
    permissionExtensionPath: async () => join(state, 'permission.ts'),
    verification,
    workerRunner: new FakeWorkers()
  })
  return { workflows: value, filePath: join(state, 'workflows.json') }
}

async function manager(_root: string, verification: WorkflowVerificationRunner): Promise<WorkflowManager> {
  const { workflows } = await storedManager(verification)
  await workflows.load()
  return workflows
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
  function isolatedManager(verification: WorkflowVerificationRunner = new FakeVerification()) {
    const workflows = new WorkflowManager({
      filePath: join(tmpdir(), 'unused-workflow.json'),
      worktreeRoot: join(tmpdir(), 'unused-worktrees'),
      permissionExtensionPath: async () => 'unused',
      verification, workerRunner: new FakeWorkers()
    })
    const internal = workflows as unknown as {
      workflows: Map<string, WorkflowSnapshot>
      changed(workflow: WorkflowSnapshot): Promise<void>
      git(cwd: string, args: string[]): Promise<string>
      launch(workflow: WorkflowSnapshot, operation: () => Promise<void>): void
      runAgent(workflow: WorkflowSnapshot, role: 'planner', cwd: string, prompt: string): Promise<string>
      test(workflow: WorkflowSnapshot): Promise<void>
      recreateDetachedWorktree(workflow: WorkflowSnapshot, role: 'tester', oid: string): Promise<string>
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

  async function phaseManager(state: WorkflowState) {
    const { workflows, filePath } = await storedManager()
    await workflows.load()
    const internal = workflows as unknown as ReturnType<typeof isolatedManager>['internal']
    const value: WorkflowSnapshot = {
      ...snapshot('12345678-1234-4234-8234-123456789abc', state),
      baseOid: 'a'.repeat(40), candidateOid: 'b'.repeat(40), candidateBranch: 'candidate', targetBranch: 'main',
      review: { verdict: 'pass', summary: 'reviewed', reviewedAt: 1 },
      verification: { state: 'passed', summary: 'verified' }, error: 'original problem'
    }
    internal.workflows.set(value.id, value)
    let merged = false
    const commands = vi.spyOn(internal, 'git').mockImplementation(async (_cwd, args) => {
      if (args[0] === 'symbolic-ref') return 'main'
      if (args[0] === 'status') return ''
      if (args[0] === 'merge') { merged = true; return '' }
      if (args[0] === 'rev-parse') {
        return args[1] === 'HEAD' && !merged ? value.baseOid! : value.candidateOid!
      }
      throw new Error(`unexpected Git command: ${args.join(' ')}`)
    })
    const launch = vi.spyOn(internal, 'launch').mockImplementation(() => undefined)
    await workflows.flush()
    vi.mocked(fs.rename).mockClear()
    return { workflows, filePath, value, commands, launch }
  }

  it.each([
    ['start', 'awaiting_start'], ['merge', 'awaiting_merge']
  ] as const)('retries %s after a pre-dispatch save failure without issuing work', async (action, state) => {
    const { workflows, filePath, value, commands, launch } = await phaseManager(state)
    const before = structuredClone(value)
    const source = await readFile(filePath, 'utf8')
    const failure = Object.assign(new Error('disk full before dispatch'), { code: 'ENOSPC' })
    vi.mocked(fs.rename).mockRejectedValueOnce(failure)
    await expect(workflows[action](value.id)).rejects.toMatchObject({ cause: failure })
    expect(value).toEqual({ ...before, revision: before.revision + 1, updatedAt: value.updatedAt })
    expect(await readFile(filePath, 'utf8')).toBe(source)
    expect(launch).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()
    const retried = await workflows[action](value.id)
    const expected = action === 'merge' ? 'completed' : 'preparing'
    expect(retried).toMatchObject({ state: expected, error: undefined })
    expect(launch).toHaveBeenCalledTimes(expected === 'completed' ? 0 : 1)
    expect(commands.mock.calls.filter(([, args]) => args[0] === 'merge')).toHaveLength(action === 'merge' ? 1 : 0)
  })

  it('preserves cancellation when an older pre-dispatch save fails', async () => {
    const { workflows, value, commands, launch } = await phaseManager('awaiting_start')
    let fail!: (error: Error) => void
    vi.mocked(fs.rename).mockImplementationOnce(() => new Promise<void>((_done, reject) => { fail = reject }))
    const failure = Object.assign(new Error('old save failed'), { code: 'ENOSPC' })
    const rejected = expect(workflows.start(value.id)).rejects.toMatchObject({ cause: failure })
    await vi.waitFor(() => expect(fs.rename).toHaveBeenCalledOnce())
    const stopping = workflows.cancel(value.id)
    expect(() => workflows.assertWorktreeDeletionIdle('/project')).toThrow(/工作流/)
    fail(failure)
    await rejected
    await stopping
    expect(value).toMatchObject({ state: 'cancelled', error: undefined })
    expect(commands).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('retains an issued merge and its completed state when the later save fails', async () => {
    const { workflows, value, commands } = await phaseManager('awaiting_merge')
    const command = commands.getMockImplementation()!
    const failure = Object.assign(new Error('disk full after merge'), { code: 'ENOSPC' })
    commands.mockImplementation(async (cwd, args) => {
      const result = await command(cwd, args)
      if (args[0] === 'merge') vi.mocked(fs.rename).mockRejectedValueOnce(failure)
      return result
    })
    await expect(workflows.merge(value.id)).rejects.toMatchObject({ cause: failure })
    expect(value).toMatchObject({ state: 'completed', mergeOid: value.candidateOid })
    await expect(workflows.merge(value.id)).rejects.toThrow(/尚未到达/)
    await workflows.flush()
    expect(commands.mock.calls.filter(([, args]) => args[0] === 'merge')).toHaveLength(1)
  })

  it.each(['invalid', 'unreadable'])('keeps %s storage read failures isolated from later saves', async (failure) => {
    const { workflows, filePath } = await storedManager()
    const source = failure === 'invalid' ? '{broken' : JSON.stringify({ version: 1, workflows: [] })
    await writeFile(filePath, source)
    if (failure === 'unreadable') vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('read denied'), { code: 'EACCES' }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await workflows.load()
    const rename = vi.mocked(fs.rename)
    await expect(workflows.create({ cwd: '/project', goal: 'preserve source' })).rejects.toThrow(/存储读取失败/)
    await expect(workflows.flush()).rejects.toThrow(/存储读取失败/)
    expect(workflows.list()).toEqual([])
    expect(rename).not.toHaveBeenCalled()
    expect(await readFile(filePath, 'utf8')).toBe(source)
  })

  it('retains recovered workflows and their source after EACCES, then allows an explicit flush retry', async () => {
    const { workflows, filePath } = await storedManager()
    const source = JSON.stringify({ version: 1, workflows: [snapshot('recovered', 'planning')] })
    await writeFile(filePath, source)
    const failure = Object.assign(new Error('recovery save denied'), { code: 'EACCES' })
    vi.mocked(fs.rename).mockRejectedValueOnce(failure)
    await expect(workflows.load()).rejects.toMatchObject({ cause: failure })
    expect(workflows.get('recovered')).toMatchObject({ state: 'interrupted', interruptedFrom: 'planning', revision: 1 })
    expect(await readFile(filePath, 'utf8')).toBe(source)
    await workflows.load()
    expect(fs.rename).toHaveBeenCalledOnce()
    await workflows.flush()
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as { workflows: WorkflowSnapshot[] }
    expect(saved.workflows[0]).toMatchObject({ id: 'recovered', state: 'interrupted', interruptedFrom: 'planning', revision: 1 })
    expect(fs.rename).toHaveBeenCalledTimes(2)
  })

  it('keeps pending filesystem saves serial and reserved, then reports failure before a newer save succeeds', async () => {
    const { workflows, filePath } = await storedManager()
    await workflows.load()
    vi.spyOn(workflows as unknown as { git(cwd: string, args: string[]): Promise<string> }, 'git').mockImplementation(async cwd => resolve(cwd))
    let fail!: (error: Error) => void
    vi.mocked(fs.rename).mockImplementationOnce(() => new Promise<void>((_done, reject) => { fail = reject }))
    const first = workflows.create({ cwd: '/project', goal: 'first intended state' })
    const rejected = expect(first).rejects.toThrow(/存储保存失败/)
    await vi.waitFor(() => expect(fs.rename).toHaveBeenCalledOnce())
    let finished = false
    const second = workflows.create({ cwd: '/project', goal: 'latest intended state' }).then(value => {
      finished = true
      return value
    })
    await vi.waitFor(() => expect(workflows.list()).toHaveLength(2))
    expect(finished).toBe(false)
    expect(fs.rename).toHaveBeenCalledOnce()
    expect(() => workflows.assertWorktreeDeletionIdle('/project')).toThrow(/工作流/)
    expect(() => workflows.assertWorktreeDeletionIdle('/unrelated')).not.toThrow()
    fail(Object.assign(new Error('save denied'), { code: 'EACCES' }))
    await rejected
    await second
    expect(() => workflows.assertWorktreeDeletionIdle('/project')).not.toThrow()
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as { workflows: WorkflowSnapshot[] }
    expect(saved.workflows.map(value => value.goal)).toEqual(['first intended state', 'latest intended state'])
  })

  it('retains storage isolation when its owner reports an unknown close', async () => {
    const { workflows } = await storedManager()
    await workflows.load()
    const failure = Object.assign(new Error('filesystem close unknown'), { closeUnknown: true })
    vi.mocked(fs.rename).mockRejectedValueOnce(failure)
    await expect(workflows.flush()).rejects.toMatchObject({ closeUnknown: true, cause: failure })
    await expect(workflows.flush()).rejects.toMatchObject({ closeUnknown: true, cause: failure })
    await expect(workflows.create({ cwd: '/project', goal: 'retain unknown source' })).rejects.toMatchObject({ closeUnknown: true })
    await expect(workflows.shutdown()).rejects.toMatchObject({ closeUnknown: true })
    expect(fs.rename).toHaveBeenCalledOnce()
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

  it('preserves cancellation after a pending verification rejects', async () => {
    const verification = Object.assign(new FakeVerification(), { assertWorktreeDeletionIdle: vi.fn() })
    let finish!: () => void
    const pending = new Promise<void>((done) => { finish = done })
    let start!: () => void
    const started = new Promise<void>((done) => { start = done })
    vi.spyOn(verification, 'run').mockImplementationOnce(async () => {
      start()
      await pending
      throw new Error('verification stopped')
    })
    const { workflows, internal } = isolatedManager(verification)
    vi.spyOn(workflows, 'flush').mockResolvedValue(undefined)
    vi.spyOn(internal, 'recreateDetachedWorktree').mockResolvedValue('/project/tester')
    const value = snapshot('pending-verification', 'reviewing')
    value.candidateOid = 'a'.repeat(40)
    internal.workflows.set(value.id, value)
    internal.launch(value, () => internal.test(value))
    await started
    await workflows.cancel(value.id)
    expect(value.state).toBe('cancelled')
    expect(value.workers[0].exitConfirmed).toBe(false)
    finish()
    await waitForState(workflows, value.id, 'cancelled')
    expect(value.workers[0]).toMatchObject({ status: 'cancelled', exitConfirmed: true })
    expect(value.verification).toBeUndefined()
  })

  it('joins an admitted start save and closes mutation admission during shutdown', async () => {
    const { workflows, internal } = isolatedManager()
    vi.spyOn(workflows, 'flush').mockResolvedValue(undefined)
    const value = snapshot('pending-start')
    const execute = vi.spyOn(internal.runner, 'run')
    internal.workflows.set(value.id, value)
    let release!: () => void
    vi.mocked(internal.changed).mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const starting = workflows.start(value.id)
    let settled = false
    const shutdown = workflows.shutdown().then(() => { settled = true })
    expect(workflows.shutdown()).toBe(workflows.shutdown())
    await expect(workflows.start(value.id)).rejects.toThrow(/已关闭/)
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await Promise.all([starting, shutdown])
    expect(value.state).toBe('interrupted')
    expect(execute).not.toHaveBeenCalled()
    expect(value.workers).toEqual([])
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
    expect(() => workflows.assertWorktreeDeletionIdle('/unrelated')).not.toThrow()
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
    const { workflows, filePath } = await storedManager()
    const value = snapshot('interrupted-1', 'implementing')
    value.workers = [{
      id: 'worker-1', role: 'implementer', kind: 'agent', status: 'running',
      outputTail: '', outputTruncated: false,
      permission: { read: true, write: true, shell: false, network: false, external: false, note: 'bounded' }
    }]
    await writeFile(filePath, JSON.stringify({ version: 1, workflows: [value] }))
    await workflows.load()
    expect(workflows.get(value.id)).toMatchObject({
      state: 'interrupted', interruptedFrom: 'implementing',
      workers: [{ status: 'interrupted', exitConfirmed: false }]
    })
    await expect(workflows.resume(value.id)).rejects.toThrow(/退出尚未确认/)
    await expect(workflows.cleanup(value.id)).rejects.toThrow(/退出尚未确认/)
    await expect(workflows.shutdown()).rejects.toMatchObject({ closeUnknown: true })
    expect(() => workflows.assertWorktreeDeletionIdle(value.cwd)).toThrow(/工作流/)
    expect(() => workflows.assertWorktreeDeletionIdle('/unrelated')).not.toThrow()
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
