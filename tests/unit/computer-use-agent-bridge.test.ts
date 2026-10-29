import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, type AgentSession, type ExtensionCommandContext, type ExtensionToolContext, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createComputerUseAgentChannel, createComputerUseTools } from '../../src/main/agent/computer-use'
import { createComputerUseModelGate } from '../../src/main/agent/computer-use-model-gate'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import { makeStaticPng } from '../fixtures/static-png'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { PendingRequestStore } from '../../src/main/agent/pending-requests'
import { createDisabledComputerUseStatus } from '../../src/shared/computer-use'
import { COMPUTER_USE_AGENT_SOURCE_FIELD, COMPUTER_USE_AGENT_TITLE_PREFIX, COMPUTER_USE_OBSERVE_TOOL, type ComputerUseAgentRequest } from '../../src/shared/computer-use-agent'
import type { BackendRecord } from '../../src/main/agent/types'
import type { ComputerUseAgentAdmission } from '../../src/main/agent/computer-use-bridge'
import { TOOL_PERMISSION_MARKER } from '../../src/main/tool-permissions'

const retentionIo = vi.hoisted(() => ({ open: vi.fn(() => 7), sync: vi.fn(), close: vi.fn() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), openSync: retentionIo.open, fsyncSync: retentionIo.sync, closeSync: retentionIo.close }))
afterEach(() => vi.unstubAllGlobals())

// All owners, SDK events/state, model metadata and approvals are synthetic.
// No AgentBridge constructor, SDK backend, desktop or credential store starts.
function fixture() {
  const model = { provider: 'openai-codex', id: 'exact-model', input: ['text', 'image'] }
  let document = { windowId: 7, generation: 1, frame: {} }
  const state = { model, sessionFile: '/mock-project/session.jsonl', sessionId: 'actual-sdk-session' }
  const client = { getState: vi.fn(async () => state) }
  const backend = { key: 'actual-backend-key', cwd: '/mock-project', sessionPath: state.sessionFile, usageBackendId: 'actual-backend-id', activeRunId: 'run-1',
    computerUseAgentNonce: 'main-created-nonce', client, phase: 'running', busy: true, compacting: false, pendingRunIds: [], startPromise: Promise.resolve() } as unknown as BackendRecord
  const run = { id: backend.activeRunId, cwd: backend.cwd, sessionPath: backend.sessionPath, state: 'running', usageBackendId: backend.usageBackendId, tools: [] }
  const pending = new PendingRequestStore({ pushToolPermissionRequests: vi.fn(), pushExtensionUiRequests: vi.fn() })
  const rules = { external: 'allow', network: 'allow', read: 'allow', write: 'allow', shell: 'allow' }
  const policy = { rules, cwd: backend.cwd, source: 'saved' }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: backend.key, activeCwd: backend.cwd, sessionSelectionGeneration: 0, stopping: false,
    win: { webContents: { id: 7, send: vi.fn() } }, backendPool: new Map([[backend.key, backend]]),
    yoloSessions: new Set(), desiredModes: new Map([[backend.key, 'build']]), pendingRequests: pending,
    toolPermissionStore: { getPolicySnapshot: vi.fn(() => policy), onChanged: vi.fn() },
    runStore: { recordUsageEntry: vi.fn(), get: vi.fn((id: string) => id === run.id ? run : undefined), update: vi.fn((_id: string, update: (value: unknown) => void) => update(run)) },
    notifyToolPermissionRequested: vi.fn(), pushToolPermissionRequests: vi.fn(), respondToExtensionUi: vi.fn()
  })
  const service = { getState: vi.fn(() => createDisabledComputerUseStatus()), start: vi.fn(), capture: vi.fn(), act: vi.fn(), stop: vi.fn(async () => createDisabledComputerUseStatus()), revoke: vi.fn() }
  bridge.configureComputerUseAgent({ enabled: true, document: () => document, service, clock: () => 10, randomId: () => 'id' })
  const request: ComputerUseAgentRequest = { version: 1, operation: 'observe', runtimeNonce: backend.computerUseAgentNonce!, runtimeId: 'factory-1', requestId: 'request-1', toolCallId: 'actual-root', provider: model.provider, modelId: model.id }
  const source = { version: 1, runtimeId: request.runtimeId, runtimeNonce: request.runtimeNonce, toolCallId: request.toolCallId }
  const start = (extra: Record<string, unknown> = {}) => bridge.trackBackendEvent(backend, { type: 'tool_execution_start', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: request.toolCallId, ...extra }, 'tool_execution_start')
  const admit = (value = request): Promise<ComputerUseAgentAdmission> => bridge.admitComputerUseRequest(backend, backend.client, value)
  return { bridge, backend, client, run, state, pending, policy, rules, request, source, service, start, admit,
    changeDocument: () => { document = { windowId: 7, generation: 2, frame: {} } } }
}

