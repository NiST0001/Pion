import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { createConversationTiming } from '../../src/main/agent/conversation-timing'
import { PION_TURN_TIMING_TYPE, parseTurnTiming, turnTimingFromEntry } from '../../src/shared/conversation-timing'

const user = (timestamp: unknown = 1000) => ({ role: 'user' as const, content: 'same text', timestamp })
const assistant = (stopReason = 'stop') => ({ role: 'assistant', stopReason, timestamp: 1234 })
const custom = (data: unknown) => ({ type: 'custom', customType: PION_TURN_TIMING_TYPE, data })
const record = { version: 1, userEntryId: 'sdk-user', inputId: 'runtime:1', startedAt: 1000, finishedAt: 5000, durationMs: 4000, outcome: 'completed' }

afterEach(() => vi.restoreAllMocks())

function harness() {
  const branch: SessionEntry[] = []
  let sessionId = 'session-a'
  let sessionFile = '/mock/session-a.jsonl'
  let nextId: string | undefined
  const appendMessage = vi.fn(function (this: unknown, message: unknown) {
    const id = nextId ?? `sdk-${branch.length}`
    branch.push({ type: 'message', message, id, parentId: null, timestamp: 'unrelated-entry-clock' } as SessionEntry)
    return id
  })
  const manager = { getBranch: vi.fn(() => branch), getSessionId: () => sessionId, getSessionFile: () => sessionFile,
    getEntry: (id: string) => branch.find(entry => entry.id === id), appendMessage }
  const ctx = { sessionManager: manager } as unknown as ExtensionContext
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>()
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const deliver = (event: unknown) => { for (const listener of listeners) listener(event as AgentSessionEvent) }
  const append = vi.fn((customType: string, data: unknown) => {
    const entry = { type: 'custom', customType, data, id: `receipt-${branch.length}`, parentId: null, timestamp: '' } as SessionEntry
    // Same ordering as SDK: successful append first, then its real notification.
    branch.push(entry)
    deliver({ type: 'entry_appended', entry })
  })
  const api = { on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
    handlers.set(name, handler)
    return () => handlers.delete(name)
  }, appendEntry: append } as unknown as ExtensionAPI
  const subscribe = vi.fn(function (this: AgentSession, listener: (event: AgentSessionEvent) => void) {
    listeners.add(listener)
    return vi.fn(function (this: unknown) { listeners.delete(listener) })
  })
  const dispose = vi.fn(function (this: AgentSession) { listeners.clear() })
  const session = { sessionManager: manager, subscribe, dispose } as unknown as AgentSession
  const timing = createConversationTiming('runtime')
  timing.extension(api)
  timing.attach(session)
  const fire = async (type: string, event: Record<string, unknown> = {}) => { await handlers.get(type)?.({ type, ...event }, ctx) }
  const start = async (message: unknown) => {
    await fire('message_start', { message })
    deliver({ type: 'message_start', message })
  }
  const persist = (message: unknown, id = `sdk-${branch.length}`) => {
    nextId = id
    try { session.sessionManager.appendMessage(message as Parameters<typeof session.sessionManager.appendMessage>[0]) }
    finally { nextId = undefined }
  }
  const end = async (message: unknown, id?: string) => {
    await fire('message_end', { message })
    deliver({ type: 'message_end', message })
    persist(message, id)
  }
  const settle = (aborted = false) => fire('agent_settled', { aborted })
  return { branch, manager, append, appendMessage, session, subscribe, dispose, timing, deliver, fire, start, persist, end, settle,
    switchIdentity: () => { sessionId = 'session-b' }, switchFile: () => { sessionFile = '/mock/session-b.jsonl' } }
}

