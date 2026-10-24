import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import {
  createAgentSessionFromServices, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionCommandContext, type InlineExtension,
  type McpExtensionOptions, type ModelRuntime, type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import {
  CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_MAX_CHARS, CAPABILITY_RUNTIME_SOURCE,
  DEFAULT_CAPABILITY_PREFERENCES, PI_CORE_TOOL_NAMES, type CapabilityPreferences, type CapabilityRuntimeNotice
} from '../../src/shared/capability-settings'
import { capabilityResourceId } from '../../src/main/capability-ids'
import {
  capabilityResourceSettings, capabilityRuntimeDescription,
  createCapabilityPolicy, expandCapabilityDefaultTools, immutableCapabilityPreferences
} from '../../src/main/agent/capability-policy'
import { createPionNativeExtensions, createPionNativeLoadoutBoundary, createPionNativeMcpCloseBarrier } from '../../src/main/agent/native-extensions'
import { createMcpStatusObserver } from '../../src/main/agent/mcp-status-observer'
import { readMcpStatusNotice } from '../../src/shared/mcp'
import { createSubagentControl } from '../../src/main/agent/subagents'

const sessions: AgentSession[] = []
const roots: string[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const preferences = (defaults: Partial<CapabilityPreferences['defaults']> = {}, overrides: Record<string, boolean> = {}): CapabilityPreferences => ({
  version: 1, revision: 4, defaults: { ...DEFAULT_CAPABILITY_PREFERENCES.defaults, ...defaults }, overrides
})
const presetPreferences = (mode: 'inherit' | 'standard' | 'minimal'): CapabilityPreferences => mode === 'inherit' ? preferences()
  : mode === 'standard' ? preferences({ tool: true, extension: true, mcp: true, skill: true })
    : preferences({ tool: false, extension: false, mcp: false, skill: false }, Object.fromEntries(PI_CORE_TOOL_NAMES.map((name) => [`tool:${name}`, true])))
const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, label: name, description: name, parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text', text: 'fixture' }], details: undefined }), ...extra
})

/** Real SDK registries/extension pipeline, inert model runtime. No prompt that
 * reaches a provider, credentials, worker, shell, package install, or MCP server. */
async function fixture(prefs: CapabilityPreferences, options: {
  defaultTools?: string[]; extensions?: InlineExtension[]; customTools?: ToolDefinition[]
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pion-capability-policy-'))
  roots.push(root)
  const settings = SettingsManager.inMemory({ cacheWarming: 'off',
    ...(options.defaultTools !== undefined ? { defaultTools: options.defaultTools } : {}) })
  const loadout = createPionNativeLoadoutBoundary(options.defaultTools)
  const policy = createCapabilityPolicy({ preferences: prefs, cwd: root, runtimeId: 'runtime-fixture', loadout,
    defaultTools: options.defaultTools, items: [], notices: [], getSessionPath: () => undefined,
    getSubagentsEnabled: () => false, getMcpItems: () => [] })
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'),
    settingsManager: capabilityResourceSettings(settings), noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(options.extensions ?? []), loadout.capture, loadout.declarations, policy.extension],
    extensionsOverride: policy.extensionsOverride, skillsOverride: policy.skillsOverride })
  await loader.reload()
  const customTools = options.customTools ?? []
  const selection = policy.initialize(customTools, settings.getDefaultTools(), () => loader.getSkills().skills)
  // Factory accepts an explicit model without resolving authentication/catalogues.
  const model = { provider: 'fixture', id: 'inert', api: 'openai-completions', name: 'inert',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10000, maxTokens: 1000 } as AgentSession['model']
  const provider = vi.fn(() => { throw new Error('A capability-policy fixture must never call a provider') })
  const models = { streamSimple: provider, getAuth: provider, checkAuth: provider,
    getModel: () => model, getAvailableSnapshot: () => [], hasConfiguredAuth: () => false } as unknown as ModelRuntime
  const { session } = await createAgentSessionFromServices({ services: { cwd: root, agentDir: join(root, 'agent'),
    settingsManager: settings, modelRuntime: models, resourceLoader: loader, diagnostics: [] },
    sessionManager: SessionManager.inMemory(root), model, thinkingLevel: 'off', customTools, ...selection })
  sessions.push(session)
  await session.bindExtensions({})
  return { root, settings, policy, loader, session, provider, selection }
}
const receipt = (host: Awaited<ReturnType<typeof fixture>>): CapabilityRuntimeNotice =>
  JSON.parse(host.session.extensionRunner!.getCommand(CAPABILITY_RUNTIME_COMMAND)!.description!)

