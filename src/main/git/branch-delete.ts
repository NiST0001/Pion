import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from 'node:path'
import { runGit } from '../git'

interface WorktreeRecord {
  path: string
  head: string
  branch?: string
  detached: boolean
  locked: boolean
  prunable: boolean
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
function fail(message: string): never { throw new Error(message) }

/** -z fields are terminated by NUL, and records by an additional NUL. Never split paths on LF. */
export function parseDeletionWorktrees(output: string): WorktreeRecord[] {
  if (!output || output.length > 4 * 1024 * 1024 || !output.endsWith('\0\0')) fail('工作树登记格式无效')
  const records: WorktreeRecord[] = []
  let fields: string[] = []
  for (const field of output.split('\0').slice(0, -1)) {
    if (field) { fields.push(field); continue }
    if (!fields.length || !fields[0].startsWith('worktree ')) fail('工作树登记格式无效')
    const record: WorktreeRecord = { path: fields[0].slice(9), head: '', detached: false, locked: false, prunable: false }
    const seen = new Set<string>()
    for (const item of fields.slice(1)) {
      const key = item.split(' ', 1)[0]
      if (seen.has(key)) fail('工作树登记字段重复')
      seen.add(key)
      if (item.startsWith('HEAD ')) record.head = item.slice(5)
      else if (item.startsWith('branch refs/heads/')) record.branch = item.slice(18)
      else if (item === 'detached') record.detached = true
      else if (item === 'locked' || item.startsWith('locked ')) record.locked = true
      else if (item === 'prunable' || item.startsWith('prunable ')) record.prunable = true
      else fail('不支持的工作树登记字段')
    }
    if (!isAbsolute(record.path) || !SHA.test(record.head)) fail('工作树登记路径或提交无效')
    records.push(record)
    fields = []
  }
  if (fields.length || new Set(records.map((r) => resolve(r.path))).size !== records.length) fail('工作树登记格式无效')
  return records
}

function pathInput(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !isAbsolute(value)
    || resolve(value) !== value || value.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) fail('工作树路径无效')
  return value
}
function branchInput(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('-')
    || /[\x00-\x20\x7f]/.test(value) || value.startsWith('refs/')) fail('分支名称无效')
  return value
}
const git = (cwd: string, args: string[]) => runGit(cwd, args, { trim: false, timeout: 30_000 })
async function line(cwd: string, args: string[]): Promise<string> {
  const output = await git(cwd, args)
  if (!output.endsWith('\n')) fail('Git 输出格式无效')
  return output.slice(0, -1)
}
async function identity(path: string, directory = true): Promise<string> {
  if (await realpath(path) !== path) fail('工作树路径包含符号链接或非规范路径')
  const stat = await lstat(path, { bigint: true })
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('工作树文件身份无效')
  return `${stat.dev}:${stat.ino}`
}
async function ancestors(path: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (let current = path;; current = dirname(current)) {
    result.set(current, await identity(current))
    if (dirname(current) === current) return result
  }
}
async function unchanged(entries: Map<string, string>): Promise<void> {
  for (const [path, expected] of entries) if (await identity(path) !== expected) fail('工作树目录身份已改变')
}
function related(a: string, b: string): boolean {
  const rel = relative(a, b)
  return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Non-force Git operations only. The caller must hold its lifecycle lock throughout.
 * Identity rechecks reduce races; they are not an OS sandbox or an atomic transaction.
 */
export async function prepareWorktreeBranchDeletion(
  projectCwd: string, targetCwd: string, branchName: string,
  assertIdle: () => void | Promise<void>
): Promise<() => Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; warning?: string }>> {
  const root = pathInput(projectCwd)
  const target = pathInput(targetCwd)
  const name = branchInput(branchName)
  if (typeof assertIdle !== 'function') fail('缺少工作树空闲检查')
  if (related(root, target) || related(target, root) || related(target, resolve(process.cwd()))
    || related(target, resolve(dirname(process.execPath))) || basename(target).toLowerCase() === '.git') fail('不能删除主工作树或嵌套目录')
  await assertIdle()
  const dirs = new Map([...await ancestors(root), ...await ancestors(target)])
  const gitFile = await identity(join(target, '.git'), false)
  await git(root, ['check-ref-format', '--branch', name])

  const records = () => git(root, ['worktree', 'list', '--porcelain', '-z']).then(parseDeletionWorktrees)
  const rootSha = await line(root, ['rev-parse', '--verify', 'HEAD'])
  const targetSha = await line(root, ['rev-parse', '--verify', `refs/heads/${name}`])
  if (!SHA.test(rootSha) || !SHA.test(targetSha)) fail('分支提交无效')
  const rootCommon = await realpath(await line(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const commonIdentity = await identity(rootCommon)

  async function checkRoot(list: WorktreeRecord[]): Promise<void> {
    const main = list[0]
    if (!main || resolve(main.path) !== root || main.detached || main.locked || main.prunable || !main.branch || main.head !== rootSha) fail('项目必须是已登记的主工作树，且提交未改变')
    if (await line(root, ['rev-parse', '--show-toplevel']) !== root
      || await line(root, ['rev-parse', '--show-superproject-working-tree']) !== ''
      || await line(root, ['rev-parse', '--verify', 'HEAD']) !== rootSha
      || await line(root, ['symbolic-ref', '--quiet', 'HEAD']) !== `refs/heads/${main.branch}`
      || await realpath(await line(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== rootCommon
      || await identity(rootCommon) !== commonIdentity) fail('主工作树身份已改变')
    if (await line(root, ['rev-parse', '--verify', `refs/heads/${name}`]) !== targetSha) fail('目标分支提交已改变')
    await git(root, ['merge-base', '--is-ancestor', targetSha, rootSha])
  }
  async function checkBeforeRemove(): Promise<void> {
    const list = await records()
    await checkRoot(list)
    const matches = list.filter((r) => resolve(r.path) === target)
    const record = matches[0]
    if (matches.length !== 1 || list[0] === record || record.detached || record.locked || record.prunable
      || record.branch !== name || record.head !== targetSha || list.filter((r) => r.branch === name).length !== 1) fail('目标不是可删除的已登记分支工作树')
    if (await line(target, ['rev-parse', '--show-toplevel']) !== target
      || await line(target, ['rev-parse', '--show-superproject-working-tree']) !== ''
      || await realpath(await line(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== rootCommon
      || await line(target, ['symbolic-ref', '--quiet', 'HEAD']) !== `refs/heads/${name}`
      || await line(target, ['rev-parse', '--verify', 'HEAD']) !== targetSha) fail('目标工作树仓库或分支身份不一致')
    if (await git(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']) !== '') fail('工作树含修改、未跟踪或忽略文件，不能删除')
    if (await identity(join(target, '.git'), false) !== gitFile) fail('工作树 Git 文件身份已改变')
    await unchanged(dirs)
  }
  await checkBeforeRemove()
  let attempted = false
  return async () => {
    if (attempted) fail('删除事务已经尝试，不自动重试')
    attempted = true
    // Keep the preflight identities across backend shutdown, not a fresh baseline.
    // Idle callback comes before the final filesystem/Git recheck, not after it.
    await assertIdle()
    await checkBeforeRemove()
    await git(root, ['worktree', 'remove', '--', target])

    try {
      await assertIdle()
      const remainingDirs = new Map(dirs)
      remainingDirs.delete(target)
      await unchanged(remainingDirs)
      const list = await records()
      await checkRoot(list)
      if (list.some((r) => resolve(r.path) === target || r.branch === name)) fail('目标工作树或分支仍被登记占用')
      try {
        await lstat(target)
        fail('目标目录仍存在，保留分支')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Recheck identities and tip immediately before branch -d; never force refs.
      await unchanged(remainingDirs)
      if (await line(root, ['rev-parse', '--verify', `refs/heads/${name}`]) !== targetSha) fail('目标分支提交已改变')
      await git(root, ['branch', '-d', '--', name])
      return { worktreeRemoved: true, branchDeleted: true }
    } catch {
      return { worktreeRemoved: true, branchDeleted: false, warning: '工作树已移除，但安全复查或分支删除失败；分支未确认删除，请刷新后检查。' }
    }
  }
}

export async function deleteWorktreeBranch(
  projectCwd: string, targetCwd: string, branchName: string,
  assertIdle: () => void | Promise<void>
): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; warning?: string }> {
  const commit = await prepareWorktreeBranchDeletion(projectCwd, targetCwd, branchName, assertIdle)
  return commit()
}
