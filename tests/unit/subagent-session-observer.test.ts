import { afterEach, expect, it, vi } from 'vitest'
import { SubagentSessionStore } from '../../src/main/agent/subagent-session-store'
import { createSubagentSessionPublisher } from '../../src/main/agent/subagent-session-observer'
import { SUBAGENT_SESSION_MAX_PACKET_CHARS, SUBAGENT_SESSION_RETENTION_MS, SUBAGENT_SESSION_WIDGET_KEY, type SubagentSessionNotice } from '../../src/shared/subagent-sessions'

afterEach(() => vi.useRealTimers())
function setup() {
  const packets: SubagentSessionNotice[] = []
  const setWidget = vi.fn((key: string, lines: string[]) => {
    expect(key).toBe(SUBAGENT_SESSION_WIDGET_KEY)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeLessThanOrEqual(SUBAGENT_SESSION_MAX_PACKET_CHARS)
    packets.push(JSON.parse(lines[0]))
  })
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'real-parent-id', getSessionFile: () => '/session.jsonl' }, ui: { setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'private-nonce', createContext: () => ctx })
  const observer = publisher.begin({ name: 'worker' }, 'actual-parent-tool-call')!
  return { publisher, observer, packets, setWidget, last: () => packets.at(-1)! }
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

it.each(['context-replaced', 'publication-failed'])('closes an opened observer after %s and rejects its late display callbacks', async (mode) => {
  vi.useFakeTimers()
  const setWidget = vi.fn()
  const make = () => ({ mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => '/session' }, ui: { setWidget } })
  let ctx = make()
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  const observer = publisher.begin({ name: 'worker' }, 'call')!
  observer.event(message('message_update', 'pending draft'))
  if (mode === 'context-replaced') ctx = make()
  else setWidget.mockImplementationOnce(() => { throw new Error('display unavailable') })
  vi.advanceTimersByTime(100)
  const count = setWidget.mock.calls.length
  observer.event(message('message_end', 'late text'))
  observer.running()
  observer.cancelling()
  observer.finish('completed')
  observer.finish('failed')
  vi.runAllTimers()
  expect(setWidget).toHaveBeenCalledTimes(count)
  expect(vi.getTimerCount()).toBe(0)
  publisher.halt()
})

it('display failures and malformed/hostile content never throw into execution', async () => {
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined },
    ui: { setWidget: () => { throw new Error('UI unavailable') } } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
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
  const receipt = { toolCallId: call }
  let last: SubagentSessionNotice | undefined
  const received: Array<{ notice: SubagentSessionNotice; snapshot: ReturnType<SubagentSessionStore['get']> }> = []
  const ctx = { mode: 'rpc', cwd, sessionManager: { getSessionId: () => parent, getSessionFile: () => path },
    ui: { setWidget: (widgetKey: string, widgetLines: string[]) => {
      last = JSON.parse(widgetLines[0])
      store.consume(scope, { type: 'extension_ui_request', method: 'setWidget', widgetKey, widgetLines }, (id) => id === call ? receipt : undefined)
      received.push({ notice: last!, snapshot: store.get(last!.id, 'backend') })
    } } }
  const publisher = createSubagentSessionPublisher({ nonce, createContext: () => ctx })
  try {
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

it.each(['', 'x'.repeat(257), 'bad\0identity'])('rejects invalid identity %j before publication', (invalid) => {
  const setWidget = vi.fn()
  const make = (nonce = 'nonce', cwd = '/project', parent = 'parent', path: string | undefined = '/session') => {
    const ctx = { mode: 'rpc', cwd, sessionManager: { getSessionId: () => parent, getSessionFile: () => path }, ui: { setWidget } }
    return createSubagentSessionPublisher({ nonce, createContext: () => ctx })
  }
  expect(make(invalid).begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(make('nonce', '/project', invalid).begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(make().begin({ name: 'worker' }, invalid)).toBeUndefined()
  for (const badPath of ['', 'x'.repeat(4097), 'bad\0path']) {
    expect(make('nonce', badPath).begin({ name: 'worker' }, 'call')).toBeUndefined()
    expect(make('nonce', '/project', 'parent', badPath).begin({ name: 'worker' }, 'call')).toBeUndefined()
  }
  expect(setWidget).not.toHaveBeenCalled()
})

it('falls back for invalid display names and rejects invalid tool identities without clipping', async () => {
  const h = await setup()
  for (const name of ['', 'x'.repeat(81), 'bad\0name']) {
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

it('retains 256 display slots until true terminal TTL, never evicts active/cancelling children', () => {
  let now = 0
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined },
    ui: { setWidget: vi.fn() } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', now: () => now, createContext: () => ctx })
  const first = publisher.begin({ name: 'first' }, 'call')!
  ctx.ui.setWidget.mockImplementationOnce(() => { throw new Error('display unavailable') })
  first.cancelling() // Display closure does not invent execution settlement.
  first.finish('failed')
  for (let n = 1; n < 256; n++) publisher.begin({ name: 'worker' }, 'call')!.cancelling()
  expect(publisher.begin({ name: 'overflow' }, 'call')).toBeUndefined()
  now = SUBAGENT_SESSION_RETENTION_MS - 1
  first.finish('completed') // A repeated finish cannot renew the original deadline.
  expect(publisher.begin({ name: 'early' }, 'call')).toBeUndefined()
  now++
  expect(publisher.begin({ name: 'replacement' }, 'call')).toBeDefined()
  expect(publisher.begin({ name: 'still-full' }, 'call')).toBeUndefined()
  publisher.halt()
})

it('keeps the original absent source path when the same real parent learns its display file', async () => {
  let path: string | undefined
  const setWidget = vi.fn()
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => path }, ui: { setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  const observer = publisher.begin({ name: 'worker' }, 'call')!
  path = '/session'
  expect(observer).toBeDefined()
  observer.event(message('message_end', 'final'))
  observer.finish('completed')
  const [key, lines] = setWidget.mock.calls.at(-1)! as unknown as [string, string[]]
  expect(key).toBe(SUBAGENT_SESSION_WIDGET_KEY)
  expect(JSON.parse(lines[0])).toMatchObject({ status: 'completed', parentSessionId: 'parent', rows: [{ text: 'final' }, { text: '' }] })
  expect(JSON.parse(lines[0])).not.toHaveProperty('parentSessionPath')
  publisher.halt()
})

it('captures live-getter client identity at begin and fences its later replacement', () => {
  vi.useFakeTimers()
  const setWidget = vi.fn()
  let manager = { getSessionId: () => 'parent', getSessionFile: () => undefined }
  let ui = { setWidget }
  const ctx = { mode: 'rpc', cwd: '/project', get sessionManager() { return manager }, get ui() { return ui } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  const observer = publisher.begin({ name: 'worker' }, 'call')!
  expect(setWidget).toHaveBeenCalledOnce()
  manager = { getSessionId: () => 'parent', getSessionFile: () => undefined }
  ui = { setWidget }
  observer.event(message('message_update', 'late'))
  vi.advanceTimersByTime(100)
  observer.finish('completed')
  expect(setWidget).toHaveBeenCalledOnce()
  publisher.halt()
})

it('requires RPC mode before publication', () => {
  const setWidget = vi.fn()
  const ctx = { mode: 'interactive', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined }, ui: { setWidget } }
  const publisher = createSubagentSessionPublisher({ nonce: 'nonce', createContext: () => ctx })
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeUndefined()
  expect(setWidget).not.toHaveBeenCalled()
  ctx.mode = 'rpc'
  expect(publisher.begin({ name: 'worker' }, 'call')).toBeDefined()
  publisher.halt()
})