it('captures immutable preferences without aliasing the next revision', () => {
  const original = preferences({ tool: false }, { 'tool:read': true })
  const snapshot = immutableCapabilityPreferences(original)
  original.defaults.tool = true
  original.overrides['tool:read'] = false
  expect(snapshot.defaults.tool).toBe(false)
  expect(snapshot.overrides['tool:read']).toBe(true)
  expect(Object.isFrozen(snapshot.defaults)).toBe(true)
  expect(Object.isFrozen(snapshot.overrides)).toBe(true)
})

it('strips only public resource lists and binds other settings methods to their real receiver', () => {
  class Settings {
    #token = 'receiver'
    snapshot = { packages: ['npm:must-not-install'], extensions: ['unsafe.ts'], skills: ['unsafe'], prompts: ['unsafe'], themes: ['unsafe'], defaultTools: ['read'] }
    getGlobalSettings() { return this.snapshot }
    getProjectSettings() { return this.snapshot }
    getDefaultProvider() { return this.#token }
  }
  const original = new Settings()
  const facade = capabilityResourceSettings(original as unknown as SettingsManager)
  expect(facade.getGlobalSettings()).toEqual({ defaultTools: ['read'] })
  expect(facade.getProjectSettings()).toEqual({ defaultTools: ['read'] })
  expect(facade.getDefaultProvider()).toBe('receiver')
  expect(original.snapshot.packages).toEqual(['npm:must-not-install'])
})

it('resource parsing never installs configured packages or loads unselected entry points', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-capability-resources-'))
  roots.push(root)
  const settings = SettingsManager.inMemory({ packages: ['npm:pion-must-not-install'], extensions: ['missing-extension.ts'] })
  const npm = vi.spyOn(settings, 'getNpmCommand').mockImplementation(() => { throw new Error('No package-manager command in this test') })
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: capabilityResourceSettings(settings),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true })
  await loader.reload()
  expect(loader.getExtensions().extensions).toEqual([])
  expect(loader.getExtensions().errors).toEqual([])
  expect(npm).not.toHaveBeenCalled()
  expect(settings.getGlobalSettings().packages).toEqual(['npm:pion-must-not-install'])
})

it('loads a catalogue-selected builtin despite its original SDK resource switch, without changing that setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-capability-builtin-'))
  roots.push(root)
  const settings = SettingsManager.inMemory({ extensions: ['-builtin:codemode'] })
  const factory = vi.fn((pi: ExtensionAPI) => { pi.registerTool(tool('codemode', { defaultActive: false })) })
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'),
    settingsManager: capabilityResourceSettings(settings), noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: ['builtin:codemode'],
    extensionFactories: [{ name: 'codemode', builtin: true, replaceable: true, factory }] })
  await loader.reload()
  expect(factory).toHaveBeenCalledOnce()
  expect(loader.getExtensions().extensions.map((entry) => entry.path)).toEqual(['builtin:codemode'])
  expect(loader.getExtensions().extensions[0].tools.has('codemode')).toBe(true)
  expect(settings.getGlobalSettings().extensions).toEqual(['-builtin:codemode'])
})

