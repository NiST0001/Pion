import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { AgentSession, ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import { createPionRuntime, parseRuntimeArgs } from '../../src/main/agent/runtime-host'
import * as capabilitySettings from '../../src/main/capability-settings'
import * as capabilityCatalogue from '../../src/main/capability-catalogue'
import * as capabilityMcp from '../../src/main/agent/capability-mcp'
import * as nativeExtensions from '../../src/main/agent/native-extensions'
import { DEFAULT_CAPABILITY_PREFERENCES } from '../../src/shared/capability-settings'
import * as modelGate from '../../src/main/agent/computer-use-model-gate'
import * as computerUse from '../../src/main/agent/computer-use'

const mocks = vi.hoisted(() => ({ services: vi.fn(), session: vi.fn(), runtime: vi.fn(), settings: vi.fn(), create: vi.fn(), open: vi.fn(), image: vi.fn(), auth: vi.fn() }))
const io = vi.hoisted(() => ({ open: vi.fn(() => 7), sync: vi.fn(), close: vi.fn() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), openSync: io.open, fsyncSync: io.sync, closeSync: io.close }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...await original<typeof import('@earendil-works/pi-coding-agent')>(),
  createAgentSessionServices: mocks.services,
  createAgentSessionFromServices: mocks.session,
  createAgentSessionRuntime: mocks.runtime,
  SettingsManager: { create: mocks.settings },
  SessionManager: { create: mocks.create, open: mocks.open }
}))
vi.mock('../../src/main/agent/image-generation', () => ({ createImageGenerationTool: mocks.image }))
const cwd = resolve('project')
const fakeSession = (sessionManager: unknown, getActiveToolNames = () => ['read', 'bash', 'edit', 'write']) => ({
  sessionManager, getActiveToolNames, subscribe: vi.fn(() => vi.fn()), dispose: vi.fn()
})
beforeEach(() => {
  vi.clearAllMocks()
  // These cases cover the no-preferences Pi activation path. Do not inherit
  // the running Pion instance's capability file or scan its real resources.
  vi.stubEnv('PION_CAPABILITY_SETTINGS_FILE', undefined)
  const manager = { getCwd: () => cwd, buildSessionContext: () => ({ messages: [] }),
    getEntries: () => [], getBranch: () => [], getEntry: () => undefined,
    getSessionId: () => 'mock-session', getSessionFile: () => undefined, appendMessage: vi.fn(),
    getHeader: () => ({ type: 'session', version: 3, id: 'mock-session', cwd, timestamp: '' }) }
  const settings = { getEnabledModels: () => [], getDefaultProvider: () => undefined, getDefaultModel: () => undefined, getDefaultTools: () => undefined, getSettings: () => ({}), applyOverrides: vi.fn(), getBlockImages: () => false, getTransport: () => 'sse' }
  mocks.create.mockReturnValue(manager)
  mocks.open.mockReturnValue(manager)
  mocks.settings.mockReturnValue(settings)
  mocks.auth.mockResolvedValue(undefined)
  mocks.image.mockImplementation((options) => ({
    name: 'pion_generate_image',
    // Exercise only the injected runtime boundary, not the real image API.
    execute: async (signal: AbortSignal) => options.getAuth({ signal, minOAuthValidityMs: 300_000 })
  }))
  // SDK replacements create new service/runtime objects, never another facade
  // around the previous backend's already-retired model runtime.
  mocks.services.mockImplementation(async () => ({ settingsManager: settings, modelRuntime: { getAuth: mocks.auth }, resourceLoader: { getExtensions: () => ({ extensions: [] }), getSkills: () => ({ skills: [] }) }, diagnostics: [] }))
  mocks.session.mockImplementation(async ({ sessionManager }) => ({ session: fakeSession(sessionManager), extensionsResult: {} }))
  mocks.runtime.mockImplementation(async (factory, target) => factory(target))
})
afterEach(() => { vi.unstubAllEnvs() })

it('parses only the private RPC arguments and fails closed on unknown flags', () => {
  expect(parseRuntimeArgs(['--mode', 'rpc', '--no-approve', '--extension', './permissions.ts'], cwd)).toMatchObject({ approved: false, extensions: [resolve(cwd, 'permissions.ts')] })
  expect(() => parseRuntimeArgs(['--session'], cwd)).toThrow(/Missing/)
  expect(() => parseRuntimeArgs(['--mode', 'print'], cwd)).toThrow(/RPC/)
  expect(() => parseRuntimeArgs(['--unexpected'], cwd)).toThrow(/Unsupported/)
})

