// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useCallback, useReducer } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PionApi, SessionEntriesPage, SessionHistoryIndex } from '../../src/shared/types'
import { initialState, type Action, type AgentState } from '../../src/renderer/src/agent/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'

const index: SessionHistoryIndex = {
  sessionPath: '/a', leafId: 'leaf', totalEntries: 1000,
  landmarks: [{ entryId: 'anchor', entryIndex: 400, ordinal: 1, snippet: 'same text', timestamp: '' }]
}
const selected: AgentState = {
  ...initialState, status: { phase: 'running', cwd: '/project' },
  session: { sessionId: 'a', sessionFile: '/a', isStreaming: false, messageCount: 1000 },
  liveSessionOwnerPath: '/a', liveSessionScopeSelected: true,
  timelineReady: true, historyIndex: index,
  timeline: [{ kind: 'user', id: 1, entryId: 'visible', text: 'current view' }]
}
function page(entryId = 'anchor', start = 300, end = 500): SessionEntriesPage {
  return { entries: [{ type: 'message', id: entryId, parentId: null, timestamp: '',
    message: { role: 'user', content: [{ type: 'text', text: 'same text' }] } }],
  toolResults: [], mode: initialState.mode, start, end, total: 1000, leafId: 'leaf' }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(getEntriesPage: PionApi['getEntriesPage'] = vi.fn(async () => page()), seed = selected) {
  const actions: Action[] = []
  const api = { getEntriesPage, getHistoryIndex: vi.fn(async () => null), onEvent: () => () => undefined } as unknown as PionApi
  const hook = renderHook(({ api }: { api: PionApi }) => {
    const [state, dispatch] = useReducer(reducer, seed)
    const trackedDispatch = useCallback((action: Action) => { actions.push(action); dispatch(action) }, [dispatch])
    return { state, dispatch, history: useAgentHistory({ api, state, dispatch: trackedDispatch }) }
  }, { initialProps: { api } })
  return { ...hook, api, actions, getEntriesPage }
}
function seedMiddle(hook: ReturnType<typeof setup>) {
  const history = hook.result.current.history
  const cached = { cwd: '/project', items: hook.result.current.state.timeline, mode: initialState.mode,
    apiBefore: 300, apiAfter: 500, toolResults: [], complete: false,
    newerComplete: false, leafId: 'leaf', total: 1000 }
  history.timelineCache.current.set('/a', cached)
  history.historyCursor.current = { path: '/a', ...cached, loading: false, loadId: history.timelineLoadId.current }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('restores by the unique real user entry and carries the exact row offset through the existing jump action', async () => {
  const hook = setup()
  const readingToken = {}
  let restored = false
  await act(async () => { restored = await hook.result.current.history.restoreHistoryReadingPosition('anchor', -37.5, undefined, readingToken) })
  expect(restored).toBe(true)
  expect(hook.getEntriesPage).toHaveBeenCalledTimes(1)
  expect(hook.getEntriesPage).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), '/a')
  expect(hook.actions.find((action) => action.type === 'historyJump')).toMatchObject({
    entryId: 'anchor', readingOffset: -37.5, nonce: 1
  })
  expect(hook.actions.find((action) => action.type === 'historyJump')).toHaveProperty('readingToken', readingToken)
  expect(hook.result.current.state.historyJump?.readingToken).toBe(readingToken)
  expect(hook.result.current.state.timeline.some((item) => item.kind === 'user' && item.entryId === 'anchor')).toBe(true)
})

it('leaves the timeline and existing error intact when the saved ID is absent, duplicated, or its index is unknown', async () => {
  for (const historyIndex of [null, { ...index, landmarks: [] }, { ...index, landmarks: [...index.landmarks, ...index.landmarks] }]) {
    const hook = setup(undefined, { ...selected, historyIndex, timelineError: 'existing error' })
    const before = hook.result.current.state.timeline
    await act(async () => { expect(await hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)).toBe(false) })
    expect(hook.getEntriesPage).not.toHaveBeenCalled()
    expect(hook.result.current.state.timeline).toBe(before)
    expect(hook.result.current.state.timelineError).toBe('existing error')
    hook.unmount()
  }
})

