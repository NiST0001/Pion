// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/types'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import { useAgentRunActions } from '../../src/renderer/src/hooks/agent/useAgentRunActions'

afterEach(cleanup)
const cwd = '/project/a', sessionFile = '/sessions/a.jsonl'
function selectedState(): AgentState {
  return { ...initialState, status: { phase: 'running', cwd },
    session: { sessionId: 'session-a', sessionFile, isStreaming: true, messageCount: 1 },
    queuedMessages: { steering: [], followUp: ['same', 'same'], nativeFollowUpCount: 0,
      followUpRunIds: ['first-run', 'second-run'] } }
}
function setup() {
  const send = vi.fn(async () => {}), remove = vi.fn(async () => {}), refreshModels = vi.fn(async () => {})
  const api = { sendQueuedMessage: send, removeQueuedMessage: remove } as unknown as PionApi
  const options: Omit<Parameters<typeof useAgentRunActions>[0], 'api' | 'state'> = {
    dispatch: vi.fn(), refreshModels, optimisticSessionTimers: { current: new Map() },
    timelineLoadId: { current: 0 }, historyIndexLoadId: { current: 0 },
    historyIndexInFlight: { current: null }, historyCursor: { current: null },
    timelineCache: { current: new Map() }, timelineOwnerPath: { current: sessionFile },
    expectedTimeline: { current: null }, reloadTimeline: vi.fn(async () => {})
  }
  const hook = renderHook(({ state, currentApi }) => useAgentRunActions({ ...options, api: currentApi, state }), {
    initialProps: { state: selectedState(), currentApi: api as PionApi | undefined }
  })
  return { ...hook, api, send, remove, refreshModels }
}

describe('queued message identity actions', () => {
  it.each(['sendQueuedMessage', 'removeQueuedMessage'] as const)('%s uses the captured run even when its old position now belongs to another row', async (method) => {
    const h = setup()
    const state = selectedState()
    state.queuedMessages = { steering: [], followUp: ['same', 'same'], nativeFollowUpCount: 0,
      followUpRunIds: ['second-run', 'replacement-run'] }
    h.rerender({ state, currentApi: h.api })
    await act(async () => { await h.result.current[method]('followUp', 1, 'second-run') })
    expect(method === 'sendQueuedMessage' ? h.send : h.remove).toHaveBeenCalledExactlyOnceWith({
      runId: 'second-run', cwd, sessionFile
    })
    expect(h.refreshModels).toHaveBeenCalledTimes(method === 'sendQueuedMessage' ? 1 : 0)
  })

  it.each(['sendQueuedMessage', 'removeQueuedMessage'] as const)('%s keeps the captured session scope and propagates a stale-run rejection', async (method) => {
    const h = setup(), captured = h.result.current[method]
    const state = selectedState()
    state.status = { phase: 'running', cwd: '/project/b' }
    state.session = { ...state.session!, sessionId: 'session-b', sessionFile: '/sessions/b.jsonl' }
    h.rerender({ state, currentApi: h.api })
    const error = new Error('会话已切换，请刷新排队消息后重试')
    const stub = method === 'sendQueuedMessage' ? h.send : h.remove
    stub.mockRejectedValueOnce(error)
    await expect(captured('followUp', 0, 'first-run')).rejects.toBe(error)
    expect(stub).toHaveBeenCalledExactlyOnceWith({ runId: 'first-run', cwd, sessionFile })
    expect(h.refreshModels).not.toHaveBeenCalled()
  })

  it.each(['sendQueuedMessage', 'removeQueuedMessage'] as const)('%s skips native steering, invalid positions and missing identities', async (method) => {
    const h = setup(), action = h.result.current[method]
    await action('steering', 0, 'native-already-dispatched')
    await action('followUp', -1, 'first-run')
    await action('followUp', 0.5, 'first-run')
    await action('followUp', 0, '')
    await action('followUp', 0, '   ')
    // Older consumers may omit the newly required identity at runtime.
    await action('followUp', 0, undefined as unknown as string)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.refreshModels).not.toHaveBeenCalled()
  })

  it.each(['sendQueuedMessage', 'removeQueuedMessage'] as const)('%s skips missing API, cwd or session without deriving another target', async (method) => {
    const h = setup()
    for (const state of [
      { ...selectedState(), status: { phase: 'stopped' as const } },
      { ...selectedState(), session: null }
    ]) {
      h.rerender({ state, currentApi: h.api })
      await h.result.current[method]('followUp', 0, 'first-run')
    }
    h.rerender({ state: selectedState(), currentApi: undefined })
    await h.result.current[method]('followUp', 0, 'first-run')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.refreshModels).not.toHaveBeenCalled()
  })
})
