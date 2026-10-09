import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renameGitBranch, listBranchInfos } from '../../src/main/git'
import { GitService, parsePorcelainV2, parseUnifiedDiff } from '../../src/main/git-service'
import * as gitProcess from '../../src/main/git/process'

const roots: string[] = []

afterEach(async () => {
  // Windows 上杀掉的 git 子进程可能短暂占用临时目录，需要重试清理
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })))
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
  // 固定行尾行为，避免 Windows 全局 core.autocrlf 把 LF 检出成 CRLF
  git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'file.txt'), 'a\nb\nc\n')
  git(root, 'add', 'file.txt')
  git(root, 'commit', '-qm', 'base')
  return root
}

// Windows 创建符号链接需要开发者模式或管理员权限，先探测能力再决定是否跳过
async function canCreateSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'pion-symlink-probe-'))
  roots.push(probe)
  try {
    await symlink('target', join(probe, 'link'))
    return true
  } catch {
    return false
  }
}

const symlinkCapable = await canCreateSymlinks()

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

  it('preserves ordinary, rename, and copy paths verbatim and in record order', () => {
    const ordinaryPaths = [
      'z/file name\nwith\ttabs.txt', '? literal.txt', '# branch.head literal',
      '1 record-prefix.txt', '2 record-prefix.txt', '--leading.txt', '  padded path  ', 'a.txt'
    ]
    const renames = [
      ['R.', 'R100', 'z/new file\nwith\ttabs.txt', ' old file\nwith\ttabs.txt '],
      ['C.', 'C075', '? copy.txt', '# branch.head not-a-header'],
      ['.R', 'R098', '# renamed.txt', '? not-an-untracked-record'],
      ['.C', 'C100', '2 destination.txt', '1 old-record.txt'],
      ['R.', 'R100', '--destination.txt', '2 old-record.txt']
    ] as const
    const parsed = parsePorcelainV2([
      '# branch.head main',
      ...ordinaryPaths.map((path) => `1 .M N... 100644 100644 100644 abc abc ${path}`),
      ...renames.flatMap(([xy, score, path, oldPath]) => [
        `2 ${xy} N... 100644 100644 100644 abc abc ${score} ${path}`, oldPath
      ]),
      '? final untracked.txt',
      ''
    ].join('\0'))

    expect(parsed.branch).toBe('main')
    expect(parsed.files.map((file) => file.path)).toEqual([
      ...ordinaryPaths, ...renames.map(([, , path]) => path), 'final untracked.txt'
    ])
    for (const file of parsed.files.slice(0, ordinaryPaths.length)) {
      expect(Object.prototype.hasOwnProperty.call(file, 'oldPath')).toBe(false)
    }
    expect(parsed.files.slice(ordinaryPaths.length, -1).map(({ path, oldPath, kind }) => ({
      path, oldPath, kind
    }))).toEqual(renames.map(([, , path, oldPath]) => ({ path, oldPath, kind: 'renamed' })))
  })

  it('preserves XY defaults, scope flags, and kind priority for both tracked record forms', () => {
    const cases = [
      ['..', '.', '.', 'modified', false, false],
      ['.M', '.', 'M', 'modified', false, true],
      ['M.', 'M', '.', 'modified', true, false],
      ['MM', 'M', 'M', 'modified', true, true],
      ['A.', 'A', '.', 'added', true, false],
      ['.D', '.', 'D', 'deleted', false, true],
      ['AD', 'A', 'D', 'deleted', true, true],
      ['.T', '.', 'T', 'type-changed', false, true],
      ['TA', 'T', 'A', 'added', true, true],
      ['RM', 'R', 'M', 'renamed', true, true],
      ['RD', 'R', 'D', 'renamed', true, true],
      ['.C', '.', 'C', 'renamed', false, true],
      ['M', 'M', '.', 'modified', true, false],
      ['', '.', '.', 'modified', false, false]
    ] as const
    for (const [xy, indexCode, worktreeCode, kind, staged, unstaged] of cases) {
      const status = { indexCode, worktreeCode, staged, unstaged, conflicted: false, binary: false }
      expect(parsePorcelainV2(`1 ${xy} N... 100644 100644 100644 abc abc ordinary.txt\0`).files,
        `ordinary XY=${xy}`).toStrictEqual([{ path: 'ordinary.txt', kind, ...status }])
      expect(parsePorcelainV2(`2 ${xy} N... 100644 100644 100644 abc abc R100 new.txt\0old.txt\0`).files,
        `rename XY=${xy}`).toStrictEqual([{ path: 'new.txt', oldPath: 'old.txt', kind: 'renamed', ...status }])
    }
  })

  it('does not consume the next record after a malformed rename record', () => {
    const parsed = parsePorcelainV2([
      '2 R. N... 100644 100644 100644 abc abc R100',
      '1 .M N... 100644 100644 100644 abc abc kept.txt',
      '2 R. N... 100644 100644 100644 abc abc',
      '? kept untracked.txt',
      '2 R.',
      '# branch.head kept-branch',
      '2 C. N... 100644 100644 100644 abc abc C100 valid new.txt',
      'valid old.txt',
      ''
    ].join('\0'))

    expect(parsed.branch).toBe('kept-branch')
    expect(parsed.files.map((file) => file.path)).toEqual([
      'kept.txt', 'kept untracked.txt', 'valid new.txt'
    ])
    expect(parsed.files[2]).toMatchObject({ kind: 'renamed', oldPath: 'valid old.txt' })
  })

  it('keeps ordinary short records separate and accepts empty tracked target fields without trimming', () => {
    const parsed = parsePorcelainV2([
      '1 .M N... 100644 100644 100644 abc abc',
      '1 .M',
      '1 .M N... 100644 100644 100644 abc abc ',
      '2 R. N... 100644 100644 100644 abc abc R100 ',
      'old.txt',
      '# branch.head after-empty-target', ''
    ].join('\0'))
    expect(parsed.branch).toBe('after-empty-target')
    expect(parsed.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: '', kind: 'modified' }, { path: '', kind: 'renamed' }
    ])
    expect(Object.prototype.hasOwnProperty.call(parsed.files[0], 'oldPath')).toBe(false)
    expect(parsed.files[1].oldPath).toBe('old.txt')
  })

  it.each([
    { label: 'missing', suffix: '', oldPath: undefined },
    { label: 'empty', suffix: '\0', oldPath: '' }
  ])('retains an own oldPath field for a $label rename source', ({ suffix, oldPath }) => {
    const { files } = parsePorcelainV2(
      '1 .M N... 100644 100644 100644 abc abc ordinary.txt\0' +
      `2 R. N... 100644 100644 100644 abc abc R100 new.txt${suffix}`
    )

    expect(files).toHaveLength(2)
    expect(Object.prototype.hasOwnProperty.call(files[0], 'oldPath')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(files[1], 'oldPath')).toBe(true)
    expect(files[1].oldPath).toBe(oldPath)
    expect(files[1].kind).toBe('renamed')
  })

  it('keeps mixed branch headers, untracked paths, and conflict records distinct', () => {
    const parsed = parsePorcelainV2([
      '# branch.oid abc', '# branch.head main', '# branch.upstream origin/main',
      '?  # ? new file\nwith\ttabs ',
      '# branch.ab +3 -2',
      '1 A. N... 100644 100644 100644 abc abc added.txt',
      'u DU N... 100644 100644 100644 100644 base ours theirs conflict file.txt',
      'u  N... 100644 100644 100644 100644 base ours theirs ? default-conflict.txt',
      '# branch.oid (initial)', '# branch.head (detached)', ''
    ].join('\0'))

    expect(parsed).toStrictEqual({
      head: null, branch: null, ahead: 3, behind: 2,
      files: [
        { path: ' # ? new file\nwith\ttabs ', kind: 'untracked', indexCode: '?', worktreeCode: '?',
          staged: false, unstaged: true, conflicted: false, binary: false },
        { path: 'added.txt', kind: 'added', indexCode: 'A', worktreeCode: '.',
          staged: true, unstaged: false, conflicted: false, binary: false },
        { path: 'conflict file.txt', kind: 'conflicted', indexCode: 'D', worktreeCode: 'U',
          staged: false, unstaged: true, conflicted: true, binary: false },
        { path: '? default-conflict.txt', kind: 'conflicted', indexCode: 'U', worktreeCode: 'U',
          staged: false, unstaged: true, conflicted: true, binary: false }
      ]
    })
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

describe('Git branch workflow', () => {
  it('renames a linked worktree branch and refreshes its branch identity', async () => {
    const root = await repository()
    const worktree = join(root, 'linked-worktree')
    git(root, 'branch', 'feature/old-name')
    git(root, 'worktree', 'add', '-q', worktree, 'feature/old-name')

    const renamed = await renameGitBranch(worktree, 'feature/old-name', 'feature/new-name')

    expect(renamed).toMatchObject({
      cwd: worktree,
      name: 'feature/new-name',
      gitBranch: 'feature/new-name',
      isMain: false
    })
    await expect(renameGitBranch(worktree, 'feature/new-name', 'feature/new-name'))
      .rejects.toThrow('新旧分支名称不能相同')
    expect((await listBranchInfos(root)).find((branch) => branch.cwd === worktree)).toMatchObject({
      name: 'feature/new-name',
      gitBranch: 'feature/new-name',
      isMain: false
    })
  })
})

describe('GitService workflow', () => {
  it.each(['staged', 'unstaged'] as const)('preserves exact %s diff arguments and UTF-8 buffer contents', async (scope) => {
    const root = join(tmpdir(), 'pion-in-memory-diff')
    const path = 'folder/特殊 name.txt'
    const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-旧内容\n+新内容😀\n`
    const service = new GitService()
    const status = vi.spyOn(service, 'getStatus').mockResolvedValue({
      root, snapshotId: 'isolated-snapshot', head: 'abc', branch: 'main', ahead: 0, behind: 0,
      operation: 'none', stagedCount: 1, unstagedCount: 1, conflictCount: 0, capturedAt: 0,
      files: [{ path, kind: 'modified', indexCode: 'M', worktreeCode: 'M',
        staged: true, unstaged: true, conflicted: false, binary: false }]
    })
    const run = vi.spyOn(gitProcess, 'runGitBuffer').mockResolvedValue(Buffer.from(patch, 'utf8'))
    try {
      const diff = await service.getDiff(root, path, scope)
      expect(status).toHaveBeenCalledExactlyOnceWith(root)
      expect(run).toHaveBeenCalledExactlyOnceWith(root, [
        'diff', ...(scope === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv',
        '--binary', '--full-index', '--unified=3', '--', path
      ])
      expect(diff.rawPatch).toBe(patch)
      expect(diff.hunks.flatMap((hunk) => hunk.lines).map(({ kind, text }) => ({ kind, text }))).toEqual([
        { kind: 'delete', text: '旧内容' }, { kind: 'add', text: '新内容😀' }
      ])
    } finally {
      run.mockRestore()
      status.mockRestore()
    }
  })

  it('reads staged and unstaged tracked diffs in forward direction without parser-only headers', async () => {
    const root = await repository()
    const service = new GitService()
    await writeFile(join(root, 'file.txt'), 'a\nindex\nc\n')
    git(root, 'add', '--', 'file.txt')
    await writeFile(join(root, 'file.txt'), 'a\nworktree\nc\n')

    const cases = [
      { scope: 'staged', removed: 'b', added: 'index' },
      { scope: 'unstaged', removed: 'index', added: 'worktree' }
    ] as const
    for (const { scope, removed, added } of cases) {
      const diff = await service.getDiff(root, 'file.txt', scope)
      const patch = execFileSync('git', [
        'diff', ...(scope === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv',
        '--binary', '--full-index', '--unified=3', '--', 'file.txt'
      ], { cwd: root, encoding: 'utf8' })
      expect(diff.rawPatch).toBe(patch)
      expect(diff).toMatchObject({ path: 'file.txt', scope, additions: 1, deletions: 1, selectable: true })
      expect(diff.hunks.flatMap((hunk) => hunk.lines)
        .filter((line) => line.kind === 'add' || line.kind === 'delete')
        .map(({ kind, text }) => ({ kind, text }))).toEqual([
        { kind: 'delete', text: removed }, { kind: 'add', text: added }
      ])
      expect(diff).not.toHaveProperty('headerLines')
    }
    await expect(service.getDiff(root, 'missing.txt', 'unstaged'))
      .rejects.toThrow('文件已不在 Git 变更列表中')
  })

  it('uses nonselectable untracked patches and rejects their staged scope', async () => {
    const root = await repository()
    const service = new GitService()
    const cases = [
      { path: 'new file.txt', bytes: Buffer.from('first\nlast'), binary: false, texts: ['first', 'last'] },
      { path: 'empty.txt', bytes: Buffer.alloc(0), binary: false, texts: [] },
      { path: 'binary.txt', bytes: Buffer.from([0, 1, 2]), binary: true, texts: [] }
    ]
    for (const { path, bytes, binary, texts } of cases) {
      await writeFile(join(root, path), bytes)
      const diff = await service.getDiff(root, path, 'unstaged')
      expect(diff).toMatchObject({
        path, scope: 'unstaged', binary, selectable: false, additions: texts.length, deletions: 0
      })
      expect(diff.rawPatch).toContain(`diff --git a/${path} b/${path}\n`)
      expect(diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'add')
        .map((line) => line.text)).toEqual(texts)
      expect(diff).not.toHaveProperty('headerLines')
      await expect(service.getDiff(root, path, 'staged')).rejects.toThrow('未跟踪文件尚未暂存')
    }
    expect((await service.getDiff(root, 'new file.txt', 'unstaged')).rawPatch)
      .toContain('\\ No newline at end of file')
  })

  it('retains status rename metadata for both diff scopes', async () => {
    const root = await repository()
    git(root, 'config', 'diff.renames', 'true')
    git(root, 'config', 'status.renames', 'true')
    const service = new GitService()
    const path = 'renamed file.txt'
    await rename(join(root, 'file.txt'), join(root, path))
    git(root, 'add', '-A', '--', 'file.txt', path)
    await writeFile(join(root, path), 'a\nb\nc\nextra\n')

    expect((await service.getStatus(root)).files).toEqual([
      expect.objectContaining({ path, oldPath: 'file.txt', kind: 'renamed', staged: true, unstaged: true })
    ])
    for (const scope of ['staged', 'unstaged'] as const) {
      const diff = await service.getDiff(root, path, scope)
      expect(diff).toMatchObject({ path, oldPath: 'file.txt', scope, binary: false, selectable: true })
      expect(diff).not.toHaveProperty('headerLines')
    }
    const unstaged = await service.getDiff(root, path, 'unstaged')
    expect(unstaged.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'add')
      .map((line) => line.text)).toEqual(['extra'])
  })

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

  it.skipIf(!symlinkCapable)('preserves symlink mode when choosing a conflict stage', async () => {
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