it('rejects a page with matching text but a different real ID without replacing the old reading window', async () => {
  const hook = setup(vi.fn(async () => page('different')), { ...selected, timelineError: 'existing error' })
  seedMiddle(hook)
  const before = hook.result.current.state.timeline
  await act(async () => { expect(await hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)).toBe(false) })
  expect(hook.result.current.state.timeline).toBe(before)
  expect(hook.result.current.state.timelineError).toBe('existing error')
  expect(hook.result.current.history.historyCursor.current?.loading).toBe(false)
  expect(hook.actions.some((action) => action.type === 'historyJump')).toBe(false)
})

it('forces the newest page even when a middle-window cache has identical leaf and total metadata', async () => {
  const hook = setup(vi.fn(async () => page('newest', 900, 1000)))
  seedMiddle(hook)
  await act(async () => { expect(await hook.result.current.history.loadLatestHistory()).toBe(true) })
  expect(hook.getEntriesPage).toHaveBeenCalledTimes(1)
  expect(hook.result.current.state.timeline.some((item) => item.kind === 'user' && item.entryId === 'newest')).toBe(true)
  expect(hook.result.current.history.hasNewerHistory()).toBe(false)
  expect(hook.actions.filter((action) => action.type === 'loadEntries')).toHaveLength(1)
})

it('reports failed newest reads as false while retaining the current window and a retryable pagination cursor', async () => {
  vi.useFakeTimers()
  const hook = setup(vi.fn(async () => { throw new Error('offline') }))
  seedMiddle(hook)
  const before = hook.result.current.state.timeline
  let result!: Promise<boolean>
  act(() => { result = hook.result.current.history.loadLatestHistory() })
  await act(async () => { await vi.advanceTimersByTimeAsync(500); expect(await result).toBe(false) })
  expect(hook.result.current.state.timeline).toBe(before)
  expect(hook.result.current.state.timelineError).toBeTruthy()
  expect(hook.result.current.history.historyCursor.current).toMatchObject({ apiBefore: 300, apiAfter: 500, loading: false })
  expect(hook.result.current.history.hasNewerHistory()).toBe(true)
})

it('retires reading intent within the same selection while releasing only its settled reader loading', async () => {
  for (const kind of ['reading', 'latest'] as const) {
    for (const completion of [page('anchor', 900, 1000), null]) {
      const pending = deferred<SessionEntriesPage | null>()
      const hook = setup(vi.fn(() => pending.promise), { ...selected, timelineError: 'existing error' })
      seedMiddle(hook)
      // Exercise the uncached latest read with the existing error still visible.
      hook.result.current.history.timelineCache.current.delete('/a')
      const before = hook.result.current.state.timeline
      const error = hook.result.current.state.timelineError
      let current = true
      let result!: Promise<boolean>
      act(() => {
        result = kind === 'reading'
          ? hook.result.current.history.restoreHistoryReadingPosition('anchor', 12, () => current)
          : hook.result.current.history.loadLatestHistory(() => current)
      })
      const loadId = hook.result.current.history.timelineLoadId.current
      const selection = hook.result.current.history.selectionRef.current
      expect(hook.result.current.state.timelineError).toBe(error)
      expect(hook.actions.some((action) => action.type === 'timelineLoading' && action.loading)).toBe(false)
      expect(hook.getEntriesPage).toHaveBeenCalledTimes(1)
      expect(hook.result.current.history.historyCursor.current?.loading).toBe(true)
      current = false
      // Retiring intent leaves the actual pending reader and its cursor intact.
      expect(hook.result.current.history.historyCursor.current?.loading).toBe(true)
      await act(async () => { pending.resolve(completion); expect(await result).toBe(false) })
      expect(hook.result.current.history.selectionRef.current).toBe(selection)
      expect(hook.result.current.history.timelineLoadId.current).toBe(loadId)
      expect(hook.result.current.state.timeline).toBe(before)
      expect(hook.result.current.state.timelineError).toBe(error)
      expect(hook.result.current.state.timelineLoading).toBe(false)
      expect(hook.result.current.history.historyCursor.current).toMatchObject({
        apiBefore: 300, apiAfter: 500, loadId, loading: false
      })
      expect(hook.actions.some((action) => ['loadEntries', 'historyJump', 'timelineError'].includes(action.type))).toBe(false)
      expect(hook.actions.filter((action) => action.type === 'timelineLoading' && !action.loading)).toHaveLength(1)
      expect(hook.getEntriesPage).toHaveBeenCalledTimes(1)
      hook.unmount()
    }
  }
})

