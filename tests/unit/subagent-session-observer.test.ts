import { afterEach, expect, it, vi } from 'vitest'
import { SubagentSessionStore } from '../../src/main/agent/subagent-session-store'
import { createSubagentSessionPublisher } from '../../src/main/agent/subagent-session-observer'
import { SUBAGENT_SESSION_ADMISSION_TITLE, SUBAGENT_SESSION_MAX_PACKET_CHARS, SUBAGENT_SESSION_RETENTION_MS, SUBAGENT_SESSION_WIDGET_KEY, type SubagentSessionNotice } from '../../src/shared/subagent-sessions'

afterEach(() => vi.useRealTimers())
async function setup() {
  const packets: SubagentSessionNotice[] = []
  const setWidget = vi.fn((key: string, lines: string[]) => {
    expect(key).toBe(SUBAGENT_SESSION_WIDGET_KEY)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeLessThanOrEqual(SUBAGENT_SESSION_MAX_PACKET_CHARS)
    packets.push(JSON.parse(lines[0]))
  })
  const input = vi.fn(async () => 'reserved')
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'real-parent-id', getSessionFile: () => '/session.jsonl' }, ui: { setWidget, input } }
  const publisher = createSubagentSessionPublisher({ nonce: 'private-nonce', createContext: () => ctx })
  expect(await publisher.reserve('actual-parent-tool-call', 2)).toBe(true)
  const observer = publisher.begin({ name: 'worker' }, 'actual-parent-tool-call')!
  return { publisher, observer, packets, setWidget, input, last: () => packets.at(-1)! }
}
const message = (type: string, text: string, thinking = '') => ({ type, message: { role: 'assistant',
  content: [{ type: 'text', text, textSignature: 'secret-signature' }, { type: 'thinking', thinking, thinkingSignature: 'secret-signature' },
    { type: 'image', data: 'secret-image' }], usage: { secret: 'secret-usage' }, systemPrompt: 'secret-system' } })

it('publishes true parent identity and independent runtime/child UUIDs only on the private widget', async () => {
  const h = await setup()
  expect(h.last()).toMatchObject({ nonce: 'private-nonce', source: 'sdk:pion_subagents', parentToolCallId: 'actual-parent-tool-call',
    parentSessionId: 'real-parent-id', parentSessionPath: '/session.jsonl', cwd: '/project', status: 'starting' })
  h.publisher.begin({ name: 'second' }, 'actual-parent-tool-call')
  expect(h.packets[0].runtimeId).toBe(h.packets[1].runtimeId)
  expect(h.packets[0].id).not.toBe(h.packets[1].id)
  expect((await setup()).last().runtimeId).not.toBe(h.last().runtimeId)
  h.publisher.halt()
})

