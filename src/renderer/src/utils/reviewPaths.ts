import type { GitDiffScope, GitFileStatus } from '../../../shared/types'

export interface PendingReviewSelection {
  paths: string[]
  preferredScope: GitDiffScope
  fallbackToFirst: boolean
}

function normalizeReviewPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized
}

function pathBelow(path: string, parent: string): string | null {
  const normalizedPath = normalizeReviewPath(path)
  const normalizedParent = normalizeReviewPath(parent)
  if (normalizedPath === normalizedParent) return ''
  if (normalizedParent === '/' && normalizedPath.startsWith('/')) return normalizedPath.slice(1)
  return normalizedPath.startsWith(`${normalizedParent}/`)
    ? normalizedPath.slice(normalizedParent.length + 1)
    : null
}

export function findReviewFile(
  files: GitFileStatus[],
  requestedPath: string,
  cwd: string | undefined,
  root: string
): GitFileStatus | null {
  const requested = normalizeReviewPath(requestedPath)
  const normalizedRoot = normalizeReviewPath(root)
  const normalizedCwd = cwd ? normalizeReviewPath(cwd) : normalizedRoot
  const cwdFromRoot = pathBelow(normalizedCwd, normalizedRoot)
  const requestedFromRoot = pathBelow(requested, normalizedRoot)
  const requestedFromCwd = pathBelow(requested, normalizedCwd)
  const relativeRequested = requested.replace(/^\.\//, '').replace(/^\//, '')
  const candidates = new Set<string>()

  if (requestedFromRoot !== null) candidates.add(requestedFromRoot)
  if (requestedFromCwd !== null) {
    candidates.add(requestedFromCwd)
    if (cwdFromRoot) candidates.add(`${cwdFromRoot}/${requestedFromCwd}`)
  }
  if (cwdFromRoot && requestedFromRoot === null && requestedFromCwd === null) {
    candidates.add(`${cwdFromRoot}/${relativeRequested}`)
  }
  candidates.add(relativeRequested)
  if (cwdFromRoot && relativeRequested.startsWith(`${cwdFromRoot}/`)) {
    candidates.add(relativeRequested.slice(cwdFromRoot.length + 1))
  }

  const normalizedFiles = files.map((file) => {
    const path = normalizeReviewPath(file.path)
    const relativePath = path.replace(/^\.\//, '').replace(/^\//, '')
    const aliases = new Set<string>([path, relativePath])
    const fromRoot = pathBelow(path, normalizedRoot)
    const fromCwd = pathBelow(path, normalizedCwd)
    if (fromRoot !== null) aliases.add(fromRoot)
    if (fromCwd !== null) aliases.add(fromCwd)
    if (cwdFromRoot && relativePath.startsWith(`${cwdFromRoot}/`)) {
      aliases.add(relativePath.slice(cwdFromRoot.length + 1))
    }
    return { file, aliases }
  })
  for (const candidate of candidates) {
    const exact = normalizedFiles.find((entry) => entry.aliases.has(candidate))
    if (exact) return exact.file
  }

  // A tool may report a cwd-relative suffix. Use it only when unambiguous.
  for (const candidate of candidates) {
    if (!candidate) continue
    const suffixMatches = normalizedFiles.filter((entry) => (
      [...entry.aliases].some((alias) => alias.endsWith(`/${candidate}`))
    ))
    if (suffixMatches.length === 1) return suffixMatches[0].file
  }
  return null
}

export function resolvePendingReviewFile(
  files: GitFileStatus[],
  pending: PendingReviewSelection,
  cwd: string | undefined,
  root: string
): GitFileStatus | null {
  for (const path of pending.paths) {
    const file = findReviewFile(files, path, cwd, root)
    if (file) return file
  }
  if (!pending.fallbackToFirst) return null
  return files.find((file) => file.unstaged || file.conflicted)
    ?? files.find((file) => file.staged)
    ?? files[0]
    ?? null
}

export function scopeForReviewFile(file: GitFileStatus, preferredScope: GitDiffScope): GitDiffScope {
  return file.unstaged || file.conflicted
    ? 'unstaged'
    : file.staged
      ? 'staged'
      : preferredScope
}
