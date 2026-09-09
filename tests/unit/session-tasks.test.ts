import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { sessionTasks } from '../../src/main/agent/wire'
import { taskSnapshotFromResult } from '../../src/shared/task-history'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState } from '../../src/renderer/src/agent/types'
import { storeTimelineCache } from '../../src/renderer/src/agent/timeline'
import type { TimelineCacheEntry } from '../../src/renderer/src/agent/timeline'
import type { SessionTask, WireEventInput } from '../../src/shared/types'

const raw = [{ id: 1, subject: '检查任务状态', status: 'in_progress' }]
const tasks: SessionTask[] = [{ id: 1, title: '检查任务状态', status: 'in_progress', activeForm: undefined, description: undefined }]
const result = { content: [], details: { tasks: raw } }
let nextCall = 0
const event = (value: unknown = result): WireEventInput => ({
  type: 'tool_execution_end', toolCallId: `missing-start-${++nextCall}`, toolName: 'pion_task', result: value, isError: false
})
const live = () => reducer(initialState, { type: 'event', event: event() })

function entry(id: string, parentId: string | null, message: Record<string, unknown>): SessionEntry {
  return { id, parentId, type: 'message', timestamp: '', message } as unknown as SessionEntry
}

describe('session task projection', () => {
  it('accepts a task result without a mounted user or tool-start row', () => {
    const state = live()
    expect(state.tasks).toEqual(tasks)
    expect(state.timeline).toEqual([])
  })

  it('recovers task snapshots from persisted entries and message_end', () => {
    const message = { role: 'toolResult', toolName: 'pion_task', ...result }
    for (const input of [
      { type: 'message_end', message },
      { type: 'entry_appended', entry: { id: 'persisted', type: 'message', message } }
    ]) {
      expect(reducer(initialState, { type: 'event', event: input }).tasks).toEqual(tasks)
    }
  })

  it('ignores a duplicate persisted result arriving after a newer task operation', () => {
    let state = reducer(initialState, { type: 'event', event: { ...event(), toolCallId: 'old' } })
    state = reducer(state, { type: 'event', event: event({ details: { tasks: [] } }) })
    state = reducer(state, { type: 'event', event: { type: 'message_end',
      message: { role: 'toolResult', toolName: 'pion_task', toolCallId: 'old', ...result } } })
    expect(state.tasks).toEqual([])
  })

  it('keeps tasks through history replacement, pagination, loading failures and settlement', () => {
    let state = live()
    state = reducer(state, { type: 'loadEntries', items: [] })
    state = reducer(state, { type: 'prependEntries', items: [{ kind: 'user', id: 1, text: '更早的消息' }] })
    state = reducer(state, { type: 'appendEntries', items: [{ kind: 'user', id: 2, text: '无新计划的消息' }] })
    state = reducer(state, { type: 'timelineError', error: '读取失败' })
    state = reducer(state, { type: 'event', event: { type: 'agent_settled' } })
    expect(state.tasks).toEqual(tasks)
  })

  it('does not treat malformed or failed results as a clear', () => {
    let state = live()
    for (const value of [{}, { details: { tasks: null } }, { details: { tasks: [{}] } }, { ...result, isError: true }]) {
      state = reducer(state, { type: 'event', event: event(value) })
    }
    state = reducer(state, { type: 'event', event: { ...event({ details: { tasks: [] } }), isError: true } })
    expect(state.tasks).toEqual(tasks)
    expect(taskSnapshotFromResult('bash', result)).toBeUndefined()
    expect(taskSnapshotFromResult('todo', result)).toEqual(tasks)
  })

  it('honors an explicit live clear and never revives it from cache or an async read', () => {
    let state = reducer(live(), { type: 'beginTaskRestore', id: 1 })
    state = reducer(state, { type: 'event', event: event({ details: { tasks: [] } }) })
    state = reducer(state, { type: 'cachedTasks', tasks })
    state = reducer(state, { type: 'restoreTasks', id: 1, tasks })
    expect(state.tasks).toEqual([])
  })

  it('gives live results priority over a previously started disk read', () => {
    let state = reducer(initialState, { type: 'beginTaskRestore', id: 1 })
    state = reducer(state, { type: 'event', event: event() })
    state = reducer(state, { type: 'restoreTasks', id: 1, tasks: [] })
    expect(state.tasks).toEqual(tasks)
  })

  it('invalidates old requests on session reset and permits the new session snapshot', () => {
    let state = reducer(live(), { type: 'beginTaskRestore', id: 1 })
    state = reducer(state, { type: 'clearTimeline' })
    state = reducer(state, { type: 'beginTaskRestore', id: 2 })
    state = reducer(state, { type: 'restoreTasks', id: 1, tasks })
    expect(state.tasks).toBeNull()
    state = reducer(state, { type: 'restoreTasks', id: 2, tasks: [] })
    expect(state.tasks).toEqual([])
  })
})

it('reads tasks from the selected ancestry, including before a compaction/window boundary', () => {
  const entries = [
    entry('root', null, { role: 'user' }),
    entry('task', 'root', { role: 'toolResult', toolName: 'pion_task', ...result }),
    entry('other', 'root', { role: 'toolResult', toolName: 'pion_task', details: { tasks: [] } }),
    { id: 'compact', parentId: 'task', type: 'compaction', timestamp: '' } as SessionEntry,
    entry('tail', 'compact', { role: 'assistant', content: [] })
  ]
  expect(sessionTasks(entries, 'tail')).toEqual(tasks)
  expect(sessionTasks(entries, 'other')).toEqual([])
  expect(sessionTasks(entries, 'root')).toEqual([])
  expect(sessionTasks(entries, null)).toEqual([])
})

it('skips malformed snapshots without looping on damaged ancestry', () => {
  const entries = [
    entry('task', null, { role: 'toolResult', toolName: 'todo', ...result }),
    entry('bad', 'task', { role: 'toolResult', toolName: 'pion_task', details: { tasks: [{}] } })
  ]
  expect(sessionTasks(entries, 'bad')).toEqual(tasks)
  expect(sessionTasks([entry('cycle', 'cycle', { role: 'assistant' })], 'cycle')).toEqual([])
})

it('preserves independent tasks when pagination updates the timeline cache', () => {
  const cache = new Map<string, TimelineCacheEntry>()
  const page: TimelineCacheEntry = { items: [], mode: 'build', apiBefore: 0, apiAfter: 1,
    toolResults: [], complete: true, newerComplete: true, leafId: 'leaf', total: 1 }
  storeTimelineCache(cache, 'session', { ...page, tasks })
  storeTimelineCache(cache, 'session', { ...page, apiAfter: 2, total: 2 })
  expect(cache.get('session')?.tasks).toEqual(tasks)
  storeTimelineCache(cache, 'session', { ...page, tasks: [] })
  expect(cache.get('session')?.tasks).toEqual([])
})