it('coalesces full snapshots with one timer, strips unknown fields and honors empty final text/thinking', async () => {
  vi.useFakeTimers()
  const h = await setup()
  for (let n = 0; n < 1000; n++) h.observer.event(message('message_update', `draft ${n}`, 'thought'))
  expect(vi.getTimerCount()).toBe(1)
  expect(h.packets).toHaveLength(1)
  vi.advanceTimersByTime(100)
  expect(h.last().rows.map((row) => row.text)).toEqual(['draft 999', 'thought'])
  expect(h.last().rows.map((row) => row.state)).toEqual(['running', 'running'])
  expect(JSON.stringify(h.last())).not.toContain('secret')
  h.observer.event(message('message_end', ''))
  h.observer.finish('completed')
  expect(h.last().rows.map((row) => row.text)).toEqual(['', ''])
  expect(h.last().rows.map((row) => row.state)).toEqual(['completed', 'completed'])
  expect(h.last().status).toBe('completed')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([['short', 'brief'], ['', '']])('keeps shorter final fields %j authoritative on the same completed rows', async (text, thinking) => {
  vi.useFakeTimers()
  const h = await setup()
  h.observer.event({ type: 'message_start', message: { role: 'assistant' } })
  vi.advanceTimersByTime(100)
  expect(h.last().rows).toEqual([])
  h.observer.event(message('message_update', 'long draft text', 'long draft thinking'))
  vi.advanceTimersByTime(100)
  expect(h.last().rows).toEqual([
    { id: 'message-1-text', kind: 'assistant', text: 'long draft text', state: 'running' },
    { id: 'message-1-thinking', kind: 'thinking', text: 'long draft thinking', state: 'running' }
  ])
  h.observer.event(message('message_end', text, thinking))
  vi.advanceTimersByTime(100)
  expect(h.last().rows).toEqual([
    { id: 'message-1-text', kind: 'assistant', text, state: 'completed' },
    { id: 'message-1-thinking', kind: 'thinking', text: thinking, state: 'completed' }
  ])
  expect(h.last().status).toBe('starting') // Message end does not claim child settlement.
  h.observer.finish('completed')
})

it('does not graft the final assistant after a tool onto the previous assistant message', async () => {
  vi.useFakeTimers()
  const h = await setup()
  h.observer.running()
  h.observer.event({ type: 'message_start', message: { role: 'assistant', id: 'secret-sdk-id' } })
  h.observer.event(message('message_update', 'before tool', 'first thought'))
  h.observer.event(message('message_end', 'before tool', 'first thought'))
  h.observer.event({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'read',
    result: { content: [{ type: 'text', text: 'tool result' }] } })
  h.observer.event({ type: 'message_start', message: { role: 'assistant', id: 'secret-final-id' } })
  h.observer.event(message('message_update', 'final draft', 'final thought'))
  vi.advanceTimersByTime(100)
  expect(h.last().rows).toEqual([
    { id: 'message-1-text', kind: 'assistant', text: 'before tool', state: 'completed' },
    { id: 'message-1-thinking', kind: 'thinking', text: 'first thought', state: 'completed' },
    { id: 'tool-2', kind: 'tool', text: 'tool result', toolName: 'read', state: 'completed' },
    { id: 'message-3-text', kind: 'assistant', text: 'final draft', state: 'running' },
    { id: 'message-3-thinking', kind: 'thinking', text: 'final thought', state: 'running' }
  ])
  h.observer.event(message('message_end', 'final', ''))
  h.observer.finish('completed')
  expect(h.last().rows.slice(-2)).toEqual([
    { id: 'message-3-text', kind: 'assistant', text: 'final', state: 'completed' },
    { id: 'message-3-thinking', kind: 'thinking', text: '', state: 'completed' }
  ])
  expect(JSON.stringify(h.last())).not.toContain('secret')
  const count = h.packets.length
  h.observer.event(message('message_update', 'late draft', 'late thought'))
  h.observer.running()
  vi.advanceTimersByTime(100)
  expect(h.packets).toHaveLength(count)
  expect(h.last().status).toBe('completed')
})

it.each(['aborted', 'failed'] as const)('keeps interrupted draft state without inventing message completion at child %s', async (status) => {
  vi.useFakeTimers()
  const h = await setup()
  h.observer.running()
  h.observer.event(message('message_update', 'unfinished', 'unfinished thought'))
  h.observer.cancelling()
  h.observer.running()
  expect(h.last().status).toBe('cancelling')
  h.observer.finish(status)
  expect(h.last()).toMatchObject({ status, rows: [
    { kind: 'assistant', text: 'unfinished', state: 'running' },
    { kind: 'thinking', text: 'unfinished thought', state: 'running' }
  ] })
  const count = h.packets.length
  h.observer.event(message('message_end', 'late final'))
  h.observer.running()
  h.observer.finish('completed')
  vi.advanceTimersByTime(100)
  expect(h.packets).toHaveLength(count)
  expect(h.last().status).toBe(status)
})

it('only projects tool text and never args, details, structured content, image or usage payloads', async () => {
  vi.useFakeTimers()
  const h = await setup()
  h.observer.event({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: { content: 'secret-args' } })
  h.observer.event({ type: 'tool_execution_update', toolCallId: 'call', toolName: 'read', partialResult: {
    content: [{ type: 'text', text: 'draft' }, { type: 'image', data: 'secret-image' }], details: 'secret-details' } })
  h.observer.event({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'read', isError: true,
    result: { content: [{ type: 'text', text: '' }], structuredContent: 'secret-structured', usage: 'secret-usage' } })
  h.observer.finish('failed')
  expect(h.last().rows).toEqual([{ id: expect.any(String), kind: 'tool', toolName: 'read', state: 'failed', text: '' }])
  expect(JSON.stringify(h.last())).not.toContain('secret')
})

it('bounds rows, fields, aggregate characters and escaped JSON with explicit truncation', async () => {
  const h = await setup()
  for (let n = 0; n < 500; n++) {
    h.observer.event({ type: 'tool_execution_end', toolCallId: `call-${n}`, toolName: 'bash',
      result: { content: [{ type: 'text', text: '\u0000'.repeat(9000) }] } })
  }
  h.observer.finish('completed')
  expect(h.last().truncated).toBe(true)
  expect(h.last().rows.length).toBeLessThanOrEqual(200)
  expect(h.last().rows.every((row) => row.text.length <= 8192)).toBe(true)
  expect(h.last().rows.reduce((n, row) => n + row.text.length + row.id.length + (row.toolName?.length ?? 0), 0)).toBeLessThanOrEqual(64 * 1024)
})

it('shutdown publishes cancelling rather than a false terminal and fences all late callbacks', async () => {
  vi.useFakeTimers()
  const h = await setup()
  h.observer.running()
  h.publisher.halt()
  expect(h.last().status).toBe('cancelling')
  const count = h.packets.length
  h.observer.event(message('message_end', 'late'))
  h.observer.finish('completed')
  vi.runAllTimers()
  expect(h.packets).toHaveLength(count)
  expect(h.publisher.begin({ name: 'late-child' }, 'call')).toBeUndefined()
})

it('display failures and malformed/hostile content never throw into execution', async () => {
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined },
    ui: { input: async () => 'reserved', setWidget: () => { throw new Error('UI unavailable') } } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  expect(await publisher.reserve('call', 1)).toBe(true)
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeUndefined()
  const h = await setup()
  const observer = h.observer
  h.setWidget.mockImplementation(() => { throw new Error('UI unavailable') })
  const hostile = { get type() { throw new Error('hostile getter') } }
  expect(() => { observer.event(hostile); observer.event(null); observer.running(); observer.cancelling(); observer.finish('failed'); h.publisher.halt(); publisher.halt() }).not.toThrow()
  expect(createSubagentSessionPublisher({ nonce: undefined, createContext: () => undefined }).begin({ name: 'worker' }, 'call')).toBeUndefined()
})


it('publishes store-accepted packets at identity/tool/text bounds without truncating identity', async () => {
  const store = new SubagentSessionStore()
  const cwd = 'c'.repeat(4096), path = 'p'.repeat(4096), nonce = 'n'.repeat(256)
  const parent = 's'.repeat(256), call = 't'.repeat(256)
  const scope = { backendId: 'backend', nonce, cwd, parentSessionPath: path }
  let last: SubagentSessionNotice | undefined
  const received: Array<{ notice: SubagentSessionNotice; snapshot: ReturnType<SubagentSessionStore['get']> }> = []
  const ctx = { mode: 'rpc', cwd, sessionManager: { getSessionId: () => parent, getSessionFile: () => path },
    ui: { input: async (_title: string, metadata?: string) => store.reserveBatch(scope, JSON.parse(metadata!), (id) => id === call) ? 'reserved' : 'denied',
      setWidget: (widgetKey: string, widgetLines: string[]) => {
      last = JSON.parse(widgetLines[0])
      store.consume(scope, { type: 'extension_ui_request', method: 'setWidget', widgetKey, widgetLines }, (id) => id === call)
      received.push({ notice: last!, snapshot: store.get(last!.id, 'backend') })
    } } }
  const publisher = createSubagentSessionPublisher({ nonce, createContext: () => ctx })
  try {
    expect(await publisher.reserve(call, 1)).toBe(true)
    const observer = publisher.begin({ name: 'w'.repeat(80) }, call)!
    expect(observer).toBeDefined()
    for (let n = 0; n < 220; n++) observer.event({ type: 'tool_execution_end', toolCallId: `${n}`,
      toolName: 'x'.repeat(256), result: { content: [{ type: 'text', text: 'a'.repeat(8192) }] } })
    observer.event(message('message_update', '\u0000'.repeat(8192), '\u0000'.repeat(8192)))
    observer.cancelling() // Immediate full draft packet exercises running row states and escaped bounds.
    observer.event(message('message_end', 'final', ''))
    observer.finish('completed')
    expect(received.length).toBeGreaterThanOrEqual(2)
    for (const { notice, snapshot } of received) {
      expect(JSON.stringify(notice).length).toBeLessThanOrEqual(128 * 1024)
      expect(notice.rows.reduce((n, row) => n + row.id.length + row.kind.length + row.text.length
        + (row.toolName?.length ?? 0) + (row.state?.length ?? 0), 0)).toBeLessThanOrEqual(64 * 1024)
      expect(snapshot).toMatchObject({ revision: notice.revision, rows: notice.rows })
    }
    expect(received.at(-2)!.notice.rows.slice(-2).map((row) => row.state)).toEqual(['running', 'running'])
    expect(last!.rows.slice(-2).map((row) => row.state)).toEqual(['completed', 'completed'])
    expect(last).toMatchObject({ cwd, parentSessionPath: path, nonce, parentSessionId: parent, parentToolCallId: call })
    expect(last!.rows.length).toBeGreaterThan(0)
    expect(last!.rows.reduce((n, row) => n + row.id.length + row.text.length + (row.toolName?.length ?? 0), 0)).toBeLessThanOrEqual(65536)
  } finally { publisher.halt(); store.dispose() }
})

it.each(['', 'x'.repeat(257), 'bad\0identity'])('rejects invalid identity %j before requesting admission/publication', async (invalid) => {
  const setWidget = vi.fn(), input = vi.fn(async () => 'reserved')
  const make = (nonce = 'nonce', cwd = '/project', parent = 'parent', path: string | undefined = '/session') => {
    const ctx = { mode: 'rpc', cwd, sessionManager: { getSessionId: () => parent, getSessionFile: () => path }, ui: { setWidget, input } }
    return createSubagentSessionPublisher({ nonce, createContext: () => ctx })
  }
  expect(await make(invalid).reserve('call', 1)).toBe(false)
  expect(await make('nonce', '/project', invalid).reserve('call', 1)).toBe(false)
  expect(await make().reserve(invalid, 1)).toBe(false)
  for (const badPath of ['', 'x'.repeat(4097), 'bad\0path']) {
    expect(await make('nonce', badPath).reserve('call', 1)).toBe(false)
    expect(await make('nonce', '/project', 'parent', badPath).reserve('call', 1)).toBe(false)
  }
  expect(input).not.toHaveBeenCalled()
  expect(setWidget).not.toHaveBeenCalled()
})

it('falls back for invalid display names and rejects invalid tool identities without clipping', async () => {
  const h = await setup()
  for (const name of ['', 'x'.repeat(81), 'bad\0name']) {
    expect(await h.publisher.reserve('call', 1)).toBe(true)
    h.publisher.begin({ name }, 'call')!.finish('failed')
    expect(h.last().name).toBe('子代理')
  }
  for (const invalid of ['', 'x'.repeat(257), 'bad\0tool']) {
    h.observer.event({ type: 'tool_execution_start', toolCallId: invalid, toolName: 'read' })
    h.observer.event({ type: 'tool_execution_start', toolCallId: 'call', toolName: invalid })
  }
  h.observer.finish('failed')
  expect(h.last().rows).toEqual([])
  h.publisher.halt()
})

it('retains 256 admission slots until true terminal TTL, never evicts active/cancelling children', async () => {
  let now = 0
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined },
    ui: { setWidget: vi.fn(), input: vi.fn(async () => 'reserved') } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', now: () => now, createContext: () => ctx })
  expect(await publisher.reserve('call', 1)).toBe(true)
  const first = publisher.begin({ name: 'first' }, 'call')!
  first.finish('failed')
  for (let n = 1; n < 256; n++) {
    if (n === 255) expect(await publisher.reserve('call', 2)).toBe(false)
    expect(await publisher.reserve('call', 1)).toBe(true)
    publisher.begin({ name: 'worker' }, 'call')!.cancelling()
  }
  expect(await publisher.reserve('call', 1)).toBe(false)
  expect(publisher.begin({ name: 'overflow' }, 'call')).toBeUndefined()
  now = SUBAGENT_SESSION_RETENTION_MS - 1
  expect(await publisher.reserve('call', 1)).toBe(false)
  expect(publisher.begin({ name: 'early' }, 'call')).toBeUndefined()
  now++
  expect(await publisher.reserve('call', 1)).toBe(true)
  expect(publisher.begin({ name: 'replacement' }, 'call')).toBeDefined()
  expect(await publisher.reserve('call', 1)).toBe(false)
  expect(publisher.begin({ name: 'still-full' }, 'call')).toBeUndefined()
  expect(ctx.ui.input).toHaveBeenCalledTimes(257)
  publisher.halt()
})

