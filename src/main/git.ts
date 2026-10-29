/**
 * Git worktree / 分支操作。
 *
 * 独立于 AgentBridge 的纯 Git 逻辑：列出项目全部分支 worktree、
 * 创建新分支 worktree（位于主项目内 .pion-worktrees/ 目录）。
 */
import { execFile } from 'node:child_process'
import { constants, existsSync, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { BranchInfo } from '../shared/types'

const execFileAsync = promisify(execFile)
// Strip only Git's line terminator, not whitespace belonging to the path.
const gitPathLineEnding = process.platform === 'win32' ? /\r?\n$/ : /\n$/

interface RunGitOptions {
  env?: NodeJS.ProcessEnv
  timeout?: number
  input?: string
  /** Keep exact stdout bytes represented as UTF-8 text (needed for NUL-delimited paths). */
  trim?: boolean
}

export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {}
): Promise<string> {
  const pending = execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: options.env,
    timeout: options.timeout
  })
  let inputError: Error | undefined
  if (options.input !== undefined) {
    const stdin = pending.child.stdin
    if (stdin) {
      stdin.on('error', (error: Error) => { inputError = error })
      stdin.end(options.input)
    } else {
      inputError = new Error('无法向 Git 传递提交范围')
    }
  }
  // An input failure must not release callers before the actual command settles.
  const { stdout } = await pending
  if (inputError) throw inputError
  const output = String(stdout)
  return options.trim === false ? output : output.trim()
}

interface GitWorktreeRecord {
  path: string
  branch?: string
}

