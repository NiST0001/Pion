import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../../src/shared/types'
import {
  getSessionListView,
  type SessionListFilter,
  type SessionListSort
} from '../../src/renderer/src/agent/sessionListView'

function session(path: string, mtime = 0, totalTokens?: number): SessionMeta {
  return { path, id: path, timestamp: '2099-01-01', mtime, preview: '', messageCount: 0, totalTokens }
}

const paths = (sessions: readonly SessionMeta[]) => sessions.map(({ path }) => path)

describe('getSessionListView', () => {
  it('defaults to all sessions in manual order and returns a fresh array with original objects', () => {
    const source = Object.freeze([Object.freeze(session('b', 1)), Object.freeze(session('a', 100))])
    const result = getSessionListView(source, new Set(['a']))
    expect(result).toEqual(source)
    expect(result).not.toBe(source)
    expect(result[0]).toBe(source[0])
    expect(result[1]).toBe(source[1])
  })

  it('filters using exact supplied paths, not timestamps, names or optimistic status', () => {
    const source = [session('/project/a'), { ...session('/project/b'), optimistic: true }, session('/other/a')]
    const running = new Set(['/project/b', '/missing'])
    expect(paths(getSessionListView(source, running, 'all'))).toEqual(['/project/a', '/project/b', '/other/a'])
    expect(paths(getSessionListView(source, running, 'running'))).toEqual(['/project/b'])
    expect(paths(getSessionListView(source, running, 'idle'))).toEqual(['/project/a', '/other/a'])
    expect(getSessionListView(source, new Set(), 'running')).toEqual([])
  })

  it.each(['updated-desc', 'updated-asc'] as const)('sorts %s by finite mtime only with stable ties', (sort) => {
    const source = [session('missing', NaN), session('later', 20), session('early', -10), session('tie', 20), session('infinite', Infinity)]
    expect(paths(getSessionListView(source, new Set(), 'all', sort))).toEqual(
      sort === 'updated-desc'
        ? ['later', 'tie', 'early', 'missing', 'infinite']
        : ['early', 'later', 'tie', 'missing', 'infinite']
    )
  })

  it('does not coerce malformed mtime to a number', () => {
    const source = [session('string', '99' as unknown as number), session('finite', 1), session('negative-infinity', -Infinity)]
    expect(paths(getSessionListView(source, new Set(), 'all', 'updated-desc'))).toEqual(['finite', 'string', 'negative-infinity'])
  })

  it('puts running sessions first without reordering either group', () => {
    const source = [session('idle-old', 0), session('run-old', 1), session('idle-new', 100), session('run-new', 200)]
    expect(paths(getSessionListView(source, new Set(['run-new', 'run-old']), 'all', 'running-first')))
      .toEqual(['run-old', 'run-new', 'idle-old', 'idle-new'])
  })

  it.each(['tokens-desc', 'tokens-asc'] as const)('sorts %s with zero known and invalid/unknown always last', (sort) => {
    const source = [
      session('unknown'), session('large', 0, 100), session('nan', 0, NaN), session('zero', 0, 0),
      session('negative', 0, -1), session('tie', 999, 100), session('infinite', 0, Infinity),
      session('small', 0, 10), session('string', 0, '200' as unknown as number),
      session('null', 0, null as unknown as number), session('negative-infinity', 0, -Infinity)
    ]
    const known = sort === 'tokens-desc' ? ['large', 'tie', 'small', 'zero'] : ['zero', 'small', 'large', 'tie']
    expect(paths(getSessionListView(source, new Set(), 'all', sort))).toEqual([
      ...known, 'unknown', 'nan', 'negative', 'infinite', 'string', 'null', 'negative-infinity'
    ])
  })

  it('combines filtering and sorting without changing the input or running set', () => {
    const source = Object.freeze([
      Object.freeze(session('a', 1, 10)), Object.freeze(session('b', 100, 20)), Object.freeze(session('c', 2, 30))
    ])
    const running: ReadonlySet<string> = new Set(['a', 'c'])
    const filters: SessionListFilter[] = ['all', 'running', 'idle']
    const sorts: SessionListSort[] = ['manual', 'updated-desc', 'updated-asc', 'running-first', 'tokens-desc', 'tokens-asc']
    for (const filter of filters) {
      for (const sort of sorts) {
        getSessionListView(source, running, filter, sort)
        expect(paths(source)).toEqual(['a', 'b', 'c'])
        expect([...running]).toEqual(['a', 'c'])
      }
    }
    expect(paths(getSessionListView(source, running, 'running', 'tokens-desc'))).toEqual(['c', 'a'])
    expect(paths(getSessionListView(source, running, 'idle', 'updated-desc'))).toEqual(['b'])
  })

  it('handles empty input for every filter and sort', () => {
    for (const filter of ['all', 'running', 'idle'] as const) {
      for (const sort of ['manual', 'updated-desc', 'updated-asc', 'running-first', 'tokens-desc', 'tokens-asc'] as const) {
        expect(getSessionListView([], new Set(), filter, sort)).toEqual([])
      }
    }
  })
})
