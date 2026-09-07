import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState } from '../../src/renderer/src/agent/types'
import { deriveWorkingStatus } from '../../src/renderer/src/agent/workingStatus'
import { applyBackendEvent } from '../../src/main/agent/backend-events'
import type { BackendRecord } from '../../src/main/agent/types'

describe('agent compaction state', () => {
  it('keeps compaction events authoritative over late snapshots in either direction', () => {
    const session = { sessionId: 'a', sessionFile: '/a.jsonl', isStreaming: true, isCompacting: false, messageCount: 1 }
    const selected = reducer(initialState, { type: 'session', session })
    const started = reducer(selected, { type: 'event', event: { type: 'compaction_start', reason: 'threshold' } })
    const stale = reducer(started, { type: 'session', session })
    expect(stale).toMatchObject({ compacting: true, busy: true })
    expect(deriveWorkingStatus({ timeline: stale.timeline, mode: stale.mode, compacting: stale.compacting }).label).toBe('压缩中...')
    const ended = reducer(stale, { type: 'event', event: {
      type: 'compaction_end', reason: 'threshold', aborted: false, result: {}, willRetry: false
    } })
    expect(reducer(ended, { type: 'session', session: { ...session, isCompacting: true } }).compacting).toBe(false)
  })

  it('resets event authority on session switch and accepts a restored compaction snapshot', () => {
    const started = reducer(initialState, { type: 'event', event: { type: 'compaction_start', reason: 'manual' } })
    const cleared = reducer(started, { type: 'clearTimeline' })
    const session = { sessionId: 'b', sessionFile: '/b.jsonl', isStreaming: false, isCompacting: false, messageCount: 1 }
    const selected = reducer(cleared, { type: 'session', session })
    expect(selected.compacting).toBe(false)
    expect(reducer(selected, { type: 'session', session: { ...session, isCompacting: true } }).compacting).toBe(true)
    const event = reducer(selected, { type: 'event', event: { type: 'compaction_start', reason: 'manual' } })
    expect(reducer(event, { type: 'session', session: { ...session, sessionId: 'c', sessionFile: '/c.jsonl' } }).compacting).toBe(false)
  })

  it('keeps the run active while automatic compaction is in progress', () => {
    const afterRun = reducer({ ...initialState, busy: true }, {
      type: 'event',
      event: { type: 'agent_end', messages: [], willRetry: false }
    })
    const compacting = reducer(afterRun, {
      type: 'event',
      event: { type: 'compaction_start', reason: 'threshold' }
    })
    const compacted = reducer(compacting, {
      type: 'event',
      event: {
        type: 'compaction_end',
        reason: 'threshold',
        result: {},
        aborted: false,
        willRetry: false
      }
    })

    expect(afterRun.busy).toBe(true)
    expect(compacting).toMatchObject({ busy: true, compacting: true })
    expect(compacted).toMatchObject({ busy: true, compacting: false })
    expect(compacted.timeline.at(-1)).toMatchObject({ kind: 'compaction', summary: '上下文已压缩' })

    const settled = reducer(compacted, { type: 'event', event: { type: 'agent_settled' } })
    expect(settled).toMatchObject({ busy: false, compacting: false })
  })

  it('marks a failed automatic compaction retry as failed instead of completed', () => {
    const backend = {
      key: 'test',
      cwd: '/tmp',
      client: {},
      phase: 'running',
      busy: true,
      compacting: false,
      pendingRunIds: [],
      startPromise: Promise.resolve()
    } as unknown as BackendRecord
    const modes = new Map()

    applyBackendEvent(backend, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'length' }],
      willRetry: true
    }, modes)
    applyBackendEvent(backend, { type: 'compaction_start', reason: 'overflow' }, modes)
    applyBackendEvent(backend, {
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      errorMessage: 'quota exceeded'
    }, modes)
    const settled = applyBackendEvent(backend, { type: 'agent_settled' }, modes)

    expect(backend.completionState).toBe('failed')
    expect(settled.sessionCompleted).toBe(false)
    expect(backend.busy).toBe(false)
  })

  it('keeps a successful automatic retry in one completed run', () => {
    const backend = {
      key: 'retry-success-test',
      cwd: '/tmp',
      client: {},
      phase: 'running',
      busy: true,
      compacting: false,
      pendingRunIds: [],
      startPromise: Promise.resolve()
    } as unknown as BackendRecord
    const modes = new Map()

    applyBackendEvent(backend, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'length' }],
      willRetry: true
    }, modes)
    applyBackendEvent(backend, { type: 'compaction_start', reason: 'overflow' }, modes)
    applyBackendEvent(backend, {
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: true
    }, modes)
    applyBackendEvent(backend, { type: 'agent_start' }, modes)
    applyBackendEvent(backend, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      willRetry: false
    }, modes)
    const settled = applyBackendEvent(backend, { type: 'agent_settled' }, modes)

    expect(settled.sessionCompleted).toBe(true)
    expect(backend.completionState).toBe('completed')
  })

  it('treats failed threshold compaction as a failed run too', () => {
    const backend = {
      key: 'threshold-test',
      cwd: '/tmp',
      client: {},
      phase: 'running',
      busy: true,
      compacting: true,
      pendingRunIds: [],
      startPromise: Promise.resolve()
    } as unknown as BackendRecord
    const modes = new Map()

    applyBackendEvent(backend, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      willRetry: false
    }, modes)
    applyBackendEvent(backend, { type: 'compaction_start', reason: 'threshold' }, modes)
    applyBackendEvent(backend, {
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: false,
      errorMessage: 'summarizer unavailable'
    }, modes)
    const settled = applyBackendEvent(backend, { type: 'agent_settled' }, modes)

    expect(backend.completionState).toBe('failed')
    expect(settled.sessionCompleted).toBe(false)
  })

  it('keeps an automatic compaction retry in the same active run', () => {
    const running = reducer(initialState, { type: 'event', event: { type: 'agent_start' } })
    const retrying = reducer(running, {
      type: 'event',
      event: { type: 'agent_end', messages: [], willRetry: true }
    })
    const compacting = reducer(retrying, {
      type: 'event',
      event: { type: 'compaction_start', reason: 'overflow' }
    })
    const compacted = reducer(compacting, {
      type: 'event',
      event: {
        type: 'compaction_end',
        reason: 'overflow',
        result: {},
        aborted: false,
        willRetry: true
      }
    })
    const retried = reducer(compacted, { type: 'event', event: { type: 'agent_start' } })

    expect(retrying).toMatchObject({ busy: true, compacting: false })
    expect(compacted).toMatchObject({ busy: true, compacting: false })
    expect(retried).toMatchObject({ busy: true, compacting: false })
  })

  it('keeps the queue message text from queue_update for the composer card', () => {
    const queued = reducer(initialState, {
      type: 'event',
      event: {
        type: 'queue_update',
        steering: ['检查入口'],
        followUp: ['完成后运行测试']
      }
    })

    expect(queued.queued).toEqual({ steering: 1, followUp: 1 })
    expect(queued.queuedMessages).toEqual({
      steering: ['检查入口'],
      followUp: ['完成后运行测试'],
      nativeFollowUpCount: 0
    })

    const settled = reducer(queued, { type: 'event', event: { type: 'agent_settled' } })
    expect(settled.queuedMessages).toEqual({
      steering: ['检查入口'],
      followUp: ['完成后运行测试'],
      nativeFollowUpCount: 0
    })
  })

  it('returns to idle when manual compaction ends', () => {
    const compacting = reducer(initialState, {
      type: 'event',
      event: { type: 'compaction_start', reason: 'manual' }
    })
    const compacted = reducer(compacting, {
      type: 'event',
      event: {
        type: 'compaction_end',
        reason: 'manual',
        result: {},
        aborted: false,
        willRetry: false
      }
    })

    expect(compacted).toMatchObject({ busy: false, compacting: false })
  })
})