describe('Main ComputerUse real captured-source boundary (mock)', () => {
  it.each(['name-only', 'wrong-nonce', 'nested'] as const)('does not accept %s as a root factory receipt', async kind => {
    const h = fixture()
    h.start(kind === 'name-only' ? {} : kind === 'wrong-nonce'
      ? { [COMPUTER_USE_AGENT_SOURCE_FIELD]: { ...h.source, runtimeNonce: 'self-reported-nonce' } }
      : { parentToolCallId: 'codemode-parent', [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    await expect(h.admit()).rejects.toThrow('source-unverified')
    expect(h.client.getState).not.toHaveBeenCalled()
  })

  it('binds an actual factory-decorated root receipt to existing backend/client/run and live document', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    const scope = await h.admit()
    expect(scope.owner).toEqual({ ownerWindowId: 7, backendId: 'actual-backend-id', runtimeId: 'factory-1', runId: 'run-1', generation: 0 })
    expect(scope.imageSupported).toBe(true)
    expect(scope.provider).toBe('openai-codex')
    expect(scope.assertCurrent).not.toThrow()
    h.changeDocument()
    expect(scope.assertCurrent).toThrow('scope-revoked')
  })

  it('matches the actual Codex composite call ID without normalization or self-registering from the payload', async () => {
    const h = fixture()
    h.request.toolCallId = 'call_actual|fc_actual'
    h.source.toolCallId = h.request.toolCallId
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    await expect(h.admit()).resolves.toMatchObject({ owner: { runtimeId: 'factory-1' } })
    await expect(h.admit({ ...h.request, toolCallId: 'call_actual' })).rejects.toThrow('source-unverified')
  })

  it.each(['ended', 'wrong-run', 'wrong-model', 'yolo', 'plan'] as const)('reapplies %s admission rather than trusting the payload nonce', async kind => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    if (kind === 'ended') h.backend.nativeToolReceipts!.get('actual-root')!.state = 'ended'
    if (kind === 'wrong-run') h.backend.activeRunId = 'other-run'
    if (kind === 'wrong-model') h.request.modelId = 'payload-model'
    if (kind === 'yolo') h.bridge.yoloSessions.add(h.backend.key)
    if (kind === 'plan') h.bridge.desiredModes.set(h.backend.key, 'plan')
    await expect(h.admit()).rejects.toThrow()
    expect(h.service.start).not.toHaveBeenCalled()
    expect(h.service.capture).not.toHaveBeenCalled()
  })

  it('permits egress only after real root source registration and between tool batches, not inside codemode/subagents', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    const { toolCallId: _id, ...fields } = h.request
    const egress = { ...fields, operation: 'egress' as const }
    await expect(h.admit(egress)).rejects.toThrow('source-unverified')
    h.backend.nativeToolReceipts!.get('actual-root')!.state = 'ended'
    await expect(h.admit(egress)).resolves.toMatchObject({ provider: 'openai-codex', modelId: 'exact-model' })
    h.bridge.trackBackendEvent(h.backend, { type: 'tool_execution_start', toolName: 'pion_subagents', toolCallId: 'subagent-parent' }, 'tool_execution_start')
    await expect(h.admit(egress)).rejects.toThrow('source-unverified')
  })

  it('binds retention identity to the actual SDK session file/id and client/factory incarnation, not payload IDs or runs', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    const first = await h.admit()
    h.backend.nativeToolReceipts!.get('actual-root')!.state = 'ended'
    const { toolCallId: _id, ...fields } = h.request
    const egress = { ...fields, operation: 'egress' as const }
    h.backend.activeRunId = h.run.id = 'actual-run-2'
    const next = await h.admit(egress)
    expect(next.owner.runId).toBe('actual-run-2')
    expect(next.sessionIdentity).toBe(first.sessionIdentity)
    h.state.sessionId = 'different-real-session'
    const replaced = await h.admit(egress)
    expect(replaced.sessionIdentity).not.toBe(first.sessionIdentity)
    expect(next.assertCurrent).toThrow('scope-revoked')
    h.state.sessionFile = '/some-other/actual-session.jsonl'
    await expect(h.admit(egress)).rejects.toThrow('source-unverified')
  })

  it('unwatch reuses only its original backend/client/runtime admission after provider/abort settles, without a new state RPC or permission grant', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    h.backend.nativeToolReceipts!.get('actual-root')!.state = 'ended'
    const { toolCallId: _id, ...fields } = h.request
    const watch = { ...fields, operation: 'watch' as const, requestId: 'actual-watch' }
    const captured = await h.admit(watch)
    const calls = h.client.getState.mock.calls.length
    h.backend.busy = false
    h.backend.activeRunId = undefined
    h.backend.controlDispatchPromises = new Set([new Promise(() => undefined)])
    const cleanup = { ...fields, operation: 'unwatch' as const, requestId: 'cleanup-own-watch', watchRequestId: watch.requestId }
    await expect(h.admit(cleanup)).resolves.toBe(captured)
    await expect(h.admit(cleanup)).resolves.toBe(captured)
    expect(h.client.getState).toHaveBeenCalledTimes(calls)
    expect(captured.assertCurrent).toThrow()
    expect(captured.assertCleanupCurrent).not.toThrow()
    await expect(h.admit({ ...cleanup, watchRequestId: 'unknown-watch' })).rejects.toThrow('source-unverified')
    await expect(h.admit({ ...cleanup, runtimeNonce: 'payload-only-nonce' })).rejects.toThrow('source-unverified')
    h.backend.client = { ...h.client } as unknown as BackendRecord['client']
    await expect(h.admit(cleanup)).rejects.toThrow('source-unverified')
    expect(h.service.start).not.toHaveBeenCalled()
    expect(h.service.act).not.toHaveBeenCalled()
  })

  it('confirms screenshot entry provenance only from the captured SDK entry event and root factory receipt', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    const admitted = await h.admit()
    const record = vi.spyOn(h.bridge.computerUseAgent, 'recordScreenshotEntry')
    const entry = { type: 'message', id: 'actual-sdk-entry', message: { role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'actual-root' } }
    h.bridge.recordComputerUseScreenshotEntry(h.backend, { type: 'entry_appended', entry })
    expect(record).toHaveBeenCalledWith(admitted.sessionIdentity,
      { backendId: h.backend.usageBackendId, runtimeId: h.source.runtimeId, runId: h.run.id, toolCallId: 'actual-root' }, entry)
    record.mockClear()
    h.backend.nativeToolReceipts!.get('actual-root')!.parentId = 'unknown-codemode'
    h.bridge.recordComputerUseScreenshotEntry(h.backend, { type: 'entry_appended', entry })
    expect(record).not.toHaveBeenCalled()
  })

  it('admits retained only from the original ended observe root and the same actual SDK file/id/client, never reminting restored identity', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    const observed = await h.admit()
    const request: ComputerUseAgentRequest = { ...h.request, operation: 'retained', requestId: 'retained-1', retained: {
      observationRequestId: h.request.requestId, entryId: 'actual-entry', sessionFile: h.state.sessionFile, sessionId: h.state.sessionId,
      frameId: 'frame', scopeRevision: 1, width: 1, height: 1, imageHash: 'a'.repeat(64), imageBytes: 80 } }
    await expect(h.admit(request)).rejects.toThrow('source-unverified') // still running
    h.backend.nativeToolReceipts!.get('actual-root')!.state = 'ended'
    await expect(h.admit(request)).resolves.toMatchObject({ sessionIdentity: observed.sessionIdentity })
    await expect(h.admit({ ...request, retained: { ...request.retained!, sessionId: 'payload-session' } })).rejects.toThrow('source-unverified')
    h.state.sessionId = 'different-real-sdk-session'
    await expect(h.admit({ ...request, retained: { ...request.retained!, sessionId: h.state.sessionId } })).rejects.toThrow('source-unverified')
    expect(h.bridge.computerUseSessionIdentities.get(h.backend).identity).toBe(observed.sessionIdentity)
    h.state.sessionId = request.retained!.sessionId
    h.backend.nativeToolReceipts!.get('actual-root')!.parentId = 'nested-parent'
    await expect(h.admit(request)).rejects.toThrow('source-unverified')
  })

  it('completes observe -> next physical request with pinned message_end-before-append ordering and no entry_appended event (synthetic SDK/Main)', async () => {
    const h = fixture()
    h.bridge.requestComputerUseApproval = vi.fn(async () => true)
    // Real SDK tree/append and egress gate, memory-only. Persistence metadata,
    // taint IO, desktop and SSE transport are mocked; no file/OS/model/auth.
    const manager = SessionManager.inMemory(h.backend.cwd)
    vi.spyOn(manager, 'isPersisted').mockReturnValue(true)
    vi.spyOn(manager, 'getSessionFile').mockReturnValue(h.state.sessionFile)
    h.state.sessionId = manager.getSessionId()
    let desktop = createDisabledComputerUseStatus()
    h.service.getState.mockImplementation(() => structuredClone(desktop))
    h.service.start.mockImplementation(async (owner, consent) => {
      desktop = { ...desktop, state: 'ready', scopeRevision: 1, coordination: 'held', owner, consent }
      return structuredClone(desktop)
    })
    h.service.capture.mockImplementation(async () => {
      desktop = { ...desktop, frame: { id: 'native-frame', width: 1, height: 1, createdAt: 10, scopeRevision: 1, captureScope: 'window', actualScope: 'window' } }
      return { state: structuredClone(desktop), png: makeStaticPng(1, 1) }
    })
    const replies = new Map<string, (value: string) => void>()
    const privateRequests: ComputerUseAgentRequest[] = []
    h.bridge.respondToExtensionUi.mockImplementation((_client: unknown, id: string, value: { value: string }) => replies.get(id)!(value.value))
    const model = { ...h.state.model, api: 'openai-codex-responses' }
    const modelRegistry = {}
    let command: ExtensionCommandContext
    const channel = createComputerUseAgentChannel({ runtimeId: h.request.runtimeId, nonce: h.request.runtimeNonce, isCurrent: () => true, createContext: () => command })
    command = { hasUI: true, mode: 'rpc', modelRegistry, ui: { input: vi.fn((title: string) => new Promise<string>(resolve => {
      const request = JSON.parse(title.slice(COMPUTER_USE_AGENT_TITLE_PREFIX.length)) as ComputerUseAgentRequest
      privateRequests.push(request)
      const id = `private-dialog-${privateRequests.length}`
      replies.set(id, resolve)
      h.bridge.handleComputerUseAgentRequest(h.backend, h.client, { type: 'extension_ui_request', method: 'input', id, title })
    })) } } as unknown as ExtensionCommandContext
    const listeners = new Set<(event: any) => void>()
    const session = { sessionManager: manager, messages: [] as any[], extensionRunner: { createCommandContext: () => command }, dispose: vi.fn(),
      getActiveToolNames: () => [COMPUTER_USE_OBSERVE_TOOL], getAllTools: () => [{ name: COMPUTER_USE_OBSERVE_TOOL, sourceInfo: { source: 'sdk', path: `<sdk:${COMPUTER_USE_OBSERVE_TOOL}>` } }],
      subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    } as unknown as AgentSession
    const network = vi.fn(async () => new Response('synthetic SSE'))
    vi.stubGlobal('fetch', network)
    const runtime = { getPhysicalModel: () => model, getAvailableSnapshot: () => [model], getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
      streamSimple: vi.fn((_model: unknown, _context: unknown, options: { fetch: typeof fetch; onPayload: (payload: unknown, actual: unknown) => Promise<unknown> }) => {
        const stream = createAssistantMessageEventStream()
        void (async () => {
          const response = { role: 'assistant', content: [{ type: 'text', text: 'next turn' }], provider: model.provider, model: model.id,
            api: model.api, timestamp: 456, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage
          try {
            await options.onPayload({}, model)
            await options.fetch('https://example.invalid/synthetic-sse', { method: 'POST' })
            stream.push({ type: 'done', reason: 'stop', message: response }); stream.end(response)
          } catch (error) {
            const failed = { ...response, stopReason: 'error' as const, errorMessage: String(error) }
            stream.push({ type: 'error', reason: 'error', error: failed }); stream.end(failed)
          }
        })()
        return stream
      }) }
    let factory: ReturnType<typeof createComputerUseTools>
    const gate = createComputerUseModelGate(runtime as unknown as ModelRuntime, { runtimeId: h.request.runtimeId, sessionManager: manager,
      settingsManager: { getBlockImages: () => false, getTransport: () => 'sse' }, isCurrent: () => true,
      authorize: (actual, signal) => factory.authorizeEgress(actual, signal), assertObservation: channel.assertObservation,
      watch: (actual, signal) => {
        const request = channel.watch(actual, signal)
        return { watchRequestId: request.watchRequestId, isAcknowledged: request.isAcknowledged, result: request.result.then(value => ({ scopeRevision: value.scopeRevision! })) }
      }, unwatch: async (actual, watchRequestId) => { await channel('unwatch', actual, { watchRequestId }) } })
    factory = createComputerUseTools({ runtimeId: h.request.runtimeId, nonce: h.request.runtimeNonce, enabled: true, sessionManager: manager,
      getSession: () => session, getModels: () => gate.models, channel, gate, isCurrent: () => true })
    factory.attach(session)
    const events: any[] = []
    session.subscribe(event => { events.push(event); h.bridge.trackBackendEvent(h.backend, event, event.type) })
    const emit = (event: any) => { for (const listener of listeners) listener(event) }
    const assistant = { role: 'assistant', provider: model.provider, model: model.id, content: [{ type: 'toolCall', id: h.request.toolCallId, name: COMPUTER_USE_OBSERVE_TOOL, arguments: {} }] } as never
    ;(session.messages as any[]).push(assistant)
    manager.appendMessage(assistant)
    emit({ type: 'tool_execution_start', toolCallId: h.request.toolCallId, toolName: COMPUTER_USE_OBSERVE_TOOL, args: {} })
    const result = await factory.tools[0].execute(h.request.toolCallId!, {}, undefined, undefined, { ...command, sessionManager: manager, cwd: h.backend.cwd, model } as unknown as ExtensionToolContext)
    expect(retentionIo.sync).toHaveBeenCalledOnce()
    const message = { ...result, role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: h.request.toolCallId, isError: false, timestamp: 123 } as never
    emit({ type: 'tool_execution_end', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: h.request.toolCallId, result })
    emit({ type: 'message_start', message })
    emit({ type: 'message_end', message }) // actual pinned SDK listener order
    const signal = new AbortController().signal
    await expect(factory.authorizeEgress(model as never, signal)).rejects.toThrow('egress-revoked')
    expect(privateRequests.map(value => value.operation)).toEqual(['observe'])
    const actualEntryId = manager.appendMessage(message) // SDK persists after emit
    const next = await gate.models.streamSimple(model as never, { messages: [] }, { transport: 'sse' }).result()
    expect(next.stopReason).toBe('stop')
    expect(network).toHaveBeenCalledOnce()
    expect(privateRequests.slice(0, 3).map(value => value.operation)).toEqual(['observe', 'retained', 'egress'])
    expect(privateRequests.filter(value => value.operation === 'retained')).toHaveLength(1)
    expect(privateRequests.some(value => value.operation === 'unwatch')).toBe(true)
    expect(privateRequests[1]).toMatchObject({ toolCallId: h.request.toolCallId, retained: { observationRequestId: privateRequests[0].requestId,
      entryId: actualEntryId, sessionFile: h.state.sessionFile, sessionId: h.state.sessionId, scopeRevision: 1 } })
    expect(events.some(event => event.type === 'entry_appended')).toBe(false)
    expect(h.service.capture).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('rechecks the exact client and live document after the existing state RPC actually returns', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    let finish!: () => void
    const actual = h.client.getState.getMockImplementation()!
    h.client.getState.mockImplementation(() => new Promise(resolve => { finish = async () => resolve(await actual()) }))
    const scope = h.admit()
    h.backend.client = { ...h.client } as unknown as BackendRecord['client']
    finish()
    await expect(scope).rejects.toThrow('scope-revoked')
    expect(h.service.start).not.toHaveBeenCalled()
  })

  it('consumes malformed private traffic before normal UI and cannot self-register an egress runtime', async () => {
    const h = fixture()
    expect(h.bridge.handleComputerUseAgentRequest(h.backend, h.client, { type: 'extension_ui_request', method: 'select', title: COMPUTER_USE_AGENT_TITLE_PREFIX + '{bad', id: 'request' })).toBe(true)
    const { toolCallId: _id, ...fields } = h.request
    await expect(h.admit({ ...fields, operation: 'egress' })).rejects.toThrow('source-unverified')
    expect(h.backend.computerUseRuntimeId).toBeUndefined()
    expect(h.client.getState).not.toHaveBeenCalled()
  })

  it.each(['deny', 'timeout', 'allow-once'] as const)('ordinary ComputerUse permission %s withdraws only the matching scope unless positively approved', async resolution => {
    const h = fixture()
    const revoke = vi.spyOn(h.bridge.computerUseAgent, 'revokeBackend')
    const metadata = { cwd: h.backend.cwd, toolName: COMPUTER_USE_OBSERVE_TOOL, category: 'external', policyCategories: ['external', 'network', 'read'], summary: 'capture/upload', detail: 'capture/upload/retention', risks: [], canRemember: false }
    h.bridge.handleToolPermissionExtensionRequest(h.backend, { type: 'extension_ui_request', method: 'select', id: 'ordinary-cua-gate', title: TOOL_PERMISSION_MARKER + JSON.stringify(metadata) })
    const request = h.pending.getToolPermissionRequests()[0]
    if (resolution === 'timeout') h.bridge.clearToolPermissionRequest(request.id)
    else await h.bridge.resolveToolPermission(request.id, resolution)
    if (resolution === 'allow-once') expect(revoke).not.toHaveBeenCalled()
    else expect(revoke).toHaveBeenCalledWith(h.backend.usageBackendId)
    expect(h.pending.getToolPermissionRequests()).toEqual([])
  })

  it('reuses real tool approval UI but forbids remembering and rechecks deny on resolution', async () => {
    const h = fixture()
    h.start({ [COMPUTER_USE_AGENT_SOURCE_FIELD]: h.source })
    const scope = await h.admit()
    const approval = h.bridge.requestComputerUseApproval(scope, 'observe') as Promise<boolean>
    const request = h.pending.getToolPermissionRequests()[0]
    expect(request).toMatchObject({ canRemember: false, policyCategories: ['external', 'network', 'read'], category: 'external' })
    expect(request.detail).toContain('openai-codex/exact-model')
    expect(request.detail).toContain('SDK')
    await expect(h.bridge.resolveToolPermission(request.id, 'allow-session')).rejects.toThrow()
    h.rules.network = 'deny'
    await h.bridge.resolveToolPermission(request.id, 'allow-once')
    expect(await approval).toBe(false)
    expect(h.bridge.respondToExtensionUi).not.toHaveBeenCalled()
    expect(h.pending.getToolPermissionRequests()).toEqual([])
  })
})
