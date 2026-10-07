import { describe, expect, it } from 'vitest'
import {
  deriveSessionTaskRuns,
  hasIncompleteTasks,
  isTaskToolName,
  normalizeSessionTasks,
  taskHistorySnapshotFromEntry,
  taskHistorySnapshotFromResult,
  taskSnapshotFromEntry
} from '../../src/shared/task-history'

const PLAN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PLAN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const task = (status: 'pending' | 'in_progress' | 'completed', title = 'Goal', id = 1) => ({ id, title, status })

describe('task history normalization', () => {
  it('validates custom snapshots with the result validator, without interpreting unrelated entries as clear', () => {
    const entry = { type: 'custom', customType: 'pion-task-state', data: {
      native: 'pion', action: 'create', nextId: 2, tasks: [{ id: 1, subject: 'Native', status: 'pending' }]
    } }
    expect(taskSnapshotFromEntry(entry)).toEqual([{ id: 1, title: 'Native', status: 'pending' }])
    expect(taskSnapshotFromEntry({ ...entry, data: { native: 'pion', tasks: [], nextId: 1 } })).toEqual([])
    for (const invalid of [
      {}, { ...entry, customType: 'other' }, { ...entry, data: { native: 'other', tasks: [] } },
      { ...entry, data: { ...entry.data, nextId: 1 } },
      { ...entry, data: { ...entry.data, tasks: [{ id: 1, subject: 'Bad', status: 'unknown' }] } },
      { ...entry, data: { ...entry.data, tasks: null } }
    ]) expect(taskSnapshotFromEntry(invalid)).toBeUndefined()
  })

  it('accepts native and legacy task snapshots', () => {
    expect(isTaskToolName('pion_task')).toBe(true)
    expect(isTaskToolName('todo')).toBe(true)
    expect(normalizeSessionTasks([
      { id: 1, subject: 'Inspect project', status: 'in_progress', activeForm: 'inspecting project' },
      { id: 'legacy', subject: 'Write tests', status: 'completed' }
    ])).toEqual([
      { id: 1, title: 'Inspect project', status: 'in_progress', activeForm: 'inspecting project' },
      { id: 'legacy', title: 'Write tests', status: 'completed' }
    ])
  })

  it('scopes snapshots to the user message that changed them', () => {
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', prompt: 'First change' },
      { kind: 'snapshot', tasks: [{ id: 1, title: 'First', status: 'pending' }] },
      { kind: 'snapshot', tasks: [{ id: 1, title: 'First', status: 'completed' }] },
      { kind: 'user', key: 'u2', prompt: 'Second change' },
      { kind: 'snapshot', tasks: [
        { id: 1, title: 'First', status: 'completed' },
        { id: 2, title: 'Second', status: 'in_progress' }
      ] }
    ])

    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ key: 'u1', prompt: 'First change' })
    expect(runs[0].tasks).toEqual([{ id: 1, title: 'First', status: 'completed' }])
    expect(runs[1].tasks).toEqual([{ id: 2, title: 'Second', status: 'in_progress' }])
  })

  it('treats an empty snapshot as a new id generation', () => {
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', prompt: 'Reset plan' },
      { kind: 'snapshot', tasks: [{ id: 1, title: 'Old', status: 'completed' }] },
      { kind: 'snapshot', tasks: [] },
      { kind: 'snapshot', tasks: [{ id: 1, title: 'New', status: 'pending' }] }
    ])

    expect(runs[0].tasks).toEqual([
      { id: 1, title: 'Old', status: 'completed' },
      { id: 1, title: 'New', status: 'pending' }
    ])
  })
})

