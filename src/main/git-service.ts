import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../shared/ipc'
import type {
  GitCommitResult,
  GitConflictContent,
  GitDiffScope,
  GitFileDiff,
  GitFileStatus,
  GitOperation,
  GitSelectionRequest,
  GitSnapshotUpdate,
  GitWorkspaceSnapshot
} from '../shared/operations'
import { MAX_CONFLICT_TEXT } from './git/constants'
import { parseNumstat } from './git/numstat'
import { runGitBuffer, runGitText } from './git/process'
import {
  canonicalChangeKey,
  filteredPatch,
  parsePorcelainV2,
  parseUnifiedDiff,
  safeRepoPath,
  stageLabel
} from './git/parsers'

export { parsePorcelainV2, parseUnifiedDiff } from './git/parsers'
export type { ParsedDiff } from './git/parsers'

const SNAPSHOT_CHANNEL = IPC_EVENTS.GitSnapshot

export class GitService {
  private win: BrowserWindow | null = null
  private readonly statusCache = new Map<string, GitWorkspaceSnapshot>()
  private readonly fingerprintCache = new Map<string, { signature: string; digest: string }>()

  bind(win: BrowserWindow): void {
    this.win = win
  }

  unbind(win: BrowserWindow): void {
    if (this.win === win) this.win = null
  }

  async getStatus(cwd: string): Promise<GitWorkspaceSnapshot> {
    const root = resolve(await runGitText(resolve(cwd), ['rev-parse', '--show-toplevel']))
    const [statusBuffer, operation] = await Promise.all([
      runGitBuffer(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
      this.detectOperation(root)
    ])
    const indexState = await runGitBuffer(root, ['ls-files', '--stage', '-z'])
    const statusRaw = statusBuffer.toString('utf8')
    const parsed = parsePorcelainV2(statusRaw)
    const worktreeFingerprint = await this.fingerprintWorktree(
      root,
      parsed.files.filter((file) => file.unstaged).map((file) => file.path)
    )
    const snapshotId = createHash('sha256')
      .update(parsed.head ?? 'unborn')
      .update('\0').update(statusBuffer)
      .update('\0').update(indexState)
      .update('\0').update(worktreeFingerprint)
      .digest('hex')
    const cached = this.statusCache.get(root)
    if (cached?.snapshotId === snapshotId && cached.operation === operation) return cached
    const stats = await Promise.all([
      runGitBuffer(root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      runGitBuffer(root, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv'])
    ])
    const [unstagedStats, stagedStats] = stats.map((buffer) => parseNumstat(buffer.toString('utf8')))
    for (const file of parsed.files) {
      const unstaged = unstagedStats.get(file.path)
      const staged = stagedStats.get(file.path)
      file.additions = (unstaged?.additions ?? 0) + (staged?.additions ?? 0)
      file.deletions = (unstaged?.deletions ?? 0) + (staged?.deletions ?? 0)
      if (file.kind === 'untracked') {
        // Match getDiff's size/binary policy and count final unterminated lines.
        const patch = await this.untrackedPatch(root, file.path)
        file.additions = patch.split('\n').slice(5).filter((line) => line.startsWith('+')).length
      }
    }
    const snapshot: GitWorkspaceSnapshot = {
      snapshotId,
      root,
      head: parsed.head,
      branch: parsed.branch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      operation,
      files: parsed.files,
      stagedCount: parsed.files.filter((file) => file.staged).length,
      unstagedCount: parsed.files.filter((file) => file.unstaged).length,
      conflictCount: parsed.files.filter((file) => file.conflicted).length,
      capturedAt: Date.now()
    }
    if (this.statusCache.size >= 16) this.statusCache.clear()
    this.statusCache.set(root, snapshot)
    return snapshot
  }

  async getDiff(cwd: string, path: string, scope: GitDiffScope): Promise<GitFileDiff> {
    const snapshot = await this.getStatus(cwd)
    const file = snapshot.files.find((candidate) => candidate.path === path)
    if (!file) throw new Error('文件已不在 Git 变更列表中')
    safeRepoPath(snapshot.root, path)
    let patch: string
    if (file.kind === 'untracked') {
      if (scope === 'staged') throw new Error('未跟踪文件尚未暂存')
      patch = await this.untrackedPatch(snapshot.root, path)
    } else {
      const args = [
        'diff',
        ...stageLabel(scope),
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        '--full-index',
        '--unified=3',
        '--',
        path
      ]
      patch = (await runGitBuffer(snapshot.root, args)).toString('utf8')
    }
    const parsed = parseUnifiedDiff(patch, snapshot.snapshotId, path, scope)
    parsed.oldPath = file.oldPath
    if (file.kind === 'untracked') parsed.selectable = false
    const { headerLines: _headerLines, ...wire } = parsed
    return wire
  }

  async stagePaths(cwd: string, snapshotId: string, paths: string[]): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    const selected = this.validatePaths(snapshot, paths, (file) => file.unstaged)
    await runGitBuffer(snapshot.root, ['add', '-A', '--', ...selected])
    return this.changedSnapshot(snapshot.root)
  }

  async unstagePaths(cwd: string, snapshotId: string, paths: string[]): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    const selected = this.validatePaths(snapshot, paths, (file) => file.staged)
    if (snapshot.head) {
      await runGitBuffer(snapshot.root, ['restore', '--staged', '--', ...selected])
    } else {
      await runGitBuffer(snapshot.root, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...selected])
    }
    return this.changedSnapshot(snapshot.root)
  }

