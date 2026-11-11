// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/types'
import type { HistoryCursor, TimelineCacheEntry } from '../../src/renderer/src/agent/timeline'
import { useAgentSessionActions } from '../../src/renderer/src/hooks/agent/useAgentSessionActions'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type AgentState } from '../../src/renderer/src/agent/types'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const A = '/project/a.jsonl', B = '/project/b.jsonl', fork = '/project/fork.jsonl'
const warning = `会话副本已创建，用量归档未完成；副本路径：${fork}`
type Kind = 'copy' | 'fork'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function cached(): TimelineCacheEntry {
  return { items: [], mode: 'build', apiBefore: 0, apiAfter: 1, toolResults: [],
    complete: true, newerComplete: true, leafId: A, total: 1 }
}
function setup() {
  const copy = deferred<Awaited<ReturnType<PionApi['copySession']>>>()
  const branch = deferred<Awaited<ReturnType<PionApi['forkSession']>>>()
  const loaded = deferred<void>()
  const messages = deferred<Awaited<ReturnType<PionApi['getSessionForkMessages']>>>()
  const sessions = deferred<Awaited<ReturnType<PionApi['listSessions']>>>()
  const api = {
    copySession: vi.fn(() => copy.promise), forkSession: vi.fn(() => branch.promise),
    getSessionForkMessages: vi.fn(() => messages.promise), listSessions: vi.fn(() => sessions.promise)
  } as unknown as PionApi
  const timelineCache = { current: new Map([[A, cached()], [B, cached()]]) }
  const timelineOwnerPath = { current: A as string | undefined }
  const historyCursor = { current: { ...cached(), path: A, loadId: 1, loading: false } as HistoryCursor | null }
  let generation = 0, intent = 0
  const captureSelection = () => {
    const selected = generation
    return () => selected === generation
  }
  const clearTimeline = vi.fn()
  const reloadTimeline = vi.fn(() => loaded.promise)
  const dispatch = vi.fn()
  const hook = renderHook(({ currentApi }) => useAgentSessionActions({
    api: currentApi, dispatch, timelineCache, timelineOwnerPath, historyCursor,
    clearTimeline, reloadTimeline, captureSelection,
    captureSelectionIntent: () => {
      const selected = intent
      return () => selected === intent
    }
  }), { initialProps: { currentApi: api } })
  return {
    ...hook, api, dispatch, messages, sessions, timelineCache, timelineOwnerPath, historyCursor, clearTimeline, reloadTimeline,
    captureSelection,
    run: (kind: Kind) => kind === 'copy' ? hook.result.current.copySession(A) : hook.result.current.forkSession(A, 'entry-a'),
    resolve: (kind: Kind, cancelled = false) => kind === 'copy'
      ? copy.resolve({ cancelled, warning }) : branch.resolve({ cancelled, text: 'original user text', warning }),
    // Authoritative STATE and the owned reload publish a new session identity;
    // explicit UI navigation alone retires the mutation's intent receipt.
    publish: (path?: string) => { generation++; if (path) timelineOwnerPath.current = path },
    select: (path: string) => {
      intent++; generation++; timelineOwnerPath.current = path
      historyCursor.current = { ...cached(), path, loadId: generation + 1, loading: false }
    },
    finishReload: () => loaded.resolve(undefined)
  }
}

it.each(['copy', 'fork'] as const)('isolates late %s receipts after A → B and A → B → A', async (kind) => {
  for (const returnToA of [false, true]) {
    const h = setup()
    const sourceCache = h.timelineCache.current.get(A)
    let pending!: Promise<string | void>
    act(() => { pending = h.run(kind) })
    act(() => { h.select(B); if (returnToA) h.select(A) })
    const cursor = h.historyCursor.current
    let text!: string | void
    await act(async () => { h.resolve(kind); text = await pending })
    expect(text).toBe(kind === 'fork' ? '' : undefined)
    expect(h.clearTimeline).not.toHaveBeenCalled()
    expect(h.reloadTimeline).not.toHaveBeenCalled()
    expect(h.timelineOwnerPath.current).toBe(returnToA ? A : B)
    expect(h.historyCursor.current).toBe(cursor)
    expect(h.timelineCache.current.get(A)).toBe(sourceCache)
    expect(h.dispatch).not.toHaveBeenCalled()
    h.unmount()
  }
})

it.each(['copy', 'fork'] as const)('retires %s receipts and callbacks across API A → B → A', async (kind) => {
  const h = setup()
  const actions = h.result.current
  const stale = () => kind === 'copy' ? actions.copySession(A) : actions.forkSession(A, 'entry-a')
  let pending!: Promise<string | void>
  act(() => { pending = stale() })
  h.rerender({ currentApi: { ...h.api } })
  h.rerender({ currentApi: h.api })
  let text!: string | void
  await act(async () => { h.resolve(kind); text = await pending; await stale() })
  expect(text).toBe(kind === 'fork' ? '' : undefined)
  expect(h.clearTimeline).not.toHaveBeenCalled()
  expect(h.reloadTimeline).not.toHaveBeenCalled()
  expect(kind === 'copy' ? h.api.copySession : h.api.forkSession).toHaveBeenCalledTimes(1)
  expect(h.timelineOwnerPath.current).toBe(A)
  expect(h.dispatch).not.toHaveBeenCalled()
})