it('minimal keeps only real Pi core sources, rejects impersonation and defaults late unknown tools off', async () => {
  let pi!: ExtensionAPI
  const restoreHistory = vi.fn()
  const overrides = Object.fromEntries(PI_CORE_TOOL_NAMES.map((name) => [`tool:${name}`, true]))
  const host = await fixture(preferences({ tool: false, extension: false, mcp: false, skill: false }, overrides), {
    extensions: [(api) => { pi = api; api.registerTool(tool('read')); api.registerTool(tool('codemode')); api.registerTool(tool('pion_task')); api.on('session_start', restoreHistory) }],
    customTools: ['pion_ask_user', 'pion_subagents', 'pion_generate_image', 'pion_computer_observe', 'pion_computer_act'].map((name) => tool(name))
  })
  expect(host.session.getActiveToolNames().sort()).toEqual([...PI_CORE_TOOL_NAMES].sort())
  expect(restoreHistory).toHaveBeenCalledOnce()
  expect(host.session.getAllTools().every((entry) => entry.sourceInfo.source === 'builtin' && entry.sourceInfo.path === `builtin:${entry.name}`)).toBe(true)
  pi.registerTool(tool('mcp__late__call', { exposure: 'codemode' }))
  pi.registerTool(tool('late', { exposure: 'deferred' }))
  expect(host.session.getCallableToolNames().sort()).toEqual([...PI_CORE_TOOL_NAMES].sort())
  expect(host.provider).not.toHaveBeenCalled()
})

it('individual overrides beat a preset, but direct, search/codemode discovery and nested calls all exclude disabled tools', async () => {
  let pi!: ExtensionAPI
  const dangerous = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must-not-run' }], details: undefined }))
  const probe = tool('probe', { execute: async (_id, _args, _signal, _update, ctx) => ({
    content: [{ type: 'text', text: JSON.stringify({ names: ctx.tools.map((entry) => entry.name),
      outcome: await ctx.executeTool('disabled', {}) }) }], details: undefined }) })
  const host = await fixture(preferences({ tool: true }, { 'tool:disabled': false }), {
    extensions: [(api) => { pi = api; api.registerTool(tool('disabled', { exposure: 'codemode', execute: dangerous })); api.registerTool(probe) }]
  })
  expect(host.session.getAllTools().map((entry) => entry.name)).not.toContain('disabled')
  expect(host.session.getCallableToolNames()).not.toContain('disabled')
  const result = await host.session.agent.state.tools.find((entry) => entry.name === 'probe')!.execute('outer', {})
  const text = result.content.find((part) => part.type === 'text')!
  expect(JSON.parse(text.text)).toMatchObject({ outcome: { isError: true } })
  pi.registerTool(tool('disabled', { exposure: 'deferred', execute: dangerous }))
  expect(host.session.getCallableToolNames()).not.toContain('disabled')
  expect(dangerous).not.toHaveBeenCalled()
  expect(host.provider).not.toHaveBeenCalled()
  const minimal = await fixture(preferences({ tool: false }, { 'tool:probe': true }), { customTools: [probe] })
  expect(minimal.session.getActiveToolNames()).toEqual(['probe'])
})

it('inherit sends explicit-on SDK modifiers, preserving Pi defaults, auto-active extensions and explicit offs', async () => {
  const host = await fixture(preferences({}, { 'tool:grep': true, 'tool:codemode': true, 'tool:bash': false }), {
    extensions: [(api) => {
      api.registerTool(tool('codemode', { defaultActive: false }))
      api.registerTool(tool('extension_default'))
    }]
  })
  // Assert the real initialize return value supplied to the inert SDK fixture,
  // not merely the policy's desired-state getter.
  expect(host.selection).toEqual({ tools: ['+grep', '+codemode'], excludeTools: ['bash'] })
  expect(host.session.getActiveToolNames().sort()).toEqual(['codemode', 'edit', 'extension_default', 'grep', 'read', 'write'])
  expect(host.session.getCallableToolNames()).not.toContain('bash')
  expect(host.provider).not.toHaveBeenCalled()
})

it.each([
  { mode: 'inherit', defaultTools: ['read'] }, { mode: 'inherit', defaultTools: [] },
  { mode: 'standard', defaultTools: ['read'] }, { mode: 'minimal', defaultTools: ['read'] }
] as const)('$mode explicit-on cannot exceed SDK defaultTools=$defaultTools', async ({ mode, defaultTools }) => {
  const prefs = presetPreferences(mode)
  const host = await fixture({ ...prefs, overrides: { ...prefs.overrides, 'tool:grep': true, 'tool:codemode': true } }, {
    defaultTools: [...defaultTools],
    extensions: [(api) => { api.registerTool(tool('codemode', { defaultActive: false })) }]
  })
  expect(host.selection.tools).not.toContain('grep')
  expect(host.selection.tools).not.toContain('codemode')
  expect(host.session.getActiveToolNames()).toEqual(defaultTools)
  expect(host.session.getCallableToolNames()).not.toContain('codemode')
  expect(host.provider).not.toHaveBeenCalled()
})