it('requires a reserved ACK and consumes the exact admitted count only for the captured parent', async () => {
  const setWidget = vi.fn(), input = vi.fn(async () => 'reserved')
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => '/session' }, ui: { input, setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  expect(publisher.begin({ name: 'early' }, 'call')).toBeUndefined()
  for (const count of [0, 9, 1.5, NaN]) expect(await publisher.reserve('call', count)).toBe(false)
  expect(input).not.toHaveBeenCalled()
  expect(await publisher.reserve('call', 2)).toBe(true)
  expect(input).toHaveBeenCalledOnce()
  const [title, placeholder, options] = input.mock.calls[0] as unknown as [string, string, { signal: AbortSignal; timeout: number }]
  expect(title).toBe(SUBAGENT_SESSION_ADMISSION_TITLE)
  expect(JSON.parse(placeholder)).toEqual({ version: 1, nonce: 'nonce', runtimeId: expect.any(String), parentToolCallId: 'call', count: 2 })
  expect(options).toMatchObject({ signal: expect.any(AbortSignal), timeout: 5000 })
  expect(publisher.begin({ name: 'wrong-parent' }, 'other')).toBeUndefined()
  expect(publisher.begin({ name: 'one' }, 'call')).toBeDefined()
  expect(publisher.begin({ name: 'two' }, 'call')).toBeDefined()
  expect(publisher.begin({ name: 'reused' }, 'call')).toBeUndefined()
  expect(setWidget).toHaveBeenCalledTimes(2)
  publisher.halt()
})

