// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../src/renderer/src/agent/types'
import type { ModelOption, PionApi } from '../../src/shared/types'

const harness = vi.hoisted(() => ({ dispatch: undefined as undefined | ((action: unknown) => void), reloadTimeline: vi.fn(async () => undefined) }))
vi.mock('../../src/renderer/src/agent/reducer', () => ({
  reducer: (state: AgentState, action: Record<string, unknown>) => {
    if (action.type === 'fixture') return { ...state, ...(action.value as Partial<AgentState>) }
    if (action.type === 'models') return { ...state, models: action.models }
    if (action.type === 'thinkingLevels') return { ...state, thinkingLevels: action.levels }
    if (action.type === 'commands') return { ...state, commands: action.commands }
    return state
  }
}))
vi.mock('../../src/renderer/src/hooks/agent/useAgentSubscriptions', () => ({
  useAgentSubscriptions: ({ dispatch }: { dispatch: typeof harness.dispatch }) => { harness.dispatch = dispatch }
}))
vi.mock('../../src/renderer/src/hooks/agent/useAgentHistory', async () => {
  const { useRef } = await import('react')
  return { useAgentHistory: ({ state }: { state: AgentState }) => {
    const selectionRef = useRef({ generation: 0, cwd: state.status.cwd, ownerPath: state.session?.sessionFile,
      sessionPath: state.session?.sessionFile, sessionId: state.session?.sessionId })
    const previous = selectionRef.current
    if (previous.cwd !== state.status.cwd || previous.sessionPath !== state.session?.sessionFile) {
      selectionRef.current = { generation: previous.generation + 1, cwd: state.status.cwd,
        ownerPath: state.session?.sessionFile, sessionPath: state.session?.sessionFile, sessionId: state.session?.sessionId }
    }
    return { selectionRef, invalidateSelection: () => { selectionRef.current.generation++ },
      timelineLoadId: useRef(0), historyIndexLoadId: useRef(0), historyIndexInFlight: useRef(null),
      historyCursor: useRef(null), timelineOwnerPath: useRef(undefined), expectedTimeline: useRef(null),
      timelineCache: useRef(new Map()), clearTimeline: vi.fn(), reloadTimeline: harness.reloadTimeline,
      switchSession: vi.fn(async () => { selectionRef.current.generation++ }),
      forkAt: vi.fn(), revertMessage: vi.fn() }
  } }
})
vi.mock('../../src/renderer/src/hooks/agent/useAgentRunActions', () => ({
  useAgentRunActions: () => ({ newSession: vi.fn(async () => undefined) })
}))
vi.mock('../../src/renderer/src/hooks/agent/useAgentSessionActions', () => ({ useAgentSessionActions: () => ({}) }))
vi.mock('../../src/renderer/src/hooks/agent/useAgentProjectActions', () => ({ useAgentProjectActions: () => ({}) }))
vi.mock('../../src/renderer/src/hooks/agent/useAgentSettingsActions', () => ({ useAgentSettingsActions: () => ({}) }))

