import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

interface MockStat {
  dev: bigint
  ino: bigint
  size: bigint
  nlink: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}
interface MockFile {
  stat(options: { bigint: true }): Promise<MockStat>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>
  close(): Promise<void>
}
const fsConstants = { ...constants }
const mocks = {
  git: vi.fn<(cwd: string, args: string[]) => Promise<string>>(),
  existsSync: vi.fn<(path: string) => boolean>(),
  mkdir: vi.fn<(path: string, options?: { recursive?: boolean }) => Promise<void>>(),
  lstat: vi.fn<(path: string, options?: { bigint: true }) => Promise<MockStat>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  open: vi.fn<(path: string, flags: number, mode: number) => Promise<MockFile>>(),
  fdStat: vi.fn<(options: { bigint: true }) => Promise<MockStat>>(),
  fdRead: vi.fn<MockFile['read']>(),
  fdWrite: vi.fn<MockFile['write']>(),
  fdClose: vi.fn<MockFile['close']>()
}
let root: string
let linked: string
let worktreeRoot: string
let excludePath: string
const regularFile = (ino = 7): MockStat => ({
  dev: 1n, ino: BigInt(ino), size: 0n, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n,
  isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false
})
const directory = (ino = 1): MockStat => ({ ...regularFile(ino), isFile: () => false, isDirectory: () => true })
const symlink = (): MockStat => ({ ...regularFile(99), isFile: () => false, isSymbolicLink: () => true })
const fsError = (code: string) => Object.assign(new Error(code), { code })
let entries: Map<string, MockStat>
let files: Map<string, string>
let records: Array<{ path: string; branch: string }>
let createWorktreeBranch: typeof import('../../src/main/git').createWorktreeBranch
let listBranchInfos: typeof import('../../src/main/git').listBranchInfos
let canonicalProjectCwd: typeof import('../../src/main/git').canonicalProjectCwd
let ensureProjectWorktreeDirectory: typeof import('../../src/main/git').ensureProjectWorktreeDirectory
const addCalls = () => mocks.git.mock.calls.filter(([, args]) => args[0] === 'worktree' && args[1] === 'add')