describe('task lifecycle projection', () => {
  it('keeps incomplete and unknown states visible without trusting completed metadata', () => {
    for (const tasks of [undefined, null, [], [{ status: 'deleted' }], [{ status: 'completed' }, { status: 'deleted' }]]) {
      expect(hasIncompleteTasks(tasks)).toBe(false)
    }
    for (const tasks of [[{}], [{ status: 'unknown' }], [{ status: 'pending' }], [{ status: 'in_progress' }],
      [{ status: 'completed' }, { status: 'pending' }]]) expect(hasIncompleteTasks(tasks)).toBe(true)
    const snapshot = taskHistorySnapshotFromResult('pion_task', { details: {
      planId: PLAN_A, completed: true, tasks: [{ id: 1, subject: 'Waiting for authorization', status: 'pending' }]
    } })!
    expect(hasIncompleteTasks(snapshot.tasks)).toBe(true)
    const completed = taskHistorySnapshotFromResult('pion_task', { details: {
      planId: PLAN_A, completed: false, tasks: [{ id: 1, subject: 'Done', status: 'completed' }]
    } })!
    expect(hasIncompleteTasks(completed.tasks)).toBe(false)
  })

  it('validates optional identity metadata while preserving the renderer array contract', () => {
    const details = { native: 'pion', planId: PLAN_A, planStart: true, completed: false,
      nextId: 2, tasks: [{ id: 1, subject: 'Goal', status: 'pending' }] }
    const entry = { type: 'custom', customType: 'pion-task-state', data: details }
    const expected = { tasks: [task('pending')], planId: PLAN_A, planStart: true }
    expect(taskHistorySnapshotFromEntry(entry)).toEqual(expected)
    expect(taskHistorySnapshotFromResult('pion_task', { details })).toEqual(expected)
    expect(taskSnapshotFromEntry(entry)).toEqual([task('pending')])
    expect(taskHistorySnapshotFromResult('todo', { details })).toEqual({ tasks: [task('pending')] })
    expect(taskHistorySnapshotFromResult('pion_task', { details, isError: true })).toBeUndefined()
    expect(taskHistorySnapshotFromResult('other', { details })).toBeUndefined()
    for (const invalid of [{ planId: 'not-a-uuid' }, { planId: 'a'.repeat(100000) }, { planStart: 'true' }, { completed: 1 }]) {
      expect(taskHistorySnapshotFromEntry({ ...entry, data: { ...details, ...invalid } })).toEqual({ tasks: [task('pending')] })
    }
    expect(taskHistorySnapshotFromEntry({ ...entry, data: { native: 'pion', tasks: [], completed: false } })).toEqual({ tasks: [] })
    expect(taskHistorySnapshotFromResult('pion_task', { details: { ...details, planStart: false } })).toEqual({ tasks: [task('pending')], planId: PLAN_A })
    expect(taskHistorySnapshotFromResult('pion_task', { details: { tasks: details.tasks } })).toEqual({ tasks: [task('pending')] })
  })

  it('bounds task metadata without interpreting oversized snapshots as clear', () => {
    expect(normalizeSessionTasks(Array.from({ length: 4097 }, () => ({ id: 1, subject: 'Goal' })))).toBeUndefined()
    expect(normalizeSessionTasks(Array.from({ length: 65 }, (_, id) => ({ id, subject: 'a'.repeat(65536) })))).toBeUndefined()
    expect(normalizeSessionTasks(Array.from({ length: 17 }, (_, id) => ({ id, subject: 'Goal', blockedBy: Array(4096).fill(1) })))).toBeUndefined()
    for (const fields of [{ subject: 'a'.repeat(65537) }, { description: 'a'.repeat(65537) },
      { activeForm: 'a'.repeat(65537) }, { id: 'a'.repeat(513) }, { blockedBy: Array(4097).fill(1) }]) {
      expect(normalizeSessionTasks([{ id: 1, subject: 'Goal', ...fields }])).toBeUndefined()
    }
  })

  it('aggregates same-goal follow-ups and authorization waits under the original user anchor', () => {
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', entryId: 'u1', prompt: 'Original goal', timestamp: 'first' },
      { kind: 'snapshot', planId: PLAN_A, planStart: true, tasks: [task('in_progress'), task('pending', 'Authorization', 2)] },
      { kind: 'user', key: 'u2', prompt: 'An unrelated question' },
      { kind: 'user', key: 'u3', prompt: 'Continue' },
      { kind: 'snapshot', planId: PLAN_A, tasks: [task('completed'), task('pending', 'Authorization', 2)] }
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ entryId: 'u1', ordinal: 1, prompt: 'Original goal', timestamp: 'first' })
    expect(runs[0].tasks).toEqual([task('completed'), task('pending', 'Authorization', 2)])
    expect(hasIncompleteTasks(runs[0].tasks)).toBe(true)
  })

  it('reopens a completed plan in place rather than duplicating or hiding its archive', () => {
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', entryId: 'u1', prompt: 'Goal' },
      { kind: 'snapshot', planId: PLAN_A, planStart: true, tasks: [task('pending')] },
      { kind: 'snapshot', planId: PLAN_A, tasks: [task('completed')] },
      { kind: 'user', key: 'u2', prompt: 'Correct the same goal' },
      { kind: 'snapshot', planId: PLAN_A, tasks: [task('in_progress')] }
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ entryId: 'u1', tasks: [task('in_progress')] })
  })

  it('separates two goals and reused numeric ids in the same user message, including mirrored starts', () => {
    const first = { kind: 'snapshot' as const, planId: PLAN_A, planStart: true, tasks: [task('completed', 'First')] }
    const second = { kind: 'snapshot' as const, planId: PLAN_B, planStart: true, tasks: [task('pending', 'Second')] }
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', entryId: 'u1', prompt: 'Two goals' },
      first, first, { kind: 'snapshot', tasks: [] }, second, second,
      // A metadata-less older tool mirror must not manufacture a third goal.
      { kind: 'snapshot', tasks: second.tasks }
    ])
    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.tasks)).toEqual([[task('completed', 'First')], [task('pending', 'Second')]])
    expect(new Set(runs.map((run) => run.key)).size).toBe(2)
    expect(runs.every((run) => run.entryId === 'u1' && run.ordinal === 1)).toBe(true)
  })

  it('starts a new goal after completion without requiring clear or merging reused task ids', () => {
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', entryId: 'u1', prompt: 'First goal' },
      { kind: 'snapshot', planId: PLAN_A, planStart: true, tasks: [task('completed', 'First')] },
      { kind: 'user', key: 'u2', entryId: 'u2', prompt: 'Second goal' },
      { kind: 'snapshot', planId: PLAN_B, planStart: true, tasks: [task('pending', 'Second')] },
      { kind: 'snapshot', planId: PLAN_B, tasks: [task('completed', 'Second')] }
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ entryId: 'u1', tasks: [task('completed', 'First')] })
    expect(runs[1]).toMatchObject({ entryId: 'u2', tasks: [task('completed', 'Second')] })
  })

  it('archives an incomplete old goal on explicit replacement and preserves completed rows through clear', () => {
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', entryId: 'u1', prompt: 'First goal' },
      { kind: 'snapshot', planId: PLAN_A, planStart: true, tasks: [task('completed'), task('pending', 'Waiting', 2)] },
      { kind: 'snapshot', tasks: [] },
      { kind: 'user', key: 'u2', entryId: 'u2', prompt: 'New goal' },
      { kind: 'snapshot', planId: PLAN_B, planStart: true, tasks: [task('completed', 'New')] },
      { kind: 'snapshot', tasks: [] },
      { kind: 'user', key: 'u3', prompt: 'Question without tasks' }
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ entryId: 'u1', ordinal: 1, tasks: [task('completed'), task('pending', 'Waiting', 2)] })
    expect(runs[1]).toMatchObject({ entryId: 'u2', ordinal: 2, tasks: [task('completed', 'New')] })
  })

  it('projects only the supplied readonly branch and never invents an invisible goal anchor', () => {
    const raw = Object.freeze({ native: 'pion', planId: PLAN_A, tasks: Object.freeze([
      Object.freeze({ id: 1, subject: 'Invisible goal', status: 'pending' })
    ]) })
    const snapshot = taskHistorySnapshotFromEntry(Object.freeze({ type: 'custom', customType: 'pion-task-state', data: raw }))!
    const events = Object.freeze([
      { kind: 'snapshot' as const, ...snapshot },
      { kind: 'user' as const, key: 'u1', prompt: 'Question' },
      { kind: 'snapshot' as const, planId: PLAN_A, tasks: [task('completed', 'Invisible goal')] },
      { kind: 'user' as const, key: 'u2', entryId: 'u2', prompt: 'Visible goal' },
      { kind: 'snapshot' as const, planId: PLAN_B, planStart: true, tasks: [task('pending', 'Visible goal')] }
    ])
    expect(deriveSessionTaskRuns(events)).toEqual([expect.objectContaining({ entryId: 'u2', ordinal: 2, tasks: [task('pending', 'Visible goal')] })])
    expect(raw.tasks[0].status).toBe('pending')
    expect(deriveSessionTaskRuns(events.slice(0, 1))).toEqual([])
  })

  it('leaves legacy snapshots without invented identities and deduplicates dual snapshot sources', () => {
    const raw = { native: 'pion', tasks: [{ id: 1, subject: 'Goal', status: 'pending' }] }
    const custom = taskHistorySnapshotFromEntry({ type: 'custom', customType: 'pion-task-state', data: raw })!
    const tool = taskHistorySnapshotFromResult('todo', { details: raw })!
    expect(custom.planId).toBeUndefined()
    const runs = deriveSessionTaskRuns([
      { kind: 'user', key: 'u1', prompt: 'Legacy' },
      { kind: 'snapshot', ...custom }, { kind: 'snapshot', ...tool },
      { kind: 'user', key: 'u2', prompt: 'Continue legacy' },
      { kind: 'snapshot', tasks: [task('completed')] }
    ])
    expect(runs.map((run) => run.key)).toEqual(['u1', 'u2'])
    expect(runs.map((run) => run.tasks)).toEqual([[task('pending')], [task('completed')]])
  })
})
