// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Dispatch } from 'react'
import type { Action } from '../../src/renderer/src/agent/types'
import type { DeleteSessionResult, PionApi, SessionEntriesPage, SessionInfo } from '../../src/shared/types'

const harness = vi.hoisted(() => ({ dispatch: undefined as Dispatch<Action> | undefined }))
vi.mock('../../src/renderer/src/hooks/agent/useAgentSubscriptions', () => ({
  useAgentSubscriptions: ({ dispatch }: { dispatch: Dispatch<Action> }) => { harness.dispatch = dispatch }
}))
import { useAgent } from '../../src/renderer/src/hooks/useAgent'

const A = '/sessions/a.jsonl', C = '/sessions/replacement.jsonl'
afterEach(() => { cleanup(); delete (window as { pion?: PionApi }).pion; harness.dispatch = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const session = (path: string): SessionInfo => ({ sessionId: path, sessionFile: path }) as SessionInfo
function page(path: string, offset = 0, total = 1): SessionEntriesPage {
  return { entries: [{ type: 'message', id: `${path}:${offset}`, parentId: null, timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: path }] } }], toolResults: [],
    start: offset, end: offset + 1, total, leafId: `${path}:${total}`, mode: 'build' }
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

it('revalidates the new API shell/cursor while an old deletion still holds its actual history read', async () => {
  const deletion = deferred<DeleteSessionResult>(), oldPage = deferred<SessionEntriesPage>()
  let current = session(A)
  const oldApi = {
    deleteSession: vi.fn(() => deletion.promise), getState: vi.fn(async () => current),
    getEntriesPage: vi.fn(async (_before?: number, _limit?: number, path?: string) => page(path ?? C)),
    getAvailableModels: vi.fn(async () => []), getThinkingLevels: vi.fn(async () => ['off']),
    getCommands: vi.fn(async () => []),
    onEvent: vi.fn((_listener: Parameters<PionApi['onEvent']>[0]) => vi.fn(() => {})),
    getHistoryIndex: vi.fn(async (_sessionPath: string) => null)
  }
  window.pion = oldApi as unknown as PionApi
  const view = renderHook(() => useAgent())
  act(() => {
    harness.dispatch?.({ type: 'status', status: { phase: 'running', cwd: '/project' } })
    harness.dispatch?.({ type: 'session', session: current })
  })
  await act(async () => { await view.result.current.actions.reloadTimeline(A) })
  oldApi.getEntriesPage.mockReturnValueOnce(oldPage.promise)
  let pending!: Promise<void>, settled = false
  act(() => { pending = view.result.current.actions.deleteSession(A).then(() => { settled = true }) })
  current = session(C)
  // Real deletion clears the active SDK selection before returning its ACK.
  act(() => {
    harness.dispatch?.({ type: 'status', status: { phase: 'ready', cwd: '/project' } })
    harness.dispatch?.({ type: 'session', session: null })
  })
  await act(async () => { deletion.resolve({ activeSessionChanged: true }) })
  expect(view.result.current.state.timelineLoading).toBe(true)
  expect(oldApi.getEntriesPage).toHaveBeenLastCalledWith(undefined, expect.any(Number), C)
  const nextApi = { ...oldApi, getState: vi.fn(async () => current),
    getEntriesPage: vi.fn(async (before?: number) => before === undefined ? page(C, 1, 3) : page(C, 0, 3)) }
  window.pion = nextApi as unknown as PionApi
  view.rerender()
  await flush()
  expect(settled).toBe(false)
  expect(view.result.current.state.timelineLoading).toBe(false)
  expect(view.result.current.state.timeline[0]).toMatchObject({ text: C })
  await act(async () => { await view.result.current.actions.loadOlder() })
  expect(nextApi.getEntriesPage).toHaveBeenCalledWith(1, expect.any(Number), C)
  const currentTimeline = view.result.current.state.timeline
  await act(async () => { oldPage.resolve(page('old-owner')); await pending })
  expect(settled).toBe(true)
  expect(view.result.current.state.timeline).toBe(currentTimeline)
  expect(view.result.current.state.timelineLoading).toBe(false)
})
