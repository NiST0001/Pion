import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyToolResult, deriveChanges, deriveTurnChanges } from '../../src/renderer/src/agent/timeline'
import type { FileChange, TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'

function toolRow(id: number, tool: ToolItem): TimelineItem {
  return { kind: 'tool', id, tool }
}

const completed: ToolItem = {
  id: 'edit', name: 'edit', status: 'done', isError: false, resultReceived: true,
  path: 'same.ts', diff: '-1 old\n+1 new'
}

afterEach(() => vi.restoreAllMocks())

describe('tool change projection cache', () => {
  it('reuses completed body parsing across tokens while preserving same-path merges and real turn boundaries', () => {
    const content = 'cache first line\ncache second line'
    const diff = '-1 cache before\n+1 cache after'
    const write = Object.freeze({ ...completed, id: 'write', name: 'write', diff: undefined, writeContent: content })
    const edit = Object.freeze({ ...completed, diff })
    const otherEdit = Object.freeze({ ...edit, id: 'other-edit' })
    let timeline: TimelineItem[] = [
      toolRow(90, { ...completed, id: 'orphan', path: 'orphan.ts' }),
      { kind: 'user', id: 1, text: 'same prompt' },
      toolRow(2, write), toolRow(3, edit), toolRow(4, edit),
      { kind: 'user', id: 5, text: 'same prompt' },
      toolRow(6, otherEdit),
      { kind: 'assistant', id: 7, text: '', thinking: '', streaming: true }
    ]
    const split = vi.spyOn(String.prototype, 'split')
    const first = deriveTurnChanges(timeline)
    const bodySplits = () => split.mock.contexts.filter(value => value === content || value === diff).length
    const initialSplits = bodySplits()
    let latest = first
    for (const delta of ['one', 'two', 'three']) {
      timeline = timeline.map(item => item.kind === 'assistant' ? { ...item, text: item.text + delta } : item)
      latest = deriveTurnChanges(timeline)
    }
    const repeatedSplits = bodySplits()
    expect(initialSplits).toBeGreaterThan(0)
    expect(repeatedSplits).toBe(initialSplits)
    expect(latest).toEqual(first)
    expect(first).toEqual([
      { userId: 1, lastItemId: 4, changes: [{ path: 'same.ts', kind: 'edit',
        diff: '+1 cache first line\n+2 cache second line\n  ...\n' + diff, additions: 3, deletions: 1 }] },
      { userId: 5, lastItemId: 7, changes: [{ path: 'same.ts', kind: 'edit', diff, additions: 1, deletions: 1 }] }
    ])
  })

  it('invalidates mutable source fields and terminal eligibility without exposing its private projection', () => {
    const tool = { ...completed }
    const timeline = [toolRow(1, tool)]
    const first = deriveChanges(timeline)
    first[0].diff = 'caller-owned replacement'
    first[0].additions = 999
    expect(deriveChanges(timeline)).toEqual([{ path: 'same.ts', kind: 'edit', diff: completed.diff, additions: 1, deletions: 1 }])
    const revisions: { patch: Partial<ToolItem>; expected: FileChange[] }[] = [
      { patch: { diff: '+1 revised\n+2 extra' }, expected: [{ path: 'same.ts', kind: 'edit', diff: '+1 revised\n+2 extra', additions: 2, deletions: 0 }] },
      { patch: { path: '' }, expected: [] },
      { patch: { path: 'moved.ts' }, expected: [{ path: 'moved.ts', kind: 'edit', diff: '+1 revised\n+2 extra', additions: 2, deletions: 0 }] },
      { patch: { diff: '' }, expected: [] },
      { patch: { diff: '+1 restored' }, expected: [{ path: 'moved.ts', kind: 'edit', diff: '+1 restored', additions: 1, deletions: 0 }] },
      { patch: { name: 'read' }, expected: [] },
      { patch: { name: 'write', writeContent: 'one\ntwo' }, expected: [{ path: 'moved.ts', kind: 'write', content: 'one\ntwo', additions: 2, deletions: 0 }] },
      { patch: { writeContent: '' }, expected: [{ path: 'moved.ts', kind: 'write', content: '', additions: 0, deletions: 0 }] },
      { patch: { status: 'running' }, expected: [] },
      { patch: { status: 'done', resultReceived: false }, expected: [] },
      { patch: { resultReceived: true, isError: true }, expected: [] },
      { patch: { isError: false }, expected: [{ path: 'moved.ts', kind: 'write', content: '', additions: 0, deletions: 0 }] }
    ]
    for (const { patch, expected } of revisions) {
      Object.assign(tool, patch)
      expect(deriveChanges(timeline)).toEqual(expected)
    }
  })

  it('uses authoritative result replacements for the same call ID and removes a cleared final diff', () => {
    const initial = { ...completed }
    expect(deriveChanges([toolRow(1, initial)])[0].additions).toBe(1)
    const replaced = applyToolResult(initial, {
      content: [{ type: 'text', text: '' }], details: { diff: '+1 revised\n+2 extra' }
    }, false, 'message')
    expect(deriveChanges([toolRow(1, replaced)])).toEqual([
      { path: 'same.ts', kind: 'edit', diff: '+1 revised\n+2 extra', additions: 2, deletions: 0 }
    ])
    const cleared = applyToolResult(replaced, { content: [] }, false, 'message')
    expect(deriveChanges([toolRow(1, cleared)])).toEqual([])
    expect(initial.diff).toBe(completed.diff)
  })
})
