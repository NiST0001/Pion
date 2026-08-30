import { describe, expect, it } from 'vitest'
import {
  deriveSessionTaskRuns,
  isTaskToolName,
  normalizeSessionTasks
} from '../../src/shared/task-history'

describe('task history normalization', () => {
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
