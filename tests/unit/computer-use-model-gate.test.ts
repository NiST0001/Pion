import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import { AgentSession, ModelRuntime, type SessionEntry, type SessionManager, type SettingsManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createAssistantMessageEventStream, normalizeContext, type Api, type AssistantMessage, type Model, type ToolResultMessage } from '@earendil-works/pi-ai'
import { computerUseHistoryState, createComputerUseModelGate, COMPUTER_USE_TAINT_ENTRY, COMPUTER_USE_UNWATCH_TIMEOUT_MS } from '../../src/main/agent/computer-use-model-gate'
import type { ComputerUseAgentResponse } from '../../src/shared/computer-use-agent'

const io = vi.hoisted(() => ({ open: vi.fn(() => 7), sync: vi.fn(), close: vi.fn() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), openSync: io.open, fsyncSync: io.sync, closeSync: io.close }))
const model = { provider: 'openai-codex', id: 'test-vision', api: 'openai-codex-responses', input: ['text', 'image'] } as Model<Api>
const assistant = (): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: model.provider, model: model.id, api: model.api, timestamp: 1, stopReason: 'stop', usage: { input: 9, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } } })
const message = { type: 'message', id: 'u', parentId: null, timestamp: '', message: { role: 'user', content: 'hi', timestamp: 1 } } as SessionEntry
function fixture() {
  const entries: SessionEntry[] = [message]
  const append = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: 'custom', customType, data, id: 'marker', parentId: 'u', timestamp: '' })
    return 'marker'
  })
  const manager = { getEntries: () => entries, getHeader: () => ({ type: 'session', version: 3, id: 'session', cwd: '/test', timestamp: '' }), appendCustomEntry: append, isPersisted: () => true, getSessionFile: () => '/mock/session.jsonl' } as unknown as SessionManager
  const settings = { getBlockImages: () => false, getTransport: () => 'sse' } as Pick<SettingsManager, 'getBlockImages' | 'getTransport'>
  const authorize = vi.fn(async () => ({ scopeRevision: 4 }))
  let watchSerial = 0
  const watch = vi.fn((_model: unknown, signal: AbortSignal) => ({ watchRequestId: `watch-${++watchSerial}`,
    result: new Promise<{ scopeRevision: number }>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) }))
  const unwatch = vi.fn(async (_model: unknown, _watchRequestId: string) => {})
  const observations = new WeakMap<ComputerUseAgentResponse, Model<Api>>()
  const assertObservation = vi.fn((actual: Model<Api>, response: ComputerUseAgentResponse) => {
    if (observations.get(response) !== actual) throw new Error('ComputerUse: source-unverified')
  })
  let revoke: (() => void) | undefined
  const network = vi.fn<typeof fetch>(async () => new Response('ok'))
  vi.stubGlobal('fetch', network)
  const calls: Record<string, unknown>[] = []
  const assistantResponses: AssistantMessage[] = []
  const auth = { auth: { apiKey: 'synthetic-oauth-only' }, source: 'OAuth' } as const
  const runtime = {
    getAuth: vi.fn(function (this: unknown, ..._args: unknown[]): Promise<typeof auth | undefined> { expect(this).toBe(runtime); return Promise.resolve(auth) }),
    login: vi.fn(function (this: unknown, ..._args: unknown[]) { expect(this).toBe(runtime) }),
    getPhysicalModel: vi.fn(() => model), getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
    // Receiver-sensitive fake mirrors ModelRuntime's private-field requirement.
    streamSimple(this: unknown, actual: Model<Api>, _context: unknown, options: Record<string, unknown> = {}) {
      expect(this).toBe(runtime)
      expect(actual).toBe(model)
      calls.push(options)
      const stream = createAssistantMessageEventStream()
      void (async () => {
        try {
          if (options.onPayload) await (options.onPayload as (p: unknown, m: Model<Api>) => unknown)({}, actual)
          if (options.fetch) {
            await (options.fetch as typeof fetch)('https://example.invalid', { method: 'POST' })
            if (revoke) { revoke(); await (options.fetch as typeof fetch)('https://example.invalid', { method: 'POST' }) }
          }
          const result = assistantResponses.shift() ?? assistant()
          stream.push({ type: 'done', reason: result.stopReason as 'stop' | 'length' | 'toolUse', message: result }); stream.end(result)
        } catch (error) {
          const result = { ...assistant(), stopReason: 'error' as const, errorMessage: String(error) }
          stream.push({ type: 'error', reason: 'error', error: result }); stream.end(result)
        }
      })()
      return stream
    },
    stream(this: unknown, ...args: unknown[]) { expect(this).toBe(runtime); return Reflect.apply(runtime.streamSimple, runtime, args) },
    complete: vi.fn(), completeSimple: vi.fn(), streamDeferred: vi.fn(), fetchDeferred: vi.fn(), cancelDeferred: vi.fn(), generateImages: vi.fn(), classify: vi.fn(), resolveModel: vi.fn(),
    getProvider: vi.fn(() => ({ streamSimple: vi.fn() })), getProviders: vi.fn(() => [{ streamSimple: vi.fn() }])
  }
  const current = { value: true }
  const gate = createComputerUseModelGate(runtime as unknown as ModelRuntime, { runtimeId: 'runtime', sessionManager: manager, settingsManager: settings, authorize, watch, unwatch, assertObservation, isCurrent: () => current.value })
  let observationSerial = 0
  const retain = (scopeRevision = 4, actual = model) => {
    const response = { version: 1, ok: true, operation: 'observe', requestId: `observe-${++observationSerial}`, scopeRevision, frameId: 'frame', width: 1, height: 1, image: { mimeType: 'image/png', data: 'synthetic-only' } } as ComputerUseAgentResponse
    observations.set(response, actual)
    gate.retain(actual, response)
    return response
  }
  return { gate, retain, runtime, auth, manager, settings, append, entries, authorize, watch, unwatch, network, calls, assistantResponses, current, revokeBetweenAttempts: (fn: () => void) => { revoke = fn } }
}
// Execute pinned ModelRuntime's real streamSimple/prepareRequest/getAuth methods,
// but never construct a runtime, credential store, provider or backend. Only the
// bottom provider/auth boundaries are synthetic; global fetch is also stubbed.
function usePinnedSdkRequests(f: ReturnType<typeof fixture>) {
  const getAuth = vi.fn(async (..._args: unknown[]) => f.auth)
  const originalStream = f.runtime.streamSimple
  const streamSimple = vi.fn((...args: unknown[]) => Reflect.apply(originalStream, f.runtime, args))
  Object.setPrototypeOf(f.runtime, ModelRuntime.prototype)
  Object.assign(f.runtime, {
    models: { getAuth, getProvider: () => ({ streamSimple }) },
    config: { getProvider: () => undefined }, extensionProviders: new Map(),
    streamSimple: ModelRuntime.prototype.streamSimple
  })
  f.runtime.getAuth.mockImplementation(function (this: unknown, ...args: unknown[]) {
    expect(this).toBe(f.runtime)
    return Reflect.apply(ModelRuntime.prototype.getAuth, this, args)
  })
  return { getAuth, streamSimple }
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('ComputerUse request exit gate (mock only)', () => {
  it('does no auth, model call, filesystem operation or permission RPC on construction', () => {
    const f = fixture()
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
    expect(io.open).not.toHaveBeenCalled()
    expect(f.gate.models.getPhysicalModel(model.provider, model.id)).toBe(model)
  })
  it('preserves clean getAuth overloads, original receiver, arguments and returned promise without egress RPCs', async () => {
    const f = fixture()
    for (const source of [model, model.provider]) {
      const overrides = { signal: new AbortController().signal, apiKey: 'synthetic-only', env: { MOCK: '1' }, minOAuthValidityMs: 123 }
      const original = Promise.resolve(f.auth)
      f.runtime.getAuth.mockReturnValueOnce(original)
      const result = Reflect.apply(f.gate.models.getAuth, f.gate.models, [source, overrides, 'untouched-extra'])
      expect(result).toBe(original)
      expect(await result).toBe(f.auth)
      expect(f.runtime.getAuth).toHaveBeenLastCalledWith(source, overrides, 'untouched-extra')
      expect(f.runtime.getAuth.mock.calls.at(-1)?.[1]).toBe(overrides)
    }
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.watch).not.toHaveBeenCalled()
    expect(f.unwatch).not.toHaveBeenCalled()
  })
  it('does not redirect explicit login into automatic screenshot-history authorization', async () => {
    const f = fixture(); f.retain(4)
    const interaction = { signal: new AbortController().signal }
    await Reflect.apply(f.gate.models.login, f.gate.models, [model.provider, 'oauth', interaction])
    expect(f.runtime.login).toHaveBeenCalledWith(model.provider, 'oauth', interaction)
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
  })
  it('blocks original getAuth completely before denied Main approval, unknown history or provider-only auth', async () => {
    const denied = fixture(); denied.retain(4)
    denied.authorize.mockRejectedValue(new Error('Main egress denied'))
    await expect(denied.gate.models.getAuth(model)).rejects.toThrow(/egress denied/)
    expect(denied.authorize).toHaveBeenCalledOnce()
    expect(denied.runtime.getAuth).not.toHaveBeenCalled()
    expect(denied.watch).not.toHaveBeenCalled()
    const unknown = fixture()
    unknown.entries.push({ type: 'custom', customType: COMPUTER_USE_TAINT_ENTRY, data: {} } as SessionEntry)
    await expect(unknown.gate.models.getAuth(model)).rejects.toThrow(/provenance/)
    expect(unknown.authorize).not.toHaveBeenCalled()
    expect(unknown.runtime.getAuth).not.toHaveBeenCalled()
    const providerOnly = fixture(); providerOnly.retain(4)
    await expect(providerOnly.gate.models.getAuth(model.provider)).rejects.toThrow(/denied/)
    expect(providerOnly.authorize).not.toHaveBeenCalled() // no model identity to approve
    expect(providerOnly.runtime.getAuth).not.toHaveBeenCalled()
  })
  it('checks the actual auth model, native provider and explicit SSE boundary before touching original getAuth', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.settings.getTransport = () => 'auto' },
      (f: ReturnType<typeof fixture>) => { f.settings.getBlockImages = () => true },
      (f: ReturnType<typeof fixture>) => { f.runtime.getRegisteredProviderConfig = () => ({}) as never },
      (f: ReturnType<typeof fixture>) => { f.runtime.getRegisteredNativeProvider = () => ({}) as never },
      (f: ReturnType<typeof fixture>) => { f.runtime.getPhysicalModel.mockReturnValue({ ...model, input: ['text'] }) }
    ]) {
      const f = fixture(); f.retain(4); mutate(f)
      await expect(f.gate.models.getAuth(model)).rejects.toThrow(/denied/)
      expect(f.authorize).not.toHaveBeenCalled()
      expect(f.runtime.getAuth).not.toHaveBeenCalled()
    }
    const f = fixture(); f.retain(4)
    for (const actual of [{ ...model, input: ['text'] }, { ...model, provider: 'other' }, { ...model, api: 'other' }]) {
      await expect(f.gate.models.getAuth(actual as Model<Api>)).rejects.toThrow(/denied/)
    }
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
  })
  it.each(['caller-abort', 'retire', 'new-source', 'session-change', 'model-change'] as const)('rechecks auth identity after pending authorization: %s', async change => {
    const f = fixture(); f.retain(4)
    const caller = new AbortController()
    const actual = { ...model }
    let approve!: (value: { scopeRevision: number }) => void
    f.authorize.mockImplementationOnce(() => new Promise(resolve => { approve = resolve }))
    const result = f.gate.models.getAuth(actual, { signal: caller.signal })
    expect(f.authorize).toHaveBeenCalledOnce()
    if (change === 'caller-abort') caller.abort()
    else if (change === 'retire') f.gate.retire()
    else if (change === 'new-source') { f.retain(9); f.retain(4) }
    else if (change === 'session-change') f.current.value = false
    else actual.id = 'other-model'
    approve({ scopeRevision: 4 })
    await expect(result).rejects.toThrow(/denied/)
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.watch).not.toHaveBeenCalled()
  })
  it('authorizes auth-only first, preserves auth overrides and requires a separate approval/watch for the subsequent compaction stream', async () => {
    const f = fixture(); f.retain(4)
    const overrides = { signal: new AbortController().signal, minOAuthValidityMs: 789, env: { MOCK: '1' } }
    expect(await f.gate.models.getAuth(model, overrides)).toBe(f.auth)
    expect(f.authorize).toHaveBeenCalledOnce()
    expect(f.authorize.mock.invocationCallOrder[0]).toBeLessThan(f.runtime.getAuth.mock.invocationCallOrder[0])
    expect(f.runtime.getAuth).toHaveBeenCalledWith(model, { ...overrides, signal: expect.any(AbortSignal) })
    expect((f.runtime.getAuth.mock.calls[0][1] as typeof overrides).signal).not.toBe(overrides.signal)
    expect(f.calls).toHaveLength(0)
    expect(f.watch).toHaveBeenCalledOnce()
    expect(f.unwatch).toHaveBeenCalledOnce() // ends only auth; no provider stream has started
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('stop')
    expect(f.authorize).toHaveBeenCalledTimes(4) // fresh stream pre-auth, transformed payload and fetch
    expect(f.watch).toHaveBeenCalledTimes(2)
    expect(f.unwatch).toHaveBeenCalledTimes(2)
    f.authorize.mockRejectedValue(new Error('later summary not approved'))
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
    expect(f.calls).toHaveLength(1)
    expect(f.runtime.getAuth).toHaveBeenCalledOnce()
  })
  it('keeps pinned SDK toolResult → next prompt → default compaction independently approvable after taint (mock boundaries only)', async () => {
    const f = fixture()
    const sdk = usePinnedSdkRequests(f)
    f.assistantResponses.push({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'observe-call', name: 'pion_computer_observe', arguments: {} }] })
    const agent = new Agent({
      initialState: { model, thinkingLevel: 'off', tools: [{ name: 'pion_computer_observe', label: 'synthetic observe', description: 'mock only', parameters: Type.Object({}),
        execute: async () => {
          const observation = f.retain(4)
          return { content: [{ type: 'image', ...observation.image! }], details: {} }
        } }] },
      // Same model-bearing runtime call as pinned sdk.js's Agent streamFn.
      streamFn: (actual, context, options) => f.gate.models.streamSimple(actual, context, options), transport: 'sse'
    })
    let toolResult: ToolResultMessage | undefined
    agent.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        toolResult = event.message
        f.entries.push({ type: 'message', id: 'actual-tool-result', parentId: 'marker', timestamp: '', message: event.message })
      }
    })
    await agent.prompt('Use the synthetic observe tool once.')
    expect(toolResult).toMatchObject({ toolCallId: 'observe-call', toolName: 'pion_computer_observe', isError: false, content: [{ type: 'image', mimeType: 'image/png', data: 'synthetic-only' }] })
    expect((sdk.streamSimple.mock.calls[1][1] as { messages: unknown[] }).messages).toContainEqual(toolResult)
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' })
    expect(f.runtime.getAuth).toHaveBeenCalledTimes(2) // real prepareRequest, before and after the tool
    expect(f.authorize).toHaveBeenCalledTimes(3) // continuation before auth, after payload, before fetch
    expect(f.authorize.mock.invocationCallOrder[0]).toBeLessThan(sdk.getAuth.mock.invocationCallOrder[1])

    let approvePrompt!: () => void
    const promptApproval = new Promise<void>(resolve => { approvePrompt = resolve })
    f.authorize.mockImplementation(async () => { await promptApproval; return { scopeRevision: 4 } })
    const prompt = agent.prompt('Continue with the retained screenshot history.')
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledTimes(4))
    expect(f.runtime.getAuth).toHaveBeenCalledTimes(2) // no auto auth while Main approval is pending
    approvePrompt(); await prompt
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' })
    expect(f.runtime.getAuth).toHaveBeenCalledTimes(3)

    // No AgentSession constructor/factory: invoke its actual pinned default
    // compaction and auth helpers on an existing in-memory Agent + fake services.
    const session = Object.assign(Object.create(AgentSession.prototype), { agent, _modelRuntime: f.gate.models,
      settingsManager: { getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }) }, _emit: vi.fn() })
    const preparation = { firstKeptEntryId: 'keep', messagesToSummarize: agent.state.messages, turnPrefixMessages: [], isSplitTurn: false,
      tokensBefore: 100, fileOps: { read: new Set(), written: new Set(), edited: new Set() } }
    const compact = () => Reflect.apply(Reflect.get(AgentSession.prototype, '_runDefaultCompaction'), session,
      [preparation, model, undefined, new AbortController().signal, 'manual'])
    f.authorize.mockRejectedValue(new Error('Main compaction egress denied'))
    await expect(compact()).rejects.toThrow(/denied/)
    expect(f.runtime.getAuth).toHaveBeenCalledTimes(3)
    expect(sdk.streamSimple).toHaveBeenCalledTimes(3)

    let approveCompaction!: () => void
    const compactionApproval = new Promise<void>(resolve => { approveCompaction = resolve })
    f.authorize.mockImplementation(async () => { await compactionApproval; return { scopeRevision: 4 } })
    const compaction = compact()
    await Promise.resolve()
    expect(f.runtime.getAuth).toHaveBeenCalledTimes(3)
    approveCompaction()
    await expect(compaction).resolves.toMatchObject({ summary: 'ok', usage: assistant().usage })
    expect(f.runtime.getAuth).toHaveBeenCalledTimes(5) // summary pre-auth + actual ModelRuntime.prepareRequest
    expect(f.runtime.getAuth.mock.calls.every(([actual]) => actual === model)).toBe(true)
    expect(sdk.getAuth.mock.calls.every(([actual]) => actual === model)).toBe(true)
    expect(f.append).toHaveBeenCalledOnce() // no recapture or restored permission
    expect(f.watch).toHaveBeenCalledTimes(4) // continuation, prompt, summary auth, summary stream
    expect(f.unwatch).toHaveBeenCalledTimes(4)
  })
  it.each(['caller-abort', 'retire', 'new-source', 'watch-withdrawal'] as const)('owns dispatched auth through actual SDK settlement, not cancellation: %s', async change => {
    const f = fixture(); f.retain(4)
    const caller = new AbortController()
    let settle!: (value: typeof f.auth) => void
    f.runtime.getAuth.mockImplementationOnce(function (this: unknown) {
      expect(this).toBe(f.runtime)
      return new Promise(resolve => { settle = resolve })
    })
    let withdraw!: (value: { scopeRevision: number }) => void
    if (change === 'watch-withdrawal') f.watch.mockImplementationOnce(() => ({ watchRequestId: 'auth-withdrawal', result: new Promise(resolve => { withdraw = resolve }) }))
    const completed = vi.fn()
    const result = f.gate.models.getAuth(model, { signal: caller.signal }).finally(completed)
    await vi.waitFor(() => expect(f.runtime.getAuth).toHaveBeenCalledOnce())
    const originalSignal = (f.runtime.getAuth.mock.calls[0][1] as { signal: AbortSignal }).signal
    if (change === 'caller-abort') caller.abort()
    else if (change === 'retire') f.gate.retire()
    else if (change === 'new-source') { f.retain(9); f.retain(4) }
    else withdraw({ scopeRevision: 99 })
    await Promise.resolve(); await Promise.resolve()
    expect(originalSignal.aborted).toBe(false) // SDK auth cancellation would only stop waiting, not refresh/persistence
    expect(completed).not.toHaveBeenCalled()
    expect(f.unwatch).not.toHaveBeenCalled()
    settle(f.auth)
    await expect(result).rejects.toThrow(/denied/)
    expect(completed).toHaveBeenCalledOnce()
    expect(f.calls).toHaveLength(0)
    expect(f.network).not.toHaveBeenCalled()
  })
  it('awaits real auth unwatch ACKs on original getAuth rejection and never bypasses a failed watch', async () => {
    const f = fixture(); f.retain(4)
    f.runtime.getAuth.mockRejectedValueOnce(new Error('synthetic OAuth failure'))
    let acknowledge!: () => void
    f.unwatch.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve }))
    const completed = vi.fn()
    const result = f.gate.models.getAuth(model).finally(completed)
    await vi.waitFor(() => expect(f.unwatch).toHaveBeenCalledWith(model, 'watch-1'))
    expect(completed).not.toHaveBeenCalled()
    acknowledge()
    await expect(result).rejects.toThrow(/synthetic OAuth failure/)
    const failedWatch = fixture(); failedWatch.retain(4)
    failedWatch.watch.mockImplementationOnce(() => { throw new Error('watch unavailable before registration') })
    await expect(failedWatch.gate.models.getAuth(model)).rejects.toThrow(/denied/)
    expect(failedWatch.runtime.getAuth).not.toHaveBeenCalled()
  })
  it('poisons later auth on an unknown unwatch outcome rather than refreshing again after local cleanup timeout', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.retain(4)
    f.unwatch.mockImplementationOnce(() => new Promise<void>(() => {}))
    const result = f.gate.models.getAuth(model)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.unwatch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(COMPUTER_USE_UNWATCH_TIMEOUT_MS)
    expect(await result).toBe(f.auth)
    await expect(f.gate.models.getAuth(model)).rejects.toThrow(/denied/)
    expect(f.runtime.getAuth).toHaveBeenCalledOnce()
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
    expect(f.calls).toHaveLength(0)
  })
  it('writes and syncs the SDK taint marker before allowing image retention; write failure poisons delivery', () => {
    const f = fixture()
    f.gate.assertImageDelivery(model)
    f.retain(4)
    expect(f.append).toHaveBeenCalledWith(COMPUTER_USE_TAINT_ENTRY, { version: 2, retention: 'sdk-session', runtimeId: 'runtime', scopeRevision: 4, provider: model.provider, modelId: model.id, observationRequestId: 'observe-1' })
    expect(f.append.mock.invocationCallOrder[0]).toBeLessThan(io.open.mock.invocationCallOrder[0])
    expect(io.sync).toHaveBeenCalledWith(7)
    expect(io.close).toHaveBeenCalledWith(7)
    expect(computerUseHistoryState(f.manager, 'runtime')).toBe('current')
    f.retain(5)
    expect(f.append).toHaveBeenCalledTimes(2)
    const broken = fixture()
    broken.append.mockImplementation(() => { throw new Error('disk full') })
    expect(() => broken.retain(4)).toThrow(/denied/)
    expect(() => broken.gate.assertImageDelivery(model)).toThrow(/denied/)
  })
  it('retains only an actual observed response, appends every scope/model generation and never reuses old approval', async () => {
    const f = fixture()
    expect(() => f.gate.retain(model, { version: 1, ok: true, operation: 'observe', requestId: 'forged', scopeRevision: 4 } as never)).toThrow(/source-unverified/)
    const first = f.retain(4)
    expect(() => f.gate.retain(model, first)).toThrow(/denied/)
    f.retain(9)
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error') // Main still returned the old scope.
    expect(f.calls).toHaveLength(0)
    f.authorize.mockResolvedValue({ scopeRevision: 9 })
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('stop')
    const alternate = { ...model, id: 'other-vision' }
    f.retain(4, alternate)
    expect(f.append.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ scopeRevision: 4, modelId: model.id, observationRequestId: 'observe-1' }),
      expect.objectContaining({ scopeRevision: 9, modelId: model.id, observationRequestId: 'observe-2' }),
      expect.objectContaining({ scopeRevision: 4, modelId: alternate.id, observationRequestId: 'observe-3' })
    ])
    expect(io.sync).toHaveBeenCalledTimes(3)
    expect(computerUseHistoryState(f.manager, 'runtime')).toBe('current')
    f.authorize.mockResolvedValue({ scopeRevision: 4 })
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('stop')
  })
  it('permits a later root run only after an independent Main egress approval for the retained history, without a new observe', async () => {
    const f = fixture(); f.retain(4)
    await f.gate.models.streamSimple(model, { messages: [] }).result()
    let approve!: () => void
    const approval = new Promise<void>(resolve => { approve = resolve })
    let permitted = false
    const requestApproval = vi.fn(() => approval)
    f.authorize.mockImplementation(async () => {
      if (!permitted) { await requestApproval(); permitted = true }
      return { scopeRevision: 4 }
    })
    const later = f.gate.models.streamSimple(model, { messages: [] }).result()
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())
    expect(f.network).toHaveBeenCalledOnce()
    approve()
    expect((await later).stopReason).toBe('stop')
    expect(f.append).toHaveBeenCalledOnce() // no new capture or restored grant
    expect(f.network).toHaveBeenCalledTimes(2)
  })
  it('preserves real stream usage, method receivers and request callbacks', async () => {
    const f = fixture(); f.retain(4)
    const payload = vi.fn(() => ({ replaced: true }))
    const result = await f.gate.models.completeSimple(model, { messages: [] }, { onPayload: payload })
    expect(result.usage).toEqual(assistant().usage)
    expect(result.stopReason).toBe('stop')
    expect(payload).toHaveBeenCalledOnce()
    expect(f.network).toHaveBeenCalledOnce()
    expect(f.authorize).toHaveBeenCalledTimes(3) // pre-auth, after payload hooks, each real fetch
    expect(f.runtime.completeSimple).not.toHaveBeenCalled() // derived entry cannot bypass the stream gate
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal)
  })
  it('rechecks every actual Codex fetch retry and blocks late transformed/queued requests after revocation', async () => {
    const f = fixture(); f.retain(4)
    f.revokeBetweenAttempts(() => f.authorize.mockRejectedValue(new Error('withdrawn')))
    const result = await f.gate.models.stream(model, { messages: [] }, { maxRetries: 3 }).result()
    expect(result.stopReason).toBe('error')
    expect(f.network).toHaveBeenCalledOnce()
    const later = await f.gate.models.streamSimple(model, { messages: [] }, {}).result()
    expect(later.stopReason).toBe('error')
    expect(f.calls).toHaveLength(1)
  })
  it('does not revive an old provider retry when scope/source generations go A-B-A', async () => {
    const f = fixture(); f.retain(4)
    f.revokeBetweenAttempts(() => { f.retain(9); f.retain(4) })
    const result = await f.gate.models.streamSimple(model, { messages: [] }).result()
    expect(result.stopReason).toBe('error')
    expect(f.network).toHaveBeenCalledOnce()
    expect((f.calls[0].signal as AbortSignal).aborted).toBe(true)
    expect(f.append).toHaveBeenCalledTimes(3)
    f.revokeBetweenAttempts(() => {})
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('stop')
  })
  it('actual watch withdrawal aborts the original request signal; retirement does not invent successful completion', async () => {
    const f = fixture(); f.retain(4)
    let withdraw!: (value: { scopeRevision: number }) => void
    f.watch.mockImplementation(() => ({ watchRequestId: 'withdrawn', result: new Promise(resolve => { withdraw = resolve }) }))
    f.network.mockImplementation(async (_url, init) => {
      withdraw({ scopeRevision: 99 })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(init?.signal?.aborted).toBe(true)
      throw new Error('original request ended with abort')
    })
    const stream = f.gate.models.streamSimple(model, { messages: [] })
    const result = await stream.result()
    expect(result.stopReason).toBe('error')
    f.gate.retire()
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
  })
  it('awaits the real correlated Main unwatch ACK after provider settlement, not just local input abort', async () => {
    const f = fixture(); f.retain(4)
    let acknowledge!: () => void
    f.unwatch.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve }))
    const completed = vi.fn()
    const result = f.gate.models.streamSimple(model, { messages: [] }).result().then(value => { completed(); return value })
    await vi.waitFor(() => expect(f.unwatch).toHaveBeenCalledWith(model, 'watch-1'))
    expect(f.watch.mock.calls[0][1].aborted).toBe(true)
    expect(f.unwatch.mock.calls[0]).toHaveLength(2) // no already-aborted cleanup signal
    expect(completed).not.toHaveBeenCalled()
    acknowledge()
    expect((await result).usage).toEqual(assistant().usage)
  })
  it('does not fill Main\'s four watcher slots across short sequential provider requests', async () => {
    const f = fixture(); f.retain(4)
    const active = new Set<string>()
    let serial = 0
    f.watch.mockImplementation((_actual, signal) => {
      if (active.size >= 4) throw new Error('busy')
      const watchRequestId = `actual-${++serial}`
      active.add(watchRequestId)
      return { watchRequestId, result: new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('LOCAL cancellation only')), { once: true })) }
    })
    f.unwatch.mockImplementation(async (_actual, id) => { expect(active.delete(id)).toBe(true) })
    for (let index = 0; index < 7; index++) {
      expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('stop')
      expect(active.size).toBe(0)
    }
    expect(f.unwatch).toHaveBeenCalledTimes(7)
  })
  it('retirement abort is not provider settlement and cannot close watches until the original request really ends', async () => {
    const f = fixture(); f.retain(4)
    let settle!: () => void
    f.network.mockImplementation(() => new Promise<Response>(resolve => { settle = () => resolve(new Response('actual end')) }))
    const result = f.gate.models.streamSimple(model, { messages: [] }).result()
    await vi.waitFor(() => expect(f.network).toHaveBeenCalledOnce())
    f.gate.retire()
    expect((f.calls[0].signal as AbortSignal).aborted).toBe(true)
    expect(f.unwatch).not.toHaveBeenCalled()
    settle()
    expect((await result).usage).toEqual(assistant().usage)
    expect(f.unwatch).toHaveBeenCalledOnce()
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
  })
  it('holds a terminal event until the original stream iterator settles and then performs cleanup', async () => {
    const f = fixture(); f.retain(4)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let terminalEmitted = false
    const final = assistant()
    f.runtime.streamSimple = function () {
      return { async *[Symbol.asyncIterator]() {
        terminalEmitted = true
        yield { type: 'done', reason: 'stop', message: final }
        await pending
      }, result: async () => final } as never
    }
    const completed = vi.fn()
    const result = f.gate.models.streamSimple(model, { messages: [] }).result().then(value => { completed(); return value })
    await vi.waitFor(() => expect(terminalEmitted).toBe(true))
    expect(completed).not.toHaveBeenCalled()
    expect(f.unwatch).not.toHaveBeenCalled()
    release()
    expect(await result).toBe(final)
    expect(f.unwatch).toHaveBeenCalledOnce()
  })
  it('bounds waiting for cleanup but keeps transport/owner unknown poisoned even after a late ACK', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.retain(4)
    let acknowledge!: () => void
    f.unwatch.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve }))
    const result = f.gate.models.streamSimple(model, { messages: [] }).result()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.unwatch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(COMPUTER_USE_UNWATCH_TIMEOUT_MS)
    expect((await result).usage).toEqual(assistant().usage) // real result, not fabricated failure/zero usage
    acknowledge()
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
    expect(f.network).toHaveBeenCalledOnce()
  })
  it('does not confuse an actual negative Main watch ACK with an unknown transport or permanently poison a normal later prompt', async () => {
    const f = fixture(); f.retain(4)
    f.watch.mockImplementationOnce(() => ({ watchRequestId: 'not-registered', isAcknowledged: () => true,
      result: Promise.reject(new Error('Main busy before registering a watcher')) }))
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
    expect(f.unwatch).not.toHaveBeenCalled() // Main proved this actual poll ended.
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('stop')
    expect(f.unwatch).toHaveBeenCalledOnce()
  })
  it('a rejected unwatch ACK cannot retire the watcher just because its local input was aborted', async () => {
    const f = fixture(); f.retain(4)
    f.unwatch.mockRejectedValue(new Error('owner retired / transport unknown'))
    await f.gate.models.streamSimple(model, { messages: [] }).result()
    expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
    expect(f.calls).toHaveLength(1)
  })
  it('rejects un-audited transport/API, blockImages and provider overrides before any request', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.settings.getTransport = () => 'auto' },
      (f: ReturnType<typeof fixture>) => { f.settings.getBlockImages = () => true },
      (f: ReturnType<typeof fixture>) => { f.runtime.getRegisteredProviderConfig = () => ({}) as never }
    ]) {
      const f = fixture(); f.retain(4); mutate(f)
      expect((await f.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
      expect(f.calls).toHaveLength(0)
      expect(f.authorize).not.toHaveBeenCalled()
    }
    const f = fixture(); f.retain(4)
    expect((await f.gate.models.streamSimple({ ...model, input: ['text'] }, { messages: [] }).result()).stopReason).toBe('error')
    expect((await f.gate.models.streamSimple({ ...model, api: 'other' }, { messages: [] }).result()).stopReason).toBe('error')
    expect((await f.gate.models.streamSimple(model, { messages: [] }, { fetch: f.network }).result()).stopReason).toBe('error')
    expect(f.calls).toHaveLength(0)
  })
  it('covers deferred/image/classifier/virtual and provider-derived exits, without touching clean behavior', async () => {
    const f = fixture()
    await f.gate.models.classify({} as never, { input: [] } as never)
    expect(f.runtime.classify).toHaveBeenCalledOnce()
    f.retain(4)
    for (const method of ['fetchDeferred', 'cancelDeferred', 'generateImages', 'classify', 'resolveModel'] as const) {
      await expect(Reflect.apply(f.gate.models[method], f.gate.models, [model, {}])).rejects.toThrow(/denied/)
    }
    expect((await f.gate.models.streamDeferred(model, {} as never).result()).stopReason).toBe('error')
    const provider = f.gate.models.getProvider(model.provider)!
    expect((await provider.streamSimple(model, normalizeContext({ messages: [] })).result()).stopReason).toBe('error')
    expect((await f.gate.models.getProviders()[0].streamSimple(model, normalizeContext({ messages: [] })).result()).stopReason).toBe('error')
    expect(f.runtime.fetchDeferred).not.toHaveBeenCalled()
    expect(f.runtime.generateImages).not.toHaveBeenCalled()
  })
  it('fails closed on restore, branch/clone/import provenance, unknown taint and image-without-marker', async () => {
    const f = fixture(); f.retain(4)
    expect(computerUseHistoryState(f.manager, 'new-runtime')).toBe('unknown')
    f.manager.getHeader = () => ({ parentSession: '/not-followed/original.jsonl' }) as never
    f.entries.splice(1)
    expect(computerUseHistoryState(f.manager, 'runtime')).toBe('clean') // untainted normal clone
    f.entries.push({ type: 'branch_summary', id: 'summary', summary: 'derived text', fromId: 'old' } as SessionEntry)
    expect(computerUseHistoryState(f.manager, 'runtime')).toBe('unknown')
    expect(() => f.gate.assertImageDelivery(model)).toThrow(/Restore\/fork\/import/)
    expect(() => f.retain(9)).toThrow(/live runtime/)
    const restored = await f.gate.models.streamSimple(model, { messages: [] }).result()
    expect(restored.stopReason).toBe('error')
    expect(restored.errorMessage).toMatch(/no approval was restored/)
    expect(f.authorize).not.toHaveBeenCalled()
    const unmarked = fixture()
    unmarked.entries.push({ type: 'message', message: { role: 'toolResult', toolName: 'pion_computer_observe', content: [{ type: 'image', data: 'not decoded', mimeType: 'image/png' }] } } as SessionEntry)
    expect(computerUseHistoryState(unmarked.manager, 'runtime')).toBe('unknown')
    expect((await unmarked.gate.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error')
  })
})
