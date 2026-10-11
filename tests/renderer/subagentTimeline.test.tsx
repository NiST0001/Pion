import { describe, expect, it } from 'vitest'
import type { SubagentSessionRow, SubagentSessionSnapshot } from '../../src/shared/subagent-sessions'
import { createSubagentTimelineProjector } from '../../src/renderer/src/agent/subagentTimeline'

function snapshot(rows: SubagentSessionRow[], extra: Partial<SubagentSessionSnapshot> = {}): SubagentSessionSnapshot {
  return { id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'parent-call',
    parentSessionId: 'parent', cwd: '/project', name: 'A name is not a prompt', status: 'running',
    revision: 1, truncated: false, rows, ...extra }
}
const text = (n: number, value: string, state?: SubagentSessionRow['state']): SubagentSessionRow =>
  ({ id: `message-${n}-text`, kind: 'assistant', text: value, ...(state ? { state } : {}) })
const thinking = (n: number, value: string, state?: SubagentSessionRow['state']): SubagentSessionRow =>
  ({ id: `message-${n}-thinking`, kind: 'thinking', text: value, ...(state ? { state } : {}) })
const tool = (n: number, value = 'output', state: SubagentSessionRow['state'] = 'completed'): SubagentSessionRow =>
  ({ id: `tool-${n}`, kind: 'tool', text: value, toolName: 'read', state })