it('injects a compiled SDK tool, preserves trust gating, and recreates tools for replacement sessions', async () => {
  const initial = await createPionRuntime(['--mode', 'rpc', '--no-approve', '--extension', './permissions.ts'], cwd)
  expect(mocks.settings).toHaveBeenCalledWith(cwd, expect.any(String), { projectTrusted: false })
  expect(mocks.session).toHaveBeenCalledWith(expect.objectContaining({ customTools: [expect.objectContaining({ name: 'pion_ask_user' }), expect.objectContaining({ name: 'pion_subagents' }), expect.objectContaining({ name: 'pion_generate_image' })] }))
  expect(mocks.image).toHaveBeenCalledWith({ cwd, getAuth: expect.any(Function) })
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(mocks.services).toHaveBeenCalledWith(expect.objectContaining({ resourceLoaderOptions: { additionalExtensionPaths: [resolve(cwd, 'permissions.ts')], extensionFactories: [
    expect.objectContaining({ name: 'codemode', builtin: true, replaceable: true }),
    expect.objectContaining({ name: 'tool-search', builtin: true, replaceable: true }),
    expect.objectContaining({ name: 'mcp', builtin: true, replaceable: true }),
    expect.any(Function), expect.objectContaining({ name: 'pion-subagents', factory: expect.any(Function) }),
    expect.any(Function), expect.any(Function),
    expect.objectContaining({ name: 'pion-conversation-timing', factory: expect.any(Function) })
  ] } }))
  const [factory, target] = mocks.runtime.mock.calls[0]
  // Match SDK teardownCurrent: disposal precedes replacement factory invocation.
  initial.session.dispose()
  await factory({ ...target, sessionStartEvent: { reason: 'new' } })
  expect(mocks.session).toHaveBeenCalledTimes(2)
  expect(mocks.image).toHaveBeenCalledTimes(2)
  const firstFactories = mocks.services.mock.calls[0][0].resourceLoaderOptions.extensionFactories
  const nextFactories = mocks.services.mock.calls[1][0].resourceLoaderOptions.extensionFactories
  for (let index = 0; index < 3; index++) {
    expect(nextFactories[index]).not.toBe(firstFactories[index])
    expect(nextFactories[index].factory).not.toBe(firstFactories[index].factory)
  }
  for (const index of [3, 5]) expect(nextFactories[index]).not.toBe(firstFactories[index])
  const firstImage = mocks.session.mock.calls[0][0].customTools[2]
  const secondImage = mocks.session.mock.calls[1][0].customTools[2]
  expect(secondImage).not.toBe(firstImage)
  expect(mocks.auth).not.toHaveBeenCalled()
  await expect(factory({ ...target, cwd: resolve('other-project') })).rejects.toThrow(/跨项目/)
  await expect(factory({ ...target, sessionManager: { ...target.sessionManager, getCwd: () => resolve('other-project') } })).rejects.toThrow(/跨项目/)
  expect(mocks.image).toHaveBeenCalledTimes(2)
})

it('installs timing inside the Cua append/dispose chain and restores the manager before rebuilding (wrapper fakes only)', async () => {
  const manager = mocks.create()
  const baseAppend = manager.appendMessage
  const innerAppends: AgentSession['sessionManager']['appendMessage'][] = []
  const toolFactory = vi.spyOn(computerUse, 'createComputerUseTools').mockImplementation(() => ({
    tools: [], authorizeEgress: vi.fn(),
    attach(session: AgentSession) {
      const innerAppend = session.sessionManager.appendMessage
      expect(innerAppend).not.toBe(baseAppend)
      expect(innerAppends).not.toContain(innerAppend)
      innerAppends.push(innerAppend)
      const innerDispose = session.dispose
      const outer: typeof innerAppend = message => innerAppend.call(manager, message)
      manager.appendMessage = outer
      session.dispose = () => {
        expect(manager.appendMessage).toBe(outer)
        manager.appendMessage = innerAppend
        innerDispose.call(session)
      }
    }
  }))
  try {
    const initial = await createPionRuntime(['--mode', 'rpc'], cwd)
    initial.session.dispose()
    expect(manager.appendMessage).toBe(baseAppend)
    const [factory, target] = mocks.runtime.mock.calls[0]
    const replacement = await factory(target)
    replacement.session.dispose()
    expect(manager.appendMessage).toBe(baseAppend)
    expect(innerAppends).toHaveLength(2)
    expect(mocks.auth).not.toHaveBeenCalled()
  } finally { toolFactory.mockRestore() }
})

