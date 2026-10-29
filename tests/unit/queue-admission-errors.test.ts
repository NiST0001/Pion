import { describe, expect, it } from 'vitest'
import { projectQueueAdmissionErrors, type QueuedMessagesSnapshot, type SessionInfo } from '../../src/shared/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type AgentState } from '../../src/renderer/src/agent/types'

const scope = { cwd: '/project', sessionPath: '/project/session.jsonl', backendId: 'backend', revision: 1 }
const error = { runId: 'second', code: 'admission-failed' as const }
const queue = (revision = 1): QueuedMessagesSnapshot => ({
  steering: [], followUp: ['same', 'same'], nativeFollowUpCount: 0,
  followUpRunIds: ['first', 'second'], admissionErrors: [error], queueScope: { ...scope, revision }
})
function state(): AgentState {
  return { ...initialState, status: { phase: 'running', cwd: scope.cwd },
    liveSessionOwnerPath: scope.sessionPath, liveSessionScopeSelected: true,
    session: { sessionId: 'session', sessionFile: scope.sessionPath, messageCount: 0, isStreaming: false } }
}
function session(snapshot?: QueuedMessagesSnapshot, liveRevision = 1): SessionInfo {
  return { sessionId: 'session', sessionFile: scope.sessionPath, messageCount: 0, isStreaming: false,
    liveState: { ...scope, revision: liveRevision, events: [] }, ...(snapshot ? { queuedMessages: snapshot } : {}) }
}