describe('bounded display-only subagent timeline', () => {
  it('joins only the real observer message identity, never matching text or adjacency', () => {
    const p = createSubagentTimelineProjector()
    const result = p.project(snapshot([text(1, 'same'), thinking(3, 'same'), tool(2), thinking(1, 'reason'), text(3, 'same')]))
    expect(result).toEqual([
      { kind: 'assistant', id: 1, text: 'same', thinking: 'reason', streaming: false },
      { kind: 'assistant', id: 3, text: 'same', thinking: 'same', streaming: false },
      { kind: 'tool', id: 2, tool: { id: 'tool-2', name: 'read', outputText: 'output', status: 'done', isError: false } }
    ])
  })

  it('keeps numeric keys and unchanged references across updates, reorder and bounded window eviction', () => {
    const p = createSubagentTimelineProjector()
    const first = p.project(snapshot([text(1, 'hello'), thinking(1, 'reason'), tool(2), text(3, 'draft')]))
    const second = p.project(snapshot([tool(2), text(3, 'final'), thinking(1, 'reason'), text(1, 'hello')], { revision: 2 }))
    expect(second.map((item) => item.id)).toEqual([2, 3, 1])
    expect(second[0]).toBe(first[1])
    expect(second[2]).toBe(first[0])
    expect(second[1]).not.toBe(first[2])
    p.project(snapshot([text(3, 'final')], { truncated: true }))
    const restored = p.project(snapshot([text(1, 'hello'), thinking(1, 'reason'), text(3, 'final')]))
    expect(restored.map((item) => item.id)).toEqual([1, 3])
    expect(restored[1]).toBe(second[1])
  })

  it('does not retain memoized content across child, runtime or backend changes', () => {
    const p = createSubagentTimelineProjector()
    const rows = [text(1, 'same')]
    const a = p.project(snapshot(rows))[0]
    const b = p.project(snapshot(rows, { id: 'other' }))[0]
    expect(b).not.toBe(a)
    const c = p.project(snapshot(rows, { id: 'other', backendId: 'replacement' }))[0]
    expect(c).not.toBe(b)
    expect(p.project(snapshot(rows, { id: 'other', backendId: 'replacement', runtimeId: 'new' }))[0]).not.toBe(c)
    p.reset()
    expect(p.project(snapshot(rows))[0]).not.toBe(a)
  })

  it('treats empty final fields as authoritative without synthesizing final/status messages', () => {
    const p = createSubagentTimelineProjector()
    const draft = p.project(snapshot([text(1, 'draft'), thinking(1, 'private reasoning')]))[0]
    const final = p.project(snapshot([text(1, ''), thinking(1, '')], { status: 'failed', truncated: true }))[0]
    expect(final).toEqual({ kind: 'assistant', id: 1, text: '', thinking: '', streaming: false })
    expect(final.id).toBe(draft.id)
    expect(p.project(snapshot([], { status: 'aborted' }))).toEqual([])
    expect(p.project(snapshot([thinking(1, '')]))).toEqual([{ kind: 'assistant', id: 1, text: '', thinking: '', streaming: false }])
  })

  it('retains live reveal identity across the real completed message state without keeping it streaming', () => {
    const p = createSubagentTimelineProjector()
    const draft = p.project(snapshot([text(1, 'draft', 'running'), thinking(1, '', 'running')]))[0]
    expect(draft).toMatchObject({ streaming: true, live: true })
    const final = p.project(snapshot([text(1, 'final', 'completed'), thinking(1, '', 'completed')]))[0]
    expect(final).toMatchObject({ id: draft.id, text: 'final', streaming: false, live: true })
    expect(p.project(snapshot([text(1, 'final', 'completed'), thinking(1, '', 'completed')]))[0]).toBe(final)
  })

  it('accepts the same exact text/id budget as the producer and store', () => {
    const rows = Array.from({ length: 8 }, (_, i) => text(i + 1, 'x'.repeat(8192), 'completed'))
    const idChars = rows.reduce((total, row) => total + row.id.length, 0)
    rows[7].text = 'x'.repeat(65536 - 7 * 8192 - idChars)
    expect(createSubagentTimelineProjector().project(snapshot(rows))).toHaveLength(8)
    rows[7].id += '\n'
    expect(createSubagentTimelineProjector().project(snapshot(rows))).toEqual([])
  })

  it('never calls an unmarked assistant streaming just because the child is running', () => {
    const p = createSubagentTimelineProjector()
    expect(p.project(snapshot([text(1, 'finished'), thinking(1, '')]))[0]).toMatchObject({ streaming: false })
    const rows = [text(1, 'earlier', 'running'), thinking(1, '', 'running'), text(2, 'draft', 'running'), thinking(2, 'reason', 'running')]
    expect(p.project(snapshot(rows)).map((item) => item.kind === 'assistant' && item.streaming)).toEqual([false, true])
    expect(p.project(snapshot([...rows, tool(3, '', 'running')])).slice(0, 2).map((item) => item.kind === 'assistant' && item.streaming)).toEqual([false, false])
    for (const status of ['starting', 'cancelling', 'completed', 'failed', 'aborted'] as const) {
      expect(p.project(snapshot(rows, { status }))[1]).toMatchObject({ streaming: false })
    }
  })

  it('projects only tool name/state/output; task JSON and attached unsafe fields stay inert', () => {
    const p = createSubagentTimelineProjector()
    const output = '{"tasks":[{"id":"1","status":"in_progress"}]}'
    const row = { ...tool(2, output, 'failed'), toolName: 'pion_task', args: { path: '/secret' },
      command: 'danger', images: ['base64'], usage: { tokens: 100 }, entryId: 'sdk-entry', path: '/secret' }
    const result = p.project(snapshot([row]))
    expect(result).toEqual([{ kind: 'tool', id: 2, tool: {
      id: 'tool-2', name: 'pion_task', status: 'error', isError: true, outputText: output
    } }])
    expect(p.project(snapshot([tool(2, '', 'running')]))[0]).toMatchObject({ tool: { status: 'running', isError: false } })
    expect(result.some((item) => item.kind === 'user')).toBe(false)
  })

  it('fails closed for duplicate/conflicting/noncanonical IDs and invalid tool metadata', () => {
    const p = createSubagentTimelineProjector()
    const invalid: SubagentSessionRow[][] = [
      [text(1, 'a'), text(1, 'b')], [text(1, 'a'), tool(1)],
      [{ id: 'assistant-1:text', kind: 'assistant', text: 'not observer grammar' }],
      [{ id: 'message-01-text', kind: 'assistant', text: '' }],
      [{ id: 'message-9007199254740992-text', kind: 'assistant', text: '' }],
      [{ id: 'message-1-text', kind: 'thinking', text: '' }],
      [{ id: 'tool-1', kind: 'tool', text: '' }],
      [{ ...tool(1), toolName: 'bad\0name' }]
    ]
    for (const rows of invalid) expect(p.project(snapshot(rows))).toEqual([])
  })

  it('rejects oversized arrays/fields/budgets rather than copying or truncating untrusted payloads', () => {
    const p = createSubagentTimelineProjector()
    expect(p.project(snapshot(Array.from({ length: 201 }, (_, i) => tool(i + 1))))).toEqual([])
    expect(p.project(snapshot([text(1, 'x'.repeat(8193))]))).toEqual([])
    expect(p.project(snapshot(Array.from({ length: 9 }, (_, i) => text(i + 1, 'x'.repeat(8192)))))).toEqual([])
    const boundary = p.project(snapshot(Array.from({ length: 200 }, (_, i) => tool(i + 1))))
    expect(boundary).toHaveLength(200)
    expect(new Set(boundary.map((item) => item.id)).size).toBe(200)
    expect(p.project(null)).toEqual([])
    expect(p.project(snapshot([], { id: '', backendId: 'backend' }))).toEqual([])
  })
})
