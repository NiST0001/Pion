import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../shared/ipc'
import type {
  GitCommitResult,
  GitConflictContent,
  GitDiffHunk,
  GitDiffLine,
  GitDiffScope,
  GitFileDiff,
  GitFileKind,
  GitFileStatus,
  GitOperation,
  GitSelectionRequest,
  GitSnapshotUpdate,
  GitWorkspaceSnapshot
} from '../shared/operations'

const GIT_TIMEOUT_MS = 45_000
const MAX_GIT_OUTPUT = 32 * 1024 * 1024
const MAX_CONFLICT_TEXT = 2 * 1024 * 1024
const SNAPSHOT_CHANNEL = IPC_EVENTS.GitSnapshot

interface GitProcessOptions {
  input?: string | Buffer
  allowExitCodes?: number[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

interface ParsedDiff extends GitFileDiff {
  headerLines: string[]
}

function collectChild(
  child: ChildProcess,
  options: GitProcessOptions,
  args: string[]
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    const finishError = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(message))
    }
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      finishError(`Git 命令超时：git ${args.join(' ')}`)
    }, options.timeoutMs ?? GIT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_GIT_OUTPUT) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        finishError('Git 输出超过 32 MiB 限制，请缩小审查范围')
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => finishError(error.message))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const allowed = options.allowExitCodes ?? [0]
      if (!allowed.includes(code ?? -1)) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(detail || `git ${args[0] ?? ''} 失败（${code ?? 'unknown'}）`))
        return
      }
      resolvePromise(Buffer.concat(stdout))
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}

async function runGitBuffer(
  cwd: string,
  args: string[],
  options: GitProcessOptions = {}
): Promise<Buffer> {
  const child = spawn('git', args, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env }
  })
  return collectChild(child, options, args)
}

async function runGitText(
  cwd: string,
  args: string[],
  options: GitProcessOptions = {}
): Promise<string> {
  return (await runGitBuffer(cwd, args, options)).toString('utf8').trim()
}

function splitFixed(record: string, fixedFields: number): string[] {
  const fields: string[] = []
  let rest = record
  for (let index = 0; index < fixedFields; index++) {
    const space = rest.indexOf(' ')
    if (space < 0) return [...fields, rest]
    fields.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  fields.push(rest)
  return fields
}

function fileKind(indexCode: string, worktreeCode: string, untracked = false, conflicted = false): GitFileKind {
  if (conflicted) return 'conflicted'
  if (untracked) return 'untracked'
  const codes = `${indexCode}${worktreeCode}`
  if (codes.includes('R') || codes.includes('C')) return 'renamed'
  if (codes.includes('D')) return 'deleted'
  if (codes.includes('A')) return 'added'
  if (codes.includes('T')) return 'type-changed'
  return 'modified'
}

export function parsePorcelainV2(raw: string): {
  head: string | null
  branch: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
} {
  const records = raw.split('\0')
  const files: GitFileStatus[] = []
  let head: string | null = null
  let branch: string | null = null
  let ahead = 0
  let behind = 0

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      head = value === '(initial)' ? null : value
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      branch = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(record)
      ahead = match ? Number(match[1]) : 0
      behind = match ? Number(match[2]) : 0
      continue
    }
    if (record.startsWith('? ')) {
      const path = record.slice(2)
      files.push({
        path,
        kind: 'untracked',
        indexCode: '?',
        worktreeCode: '?',
        staged: false,
        unstaged: true,
        conflicted: false,
        binary: false
      })
      continue
    }
    if (record.startsWith('1 ')) {
      const fields = splitFixed(record, 8)
      if (fields.length < 9) continue
      const xy = fields[1]
      const indexCode = xy[0] ?? '.'
      const worktreeCode = xy[1] ?? '.'
      files.push({
        path: fields[8],
        kind: fileKind(indexCode, worktreeCode),
        indexCode,
        worktreeCode,
        staged: indexCode !== '.',
        unstaged: worktreeCode !== '.',
        conflicted: false,
        binary: false
      })
      continue
    }
    if (record.startsWith('2 ')) {
      const fields = splitFixed(record, 9)
      if (fields.length < 10) continue
      const oldPath = records[++index]
      const xy = fields[1]
      const indexCode = xy[0] ?? '.'
      const worktreeCode = xy[1] ?? '.'
      files.push({
        path: fields[9],
        oldPath,
        kind: 'renamed',
        indexCode,
        worktreeCode,
        staged: indexCode !== '.',
        unstaged: worktreeCode !== '.',
        conflicted: false,
        binary: false
      })
      continue
    }
    if (record.startsWith('u ')) {
      const fields = splitFixed(record, 10)
      if (fields.length < 11) continue
      const xy = fields[1]
      files.push({
        path: fields[10],
        kind: 'conflicted',
        indexCode: xy[0] ?? 'U',
        worktreeCode: xy[1] ?? 'U',
        staged: false,
        unstaged: true,
        conflicted: true,
        binary: false
      })
    }
  }
  return { head, branch, ahead, behind, files }
}