it('expands SDK-resolved patterns over registered names only, with literal dots and no guessed glob syntax', () => {
  const resolved = SettingsManager.inMemory({ defaultTools: ['audit.*', 'mcp__docs__*', 'read'] }).getDefaultTools()
  expect([...expandCapabilityDefaultTools(resolved, ['read', 'audit.read', 'auditXread', 'mcp__docs__get', 'mcp__other__get'])])
    .toEqual(['read', 'audit.read', 'mcp__docs__get'])
  for (const entry of ['r?ad', 'r[ea]*', '{read,write}', '!write', '+grep']) {
    expect(() => expandCapabilityDefaultTools(['*', entry], ['read', 'write'])).toThrow('仅支持精确名称和 *')
  }
})

it('inherit expands * before capturing the native ceiling, without hidden or unknown late tools', async () => {
  let pi!: ExtensionAPI
  const host = await fixture(preferences(), { defaultTools: ['*'], extensions: [(api) => {
    pi = api
    api.registerTool(tool('optional', { defaultActive: false }))
    api.registerTool(tool('hidden', { exposure: 'hidden' }))
  }] })
  expect(host.settings.getDefaultTools()).toEqual(['*'])
  expect(host.session.getActiveToolNames().sort()).toEqual([...PI_CORE_TOOL_NAMES, 'optional'].sort())
  expect(receipt(host).items.find((item) => item.name === 'grep')).toMatchObject({ enabled: true, available: true })
  expect(host.session.getAllTools().some((entry) => entry.name === 'hidden')).toBe(false)
  pi.registerTool(tool('mcp__late__inspect', { exposure: 'codemode' }))
  pi.registerTool(tool('late', { exposure: 'deferred' }))
  expect(host.session.getCallableToolNames().sort()).toEqual([...PI_CORE_TOOL_NAMES, 'optional'].sort())
  expect(host.provider).not.toHaveBeenCalled()
})

it.each(['inherit', 'standard', 'minimal'] as const)('%s keeps raw negative write patterns above expanded * and desired on switches', async (mode) => {
  const prefs = presetPreferences(mode)
  const host = await fixture({ ...prefs, overrides: { ...prefs.overrides, 'tool:write': true } }, { defaultTools: ['*', '-wri*'] })
  // SDK removes modifiers by exact string, so the raw negative wildcard must
  // still be applied by the independent execution ceiling after expansion.
  expect(host.settings.getDefaultTools()).toEqual(['*'])
  const expected = PI_CORE_TOOL_NAMES.filter((name) => name !== 'write').sort()
  expect(host.session.getActiveToolNames().sort()).toEqual(expected)
  expect(host.session.getCallableToolNames().sort()).toEqual(expected)
  expect(host.session.getAllTools().some((entry) => entry.name === 'write')).toBe(false)
  expect(host.selection.tools).not.toContain('write')
  expect(host.provider).not.toHaveBeenCalled()
})

it.each(['inherit', 'standard', 'minimal'] as const)('%s initializes +grep from SDK resolved defaults without widening the original ceiling', async (mode) => {
  const host = await fixture(presetPreferences(mode), { defaultTools: ['+grep'], extensions: [(api) => {
    api.registerTool(tool('codemode', { defaultActive: false }))
  }] })
  const expected = ['read', 'bash', 'edit', 'write', 'grep']
  expect(host.settings.getDefaultTools()).toEqual(expected)
  expect(host.session.getActiveToolNames().sort()).toEqual([...expected].sort())
  expect(host.session.getCallableToolNames().sort()).toEqual([...expected].sort())
  expect(host.session.getAllTools().map((entry) => entry.name).sort()).toEqual([...expected].sort())
  expect(host.provider).not.toHaveBeenCalled()
})

