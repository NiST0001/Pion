import type { SessionMeta } from '../../../shared/types'

export type SessionListFilter = 'all' | 'running' | 'idle'
export type SessionListSort =
  | 'manual'
  | 'updated-desc'
  | 'updated-asc'
  | 'running-first'
  | 'tokens-desc'
  | 'tokens-asc'

/** Unknown numeric metadata stays last in either direction; no numeric coercion. */
function compareKnownNumbers(a: number | undefined, b: number | undefined, ascending: boolean): number {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  if (a === b) return 0
  return (a < b ? -1 : 1) * (ascending ? 1 : -1)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function tokenCount(session: SessionMeta): number | undefined {
  const value = finiteNumber(session.totalTokens)
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Display-only projection of an already scoped project list. Running membership
 * comes exclusively from the supplied exact paths, never from session metadata.
 * Returns a fresh array, preserving session identities and source order on ties.
 * Manual ordering preserves the input order after filtering, without writing it.
 */
export function getSessionListView(
  sessions: readonly SessionMeta[],
  runningPaths: ReadonlySet<string>,
  filter: SessionListFilter = 'all',
  sort: SessionListSort = 'manual'
): SessionMeta[] {
  const rows = sessions
    .map((session, index) => ({ session, index, running: runningPaths.has(session.path) }))
    .filter(({ running }) => filter === 'all' || (filter === 'running' ? running : !running))

  if (sort !== 'manual') {
    rows.sort((a, b) => {
      let comparison: number
      switch (sort) {
        case 'running-first':
          comparison = Number(b.running) - Number(a.running)
          break
        case 'updated-desc':
        case 'updated-asc':
          comparison = compareKnownNumbers(
            finiteNumber(a.session.mtime), finiteNumber(b.session.mtime), sort === 'updated-asc'
          )
          break
        case 'tokens-desc':
        case 'tokens-asc':
          comparison = compareKnownNumbers(tokenCount(a.session), tokenCount(b.session), sort === 'tokens-asc')
          break
      }
      return comparison || a.index - b.index
    })
  }

  return rows.map(({ session }) => session)
}
