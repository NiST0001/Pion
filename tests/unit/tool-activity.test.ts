import { describe, expect, it, vi } from 'vitest'
import { groupToolActivity, retainToolActivityGroups } from '../../src/renderer/src/agent/toolActivityGroups'
import type { RetainedToolActivityGroup, ToolActivityGroup, ToolTimelineItem } from '../../src/renderer/src/agent/toolActivityGroups'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

type PreviousGroup = Pick<RetainedToolActivityGroup, 'key' | 'ids'>
const scope = 'session-a'
const tool = (id: number, callId: string): ToolTimelineItem => ({ kind: 'tool', id,
  tool: { id: callId, name: 'read', path: 'same.ts', outputText: 'same output', status: 'done', isError: false } })
const previous = (...groups: [string, string[]][]): PreviousGroup[] => groups.map(([key, ids]) => ({ key, ids: new Set(ids) }))
function groups(calls: string[][]): ToolActivityGroup[] {
  const timeline: TimelineItem[] = []
  for (const ids of calls) {
    if (timeline.length) timeline.push({ kind: 'assistant', id: timeline.length + 1, text: '', thinking: '', streaming: false })
    for (const id of ids) timeline.push(tool(timeline.length + 1, id))
  }
  return groupToolActivity(timeline)
}
// Original selection rule, kept small and independent from the indexed implementation.
function baseline(current: readonly ToolActivityGroup[], old: readonly PreviousGroup[]): string[] {
  const used = new Set<string>()
  return current.map(group => {
    const ids = new Set(group.items.map(item => item.tool.id))
    const retained = old.find(candidate => !used.has(candidate.key) && [...candidate.ids].some(id => ids.has(id)))
    const key = retained?.key ?? `group:${scope}:${group.items[0].tool.id}:${group.items[0].id}`
    used.add(key)
    return key
  })
}

describe('indexed tool group identity projection', () => {
  it.each([
    { name: 'merge takes the earliest old group, independent of current ID order',
      old: previous(['first', ['a']], ['second', ['b']]), calls: [['b', 'a'], ['b']], keys: ['first', 'second'] },
    { name: 'split only retains the old key for its first matching segment',
      old: previous(['old', ['a', 'b', 'c']]), calls: [['b'], ['a', 'c']], keys: ['old', 'group:session-a:a:3'] },
    { name: 'unrelated prepend leaves retained groups available',
      old: previous(['old', ['a']]), calls: [['new'], ['a']], keys: ['group:session-a:new:1', 'old'] },
    { name: 'prepend within a group keeps its original identity',
      old: previous(['old', ['a']]), calls: [['new', 'a']], keys: ['old'] },
    { name: 'conflicting duplicate IDs advance only past used keys',
      old: previous(['first', ['x']], ['second', ['x', 'y']], ['third', ['z']]),
      calls: [['x'], ['y'], ['x'], ['z']], keys: ['first', 'second', 'group:session-a:x:5', 'third'] },
    { name: 'duplicate old keys are consumed together',
      old: previous(['shared', ['x']], ['shared', ['y']], ['last', ['y']]), calls: [['x'], ['y']], keys: ['shared', 'last'] },
    { name: 'generated keys also exclude colliding old keys',
      old: previous(['group:session-a:a:1', ['b']], ['last', ['b']]),
      calls: [['a'], ['b']], keys: ['group:session-a:a:1', 'last'] },
    { name: 'equal metadata with a new real ID gets a new identity',
      old: previous(['old', ['a']]), calls: [['b']], keys: ['group:session-a:b:1'] }
  ])('$name', ({ old, calls, keys }) => {
    const current = groups(calls)
    expect(baseline(current, old)).toEqual(keys)
    const projected = retainToolActivityGroups(current, old, scope)
    expect(projected.map(group => group.key)).toEqual(keys)
    projected.forEach((group, index) => {
      expect(group.items).toBe(current[index].items)
      expect(group.ids).toEqual(new Set(calls[index]))
    })
  })

  it('matches the baseline for combinations of overlapping/duplicate group identities', () => {
    const combinations = [['a'], ['b'], ['a', 'b']]
    for (const a of combinations) for (const b of combinations) for (const c of combinations) {
      const old = previous(['first', a], ['second', b], ['first', c])
      for (const x of combinations) for (const y of combinations) for (const z of combinations) {
        const current = groups([x, y, z])
        expect(retainToolActivityGroups(current, old, scope).map(group => group.key)).toEqual(baseline(current, old))
      }
    }
  })

  it.each([32, 64])('indexes each old ID set once for %i streaming groups instead of scanning G² sets', count => {
    const old = previous(...Array.from({ length: count }, (_, i): [string, string[]] => [`old-${i}`, [`call-${i}`]]))
    const current = groups(Array.from({ length: count }, (_, i) => [`call-${i}`]))
    const iterations = old.map(group => vi.spyOn(group.ids, Symbol.iterator))
    // Reverse matching makes every earlier, still-unused group get scanned.
    current.reverse()
    const expected = baseline(current, old)
    expect(iterations.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(count * (count + 1) / 2)
    iterations.forEach(spy => spy.mockClear())
    const projected = retainToolActivityGroups(current, old, scope)
    expect(projected.map(group => group.key)).toEqual(expected)
    expect(iterations.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(count)
  })

  it('does not mutate frozen groups or their tool items on equivalent refresh', () => {
    const current = groups([['a', 'b']])
    current.forEach(group => {
      group.items.forEach(item => { Object.freeze(item.tool); Object.freeze(item) })
      Object.freeze(group.items)
      Object.freeze(group)
    })
    Object.freeze(current)
    const first = retainToolActivityGroups(current, [], scope)
    const refresh = groups([['a', 'b']])
    const next = retainToolActivityGroups(refresh, Object.freeze(first), scope)
    expect(next[0].key).toBe(first[0].key)
    expect(next[0].items).toBe(refresh[0].items)
    expect(next[0].items[0]).not.toBe(first[0].items[0])
  })
})