it('standard intersects the ORIGINAL explicit defaultTools ceiling, including late MCP registrations', async () => {
  let pi!: ExtensionAPI
  const host = await fixture(preferences({ tool: true }), { defaultTools: ['read', 'mcp__docs__*', '-mcp__docs__delete*'],
    extensions: [(api) => { pi = api; api.registerTool(tool('codemode', { defaultActive: false })) }] })
  expect(host.session.getActiveToolNames()).toEqual(['read'])
  pi.registerTool(tool('mcp__docs__get', { exposure: 'codemode' }))
  pi.registerTool(tool('mcp__docs__delete_all', { exposure: 'codemode' }))
  pi.registerTool(tool('mcp__other__get', { exposure: 'deferred' }))
  expect(host.session.getCallableToolNames().sort()).toEqual(['mcp__docs__get', 'read'])
  expect(host.session.getAllTools().map((entry) => entry.name)).not.toContain('codemode')
  expect(host.provider).not.toHaveBeenCalled()
})

it('keeps inherit activation and hidden exposures, and reapplies plan declarations after late registration', async () => {
  const inherited = await fixture(preferences())
  expect(inherited.selection).not.toHaveProperty('tools')
  expect(inherited.session.getActiveToolNames()).toEqual(['read', 'bash', 'edit', 'write'])
  let pi!: ExtensionAPI
  const standard = await fixture(preferences({ tool: true }), { extensions: [(api) => {
    pi = api
    api.registerTool(tool('hidden', { exposure: 'hidden' }))
  }] })
  pi.registerTool(tool('late'))
  const context = standard.session.extensionRunner!.createCommandContext().getSystemPromptOptions()
  await standard.session.extensionRunner!.emitBeforeAgentStart({ messageType: 'user', prompt: 'fixture' }, {
    ...context, forceSystemPrompt: '[PION PLAN MODE]'
  })
  expect(standard.session.getActiveToolNames().sort()).toEqual(['find', 'grep', 'ls', 'read'])
  expect(standard.provider).not.toHaveBeenCalled()
})

it('automatically receipts post-session_start resources_discover skills and consumes disabled/unknown skill commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-capability-skills-'))
  roots.push(root)
  const selected = join(root, 'selected.md')
  const disabled = join(root, 'disabled.md')
  await writeFile(selected, '---\nname: selected\ndescription: selected skill\n---\ninstructions')
  await writeFile(disabled, '---\nname: disabled\ndescription: disabled skill\n---\ninstructions')
  const host = await fixture(preferences({ skill: false }, { [capabilityResourceId('skill', selected)]: true }), {
    extensions: [(api) => { api.on('resources_discover', () => ({ skillPaths: [selected, disabled] })) }]
  })
  expect(host.loader.getSkills().skills.map((skill) => skill.name)).toEqual(['selected'])
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ id: capabilityResourceId('skill', selected), enabled: true, available: true }))
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ id: capabilityResourceId('skill', disabled), kind: 'skill', enabled: false, available: false }))
  const dispositions: string[] = []
  await host.session.prompt('/skill:disabled do not forward', { preflightResult: (value) => dispositions.push(value) })
  expect(await host.session.steer('/skill:unknown args')).toBe('handled')
  expect(await host.session.followUp('/skill:')).toBe('handled')
  expect(dispositions).toEqual(['handled'])
  expect(host.session.messages).toEqual([])
  expect(host.session.pendingMessageCount).toBe(0)
  expect(host.provider).not.toHaveBeenCalled()
})

it('automatically receipts initial background MCP registrations, hidden updates and deletes after the SDK registry refresh', async () => {
  let pi!: ExtensionAPI
  let connect!: () => void
  const ready = new Promise<void>((resolve) => { connect = resolve })
  let registered!: Promise<void>
  const name = 'mcp__fixture__inspect'
  const host = await fixture(preferences(), { extensions: [(api) => {
    pi = api
    api.on('session_start', () => {
      // A mock background connection, with no mcp_servers_change or prompt to
      // mask a missing registry-driven receipt. No real server is started.
      registered = ready.then(() => { api.registerTool(tool(name, { exposure: 'codemode' })) })
    })
  }] })
  expect(receipt(host).items.some((item) => item.name === name)).toBe(false)
  connect()
  await registered
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ name, origin: 'mcp', available: true }))
  pi.registerTool(tool(name, { exposure: 'hidden' }))
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ name, available: true }))
  await Promise.resolve()
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ name, available: false }))
  pi.registerTool(tool(name, { exposure: 'deferred' }))
  await Promise.resolve()
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ name, available: true }))
  const loaded = host.loader.getExtensions()
  expect(loaded.extensions.find((entry) => entry.tools.has(name))!.tools.delete(name)).toBe(true)
  loaded.runtime.refreshTools()
  await Promise.resolve()
  expect(receipt(host).items).toContainEqual(expect.objectContaining({ name, available: false }))
  expect(host.provider).not.toHaveBeenCalled()
})