describe('turn timing whitelist', () => {
  it('projects only timing fields and genuine custom-entry record fields', () => {
    expect(parseTurnTiming({ ...record, secret: 'discard' })).toEqual({ startedAt: 1000, finishedAt: 5000, durationMs: 4000, outcome: 'completed' })
    expect(turnTimingFromEntry(custom({ ...record, secret: 'discard' }))).toEqual(record)
    expect(turnTimingFromEntry({ ...custom(record), type: 'message' })).toBeUndefined()
    expect(turnTimingFromEntry({ ...custom(record), customType: 'other' })).toBeUndefined()
    expect(turnTimingFromEntry(custom({ ...record, version: 2 }))).toBeUndefined()
    for (const key of ['userEntryId', 'inputId']) {
      for (const value of ['', 'x'.repeat(513), 'x\0y', 1]) expect(turnTimingFromEntry(custom({ ...record, [key]: value }))).toBeUndefined()
      expect(turnTimingFromEntry(custom({ ...record, [key]: 'x'.repeat(512) }))).toBeDefined()
    }
  })

  it('rejects false clocks, invalid durations and inconsistent differences', () => {
    for (const value of [0, -1, NaN, Infinity, -Infinity, 8.64e15 + 1, '1000', true, new Date(1000), null]) {
      expect(parseTurnTiming({ ...record, startedAt: value })).toBeUndefined()
      expect(parseTurnTiming({ ...record, finishedAt: value })).toBeUndefined()
    }
    for (const durationMs of [-1, NaN, Infinity, '4000', 0, 3999]) expect(parseTurnTiming({ ...record, durationMs })).toBeUndefined()
    expect(parseTurnTiming({ ...record, outcome: 'success' })).toBeUndefined()
    expect(parseTurnTiming([])).toBeUndefined()
    expect(parseTurnTiming(null)).toBeUndefined()
    expect(parseTurnTiming({ ...record, finishedAt: 1000, durationMs: 0 })).toBeDefined()
    expect(parseTurnTiming({ startedAt: 5000, finishedAt: 1000, outcome: 'ended' })).toEqual({ startedAt: 5000, finishedAt: 1000, outcome: 'ended' })
    expect(parseTurnTiming({ ...record, startedAt: 5000, finishedAt: 1000, durationMs: 0 })).toBeUndefined()
  })
})