it.each(['reading', 'latest'] as const)('rejects %s results after rendered or window API replacement', async (kind) => {
  for (const owner of ['rendered', 'window'] as const) {
    const pending = deferred<SessionEntriesPage>()
    const hook = setup(vi.fn(() => pending.promise))
    seedMiddle(hook)
    const before = hook.result.current.state.timeline
    let result!: Promise<boolean>
    act(() => {
      result = kind === 'reading'
        ? hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)
        : hook.result.current.history.loadLatestHistory()
    })
    const cursor = hook.result.current.history.historyCursor.current
    const loadId = hook.result.current.history.timelineLoadId.current
    expect(cursor).toMatchObject({ loadId, loading: true })
    const replacement = { ...hook.api }
    if (owner === 'rendered') hook.rerender({ api: replacement })
    else vi.stubGlobal('pion', replacement)
    if (owner === 'window') {
      expect(hook.result.current.history.timelineLoadId.current).toBe(loadId)
      expect(hook.result.current.history.historyCursor.current).toBe(cursor)
      expect(cursor?.loading).toBe(true)
    }
    await act(async () => { pending.resolve(page('anchor', 900, 1000)); expect(await result).toBe(false) })
    if (hook.result.current.history.timelineLoadId.current === loadId) {
      expect(hook.result.current.history.historyCursor.current).toBe(cursor)
      expect(cursor?.loading).toBe(false)
    } else {
      // A rendered API change may retire the cursor through an effect's new loadId.
      expect(owner).toBe('rendered')
      expect(cursor?.loadId).not.toBe(hook.result.current.history.timelineLoadId.current)
    }
    expect(hook.result.current.state.timeline).toBe(before)
    expect(hook.actions.some((action) => ['loadEntries', 'historyJump', 'timelineError'].includes(action.type))).toBe(false)
    expect(hook.actions.some((action) => action.type === 'timelineLoading')).toBe(false)
    hook.unmount()
    vi.unstubAllGlobals()
  }
})

it.each(['reading', 'latest'] as const)('rejects %s reads across missing raw cwd/session snapshots', async (kind) => {
  for (const missing of ['cwd', 'session'] as const) {
    for (const timing of ['before', 'pending'] as const) {
      const pending = deferred<SessionEntriesPage>()
      const hook = setup(vi.fn(() => pending.promise))
      seedMiddle(hook)
      const before = hook.result.current.state.timeline
      const selection = hook.result.current.history.selectionRef.current
      const removeSnapshot = () => hook.result.current.dispatch(missing === 'cwd'
        ? { type: 'status', status: { phase: 'running' } }
        : { type: 'session', session: null })
      if (timing === 'before') act(removeSnapshot)
      let result!: Promise<boolean>
      act(() => {
        result = kind === 'reading'
          ? hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)
          : hook.result.current.history.loadLatestHistory()
      })
      if (timing === 'pending') act(removeSnapshot)
      await act(async () => { pending.resolve(page('anchor', 900, 1000)); expect(await result).toBe(false) })
      expect(hook.getEntriesPage).toHaveBeenCalledTimes(timing === 'pending' ? 1 : 0)
      expect(hook.result.current.history.selectionRef.current).toBe(selection)
      expect(hook.result.current.state.timeline).toBe(before)
      expect(hook.result.current.history.historyCursor.current?.loading).toBe(false)
      expect(hook.actions.some((action) => ['loadEntries', 'historyJump', 'timelineError'].includes(action.type))).toBe(false)
      hook.unmount()
    }
  }
})

