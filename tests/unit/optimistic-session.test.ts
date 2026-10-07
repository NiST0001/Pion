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
  it('keeps retained branch caches when duplicate worktree project rows are grouped', () => {
    const branchCwd = '/tmp/elsewhere/feature'
    const branchSession = { ...existing, id: 'branch', path: '/tmp/branch.jsonl', projectCwd: branchCwd }
    const orphanCwd = '/tmp/removed-project'
    const before = {
      ...state(),
      sessionsByProject: { [cwd]: [existing], [branchCwd]: [branchSession], [orphanCwd]: [existing] },
      branchesByProject: {
        [cwd]: [{ cwd, name: 'main', isMain: true }, { cwd: branchCwd, name: 'feature', isMain: false }],
        [branchCwd]: [{ cwd: branchCwd, name: 'feature', isMain: false }]
      }
    }
    const grouped = reducer(before, { type: 'projects', projects: [{ cwd, name: 'Project', addedAt: 1, lastUsedAt: 1 }] })
    expect(grouped.sessionsByProject[branchCwd]).toEqual([branchSession])
    expect(grouped.sessionsByProject[orphanCwd]).toBeUndefined()
    expect(grouped.branchesByProject[branchCwd]).toBeUndefined()
    expect(grouped.branchesByProject[cwd]).toEqual(before.branchesByProject[cwd])
  })
  it('selects the worktree list immediately on cwd changes without reusing root sessions', () => {
    const worktreeCwd = '/tmp/project-feature'
    const worktree = { ...existing, projectCwd: worktreeCwd, id: 'feature', path: '/tmp/feature.jsonl' }
    const before = { ...state(), sessionsByProject: { [cwd]: [existing], [worktreeCwd]: [worktree] } }
    const selected = reducer(before, { type: 'status', status: { phase: 'ready', cwd: worktreeCwd } })
    expect(selected.sessions).toEqual([worktree])
    expect(selected.sessionsByProject[cwd]).toEqual([existing])
    const background = reducer(selected, { type: 'projectSessionsUpdate', cwd, sessions: [existing, optimistic] })
    expect(background.sessions).toEqual([worktree])
    const returned = reducer(background, { type: 'status', status: { phase: 'starting', cwd } })
    expect(returned.sessions).toEqual([existing, optimistic])
  })

  it('does not carry the previous cwd list into an unloaded worktree', () => {
    const selected = reducer(state(), { type: 'status', status: { phase: 'ready', cwd: '/tmp/project-feature' } })
    expect(selected.sessions).toEqual([])
    expect(selected.sessionsByProject[cwd]).toEqual([existing])
  })

  it('projects a bulk list refresh onto only the active worktree', () => {
    const worktreeCwd = '/tmp/project-feature'
    const worktree = { ...existing, projectCwd: worktreeCwd, id: 'feature', path: '/tmp/feature.jsonl' }
    const selected = reducer(state(), { type: 'status', status: { phase: 'ready', cwd: worktreeCwd } })
    const refreshed = reducer(selected, {
      type: 'projectSessions',
      sessionsByProject: { [cwd]: [existing, optimistic], [worktreeCwd]: [worktree] }
    })
    expect(refreshed.sessions).toEqual([worktree])
    expect(refreshed.sessionsByProject[cwd]).toEqual([existing, optimistic])
  })
  it('publishes a background project session without replacing the active project list', () => {
    const background = { ...existing, projectCwd: '/tmp/other-project', id: 'background', path: '/tmp/background.jsonl' }
    const updated = reducer(state(), { type: 'sessions', sessions: [background] })
    expect(updated.sessions).toEqual([existing])
    expect(updated.sessionsByProject[background.projectCwd]).toEqual([background])
  })

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