it.each(['denied', undefined, 'unexpected'])('does not publish after non-reserved reply %s', async (reply) => {
  const setWidget = vi.fn(), input = vi.fn(async () => reply)
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined }, ui: { input, setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  expect(await publisher.reserve('call', 1)).toBe(false)
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(setWidget).not.toHaveBeenCalled()
})

it.each(['timeout', 'abort', 'halt'])('fences pending admission and late reserved reply after %s', async (mode) => {
  vi.useFakeTimers()
  let respond!: (value: string) => void
  const input = vi.fn(() => new Promise<string>((resolve) => { respond = resolve }))
  const setWidget = vi.fn()
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined }, ui: { input, setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  const controller = new AbortController()
  const admission = publisher.reserve('call', 2, controller.signal)
  expect(await publisher.reserve('another', 1)).toBe(false)
  expect(publisher.begin({ name: 'pending' }, 'call')).toBeUndefined()
  if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5000)
  if (mode === 'abort') controller.abort()
  if (mode === 'halt') publisher.halt()
  expect(await admission).toBe(false)
  respond('reserved')
  await Promise.resolve()
  expect(publisher.begin({ name: 'late' }, 'call')).toBeUndefined()
  expect(input).toHaveBeenCalledOnce()
  expect(setWidget).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['before-ack', 'after-ack'])('fails closed for a parent context replacement %s', async (when) => {
  let respond!: (value: string) => void
  const input = vi.fn(() => new Promise<string>((resolve) => { respond = resolve }))
  const setWidget = vi.fn()
  const make = () => ({ mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined }, ui: { input, setWidget } })
  let ctx = make()
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  const admission = publisher.reserve('call', 1)
  if (when === 'before-ack') ctx = make()
  respond('reserved')
  expect(await admission).toBe(when === 'after-ack')
  if (when === 'after-ack') ctx = make()
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(setWidget).not.toHaveBeenCalled()
})

