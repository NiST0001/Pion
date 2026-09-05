// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  applyToolResult,
  deriveAgentTodos,
  deriveLatestRunChanges,
  diffStats,
  entriesToTimeline,
  getViewportHistoryPageSize,
  uniqueTimelineItems
} from '../../src/renderer/src/agent/timeline'
import type { TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'

describe('timeline derivation', () => {
  it('scales the initial history window to the available viewport', () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 })
    expect(getViewportHistoryPageSize()).toBe(8)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1_600 })
    expect(getViewportHistoryPageSize()).toBe(19)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 2_400 })
    expect(getViewportHistoryPageSize()).toBe(24)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('deduplicates paged items against live transcript entries', () => {
    const existing = [
      { kind: 'user' as const, id: 1, entryId: 'entry-1', text: '已有' },
      { kind: 'tool' as const, id: 2, tool: { id: 'tool-1', name: 'read', status: 'done' as const, isError: false } }
    ]
    const incoming = [
      { kind: 'user' as const, id: 3, entryId: 'entry-1', text: '重复' },
      { kind: 'assistant' as const, id: 4, entryId: 'entry-2', text: '新增', thinking: '', streaming: false }
    ]

    expect(uniqueTimelineItems(existing, incoming)).toEqual([incoming[1]])
  })

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

  it('retains every captured edit for the same file in the current turn', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'update twice' },
      { kind: 'tool', id: 2, tool: { id: 'a', name: 'edit', status: 'done', isError: false, path: 'src/a.ts', diff: '-1 old\n+1 middle' } },
      { kind: 'tool', id: 3, tool: { id: 'b', name: 'edit', status: 'done', isError: false, path: 'src/a.ts', diff: '-3 before\n+3 after' } }
    ]

    expect(deriveLatestRunChanges(timeline)).toEqual([
      {
        path: 'src/a.ts',
        kind: 'edit',
        diff: '-1 old\n+1 middle\n  ...\n-3 before\n+3 after',
        additions: 2,
        deletions: 2
      }
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

  it('keeps a completed plan until the next turn starts planning', () => {
    const completedPlan: TimelineItem[] = [
      { kind: 'user', id: 1, entryId: 'u1', text: 'First turn' },
      {
        kind: 'tool',
        id: 2,
        tool: {
          id: 'tasks-1',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: [{ id: 1, title: 'Finish first turn', status: 'completed' }]
        }
      },
      { kind: 'user', id: 3, entryId: 'u2', text: 'Second turn' }
    ]

    expect(deriveAgentTodos(completedPlan)).toEqual([
      { id: 1, title: 'Finish first turn', status: 'completed' }
    ])

    const clearedPlan: TimelineItem[] = [
      ...completedPlan,
      {
        kind: 'tool',
        id: 4,
        tool: {
          id: 'tasks-2',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: []
        }
      }
    ]
    expect(deriveAgentTodos(clearedPlan)).toBeNull()

    expect(deriveAgentTodos([
      ...clearedPlan,
      {
        kind: 'tool',
        id: 5,
        tool: {
          id: 'tasks-3',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: [{ id: 1, title: 'Start second turn', status: 'pending' }]
        }
      }
    ])).toEqual([{ id: 1, title: 'Start second turn', status: 'pending' }])
  })

  it('produces stable ids across rebuilds of the same entries', () => {
    const entries = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: '问题' }] }
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }
          ]
        }
      }
    ] as never[]
    const first = entriesToTimeline(entries).map((item) => item.id)
    const second = entriesToTimeline(entries).map((item) => item.id)
    expect(second).toEqual(first)
    expect(new Set(first).size).toBe(first.length)
  })
})
