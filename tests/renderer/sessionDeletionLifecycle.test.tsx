// @vitest-environment jsdom
import { useReducer } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeleteSessionResult, PionApi, SessionEntriesPage } from '../../src/shared/types'
import { initialState, type Action } from '../../src/renderer/src/agent/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { useAgentSessionActions } from '../../src/renderer/src/hooks/agent/useAgentSessionActions'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const A = '/project/a.jsonl', B = '/project/b.jsonl', replacement = '/project/replacement.jsonl'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function page(path: string): SessionEntriesPage {
  return { entries: [{ type: 'message', id: path, parentId: null, timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: path }] } }],
  toolResults: [], start: 0, end: 1, total: 1, leafId: path, mode: 'build' }
}
function setup() {
  const deletion = deferred<DeleteSessionResult>()
  const api = {
    deleteSession: vi.fn(() => deletion.promise),
    getEntriesPage: vi.fn(async (_before?: number, _limit?: number, path?: string) => page(path ?? replacement)),
    getState: vi.fn(async () => ({ sessionFile: replacement })),
    listSessions: vi.fn(async () => [])
  } as unknown as PionApi
  const clear = vi.fn()
  const dispatched: Action[] = []
  const hook = renderHook(({ api: currentApi }) => {
    const [state, dispatch] = useReducer(reducer, initialState)
    const history = useAgentHistory({ api: currentApi, state, dispatch })
    const sessions = useAgentSessionActions({ api: currentApi,
      dispatch: (action) => { dispatched.push(action); dispatch(action) },
      timelineCache: history.timelineCache, timelineOwnerPath: history.timelineOwnerPath,
      historyCursor: history.historyCursor,
      clearTimeline: (path) => { clear(path); history.clearTimeline(path) },
      reloadTimeline: history.reloadTimeline,
      reloadTimelineAfterDelete: () => history.reloadTimeline(undefined, false, true),
      captureSelection: () => {
        const selected = { ...history.selectionRef.current }
        return () => history.selectionRef.current.generation === selected.generation
          && history.selectionRef.current.ownerPath === selected.ownerPath
          && history.selectionRef.current.cwd === selected.cwd
      }
    })
    return { state, history, sessions,
      deleteSession: (path: string) => {
        if (history.timelineOwnerPath.current === path) history.invalidateSelection()
        return sessions.deleteSession(path)
      },
      select: async (path: string) => {
        history.invalidateSelection()
        history.timelineOwnerPath.current = path
        history.clearTimeline(path)
        await history.reloadTimeline(path)
      }
    }
  }, { initialProps: { api } })
  return { ...hook, api, deletion, clear, dispatched }
}

it('keeps history/cache through a deferred deletion failure', async () => {
  const h = setup()
  await act(async () => { await h.result.current.select(A) })
  const cached = h.result.current.history.timelineCache.current.get(A)
  const timeline = h.result.current.state.timeline
  let pending!: Promise<void>
  act(() => { pending = h.result.current.deleteSession(A) })
  const failed = expect(pending).rejects.toThrow('archive failed')
  expect(h.result.current.history.timelineCache.current.get(A)).toBe(cached)
  expect(h.result.current.history.timelineOwnerPath.current).toBe(A)
  await act(async () => { h.deletion.reject(new Error('archive failed')); await failed })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.history.timelineCache.current.get(A)).toBe(cached)
  expect(h.clear).not.toHaveBeenCalled()
  expect(h.api.getState).not.toHaveBeenCalled()
})

it.each([false, true])('isolates an old active deletion after A → B%s', async (backToA) => {
  const h = setup()
  await act(async () => { await h.result.current.select(A) })
  let pending!: Promise<void>
  act(() => { pending = h.result.current.deleteSession(A) })
  await act(async () => { await h.result.current.select(B) })
  if (backToA) await act(async () => { await h.result.current.select(A) })
  const timeline = h.result.current.state.timeline
  const cursor = h.result.current.history.historyCursor.current
  await act(async () => { h.deletion.resolve({ activeSessionChanged: true }); await pending })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.history.timelineOwnerPath.current).toBe(backToA ? A : B)
  expect(h.result.current.history.historyCursor.current).toBe(cursor)
  expect(h.result.current.history.timelineCache.current.has(A)).toBe(false)
  expect(h.clear).not.toHaveBeenCalled()
  expect(h.api.getState).not.toHaveBeenCalled()
})

it('restores the replacement for the original active selection and awaits its page', async () => {
  const h = setup()
  await act(async () => { await h.result.current.select(A) })
  const restored = deferred<SessionEntriesPage>()
  vi.mocked(h.api.getEntriesPage).mockReturnValueOnce(restored.promise)
  let pending!: Promise<void>, settled = false
  act(() => { pending = h.result.current.deleteSession(A).then(() => { settled = true }) })
  await act(async () => { h.deletion.resolve({ activeSessionChanged: true }) })
  expect(h.clear).toHaveBeenCalledTimes(1)
  expect(h.result.current.history.timelineCache.current.has(A)).toBe(false)
  expect(h.api.getEntriesPage).toHaveBeenLastCalledWith(undefined, expect.any(Number), replacement)
  expect(settled).toBe(false)
  await act(async () => { restored.resolve(page(replacement)); await pending })
  expect(settled).toBe(true)
  expect(h.result.current.history.timelineOwnerPath.current).toBe(replacement)
  expect(h.result.current.state.timeline[0]).toMatchObject({ text: replacement })
})

it('keeps the deletion read slot after the UI deadline until the actual page settles', async () => {
  const h = setup()
  await act(async () => { await h.result.current.select(A) })
  vi.useFakeTimers()
  const rawPage = deferred<SessionEntriesPage>()
  vi.mocked(h.api.getEntriesPage).mockReturnValueOnce(rawPage.promise)
  let pending!: Promise<void>, settled = false
  act(() => { pending = h.result.current.deleteSession(A).then(() => { settled = true }) })
  await act(async () => { h.deletion.resolve({ activeSessionChanged: true }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
  expect(settled).toBe(false)
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toBeTruthy()
  await act(async () => { rawPage.resolve(page(replacement)); await pending })
  expect(settled).toBe(true)
  expect(h.result.current.state.timelineError).toBeTruthy()
  expect(h.result.current.state.timeline).toEqual([])
})

it('retires deletion and directory receipts across API A → B → A', async () => {
  const h = setup()
  await act(async () => { await h.result.current.select(A) })
  const directory = deferred<Awaited<ReturnType<PionApi['listSessions']>>>()
  vi.mocked(h.api.listSessions).mockReturnValueOnce(directory.promise)
  let pending!: Promise<void>, refresh!: Promise<void>
  act(() => {
    pending = h.result.current.deleteSession(A)
    refresh = h.result.current.sessions.refreshProjectSessions('/project')
  })
  h.rerender({ api: { ...h.api } })
  h.rerender({ api: h.api })
  const cached = h.result.current.history.timelineCache.current.get(A)
  const timeline = h.result.current.state.timeline
  await act(async () => {
    h.deletion.resolve({ activeSessionChanged: true })
    directory.resolve([])
    await Promise.all([pending, refresh])
  })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.history.timelineCache.current.get(A)).toBe(cached)
  expect(h.dispatched.some((action) => action.type === 'projectSessionsUpdate')).toBe(false)
  expect(h.clear).not.toHaveBeenCalled()
  expect(h.api.getState).not.toHaveBeenCalled()
})
