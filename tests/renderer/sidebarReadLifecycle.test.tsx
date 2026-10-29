// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useReducer, type Dispatch } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PionApi, SessionMeta } from '../../src/shared/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type Action, type AgentState } from '../../src/renderer/src/agent/types'
import { useAgentSubscriptions } from '../../src/renderer/src/hooks/agent/useAgentSubscriptions'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function row(cwd: string, sidebarRevision = 1, totalTokens?: number): SessionMeta {
  return { id: cwd, path: `${cwd}/session.jsonl`, projectCwd: cwd,
    timestamp: '2026-01-01', mtime: 1, preview: '', messageCount: 1,
    sidebarRevision, ...(totalTokens === undefined ? {} : { totalTokens }) }
}

function fixture(cwds: string[], delayBranches = false) {
  const projects = cwds.map((cwd) => ({ cwd, name: cwd, addedAt: 0, lastUsedAt: 0 }))
  // Reducer publications leave these discovery inputs stable until an explicit
  // rerender, so a completed branch query does not restart the read under test.
  const branchesByProject: AgentState['branchesByProject'] = Object.fromEntries(
    cwds.map((cwd) => [cwd, [{ name: 'main', cwd, isMain: true }]]))
  const reads: Array<ReturnType<typeof deferred<SessionMeta[]>> & { cwd: string }> = []
  const listeners = new Set<(sessions: SessionMeta[]) => void>()
  const branchReads: Array<ReturnType<typeof deferred<AgentState['branchesByProject'][string]>> & { cwd: string }> = []
  let pending = 0, maxPending = 0, branchPending = 0, maxBranchPending = 0
  const subscribe = (_listener: (value: unknown) => void) => () => undefined
  const api = { onStatus: vi.fn(subscribe), onRunCheckpoint: vi.fn(subscribe), onState: vi.fn(subscribe),
    onSessions: vi.fn((listener: (sessions: SessionMeta[]) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    onUnreadSessions: vi.fn(subscribe), onRunningSessionPaths: vi.fn(subscribe), onTree: vi.fn(subscribe),
    onProjects: vi.fn(subscribe), onEvent: vi.fn(subscribe),
    getRunningSessionPaths: vi.fn().mockResolvedValue([]), getUnreadSessionPaths: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn((cwd: string) => {
      if (!delayBranches) return Promise.resolve(branchesByProject[cwd])
      const read = { cwd, ...deferred<AgentState['branchesByProject'][string]>() }
      branchReads.push(read)
      maxBranchPending = Math.max(maxBranchPending, ++branchPending)
      return read.promise.finally(() => { branchPending-- })
    }),
    listSessions: vi.fn((cwd: string) => {
      const read = { cwd, ...deferred<SessionMeta[]>() }
      reads.push(read)
      maxPending = Math.max(maxPending, ++pending)
      return read.promise.finally(() => { pending-- })
    }) }
  const options = { api: api as unknown as PionApi, projects, branchesByProject }
  const optimisticSessionTimers = { current: new Map<string, number>() }
  let reduce!: Dispatch<Action>
  const dispatch = vi.fn((action: Action) => reduce(action))
  const h = renderHook((props) => {
    const [state, nextDispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'ready', cwd: cwds[0] } })
    reduce = nextDispatch
    useAgentSubscriptions({ ...props, dispatch, sessionsByProject: state.sessionsByProject, optimisticSessionTimers })
    return state
  }, { initialProps: options })
  return { h, api, options, reads, branchReads, dispatch,
    get pending() { return pending }, get maxPending() { return maxPending },
    get branchPending() { return branchPending }, get maxBranchPending() { return maxBranchPending },
    push: (sessions: SessionMeta[]) => listeners.forEach((listener) => listener(sessions)),
    close: async () => {
      h.unmount()
      await act(async () => {
        for (const read of reads) read.resolve([])
        for (const read of branchReads) read.resolve([])
      })
    } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('publishes success after the slow-read deadline while retaining same-revision token supplements', async () => {
  const cwd = '/late', f = fixture([cwd])
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
  expect(console.warn).toHaveBeenCalledWith('[pion] sidebar read is still pending:', cwd)
  expect(f.pending).toBe(1)
  expect(f.api.listSessions).toHaveBeenCalledTimes(1)
  expect(f.h.result.current.sessionsByProject[cwd]).toBeUndefined()
  act(() => f.push([row(cwd, 2, 80)]))
  const base = row(cwd, 2)
  await act(async () => { f.reads[0].resolve([base]) })
  expect(f.dispatch).toHaveBeenCalledWith({ type: 'projectSessionsUpdate', cwd, sessions: [base] })
  expect(f.h.result.current.sessionsByProject[cwd]).toEqual([row(cwd, 2, 80)])
  expect(f.pending).toBe(0)
  expect(f.api.listSessions).toHaveBeenCalledTimes(1)
  await f.close()
})

it('retains four actual slots after deadlines and discovery replacement, with free workers progressing independently', async () => {
  const cwds = ['/slow', '/two', '/three', '/four', '/five', '/six'], f = fixture(cwds)
  expect(f.api.listSessions.mock.calls.map(([cwd]) => cwd)).toEqual(cwds.slice(0, 4))
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(f.api.listSessions).toHaveBeenCalledTimes(4)
  expect(f.pending).toBe(4)

  await act(async () => { f.reads[1].resolve([row('/two')]) })
  expect(f.h.result.current.sessionsByProject['/two']).toEqual([row('/two')])
  expect(f.reads[4].cwd).toBe('/five')
  await act(async () => { f.reads[4].resolve([row('/five')]) })
  expect(f.reads[5].cwd).toBe('/six')
  expect(f.h.result.current.sessionsByProject['/slow']).toBeUndefined()
  expect(f.pending).toBe(4)

  f.h.rerender({ ...f.options, branchesByProject: { ...f.options.branchesByProject } })
  expect(f.api.listSessions).toHaveBeenCalledTimes(6)
  const obsolete = row('/slow', 1)
  await act(async () => { f.reads[0].resolve([obsolete]) })
  expect(f.dispatch).not.toHaveBeenCalledWith({ type: 'projectSessionsUpdate', cwd: '/slow', sessions: [obsolete] })
  expect(f.api.listSessions).toHaveBeenCalledTimes(7)
  expect(f.pending).toBe(4)
  expect(f.maxPending).toBe(4)
  await f.close()
  expect(f.pending).toBe(0)
  expect(f.api.listSessions).toHaveBeenCalledTimes(7)
})

it('keeps both four-slot pools across API A-B-A and permanently retires every old push callback', async () => {
  const cwds = ['/one', '/two', '/three', '/four', '/five'], f = fixture(cwds, true)
  const retired = [
    () => f.api.onStatus.mock.calls[0][0]({ phase: 'ready', cwd: '/old' }),
    () => f.api.onRunCheckpoint.mock.calls[0][0](null),
    () => f.api.onState.mock.calls[0][0](null),
    () => f.api.onUnreadSessions.mock.calls[0][0](['/old']),
    () => f.api.onRunningSessionPaths.mock.calls[0][0](['/old']),
    () => f.api.onTree.mock.calls[0][0](null),
    () => f.api.onProjects.mock.calls[0][0]([]),
    () => f.api.onEvent.mock.calls[0][0]({ type: 'agent_settled' }),
    () => f.api.onSessions.mock.calls[0][0]([row('/one', 99, 999)])
  ]
  f.h.rerender({ ...f.options, api: { ...f.api } as unknown as PionApi })
  f.h.rerender(f.options)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(f.api.listBranches).toHaveBeenCalledTimes(4)
  expect(f.api.listSessions).toHaveBeenCalledTimes(4)
  expect(f.branchPending).toBe(4)
  expect(f.pending).toBe(4)
  f.dispatch.mockClear()
  act(() => retired.forEach((push) => push()))
  expect(f.dispatch).not.toHaveBeenCalled()
  await act(async () => { f.reads[0].resolve([row('/one')]); f.branchReads[0].resolve([]) })
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(f.api.listBranches).toHaveBeenCalledTimes(5)
  expect(f.api.listSessions).toHaveBeenCalledTimes(5)
  expect(f.branchReads[4].cwd).toBe('/one')
  expect(f.reads[4].cwd).toBe('/one')
  expect(f.branchPending).toBe(4)
  expect(f.pending).toBe(4)
  expect(f.maxBranchPending).toBe(4)
  expect(f.maxPending).toBe(4)
  await f.close()
  expect(f.api.listBranches).toHaveBeenCalledTimes(5)
  expect(f.api.listSessions).toHaveBeenCalledTimes(5)
})

it.each(['unmount', 'api', 'window'] as const)('rejects late read success and a retired push after %s', async (retire) => {
  const cwd = '/retired', f = fixture([cwd])
  const retiredPush = f.api.onSessions.mock.calls[0][0]
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
  if (retire === 'unmount') f.h.unmount()
  else if (retire === 'window') vi.stubGlobal('pion', { ...f.api })
  else f.h.rerender({ ...f.options, api: { ...f.api } as unknown as PionApi })
  f.dispatch.mockClear()
  await act(async () => {
    retiredPush([row(cwd, 99, 999)])
    f.reads[0].resolve([row(cwd, 99)])
  })
  expect(f.dispatch.mock.calls.some(([action]) => action.type === 'sessions' || action.type === 'projectSessionsUpdate')).toBe(false)
  if (retire === 'api') {
    await act(async () => { f.reads[1].resolve([row(cwd, 1)]) })
    expect(f.h.result.current.sessionsByProject[cwd]).toEqual([row(cwd, 1)])
  }
  await f.close()
})