it.each(['shutdown', 'replacement'] as const)('rejects queued and later receipts after owner %s', async (reason) => {
  let pi!: ExtensionAPI
  const host = await fixture(preferences(), { extensions: [(api) => { pi = api }] })
  const before = host.session.extensionRunner!.getCommand(CAPABILITY_RUNTIME_COMMAND)!.description
  pi.registerTool(tool('late_before_retire'))
  if (reason === 'shutdown') await host.session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'new' })
  else host.policy.retire() // runtime-host does this before replacement services.
  await Promise.resolve()
  pi.registerTool(tool('late_after_retire'))
  host.policy.refreshNotice()
  await Promise.resolve()
  expect(host.session.extensionRunner!.getCommand(CAPABILITY_RUNTIME_COMMAND)!.description).toBe(before)
  expect(host.provider).not.toHaveBeenCalled()
})

it('publishes a bounded exact-source read-only command receipt without schemas or raw tool descriptions', async () => {
  const secret = 'RAW-CONFIG-OR-TOOL-DESCRIPTION'
  const host = await fixture(preferences({ tool: true }), { customTools: [tool('inspect', { description: secret })] })
  const command = host.session.extensionRunner!.getCommand(CAPABILITY_RUNTIME_COMMAND)!
  expect(command.sourceInfo.path).toBe(CAPABILITY_RUNTIME_SOURCE)
  const notice = JSON.parse(command.description!) as CapabilityRuntimeNotice
  expect(notice).toMatchObject({ version: 1, revision: 4, runtimeId: 'runtime-fixture', cwd: host.root })
  expect(command.description).not.toContain(secret)
  expect(command.description).not.toContain('parameters')
  await host.session.prompt(`/${CAPABILITY_RUNTIME_COMMAND}`)
  expect(host.session.messages).toEqual([])
  const huge = capabilityRuntimeDescription({ ...notice, items: Array.from({ length: 4096 }, (_, index) => ({
    id: `tool:t${index}`, kind: 'tool', origin: 'extension', name: `t${index}`, label: 'x'.repeat(1000),
    description: 'x'.repeat(10000), enabled: true, available: true })) })
  expect(huge.length).toBeLessThanOrEqual(CAPABILITY_RUNTIME_MAX_CHARS)
  expect(JSON.parse(huge).notices).toContain('能力目录超过单次回执上限，部分条目已省略。')
  expect(host.provider).not.toHaveBeenCalled()
})