describe('bounded queue admission errors', () => {
  it('projects fixed fields only, rejecting wrong IDs, unknown codes and ambiguous identities', () => {
    expect(projectQueueAdmissionErrors([{ ...error, message: '<script>secret</script>', credential: 'Bearer secret' }], ['first', 'second']))
      .toEqual([error])
    expect(projectQueueAdmissionErrors([{ ...error, code: 'Bearer secret' }], ['second'])).toEqual([])
    expect(projectQueueAdmissionErrors([error], ['first'])).toEqual([])
    expect(projectQueueAdmissionErrors([error], ['second', 'second'])).toEqual([])
    expect(projectQueueAdmissionErrors([error], [null])).toEqual([])
    expect(projectQueueAdmissionErrors(undefined, ['second'])).toEqual([])
  })

  it('uses the same run-scoped projection for push, STATE and cached live snapshots', () => {
    const pushed = reducer(state(), { type: 'event', event: { type: 'queue_update', ...queue() } })
    const loaded = reducer(state(), { type: 'session', session: session(queue()) })
    expect(pushed.queuedMessages).toEqual(loaded.queuedMessages)
    expect(loaded.queuedMessages.admissionErrors).toEqual([error])
    const cached = reducer(loaded, { type: 'session', session: session(queue()) })
    expect(cached.queuedMessages.admissionErrors).toEqual([error])
    const shifted = reducer(cached, { type: 'event', event: { type: 'queue_update', ...queue(2),
      followUp: ['same'], followUpRunIds: ['first'] } })
    expect(shifted.queuedMessages.admissionErrors).toEqual([])
  })

  it.each(['cwd', 'sessionPath', 'retired backend', 'revision'] as const)('rejects %s queue receipts', mismatch => {
    const current = reducer(state(), { type: 'event', event: { type: 'queue_update', ...queue(3), admissionErrors: [] } })
    const stale = queue(2)
    if (mismatch === 'cwd') stale.queueScope!.cwd = '/other'
    else if (mismatch === 'sessionPath') stale.queueScope!.sessionPath = '/other.jsonl'
    else if (mismatch === 'retired backend') {
      stale.queueScope!.backendId = 'old'
      current.liveSessionBackendHistory = { cwd: scope.cwd, sessionPath: scope.sessionPath, current: scope.backendId, retired: ['old'] }
    }
    const result = reducer(current, { type: 'event', event: { type: 'queue_update', ...stale } })
    expect(result.queuedMessages).toBe(current.queuedMessages)
    expect(result.queuedMessages.admissionErrors).toEqual([])
    // A newer root live revision alone never revives an older queue error.
    expect(reducer(current, { type: 'session', session: session(stale, 10) }).queuedMessages.admissionErrors).toEqual([])
  })

  it('clears missing error fields and rejects late old errors after clearing', () => {
    const current = reducer(state(), { type: 'session', session: session(queue()) })
    const clearedQueue = queue(2)
    delete clearedQueue.admissionErrors
    const cleared = reducer(current, { type: 'session', session: session(clearedQueue) })
    expect(cleared.queuedMessages.admissionErrors).toEqual([])
    expect(reducer(cleared, { type: 'event', event: { type: 'queue_update', ...queue() } }).queuedMessages.admissionErrors).toEqual([])
    expect(reducer(current, { type: 'session', session: session() }).queuedMessages.admissionErrors ?? []).toEqual([])
    const legacyQueue = queue()
    delete legacyQueue.queueScope
    const legacy = reducer(current, { type: 'event', event: { type: 'queue_update', ...legacyQueue } })
    expect(legacy.queuedMessages.followUpRunIds).toEqual(['first', 'second'])
    expect(legacy.queuedMessages.admissionErrors).toEqual([])
    expect(reducer(legacy, { type: 'event', event: { type: 'queue_update', ...queue() } }).queuedMessages.admissionErrors).toEqual([])
  })

  it('retires A-B-A backend receipts even when only local queue pushes arrived', () => {
    const first = reducer(state(), { type: 'event', event: { type: 'queue_update', ...queue() } })
    const replacement = queue(1)
    replacement.queueScope!.backendId = 'replacement'
    replacement.admissionErrors = []
    const second = reducer(first, { type: 'event', event: { type: 'queue_update', ...replacement } })
    const retired = reducer(second, { type: 'event', event: { type: 'queue_update', ...queue(100) } })
    expect(retired.queuedMessages).toBe(second.queuedMessages)
    expect(retired.queuedMessages.admissionErrors).toEqual([])
    const missingPath = queue(2)
    delete missingPath.queueScope!.sessionPath
    expect(reducer(first, { type: 'event', event: { type: 'queue_update', ...missingPath } }).queuedMessages).toBe(first.queuedMessages)
  })

  it('accepts a newer queue revision independently of an older root live snapshot', () => {
    const loaded = reducer(state(), { type: 'session', session: session(queue(1), 10) })
    const cleared = queue(2)
    delete cleared.admissionErrors
    const result = reducer(loaded, { type: 'session', session: session(cleared, 9) })
    expect(result.queuedMessages.queueScope?.revision).toBe(2)
    expect(result.queuedMessages.admissionErrors).toEqual([])
    expect(result.liveSessionRevision).toBe(10)
    expect(reducer(result, { type: 'session', session: session(queue(1), 11) }).queuedMessages.admissionErrors).toEqual([])
  })

  it.each([9, 10])('accepts a newer pushed queue receipt without rewinding root revision 10 to %i', revision => {
    const loaded = reducer(state(), { type: 'session', session: session(queue(1), 10) })
    const result = reducer(loaded, { type: 'event', event: { type: 'queue_update', ...queue(2),
      admissionErrors: [], _pionLive: { ...scope, revision } } })
    expect(result.queuedMessages.queueScope?.revision).toBe(2)
    expect(result.queuedMessages.admissionErrors).toEqual([])
    expect(result.liveSessionRevision).toBe(10)
  })

  it('keeps a newer root backend receipt when its queue projection is rejected', () => {
    const loaded = reducer(state(), { type: 'event', event: { type: 'queue_update', ...queue() } })
    const replacement = { ...scope, backendId: 'replacement', revision: 20 }
    const result = reducer(loaded, { type: 'event', event: {
      type: 'queue_update', ...queue(100), _pionLive: replacement
    } })
    expect(result.queuedMessages).toBe(loaded.queuedMessages)
    expect(result.liveSessionBackendHistory?.current).toBe('replacement')
    expect(result.liveSessionBackendHistory?.retired).toEqual(['backend'])
    const late = reducer(result, { type: 'event', event: { type: 'agent_start', _pionLive: { ...scope, revision: 30 } } })
    expect(late).toBe(result)
  })

  it.each(['STATE', 'push'] as const)('rejects a queue backend conflicting with its %s root receipt', source => {
    const incoming = queue()
    incoming.queueScope!.backendId = 'unrelated'
    const result = source === 'STATE'
      ? reducer(state(), { type: 'session', session: session(incoming) })
      : reducer(state(), { type: 'event', event: { type: 'queue_update', ...incoming, _pionLive: scope } })
    expect(result.queuedMessages.followUp).toEqual([])
    expect(result.liveSessionBackendHistory?.current).toBe(scope.backendId)
  })

  it('accepts the first persisted path from its owning STATE without an earlier SDK path', () => {
    const fresh = { ...state(), liveSessionScopeSelected: false, liveSessionOwnerPath: undefined,
      session: { sessionId: 'session', messageCount: 0, isStreaming: false } }
    const loaded = reducer(fresh, { type: 'session', session: session(queue()) })
    expect(loaded.queuedMessages.admissionErrors).toEqual([error])
  })

  it('ignores diagnostics on native, malformed or missing-identity rows', () => {
    const native = queue()
    native.nativeFollowUpCount = 2
    expect(reducer(state(), { type: 'session', session: session(native) }).queuedMessages.admissionErrors).toEqual([])
    const malformed = { ...queue(), followUp: [17, 'same'] } as unknown as QueuedMessagesSnapshot
    expect(reducer(state(), { type: 'session', session: session(malformed) }).queuedMessages).toMatchObject({
      followUp: ['same'], followUpRunIds: [null], admissionErrors: []
    })
  })
})