  async discardPaths(cwd: string, snapshotId: string, paths: string[]): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    const selected = this.validatePaths(snapshot, paths, (file) => file.unstaged && !file.conflicted)
    for (const path of selected) {
      const file = snapshot.files.find((candidate) => candidate.path === path) as GitFileStatus
      if (file.kind === 'untracked') {
        await rm(safeRepoPath(snapshot.root, path), { force: true, recursive: false })
      } else {
        await runGitBuffer(snapshot.root, ['restore', '--worktree', '--', path])
      }
    }
    return this.changedSnapshot(snapshot.root)
  }

  async applySelection(request: GitSelectionRequest): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(request.cwd, request.snapshotId)
    const file = snapshot.files.find((candidate) => candidate.path === request.path)
    if (!file) throw new Error('文件状态已变化，请刷新后重试')
    if (file.kind === 'untracked' || file.conflicted) throw new Error('此文件只支持整文件操作')
    const scope: GitDiffScope = request.action === 'stage' ? 'unstaged' : 'staged'
    if (request.action === 'discard') {
      // Discard always operates on the worktree diff.
      if (!file.unstaged) throw new Error('文件没有未暂存修改')
    } else if (scope === 'unstaged' ? !file.unstaged : !file.staged) {
      throw new Error('文件在所选范围中没有修改')
    }

    const forwardScope: GitDiffScope = request.action === 'unstage' ? 'staged' : 'unstaged'
    const forwardPatch = await this.rawDiff(snapshot.root, request.path, forwardScope, false)
    const forward = parseUnifiedDiff(forwardPatch, snapshot.snapshotId, request.path, forwardScope)
    if (!forward.selectable) throw new Error('此差异不支持 hunk/行级操作')
    const selectedLines = request.lineIds?.length
      ? forward.hunks.flatMap((hunk) => hunk.lines).filter((line) => request.lineIds?.includes(line.id))
      : forward.hunks.find((hunk) => hunk.id === request.hunkId)?.lines.filter((line) => line.kind === 'add' || line.kind === 'delete')
    if (!selectedLines?.length) throw new Error('没有选择可应用的差异行')
    const keys = new Set(selectedLines.map((line) => canonicalChangeKey(line, false)).filter((key): key is string => Boolean(key)))

    const reverse = request.action !== 'stage'
    const applySource = reverse
      ? parseUnifiedDiff(
          await this.rawDiff(snapshot.root, request.path, forwardScope, true),
          snapshot.snapshotId,
          request.path,
          forwardScope
        )
      : forward
    const patch = filteredPatch(applySource, keys, reverse)
    const cached = request.action === 'stage' || request.action === 'unstage'
    const applyArgs = ['apply', ...(cached ? ['--cached'] : []), '--recount', '--unidiff-zero', '--whitespace=nowarn', '-']
    await runGitBuffer(snapshot.root, [...applyArgs.slice(0, 1), '--check', ...applyArgs.slice(1)], { input: patch })
    await runGitBuffer(snapshot.root, applyArgs, { input: patch })
    return this.changedSnapshot(snapshot.root)
  }

  async commit(cwd: string, snapshotId: string, message: string): Promise<GitCommitResult> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    const normalized = message.trim()
    if (!normalized) throw new Error('提交说明不能为空')
    if (normalized.length > 10_000) throw new Error('提交说明过长')
    if (snapshot.conflictCount > 0) throw new Error('存在未解决冲突，无法提交')
    if (snapshot.stagedCount === 0) throw new Error('暂存区没有可提交的修改')
    const output = await runGitText(snapshot.root, ['commit', '--file=-'], {
      input: `${normalized}\n`,
      timeoutMs: 10 * 60_000,
      env: { GIT_EDITOR: 'true' }
    })
    const commit = await runGitText(snapshot.root, ['rev-parse', 'HEAD'])
    return { commit, summary: output, snapshot: await this.changedSnapshot(snapshot.root) }
  }

  async readConflict(cwd: string, path: string): Promise<GitConflictContent> {
    const snapshot = await this.getStatus(cwd)
    const file = snapshot.files.find((candidate) => candidate.path === path && candidate.conflicted)
    if (!file) throw new Error('文件不再处于冲突状态')
    const target = safeRepoPath(snapshot.root, path)
    const [base, ours, theirs, working, stageRecords] = await Promise.all([
      this.readStage(snapshot.root, 1, path),
      this.readStage(snapshot.root, 2, path),
      this.readStage(snapshot.root, 3, path),
      readFile(target).catch(() => undefined),
      runGitBuffer(snapshot.root, ['ls-files', '--unmerged', '-z', '--', path])
    ])
    const values = [base, ours, theirs, working].filter((value): value is Buffer => Boolean(value))
    const specialMode = stageRecords.toString('utf8').split('\0').some((record) => /^(120000|160000) /.test(record))
    const binary = specialMode || values.some((value) => value.includes(0))
    return {
      path,
      base: binary ? undefined : base?.toString('utf8'),
      ours: binary ? undefined : ours?.toString('utf8'),
      theirs: binary ? undefined : theirs?.toString('utf8'),
      working: binary ? undefined : working?.toString('utf8'),
      binary
    }
  }

  async resolveConflict(
    cwd: string,
    snapshotId: string,
    path: string,
    strategy: 'ours' | 'theirs' | 'content',
    content?: string
  ): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    const file = snapshot.files.find((candidate) => candidate.path === path && candidate.conflicted)
    if (!file) throw new Error('文件不再处于冲突状态')
    const target = safeRepoPath(snapshot.root, path)
    if (strategy === 'content') {
      if (typeof content !== 'string') throw new Error('缺少冲突解决内容')
      const temp = `${target}.${randomUUID()}.pion-merge`
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temp, Buffer.from(content))
      await rename(temp, target)
    } else {
      const stage = strategy === 'ours' ? 2 : 3
      const bytes = await this.readStage(snapshot.root, stage, path)
      if (bytes === undefined) {
        await rm(target, { force: true })
      } else {
        // checkout-index preserves executable and symlink modes; writing the
        // stage bytes directly would turn a symlink conflict into a regular file.
        await runGitBuffer(snapshot.root, ['checkout-index', '--force', `--stage=${stage}`, '--', path])
      }
    }
    await runGitBuffer(snapshot.root, ['add', '-A', '--', path])
    return this.changedSnapshot(snapshot.root)
  }

  async continueOperation(cwd: string, snapshotId: string): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    if (snapshot.conflictCount > 0) throw new Error('仍有未解决冲突')
    const args = snapshot.operation === 'merge' ? ['merge', '--continue']
      : snapshot.operation === 'rebase' ? ['rebase', '--continue']
        : snapshot.operation === 'cherry-pick' ? ['cherry-pick', '--continue']
          : snapshot.operation === 'revert' ? ['revert', '--continue']
            : null
    if (!args) throw new Error('当前没有可继续的 Git 操作')
    await runGitBuffer(snapshot.root, args, { env: { GIT_EDITOR: 'true' }, timeoutMs: 10 * 60_000 })
    return this.changedSnapshot(snapshot.root)
  }

  async abortOperation(cwd: string, snapshotId: string): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.assertSnapshot(cwd, snapshotId)
    const args = snapshot.operation === 'merge' ? ['merge', '--abort']
      : snapshot.operation === 'rebase' ? ['rebase', '--abort']
        : snapshot.operation === 'cherry-pick' ? ['cherry-pick', '--abort']
          : snapshot.operation === 'revert' ? ['revert', '--abort']
            : null
    if (!args) throw new Error('当前没有可中止的 Git 操作')
    await runGitBuffer(snapshot.root, args)
    return this.changedSnapshot(snapshot.root)
  }

  private async assertSnapshot(cwd: string, expected: string): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.getStatus(cwd)
    if (snapshot.snapshotId !== expected) throw new Error('工作区已发生变化，请刷新审查内容后重试')
    return snapshot
  }

  private validatePaths(
    snapshot: GitWorkspaceSnapshot,
    paths: string[],
    allowed: (file: GitFileStatus) => boolean
  ): string[] {
    const unique = [...new Set(paths)]
    if (unique.length === 0 || unique.length > 200) throw new Error('请选择 1–200 个文件')
    for (const path of unique) {
      safeRepoPath(snapshot.root, path)
      const file = snapshot.files.find((candidate) => candidate.path === path)
      if (!file || !allowed(file)) throw new Error(`文件状态已变化：${path}`)
    }
    return unique
  }

  private async changedSnapshot(cwd: string): Promise<GitWorkspaceSnapshot> {
    const snapshot = await this.getStatus(cwd)
    const update: GitSnapshotUpdate = { snapshot }
    this.win?.webContents.send(SNAPSHOT_CHANNEL, update)
    return snapshot
  }

  private async rawDiff(root: string, path: string, scope: GitDiffScope, reverse: boolean): Promise<string> {
    const args = [
      'diff',
      ...stageLabel(scope),
      ...(reverse ? ['-R'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      '--unified=3',
      '--',
      path
    ]
    return (await runGitBuffer(root, args)).toString('utf8')
  }

  private async untrackedPatch(root: string, path: string): Promise<string> {
    const target = safeRepoPath(root, path)
    const stat = await lstat(target)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
      return `diff --git a/${path} b/${path}\nBinary files /dev/null and b/${path} differ\n`
    }
    const bytes = await readFile(target)
    if (bytes.includes(0)) return `diff --git a/${path} b/${path}\nBinary files /dev/null and b/${path} differ\n`
    const text = bytes.toString('utf8')
    if (!text) return `diff --git a/${path} b/${path}\nnew file mode 100644\n`
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      ...(text.endsWith('\n') ? [] : ['\\ No newline at end of file']),
      ''
    ].join('\n')
  }

  private async fingerprintWorktree(root: string, paths: string[]): Promise<string> {
    if (this.fingerprintCache.size > 20_000) this.fingerprintCache.clear()
    const aggregate = createHash('sha256')
    for (const path of [...paths].sort()) {
      const target = safeRepoPath(root, path)
      const key = `${root}\0${path}`
      try {
        const stat = await lstat(target)
        const signature = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        let digest = this.fingerprintCache.get(key)?.signature === signature
          ? this.fingerprintCache.get(key)!.digest
          : ''
        if (!digest) {
          const file = createHash('sha256')
          if (stat.isSymbolicLink()) {
            file.update(await readlink(target))
          } else if (stat.isFile()) {
            for await (const chunk of createReadStream(target)) file.update(chunk as Buffer)
          } else {
            file.update(`special:${stat.mode}`)
          }
          digest = file.digest('hex')
          this.fingerprintCache.set(key, { signature, digest })
        }
        aggregate.update(path).update('\0').update(signature).update('\0').update(digest).update('\0')
      } catch {
        aggregate.update(path).update('\0missing\0')
      }
    }
    return aggregate.digest('hex')
  }

  private async readStage(root: string, stage: 1 | 2 | 3, path: string): Promise<Buffer | undefined> {
    try {
      const value = await runGitBuffer(root, ['show', `:${stage}:${path}`])
      if (value.length > MAX_CONFLICT_TEXT) throw new Error('冲突文件超过 2 MiB 限制')
      return value
    } catch (error) {
      if (error instanceof Error && error.message.includes('超过 2 MiB')) throw error
      return undefined
    }
  }

  private async detectOperation(root: string): Promise<GitOperation> {
    const checks: Array<[GitOperation, string]> = [
      ['merge', 'MERGE_HEAD'],
      ['rebase', 'rebase-merge'],
      ['rebase', 'rebase-apply'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD']
    ]
    for (const [operation, marker] of checks) {
      try {
        const path = await runGitText(root, ['rev-parse', '--git-path', marker])
        await access(resolve(root, path), fsConstants.F_OK)
        return operation
      } catch {
        // Try the next operation marker.
      }
    }
    return 'none'
  }
}
