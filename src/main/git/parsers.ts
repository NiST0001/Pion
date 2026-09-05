import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  GitDiffHunk,
  GitDiffLine,
  GitDiffScope,
  GitFileDiff,
  GitFileKind,
  GitFileStatus
} from '../../shared/operations'

export interface ParsedDiff extends GitFileDiff {
  headerLines: string[]
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

export function safeRepoPath(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error('无效的 Git 路径')
  const target = resolve(root, path)
  if (target === root || !target.startsWith(`${root}${sep}`) || relative(root, target).startsWith('..')) {
    throw new Error('Git 路径超出工作区')
  }
  return target
}

export function canonicalChangeKey(line: GitDiffLine, reverse: boolean): string | null {
  if (!reverse && line.kind === 'add') return `add:${line.newLine}:${line.text}`
  if (!reverse && line.kind === 'delete') return `delete:${line.oldLine}:${line.text}`
  if (reverse && line.kind === 'delete') return `add:${line.oldLine}:${line.text}`
  if (reverse && line.kind === 'add') return `delete:${line.newLine}:${line.text}`
  return null
}

export function filteredPatch(diff: ParsedDiff, selected: Set<string>, reverse: boolean): string {
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

export function stageLabel(scope: GitDiffScope): string[] {
  return scope === 'staged' ? ['--cached'] : []
}