export function parseGitWorktrees(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = []
  let current: GitWorktreeRecord | null = null
  // -z keeps paths literal, including embedded newlines and quotes. Retain LF
  // parsing for existing callers supplying non-NUL porcelain.
  for (const line of output.includes('\0') ? output.split('\0') : output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  if (current) records.push(current)
  return records
}

/** List every worktree of the project as a branch entry (main worktree first). */
export async function listBranchInfos(cwd: string): Promise<BranchInfo[]> {
  const requestedCwd = resolve(cwd)
  try {
    const root = resolve((await runGit(requestedCwd, ['rev-parse', '--show-toplevel'], { trim: false })).replace(gitPathLineEnding, ''))
    const records = parseGitWorktrees(await runGit(root, ['worktree', 'list', '--porcelain', '-z'], { trim: false }))
    // `rev-parse --show-toplevel` points at the requested linked worktree.
    // `git worktree list` is ordered with the primary worktree first, so use
    // that record to keep isMain stable when callers start from a branch cwd.
    const mainRecord = records[0]
    const mainCwd = mainRecord ? resolve(mainRecord.path) : root
    const currentBranch = mainRecord?.branch ?? await runGit(mainCwd, ['branch', '--show-current']).catch(() => '')
    const branches = records.map((record) => {
      const worktreeCwd = resolve(record.path)
      const isMain = worktreeCwd === mainCwd
      const gitBranch = record.branch ?? (isMain ? currentBranch : undefined)
      return {
        name: isMain ? (gitBranch || 'main') : (gitBranch || basename(worktreeCwd)),
        cwd: worktreeCwd,
        gitBranch: gitBranch || undefined,
        isMain
      }
    })
    if (branches.some((branch) => branch.isMain)) return branches
    return [{ name: currentBranch || 'main', cwd: root, gitBranch: currentBranch || undefined, isMain: true }]
  } catch {
    return [{ name: 'main', cwd: requestedCwd, isMain: true }]
  }
}

/** Project identity only; never use this to replace a backend's working directory. */
export async function canonicalProjectCwd(cwd: string): Promise<string> {
  try {
    // Only fold an actual, live registered worktree, not a path-name convention
    // or an arbitrary subdirectory. The branch-list fallback preserves cwd.
    if (!existsSync(cwd)) return cwd
    const branches = await listBranchInfos(cwd)
    const main = branches.find((branch) => branch.isMain)
    // Includes listBranchInfos' non-Git/error fallback: retain the exact record
    // instead of normalizing a failed lookup into a different identity.
    if (main && resolve(main.cwd) === resolve(cwd)) return cwd
    const registered = branches.some((branch) => resolve(branch.cwd) === resolve(cwd))
    if (registered && main && existsSync(main.cwd)) return main.cwd
  } catch {
    // Missing directories and unavailable Git must not erase project records.
  }
  return cwd
}

/** Rename the branch checked out by the requested worktree. */
export async function renameGitBranch(cwd: string, oldBranchName: string, newBranchName: string): Promise<BranchInfo> {
  const requestedCwd = resolve(cwd)
  const oldName = oldBranchName.trim()
  const newName = newBranchName.trim()
  if (!oldName) throw new Error('原分支名称不能为空')
  if (!newName) throw new Error('新分支名称不能为空')
  if (oldName === newName) throw new Error('新旧分支名称不能相同')

  await runGit(requestedCwd, ['check-ref-format', '--branch', newName])
  const currentBranch = await runGit(requestedCwd, ['branch', '--show-current'])
  if (currentBranch !== oldName) {
    throw new Error(`只能重命名当前工作树对应的分支：${currentBranch || 'detached HEAD'}`)
  }

  try {
    await runGit(requestedCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${oldName}`])
  } catch {
    throw new Error(`Git 分支不存在：${oldName}`)
  }

  await runGit(requestedCwd, ['branch', '-m', oldName, newName])
  const branches = await listBranchInfos(requestedCwd)
  return branches.find((branch) => branch.cwd === requestedCwd && branch.gitBranch === newName)
    ?? branches.find((branch) => branch.gitBranch === newName)
    ?? { name: newName, cwd: requestedCwd, gitBranch: newName, isMain: false }
}

type ProjectWorktreeDirectory = '.pion-worktrees' | '.pion-workflow-worktrees'

async function excludeWorktreeDirectory(root: string, directoryName: ProjectWorktreeDirectory): Promise<void> {
  const excludePath = resolve(root, (await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { trim: false })).replace(gitPathLineEnding, ''))
  const maxBytes = 1024n * 1024n
  const invalidFile = () => new Error('Git 本地排除文件不是稳定的普通文件')
  const sameSnapshot = (actual: BigIntStats, expected: BigIntStats): boolean =>
    actual.isFile() && !actual.isSymbolicLink() && actual.nlink === 1n
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs
  let existing: BigIntStats | undefined
  try {
    existing = await lstat(excludePath, { bigint: true })
    if (!sameSnapshot(existing, existing)) throw invalidFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!existing) await mkdir(dirname(excludePath), { recursive: true })
  // Windows has no supported O_NOFOLLOW. lstat/FD rechecks remain a normal
  // software path gate there (and on other platforms), not an OS sandbox.
  const flags = constants.O_RDWR | constants.O_APPEND | (process.platform === 'win32'
    ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  const file = await open(excludePath, flags | (existing ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
  try {
    const snapshot = await file.stat({ bigint: true })
    if (!sameSnapshot(snapshot, existing ?? snapshot)) throw invalidFile()
    const checkSnapshot = async (): Promise<void> => {
      if (!sameSnapshot(await file.stat({ bigint: true }), snapshot)
        || !sameSnapshot(await lstat(excludePath, { bigint: true }), snapshot)) throw invalidFile()
    }
    await checkSnapshot()
    if (snapshot.size < 0n || snapshot.size > maxBytes) throw new Error('Git 本地排除文件过大')
    const buffer = Buffer.alloc(Number(snapshot.size) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== Number(snapshot.size)) throw invalidFile()
    await checkSnapshot()
    const content = buffer.subarray(0, length).toString('utf8')
    const rule = `/${directoryName}/`
    if (content.split(/\r?\n/).includes(rule)) return
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const addition = Buffer.from(`${content && !content.endsWith('\n') ? eol : ''}${rule}${eol}`, 'utf8')
    if (snapshot.size + BigInt(addition.length) > maxBytes) throw new Error('Git 本地排除文件过大')
    const { bytesWritten } = await file.write(addition, 0, addition.length, null)
    if (bytesWritten !== addition.length) throw invalidFile()
    const updated = await file.stat({ bigint: true })
    if (updated.dev !== snapshot.dev || updated.ino !== snapshot.ino
      || updated.size !== snapshot.size + BigInt(addition.length)
      || !sameSnapshot(await lstat(excludePath, { bigint: true }), updated)) throw invalidFile()
  } finally {
    await file.close()
  }
}

async function projectWorktreeContext(cwd: string) {
  const requestedRoot = resolve((await runGit(resolve(cwd), ['rev-parse', '--show-toplevel'], { trim: false })).replace(gitPathLineEnding, ''))
  const records = parseGitWorktrees(await runGit(requestedRoot, ['worktree', 'list', '--porcelain', '-z'], { trim: false }))
  if (!records[0] || !isAbsolute(records[0].path)
    || !records.some((record) => resolve(record.path) === requestedRoot)) throw new Error('无法确认主工作树目录')
  return { requestedRoot, records, root: await realpath(resolve(records[0].path)) }
}

async function worktreeDirectoryIdentity(path: string): Promise<string> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path) {
    throw new Error('工作树根目录不能是符号链接或非目录')
  }
  return `${stat.dev}:${stat.ino}`
}

async function prepareProjectWorktreeDirectory(root: string, directoryName: ProjectWorktreeDirectory): Promise<string> {
  // Ignore locally before creating anything in the working tree; never edit .gitignore.
  await excludeWorktreeDirectory(root, directoryName)
  const worktreeRoot = join(root, directoryName)
  try {
    // Non-recursive mkdir cannot silently follow an existing directory symlink.
    await mkdir(worktreeRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await worktreeDirectoryIdentity(worktreeRoot)
  try {
    await runGit(root, ['check-ignore', '--quiet', '--no-index', '--', `${directoryName}/`])
  } catch {
    throw new Error(`项目规则未忽略 ${directoryName}/，请先检查 Git 忽略配置`)
  }
  return worktreeRoot
}

/** Shared by branch and workflow creation; metadata stays outside these worktrees. */
export async function ensureProjectWorktreeDirectory(
  cwd: string, directoryName: ProjectWorktreeDirectory = '.pion-worktrees'
): Promise<string> {
  if (directoryName !== '.pion-worktrees' && directoryName !== '.pion-workflow-worktrees') throw new Error('工作树管理目录无效')
  const { root } = await projectWorktreeContext(cwd)
  return prepareProjectWorktreeDirectory(root, directoryName)
}

/** Create a new branch and its worktree under <primary-project>/.pion-worktrees/. */
export async function createWorktreeBranch(cwd: string, branchName: string): Promise<BranchInfo> {
  const name = branchName.trim()
  if (!name) throw new Error('分支名称不能为空')
  const { requestedRoot, records, root } = await projectWorktreeContext(cwd)
  await runGit(root, ['check-ref-format', '--branch', name])
  const worktreeRoot = await prepareProjectWorktreeDirectory(root, '.pion-worktrees')
  const rootIdentity = await worktreeDirectoryIdentity(worktreeRoot)
  const cleanedName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
  const safeName = /^(?:\.{1,2}|\.git)$/i.test(cleanedName) ? 'branch' : cleanedName
  const registeredPaths = new Set(records.map((record) => resolve(record.path)))
  let worktreeCwd = join(worktreeRoot, safeName)
  let suffix = 2
  for (;;) {
    if (!registeredPaths.has(worktreeCwd)) {
      try {
        // lstat also reserves dangling symlink entries, unlike existsSync.
        await lstat(worktreeCwd)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    worktreeCwd = join(worktreeRoot, `${safeName}-${suffix}`)
    suffix += 1
  }

  if (await worktreeDirectoryIdentity(worktreeRoot) !== rootIdentity) throw new Error('工作树根目录已改变')
  // Keep the requested worktree's HEAD as the starting point; only its destination changes.
  await runGit(requestedRoot, ['worktree', 'add', '-b', name, worktreeCwd])
  const branch = (await listBranchInfos(root)).find((item) => item.cwd === resolve(worktreeCwd))
  return branch ?? { name, cwd: resolve(worktreeCwd), gitBranch: name, isMain: false }
}
