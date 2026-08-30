import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { SessionMeta } from '../../src/shared/types'

const cwd = '/tmp/project'
const existing: SessionMeta = {
  projectCwd: cwd,
  path: '/tmp/existing.jsonl',
  id: 'existing',
  timestamp: '2026-01-01T00:00:00.000Z',
  mtime: 1,
  preview: 'older session',
  messageCount: 2
}
const optimistic: SessionMeta = {
  projectCwd: cwd,
  path: 'pion:pending:new-session',
  id: 'new-session',
  timestamp: '2026-01-02T00:00:00.000Z',
  mtime: 2,
  preview: 'first prompt',
  messageCount: 1,
  optimistic: true
}

function state(): AgentState {
  return {
    ...initialState,
    status: { phase: 'running', cwd },
    sessions: [existing],
    sessionsByProject: { [cwd]: [existing] }
  }
}

describe('optimistic new session projection', () => {
  it('appears immediately and survives a stale session-list response', () => {
    const projected = reducer(state(), { type: 'optimisticSession', session: optimistic })
    expect(projected.sessions.map((session) => session.id)).toEqual(['existing', 'new-session'])

    const stale = reducer(projected, { type: 'sessions', sessions: [existing] })
    expect(stale.sessions.map((session) => session.id)).toEqual(['existing', 'new-session'])
    expect(stale.sessions[1].optimistic).toBe(true)
  })

  it('reconciles the projection with the persisted JSONL session by id', () => {
    const projected = reducer(state(), { type: 'optimisticSession', session: optimistic })
    const persisted: SessionMeta = {
      ...optimistic,
      path: '/tmp/new-session.jsonl',
      optimistic: undefined,
      messageCount: 2
    }
    const reconciled = reducer(projected, { type: 'sessions', sessions: [existing, persisted] })

    expect(reconciled.sessions.filter((session) => session.id === optimistic.id)).toEqual([persisted])
    expect(reconciled.sessions.map((session) => session.path)).toEqual([
      existing.path,
      persisted.path
    ])
  })

  it('removes an unsaved projection after dispatch failure', () => {
    const projected = reducer(state(), { type: 'optimisticSession', session: optimistic })
    const removed = reducer(projected, {
      type: 'removeOptimisticSession',
      cwd,
      id: optimistic.id
    })
    expect(removed.sessions).toEqual([existing])
  })
})
