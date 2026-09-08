// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { PionApi, SessionHistoryIndex, WireEventInput } from '../../src/shared/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })
const path = '/a/session.jsonl'
const index = (count: number, sessionPath = path): SessionHistoryIndex => ({ sessionPath, totalEntries: count * 2,
  landmarks: Array.from({ length: count }, (_, n) => ({ entryId: `entry-${n}`, entryIndex: n * 2, ordinal: n + 1, snippet: `message ${n}`, timestamp: '' })) })
const state: AgentState = { ...initialState, busy: true, timelineLoading: true,
  session: { sessionId: 'a', sessionFile: path, isStreaming: true, isCompacting: false, messageCount: 1 } }
function setup(get = vi.fn().mockResolvedValue(index(1))) {
  let deliver!: (event: WireEventInput) => void
  const off = vi.fn(), dispatch = vi.fn()
  const api = { getHistoryIndex: get, onEvent: (listener: typeof deliver) => { deliver = listener; return off } } as unknown as PionApi
  const hook = renderHook((current: AgentState) => useAgentHistory({ api, state: current, dispatch }), { initialProps: state })
  hook.result.current.timelineOwnerPath.current = path
  return { ...hook, get, off, dispatch, event: (event: WireEventInput) => deliver(event) }
}
const userEntry: WireEventInput = { type: 'entry_appended', entry: { id: 'new', type: 'message', parentId: null, timestamp: '', message: { role: 'user', content: 'new prompt' } } }

it('updates new landmarks during a busy run without reloading or jumping the timeline', async () => {
  const h = setup()
  await act(async () => { h.rerender({ ...state, timelineLoading: false }) })
  expect(h.get).toHaveBeenCalledTimes(1)
  h.get.mockResolvedValue(index(2))
  act(() => { h.event(userEntry); h.event(userEntry) })
  await act(async () => { vi.advanceTimersByTime(60) })
  expect(h.get).toHaveBeenCalledTimes(2)
  expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'historyIndex', index: index(2) })
  expect(h.dispatch.mock.calls.every(([action]) => action.type === 'historyIndex')).toBe(true)
  act(() => { for (let n = 0; n < 100; n++) h.event({ type: 'message_update', usage: null, assistantMessageEvent: { type: 'text_delta', delta: 'x' } }) })
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(h.get).toHaveBeenCalledTimes(2)
  h.event({ type: 'message_end', message: { role: 'assistant', content: 'finished' } })
  await act(async () => { vi.advanceTimersByTime(60) })
  expect(h.get).toHaveBeenCalledTimes(3)
})

it('performs a trailing refresh when another entry arrives during an in-flight request', async () => {
  let resolve!: (value: SessionHistoryIndex) => void
  const pending = new Promise<SessionHistoryIndex>((done) => { resolve = done })
  const get = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(index(2))
  const h = setup(get)
  const first = h.result.current.refreshHistoryIndex(path)
  h.event(userEntry)
  await act(async () => { vi.advanceTimersByTime(60) })
  expect(get).toHaveBeenCalledTimes(1)
  await act(async () => { resolve(index(1)); await first })
  expect(get).toHaveBeenCalledTimes(2)
  expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'historyIndex', index: index(2) })
})

it('keeps the rail on read failure and ignores replies after selecting another session', async () => {
  const h = setup(vi.fn().mockRejectedValue(new Error('temporary read failure')))
  await act(async () => { await h.result.current.refreshHistoryIndex(path) })
  expect(h.dispatch).not.toHaveBeenCalled()
  let resolve!: (value: SessionHistoryIndex) => void
  h.get.mockImplementationOnce(() => new Promise<SessionHistoryIndex>((done) => { resolve = done }))
  const pending = h.result.current.refreshHistoryIndex(path)
  h.result.current.timelineOwnerPath.current = '/b/session.jsonl'
  await act(async () => { resolve(index(1)); await pending })
  expect(h.dispatch).not.toHaveBeenCalled()
  h.unmount()
  expect(h.off).toHaveBeenCalledTimes(1)
})