it('captures each backend’s own model runtime and only resolves Codex OAuth when the image tool executes', async () => {
  const initial = await createPionRuntime(['--mode', 'rpc', '--approve'], cwd)
  const [factory, target] = mocks.runtime.mock.calls[0]
  const nextAuth = vi.fn().mockResolvedValue(undefined)
  const services = await mocks.services.mock.results[0].value
  const nextModels = { getAuth: nextAuth }
  mocks.services.mockResolvedValue({ ...services, modelRuntime: nextModels })
  initial.session.dispose()
  await factory({ ...target, sessionStartEvent: { reason: 'resume' } })
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(nextAuth).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  await mocks.session.mock.calls[0][0].customTools[2].execute(signal)
  expect(mocks.auth).toHaveBeenCalledWith('openai-codex', { signal, minOAuthValidityMs: 300_000 })
  expect(nextAuth).not.toHaveBeenCalled()
  await mocks.session.mock.calls[1][0].customTools[2].execute(signal)
  expect(nextAuth).toHaveBeenCalledWith('openai-codex', { signal, minOAuthValidityMs: 300_000 })
  expect(mocks.auth).toHaveBeenCalledTimes(1)
  expect(mocks.auth.mock.contexts[0]).not.toBe(services.modelRuntime)
  expect(mocks.auth.mock.contexts[0]).toHaveProperty('getAuth', mocks.auth)
  expect(nextAuth.mock.contexts[0]).toBe(nextModels)
})

it('keeps independent image OAuth usable after live taint without exempting SDK history auth or streams (spies only)', async () => {
  const model = { provider: 'openai-codex', id: 'mock-vision', api: 'openai-codex-responses', input: ['text', 'image'] } as Model<Api>
  const entries: SessionEntry[] = [{ type: 'message', id: 'user', parentId: null, timestamp: '', message: { role: 'user', content: 'mock', timestamp: 1 } }]
  Object.assign(mocks.create(), { getEntries: () => [...entries], getBranch: () => [...entries],
    isPersisted: () => true, getSessionFile: () => '/mock/session.jsonl',
    appendCustomEntry: (customType: string, data: unknown) => {
      entries.push({ type: 'custom', id: 'taint', parentId: 'user', timestamp: '', customType, data })
      return 'taint'
    } })
  const rawModels = { getAuth: mocks.auth, login: vi.fn(), streamSimple: vi.fn(),
    getPhysicalModel: () => model, getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined }
  mocks.services.mockResolvedValue({ settingsManager: mocks.settings(), modelRuntime: rawModels,
    resourceLoader: { getExtensions: () => ({ extensions: [] }) }, diagnostics: [] })
  const createGate = modelGate.createComputerUseModelGate
  const authorize = vi.fn().mockRejectedValue(new Error('Main egress denied'))
  const gateFactory = vi.spyOn(modelGate, 'createComputerUseModelGate').mockImplementationOnce((runtime, options) =>
    // Synthetic Main observation/approval boundaries; marker filesystem is also
    // mocked above. No screenshot, credential store, provider or network runs.
    createGate(runtime, { ...options, authorize, assertObservation: vi.fn() }))
  await createPionRuntime(['--mode', 'rpc', '--approve'], cwd)
  const gate = gateFactory.mock.results[0].value!
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(io.open).not.toHaveBeenCalled()
  gate.retain(model, { version: 1, operation: 'observe', requestId: 'mock-observe', ok: true, scopeRevision: 4,
    image: { mimeType: 'image/png', data: 'synthetic-only' } })
  expect(modelGate.computerUseHistoryState(mocks.create(), gateFactory.mock.calls[0][1].runtimeId)).toBe('current')
  const { services, customTools } = mocks.session.mock.calls[0][0]
  expect(services.modelRuntime).toBe(gate.models)
  expect(services.modelRuntime).not.toBe(rawModels)
  await expect(services.modelRuntime.getAuth(model)).rejects.toThrow('Main egress denied')
  await expect(services.modelRuntime.getAuth('openai-codex')).rejects.toThrow(/egress denied/)
  expect(await services.modelRuntime.streamSimple(model, { messages: [] }).result()).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('Main egress denied') })
  expect(rawModels.streamSimple).not.toHaveBeenCalled()
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(authorize).toHaveBeenCalledTimes(2)
  const signal = new AbortController().signal
  await services.modelRuntime.login('openai-codex', 'oauth', { signal })
  expect(rawModels.login).toHaveBeenCalledWith('openai-codex', 'oauth', { signal })
  const auth = { source: 'OAuth', auth: { apiKey: 'synthetic-only' } }
  mocks.auth.mockResolvedValue(auth)
  // Execute only the injected auth closure at the image tool boundary, after
  // its unchanged permission/input gates; it receives no SDK screenshot history.
  expect(await customTools[2].execute(signal)).toBe(auth)
  expect(mocks.auth).toHaveBeenCalledExactlyOnceWith('openai-codex', { signal, minOAuthValidityMs: 300_000 })
  expect(mocks.auth.mock.contexts[0]).toBe(rawModels)
  await expect(services.modelRuntime.getAuth(model)).rejects.toThrow('Main egress denied')
  expect(authorize).toHaveBeenCalledTimes(3)
  expect(mocks.auth).toHaveBeenCalledTimes(1)
})