import { useAgent } from '../../src/renderer/src/hooks/useAgent'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
function models(id: string): ModelOption[] { return [{ id, provider: 'test', name: id } as ModelOption] }
function select(cwd: string, backendId = 'backend-a') {
  act(() => harness.dispatch?.({ type: 'fixture', value: {
    status: { phase: 'running', cwd }, timelineLoading: false, liveSessionBackendId: backendId,
    session: { sessionId: 'same-sdk-id', sessionFile: `${cwd}/session.jsonl` }
  } }))
}
function setup() {
  const api = {
    getAvailableModels: vi.fn(async () => models('default')),
    getThinkingLevels: vi.fn(async () => ['off']),
    getCommands: vi.fn<PionApi['getCommands']>(async () => []),
    startAgent: vi.fn(async () => undefined),
    setModel: vi.fn(async (): Promise<void> => undefined),
    addModelProvider: vi.fn(async () => models('added'))
  }
  window.pion = api as unknown as PionApi
  return { api, ...renderHook(() => useAgent()) }
}
afterEach(() => { cleanup(); vi.useRealTimers(); delete (window as { pion?: PionApi }).pion })

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('selected model catalog scope', () => {
  it('adopts an explicitly migration-prepared fresh session without reading its not-yet-persisted history', async () => {
    const h = setup()
    select('/target'); await flush()
    harness.reloadTimeline.mockClear()
    await act(async () => h.result.current.actions.start('/target', { fresh: true }))
    expect(h.api.startAgent).toHaveBeenCalledWith('/target')
    expect(harness.reloadTimeline).not.toHaveBeenCalled()
    expect(h.result.current.state.models).toEqual(models('default'))
  })
  it('publishes models and thinking without waiting for a pending command RPC, then bounds waiting and rejects late commands', async () => {
    vi.useFakeTimers()
    const h = setup()
    const commands = deferred<Awaited<ReturnType<PionApi['getCommands']>>>()
    h.api.getCommands.mockImplementation(() => commands.promise)
    select('/a')
    await flush()
    expect(h.result.current.state.models).toEqual(models('default'))
    expect(h.result.current.state.thinkingLevels).toEqual(['off'])
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    await act(async () => { commands.resolve([{ name: 'late' }] as Awaited<ReturnType<PionApi['getCommands']>>) })
    expect(h.result.current.state.commands).toEqual([])
    expect(h.api.getAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('rejects old A replies after A -> B -> A even with the same SDK session ID', async () => {
    const h = setup()
    const oldA = deferred<ModelOption[]>()
    h.api.getAvailableModels.mockImplementationOnce(() => oldA.promise)
    select('/a'); await flush()
    select('/b'); await flush()
    select('/a'); await flush()
    await act(async () => { oldA.resolve(models('stale-a')) })
    expect(h.result.current.state.models).toEqual(models('default'))
    expect(h.api.getAvailableModels).toHaveBeenCalledTimes(3)
  })

  it('refreshes the same SDK session ID on cwd/backend replacement and fences the replaced backend', async () => {
    const h = setup()
    const oldBackend = deferred<ModelOption[]>()
    h.api.getAvailableModels.mockImplementationOnce(() => oldBackend.promise)
    select('/a', 'one'); await flush()
    select('/a', 'two'); await flush()
    await act(async () => { oldBackend.resolve(models('stale-backend')) })
    select('/b', 'two'); await flush()
    expect(h.api.getAvailableModels).toHaveBeenCalledTimes(3)
    expect(h.result.current.state.models).toEqual(models('default'))
  })

  it('invalidates pending catalog publication synchronously on new selection intent before any snapshot changes', async () => {
    const h = setup()
    const pending = deferred<ModelOption[]>()
    h.api.getAvailableModels.mockImplementationOnce(() => pending.promise)
    select('/a'); await flush()
    await act(async () => { await h.result.current.actions.newSession() })
    await act(async () => { pending.resolve(models('stale')) })
    expect(h.result.current.state.models).toEqual([])
  })

  it('does not retry an empty/failing catalog automatically on unrelated renders or phase gaps', async () => {
    const h = setup()
    h.api.getAvailableModels.mockResolvedValue([])
    select('/a'); await flush()
    act(() => harness.dispatch?.({ type: 'fixture', value: { status: { phase: 'starting', cwd: '/a' } } }))
    select('/a'); await flush()
    expect(h.api.getAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('records a failed attempt without retrying on unrelated state updates', async () => {
    const h = setup()
    h.api.getAvailableModels.mockRejectedValue(new Error('catalog unavailable'))
    select('/a'); await flush()
    act(() => harness.dispatch?.({ type: 'fixture', value: { thinkingLevels: ['high'] } }))
    await flush()
    expect(h.api.getAvailableModels).toHaveBeenCalledTimes(1)
    expect(h.result.current.state.models).toEqual([])
  })

  it('fences a replaced preload API and refreshes the unchanged selection once for its new owner', async () => {
    const h = setup()
    const pending = deferred<ModelOption[]>()
    h.api.getAvailableModels.mockImplementationOnce(() => pending.promise)
    select('/a'); await flush()
    const newApi = { ...h.api, getAvailableModels: vi.fn(async () => models('new-owner')) }
    window.pion = newApi as unknown as PionApi
    h.rerender(); await flush()
    await act(async () => { pending.resolve(models('old-owner')) })
    expect(h.result.current.state.models).toEqual(models('new-owner'))
    expect(newApi.getAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('does not start a post-setModel refresh after the original selection has changed', async () => {
    const h = setup()
    select('/a'); await flush()
    const pending = deferred<void>()
    h.api.setModel.mockImplementationOnce(() => pending.promise)
    let action!: Promise<void>
    act(() => { action = h.result.current.actions.setModel('test', 'chosen') })
    select('/b'); await flush()
    await act(async () => { pending.resolve(); await action })
    expect(h.api.getAvailableModels).toHaveBeenCalledTimes(2)
  })
})
