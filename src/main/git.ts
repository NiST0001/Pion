/**
 * Git worktree / 分支操作。
 *
 * 独立于 AgentBridge 的纯 Git 逻辑：列出项目全部分支 worktree、
 * 创建新分支 worktree（位于项目同级 .pion-worktrees/ 目录）。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { BranchInfo } from '../shared/types'

const execFileAsync = promisify(execFile)

interface RunGitOptions {
  env?: NodeJS.ProcessEnv
  timeout?: number
  /** Keep exact stdout bytes represented as UTF-8 text (needed for NUL-delimited paths). */
  trim?: boolean
}

export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {}
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: options.env,
    timeout: options.timeout
  })
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
  for (const line of output.split(/\r?\n/)) {
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
    const root = resolve(await runGit(requestedCwd, ['rev-parse', '--show-toplevel']))
    const records = parseGitWorktrees(await runGit(root, ['worktree', 'list', '--porcelain']))
    const mainRecord = records.find((record) => resolve(record.path) === root)
    const currentBranch = mainRecord?.branch ?? await runGit(root, ['branch', '--show-current']).catch(() => '')
    const branches = records.map((record) => {
      const worktreeCwd = resolve(record.path)
      const isMain = worktreeCwd === root
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

/** Create a new branch and its worktree under <project>/../.pion-worktrees/. */
export async function createWorktreeBranch(cwd: string, branchName: string): Promise<BranchInfo> {
  const name = branchName.trim()
  if (!name) throw new Error('分支名称不能为空')
  const root = resolve(await runGit(resolve(cwd), ['rev-parse', '--show-toplevel']))
  await runGit(root, ['check-ref-format', '--branch', name])

  const worktreeRoot = join(dirname(root), '.pion-worktrees')
  await mkdir(worktreeRoot, { recursive: true })
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
  const stem = `${basename(root)}-${safeName}`
  let worktreeCwd = join(worktreeRoot, stem)
  let suffix = 2
  while (existsSync(worktreeCwd)) {
    worktreeCwd = join(worktreeRoot, `${stem}-${suffix}`)
    suffix += 1
  }

  await runGit(root, ['worktree', 'add', '-b', name, worktreeCwd])
  const branch = (await listBranchInfos(root)).find((item) => item.cwd === resolve(worktreeCwd))
  return branch ?? { name, cwd: resolve(worktreeCwd), gitBranch: name, isMain: false }
}