it.each([
  { selection: undefined }, { selection: [] }, { selection: ['read'] },
  { selection: ['-codemode', '-tool_search'] }, { selection: ['+codemode', '+tool_search'] }
])('delegates default activation to Pi without overriding settings ($selection)', async ({ selection }) => {
  const settings = mocks.settings()
  const raw = selection === undefined ? {} : { defaultTools: selection }
  settings.getSettings = () => raw
  const getDefaultTools = vi.fn(() => selection)
  settings.getDefaultTools = getDefaultTools
  // Present registered native helpers: the removed host policy would force
  // +codemode/+tool_search for an undefined loadout even before MCP connects.
  mocks.services.mockResolvedValue({
    settingsManager: settings, modelRuntime: { getAuth: mocks.auth }, diagnostics: [],
    resourceLoader: { getExtensions: () => ({ extensions: [
      { path: 'builtin:codemode', tools: new Map([['codemode', { definition: { name: 'codemode' } }]]) },
      { path: 'builtin:tool-search', tools: new Map([['tool_search', { definition: { name: 'tool_search' } }]]) }
    ] }) }
  })
  await createPionRuntime(['--mode', 'rpc'], cwd)
  expect(settings.applyOverrides).not.toHaveBeenCalled()
  expect(settings.getSettings()).toEqual(raw)
  expect(getDefaultTools).not.toHaveBeenCalled()
  expect(mocks.services.mock.calls[0][0].settingsManager).toBe(settings)
  expect(mocks.session.mock.calls[0][0]).not.toHaveProperty('tools')
  expect(mocks.session.mock.calls[0][0]).not.toHaveProperty('noTools')
})

it('freezes raw explicit loadouts before RPC MCP lifecycle binding', async () => {
  const settings = mocks.settings()
  settings.getSettings = () => ({ defaultTools: ['+codemode', '+mcp__docs__*', '-mcp__docs__delete*'] })
  settings.getDefaultTools = () => ['codemode', 'mcp__docs__*']
  const initial = ['read', 'bash', 'edit', 'write', 'codemode']
  const getActiveToolNames = vi.fn(() => [...initial])
  mocks.session.mockResolvedValue({ session: fakeSession(mocks.create(), getActiveToolNames), extensionsResult: {} })
  await createPionRuntime(['--mode', 'rpc'], cwd)
  expect(settings.applyOverrides).not.toHaveBeenCalled()
  expect(getActiveToolNames).toHaveBeenCalledTimes(1)
  const factories = mocks.services.mock.calls[0][0].resourceLoaderOptions.extensionFactories
  const handlers = new Map<string, (event: any) => unknown>()
  const pi = {
    getActiveTools: () => ['read', 'codemode', 'tool_search', 'mcp__other__get'],
    setActiveTools: vi.fn(),
    on: (name: string, handler: (event: any) => unknown) => { handlers.set(name, handler); return () => {} }
  }
  factories[3](pi) // execution gate
  factories[5](pi) // no-policy declaration lifecycle
  // Binding after creation sees an MCP-expanded loadout; it cannot recapture it.
  handlers.get('session_start')!({ reason: 'startup' })
  const call = (toolName: string) => handlers.get('tool_call')!({ toolName, input: {}, parentToolCallId: 'codemode/1' })
  expect(call('write')).toBeUndefined()
  expect(call('mcp__docs__get')).toBeUndefined()
  expect(call('mcp__docs__delete_all')).toMatchObject({ block: true })
  expect(call('mcp__other__get')).toMatchObject({ block: true })
  expect(call('tool_search')).toMatchObject({ block: true })
})

