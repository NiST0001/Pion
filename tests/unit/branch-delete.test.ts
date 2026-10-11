import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

describe('branch deletion isolated mock fixtures', () => {
  const mocks = { git: vi.fn(), realpath: vi.fn(), lstat: vi.fn() }
  let deleteWorktreeBranch: typeof import('../../src/main/git/branch-delete').deleteWorktreeBranch
  let prepareWorktreeBranchDeletion: typeof import('../../src/main/git/branch-delete').prepareWorktreeBranchDeletion
  let parseDeletionWorktrees: typeof import('../../src/main/git/branch-delete').parseDeletionWorktrees

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../src/main/git', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../src/main/git')>(),
      runGit: mocks.git
    }))
    vi.doMock('node:fs/promises', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:fs/promises')>(),
      realpath: mocks.realpath,
      lstat: mocks.lstat
    }))
    ;({ deleteWorktreeBranch, prepareWorktreeBranchDeletion, parseDeletionWorktrees } = await import('../../src/main/git/branch-delete'))
  })
  afterAll(() => {
    vi.doUnmock('../../src/main/git')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })

  const root = resolve('/pion-tests/project')
  const target = resolve('/pion-tests/branches/space and\nnewline')
  const common = join(root, '.git')
  const sha = 'a'.repeat(40)
  const changedSha = 'b'.repeat(40)
  let removed: boolean
  let deleted: boolean
  let dirty: string
  let targetBranch: string
  let targetTip: string
  let mainTip: string
  let targetFlags: string[]
  let mainPath: string
  let targetPath: string
  let targetTop: string
  let targetCommon: string
  let superproject: string
  let dotGitDirectory: boolean
  let inodeChanged: string | undefined
  let recreated: boolean
  let extraRecords: string
  let removeError: boolean
  let deleteError: boolean
  let notMerged: boolean

  function record(path: string, head: string, branch: string, flags: string[] = []): string {
    return [`worktree ${path}`, `HEAD ${head}`, ...(branch ? [`branch refs/heads/${branch}`] : []), ...flags, '', ''].join('\0')
  }
  function listing(): string {
    return record(mainPath, mainTip, 'main')
      + (removed ? '' : record(targetPath, targetTip, targetBranch, targetFlags)) + extraRecords
  }
  function sideEffects(): string[][] {
    return mocks.git.mock.calls.map(([, args]) => args as string[])
      .filter((args) => (args[0] === 'worktree' && args[1] === 'remove') || (args[0] === 'branch' && args[1] === '-d'))
  }
  function idleWith(action: (count: number) => void): () => Promise<void> {
    let count = 0
    return vi.fn(async () => { action(++count) })
  }

  beforeEach(() => {
    // Reset only this suite's fixtures, never another coverage-imported suite's mocks.
    for (const mock of Object.values(mocks)) mock.mockReset()
    removed = false; deleted = false; dirty = ''; targetBranch = 'feature'; targetTip = sha; mainTip = sha
    targetFlags = []; mainPath = root; targetPath = target; targetTop = target; targetCommon = common
    superproject = ''; dotGitDirectory = false; inodeChanged = undefined; recreated = false
    extraRecords = ''; removeError = false; deleteError = false; notMerged = false
    mocks.realpath.mockImplementation(async (path: string) => path)
    mocks.lstat.mockImplementation(async (path: string) => {
      if (path === target && removed && !recreated) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      const file = path === join(target, '.git') && !dotGitDirectory
      return { dev: 1n, ino: path === inodeChanged ? 2n : 1n, isSymbolicLink: () => false, isDirectory: () => !file, isFile: () => file }
    })
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      const command = args.join(' ')
      if (command === 'check-ref-format --branch feature') return ''
      if (command === 'worktree list --porcelain -z') return listing()
      if (command === 'rev-parse --verify HEAD') return `${cwd === root ? mainTip : targetTip}\n`
      if (command === 'rev-parse --verify refs/heads/feature') return `${targetTip}\n`
      if (command === 'rev-parse --path-format=absolute --git-common-dir') return `${cwd === root ? common : targetCommon}\n`
      if (command === 'rev-parse --show-toplevel') return `${cwd === root ? root : targetTop}\n`
      if (command === 'rev-parse --show-superproject-working-tree') return `${cwd === root ? '' : superproject}\n`
      if (command === 'symbolic-ref --quiet HEAD') return `refs/heads/${cwd === root ? 'main' : targetBranch}\n`
      if (args[0] === 'merge-base') { if (notMerged) throw new Error('not ancestor'); return '' }
      if (args[0] === 'status') return dirty
      if (command === `worktree remove -- ${target}`) {
        if (removeError) throw new Error('remove failed')
        removed = true; return ''
      }
      if (command === 'branch -d -- feature') {
        if (deleteError) throw new Error('delete failed')
        deleted = true; return ''
      }
      throw new Error(`Unexpected mock Git command: ${command}`)
    })
  })

  const remove = (idle: () => void | Promise<void> = vi.fn()) => deleteWorktreeBranch(root, target, 'feature', idle)

  describe('NUL worktree deletion parser', () => {
    it('preserves space and LF paths without line parsing', () => {
      expect(parseDeletionWorktrees(listing()).map((item) => item.path)).toEqual([root, target])
    })
    it.each(['', 'worktree /x\nHEAD abc\n', `worktree /x\0HEAD ${sha}\0`, `worktree /x\0HEAD bad\0\0`,
      `worktree /x\0HEAD ${sha}\0HEAD ${sha}\0\0`, `worktree /x\0HEAD ${sha}\0unknown\0\0`])('rejects malformed records %j', (output) => {
      expect(() => parseDeletionWorktrees(output)).toThrow()
    })
    it('rejects duplicated registrations', () => {
      expect(() => parseDeletionWorktrees(listing() + record(target, sha, 'feature'))).toThrow()
    })
  })

  describe('prepareWorktreeBranchDeletion: captured one-shot transaction', () => {
    it('performs read-only preflight without removing the worktree or branch', async () => {
      const idle = vi.fn()
      const commit = await prepareWorktreeBranchDeletion(root, target, 'feature', idle)
      expect(commit).toEqual(expect.any(Function))
      expect(idle).toHaveBeenCalledTimes(1)
      expect(mocks.realpath).toHaveBeenCalled()
      expect(mocks.lstat).toHaveBeenCalled()
      expect(mocks.git).toHaveBeenCalledWith(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], expect.any(Object))
      expect(sideEffects()).toEqual([])
      expect(removed).toBe(false)
      expect(deleted).toBe(false)
    })

    it('rejects identity, tip and dirty changes during backend shutdown without side effects', async () => {
      for (const change of ['identity', 'tip', 'dirty']) {
        const commit = await prepareWorktreeBranchDeletion(root, target, 'feature', vi.fn())
        // Simulate the caller awaiting actual backend exit after preflight.
        await Promise.resolve()
        if (change === 'identity') inodeChanged = target
        if (change === 'tip') targetTip = changedSha
        if (change === 'dirty') dirty = '?? appeared-during-shutdown\0'
        await expect(commit()).rejects.toThrow()
        expect(sideEffects()).toEqual([])
        expect(removed).toBe(false)
        expect(deleted).toBe(false)
        inodeChanged = undefined; targetTip = sha; dirty = ''
      }
    })

    it('allows one attempt only, rejecting concurrent, completed and failed retries without reexecution', async () => {
      let release!: () => void
      const waitingForIdle = new Promise<void>((resolve) => { release = resolve })
      const idle = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => waitingForIdle)
      const commit = await prepareWorktreeBranchDeletion(root, target, 'feature', idle)
      const first = commit()
      const callsWhilePending = mocks.git.mock.calls.length
      await expect(commit()).rejects.toThrow('删除事务已经尝试')
      expect(mocks.git).toHaveBeenCalledTimes(callsWhilePending)
      expect(idle).toHaveBeenCalledTimes(2)
      expect(sideEffects()).toEqual([])
      release()
      await expect(first).resolves.toEqual({ worktreeRemoved: true, branchDeleted: true })
      const callsAfterSuccess = mocks.git.mock.calls.length
      await expect(commit()).rejects.toThrow('删除事务已经尝试')
      expect(mocks.git).toHaveBeenCalledTimes(callsAfterSuccess)
      expect(sideEffects()).toEqual([['worktree', 'remove', '--', target], ['branch', '-d', '--', 'feature']])

      removed = false; deleted = false
      const failedCommit = await prepareWorktreeBranchDeletion(root, target, 'feature', vi.fn())
      dirty = '!! late-file\0'
      await expect(failedCommit()).rejects.toThrow()
      dirty = ''
      const callsAfterFailure = mocks.git.mock.calls.length
      await expect(failedCommit()).rejects.toThrow('删除事务已经尝试')
      expect(mocks.git).toHaveBeenCalledTimes(callsAfterFailure)
      expect(sideEffects()).toHaveLength(2)
      expect(removed).toBe(false)
      expect(deleted).toBe(false)
    })
  })

  describe('deleteWorktreeBranch: mock-only safety boundaries', () => {
    it('uses no shell, force, filesystem deletion, or upstream-only merge inference', async () => {
      const idle = vi.fn()
      expect(await remove(idle)).toEqual({ worktreeRemoved: true, branchDeleted: true })
      expect(deleted).toBe(true)
      expect(idle).toHaveBeenCalledTimes(3)
      expect(sideEffects()).toEqual([['worktree', 'remove', '--', target], ['branch', '-d', '--', 'feature']])
      expect(mocks.git).toHaveBeenCalledWith(root, ['merge-base', '--is-ancestor', sha, sha], expect.any(Object))
      expect(mocks.git).toHaveBeenCalledWith(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], expect.objectContaining({ trim: false }))
      for (const [, args, options] of mocks.git.mock.calls) {
        expect(args).not.toContain('-D'); expect(args).not.toContain('-f'); expect(args).not.toContain('--force')
        expect(options).toMatchObject({ trim: false, timeout: 30_000 })
      }
      // Only read-only filesystem methods are overridden; no real filesystem/Git operations are requested.
    })
    it.each([null, undefined, 42, {}, '', 'relative', `${root}\0bad`, join(root, '.git'), `${root}/../project`, 'x'.repeat(4097)])('fails closed for invalid paths %j', async (value) => {
      await expect(deleteWorktreeBranch(value as string, target, 'feature', vi.fn())).rejects.toThrow()
      expect(mocks.git).not.toHaveBeenCalled()
    })
    it.each([null, undefined, 42, {}, '', '-feature', 'refs/heads/feature', 'a\nb', 'x'.repeat(513)])('fails closed for invalid names %j', async (value) => {
      await expect(deleteWorktreeBranch(root, target, value as string, vi.fn())).rejects.toThrow()
      expect(mocks.git).not.toHaveBeenCalled()
    })
    it('rejects missing lifecycle callback', async () => {
      await expect(deleteWorktreeBranch(root, target, 'feature', undefined as never)).rejects.toThrow()
      expect(sideEffects()).toEqual([])
    })
    it.each([root, join(root, 'nested'), dirname(root)])('rejects main and nested/ancestor targets %s', async (path) => {
      await expect(deleteWorktreeBranch(root, path, 'feature', vi.fn())).rejects.toThrow()
      expect(sideEffects()).toEqual([])
    })
    it.each(['detached', 'locked', 'locked user reason', 'prunable', 'prunable missing path'])('rejects flagged targets %s', async (flag) => {
      targetFlags = [flag]
      await expect(remove()).rejects.toThrow()
      expect(sideEffects()).toEqual([])
    })
    it.each([' M file\0', '?? untracked\0', '!! ignored\0', 'R  new\0old\0'])('rejects all nonempty status output %j', async (status) => {
      dirty = status
      await expect(remove()).rejects.toThrow()
      expect(sideEffects()).toEqual([])
    })
    it.each(['foreign', 'submodule', 'wrong-branch', 'unregistered', 'wrong-project', 'git-directory', 'symlink', 'unmerged', 'other-checkout'])('rejects %s before side effects', async (kind) => {
      if (kind === 'foreign') targetCommon = resolve('/foreign/.git')
      if (kind === 'submodule') superproject = root
      if (kind === 'wrong-branch') targetBranch = 'other'
      if (kind === 'unregistered') targetPath = resolve('/other/worktree')
      if (kind === 'wrong-project') mainPath = resolve('/other/main')
      if (kind === 'git-directory') dotGitDirectory = true
      if (kind === 'symlink') mocks.realpath.mockImplementation(async (path: string) => path === target ? resolve('/alias') : path)
      if (kind === 'unmerged') notMerged = true
      if (kind === 'other-checkout') extraRecords = record(resolve('/another/checkout'), sha, 'feature')
      await expect(remove()).rejects.toThrow()
      expect(sideEffects()).toEqual([])
    })
    it.each(['busy', 'dirty', 'target-tip', 'main-tip', 'root-inode', 'target-inode', 'parent-inode', 'locked'])('revalidates %s immediately before removal', async (kind) => {
      const idle = idleWith((count) => {
        if (count !== 2) return
        if (kind === 'busy') throw new Error('busy')
        if (kind === 'dirty') dirty = '!! late ignored\0'
        if (kind === 'target-tip') targetTip = changedSha
        if (kind === 'main-tip') mainTip = changedSha
        if (kind === 'root-inode') inodeChanged = root
        if (kind === 'target-inode') inodeChanged = target
        if (kind === 'parent-inode') inodeChanged = dirname(target)
        if (kind === 'locked') targetFlags = ['locked']
      })
      await expect(remove(idle)).rejects.toThrow()
      expect(sideEffects()).toEqual([])
    })
    it('does not delete the branch after a failed worktree remove', async () => {
      removeError = true
      await expect(remove()).rejects.toThrow('remove failed')
      expect(sideEffects()).toEqual([['worktree', 'remove', '--', target]])
      expect(deleted).toBe(false)
    })
    it('reports partial success on branch -d refusal without force/retry', async () => {
      deleteError = true
      expect(await remove()).toMatchObject({ worktreeRemoved: true, branchDeleted: false, warning: expect.any(String) })
      expect(sideEffects()).toHaveLength(2)
      expect(deleted).toBe(false)
    })
    it.each(['busy', 'target-tip', 'main-tip', 'parent-inode', 'root-inode', 'recreated', 'other-checkout'])('preserves partial success and skips branch deletion on late %s', async (kind) => {
      const idle = idleWith((count) => {
        if (count !== 3) return
        if (kind === 'busy') throw new Error('busy')
        if (kind === 'target-tip') targetTip = changedSha
        if (kind === 'main-tip') mainTip = changedSha
        if (kind === 'parent-inode') inodeChanged = dirname(target)
        if (kind === 'root-inode') inodeChanged = root
        if (kind === 'recreated') recreated = true
        if (kind === 'other-checkout') extraRecords = record(resolve('/another/checkout'), sha, 'feature')
      })
      expect(await remove(idle)).toMatchObject({ worktreeRemoved: true, branchDeleted: false, warning: expect.any(String) })
      expect(sideEffects()).toEqual([['worktree', 'remove', '--', target]])
    })
  })
})
