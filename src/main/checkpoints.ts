import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { runGit } from './git'

const CHECKPOINT_TIMEOUT_MS = 20_000

/** Internal Git object IDs needed to restore a workspace exactly. */
export interface GitRunCheckpoint {
  id: string
  cwd: string
  createdAt: number
  /** Tree containing the complete non-ignored working tree at prompt time. */
  worktreeTree: string
  /** Tree containing the real Git index at prompt time. */
  indexTree: string
}

export interface GitCheckpointInspection {
  hasChanges: boolean
  changedFileCount: number
}

interface WorkspaceSnapshot {
  cwd: string
  worktreeTree: string
  indexTree: string
}

function gitOptions(env?: NodeJS.ProcessEnv): { env?: NodeJS.ProcessEnv; timeout: number } {
  return { env, timeout: CHECKPOINT_TIMEOUT_MS }
}

async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return resolve(await runGit(resolve(cwd), ['rev-parse', '--show-toplevel'], gitOptions()))
  } catch {
    throw new Error('当前目录不是 Git 工作区，无法创建运行检查点')
  }
}

async function ensureResolvableIndex(cwd: string): Promise<void> {
  const conflicts = await runGit(
    cwd,
    ['diff', '--name-only', '--diff-filter=U'],
    gitOptions()
  )
  if (conflicts) throw new Error('工作区存在未解决的 Git 冲突，暂时无法创建运行检查点')
}

/**
 * Write the current worktree to Git's object database through a temporary
 * index. The user's real index is never changed. New ignored files are
 * intentionally excluded so checkpoints cannot accidentally ingest caches,
 * dependencies, credentials, or build output.
 */
async function writeWorktreeTree(cwd: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'pion-checkpoint-index-'))
  const indexFile = join(tempDir, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    const hasHead = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], gitOptions())
      .then(() => true, () => false)
    await runGit(cwd, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], gitOptions(env))
    await runGit(cwd, ['add', '-A', '--', '.'], gitOptions(env))
    return await runGit(cwd, ['write-tree'], gitOptions(env))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const root = await repositoryRoot(cwd)
  await ensureResolvableIndex(root)
  const [indexTree, worktreeTree] = await Promise.all([
    runGit(root, ['write-tree'], gitOptions()),
    writeWorktreeTree(root)
  ])
  return { cwd: root, indexTree, worktreeTree }
}

export async function createGitRunCheckpoint(cwd: string): Promise<GitRunCheckpoint> {
  const snapshot = await snapshotWorkspace(cwd)
  return {
    id: randomUUID(),
    cwd: snapshot.cwd,
    createdAt: Date.now(),
    worktreeTree: snapshot.worktreeTree,
    indexTree: snapshot.indexTree
  }
}

export async function inspectGitRunCheckpoint(
  checkpoint: GitRunCheckpoint
): Promise<GitCheckpointInspection> {
  const currentTree = await writeWorktreeTree(checkpoint.cwd)
  const changed = await runGit(
    checkpoint.cwd,
    ['diff', '--name-only', '-z', checkpoint.worktreeTree, currentTree, '--'],
    { ...gitOptions(), trim: false }
  )
  const changedFileCount = changed.split('\0').filter(Boolean).length
  return { hasChanges: changedFileCount > 0, changedFileCount }
}

function safeWorkspacePath(root: string, path: string): string {
  const target = resolve(root, path)
  const inside = target !== root && target.startsWith(`${root}${sep}`)
  if (!inside || relative(root, target).startsWith('..')) {
    throw new Error(`Git 返回了工作区外的路径：${path}`)
  }
  return target
}

async function removeNonIgnoredUntracked(cwd: string): Promise<void> {
  const output = await runGit(
    cwd,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { ...gitOptions(), trim: false }
  )
  for (const path of output.split('\0').filter(Boolean)) {
    await rm(safeWorkspacePath(cwd, path), { recursive: true, force: true })
  }
}

async function restoreWorkspace(snapshot: WorkspaceSnapshot): Promise<void> {
  await removeNonIgnoredUntracked(snapshot.cwd)
  // First restore the exact working tree. Then restore the original index
  // without -u so staged and unstaged states remain exactly as they were.
  await runGit(
    snapshot.cwd,
    ['read-tree', '--reset', '-u', snapshot.worktreeTree],
    gitOptions()
  )
  await runGit(snapshot.cwd, ['read-tree', snapshot.indexTree], gitOptions())
}

export async function rollbackGitRunCheckpoint(checkpoint: GitRunCheckpoint): Promise<void> {
  const root = await repositoryRoot(checkpoint.cwd)
  if (root !== checkpoint.cwd) throw new Error('检查点所属工作区已发生变化，无法安全恢复')

  // Keep a short-lived guard snapshot so an unexpected Git failure during the
  // restore cannot destroy the current workspace state.
  const guard = await snapshotWorkspace(root)
  try {
    await restoreWorkspace({
      cwd: checkpoint.cwd,
      worktreeTree: checkpoint.worktreeTree,
      indexTree: checkpoint.indexTree
    })
  } catch (error) {
    try {
      await restoreWorkspace(guard)
    } catch (guardError) {
      const reason = guardError instanceof Error ? guardError.message : String(guardError)
      throw new Error(`检查点恢复失败，且无法恢复操作前状态：${reason}`)
    }
    throw error
  }
}
