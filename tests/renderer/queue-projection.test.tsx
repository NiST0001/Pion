import { describe, expect, it } from 'vitest'
import { projectQueueSnapshot } from '../../src/main/agent/queue-projection'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState } from '../../src/renderer/src/agent/types'

describe('queue edit identity projection', () => {
  it('keeps native null identities and distinct local ids parallel to duplicate strings', () => {
    const { queue } = projectQueueSnapshot({ steering: [], followUp: ['same'] }, [],
      ['same', 'same', '（图像消息）'], ['one', 'two', 'image'])
    expect(queue.followUpRunIds).toEqual([null, 'one', 'two', 'image'])
    const state = reducer(initialState, { type: 'event', event: { type: 'queue_update', ...queue } })
    expect(state.queuedMessages.followUpRunIds).toEqual([null, 'one', 'two', 'image'])
  })

  it('restores actual queue ids from a session snapshot and does not invent old-snapshot ids', () => {
    const queuedMessages = { steering: [], followUp: ['same', 'same'], nativeFollowUpCount: 0,
      followUpRunIds: ['one', 'two'] }
    const state = reducer(initialState, { type: 'session', session: {
      sessionId: 'session', sessionFile: '/session.jsonl', isStreaming: false, messageCount: 1, queuedMessages
    } })
    expect(state.queuedMessages).toEqual(queuedMessages)
    expect(state.queued.followUp).toBe(2)
    const legacy = reducer(state, { type: 'event', event: {
      type: 'queue_update', steering: [], followUp: ['same', 'same']
    } })
    expect(legacy.queuedMessages.followUpRunIds).toEqual([null, null])
  })
})