it('uses capability lifecycle declarations and the single ceiling gate without duplicate loadout hooks', async () => {
  vi.stubEnv('PION_CAPABILITY_SETTINGS_FILE', '/fixture/capabilities.json')
  const settings = mocks.settings()
  settings.getSettings = () => ({ defaultTools: ['read'] })
  settings.getDefaultTools = () => ['read']
  const loadout = nativeExtensions.createPionNativeLoadoutBoundary(['read'])
  const spies = [
    vi.spyOn(capabilitySettings, 'readCapabilityPreferences').mockResolvedValue(DEFAULT_CAPABILITY_PREFERENCES),
    vi.spyOn(capabilityCatalogue, 'readCapabilityResources').mockResolvedValue({ catalogueRevision: 'fixture', items: [], notices: [],
      extensionPaths: [], skillPaths: [], promptPaths: [], themePaths: [] }),
    vi.spyOn(capabilityMcp, 'loadCapabilityMcpConfiguration').mockReturnValue({ config: { servers: [], errors: [] }, items: [], notices: [] }),
    vi.spyOn(nativeExtensions, 'createPionNativeLoadoutBoundary').mockReturnValue(loadout)
  ]
  try {
    await createPionRuntime(['--mode', 'rpc'], cwd)
    const factories = mocks.services.mock.calls[0][0].resourceLoaderOptions.extensionFactories
    expect(factories).not.toContain(loadout.capture)
    expect(factories).not.toContain(loadout.declarations)
    let active = ['read', 'write']
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const policy = factories.find((entry: { name?: string }) => entry.name === 'pion-capability-policy')
    policy.factory({ registerCommand: vi.fn(), getMcpServers: () => [],
      getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names] },
      getAllTools: () => ['read', 'write'].map(name => ({ name, exposure: 'direct',
        sourceInfo: { path: `builtin:${name}`, source: 'builtin', scope: 'temporary', origin: 'top-level' } })),
      on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler) }
    } as unknown as ExtensionAPI)
    const allowed = vi.spyOn(loadout, 'allowed')
    expect(handlers.get('tool_call')!({ toolName: 'read' })).toBeUndefined()
    expect(allowed).toHaveBeenCalledExactlyOnceWith('read')
    allowed.mockClear()
    expect(handlers.get('tool_call')!({ toolName: 'write' })).toMatchObject({ block: true })
    expect(allowed).toHaveBeenCalledExactlyOnceWith('write')
    for (const type of ['session_start', 'session_tree', 'before_agent_start']) {
      active = ['read', 'write'] // Simulate an SDK registry/branch loadout refresh.
      const event = { systemPromptOptions: { selectedTools: [...active] } }
      const ctx = { sessionManager: { getBranch: () => [] } }
      handlers.get(type)!(event, ctx)
      expect(active).toEqual(['read'])
      if (type === 'before_agent_start') expect(event.systemPromptOptions.selectedTools).toEqual(['read'])
      active = [] // A user-hidden/empty subset remains empty across every hook.
      handlers.get(type)!(event, ctx)
      expect(active).toEqual([])
    }
  } finally { spies.forEach(spy => spy.mockRestore()) }
})

it('rejects a stored session from another project before creating services or tools', async () => {
  mocks.open.mockReturnValue({ getCwd: () => resolve('other-project') })
  await expect(createPionRuntime(['--mode', 'rpc', '--session', 'foreign.jsonl'], cwd)).rejects.toThrow('不匹配')
  expect(mocks.services).not.toHaveBeenCalled()
  expect(mocks.image).not.toHaveBeenCalled()
  expect(mocks.auth).not.toHaveBeenCalled()
})