it.each([
  { kind: 'copy', change: 'api' }, { kind: 'fork', change: 'selection' }, { kind: 'fork', change: 'api' }
] as const)('drops $kind warning and prefill when $change changes during the owned reload', async ({ kind, change }) => {
  const h = setup()
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  await act(async () => { h.resolve(kind) })
  expect(h.reloadTimeline).toHaveBeenCalledTimes(1)
  if (change === 'selection') act(() => { h.select(B) })
  else h.rerender({ currentApi: { ...h.api } })
  let text!: string | void
  await act(async () => { h.finishReload(); text = await pending })
  expect(text).toBe(kind === 'copy' ? undefined : '')
  expect(h.clearTimeline).toHaveBeenCalledTimes(1)
  expect(h.dispatch).not.toHaveBeenCalled()
})

it.each(['copy', 'fork'] as const)('accepts normal %s completion including its own STATE and history selection', async (kind) => {
  const h = setup()
  const originalSelection = h.captureSelection()
  let pending!: Promise<string | void>, settled = false
  act(() => { pending = h.run(kind).then((text) => { settled = true; return text }) })
  act(() => { h.publish(fork) })
  expect(originalSelection()).toBe(false)
  await act(async () => { h.resolve(kind) })
  expect(h.clearTimeline).toHaveBeenCalledTimes(1)
  expect(h.reloadTimeline).toHaveBeenCalledTimes(1)
  expect(h.timelineOwnerPath.current).toBeUndefined()
  expect(h.historyCursor.current).toBeNull()
  expect(settled).toBe(false)
  expect(h.dispatch).not.toHaveBeenCalled()
  let text!: string | void
  await act(async () => { h.publish(fork); h.finishReload(); text = await pending })
  expect(text).toBe(kind === 'fork' ? 'original user text' : undefined)
  expect(h.timelineOwnerPath.current).toBe(fork)
  expect(settled).toBe(true)
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'statusError', error: warning })
})

it('applies an owned warning without resetting a busy backend or accepting stale ready errors', () => {
  const state: AgentState = { ...initialState, status: { phase: 'running', cwd: '/project' },
    busy: true, compacting: true, compactionEventState: true, liveSessionBackendId: 'backend-a',
    session: { sessionId: 'a', sessionFile: A, isStreaming: true, messageCount: 1 },
    timeline: [{ kind: 'assistant', id: 1, text: 'streaming', thinking: '', streaming: true }] }
  const retained = reducer(state, { type: 'status', status: { phase: 'ready', cwd: '/project', error: 'stale ready error' } })
  expect(retained.status).toBe(state.status)
  const next = reducer(retained, { type: 'statusError', error: warning })
  expect(next).toEqual({ ...retained, status: { ...state.status, error: warning } })
  expect(next.status.phase).toBe('running')
  expect(next.busy).toBe(true)
  expect(next.timeline).toBe(state.timeline)
  expect(next.session).toBe(state.session)
})

it.each(['copy', 'fork'] as const)('retires %s receipts and callbacks when the hook unmounts', async (kind) => {
  const h = setup()
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  h.unmount()
  let text!: string | void
  await act(async () => { h.resolve(kind); text = await pending; await h.run(kind) })
  expect(text).toBe(kind === 'fork' ? '' : undefined)
  expect(kind === 'copy' ? h.api.copySession : h.api.forkSession).toHaveBeenCalledTimes(1)
  expect(h.clearTimeline).not.toHaveBeenCalled()
  expect(h.reloadTimeline).not.toHaveBeenCalled()
})

it.each(['api', 'unmount', 'window'] as const)('retires discovery callbacks and late reads after %s', async (retire) => {
  const h = setup(), actions = h.result.current
  const refresh = actions.refreshProjectSessions('/project')
  const reading = actions.getSessionForkMessages(A)
  if (retire === 'unmount') h.unmount()
  else if (retire === 'window') vi.stubGlobal('pion', { ...h.api })
  else {
    h.rerender({ currentApi: { ...h.api } })
    h.rerender({ currentApi: h.api })
  }
  let messages!: Awaited<typeof reading>
  await act(async () => {
    h.sessions.resolve([])
    h.messages.resolve([{ entryId: 'entry-a', text: 'old message' }])
    await refresh
    messages = await reading
    await actions.refreshProjectSessions('/project')
    expect(await actions.getSessionForkMessages(A)).toEqual([])
  })
  expect(messages).toEqual([])
  expect(h.dispatch).not.toHaveBeenCalled()
  expect(h.api.listSessions).toHaveBeenCalledTimes(1)
  expect(h.api.getSessionForkMessages).toHaveBeenCalledTimes(1)
})

it.each(['copy', 'fork'] as const)('preserves the original view after cancelled %s', async (kind) => {
  const h = setup()
  const cursor = h.historyCursor.current
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  await act(async () => { h.resolve(kind, true); await pending })
  expect(h.clearTimeline).not.toHaveBeenCalled()
  expect(h.reloadTimeline).not.toHaveBeenCalled()
  expect(h.timelineOwnerPath.current).toBe(A)
  expect(h.historyCursor.current).toBe(cursor)
})
