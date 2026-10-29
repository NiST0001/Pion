import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../../src/shared/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type Action, type AgentState } from '../../src/renderer/src/agent/types'

const cwd = '/tmp/project'
const row = (id: string, sidebarRevision?: number, totalTokens?: number): SessionMeta => ({
  id, path: `${cwd}/${id}.jsonl`, projectCwd: cwd, timestamp: '2026-01-01', mtime: 1,
  preview: id, messageCount: 1, sidebarRevision, ...(totalTokens === undefined ? {} : { totalTokens })
})
const empty: AgentState = { ...initialState, status: { phase: 'ready', cwd } }
type Publication = 'push' | 'bootstrap' | 'refresh'
function publish(state: AgentState, sessions: SessionMeta[], mode: Publication, directory = cwd): AgentState {
  const action: Action = mode === 'push' ? { type: 'sessions', sessions }
    : mode === 'bootstrap' ? { type: 'projectSessionsUpdate', cwd: directory, sessions }
      : { type: 'projectSessions', sessionsByProject: { [directory]: sessions } }
  return reducer(state, action)
}

// Reducer-only ordering regressions; no Chromium painting or GPU verification.
describe.each(['push', 'bootstrap', 'refresh'] as const)('progressive sidebar %s publication', (mode) => {
  it.each([0, 23])('does not erase known totals (%s) when the same discovery base arrives late', (total) => {
    let state = publish(empty, [row('a', 1), row('unknown', 1)], mode)
    expect(state.sessions[0].totalTokens).toBeUndefined()
    state = publish(state, [row('a', 1, total), row('unknown', 1)], 'push')
    state = publish(state, [row('a', 1), row('unknown', 1)], mode)
    expect(state.sessions[0].totalTokens).toBe(total)
    expect(state.sessions[1].totalTokens).toBeUndefined()
    expect(state.sessionsByProject[cwd]).toBe(state.sessions)
  })

  it('starts a newer discovery unknown even with identical file metadata, and rejects old rows/totals', () => {
    let state = publish(empty, [row('a', 1, 100), row('deleted', 1, 200)], 'push')
    state = publish(state, [row('a', 2)], mode)
    expect(state.sessions).toEqual([row('a', 2)])
    const latest = state.sessions
    state = publish(state, [row('a', 1, 999), row('deleted', 1, 999)], mode)
    expect(state.sessions).toBe(latest)
    state = publish(state, [row('a', 2, 7)], 'push')
    expect(state.sessions).toEqual([row('a', 2, 7)])
  })

  it('keeps optimistic rows and manual order through a token supplement', () => {
    let state = publish(empty, [row('b', 1), row('a', 1)], 'push')
    state = reducer(state, { type: 'reorderSessions', cwd, paths: [row('b').path, row('a').path] })
    const optimistic = { ...row('pending'), optimistic: true }
    state = reducer(state, { type: 'optimisticSession', session: optimistic })
    state = publish(state, [row('a', 1, 9), row('b', 1, 4)], mode)
    expect(state.sessions.map(({ id }) => id)).toEqual(['b', 'a', 'pending'])
    expect(state.sessions.map(({ totalTokens }) => totalTokens)).toEqual([4, 9, undefined])
    expect(state.sessions[2]).toBe(optimistic)
  })

  it('does not carry totals across a different SDK id at the same path or an unversioned snapshot', () => {
    const original = publish(empty, [row('a', 1, 23)], 'push')
    const replaced = { ...row('a', 1), id: 'different-sdk-session' }
    expect(publish(original, [replaced], mode).sessions).toEqual([replaced])
    expect(publish(original, [row('a')], mode).sessions).toEqual([row('a')])
  })
})

it('compares revisions only within the owning cwd and keeps the selected project untouched', () => {
  const otherCwd = '/tmp/other'
  const selected = publish(empty, [row('selected', 100, 40)], 'push')
  const other = { ...row('other', 2), path: `${otherCwd}/other.jsonl`, projectCwd: otherCwd }
  let state = publish(selected, [other], 'bootstrap', otherCwd)
  expect(state.sessions).toBe(selected.sessions)
  state = publish(state, [{ ...other, totalTokens: 6 }], 'push')
  state = publish(state, [other], 'bootstrap', otherCwd)
  expect(state.sessions).toBe(selected.sessions)
  expect(state.sessionsByProject[otherCwd]).toEqual([{ ...other, totalTokens: 6 }])
  expect(state.sessionsByProject[cwd]).toBe(selected.sessions)
})