it.each(['reading', 'latest'] as const)('releases only its own %s cursor after a reset-only retirement', async (kind) => {
  const pending = deferred<SessionEntriesPage>()
  const hook = setup(vi.fn(() => pending.promise), { ...selected, timelineError: 'existing error' })
  seedMiddle(hook)
  const before = hook.result.current.state.timeline
  const error = hook.result.current.state.timelineError
  let result!: Promise<boolean>
  act(() => {
    result = kind === 'reading'
      ? hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)
      : hook.result.current.history.loadLatestHistory()
  })
  const selection = hook.result.current.history.selectionRef.current
  const loadId = hook.result.current.history.timelineLoadId.current
  act(() => hook.result.current.dispatch({ type: 'resetHistoryNavigation' }))
  expect(hook.result.current.history.historyCursor.current?.loading).toBe(true)
  await act(async () => { pending.resolve(page('anchor', 900, 1000)); expect(await result).toBe(false) })
  expect(hook.result.current.history.selectionRef.current).toBe(selection)
  expect(hook.result.current.history.timelineLoadId.current).toBe(loadId)
  expect(hook.result.current.state.timeline).toBe(before)
  expect(hook.result.current.state.timelineError).toBe(error)
  expect(hook.result.current.history.historyCursor.current).toMatchObject({ apiBefore: 300, apiAfter: 500, loading: false })
  expect(hook.actions.some((action) => ['loadEntries', 'historyJump', 'timelineError'].includes(action.type))).toBe(false)
  expect(hook.actions.filter((action) => action.type === 'timelineLoading' && !action.loading)).toHaveLength(1)
})

it.each(['reading', 'latest'] as const)('keeps the previous error until a successful %s page is accepted', async (kind) => {
  const pending = deferred<SessionEntriesPage>()
  const hook = setup(vi.fn(() => pending.promise), { ...selected, timelineError: 'existing error' })
  seedMiddle(hook)
  hook.result.current.history.timelineCache.current.delete('/a')
  const error = hook.result.current.state.timelineError
  let result!: Promise<boolean>
  act(() => {
    result = kind === 'reading'
      ? hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)
      : hook.result.current.history.loadLatestHistory()
  })
  expect(hook.result.current.state.timelineError).toBe(error)
  expect(hook.result.current.history.historyCursor.current?.loading).toBe(true)
  expect(hook.actions.some((action) => action.type === 'timelineLoading' && action.loading)).toBe(false)
  await act(async () => { pending.resolve(page('anchor', 900, 1000)); expect(await result).toBe(true) })
  expect(hook.result.current.state.timelineError).toBeUndefined()
  const jump = hook.actions.find((action) => action.type === 'historyJump')
  if (jump) expect(jump).not.toHaveProperty('readingToken')
})

it('omits reading-only fields from ordinary history jumps', async () => {
  const hook = setup()
  await act(async () => { await hook.result.current.history.jumpToHistoryLandmark(index.landmarks[0]) })
  const jump = hook.actions.find((action) => action.type === 'historyJump')
  expect(jump).toMatchObject({ entryId: 'anchor', nonce: 1 })
  expect(jump).not.toHaveProperty('readingOffset')
  expect(jump).not.toHaveProperty('readingToken')
})

it('rejects late reading and latest-page completions after the selection is retired', async () => {
  for (const kind of ['reading', 'latest'] as const) {
    const pending = deferred<SessionEntriesPage>()
    const hook = setup(vi.fn(() => pending.promise))
    let result!: Promise<boolean>
    act(() => {
      result = kind === 'reading'
        ? hook.result.current.history.restoreHistoryReadingPosition('anchor', 12)
        : hook.result.current.history.loadLatestHistory()
      hook.result.current.history.invalidateSelection()
    })
    await act(async () => { pending.resolve(page('anchor', 900, 1000)); expect(await result).toBe(false) })
    expect(hook.actions.some((action) => action.type === 'loadEntries' || action.type === 'historyJump')).toBe(false)
    hook.unmount()
  }
})
