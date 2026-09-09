// @vitest-environment jsdom
import { useReducer } from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { useAgentSessionActions } from '../../src/renderer/src/hooks/agent/useAgentSessionActions'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { TaskPanel } from '../../src/renderer/src/features/session/TaskPanel'
import { initialState } from '../../src/renderer/src/agent/types'
import type { PionApi, SessionEntriesPage, SessionTask } from '../../src/shared/types'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)
const path = '/project/session.jsonl'
const tasks: SessionTask[] = [{ id: 1, title: '仍在执行的任务', status: 'in_progress' }]
const page = (snapshot = tasks): SessionEntriesPage => ({
  entries: [{ type: 'message', id: 'tail', parentId: 'previous', timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: '很长的后续输出' }] } }],
  toolResults: [], taskSnapshot: snapshot, start: 99, end: 100, total: 100, leafId: 'tail', mode: 'build'
})
function setup(getEntriesPage = vi.fn().mockResolvedValue(page()), extra: Partial<PionApi> = {}) {
  const api = { getEntriesPage, ...extra } as unknown as PionApi
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, initialState)
    const history = useAgentHistory({ api, state, dispatch })
    const sessions = useAgentSessionActions({ api, dispatch,
      timelineCache: history.timelineCache, timelineOwnerPath: history.timelineOwnerPath,
      historyCursor: history.historyCursor, reloadTimeline: history.reloadTimeline })
    return { state, dispatch, history, sessions }
  })
  return { ...hook, getEntriesPage }
}

it('hydrates tasks outside the newest history window and retains them in the separate cache', async () => {
  const h = setup()
  await act(async () => { await h.result.current.history.reloadTimeline(path) })
  expect(h.result.current.state.timeline.every((item) => item.kind === 'assistant')).toBe(true)
  expect(h.result.current.state.tasks).toEqual(tasks)
  expect(h.result.current.history.timelineCache.current.get(path)?.tasks).toEqual(tasks)
})

it('does not lose the panel projection when jumping to a task-free history window', async () => {
  const h = setup()
  await act(async () => { await h.result.current.history.reloadTimeline(path) })
  const panel = render(<TaskPanel sessionKey={path} agentTodos={h.result.current.state.tasks} />)
  const header = screen.getByRole('button', { name: '展开本轮任务' })
  const landmark = { entryId: 'tail', entryIndex: 20, ordinal: 1, snippet: '历史消息', timestamp: '' }
  act(() => h.result.current.dispatch({ type: 'historyIndex', index: { sessionPath: path, totalEntries: 100, landmarks: [landmark] } }))
  await act(async () => { await h.result.current.history.jumpToHistoryLandmark(landmark) })
  panel.rerender(<TaskPanel sessionKey={path} agentTodos={h.result.current.state.tasks} />)
  expect(screen.getByRole('button', { name: '展开本轮任务' })).toBe(header)
  expect(h.result.current.state.tasks).toEqual(tasks)
  expect(h.result.current.history.timelineCache.current.get(path)?.tasks).toEqual(tasks)
})

it('does not let a history reply rewind a live clear received while loading', async () => {
  let resolve!: (value: SessionEntriesPage) => void
  const h = setup(vi.fn().mockImplementation(() => new Promise<SessionEntriesPage>((done) => { resolve = done })))
  let pending!: Promise<void>
  act(() => { pending = h.result.current.history.reloadTimeline(path) })
  act(() => h.result.current.dispatch({ type: 'event', event: {
    type: 'tool_execution_end', toolCallId: 'not-in-page', toolName: 'pion_task', isError: false,
    result: { details: { tasks: [] } }
  } }))
  await act(async () => { resolve(page()); await pending })
  expect(h.result.current.state.tasks).toEqual([])
  expect(h.result.current.history.timelineCache.current.get(path)?.tasks).toEqual([])
})

it('ignores an old session read after a new selection begins', async () => {
  let resolve!: (value: SessionEntriesPage) => void
  const get = vi.fn().mockImplementationOnce(() => new Promise<SessionEntriesPage>((done) => { resolve = done }))
    .mockResolvedValue(page([]))
  const h = setup(get)
  let old!: Promise<void>
  act(() => { old = h.result.current.history.reloadTimeline(path) })
  act(() => h.result.current.dispatch({ type: 'clearTimeline' }))
  await act(async () => { await h.result.current.history.reloadTimeline('/other/session.jsonl') })
  await act(async () => { resolve(page()); await old })
  expect(h.result.current.state.tasks).toEqual([])
  expect(h.result.current.history.timelineOwnerPath.current).toBe('/other/session.jsonl')
})

it.each(['copy', 'fork', 'delete'] as const)('resets the task scope when %s changes the active session', async (operation) => {
  const h = setup(vi.fn().mockResolvedValue(page()), {
    copySession: vi.fn().mockResolvedValue({ cancelled: false }),
    forkSession: vi.fn().mockResolvedValue({ cancelled: false, text: '原消息' }),
    deleteSession: vi.fn().mockResolvedValue({ activeSessionChanged: true }),
    getState: vi.fn().mockResolvedValue({ sessionId: 'other', sessionFile: '/other/session.jsonl', isStreaming: false, messageCount: 0 })
  })
  await act(async () => { await h.result.current.history.reloadTimeline(path) })
  h.getEntriesPage.mockResolvedValue(page([]))
  await act(async () => {
    if (operation === 'copy') await h.result.current.sessions.copySession(path)
    else if (operation === 'fork') await h.result.current.sessions.forkSession(path, 'user')
    else await h.result.current.sessions.deleteSession(path)
  })
  expect(h.result.current.state.tasks).toEqual([])
  expect(h.result.current.history.timelineOwnerPath.current).toBe('/other/session.jsonl')
})

it('does not clear the task panel when copying a session is cancelled', async () => {
  const h = setup(vi.fn().mockResolvedValue(page()), { copySession: vi.fn().mockResolvedValue({ cancelled: true }) })
  await act(async () => { await h.result.current.history.reloadTimeline(path) })
  await act(async () => { await h.result.current.sessions.copySession(path) })
  expect(h.result.current.state.tasks).toEqual(tasks)
  expect(h.getEntriesPage).toHaveBeenCalledTimes(1)
})

it('hydrates tasks even when the rendered history cache needs no replacement', async () => {
  const h = setup()
  await act(async () => { await h.result.current.history.reloadTimeline(path) })
  const timeline = h.result.current.state.timeline
  h.getEntriesPage.mockResolvedValue(page([]))
  await act(async () => { await h.result.current.history.reloadTimeline(path) })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.state.tasks).toEqual([])
})
