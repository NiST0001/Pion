import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { WorkflowManager } from '../../src/main/workflow-manager'
import type { WorkflowRole, WorkflowSnapshot } from '../../src/shared/workflows'

const PRIMARY = resolve('/project')
const REQUESTED = resolve('/linked-project')
const METADATA = resolve('/user-data/workflows')
const MANAGED = join(PRIMARY, '.pion-workflow-worktrees')
const ID = '12345678-1234-4234-8234-123456789abc'
const BASE = 'a'.repeat(40)
const REQUEST_HEAD = 'b'.repeat(40)
const CANDIDATE = 'c'.repeat(40)
const projectPath = (role: WorkflowRole) => join(MANAGED, ID, role)
const legacyPath = (role: WorkflowRole) => join(METADATA, ID, role)

type Internal = {
  workflows: Map<string, WorkflowSnapshot>
  git(cwd: string, args: string[]): Promise<string>
  changed(workflow: WorkflowSnapshot): Promise<void>
  prepare(workflow: WorkflowSnapshot): Promise<void>
  recreateDetachedWorktree(workflow: WorkflowSnapshot, role: 'reviewer' | 'tester', oid: string): Promise<string>
}

type Node = { kind: 'directory' | 'file' | 'symlink'; ino: bigint }
type Record = { path: string; head: string; branch?: string }

