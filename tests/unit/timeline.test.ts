import { describe, expect, it } from 'vitest'
import {
  applyToolResult,
  deriveAgentTodos,
  deriveLatestRunChanges,
  diffStats,
  entriesToTimeline
} from '../../src/renderer/src/agent/timeline'
import type { TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'

describe('timeline derivation', () => {
  it('counts display-diff additions and deletions', () => {
    expect(diffStats(' 4 context\n-5 old\n+5 new\n+6 next')).toEqual({ additions: 2, deletions: 1 })
  })

  it('keeps the latest tool result and task snapshot', () => {
    const tool: ToolItem = { id: 't1', name: 'pion_task', status: 'running', isError: false }
    const result = applyToolResult(tool, {
      content: [{ type: 'text', text: 'updated' }],
      details: { tasks: [{ id: 1, subject: 'Validate', status: 'in_progress' }] }
    }, false)

    expect(result).toMatchObject({ status: 'done', outputText: 'updated' })
    expect(result.todos).toEqual([
      expect.objectContaining({ id: 1, title: 'Validate', status: 'in_progress' })
    ])
  })

  it('derives changes only after the latest user turn', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'old' },
      { kind: 'tool', id: 2, tool: { id: 'a', name: 'write', status: 'done', isError: false, path: 'old.ts', writeContent: 'old' } },
      { kind: 'user', id: 3, text: 'new' },
      { kind: 'tool', id: 4, tool: { id: 'b', name: 'edit', status: 'done', isError: false, path: 'new.ts', diff: '-1 old\n+1 new' } }
    ]

    expect(deriveLatestRunChanges(timeline)).toEqual([
      { path: 'new.ts', kind: 'edit', diff: '-1 old\n+1 new', additions: 1, deletions: 1 }
    ])
  })

  it('replays persisted task snapshots into the current plan', () => {
    const timeline = entriesToTimeline([
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Implement tests' }
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'pion_task', arguments: {} }] }
      },
      {
        type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'toolResult', toolCallId: 't1', toolName: 'pion_task', isError: false,
          content: [{ type: 'text', text: 'ok' }],
          details: { tasks: [{ id: 1, subject: 'Implement tests', status: 'pending' }] }
        }
      }
    ])

    expect(deriveAgentTodos(timeline)).toEqual([
      expect.objectContaining({ title: 'Implement tests', status: 'pending' })
    ])
  })
})