it('keeps real SDK MCP active through replacement/RPC duplicate binds without rereading config or registrations', async () => {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const registrations = vi.fn(() => [{ name: 'blocked', extensionPath: '/private/extension', config: { command: 'must-not-spawn', enabled: false } }])
  const loadConfig = vi.fn(() => ({ servers: [{ name: 'blocked', source: '/private/mcp.json',
    config: { command: 'must-not-spawn', enabled: false } }], errors: [] }))
  const setWidget = vi.fn((_key: string, _lines?: string[]) => {})
  const ctx = { cwd: '/fixture', mode: 'rpc', modelRegistry: {},
    sessionManager: { getSessionFile: () => undefined }, ui: { notify: vi.fn(), setWidget } } as unknown as ExtensionCommandContext
  const observer = createMcpStatusObserver({ createContext: () => ctx, slot: { busy: false } })
  const barrier = createPionNativeMcpCloseBarrier()
  const entry = createPionNativeExtensions(observer, { loadConfig, registrations, closeBarrier: barrier })[2]
  const pi = { on: (name: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => undefined
  }, getMcpServers: () => [{ name: 'blocked', extensionPath: '/private/extension', config: { command: 'must-not-spawn', enabled: true } }],
  getCommands: () => [{ name: 'mcp', source: 'extension', sourceInfo: { path: 'builtin:mcp', source: 'builtin', scope: 'temporary', origin: 'top-level' } }],
  getAllTools: () => [], getActiveTools: () => [], setActiveTools: vi.fn(), registerToolRenderer: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI
  if (typeof entry === 'function') throw new Error('Expected builtin MCP entry')
  await entry.factory(pi)
  await observer.extension(pi)
  const dispatch = async (type: string) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx)
  }
  try {
    // SDK finishSessionReplacement binds internally; RPC new_session/switch_session binds again.
    await dispatch('session_start')
    await dispatch('session_start')
    expect(loadConfig).toHaveBeenCalledOnce()
    expect(registrations).toHaveBeenCalledOnce()
    expect(registrations).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ config: expect.objectContaining({ enabled: true }) })]))
    expect(setWidget).toHaveBeenCalledTimes(2)
    expect(readMcpStatusNotice(setWidget.mock.calls.at(-1)?.[1])).toMatchObject({
      availability: 'native', phase: 'ready', servers: [{ name: 'blocked', state: 'disabled' }]
    })
  } finally {
    await dispatch('session_shutdown')
    await dispatch('session_shutdown')
  }
  await expect(barrier.assertClosed()).resolves.toBeUndefined()
})

function mcpDeferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Mock only the SDK actors; invoke the production policy/guard wrapper's actual
 * registered lifecycle handlers. No server, transport, credentials or model. */
async function mockNativeMcpLifecycle() {
  const start = vi.fn<() => void | Promise<void>>()
  const close = vi.fn<() => void | Promise<void>>()
  vi.resetModules()
  vi.doMock('@earendil-works/pi-coding-agent', () => ({
    createCodemodeExtension: () => () => {}, createToolSearchExtension: () => () => {},
    createMcpExtension: (options: McpExtensionOptions) => (pi: ExtensionAPI) => {
      pi.on('session_start', (_event, ctx) => { options.loadConfig!(ctx); pi.getMcpServers(); return start() })
      pi.on('session_shutdown', close)
    }
  }))
  try {
    const native = await import('../../src/main/agent/native-extensions')
    const closeBarrier = native.createPionNativeMcpCloseBarrier()
    const loadConfig = vi.fn(() => ({ servers: [], errors: [] }))
    const registrations = vi.fn((entries: ReturnType<ExtensionAPI['getMcpServers']>) => entries)
    return { start, close, loadConfig, registrations, closeBarrier, async instance() {
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      const pi = { on: (name: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(name, handler); return () => handlers.delete(name)
      }, getMcpServers: () => [] } as unknown as ExtensionAPI
      const entry = native.createPionNativeExtensions(undefined, { loadConfig, registrations, closeBarrier })[2]
      if (typeof entry === 'function') throw new Error('Expected builtin MCP entry')
      await entry.factory(pi)
      const emit = (type: string) => handlers.get(type)!({ type }, {}) as Promise<unknown>
      return { start: () => emit('session_start'), shutdown: () => emit('session_shutdown') }
    } }
  } finally {
    vi.doUnmock('@earendil-works/pi-coding-agent')
    vi.resetModules()
  }
}

it('duplicate native starts await the same actual pending Promise and shutdown cannot revive that instance', async () => {
  const h = await mockNativeMcpLifecycle()
  const startup = mcpDeferred()
  h.start.mockReturnValueOnce(startup.promise)
  const runtime = await h.instance()
  const barrierStart = vi.spyOn(h.closeBarrier, 'start')
  const first = runtime.start()
  const second = runtime.start()
  const settled = vi.fn()
  const waiting = Promise.all([first.then(settled), second.then(settled)])
  expect(second).toBe(first)
  await Promise.resolve()
  expect(h.start).toHaveBeenCalledOnce()
  expect(h.loadConfig).toHaveBeenCalledOnce()
  expect(h.registrations).toHaveBeenCalledOnce()
  expect(barrierStart).toHaveBeenCalledOnce()
  expect(settled).not.toHaveBeenCalled()
  startup.resolve()
  await waiting
  expect(settled).toHaveBeenCalledTimes(2)
  expect(runtime.start()).toBe(first)
  const closing = runtime.shutdown()
  expect(runtime.shutdown()).toBe(closing)
  await closing
  await expect(runtime.start()).rejects.toThrow('旧运行时')
  expect(h.start).toHaveBeenCalledOnce()
  expect(h.close).toHaveBeenCalledOnce()
  expect(barrierStart).toHaveBeenCalledOnce()
})

