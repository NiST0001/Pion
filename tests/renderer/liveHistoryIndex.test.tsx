// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { PionApi, SessionHistoryIndex, WireEventInput } from '../../src/shared/types'

const path = '/a/session.jsonl'
const index = (count: number, sessionPath = path): SessionHistoryIndex => ({
  sessionPath, leafId: `leaf-${count}`, totalEntries: count * 2,
  landmarks: Array.from({ length: count }, (_, n) => ({ entryId: `entry-${n}`, entryIndex: n * 2, ordinal: n + 1, snippet: `message ${n}`, timestamp: '' }))
})
const state: AgentState = {
  ...initialState, busy: true, timelineLoading: true,
  status: { phase: 'running', cwd: '/a' },
  session: { sessionId: 'a', sessionFile: path, isStreaming: true, isCompacting: false, messageCount: 1 }
}
function setup(get = vi.fn().mockResolvedValue(index(1)), seed = state) {
  let deliver!: (event: WireEventInput) => void
  const off = vi.fn(), dispatch = vi.fn()
  const api = { getHistoryIndex: get, onEvent: (listener: typeof deliver) => { deliver = listener; return off } } as unknown as PionApi
  const hook = renderHook((current: AgentState) => useAgentHistory({ api, state: current, dispatch }), { initialProps: seed })
  return { ...hook, get, off, dispatch, event: (event: WireEventInput) => deliver(event) }
}
const userEntry: WireEventInput = { type: 'entry_appended', entry: { id: 'new', type: 'message', parentId: null, timestamp: '', message: { role: 'user', content: 'new prompt' } } }

