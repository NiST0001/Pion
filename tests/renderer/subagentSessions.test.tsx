// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/pion-api'
import type { SubagentSessionList, SubagentSessionSnapshot, SubagentSessionSummary } from '../../src/shared/subagent-sessions'
import { useSubagentSessions } from '../../src/renderer/src/hooks/useSubagentSessions'

const child = (id = 'a'): SubagentSessionSummary => ({ id, backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'tool', parentSessionId: 'parent', parentSessionPath: '/parent.jsonl', cwd: '/project', name: id, status: 'running', revision: 1, truncated: false })
const detail = (summary: SubagentSessionSummary): SubagentSessionSnapshot => ({ ...summary, rows: [{ id: 'row', kind: 'assistant', text: summary.name }] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function fixture() {
  let listener: ((list: SubagentSessionList) => void) | undefined
  const order: string[] = []
  const off = vi.fn()
  const bootstrap = deferred<SubagentSessionList>()
  const api = {
    listSubagentSessions: vi.fn(() => { order.push('list'); return bootstrap.promise }),
    getSubagentSession: vi.fn(async (id: string): Promise<SubagentSessionSnapshot | null> => detail(child(id))),
    onSubagentSessions: vi.fn((callback: (list: SubagentSessionList) => void) => { order.push('subscribe'); listener = callback; return off })
  } satisfies Pick<PionApi, 'listSubagentSessions' | 'getSubagentSession' | 'onSubagentSessions'>
  return { api: api as unknown as PionApi, mocks: api, bootstrap, off, order, push: (list: SubagentSessionList) => listener?.(list) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('useSubagentSessions memory projection', () => {
  it('stops reads and unsubscribes while hidden, fences old callbacks and expires before restoration', async () => {
    vi.useFakeTimers()
    let hidden = false
    let monotonic = 0
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const f = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const summary = { ...child(), status: 'completed' as const, retentionRemainingMs: 1000 }
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => { f.push({ revision: 2, sessions: [summary] }); result.current.open(summary) })
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) })
    expect(f.off).toHaveBeenCalledOnce()
    expect(result.current.sessions).toEqual([])
    expect(result.current.selectedTarget).toBeNull()
    act(() => { f.push({ revision: 50, sessions: [child('late')] }); vi.advanceTimersByTime(5000) })
    await act(async () => f.bootstrap.resolve({ revision: 60, sessions: [child('bootstrap')] }))
    expect(f.mocks.listSubagentSessions).toHaveBeenCalledOnce()
    expect(f.mocks.getSubagentSession).toHaveBeenCalledOnce()
    monotonic = 1001
    const restoredBootstrap = deferred<SubagentSessionList>()
    f.mocks.listSubagentSessions.mockImplementationOnce(() => { f.order.push('list'); return restoredBootstrap.promise })
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) })
    expect(f.order).toEqual(['subscribe', 'list', 'subscribe', 'list'])
    act(() => f.push({ revision: 3, sessions: [summary, child('b')] }))
    expect(result.current.sessions.map((item) => item.id)).toEqual(['b'])
    act(() => result.current.open(child('b')))
    expect(f.mocks.getSubagentSession).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(detail(summary)))
    expect(result.current.selected?.id).toBe('b')
  })
  it('does not start collection when initially hidden', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const f = fixture()
    const { result } = renderHook(() => useSubagentSessions(f.api))
    expect(f.order).toEqual([])
    act(() => result.current.open(child()))
    expect(f.mocks.getSubagentSession).not.toHaveBeenCalled()
  })
  it('requires a current authoritative summary and retires a null detail without leaving a row', async () => {
    const f = fixture()
    f.mocks.getSubagentSession.mockResolvedValue(null)
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => result.current.open(child()))
    expect(f.mocks.getSubagentSession).not.toHaveBeenCalled()
    const current = { ...child(), parentSessionPath: '/new-parent.jsonl', revision: 2 }
    act(() => { f.push({ revision: 1, sessions: [current] }); result.current.open(child()) })
    expect(f.mocks.getSubagentSession).not.toHaveBeenCalled()
    await act(async () => result.current.open(current))
    expect(result.current.sessions).toEqual([])
    expect(result.current.selectedTarget).toBeNull()
    act(() => { f.push({ revision: 2, sessions: [current] }); result.current.open(current) })
    expect(result.current.sessions).toEqual([])
    expect(f.mocks.getSubagentSession).toHaveBeenCalledOnce()
  })
  it.each(['revision', 'parent', 'status', 'truncated'] as const)('rejects pending detail when child %s changes, then fetches the new binding', async (change) => {
    const f = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    const original = child()
    const newer = { ...original, ...(change === 'revision' ? { revision: 2 } : change === 'parent' ? { parentSessionPath: '/other.jsonl' } : change === 'status' ? { status: 'cancelling' as const } : { truncated: true }) }
    f.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise).mockResolvedValue(detail(newer))
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => { f.push({ revision: 1, sessions: [original] }); result.current.open(original) })
    act(() => f.push({ revision: 2, sessions: [newer] }))
    expect(f.mocks.getSubagentSession).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(detail(original)))
    expect(f.mocks.getSubagentSession).toHaveBeenCalledTimes(2)
    expect(result.current.selected).toEqual(detail(newer))
  })
  it('keeps the accepted body revision during refresh and immediately applies terminal metadata without reviving a run', async () => {
    const f = fixture()
    const original = child()
    const refresh = deferred<SubagentSessionSnapshot | null>()
    const terminalRead = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockResolvedValueOnce(detail(original))
      .mockImplementationOnce(() => refresh.promise).mockImplementationOnce(() => terminalRead.promise)
    const { result } = renderHook(() => useSubagentSessions(f.api))
    await act(async () => { f.push({ revision: 1, sessions: [original] }); result.current.open(original) })
    const rows = result.current.selected!.rows
    const newer = { ...original, revision: 2, name: 'new header', truncated: true }
    act(() => f.push({ revision: 2, sessions: [newer] }))
    expect(result.current.loading).toBe(true)
    expect(result.current.selected).toMatchObject({ revision: 1, name: 'new header', truncated: true, status: 'running' })
    expect(result.current.selected!.rows).toBe(rows)
    const completed = { ...newer, revision: 3, status: 'completed' as const, retentionRemainingMs: 1000 }
    act(() => f.push({ revision: 3, sessions: [completed] }))
    expect(result.current.selected).toMatchObject({ revision: 1, status: 'completed' })
    expect(result.current.selected!.rows).toBe(rows)
    // Adding a revision to an old snapshot must not make its stale status/name
    // binding acceptable. The actual pending slot remains occupied until here.
    await act(async () => refresh.resolve({ ...detail(newer), revision: 3 }))
    expect(result.current.selected!.rows).toBe(rows)
    expect(result.current.selected!.status).toBe('completed')
    expect(f.mocks.getSubagentSession).toHaveBeenCalledTimes(3)
    act(() => f.push({ revision: 4, sessions: [{ ...newer, revision: 4 }] }))
    expect(result.current.sessions[0].status).toBe('completed')
    expect(result.current.selected!.status).toBe('completed')
    await act(async () => terminalRead.resolve(detail(completed)))
    expect(result.current.selected).toMatchObject({ revision: 3, status: 'completed' })
  })
  it('replaces retained rows only after a matching new detail and rejects a forged revision with stale binding', async () => {
    const f = fixture()
    const original = child()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockResolvedValueOnce(detail(original)).mockImplementationOnce(() => pending.promise)
    const { result } = renderHook(() => useSubagentSessions(f.api))
    await act(async () => { f.push({ revision: 1, sessions: [original] }); result.current.open(original) })
    const rows = result.current.selected!.rows
    const newer = { ...original, revision: 2, name: 'new header' }
    act(() => f.push({ revision: 2, sessions: [newer] }))
    await act(async () => pending.resolve({ ...detail(original), revision: 2 }))
    expect(result.current.selected!.revision).toBe(1)
    expect(result.current.selected!.rows).toBe(rows)
    f.mocks.getSubagentSession.mockResolvedValue(detail(newer))
    act(() => f.push({ revision: 3, sessions: [newer] }))
    await act(async () => {})
    expect(result.current.selected).toEqual(detail(newer))
    expect(result.current.selected!.rows).not.toBe(rows)
  })
  it('keeps safe rows through first parent-path binding but clears them on known path or source changes', async () => {
    const f = fixture()
    const original = { ...child(), parentSessionPath: undefined }
    f.mocks.getSubagentSession.mockResolvedValueOnce(detail(original))
      .mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useSubagentSessions(f.api))
    await act(async () => { f.push({ revision: 1, sessions: [original] }); result.current.open(original) })
    const rows = result.current.selected!.rows
    const bound = { ...original, parentSessionPath: '/persisted.jsonl', revision: 2 }
    act(() => f.push({ revision: 2, sessions: [bound] }))
    expect(result.current.selected!.rows).toBe(rows)
    expect(result.current.selected).toMatchObject({ revision: 1, parentSessionPath: '/persisted.jsonl' })
    act(() => f.push({ revision: 3, sessions: [{ ...bound, parentSessionPath: '/different.jsonl', revision: 3 }] }))
    expect(result.current.selected).toBeNull()
  })
  it.each(['runtimeId', 'cwd', 'parentToolCallId', 'parentSessionId', 'backendId'] as const)('clears accepted rows when %s changes', async (field) => {
    const f = fixture()
    f.mocks.getSubagentSession.mockImplementationOnce(async () => detail(child()))
      .mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useSubagentSessions(f.api))
    await act(async () => { f.push({ revision: 1, sessions: [child()] }); result.current.open(child()) })
    expect(result.current.selected).not.toBeNull()
    act(() => f.push({ revision: 2, sessions: [{ ...child(), [field]: 'changed', revision: 2 }] }))
    expect(result.current.selected).toBeNull()
  })
  it('unrelated list revisions do not starve pending detail', async () => {
    const f = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => { f.push({ revision: 1, sessions: [child()] }); result.current.open(child()) })
    act(() => { for (let revision = 2; revision < 20; revision++) f.push({ revision, sessions: [child(), { ...child('b'), revision }] }) })
    await act(async () => pending.resolve(detail(child())))
    expect(result.current.selected?.id).toBe('a')
    expect(f.mocks.getSubagentSession).toHaveBeenCalledOnce()
  })
  it('removal fences a pending detail and its null result cannot close a newer target', async () => {
    const f = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => { f.push({ revision: 1, sessions: [child()] }); result.current.open(child()) })
    act(() => { f.push({ revision: 2, sessions: [child('b')] }); result.current.open(child('b')) })
    await act(async () => pending.resolve(null))
    expect(result.current.selected?.id).toBe('b')
    expect(result.current.sessions.map((item) => item.id)).toEqual(['b'])
  })
  it('resets API-scoped revisions and tombstones but holds the real old IPC slot until settlement', async () => {
    const old = fixture()
    const next = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    old.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const { result, rerender } = renderHook(({ api }) => useSubagentSessions(api), { initialProps: { api: old.api } })
    act(() => { old.push({ revision: 100, sessions: [child()] }); result.current.open(child()) })
    act(() => old.push({ revision: 101, sessions: [] }))
    rerender({ api: next.api })
    act(() => old.push({ revision: 999, sessions: [child('late')] }))
    await act(async () => old.bootstrap.resolve({ revision: 9999, sessions: [child('old')] }))
    act(() => { next.push({ revision: 1, sessions: [child()] }); result.current.open(child()) })
    expect(result.current.sessions.map((item) => item.id)).toEqual(['a'])
    expect(next.mocks.getSubagentSession).not.toHaveBeenCalled()
    await act(async () => pending.resolve(detail(child('old'))))
    expect(next.mocks.getSubagentSession).toHaveBeenCalledOnce()
    expect(result.current.selected?.id).toBe('a')
  })
  it('can restore a disabled list at the same revision without renewing deadlines', async () => {
    const f = fixture()
    const { result, rerender } = renderHook(({ enabled }) => useSubagentSessions(f.api, enabled), { initialProps: { enabled: true } })
    act(() => f.push({ revision: 5, sessions: [child()] }))
    rerender({ enabled: false })
    expect(result.current.sessions).toEqual([])
    rerender({ enabled: true })
    await act(async () => f.bootstrap.resolve({ revision: 5, sessions: [child()] }))
    expect(result.current.sessions.map((item) => item.id)).toEqual(['a'])
  })
  it('bounded tombstone floors compare global list revisions, not unrelated child revisions', () => {
    const f = fixture()
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => {
      for (let revision = 1; revision <= 1026; revision++) f.push({ revision, sessions: [{ ...child(String(revision)), revision: 999999 }] })
      f.push({ revision: 1027, sessions: [child('fresh')] })
    })
    expect(result.current.sessions.map((item) => item.id)).toEqual(['fresh'])
  })
  it('subscribes first and refuses old bootstrap/push revisions', async () => {
    const f = fixture()
    const { result } = renderHook(() => useSubagentSessions(f.api))
    expect(f.order).toEqual(['subscribe', 'list'])
    act(() => f.push({ revision: 3, sessions: [child('new')] }))
    await act(async () => f.bootstrap.resolve({ revision: 1, sessions: [child('old')] }))
    act(() => f.push({ revision: 2, sessions: [] }))
    expect(result.current.sessions.map((item) => item.id)).toEqual(['new'])
    expect(f.mocks.getSubagentSession).not.toHaveBeenCalled()
  })
  it('holds the actual detail promise through close, reopen and hide; old generations cannot overwrite', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const { result, rerender, unmount } = renderHook(({ enabled }) => useSubagentSessions(f.api, enabled), { initialProps: { enabled: true } })
    act(() => { f.push({ revision: 1, sessions: [child('a'), child('b')] }); result.current.open(child('a')) })
    act(() => { result.current.close(); result.current.open(child('b')); vi.advanceTimersByTime(10_000) })
    expect(f.mocks.getSubagentSession).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(detail(child('a'))))
    expect(result.current.selected?.id).toBe('b')
    const calls = f.mocks.getSubagentSession.mock.calls.length
    rerender({ enabled: false })
    act(() => vi.advanceTimersByTime(10_000))
    expect(f.mocks.getSubagentSession).toHaveBeenCalledTimes(calls)
    expect(f.off).toHaveBeenCalledOnce()
    expect(result.current.selected).toBeNull()
    expect(result.current.selectedTarget).toBeNull()
    expect(result.current.sessions).toEqual([])
    unmount()
  })
  it('releases an expired selection even while the actual detail request stays pending', () => {
    vi.useFakeTimers()
    let monotonic = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const f = fixture()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.mocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const summary = { ...child(), status: 'failed' as const, retentionRemainingMs: 1000 }
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => { f.push({ revision: 1, sessions: [summary] }); result.current.open(summary) })
    monotonic = 1001
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current.selectedTarget).toBeNull()
    expect(result.current.loading).toBe(false)
    act(() => { f.push({ revision: 2, sessions: [child('b')] }); result.current.open(child('b')); vi.advanceTimersByTime(10_000) })
    expect(f.mocks.getSubagentSession).toHaveBeenCalledTimes(1)
  })
  it('expires terminal rows by monotonic time, never renews repeated snapshots and refuses resurrection', async () => {
    vi.useFakeTimers()
    let monotonic = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const f = fixture()
    const summary = { ...child(), status: 'completed' as const, retentionRemainingMs: 1000 }
    f.mocks.getSubagentSession.mockResolvedValue(detail(summary))
    const { result } = renderHook(() => useSubagentSessions(f.api))
    act(() => { f.push({ revision: 1, sessions: [summary] }); result.current.open(summary) })
    await act(async () => {})
    expect(result.current.selected?.rows).toHaveLength(1)
    monotonic = 800
    act(() => { vi.setSystemTime(-100_000); f.push({ revision: 2, sessions: [summary] }) })
    await act(async () => {})
    monotonic = 1001
    act(() => vi.advanceTimersByTime(500))
    expect(result.current.sessions).toEqual([])
    expect(result.current.selected).toBeNull()
    expect(result.current.selectedTarget).toBeNull()
    act(() => { f.push({ revision: 3, sessions: [{ ...summary, revision: 50, retentionRemainingMs: 99999 }] }); result.current.open(summary) })
    expect(result.current.sessions).toEqual([])
    expect(result.current.selectedTarget).toBeNull()
  })
})
