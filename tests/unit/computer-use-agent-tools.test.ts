import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSession, ExtensionCommandContext, ExtensionToolContext, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ComputerUseModelGate } from '../../src/main/agent/computer-use-model-gate'
import { createComputerUseAgentChannel, createComputerUseTools } from '../../src/main/agent/computer-use'
import { COMPUTER_USE_AGENT_TITLE_PREFIX, COMPUTER_USE_AGENT_SOURCE_FIELD, COMPUTER_USE_OBSERVE_TOOL, COMPUTER_USE_ACT_TOOL } from '../../src/shared/computer-use-agent'
import { COMPUTER_USE_MODEL_MAX_EDGE, COMPUTER_USE_UNWATCH_TIMEOUT_MS } from '../../src/main/agent/computer-use-model-gate'

function png() {
  const chunk = (kind: string, bytes: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind), bytes])
    let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length)
    const footer = Buffer.alloc(4); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, body, footer])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 200, 100, 50]))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
function fixture(enabled = true) {
  const listeners = new Set<(event: any) => void>()
  const metadata = { provider: 'openai-codex', id: 'test-vision', api: 'openai-codex-responses', input: ['text', 'image'] }
  const modelRegistry = {}
  const entries: any[] = []
  const append = vi.fn((message: unknown) => { const id = `sdk-entry-${entries.length}`; entries.push({ type: 'message', id, message }); return id })
  const manager = { getCwd: () => '/mock', getBranch: () => [...entries], getEntries: () => [...entries],
    getSessionFile: () => '/mock/session.jsonl', getSessionId: () => 'sdk-session', isPersisted: () => true, appendMessage: append
  } as unknown as SessionManager
  const command = { hasUI: true, mode: 'rpc', modelRegistry, ui: { input: vi.fn() } } as unknown as ExtensionCommandContext
  const gate = { retain: vi.fn(), assertImageDelivery: vi.fn(), retire: vi.fn() } as unknown as ComputerUseModelGate
  const models = { getPhysicalModel: vi.fn(() => metadata), getAvailableSnapshot: () => [metadata] } as unknown as ModelRuntime
  const session = { messages: [] as any[], sessionManager: manager, extensionRunner: { createCommandContext: () => command },
    getAllTools: () => [COMPUTER_USE_OBSERVE_TOOL, COMPUTER_USE_ACT_TOOL].map(name => ({ name, sourceInfo: { source: 'sdk', path: `<sdk:${name}>` } })),
    getActiveToolNames: () => [COMPUTER_USE_OBSERVE_TOOL, COMPUTER_USE_ACT_TOOL],
    subscribe: (fn: (event: any) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, dispose: vi.fn()
  } as unknown as AgentSession
  let current = true
  const channel = Object.assign(vi.fn(async (operation: string) => ({ version: 1, ok: true, operation, requestId: 'r', scopeRevision: 4, ...(operation === 'observe' ? { frameId: 'frame', width: 1, height: 1, image: { data: png(), mimeType: 'image/png' } } : {}) })), { assertObservation: vi.fn() })
  const factory = createComputerUseTools({ runtimeId: 'runtime', nonce: 'nonce', enabled, sessionManager: manager, getSession: () => session, getModels: () => models, channel: channel as never, gate, isCurrent: () => current })
  factory.attach(session)
  const observed: any[] = []
  session.subscribe(event => observed.push(event))
  const ctx = { ...command, cwd: '/mock', sessionManager: manager, model: metadata } as unknown as ExtensionToolContext
  const emit = (event: any) => { for (const fn of listeners) fn(event) }
  const start = (name = COMPUTER_USE_OBSERVE_TOOL, id = 'root-call', extra = {}) => {
    const message = { role: 'assistant', provider: metadata.provider, model: metadata.id, content: [{ type: 'toolCall', name, id, arguments: {} }] }
    ;(session.messages as any[]).push(message)
    entries.push({ type: 'message', id: `assistant-${id}`, message })
    emit({ type: 'tool_execution_start', toolName: name, toolCallId: id, args: {}, ...extra })
  }
  const execute = (name = COMPUTER_USE_OBSERVE_TOOL, params: unknown = {}, id = 'root-call', context = ctx, signal?: AbortSignal) => factory.tools.find(tool => tool.name === name)!.execute(id, params, signal, undefined, context)
  return { factory, gate, models, manager, session, command, ctx, channel, observed, entries, append, emit, start, execute, retire: () => { current = false } }
}

describe('root ComputerUse tools (synthetic SDK/Main only)', () => {
  it('registers nothing by default and never probes/requests/reads credentials while constructing or attaching', () => {
    const f = fixture(false)
    expect(f.factory.tools).toEqual([])
    expect(f.channel).not.toHaveBeenCalled()
    expect(f.models.getPhysicalModel).not.toHaveBeenCalled()
  })
  it('keeps exact model-only tools, minimal schemas and no self-reported owner/run/model fields', () => {
    const f = fixture()
    expect(f.factory.tools.map(tool => tool.name)).toEqual([COMPUTER_USE_OBSERVE_TOOL, COMPUTER_USE_ACT_TOOL])
    for (const tool of f.factory.tools) expect(tool).toMatchObject({ exposure: 'model-only', executionMode: 'sequential' })
    expect(f.factory.tools[0].parameters).toMatchObject({ additionalProperties: false, properties: {} })
    expect(Object.keys((f.factory.tools[1].parameters as any).properties)).toEqual(['frameId', 'action'])
  })
  it('requires actual root execution receipt and current SDK context; nested/spoofed/retired calls cannot issue a private request', async () => {
    const f = fixture()
    await expect(f.execute()).rejects.toThrow(/source-unverified/)
    f.start(COMPUTER_USE_OBSERVE_TOOL, 'nested', { parentToolCallId: 'other' })
    await expect(f.execute(COMPUTER_USE_OBSERVE_TOOL, {}, 'nested')).rejects.toThrow(/source-unverified/)
    f.start()
    await expect(f.execute(COMPUTER_USE_OBSERVE_TOOL, { toolCallId: 'other' })).rejects.toThrow(/invalid-request/)
    await expect(f.execute(COMPUTER_USE_OBSERVE_TOOL, {}, 'root-call', { ...f.ctx, sessionManager: {} } as never)).rejects.toThrow(/source-unverified/)
    f.retire()
    await expect(f.execute()).rejects.toThrow(/source-unverified/)
    expect(f.channel).not.toHaveBeenCalled()
  })
  it('marks only genuinely installed SDK root events with the factory incarnation receipt', () => {
    const f = fixture(); f.start()
    expect(f.observed[0][COMPUTER_USE_AGENT_SOURCE_FIELD]).toEqual({ version: 1, runtimeId: 'runtime', runtimeNonce: 'nonce', toolCallId: 'root-call' })
    f.session.getAllTools = () => [{ name: COMPUTER_USE_OBSERVE_TOOL, sourceInfo: { source: 'extension', path: 'spoof' } }] as never
    f.start(COMPUTER_USE_OBSERVE_TOOL, 'not-sdk')
    expect(f.observed[1][COMPUTER_USE_AGENT_SOURCE_FIELD]).toBeUndefined()
  })
  it('returns exactly one model image only after the durable taint gate; details are metadata-only', async () => {
    const f = fixture(); f.start()
    const result = await f.execute()
    expect(f.gate.retain).toHaveBeenCalledWith(f.ctx.model, expect.objectContaining({ operation: 'observe', requestId: 'r', scopeRevision: 4 }))
    expect(result.content.filter(part => part.type === 'image')).toHaveLength(1)
    expect(result.details).toEqual({ version: 1, frameId: 'frame', width: 1, height: 1, scopeRevision: 4, retention: 'sdk-session' })
    expect(JSON.stringify(result.details)).not.toContain(png())
    expect(f.channel).toHaveBeenCalledWith('observe', expect.objectContaining({ id: 'test-vision' }), { toolCallId: 'root-call' }, undefined)
    ;(f.gate.retain as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('disk write failed') })
    f.start(COMPUTER_USE_OBSERVE_TOOL, 'second-root')
    await expect(f.execute(COMPUTER_USE_OBSERVE_TOOL, {}, 'second-root')).rejects.toThrow(/disk write failed/)
  })
  it('does not fake coordinates if Main returns an image above the pinned SDK normalization threshold', async () => {
    const f = fixture(); f.start()
    f.channel.mockResolvedValueOnce({ version: 1, ok: true, operation: 'observe', requestId: 'r', scopeRevision: 4, frameId: 'frame', width: COMPUTER_USE_MODEL_MAX_EDGE + 1, height: 1, image: { data: png(), mimeType: 'image/png' } })
    await expect(f.execute()).rejects.toThrow(/protocol-error/)
    expect(f.gate.retain).not.toHaveBeenCalled()
  })
  it('independently blocks plan mode and hidden tools even when a stale event was emitted', async () => {
    const f = fixture(); f.start()
    f.entries.push({ type: 'custom', customType: 'plan-mode-state', data: { enabled: true } })
    await expect(f.execute()).rejects.toThrow(/permission-denied/)
    f.entries.length = 0
    f.session.getActiveToolNames = () => []
    await expect(f.execute()).rejects.toThrow(/permission-denied/)
    expect(f.channel).not.toHaveBeenCalled()
  })
  it('uses actual assistant/physical metadata; unaudited virtual routing or missing image input cannot authenticate/fallback', async () => {
    const f = fixture(); f.start()
    await expect(f.execute(COMPUTER_USE_OBSERVE_TOOL, {}, 'root-call', { ...f.ctx, model: { provider: 'router', id: 'virtual' } } as never)).rejects.toThrow(/model-unavailable/)
    expect(f.channel).not.toHaveBeenCalled()
    await f.execute()
    expect(f.models.getPhysicalModel).toHaveBeenCalledWith('openai-codex', 'test-vision')
    ;(f.models.getPhysicalModel as ReturnType<typeof vi.fn>).mockReturnValue({ provider: 'openai-codex', id: 'test-vision', input: ['text'] })
    await expect(f.execute()).rejects.toThrow(/model-unavailable/)
    expect(f.channel).toHaveBeenCalledOnce()
  })
  it('consumes frame once even on Main protected-target rejection; never retries, types Unicode, or grants focus safety', async () => {
    const f = fixture(); f.start(); await f.execute()
    f.start(COMPUTER_USE_ACT_TOOL, 'act')
    const params = { frameId: 'frame', action: { type: 'click', x: 0, y: 0, button: 'left' } }
    await expect(f.execute(COMPUTER_USE_ACT_TOOL, { frameId: 'frame', action: { type: 'type', text: '中文' } }, 'act')).rejects.toThrow(/invalid-request/)
    expect(f.channel).toHaveBeenCalledOnce()
    f.channel.mockRejectedValueOnce(new Error('ComputerUse: target-unverified'))
    await expect(f.execute(COMPUTER_USE_ACT_TOOL, params, 'act')).rejects.toThrow(/target-unverified/)
    await expect(f.execute(COMPUTER_USE_ACT_TOOL, params, 'act')).rejects.toThrow(/frame-stale/)
    expect(f.channel).toHaveBeenCalledTimes(2)
  })
  it('ignores message_end as append evidence and privately reports only a successful scanned SDK append before egress', async () => {
    const f = fixture(); f.start()
    const result = await f.execute()
    const message = { ...result, role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root-call', isError: false, timestamp: 123 } as never
    f.emit({ type: 'tool_execution_end', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root-call', result })
    f.emit({ type: 'message_end', message }) // pinned SDK emits this BEFORE append
    const signal = new AbortController().signal
    await expect(f.factory.authorizeEgress(f.ctx.model!, signal)).rejects.toThrow(/egress-revoked/)
    expect(f.channel).toHaveBeenCalledOnce()
    const entryId = f.manager.appendMessage(message) // no entry_appended follows
    await expect(f.factory.authorizeEgress(f.ctx.model!, signal)).resolves.toEqual({ scopeRevision: 4 })
    expect(f.channel).toHaveBeenNthCalledWith(2, 'retained', f.ctx.model,
      { toolCallId: 'root-call', retained: expect.objectContaining({ observationRequestId: 'r', entryId, sessionFile: '/mock/session.jsonl', sessionId: 'sdk-session', scopeRevision: 4, width: 1, height: 1 }) }, signal)
    expect(f.channel).toHaveBeenNthCalledWith(3, 'egress', f.ctx.model, {}, signal)
    expect(f.observed.some(event => event.type === 'entry_appended')).toBe(false)
  })
  it.each(['not-appended', 'append-failed', 'missing-entry', 'off-branch', 'wrong-root', 'wrong-image', 'wrong-scope', 'wrong-session'] as const)('fails closed for %s even with a successful observe response and a taint marker', async kind => {
    const f = fixture(); f.start()
    const result = await f.execute()
    const message = { ...result, role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root-call', isError: false, timestamp: 123 } as never
    f.emit({ type: 'tool_execution_end', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root-call', result })
    if (kind === 'append-failed') {
      const append = f.append.getMockImplementation()!
      f.append.mockImplementationOnce((value: unknown) => { append(value); throw new Error('SDK persist failed after tree insertion') })
      expect(() => f.manager.appendMessage(message)).toThrow(/persist failed/)
    } else if (kind === 'not-appended') f.entries.push({ type: 'message', id: 'in-memory-only', message })
    else f.manager.appendMessage(message)
    if (kind === 'missing-entry') f.entries.pop()
    if (kind === 'off-branch') f.manager.getBranch = () => f.entries.slice(0, -1)
    if (kind === 'wrong-root') f.entries[0].message.content[0].id = 'different-root'
    if (kind === 'wrong-image') f.entries.at(-1).message.content[1].data = png().replace(/.$/, 'A')
    if (kind === 'wrong-scope') f.entries.at(-1).message.details.scopeRevision++
    if (kind === 'wrong-session') f.manager.getSessionId = () => 'other-session'
    await expect(f.factory.authorizeEgress(f.ctx.model!, new AbortController().signal)).rejects.toThrow(/egress-revoked/)
    expect(f.channel).toHaveBeenCalledOnce()
  })
  it('requires Main retention ACK and rechecks the actual session/entry after the awaited report before issuing egress', async () => {
    const f = fixture(); f.start()
    const result = await f.execute()
    f.manager.appendMessage({ ...result, role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root-call', isError: false, timestamp: 123 } as never)
    f.channel.mockImplementationOnce(async () => { f.manager.getSessionFile = () => '/mock/replaced.jsonl'; return { version: 1, ok: true, operation: 'retained', requestId: 'r', scopeRevision: 4 } })
    await expect(f.factory.authorizeEgress(f.ctx.model!, new AbortController().signal)).rejects.toThrow(/egress-revoked/)
    expect(f.channel).toHaveBeenCalledTimes(2)
    expect(f.channel.mock.calls.map(call => call[0])).toEqual(['observe', 'retained'])
  })
  it('rechecks actual file/id even after pending retention was confirmed and only egress approval is awaited', async () => {
    const f = fixture(); f.start()
    const result = await f.execute()
    f.manager.appendMessage({ ...result, role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root-call', isError: false, timestamp: 123 } as never)
    const signal = new AbortController().signal
    await f.factory.authorizeEgress(f.ctx.model!, signal)
    f.channel.mockImplementationOnce(async () => { f.manager.getSessionId = () => 'late-replacement'; return { version: 1, ok: true, operation: 'egress', requestId: 'r', scopeRevision: 4 } })
    await expect(f.factory.authorizeEgress(f.ctx.model!, signal)).rejects.toThrow(/egress-revoked/)
  })
  it('rejects late replies after runtime retirement before any image can be returned', async () => {
    const f = fixture(); f.start()
    f.channel.mockImplementationOnce(async () => { f.retire(); return { version: 1, ok: true, operation: 'observe', requestId: 'r', scopeRevision: 4, frameId: 'frame', width: 1, height: 1, image: { data: png(), mimeType: 'image/png' } } })
    await expect(f.execute()).rejects.toThrow(/source-unverified/)
    expect(f.gate.retain).not.toHaveBeenCalled()
  })
})

describe('private SDK command-context channel', () => {
  it('calls actual ui.input(title, placeholder, options) with runtime identity, bounded wait and root id', async () => {
    const input = vi.fn(async (title: string) => {
      const request = JSON.parse(title.slice(COMPUTER_USE_AGENT_TITLE_PREFIX.length))
      expect(request).toMatchObject({ operation: 'egress', runtimeNonce: 'nonce', runtimeId: 'runtime', provider: 'openai-codex', modelId: 'vision' })
      expect(request).not.toHaveProperty('toolCallId')
      return JSON.stringify({ version: 1, operation: request.operation, requestId: request.requestId, ok: true, scopeRevision: 1 })
    })
    const channel = createComputerUseAgentChannel({ runtimeId: 'runtime', nonce: 'nonce', isCurrent: () => true, createContext: () => ({ mode: 'rpc', hasUI: true, ui: { input } }) as never })
    const signal = new AbortController().signal
    await channel('egress', { provider: 'openai-codex', id: 'vision' } as never, {}, signal)
    expect(input).toHaveBeenCalledWith(expect.stringContaining(COMPUTER_USE_AGENT_TITLE_PREFIX), undefined, { signal, timeout: 120_000 })
  })
  it('exports the actual outgoing watch requestId and explicitly unwatches after SDK input abort without reusing its signal', async () => {
    const active = new Set<string>()
    const input = vi.fn((title: string, _placeholder: unknown, options: { signal?: AbortSignal; timeout: number }) => {
      const request = JSON.parse(title.slice(COMPUTER_USE_AGENT_TITLE_PREFIX.length))
      if (request.operation === 'watch') {
        active.add(request.requestId)
        return new Promise<undefined>(resolve => options.signal!.addEventListener('abort', () => resolve(undefined), { once: true }))
      }
      expect(request.operation).toBe('unwatch')
      expect(options).toEqual({ signal: undefined, timeout: COMPUTER_USE_UNWATCH_TIMEOUT_MS })
      expect(active.delete(request.watchRequestId)).toBe(true)
      return Promise.resolve(JSON.stringify({ version: 1, operation: 'unwatch', requestId: request.requestId, ok: true }))
    })
    const channel = createComputerUseAgentChannel({ runtimeId: 'runtime', nonce: 'nonce', isCurrent: () => true, createContext: () => ({ mode: 'rpc', hasUI: true, ui: { input } }) as never })
    const controller = new AbortController()
    const model = { provider: 'openai-codex', id: 'vision' } as never
    const request = channel.watch(model, controller.signal)
    expect(active.has(request.watchRequestId)).toBe(true)
    controller.abort()
    await expect(request.result).rejects.toThrow(/scope-revoked/)
    expect(request.isAcknowledged()).toBe(false)
    expect(active.size).toBe(1) // the real SDK emits no cancellation RPC
    const ack = await channel('unwatch', model, { watchRequestId: request.watchRequestId })
    expect(ack.operation).toBe('unwatch')
    expect(active.size).toBe(0)
  })
  it('marks a watch ended only for a validated matching Main ACK, including an explicit negative response', async () => {
    const input = vi.fn(async (title: string) => {
      const request = JSON.parse(title.slice(COMPUTER_USE_AGENT_TITLE_PREFIX.length))
      return JSON.stringify({ version: 1, operation: 'watch', requestId: request.requestId, ok: false, error: 'busy' })
    })
    const channel = createComputerUseAgentChannel({ runtimeId: 'runtime', nonce: 'nonce', isCurrent: () => true, createContext: () => ({ mode: 'rpc', hasUI: true, ui: { input } }) as never })
    const request = channel.watch({ provider: 'openai-codex', id: 'vision' } as never, new AbortController().signal)
    expect(request.isAcknowledged()).toBe(false)
    await expect(request.result).rejects.toThrow(/busy/)
    expect(request.isAcknowledged()).toBe(true)
  })
  it('retains only this channel\'s actual successful observe object for the same physical model/runtime, not reconstructed fields', async () => {
    const model = { provider: 'openai-codex', id: 'vision' } as never
    const input = vi.fn(async (title: string) => {
      const request = JSON.parse(title.slice(COMPUTER_USE_AGENT_TITLE_PREFIX.length))
      return JSON.stringify({ version: 1, operation: 'observe', requestId: request.requestId, ok: true, scopeRevision: 4, frameId: 'frame', width: 1, height: 1, image: { data: png(), mimeType: 'image/png' } })
    })
    let current = true
    const channel = createComputerUseAgentChannel({ runtimeId: 'runtime', nonce: 'nonce', isCurrent: () => current, createContext: () => ({ mode: 'rpc', hasUI: true, ui: { input } }) as never })
    const response = await channel('observe', model, { toolCallId: 'actual-root' })
    expect(() => channel.assertObservation(model, response)).not.toThrow()
    expect(() => channel.assertObservation(model, response, 'actual-root')).not.toThrow()
    expect(() => channel.assertObservation(model, response, 'different-root')).toThrow(/source-unverified/)
    expect(() => channel.assertObservation(model, { ...response })).toThrow(/source-unverified/)
    expect(() => channel.assertObservation({ provider: 'openai-codex', id: 'other' } as never, response)).toThrow(/source-unverified/)
    expect(Object.isFrozen(response)).toBe(true)
    current = false
    expect(() => channel.assertObservation(model, response)).toThrow(/source-unverified/)
  })
  it('a cleanup timeout, wrong ACK or retired runtime is not a successful unwatch', async () => {
    const input = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(JSON.stringify({ version: 1, operation: 'unwatch', requestId: 'wrong', ok: true }))
    let current = true
    const channel = createComputerUseAgentChannel({ runtimeId: 'runtime', nonce: 'nonce', isCurrent: () => current, createContext: () => ({ mode: 'rpc', hasUI: true, ui: { input } }) as never })
    const model = { provider: 'openai-codex', id: 'vision' } as never
    await expect(channel('unwatch', model, { watchRequestId: 'watch' })).rejects.toThrow(/scope-revoked/)
    await expect(channel('unwatch', model, { watchRequestId: 'watch' })).rejects.toThrow(/protocol-error/)
    current = false
    await expect(channel('unwatch', model, { watchRequestId: 'watch' })).rejects.toThrow(/unavailable/)
    expect(input).toHaveBeenCalledTimes(2)
  })
  it('rejects missing UI/nonce, protocol mismatch and cancellation instead of assuming consent', async () => {
    const missing = createComputerUseAgentChannel({ runtimeId: 'runtime', isCurrent: () => true, createContext: () => undefined })
    await expect(missing('egress', {} as never)).rejects.toThrow(/unavailable/)
    const input = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(JSON.stringify({ version: 1, operation: 'egress', requestId: 'wrong', ok: true, scopeRevision: 1 }))
    const channel = createComputerUseAgentChannel({ runtimeId: 'runtime', nonce: 'nonce', isCurrent: () => true, createContext: () => ({ mode: 'rpc', hasUI: true, ui: { input } }) as never })
    await expect(channel('egress', { provider: 'openai-codex', id: 'vision' } as never)).rejects.toThrow(/scope-revoked/)
    await expect(channel('egress', { provider: 'openai-codex', id: 'vision' } as never)).rejects.toThrow(/protocol-error/)
  })
})