// This file is also imported by the coverage aggregate; fake timers and
// cleanup must not affect sibling suites.
describe('live history index', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('updates new landmarks during a busy run without reloading or jumping the timeline', async () => {
    const h = setup()
    expect(h.result.current.timelineOwnerPath.current).toBe(path)
    await act(async () => { h.rerender({ ...state, timelineLoading: false }) })
    expect(h.get).toHaveBeenCalledTimes(1)
    h.get.mockResolvedValue(index(2))
    act(() => { h.event(userEntry); h.event(userEntry) })
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(h.get).toHaveBeenCalledTimes(2)
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'historyIndex', index: index(2) })
    expect(h.dispatch.mock.calls.every(([action]) => action.type === 'historyIndex')).toBe(true)
    act(() => {
      for (let n = 0; n < 100; n++) {
        h.event({ type: 'message_update', usage: null, assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
        h.event({ type: 'message_update', usage: null, assistantMessageEvent: { type: 'thinking_delta', delta: 'x' } })
        h.event({ type: 'tool_execution_update', toolCallId: 'tool', toolName: 'bash', partialResult: 'x' })
      }
    })
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

  it('coalesces all persisted leaf changes even when no visible landmark was added', async () => {
    const metadataIndex = { ...index(1), leafId: 'metadata-leaf' }
    const h = setup(vi.fn().mockResolvedValue(metadataIndex))
    act(() => {
      for (const type of ['custom', 'thinking_level_change', 'model_change', 'session_info', 'branch_summary', 'label']) {
        h.event({ type: 'entry_appended', entry: {
          type, id: `entry-${type}`, parentId: 'leaf-1', timestamp: '',
          customType: 'pion-subagents-state', data: { enabled: false }
        } })
      }
      h.event({ type: 'entry_appended', entry: {
        type: 'message', id: 'tool-result', parentId: 'leaf-1', timestamp: '',
        message: { role: 'toolResult', content: 'done' }
      } })
      h.event({ type: 'thinking_level_changed', level: 'high' })
      h.event({ type: 'session_info_changed', name: 'renamed' })
      h.event({ type: 'model_changed', model: { id: 'other' } })
    })
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(h.get).toHaveBeenCalledTimes(1)
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'historyIndex', index: metadataIndex })
  })

  it('coalesces snapshot metadata updates received while the index is still loading', async () => {
    let resolve!: (value: SessionHistoryIndex) => void
    const pending = new Promise<SessionHistoryIndex>((done) => { resolve = done })
    const metadataIndex = { ...index(1), leafId: 'metadata-leaf' }
    const h = setup(vi.fn().mockReturnValueOnce(pending).mockResolvedValue(metadataIndex))
    const first = h.result.current.refreshHistoryIndex(path)
    const ready = { ...state, timelineLoading: false }
    act(() => h.rerender({ ...ready, session: { ...state.session!, thinkingLevel: 'high' } }))
    act(() => h.rerender({ ...ready, session: { ...state.session!, sessionName: 'renamed', subagentsEnabled: false } }))
    act(() => h.rerender({ ...ready, session: { ...state.session!, provider: 'other', modelId: 'other' } }))
    expect(h.get).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(index(1)); await first })
    expect(h.get).toHaveBeenCalledTimes(2)
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'historyIndex', index: metadataIndex })
    expect(h.dispatch.mock.calls.every(([action]) => action.type === 'historyIndex')).toBe(true)
  })

  it('refreshes the leaf at cold-start completion even if snapshot metadata is unchanged', async () => {
    const startupIndex = { ...index(1), leafId: 'startup-custom-leaf' }
    const starting: AgentState = {
      ...state, timelineLoading: false, historyIndex: index(1),
      status: { phase: 'starting', cwd: '/a' }
    }
    const h = setup(vi.fn().mockResolvedValue(startupIndex), starting)
    expect(h.get).not.toHaveBeenCalled()
    await act(async () => h.rerender({ ...starting, status: { phase: 'running', cwd: '/a' } }))
    expect(h.result.current.timelineOwnerPath.current).toBe(path)
    expect(h.get).toHaveBeenCalledExactlyOnceWith(path)
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'historyIndex', index: startupIndex })
  })

  it.each(['entry', 'snapshot'] as const)('retries an allocated but initially unpersisted live session on its first persisted %s', async (trigger) => {
    const fresh: AgentState = { ...state, timelineLoading: false, session: { ...state.session!, messageCount: 0 } }
    const get = vi.fn().mockRejectedValueOnce(new Error('not yet written')).mockResolvedValue(index(1))
    const h = setup(get, fresh)
    await act(async () => { await h.result.current.historyIndexInFlight.current?.promise })
    expect(h.result.current.timelineOwnerPath.current).toBe(path)
    expect(h.dispatch).not.toHaveBeenCalled()
    await act(async () => {
      if (trigger === 'entry') {
        h.event(userEntry)
        vi.advanceTimersByTime(60)
      } else h.rerender({ ...fresh, session: { ...fresh.session!, messageCount: 1 } })
    })
    expect(get).toHaveBeenCalledTimes(2)
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'historyIndex', index: index(1) })
  })

  it('retains logical ownership and event refreshes through a missing/error session snapshot', async () => {
    const h = setup()
    const selection = h.result.current.selectionRef.current
    act(() => h.rerender({ ...state, session: null, status: { phase: 'error', error: 'restart failed' } }))
    expect(h.result.current.selectionRef.current).toBe(selection)
    act(() => h.event({ type: 'entry_appended', entry: {
      type: 'custom', id: 'restart-leaf', parentId: 'leaf-1', timestamp: '', customType: 'pion-subagents-state'
    } }))
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(h.get).toHaveBeenCalledExactlyOnceWith(path)
    expect(h.off).not.toHaveBeenCalled()
  })

  it('still accepts older index snapshots without a leaf field', async () => {
    const legacy = index(1)
    delete legacy.leafId
    const h = setup(vi.fn().mockResolvedValue(legacy))
    await act(async () => { await h.result.current.refreshHistoryIndex(path) })
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'historyIndex', index: legacy })
  })
})