describe('worktree location with scoped Git/filesystem mocks', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('node:child_process', async () => {
      const { promisify } = await import('node:util')
      return {
        execFile: Object.assign(vi.fn(), {
          [promisify.custom]: async (_file: string, args: string[]) => ({
            stdout: await mocks.git(args[1], args.slice(2)), stderr: ''
          })
        })
      }
    })
    vi.doMock('node:fs', () => ({ existsSync: mocks.existsSync, constants: fsConstants }))
    vi.doMock('node:fs/promises', () => ({
      mkdir: mocks.mkdir, lstat: mocks.lstat, realpath: mocks.realpath, open: mocks.open
    }))
    try {
      ;({ createWorktreeBranch, listBranchInfos, canonicalProjectCwd, ensureProjectWorktreeDirectory } = await import('../../src/main/git'))
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('node:fs')
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
  afterAll(() => {
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    fsConstants.O_NOFOLLOW = constants.O_NOFOLLOW
    root = resolve('mock-worktree-location', 'project')
    linked = join(dirname(root), '.pion-worktrees', 'project-old')
    worktreeRoot = join(root, '.pion-worktrees')
    excludePath = join(root, '.git', 'info', 'exclude')
    entries = new Map([[root, directory()], [linked, directory(2)], [dirname(excludePath), directory(3)], [excludePath, regularFile()]])
    files = new Map([[excludePath, '# user exclusions\nlocal-only']])
    records = [{ path: root, branch: 'main' }, { path: linked, branch: 'old' }]
    mocks.existsSync.mockImplementation((path) => entries.has(path))
    mocks.realpath.mockImplementation(async (path) => path)
    mocks.lstat.mockImplementation(async (path) => {
      const entry = entries.get(path)
      if (!entry) throw fsError('ENOENT')
      return { ...entry, size: files.has(path) ? BigInt(Buffer.byteLength(files.get(path)!)) : entry.size }
    })
    mocks.mkdir.mockImplementation(async (path, options) => {
      if (entries.has(path) && !options?.recursive) throw fsError('EEXIST')
      if (!entries.has(path)) entries.set(path, directory(4))
    })
    mocks.open.mockImplementation(async (path, flags) => {
      if ((flags & fsConstants.O_EXCL) && entries.has(path)) throw fsError('EEXIST')
      if ((flags & (fsConstants.O_NOFOLLOW ?? 0)) && entries.get(path)?.isSymbolicLink()) throw fsError('ELOOP')
      if (!entries.has(path)) {
        if (!(flags & fsConstants.O_CREAT)) throw fsError('ENOENT')
        entries.set(path, regularFile(8))
        files.set(path, '')
      }
      const identity = { ...entries.get(path)! }
      let content = files.get(path) ?? ''
      mocks.fdStat.mockImplementation(async () => ({ ...identity, size: BigInt(Buffer.byteLength(content)) }))
      mocks.fdRead.mockImplementation(async (buffer, offset, length, position) => ({
        bytesRead: Buffer.from(content).copy(buffer, offset, position, position + length)
      }))
      mocks.fdWrite.mockImplementation(async (buffer, offset, length) => {
        content += buffer.subarray(offset, offset + length).toString('utf8')
        identity.mtimeNs += 1n
        identity.ctimeNs += 1n
        files.set(path, content)
        entries.set(path, identity)
        return { bytesWritten: length }
      })
      return { stat: mocks.fdStat, read: mocks.fdRead, write: mocks.fdWrite, close: mocks.fdClose }
    })
    mocks.fdClose.mockResolvedValue()
    mocks.git.mockImplementation(async (cwd, args) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        if (cwd === linked) return `${linked}\n`
        if (cwd === root || cwd === join(root, 'src')) return `${root}\n`
      }
      if (args.join(' ') === 'worktree list --porcelain -z' && records.some((record) => record.path === cwd)) {
        return records.map((record) => `worktree ${record.path}\0HEAD ${'a'.repeat(40)}\0branch refs/heads/${record.branch}\0\0`).join('')
      }
      if (args.join(' ') === 'rev-parse --path-format=absolute --git-path info/exclude') return `${excludePath}\n`
      if (args[0] === 'check-ref-format' || args[0] === 'check-ignore') return ''
      if (args[0] === 'worktree' && args[1] === 'add') {
        records.push({ path: args[4], branch: args[3] })
        entries.set(args[4], directory(5))
        return ''
      }
      throw new Error(`Unexpected Git command: ${cwd}: ${args.join(' ')}`)
    })
  })

  it('uses the primary project directory and safe branch name, preserving local exclusions', async () => {
    const branch = await createWorktreeBranch(join(root, 'src'), ' feature/ui ')
    const target = join(worktreeRoot, 'feature-ui')
    expect(branch).toEqual({ name: 'feature/ui', cwd: target, gitBranch: 'feature/ui', isMain: false })
    expect(addCalls()).toEqual([[root, ['worktree', 'add', '-b', 'feature/ui', target]]])
    expect(files.get(excludePath)).toBe('# user exclusions\nlocal-only\n/.pion-worktrees/\n')
    const flags = mocks.open.mock.calls[0][1]
    expect(flags & constants.O_RDWR).toBe(constants.O_RDWR)
    expect(flags & constants.O_APPEND).toBe(constants.O_APPEND)
    expect(flags & (constants.O_CREAT | constants.O_TRUNC)).toBe(0)
    if (process.platform !== 'win32' && constants.O_NOFOLLOW) expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(mocks.fdWrite).toHaveBeenCalledWith(Buffer.from('\n/.pion-worktrees/\n'), 0, Buffer.byteLength('\n/.pion-worktrees/\n'), null)
    const addIndex = mocks.git.mock.calls.findIndex(([, args]) => args[0] === 'worktree' && args[1] === 'add')
    expect(mocks.fdClose.mock.invocationCallOrder[0]).toBeLessThan(mocks.git.mock.invocationCallOrder[addIndex])
    expect(mocks.mkdir).toHaveBeenCalledWith(worktreeRoot)
    expect(mocks.mkdir).not.toHaveBeenCalledWith(join(dirname(root), '.pion-worktrees'), expect.anything())
    expect(mocks.open.mock.calls.every(([path]) => path === excludePath)).toBe(true)
  })

  it.each(['\n', '\r\n'])('anchors linked worktree creation at main and does not duplicate an existing %j rule', async (eol) => {
    const content = `# user exclusions${eol}/.pion-worktrees/${eol}local-only${eol}`
    files.set(excludePath, content)
    const before = await listBranchInfos(linked)
    const branch = await createWorktreeBranch(linked, 'hotfix')
    expect(branch.cwd).toBe(join(worktreeRoot, 'hotfix'))
    expect(addCalls()).toEqual([[linked, ['worktree', 'add', '-b', 'hotfix', branch.cwd]]])
    expect(await listBranchInfos(linked)).toEqual([...before, branch])
    expect(before).toContainEqual({ name: 'old', cwd: linked, gitBranch: 'old', isMain: false })
    expect(entries.get(linked)).toMatchObject({ dev: 1n, ino: 2n })
    expect(files.get(excludePath)).toBe(content)
    expect(mocks.fdWrite).not.toHaveBeenCalled()
    expect(mocks.fdClose).toHaveBeenCalled()
  })

  it('preserves CRLF while adding a missing rule, and creates a missing local exclude file', async () => {
    files.set(excludePath, '# user exclusions\r\nlocal-only')
    await createWorktreeBranch(root, 'first')
    expect(files.get(excludePath)).toBe('# user exclusions\r\nlocal-only\r\n/.pion-worktrees/\r\n')
    files.delete(excludePath)
    entries.delete(excludePath)
    await createWorktreeBranch(root, 'second')
    expect(files.get(excludePath)).toBe('/.pion-worktrees/\n')
    const flags = mocks.open.mock.calls[1][1]
    expect(flags & (constants.O_CREAT | constants.O_EXCL | constants.O_APPEND)).toBe(constants.O_CREAT | constants.O_EXCL | constants.O_APPEND)
  })

  it('preserves NUL-delimited primary/linked paths with newlines, quotes and trailing whitespace', async () => {
    root = `${root}\n"primary" \n`
    linked = `${linked}\n"linked" \n`
    worktreeRoot = join(root, '.pion-worktrees')
    excludePath = join(root, '.git', 'info', 'exclude')
    entries.set(root, directory())
    entries.set(linked, directory(2))
    entries.set(excludePath, regularFile())
    files.set(excludePath, '# local\n')
    records = [{ path: root, branch: 'main' }, { path: linked, branch: 'old' }]
    expect(await listBranchInfos(linked)).toEqual([
      { name: 'main', cwd: root, gitBranch: 'main', isMain: true },
      { name: 'old', cwd: linked, gitBranch: 'old', isMain: false }
    ])
    expect(await canonicalProjectCwd(linked)).toBe(root)
    const branch = await createWorktreeBranch(linked, 'special')
    expect(branch.cwd).toBe(join(worktreeRoot, 'special'))
    expect(addCalls()).toEqual([[linked, ['worktree', 'add', '-b', 'special', branch.cwd]]])
    expect(mocks.git).toHaveBeenCalledWith(linked, ['worktree', 'list', '--porcelain', '-z'])
    expect(files.get(excludePath)).toBe('# local\n/.pion-worktrees/\n')
  })

  it('prepares workflow worktrees inside the primary project without creating a branch or moving old paths', async () => {
    const directory = join(root, '.pion-workflow-worktrees')
    await expect(ensureProjectWorktreeDirectory(linked, '.pion-workflow-worktrees')).resolves.toBe(directory)
    expect(files.get(excludePath)).toBe('# user exclusions\nlocal-only\n/.pion-workflow-worktrees/\n')
    expect(mocks.git).toHaveBeenCalledWith(root, ['check-ignore', '--quiet', '--no-index', '--', '.pion-workflow-worktrees/'])
    expect(addCalls()).toEqual([])
    expect(entries.has(linked)).toBe(true)
  })

  it('avoids a sanitized .git directory while preserving the original branch and collision suffixes', async () => {
    entries.set(join(worktreeRoot, 'branch'), directory(8))
    const branch = await createWorktreeBranch(root, '分支.git')
    expect(branch).toEqual({ name: '分支.git', cwd: join(worktreeRoot, 'branch-2'), gitBranch: '分支.git', isMain: false })
    expect(addCalls()).toEqual([[root, ['worktree', 'add', '-b', '分支.git', branch.cwd]]])
  })

  it('suffixes past missing registered paths, existing directories and dangling symlinks', async () => {
    const stale = join(worktreeRoot, 'feature-ui')
    records.push({ path: stale, branch: 'stale' })
    entries.set(join(worktreeRoot, 'feature-ui-2'), directory(6))
    entries.set(join(worktreeRoot, 'feature-ui-3'), symlink())
    const branch = await createWorktreeBranch(root, 'feature/ui')
    expect(branch.cwd).toBe(join(worktreeRoot, 'feature-ui-4'))
    expect(entries.has(stale)).toBe(false)
    expect(entries.get(join(worktreeRoot, 'feature-ui-3'))?.isSymbolicLink()).toBe(true)
    expect(await listBranchInfos(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ cwd: linked, gitBranch: 'old' }),
      expect.objectContaining({ cwd: stale, gitBranch: 'stale' }),
      branch
    ]))
    expect(mocks.git.mock.calls.filter(([, args]) => args[0] === 'worktree').every(([, args]) => ['list', 'add'].includes(args[1]))).toBe(true)
  })

  it.each(['open', 'read', 'append', 'close'])('does not create a worktree when local exclude %s fails', async (operation) => {
    const failure = fsError('EACCES')
    if (operation === 'open') mocks.open.mockRejectedValueOnce(failure)
    else if (operation === 'read') mocks.fdRead.mockRejectedValueOnce(failure)
    else if (operation === 'append') mocks.fdWrite.mockRejectedValueOnce(failure)
    else mocks.fdClose.mockRejectedValueOnce(failure)
    await expect(createWorktreeBranch(linked, 'blocked')).rejects.toBe(failure)
    expect(addCalls()).toEqual([])
    expect(mocks.mkdir).not.toHaveBeenCalledWith(worktreeRoot)
    expect(entries.has(worktreeRoot)).toBe(false)
  })

  it.each(['symlink', 'directory', 'hardlink'])('rejects an existing %s exclude without opening or writing it', async (kind) => {
    const content = files.get(excludePath)
    entries.set(excludePath, kind === 'symlink' ? symlink() : kind === 'directory' ? directory() : { ...regularFile(), nlink: 2n })
    await expect(createWorktreeBranch(root, 'blocked')).rejects.toThrow('稳定的普通文件')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(files.get(excludePath)).toBe(content)
    expect(addCalls()).toEqual([])
  })

  it.each(['fd-identity', 'path-swap', 'oversize', 'short-append'])('rejects an unsafe exclude %s and closes the FD', async (kind) => {
    const content = files.get(excludePath)!
    if (kind === 'fd-identity') mocks.fdStat.mockResolvedValueOnce({ ...regularFile(99), size: BigInt(Buffer.byteLength(content)) })
    else if (kind === 'path-swap') {
      mocks.fdRead.mockImplementationOnce(async (buffer, offset, length, position) => {
        entries.set(excludePath, symlink())
        return { bytesRead: Buffer.from(content).copy(buffer, offset, position, position + length) }
      })
    } else if (kind === 'oversize') files.set(excludePath, 'x'.repeat(1024 * 1024 + 1))
    else mocks.fdWrite.mockResolvedValueOnce({ bytesWritten: 1 })
    await expect(createWorktreeBranch(root, 'blocked')).rejects.toThrow()
    expect(mocks.fdClose).toHaveBeenCalledTimes(1)
    expect(mocks.fdWrite).toHaveBeenCalledTimes(kind === 'short-append' ? 1 : 0)
    expect(addCalls()).toEqual([])
    expect(entries.has(worktreeRoot)).toBe(false)
  })

  it('keeps regular file creation working when O_NOFOLLOW is unavailable, retaining identity checks', async () => {
    fsConstants.O_NOFOLLOW = 0
    files.delete(excludePath)
    entries.delete(excludePath)
    const branch = await createWorktreeBranch(root, 'portable')
    expect(branch.cwd).toBe(join(worktreeRoot, 'portable'))
    expect(files.get(excludePath)).toBe('/.pion-worktrees/\n')
    expect(mocks.lstat).toHaveBeenCalledWith(excludePath, { bigint: true })
    expect(mocks.fdStat).toHaveBeenCalledWith({ bigint: true })
    expect(mocks.fdClose).toHaveBeenCalledTimes(1)
  })

  it('rejects project rules that override the local exclude, without creating a worktree', async () => {
    const normalGit = mocks.git.getMockImplementation()!
    mocks.git.mockImplementation(async (cwd, args) => {
      if (args[0] === 'check-ignore') throw fsError('NOT_IGNORED')
      return normalGit(cwd, args)
    })
    await expect(createWorktreeBranch(root, 'blocked')).rejects.toThrow('项目规则未忽略')
    expect(addCalls()).toEqual([])
    expect(mocks.git).toHaveBeenCalledWith(root, ['check-ignore', '--quiet', '--no-index', '--', '.pion-worktrees/'])
  })

  it('rejects a symlink worktree root without creating directories beneath it', async () => {
    entries.set(worktreeRoot, symlink())
    await expect(createWorktreeBranch(root, 'blocked')).rejects.toThrow('工作树根目录不能是符号链接或非目录')
    expect(addCalls()).toEqual([])
    expect(mocks.mkdir.mock.calls.every(([path]) => path === dirname(excludePath) || path === worktreeRoot)).toBe(true)
    expect(entries.has(join(worktreeRoot, 'blocked'))).toBe(false)
  })

  it('rechecks the worktree root after choosing a target', async () => {
    const normalLstat = mocks.lstat.getMockImplementation()!
    mocks.lstat.mockImplementation(async (path) => {
      if (path === join(worktreeRoot, 'blocked')) entries.set(worktreeRoot, symlink())
      return normalLstat(path)
    })
    await expect(createWorktreeBranch(root, 'blocked')).rejects.toThrow('工作树根目录不能是符号链接或非目录')
    expect(addCalls()).toEqual([])
  })

  it('fails closed if Git does not identify the primary worktree', async () => {
    const normalGit = mocks.git.getMockImplementation()!
    mocks.git.mockImplementation(async (cwd, args) => args[0] === 'worktree' && args[1] === 'list' ? '' : normalGit(cwd, args))
    await expect(createWorktreeBranch(linked, 'blocked')).rejects.toThrow('无法确认主工作树目录')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(addCalls()).toEqual([])
  })
})