// All filesystem/Git operations below are in-memory. No real user worktrees,
// SDK workers, commands or configuration directories may be opened by this suite.
describe('workflow worktree destinations and conservative cleanup', () => {
  let manager: WorkflowManager
  let internal: Internal
  let value: WorkflowSnapshot
  let nodes: Map<string, Node>
  let records: Record[]
  let dirty: Map<string, string>
  let refs: Map<string, string>
  let nextIno: bigint
  let fs: {
    mkdir: ReturnType<typeof vi.fn>
    writeFile: ReturnType<typeof vi.fn>
    realpath: ReturnType<typeof vi.fn>
    readFile: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
  }
  let ensure: ReturnType<typeof vi.fn>
  let commands: MockInstance<Internal['git']>

  function node(path: string, kind: Node['kind'] = 'directory'): void {
    if (!nodes.has(path)) nodes.set(path, { kind, ino: nextIno++ })
  }

  function registered(path: string, role: WorkflowRole, head = BASE): void {
    node(dirname(dirname(path)))
    node(dirname(path))
    node(path)
    node(join(path, '.git'), 'file')
    records.push({ path, head, branch: role === 'implementer' ? value.candidateBranch : undefined })
  }

  beforeEach(async () => {
    vi.resetModules()
    nodes = new Map()
    records = [
      { path: PRIMARY, head: BASE, branch: 'main' },
      { path: REQUESTED, head: REQUEST_HEAD, branch: 'requested' }
    ]
    dirty = new Map()
    refs = new Map()
    nextIno = 1n
    for (const path of [PRIMARY, REQUESTED, join(PRIMARY, '.git'), METADATA]) node(path)
    const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
    fs = {
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        if (nodes.has(path) && !options?.recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        node(path)
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(missing()),
      rename: vi.fn().mockResolvedValue(undefined),
      realpath: vi.fn(async (path: string) => {
        if (!nodes.has(path)) throw missing()
        return path
      })
    }
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      lstat: vi.fn(async (path: string) => {
        const entry = nodes.get(path)
        if (!entry) throw missing()
        return { dev: 1n, ino: entry.ino,
          isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file',
          isSymbolicLink: () => entry.kind === 'symlink' }
      })
    }))
    ensure = vi.fn(async () => { node(MANAGED); return MANAGED })
    vi.doMock('../../src/main/git', () => ({ ensureProjectWorktreeDirectory: ensure, runGit: vi.fn() }))
    vi.doMock('../../src/main/workflow/runners', () => ({ PiWorkflowWorkerRunner: class {}, VerificationWorkflowRunner: class {} }))
    vi.doMock('node:child_process', () => ({ execFile: vi.fn(() => { throw new Error('real Git forbidden') }) }))
    vi.doMock('electron', () => ({ BrowserWindow: class {} }))
    const { WorkflowManager } = await import('../../src/main/workflow-manager')
    manager = new WorkflowManager({
      filePath: join(METADATA, 'workflows.json'), worktreeRoot: METADATA,
      permissionExtensionPath: async () => 'unused',
      workerRunner: { run: vi.fn(), cancel: vi.fn() },
      verification: { run: vi.fn(), cancel: vi.fn() }
    })
    internal = manager as unknown as Internal
    vi.spyOn(internal, 'changed').mockResolvedValue(undefined)
    commands = vi.spyOn(internal, 'git').mockImplementation(async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return records.map((entry) => `worktree ${entry.path}\0HEAD ${entry.head}\0${entry.branch ? `branch refs/heads/${entry.branch}` : 'detached'}\0\0`).join('')
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        const branching = args[2] === '-b'
        const path = args[branching ? 4 : 3]
        registered(path, branching ? 'implementer' : 'reviewer', args.at(-1)!)
        if (branching) refs.set(args[3], args.at(-1)!)
        return ''
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const path = args.at(-1)!
        records = records.filter((entry) => entry.path !== path)
        nodes.delete(path)
        nodes.delete(join(path, '.git'))
        return ''
      }
      if (args[0] === 'status') return dirty.get(cwd) ?? ''
      if (args[0] === 'rev-parse') {
        if (args.includes('--show-toplevel')) return cwd
        if (args.includes('--git-common-dir')) return join(PRIMARY, '.git')
        return records.find((entry) => entry.path === cwd)?.head ?? BASE
      }
      if (args[0] === 'symbolic-ref') return records.find((entry) => entry.path === cwd)?.branch ?? ''
      if (args[0] === 'checkout') {
        records.find((entry) => entry.path === cwd)!.head = args[2]
        return ''
      }
      if (args[0] === 'for-each-ref') {
        const contains = args.find((arg) => arg.startsWith('--contains='))?.slice('--contains='.length)
        if (contains) return [BASE, REQUEST_HEAD, CANDIDATE].includes(contains) ? BASE : ''
        return refs.get(value.candidateBranch!) ?? ''
      }
      if (args[0] === 'merge-base') return ''
      if (args[0] === 'branch' && args[1] === '-d') { refs.delete(args.at(-1)!); return '' }
      throw new Error(`unexpected Git command: ${args.join(' ')}`)
    })
    value = { version: 1, id: ID, cwd: REQUESTED, goal: 'feature', state: 'preparing',
      createdAt: 1, updatedAt: 1, revision: 0, workers: [], worktrees: {}, repairAttempts: 0, maxRepairAttempts: 2 }
    internal.workflows.set(ID, value)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const path of ['node:fs/promises', 'node:child_process', 'electron', '../../src/main/git', '../../src/main/workflow/runners']) vi.doUnmock(path)
    vi.resetModules()
  })

  it.each(['read-error', 'malformed', 'invalid-entry'] as const)('preserves storage and blocks writes after %s', async (failure) => {
    if (failure === 'read-error') fs.readFile.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    else fs.readFile.mockResolvedValueOnce(failure === 'malformed' ? '{broken' : JSON.stringify({ version: 1, workflows: [null] }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(manager.load()).resolves.toBeUndefined()
    await expect(manager.flush()).rejects.toThrow(/已保留原文件/)
    await expect(manager.cleanup(ID)).rejects.toThrow(/已保留原文件/)
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()
  })

  it.each(['writeFile', 'rename'] as const)('stops queued and shutdown persistence after a %s failure', async (operation) => {
    let fail!: (error: Error) => void
    fs[operation].mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const first = manager.flush()
    const second = manager.flush()
    const firstRejected = expect(first).rejects.toThrow(/存储保存失败/)
    const secondRejected = expect(second).rejects.toThrow(/存储保存失败/)
    await vi.waitFor(() => expect(fs[operation]).toHaveBeenCalledTimes(1))
    fail(new Error(`${operation} failed`))
    await Promise.all([firstRejected, secondRejected])
    await expect(manager.flush()).rejects.toThrow(/存储保存失败/)
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(fs.mkdir).toHaveBeenCalledTimes(1)
    expect(fs.writeFile).toHaveBeenCalledTimes(1)
    expect(fs.rename).toHaveBeenCalledTimes(operation === 'rename' ? 1 : 0)
    expect(commands).not.toHaveBeenCalled()
  })

  it('treats only ENOENT as empty storage without writing an empty replacement', async () => {
    await manager.load()
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('rejects cleanup before Git when worker OS exit or stdio close is unknown', async () => {
    value.state = 'cancelled'
    value.worktrees.tester = projectPath('tester')
    registered(projectPath('tester'), 'tester')
    const runner = (manager as unknown as { runner: { assertWorktreeDeletionIdle?: (cwd: string) => void } }).runner
    runner.assertWorktreeDeletionIdle = vi.fn(() => { throw new Error('process exit/stdio close unknown') })
    await expect(manager.cleanup(ID)).rejects.toThrow(/exit\/stdio close unknown/)
    expect(commands).not.toHaveBeenCalled()
    expect(value.worktrees.tester).toBe(projectPath('tester'))
    expect(value.cleanupCompletedAt).toBeUndefined()
  })

  it('creates every new role under the real primary project while preserving requested cwd/HEAD and metadata', async () => {
    await internal.prepare(value)
    expect(value.cwd).toBe(REQUESTED)
    expect(value.baseOid).toBe(REQUEST_HEAD)
    expect(value.targetBranch).toBe('requested')
    for (const role of ['reviewer', 'tester'] as const) {
      await internal.recreateDetachedWorktree(value, role, CANDIDATE)
    }
    expect(value.worktrees).toEqual(Object.fromEntries(['planner', 'implementer', 'reviewer', 'tester'].map((role) => [role, projectPath(role as WorkflowRole)])))
    expect(ensure).toHaveBeenCalledWith(REQUESTED, '.pion-workflow-worktrees')
    const adds = commands.mock.calls.filter(([, args]) => args[0] === 'worktree' && args[1] === 'add')
    expect(adds).toHaveLength(4)
    expect(adds.slice(0, 2).every(([, args]) => args.at(-1) === REQUEST_HEAD)).toBe(true)
    expect(adds.every(([, args]) => dirname(args.at(-2)!) === join(MANAGED, ID))).toBe(true)
    const config = fs.writeFile.mock.calls.at(-1)!
    expect(config[0]).toBe(join(METADATA, ID, 'permissions.json'))
    expect(JSON.parse(config[1]).projects[projectPath('implementer')].write).toBe('allow')
    expect(JSON.parse(config[1]).projects[projectPath('reviewer')].write).toBe('deny')
  })

  it('reuses registered legacy roles from mappings or worker history, but places missing roles in the project', async () => {
    value.baseOid = REQUEST_HEAD
    value.candidateBranch = `pion/${ID.slice(0, 8)}/candidate`
    for (const role of ['planner', 'implementer'] as const) {
      value.worktrees[role] = legacyPath(role)
      registered(legacyPath(role), role, REQUEST_HEAD)
    }
    const oldTester = legacyPath('tester')
    registered(oldTester, 'tester')
    value.workers.push({ id: 'tester-worker', role: 'tester', kind: 'command', status: 'completed', worktreePath: oldTester,
      outputTail: '', outputTruncated: false, permission: { read: true, write: false, shell: false, network: false, external: false, note: 'test' } })
    await internal.prepare(value)
    expect(ensure).not.toHaveBeenCalled()
    expect(commands.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'add')).toBe(false)
    expect(await internal.recreateDetachedWorktree(value, 'reviewer', CANDIDATE)).toBe(projectPath('reviewer'))
    expect(await internal.recreateDetachedWorktree(value, 'tester', CANDIDATE)).toBe(oldTester)
    expect(commands).toHaveBeenCalledWith(oldTester, ['checkout', '--detach', CANDIDATE, '--'])
    expect(commands.mock.calls.filter(([, args]) => args[0] === 'worktree' && args[1] === 'add')).toHaveLength(1)
    expect(nodes.has(oldTester)).toBe(true)
    expect(value.workers[0].worktreePath).toBe(oldTester)
  })

  it('uses a project path when a persisted legacy role is confirmed absent, without recreating an external worktree', async () => {
    value.worktrees.reviewer = legacyPath('reviewer')
    expect(await internal.recreateDetachedWorktree(value, 'reviewer', CANDIDATE)).toBe(projectPath('reviewer'))
    expect(value.worktrees.reviewer).toBe(projectPath('reviewer'))
    expect(nodes.has(legacyPath('reviewer'))).toBe(false)
    expect(commands).toHaveBeenCalledWith(REQUESTED, ['worktree', 'add', '--detach', projectPath('reviewer'), CANDIDATE])
  })

  it.each(['reviewer', 'tester'] as const)('preserves an unknown existing %s directory rather than replacing it', async (role) => {
    node(MANAGED)
    node(join(MANAGED, ID))
    node(projectPath(role))
    await expect(internal.recreateDetachedWorktree(value, role, CANDIDATE)).rejects.toThrow(/真实登记/)
    expect(nodes.has(projectPath(role))).toBe(true)
    expect(commands.mock.calls.some(([, args]) => args[0] === 'worktree' && ['add', 'remove'].includes(args[1]))).toBe(false)
  })

  it.each(['../escape', 'uuid/../../escape', 'uuid\\escape'])('rejects unsafe workflow IDs before preparing paths: %s', async (id) => {
    value.id = id
    await expect(internal.recreateDetachedWorktree(value, 'reviewer', CANDIDATE)).rejects.toThrow(/ID/)
    expect(ensure).not.toHaveBeenCalled()
    expect(fs.mkdir).not.toHaveBeenCalled()
  })

  it('rejects a symlink workflow directory before adding a role', async () => {
    node(MANAGED)
    node(join(MANAGED, ID), 'symlink')
    await expect(internal.recreateDetachedWorktree(value, 'reviewer', CANDIDATE)).rejects.toThrow(/符号链接/)
    expect(commands.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'add')).toBe(false)
  })

  it('preserves a registered role if its real directory has become an alias', async () => {
    const path = projectPath('reviewer')
    registered(path, 'reviewer')
    value.worktrees.reviewer = path
    fs.realpath.mockImplementation(async (current: string) => current === path ? resolve('/other-directory') : current)
    await expect(internal.recreateDetachedWorktree(value, 'reviewer', CANDIDATE)).rejects.toThrow(/别名/)
    expect(nodes.has(path)).toBe(true)
    expect(commands.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
  })

  it('recreates only a clean registered project role using non-force Git removal', async () => {
    const path = projectPath('reviewer')
    registered(path, 'reviewer')
    value.worktrees.reviewer = path
    await internal.recreateDetachedWorktree(value, 'reviewer', CANDIDATE)
    expect(commands).toHaveBeenCalledWith(REQUESTED, ['worktree', 'remove', '--', path])
    expect(commands).toHaveBeenCalledWith(REQUESTED, ['worktree', 'add', '--detach', path, CANDIDATE])
    expect(records.find((entry) => entry.path === path)?.head).toBe(CANDIDATE)
    expect(commands.mock.calls.some(([, args]) => args.includes('--force') || args.includes('-D'))).toBe(false)
  })

  it('preserves dirty/ignored role files during recreation and records partial cleanup', async () => {
    for (const role of ['planner', 'tester'] as const) {
      registered(projectPath(role), role)
      value.worktrees[role] = projectPath(role)
    }
    dirty.set(projectPath('tester'), '!! build-cache\0')
    await expect(internal.recreateDetachedWorktree(value, 'tester', CANDIDATE)).rejects.toThrow(/忽略文件/)
    value.state = 'cancelled'
    const cleaned = await manager.cleanup(ID)
    expect(cleaned.worktrees).toEqual({ tester: projectPath('tester') })
    expect(cleaned.cleanupCompletedAt).toBeUndefined()
    expect(cleaned.error).toContain('已确认移除 1 个工作树')
    expect(nodes.has(projectPath('tester'))).toBe(true)
    expect(nodes.has(projectPath('planner'))).toBe(false)
    expect(commands.mock.calls.some(([, args]) => args[0] === 'branch')).toBe(false)
  })

  it.each(['project', 'legacy'] as const)('preserves clean unique detached commits during %s recreation and cleanup', async (layout) => {
    const path = layout === 'project' ? projectPath('tester') : legacyPath('tester')
    registered(path, 'tester', 'd'.repeat(40))
    value.worktrees.tester = path
    await expect(internal.recreateDetachedWorktree(value, 'tester', CANDIDATE)).rejects.toThrow('尚未被分支或标签保留')
    value.state = 'cancelled'
    const cleaned = await manager.cleanup(ID)
    expect(cleaned.worktrees.tester).toBe(path)
    expect(cleaned.cleanupCompletedAt).toBeUndefined()
    expect(nodes.has(path)).toBe(true)
    expect(commands.mock.calls.some(([, args]) => args[0] === 'checkout'
      || (args[0] === 'worktree' && args[1] === 'remove'))).toBe(false)
  })

  it('does not mark branch deletion failure as completed after confirmed worktree removal', async () => {
    value.state = 'completed'
    value.candidateOid = CANDIDATE
    value.candidateBranch = `pion/${ID.slice(0, 8)}/candidate`
    value.worktrees.implementer = projectPath('implementer')
    refs.set(value.candidateBranch, CANDIDATE)
    registered(projectPath('implementer'), 'implementer', CANDIDATE)
    const dispatch = commands.getMockImplementation()!
    commands.mockImplementation(async (cwd, args) => {
      if (args[0] === 'branch') throw new Error('branch still retained')
      return dispatch(cwd, args)
    })
    const cleaned = await manager.cleanup(ID)
    expect(cleaned.worktrees).toEqual({})
    expect(cleaned.cleanupCompletedAt).toBeUndefined()
    expect(cleaned.error).toContain('branch still retained')
    expect(refs.has(value.candidateBranch)).toBe(true)
    expect(commands).toHaveBeenCalledWith(REQUESTED, ['branch', '-d', '--', value.candidateBranch])
  })

  it('rejects ordinary project directories as cleanup targets', async () => {
    const path = join(PRIMARY, 'src')
    node(path)
    value.state = 'cancelled'
    value.worktrees.tester = path
    const cleaned = await manager.cleanup(ID)
    expect(cleaned.cleanupCompletedAt).toBeUndefined()
    expect(cleaned.worktrees.tester).toBe(path)
    expect(nodes.has(path)).toBe(true)
    expect(commands.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('retains cleanup reservations until the actual Git removal promise settles', async () => {
    value.state = 'cancelled'
    value.worktrees.tester = projectPath('tester')
    registered(projectPath('tester'), 'tester')
    let finish!: () => void
    const held = new Promise<void>((done) => { finish = done })
    const dispatch = commands.getMockImplementation()!
    commands.mockImplementation(async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') await held
      return dispatch(cwd, args)
    })
    const cleaning = manager.cleanup(ID)
    await vi.waitFor(() => expect(commands.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(true))
    await expect(manager.cleanup(ID)).rejects.toThrow(/正在进行/)
    expect(() => manager.assertWorktreeDeletionIdle(resolve('/unrelated'))).toThrow(/工作流/)
    finish()
    expect((await cleaning).cleanupCompletedAt).toBeTypeOf('number')
  })
})