function lineId(snapshotId: string, scope: GitDiffScope, path: string, hunk: number, line: number): string {
  return createHash('sha1').update(`${snapshotId}\0${scope}\0${path}\0${hunk}\0${line}`).digest('hex').slice(0, 16)
}

function hunkId(snapshotId: string, scope: GitDiffScope, path: string, header: string, index: number): string {
  return createHash('sha1').update(`${snapshotId}\0${scope}\0${path}\0${header}\0${index}`).digest('hex').slice(0, 16)
}

export function parseUnifiedDiff(
  patch: string,
  snapshotId: string,
  path: string,
  scope: GitDiffScope
): ParsedDiff {
  const rawLines = patch.replace(/\n$/, '').split('\n')
  const firstHunk = rawLines.findIndex((line) => line.startsWith('@@ '))
  const headerLines = firstHunk < 0 ? rawLines.filter(Boolean) : rawLines.slice(0, firstHunk)
  const hunks: GitDiffHunk[] = []
  let additions = 0
  let deletions = 0
  let cursor = firstHunk < 0 ? rawLines.length : firstHunk

  while (cursor < rawLines.length) {
    const header = rawLines[cursor]
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (!match) {
      cursor += 1
      continue
    }
    const oldStart = Number(match[1])
    const oldLines = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newLines = match[4] === undefined ? 1 : Number(match[4])
    const index = hunks.length
    cursor += 1
    let oldLine = oldStart
    let newLine = newStart
    const lines: GitDiffLine[] = []
    while (cursor < rawLines.length && !rawLines[cursor].startsWith('@@ ')) {
      const raw = rawLines[cursor]
      const marker = raw[0]
      const id = lineId(snapshotId, scope, path, index, lines.length)
      if (marker === '+') {
        additions += 1
        lines.push({ id, kind: 'add', newLine, text: raw.slice(1) })
        newLine += 1
      } else if (marker === '-') {
        deletions += 1
        lines.push({ id, kind: 'delete', oldLine, text: raw.slice(1) })
        oldLine += 1
      } else if (marker === ' ') {
        lines.push({ id, kind: 'context', oldLine, newLine, text: raw.slice(1) })
        oldLine += 1
        newLine += 1
      } else {
        lines.push({ id, kind: 'meta', text: raw })
      }
      cursor += 1
    }
    hunks.push({
      id: hunkId(snapshotId, scope, path, header, index),
      header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines
    })
  }

  const binary = patch.includes('GIT binary patch') || patch.includes('Binary files ')
  return {
    snapshotId,
    path,
    scope,
    binary,
    additions,
    deletions,
    hunks,
    selectable: !binary && hunks.length > 0 && !path.includes('\n'),
    rawPatch: patch,
    headerLines
  }
}

function safeRepoPath(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error('无效的 Git 路径')
  const target = resolve(root, path)
  if (target === root || !target.startsWith(`${root}${sep}`) || relative(root, target).startsWith('..')) {
    throw new Error('Git 路径超出工作区')
  }
  return target
}

function canonicalChangeKey(line: GitDiffLine, reverse: boolean): string | null {
  if (!reverse && line.kind === 'add') return `add:${line.newLine}:${line.text}`
  if (!reverse && line.kind === 'delete') return `delete:${line.oldLine}:${line.text}`
  if (reverse && line.kind === 'delete') return `add:${line.oldLine}:${line.text}`
  if (reverse && line.kind === 'add') return `delete:${line.newLine}:${line.text}`
  return null
}

function filteredPatch(diff: ParsedDiff, selected: Set<string>, reverse: boolean): string {
  const output = [...diff.headerLines]
  let selectedCount = 0
  for (const hunk of diff.hunks) {
    const lines: string[] = []
    let hasSelection = false
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        lines.push(` ${line.text}`)
      } else if (line.kind === 'meta') {
        lines.push(line.text)
      } else {
        const key = canonicalChangeKey(line, reverse)
        const keep = key !== null && selected.has(key)
        if (keep) {
          hasSelection = true
          selectedCount += 1
          lines.push(`${line.kind === 'add' ? '+' : '-'}${line.text}`)
        } else if (line.kind === 'delete') {
          // An unselected deletion remains in the patch base and therefore becomes context.
          lines.push(` ${line.text}`)
        }
      }
    }
    if (hasSelection) output.push(hunk.header, ...lines)
  }
  if (selectedCount === 0) throw new Error('选择中没有可应用的增删行')
  return `${output.join('\n')}\n`
}

function stageLabel(scope: GitDiffScope): string[] {
  return scope === 'staged' ? ['--cached'] : []
}

export class GitService {
  private win: BrowserWindow | null = null
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