it.each(['closed', 'failed'] as const)('next factory cannot start while original shutdown is pending (%s)', async (outcome) => {
  const h = await mockNativeMcpLifecycle()
  const previous = await h.instance()
  await previous.start()
  const shutdown = mcpDeferred()
  h.close.mockReturnValueOnce(shutdown.promise)
  const closing = previous.shutdown()
  expect(previous.shutdown()).toBe(closing)
  const next = await h.instance()
  const starting = next.start()
  expect(next.start()).toBe(starting)
  const admitted = vi.fn()
  void starting.then(admitted, () => undefined)
  void closing.catch(() => undefined)
  await Promise.resolve()
  await expect(previous.start()).rejects.toThrow('旧运行时')
  expect(h.start).toHaveBeenCalledOnce()
  expect(h.close).toHaveBeenCalledOnce()
  expect(admitted).not.toHaveBeenCalled()
  if (outcome === 'closed') {
    shutdown.resolve()
    await closing
    await starting
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(admitted).toHaveBeenCalledOnce()
    await next.shutdown()
    await expect(h.closeBarrier.assertClosed()).resolves.toBeUndefined()
  } else {
    shutdown.reject(new Error('private close failure'))
    await expect(closing).rejects.toThrow('原生 MCP 收尾失败')
    await expect(starting).rejects.toThrow('原生 MCP 收尾失败')
    await expect(h.closeBarrier.assertClosed()).rejects.toThrow('原生 MCP 收尾失败')
    const later = await h.instance()
    await expect(later.start()).rejects.toThrow('原生 MCP 收尾失败')
    expect(previous.shutdown()).toBe(closing)
    expect(h.start).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
    expect(admitted).not.toHaveBeenCalled()
  }
})

it('keeps a real native close pending and latches swallowed failures before replacement services', async () => {
  const barrier = createPionNativeMcpCloseBarrier()
  await barrier.start()
  await expect(barrier.assertClosed()).rejects.toThrow('尚无收尾回执')
  let release!: () => void
  const original = new Promise<void>((resolve) => { release = resolve })
  const closing = barrier.close(() => original)
  const replacementServices = vi.fn()
  const replacement = barrier.assertClosed().then(replacementServices)
  await Promise.resolve()
  expect(replacementServices).not.toHaveBeenCalled()
  release()
  await closing
  await replacement
  expect(replacementServices).toHaveBeenCalledOnce()
  await barrier.start() // Same-factory SDK reload obeys the same fence.
  await barrier.close(async () => { throw new Error('private close diagnostic') }).catch(() => undefined)
  await expect(barrier.assertClosed()).rejects.toThrow('原生 MCP 收尾失败')
  await expect(barrier.start()).rejects.toThrow('原生 MCP 收尾失败')
  expect(replacementServices).toHaveBeenCalledOnce()
})

it('a globally disabled subagent cannot be reenabled by its local command or directly executed', async () => {
  const control = createSubagentControl(vi.fn(), undefined, undefined, undefined, () => false)
  const host = await fixture(preferences({ tool: true }, { 'tool:pion_subagents': false }), {
    extensions: [{ name: 'pion-subagents', factory: control.extension }], customTools: [control.tool] })
  expect(control.isEnabled()).toBe(false)
  const command = host.session.extensionRunner!.getCommand('pion-subagents')!
  expect(command.sourceInfo).toMatchObject({ path: '<inline:pion-subagents>', source: 'inline', scope: 'temporary', origin: 'top-level' })
  await expect(command.handler('on', host.session.extensionRunner!.createCommandContext())).rejects.toThrow('设置中关闭')
  await expect(control.tool.execute('direct', { tasks: [{ name: 'must-not-run', task: 'no model' }] }, undefined, undefined, {} as never)).rejects.toThrow('子代理已关闭')
  expect(host.provider).not.toHaveBeenCalled()
})
