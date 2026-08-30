import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService, parsePorcelainV2, parseUnifiedDiff } from '../../src/main/git-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pion-git-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Pion Tests')
  git(root, 'config', 'user.email', 'pion@example.invalid')
  await writeFile(join(root, 'file.txt'), 'a\nb\nc\n')
  git(root, 'add', 'file.txt')
  git(root, 'commit', '-qm', 'base')
  return root
}

describe('GitService parsing', () => {
  it('parses NUL-delimited porcelain paths with spaces', () => {
    const parsed = parsePorcelainV2([
      '# branch.oid abc',
      '# branch.head main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc abc folder/file name.ts',
      '? new file.txt',
      ''
    ].join('\0'))

    expect(parsed).toMatchObject({ head: 'abc', branch: 'main', ahead: 2, behind: 1 })
    expect(parsed.files.map((file) => file.path)).toEqual(['folder/file name.ts', 'new file.txt'])
  })

  it('assigns stable selectable hunk and line identities', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n',
      'snapshot',
      'a.txt',
      'unstaged'
    )
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0].lines.map((line) => line.kind)).toEqual(['delete', 'add', 'context'])
    expect(diff).toMatchObject({ additions: 1, deletions: 1, selectable: true })
  })
})

describe('GitService workflow', () => {
  it('stages selected lines, unstages hunks, commits, and rejects stale snapshots', async () => {
    const root = await repository()
    const service = new GitService()
    await writeFile(join(root, 'file.txt'), 'a\nB\nc\nnew\n')

    const initial = await service.getStatus(root)
    const diff = await service.getDiff(root, 'file.txt', 'unstaged')
    const newLine = diff.hunks.flatMap((hunk) => hunk.lines)
      .find((line) => line.kind === 'add' && line.text === 'new')
    expect(newLine).toBeDefined()

    const partiallyStaged = await service.applySelection({
      cwd: root,
      snapshotId: initial.snapshotId,
      path: 'file.txt',
      action: 'stage',
      lineIds: [newLine?.id as string]
    })
    expect(partiallyStaged.stagedCount).toBe(1)
    expect(git(root, 'diff', '--cached')).toContain('+new')
    expect(git(root, 'diff', '--cached')).not.toContain('+B')

    await expect(service.stagePaths(root, initial.snapshotId, ['file.txt']))
      .rejects.toThrow('工作区已发生变化')

    const stagedDiff = await service.getDiff(root, 'file.txt', 'staged')
    const unstaged = await service.applySelection({
      cwd: root,
      snapshotId: partiallyStaged.snapshotId,
      path: 'file.txt',
      action: 'unstage',
      hunkId: stagedDiff.hunks[0].id
    })
    expect(unstaged.stagedCount).toBe(0)

    const stagedAll = await service.stagePaths(root, unstaged.snapshotId, ['file.txt'])
    const result = await service.commit(root, stagedAll.snapshotId, 'update file')
    expect(result.commit).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(result.snapshot.stagedCount).toBe(0)
  })

  it('reverts selected replacement lines without discarding unrelated additions', async () => {
    const root = await repository()
    const service = new GitService()
    await writeFile(join(root, 'file.txt'), 'a\nB\nc\nnew\n')
    const snapshot = await service.getStatus(root)
    const diff = await service.getDiff(root, 'file.txt', 'unstaged')
    const replacement = diff.hunks.flatMap((hunk) => hunk.lines)
      .filter((line) => (line.kind === 'delete' && line.text === 'b') || (line.kind === 'add' && line.text === 'B'))

    await service.applySelection({
      cwd: root,
      snapshotId: snapshot.snapshotId,
      path: 'file.txt',
      action: 'discard',
      lineIds: replacement.map((line) => line.id)
    })
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('a\nb\nc\nnew\n')
  })

  it('reads, resolves, and continues a merge conflict', async () => {
    const root = await repository()
    const service = new GitService()
    git(root, 'checkout', '-qb', 'incoming')
    await writeFile(join(root, 'file.txt'), 'incoming\n')
    git(root, 'commit', '-qam', 'incoming')
    git(root, 'checkout', '-q', 'master')
    await writeFile(join(root, 'file.txt'), 'current\n')
    git(root, 'commit', '-qam', 'current')
    try { git(root, 'merge', 'incoming') } catch { /* expected conflict */ }

    const conflicted = await service.getStatus(root)
    expect(conflicted).toMatchObject({ operation: 'merge', conflictCount: 1 })
    const content = await service.readConflict(root, 'file.txt')
    expect(content.ours).toContain('current')
    expect(content.theirs).toContain('incoming')

    const resolved = await service.resolveConflict(root, conflicted.snapshotId, 'file.txt', 'ours')
    expect(resolved.conflictCount).toBe(0)
    const completed = await service.continueOperation(root, resolved.snapshotId)
    expect(completed.operation).toBe('none')
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('current\n')
  })

  it('preserves symlink mode when choosing a conflict stage', async () => {
    const root = await repository()
    const service = new GitService()
    await symlink('base-target', join(root, 'link'))
    git(root, 'add', 'link')
    git(root, 'commit', '-qm', 'add link')
    git(root, 'checkout', '-qb', 'link-incoming')
    await unlink(join(root, 'link'))
    await symlink('incoming-target', join(root, 'link'))
    git(root, 'commit', '-qam', 'incoming link')
    git(root, 'checkout', '-q', 'master')
    await unlink(join(root, 'link'))
    await symlink('current-target', join(root, 'link'))
    git(root, 'commit', '-qam', 'current link')
    try { git(root, 'merge', 'link-incoming') } catch { /* expected conflict */ }

    const snapshot = await service.getStatus(root)
    const conflict = await service.readConflict(root, 'link')
    expect(conflict.binary).toBe(true)
    await service.resolveConflict(root, snapshot.snapshotId, 'link', 'ours')
    expect((await lstat(join(root, 'link'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, 'link'))).toBe('current-target')
  })

  it('discards tracked and untracked worktree changes', async () => {
    const root = await repository()
    const service = new GitService()
    await writeFile(join(root, 'file.txt'), 'changed\n')
    await writeFile(join(root, 'untracked.txt'), 'temporary\n')
    const snapshot = await service.getStatus(root)

    const next = await service.discardPaths(root, snapshot.snapshotId, ['file.txt', 'untracked.txt'])
    expect(next.files).toEqual([])
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('a\nb\nc\n')
    await expect(readFile(join(root, 'untracked.txt'), 'utf8')).rejects.toThrow()
  })
})