it('fails closed without the real SDK input method and never reuses a failed starting publication', async () => {
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined }, ui: { setWidget: vi.fn() } }
  const missing = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  expect(await missing.reserve('call', 1)).toBe(false)
  const ready = { ...ctx, ui: { ...ctx.ui, input: async () => 'reserved' } }
  ready.ui.setWidget.mockImplementationOnce(() => { throw new Error('unavailable') })
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ready })
  expect(await publisher.reserve('call', 1)).toBe(true)
  expect(publisher.begin({ name: 'first' }, 'call')).toBeUndefined()
  expect(publisher.begin({ name: 'retry' }, 'call')).toBeUndefined()
  expect(ready.ui.setWidget).toHaveBeenCalledOnce()
})

it('captures live-getter client identity before ACK instead of resolving its replacement afterward', async () => {
  let respond!: (value: string) => void
  const input = vi.fn(() => new Promise<string>((resolve) => { respond = resolve }))
  const setWidget = vi.fn()
  let manager = { getSessionId: () => 'parent', getSessionFile: () => undefined }
  let ui = { input, setWidget }
  const ctx = { mode: 'rpc', cwd: '/project', get sessionManager() { return manager }, get ui() { return ui } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  const admission = publisher.reserve('call', 1)
  manager = { getSessionId: () => 'parent', getSessionFile: () => undefined }
  ui = { input, setWidget }
  respond('reserved')
  expect(await admission).toBe(false)
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(setWidget).not.toHaveBeenCalled()
})

it('requires RPC mode and fences an admitted token aborted before begin', async () => {
  const input = vi.fn(async () => 'reserved'), setWidget = vi.fn()
  const ctx = { mode: 'interactive', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined }, ui: { input, setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  expect(await publisher.reserve('call', 1)).toBe(false)
  expect(input).not.toHaveBeenCalled()
  ctx.mode = 'rpc'
  const controller = new AbortController()
  expect(await publisher.reserve('call', 1, controller.signal)).toBe(true)
  controller.abort()
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(setWidget).not.toHaveBeenCalled()
})