describe('SDK settled timing receipts', () => {
  it('uses exact user objects/SDK IDs, survives retry starts and writes before notifying', async () => {
    const h = harness()
    expect(h.append).not.toHaveBeenCalled()
    const source = Object.freeze(user())
    const events: AgentSessionEvent[] = []
    const unsubscribe = h.session.subscribe(event => {
      events.push(event)
      if (event.type === 'entry_appended') expect(h.branch).toContain(event.entry)
    })
    await h.start(source)
    await h.end(source, 'sdk-real-user')
    await h.fire('agent_start')
    h.persist(assistant('error'))
    await h.fire('agent_end')
    await h.fire('agent_start')
    h.persist(assistant('stop'))
    await h.fire('agent_end')
    expect(h.append).not.toHaveBeenCalled()
    vi.spyOn(Date, 'now').mockReturnValue(9000)
    await h.settle()
    expect(h.append).toHaveBeenCalledExactlyOnceWith(PION_TURN_TIMING_TYPE, { ...record, userEntryId: 'sdk-real-user', finishedAt: 9000, durationMs: 8000 })
    const messageEvents = events.filter(event => event.type === 'message_start' || event.type === 'message_end')
    expect(messageEvents).toHaveLength(2)
    for (const event of messageEvents) {
      if (event.type !== 'message_start' && event.type !== 'message_end') continue
      expect(event.message).toEqual({ ...source, _pionTurnInputId: 'runtime:1' })
      expect(event.message).not.toBe(source)
    }
    expect(source).not.toHaveProperty('_pionTurnInputId')
    expect(h.branch[0]).toMatchObject({ message: source })
    expect((h.branch[0] as { message: unknown }).message).toBe(source)
    expect(h.subscribe.mock.contexts[0]).toBe(h.session)
    await h.settle()
    expect(h.append).toHaveBeenCalledTimes(1)
    const receiver = {}
    unsubscribe.call(receiver)
    expect(h.subscribe.mock.results[0].value.mock.contexts[0]).toBe(receiver)
    const before = events.length
    h.deliver({ type: 'agent_start' })
    expect(events).toHaveLength(before)
  })

  it('gives distinct equal-text/equal-clock steer inputs one final clock and independent elapsed values', async () => {
    const h = harness()
    const messages = [user(), user(), user(3000)]
    for (const message of messages) { await h.start(message); await h.end(message) }
    h.persist(assistant())
    const now = vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(now).toHaveBeenCalledTimes(1)
    expect(h.append.mock.calls.map(([, data]) => data)).toEqual(messages.map((message, index) => ({
      version: 1, userEntryId: `sdk-${index}`, inputId: `runtime:${index + 1}`, startedAt: message.timestamp,
      finishedAt: 7000, durationMs: 7000 - (message.timestamp as number), outcome: 'completed'
    })))
  })

  it.each([
    [true, 'stop', 'aborted'], [false, 'aborted', 'aborted'], [false, 'error', 'failed'],
    [false, 'length', 'ended'], [false, 'toolUse', 'ended'], [false, undefined, 'ended']
  ] as const)('classifies final aborted=%s reason=%s as %s', async (aborted, reason, outcome) => {
    const h = harness(), message = user()
    // Old successful replies provide no outcome evidence for this input.
    h.persist(assistant())
    await h.start(message)
    await h.end(message)
    if (reason !== undefined) h.persist(assistant(reason))
    vi.spyOn(Date, 'now').mockReturnValue(6000)
    await h.settle(aborted)
    expect(h.append.mock.calls[0][1]).toMatchObject({ outcome })
  })

  it('keeps rolled-back absolute clocks without a fabricated zero duration', async () => {
    const h = harness(), message = user(8000)
    await h.start(message)
    await h.end(message)
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(h.append.mock.calls[0][1]).toEqual({ version: 1, userEntryId: 'sdk-0', inputId: 'runtime:1', startedAt: 8000, finishedAt: 7000, outcome: 'ended' })
  })

  it('leaves invalid SDK/start or end clocks unknown', async () => {
    for (const [startedAt, finishedAt] of [[NaN, 5000], [0, 5000], ['1000', 5000], [1000, NaN], [1000, 0], [1000, 8.64e15 + 1]]) {
      const h = harness(), message = user(startedAt)
      await h.start(message)
      await h.end(message)
      vi.spyOn(Date, 'now').mockReturnValue(finishedAt as number)
      await h.settle()
      expect(h.append).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    }
  })

  it('requires unique same-object branch proof, with no text/time or missing-entry fallback', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    for (const proof of ['missing', 'clone', 'ambiguous', 'missing-start']) {
      const h = harness(), message = user()
      if (proof !== 'missing-start') await h.start(message)
      if (proof === 'clone') h.persist({ ...message })
      if (proof === 'ambiguous') { h.persist(message, 'a'); h.persist(message, 'b') }
      if (proof === 'missing-start') h.persist(message)
      await h.settle()
      expect(h.append).not.toHaveBeenCalled()
    }
  })

  it.each(['session_start', 'session_shutdown', 'identity', 'file'])('retires pending object refs at %s boundaries', async boundary => {
    const h = harness(), message = user()
    await h.start(message)
    await h.end(message)
    if (boundary === 'identity') h.switchIdentity()
    else if (boundary === 'file') h.switchFile()
    else await h.fire(boundary)
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(h.append).not.toHaveBeenCalled()
  })

  it('does not retry an append failure or a duplicate settled notification', async () => {
    const h = harness(), message = user()
    await h.start(message)
    await h.end(message)
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    h.append.mockImplementationOnce(() => { throw new Error('append failed') })
    await h.settle()
    await h.settle()
    await h.start(message)
    await h.settle()
    expect(h.append).toHaveBeenCalledTimes(1)
  })

  it('stops a receipt batch if its append notification crosses a session boundary', async () => {
    const h = harness()
    for (const message of [user(), user(2000)]) { await h.start(message); await h.end(message) }
    h.session.subscribe(event => {
      if (event.type === 'entry_appended') void h.fire('session_start')
    })
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(h.append).toHaveBeenCalledTimes(1)
  })

  it('skips an already recorded SDK user entry rather than replacing its clock', async () => {
    const h = harness(), message = user()
    await h.start(message)
    await h.end(message, 'sdk-user')
    h.branch.push({ ...custom(record), id: 'old-receipt', parentId: 'sdk-user', timestamp: '' } as SessionEntry)
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(h.append).not.toHaveBeenCalled()
  })

  it('keeps an outer persistence wrapper authoritative and restores SDK bases before replacement', async () => {
    const h = harness(), message = user()
    const manager = h.session.sessionManager
    const inner = manager.appendMessage
    const innerDispose = h.session.dispose
    // Model only Cua's public wrapper chain; no real Cua, model or image loads.
    const outer: typeof manager.appendMessage = function (value) {
      expect(manager.appendMessage).toBe(outer)
      return inner.call(manager, value)
    }
    manager.appendMessage = outer
    h.session.dispose = () => {
      expect(manager.appendMessage).toBe(outer)
      manager.appendMessage = inner
      innerDispose.call(h.session)
    }
    await h.start(message)
    await h.end(message)
    h.persist(assistant())
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(h.append).toHaveBeenCalledTimes(1)
    expect(manager.appendMessage).toBe(outer)
    expect(h.appendMessage.mock.contexts).toEqual([manager, manager])
    h.session.dispose()
    expect(manager.appendMessage).toBe(h.appendMessage)
    expect(h.session.subscribe).toBe(h.subscribe)
    expect(h.session.dispose).toBe(h.dispose)
    expect(h.dispose).toHaveBeenCalledExactlyOnceWith()
    expect(h.dispose.mock.contexts[0]).toBe(h.session)
    // The SDK disposes the old session before reusing this manager for a runtime.
    const replacement = { sessionManager: manager, subscribe: h.subscribe, dispose: h.dispose } as unknown as AgentSession
    createConversationTiming('replacement').attach(replacement)
    manager.appendMessage(user(2000))
    expect(h.appendMessage).toHaveBeenCalledTimes(3)
    replacement.dispose()
    expect(manager.appendMessage).toBe(h.appendMessage)
  })

  it('requires a successful append receipt even when a throwing SDK append leaves its branch entry', async () => {
    const h = harness(), message = user()
    await h.start(message)
    const failure = new Error('persist failed')
    h.appendMessage.mockImplementationOnce(value => {
      h.branch.push({ type: 'message', message: value, id: 'failed-user', parentId: null, timestamp: '' } as SessionEntry)
      throw failure
    })
    expect(() => h.persist(message)).toThrow(failure)
    expect(h.branch).toHaveLength(1)
    vi.spyOn(Date, 'now').mockReturnValue(7000)
    await h.settle()
    expect(h.append).not.toHaveBeenCalled()
    expect(h.appendMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects changed receipt entry identity and ambiguous SDK IDs', async () => {
    for (const change of ['entry', 'id', 'changed-id']) {
      const h = harness(), message = user()
      await h.start(message)
      await h.end(message)
      if (change === 'entry') h.branch[0] = { ...h.branch[0] }
      else if (change === 'changed-id') h.branch[0].id = 'rewritten-id'
      else h.branch.push({ ...h.branch[0], message: user(2000) } as SessionEntry)
      vi.spyOn(Date, 'now').mockReturnValue(7000)
      await h.settle()
      expect(h.append).not.toHaveBeenCalled()
    }
  })

  it('retires held callbacks and leaves an unrecognized outer append wrapper untouched', async () => {
    const h = harness(), listener = vi.fn()
    h.session.subscribe(listener)
    const heldCallback = h.subscribe.mock.calls[0][0]
    const manager = h.session.sessionManager
    const inner = manager.appendMessage
    const foreign: typeof manager.appendMessage = message => inner.call(manager, message)
    manager.appendMessage = foreign
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.session.dispose()
    expect(manager.appendMessage).toBe(foreign)
    expect(warning).toHaveBeenCalledTimes(1)
    heldCallback({ type: 'agent_start' })
    expect(listener).not.toHaveBeenCalled()
    manager.appendMessage(user())
    expect(h.appendMessage).toHaveBeenCalledTimes(1)
    await h.fire('session_start')
    const message = user()
    await h.start(message)
    h.persist(message)
    await h.settle()
    expect(h.append).not.toHaveBeenCalled()
  })

  it('forwards other events unchanged, attaches once, and retires SDK subscriptions on disposal', async () => {
    const h = harness(), listener = vi.fn()
    h.timing.attach(h.session)
    h.session.subscribe(listener)
    const event = { type: 'agent_start' }
    h.deliver(event)
    expect(listener).toHaveBeenCalledExactlyOnceWith(event)
    expect(listener.mock.calls[0][0]).toBe(event)
    const unknownUser = { type: 'message_end', message: user() }
    h.deliver(unknownUser)
    expect(listener.mock.calls[1][0]).toBe(unknownUser)
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    h.session.dispose()
    h.deliver(event)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
