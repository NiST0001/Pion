import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition, type ToolResultEvent, type ToolResultEventResult, type ResourceLoader } from '@earendil-works/pi-coding-agent'
import { applyPionNativeToolDefaults, createPionNativeExtensions, createPionNativeLoadoutBoundary, NATIVE_SCRIPT_DEADLINE_MS, NATIVE_SCRIPT_MAX_MODEL_CALLS } from '../../src/main/agent/native-extensions'
import { loadAgentCapabilities } from '../../src/main/agent/capabilities'

const mocks = vi.hoisted(() => ({
  codemode: vi.fn(), search: vi.fn(), mcp: vi.fn(), start: vi.fn(), shutdown: vi.fn(),
  settings: vi.fn(), loaders: vi.fn(), agentDir: ''
}))
const definition = (name: string) => ({
  name, label: name, description: `${name} description`,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text' as const, text: 'mock' }], details: undefined })
})
vi.mock('@earendil-works/pi-coding-agent', async (original) => {
  const sdk = await original<typeof import('@earendil-works/pi-coding-agent')>()
  return {
    ...sdk,
    createCodemodeExtension: mocks.codemode,
    createToolSearchExtension: mocks.search,
    createMcpExtension: mocks.mcp,
    getAgentDir: () => mocks.agentDir,
    SettingsManager: { ...sdk.SettingsManager, create: mocks.settings, inMemory: sdk.SettingsManager.inMemory },
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
        // Exercise the real SDK replacement loader without discovering the
        // current account's global skills/prompts/context files.
        super({ ...options, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true })
        mocks.loaders(options)
      }
    }
  }
})
let root: string
beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'pion-native-extensions-'))
  mocks.agentDir = join(root, 'agent')
  mocks.codemode.mockImplementation(() => (pi: ExtensionAPI) => pi.registerTool(definition('codemode')))
  mocks.search.mockImplementation(() => (pi: ExtensionAPI) => pi.registerTool(definition('tool_search')))
  mocks.mcp.mockImplementation(() => (pi: ExtensionAPI) => {
    pi.registerCommand('mcp', { description: 'Mock MCP', handler: async () => {} })
    pi.on('session_start', mocks.start)
    pi.on('session_shutdown', mocks.shutdown)
  })
  mocks.settings.mockImplementation((_cwd, _agentDir, options) => SettingsManager.inMemory({}, { projectTrusted: options.projectTrusted }))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('creates fresh named, replaceable CLI builtins for every backend with models explicitly enabled', () => {
  const first = createPionNativeExtensions()
  const second = createPionNativeExtensions()
  expect(first).toEqual([
    { name: 'codemode', builtin: true, replaceable: true, factory: expect.any(Function) },
    { name: 'tool-search', builtin: true, replaceable: true, factory: expect.any(Function) },
    { name: 'mcp', builtin: true, replaceable: true, factory: expect.any(Function) }
  ])
  first.forEach((entry, index) => {
    expect(second[index]).not.toBe(entry)
    if (typeof entry !== 'function' && typeof second[index] !== 'function') {
      expect((second[index] as typeof entry).factory).not.toBe(entry.factory)
    }
  })
  expect(mocks.codemode).toHaveBeenCalledWith({ models: true })
  expect(mocks.mcp.mock.calls).toEqual([[], []])
  expect(mocks.start).not.toHaveBeenCalled()
})

async function loader(settings: Parameters<typeof SettingsManager.inMemory>[0] = {}, extra: ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionFactories'] = []) {
  const settingsManager = SettingsManager.inMemory(settings, { projectTrusted: false })
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: mocks.agentDir, settingsManager,
    extensionFactories: [...createPionNativeExtensions(), ...extra]
  })
  await resourceLoader.reload()
  return { settingsManager, resourceLoader }
}

it('leaves legacy /mcp and replacement tools in control without duplicate registration or connections', async () => {
  const { resourceLoader } = await loader({}, [(pi) => {
    pi.registerCommand('mcp', { description: 'Legacy adapter', handler: async () => {} })
    pi.registerTool(definition('codemode'))
    pi.registerTool(definition('tool_search'))
  }])
  const result = resourceLoader.getExtensions()
  expect(result.errors).toEqual([])
  for (const path of ['builtin:mcp', 'builtin:codemode', 'builtin:tool-search']) {
    expect(result.extensions.map((extension) => extension.path)).not.toContain(path)
  }
  expect(result.extensions.flatMap((extension) => [...extension.commands.keys()]).filter((name) => name === 'mcp')).toHaveLength(1)
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.shutdown).not.toHaveBeenCalled()
})

it('honors disabled builtin settings and SDK noExtensions without host bypasses', async () => {
  const disabled = await loader({ extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool-search'] })
  expect(disabled.resourceLoader.getExtensions().extensions).toEqual([])
  const overrides = vi.spyOn(disabled.settingsManager, 'applyOverrides')
  applyPionNativeToolDefaults(disabled.settingsManager, disabled.resourceLoader)
  expect(overrides).not.toHaveBeenCalled()
  const noExtensions = new DefaultResourceLoader({
    cwd: root, agentDir: mocks.agentDir, settingsManager: SettingsManager.inMemory({}),
    extensionFactories: createPionNativeExtensions(), noExtensions: true
  })
  await noExtensions.reload()
  expect(noExtensions.getExtensions().extensions).toEqual([])
  expect(mocks.start).not.toHaveBeenCalled()
})

it('loads native builtins only after the SDK trust decision without granting project trust', async () => {
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false })
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: mocks.agentDir, settingsManager, extensionFactories: createPionNativeExtensions()
  })
  const resolveProjectTrust = vi.fn(async ({ extensionsResult }: { extensionsResult: ReturnType<ResourceLoader['getExtensions']> }) => {
    expect(extensionsResult.extensions.map((extension: { path: string }) => extension.path)).not.toContain('builtin:mcp')
    return false
  })
  await resourceLoader.reload({ resolveProjectTrust })
  expect(resolveProjectTrust).toHaveBeenCalledTimes(1)
  expect(settingsManager.isProjectTrusted()).toBe(false)
  expect(resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toContain('builtin:mcp')
  expect(mocks.start).not.toHaveBeenCalled()
})

it('adds only registered native defaults ephemerally while retaining SDK coding defaults', async () => {
  const { settingsManager, resourceLoader } = await loader()
  const globalBefore = settingsManager.getGlobalSettings()
  const projectBefore = settingsManager.getProjectSettings()
  const overrides = vi.spyOn(settingsManager, 'applyOverrides')
  applyPionNativeToolDefaults(settingsManager, resourceLoader)
  expect(overrides).toHaveBeenCalledWith({ defaultTools: ['+codemode', '+tool_search'] })
  expect(settingsManager.getDefaultTools()).toEqual(['read', 'bash', 'edit', 'write', 'codemode', 'tool_search'])
  expect(settingsManager.getGlobalSettings()).toEqual(globalBefore)
  expect(settingsManager.getProjectSettings()).toEqual(projectBefore)
  applyPionNativeToolDefaults(settingsManager, resourceLoader)
  expect(overrides).toHaveBeenCalledTimes(1)
})

it.each([
  { selection: [] }, { selection: ['read'] },
  { selection: ['-codemode', '-tool_search'] }, { selection: ['+grep'] }
])('does not override an explicit user loadout $selection', async ({ selection }) => {
  const { settingsManager, resourceLoader } = await loader({ defaultTools: selection })
  const expected = settingsManager.getDefaultTools()
  const overrides = vi.spyOn(settingsManager, 'applyOverrides')
  applyPionNativeToolDefaults(settingsManager, resourceLoader)
  expect(settingsManager.getDefaultTools()).toEqual(expected)
  expect(overrides).not.toHaveBeenCalled()
})

it('never supplies defaults for tools belonging only to a replacement extension', () => {
  const settings = { getDefaultTools: () => undefined, applyOverrides: vi.fn() }
  const resourceLoader = { getExtensions: () => ({ extensions: [{
    path: '/legacy.ts', tools: new Map([['codemode', { definition: definition('codemode') }]])
  }] }) } as unknown as Pick<ResourceLoader, 'getExtensions'>
  applyPionNativeToolDefaults(settings, resourceLoader)
  expect(settings.applyOverrides).not.toHaveBeenCalled()
})

it.each([false, true])('capability reload uses the same builtin registry without binding/connecting (trusted=%s)', async (projectTrusted) => {
  const result = await loadAgentCapabilities(root, projectTrusted)
  expect(mocks.settings).toHaveBeenCalledWith(root, mocks.agentDir, { projectTrusted })
  expect(mocks.loaders).toHaveBeenCalledWith(expect.objectContaining({ extensionFactories: [
    expect.objectContaining({ name: 'codemode', builtin: true, replaceable: true }),
    expect.objectContaining({ name: 'tool-search', builtin: true, replaceable: true }),
    expect.objectContaining({ name: 'mcp', builtin: true, replaceable: true })
  ] }))
  expect(result.tools.map((tool) => tool.name).sort()).toEqual(['codemode', 'tool_search'])
  expect(result.tools.every((tool) => tool.source === 'builtin')).toBe(true)
  expect(Object.keys(result).sort()).toEqual(['skills', 'tools'])
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.shutdown).not.toHaveBeenCalled()
})

it('capabilities list only surviving registered tools, not disabled tools or imaginary MCP services', async () => {
  mocks.settings.mockImplementation(() => SettingsManager.inMemory({ extensions: ['-builtin:codemode', '-builtin:tool-search', '-builtin:mcp'] }))
  expect(await loadAgentCapabilities(root, false)).toEqual({ skills: [], tools: [] })
  expect(mocks.start).not.toHaveBeenCalled()
})

async function guardedTool(execute: ToolDefinition['execute']) {
  mocks.codemode.mockImplementation(() => (pi: ExtensionAPI) => pi.registerTool({ ...definition('codemode'), execute }))
  const { resourceLoader } = await loader()
  return resourceLoader.getExtensions().extensions.find((entry) => entry.path === 'builtin:codemode')!.tools.get('codemode')!.definition
}
const contextWith = (registry: unknown) => ({ modelRegistry: registry }) as ExtensionToolContext

it('budgets mixed classifier/image calls per script before dispatch and leaves global registry untouched', async () => {
  const usage = { cost: { total: 1 } }
  const registry = { classify: vi.fn(async () => ({ usage })), generateImages: vi.fn(async () => ({ usage })) }
  const originalClassify = registry.classify
  // Budget rejection is synchronous preflight, before the underlying never-reject SDK API.
  const safeTool = await guardedTool(async (_id, _params, _signal, _update, ctx) => {
    for (let n = 0; n < NATIVE_SCRIPT_MAX_MODEL_CALLS; n++) {
      if (n % 2) await ctx.modelRegistry.generateImages({} as never, {} as never)
      else await ctx.modelRegistry.classify({} as never, {} as never)
    }
    expect(() => ctx.modelRegistry.classify({} as never, {} as never)).toThrow('budget')
    return { content: [{ type: 'text', text: 'done' }], details: undefined, usage: usage as never }
  })
  for (let run = 0; run < 2; run++) {
    const result = await safeTool.execute('run', {}, undefined, undefined, contextWith(registry))
    expect(result.usage).toBe(usage) // the SDK result is the sole usage carrier
  }
  expect(registry.classify).toBe(originalClassify)
  expect(registry.classify).toHaveBeenCalledTimes(8)
  expect(registry.generateImages).toHaveBeenCalledTimes(8)
})

it('binds public methods and model dispatch to private-field registry receivers', async () => {
  class Registry {
    #value = 'private'
    getError() { return this.#value }
    async classify(_model: unknown, _context: unknown, options: { signal: AbortSignal }) {
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return this.#value
    }
  }
  const registry = new Registry()
  const tool = await guardedTool(async (_id, _params, _signal, _update, ctx) => {
    expect(ctx.modelRegistry.getError()).toBe('private')
    expect(await ctx.modelRegistry.classify({} as never, {} as never)).toBe('private')
    return { content: [], details: undefined }
  })
  await tool.execute('run', {}, undefined, undefined, contextWith(registry))
  expect(registry.getError()).toBe('private')
})

it('has a hard host deadline regardless of script timeout options, while late calls remain blocked', async () => {
  vi.useFakeTimers()
  try {
    const registry = { generateImages: vi.fn((_model: unknown, _context: unknown, _options: { signal: AbortSignal }) => new Promise(() => {})) }
    let scoped!: ExtensionToolContext
    let signal!: AbortSignal
    const tool = await guardedTool(async (_id, _params, scopeSignal, _update, ctx) => {
      scoped = ctx
      signal = scopeSignal!
      await ctx.modelRegistry.generateImages({} as never, {} as never, { signal: new AbortController().signal })
      return { content: [], details: undefined }
    })
    const running = tool.execute('run', { code: '// @options: {"timeout_ms":2147483647}' }, undefined, undefined, contextWith(registry))
    const rejected = expect(running).rejects.toThrow('five-minute')
    await vi.advanceTimersByTimeAsync(NATIVE_SCRIPT_DEADLINE_MS)
    await rejected
    expect(signal.aborted).toBe(true)
    expect(registry.generateImages.mock.calls[0][2].signal.aborted).toBe(true)
    expect(() => scoped.modelRegistry.generateImages({} as never, {} as never)).toThrow('cancelled')
    expect(registry.generateImages).toHaveBeenCalledTimes(1)
    // Settling the host wait does not assert the pending provider Promise stopped or avoided cost.
  } finally { vi.useRealTimers() }
})

it('combines parent cancellation and prevents dispatch before and after cancellation or completion', async () => {
  const registry = { classify: vi.fn(async () => ({})) }
  let scoped!: ExtensionToolContext
  const tool = await guardedTool(async (_id, _params, _signal, _update, ctx) => {
    scoped = ctx
    return { content: [], details: undefined }
  })
  const parent = new AbortController()
  parent.abort(new Error('parent cancelled'))
  await expect(tool.execute('run', {}, parent.signal, undefined, contextWith(registry))).rejects.toThrow('parent cancelled')
  expect(registry.classify).not.toHaveBeenCalled()
  await tool.execute('run', {}, undefined, undefined, contextWith(registry))
  expect(() => scoped.modelRegistry.classify({} as never, {} as never)).toThrow('cancelled')
  expect(registry.classify).not.toHaveBeenCalled()
})

it('propagates active parent abort to a dispatched model request without retry or paid fallback', async () => {
  const parent = new AbortController()
  const registry = { classify: vi.fn((_model: unknown, _context: unknown, _options: { signal: AbortSignal }) => new Promise(() => {})) }
  let scoped!: ExtensionToolContext
  const tool = await guardedTool(async (_id, _params, _signal, _update, ctx) => {
    scoped = ctx
    await ctx.modelRegistry.classify({} as never, {} as never)
    return { content: [], details: undefined }
  })
  const running = tool.execute('run', {}, parent.signal, undefined, contextWith(registry))
  const rejected = expect(running).rejects.toThrow('stop request')
  parent.abort(new Error('stop request'))
  await rejected
  expect(registry.classify.mock.calls[0][2].signal.aborted).toBe(true)
  expect(() => scoped.modelRegistry.classify({} as never, {} as never)).toThrow('cancelled')
  expect(registry.classify).toHaveBeenCalledTimes(1)
})

async function resultHandler(name: 'codemode' | 'mcp') {
  const handlers: ((event: ToolResultEvent) => ToolResultEventResult | undefined)[] = []
  const pi = {
    on: (event: string, handler: (event: ToolResultEvent) => ToolResultEventResult | undefined) => {
      if (event === 'tool_result') handlers.push(handler)
      return () => {}
    },
    registerTool: vi.fn(), registerCommand: vi.fn()
  } as unknown as ExtensionAPI
  const entry = createPionNativeExtensions().find((extension) => typeof extension !== 'function' && extension.name === name)!
  if (typeof entry !== 'function') await entry.factory(pi)
  return handlers[0]
}
const eventWith = (toolName: string, content: ToolResultEvent['content'], details: unknown = undefined) => ({
  type: 'tool_result', toolCallId: 'test', input: {}, toolName, content, details,
  isError: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } }, structuredContent: { image: 'unsafe duplicate' }
}) as ToolResultEvent
// Valid static PNG fixture; projection is structural validation, not a new decoder.
const safePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='

it.each(['codemode', 'mcp'] as const)('projects %s image blocks fail-closed without losing text/errors/usage', async (name) => {
  const handler = await resultHandler(name)
  const event = eventWith(name === 'mcp' ? 'mcp__server__resource' : name, [
    { type: 'text', text: 'Original image path: /tmp/native.png' },
    { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) }
  ], { calls: [{ name: 'models.generateImages', durationMs: Infinity, args: 'unbounded', error: 'provider failure' }], rawImage: safePng })
  const result = handler(event)!
  expect(result.content!.every((part) => part.type === 'text')).toBe(true)
  expect(result.content![0]).toEqual(event.content[0])
  expect(result.details).toEqual({ calls: [{ name: 'models.generateImages', error: 'provider failure' }] })
  expect(result).not.toHaveProperty('structuredContent') // public content replacement drops it
  expect(result).not.toHaveProperty('usage') // retain SDK usage, do not duplicate it
  expect(result).not.toHaveProperty('isError') // retain SDK error state
  expect(handler(eventWith('unrelated', event.content))).toBeUndefined()
})

it('also projects the SDK shared read_mcp_resource tool instead of only namespaced server tools', async () => {
  const handler = await resultHandler('mcp')
  const result = handler(eventWith('read_mcp_resource', [
    { type: 'text', text: 'resource text' },
    { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) }
  ]))!
  expect(result.content![0]).toEqual({ type: 'text', text: 'resource text' })
  expect(result.content!.some((part) => part.type === 'image')).toBe(false)
})

it('does not throw for malformed image output (which would let SDK result hooks fail open)', async () => {
  const handler = await resultHandler('mcp')
  const event = eventWith('mcp__server__resource', [null] as unknown as ToolResultEvent['content'])
  expect(() => handler(event)).not.toThrow()
  expect(handler(event)!.content).toEqual([{ type: 'text', text: '原生工具输出无法安全预览，已省略。' }])
})

it('keeps up to four valid safe static previews and bounds text/details without claiming text redaction', async () => {
  const handler = await resultHandler('codemode')
  const image = { type: 'image' as const, data: safePng, mimeType: 'image/png' }
  const result = handler(eventWith('codemode', [
    { type: 'text', text: 'literal base64 text remains: ' + safePng }, ...Array.from({ length: 5 }, () => image),
    { type: 'text', text: 'X'.repeat(80_000) }
  ], { summary: 'S'.repeat(8_000), calls: Array.from({ length: 200 }, () => ({ status: 'ok', durationMs: 1, cost: 2 })) }))!
  expect(result.content!.filter((part) => part.type === 'image')).toHaveLength(4)
  expect(result.content![0]).toEqual({ type: 'text', text: 'literal base64 text remains: ' + safePng })
  const details = result.details as { summary: string; calls: unknown[] }
  expect(details.summary).toHaveLength(4096)
  expect(details.calls).toHaveLength(128)
  expect(result.content!.filter((part) => part.type === 'text').reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0)).toBeLessThan(66_000)
})

function boundaryHarness(selection: string[] | undefined, initial: string[]) {
  const boundary = createPionNativeLoadoutBoundary(selection)
  const handlers = new Map<string, ((event: any) => unknown)[]>()
  let active = [...initial]
  const setActiveTools = vi.fn((names: string[]) => { active = [...names] })
  const pi = {
    getActiveTools: () => [...active], setActiveTools,
    on: (event: string, handler: (event: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    }
  } as unknown as ExtensionAPI
  // SDK loads inline handlers after builtins; host initializes before binding.
  boundary.initialize(initial)
  boundary.capture(pi)
  boundary.declarations(pi)
  const emit = async (name: string, event: any = {}) => {
    let blocked: unknown
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(event)
      if (result) blocked = result
    }
    return blocked
  }
  return { emit, active: () => [...active], set: (names: string[]) => { active = [...names] }, setActiveTools,
    call: (name: string, nested = false) => emit('tool_call', { toolName: name, input: {}, ...(nested ? { parentToolCallId: 'outer' } : {}) }),
    prompt: async () => {
      const event = { systemPromptOptions: { selectedTools: [...active] } }
      await emit('before_agent_start', event)
      return event.systemPromptOptions.selectedTools
    } }
}

it.each([{ selection: [] }, { selection: ['read'] }, { selection: ['-codemode', '-tool_search'] }])('blocks MCP helper autoactivation and every excluded nested call for $selection', async ({ selection }) => {
  const initial = selection.length === 0 ? ['extension_direct'] : selection[0] === 'read' ? ['read'] : ['read', 'bash', 'edit', 'write']
  const host = boundaryHarness(selection, initial)
  // Simulate MCP session_start autoactivation BEFORE the inline handlers run.
  host.set([...initial, 'codemode', 'tool_search', 'mcp__late__call'])
  await host.emit('session_start')
  expect(host.active()).toEqual(selection.length === 0 ? [] : initial)
  for (const name of ['codemode', 'tool_search', 'mcp__late__call', 'list_mcp_resources']) {
    expect(await host.call(name)).toMatchObject({ block: true })
    expect(await host.call(name, true)).toMatchObject({ block: true })
  }
  expect(await host.call('write', true)).toEqual(selection.length > 0 && selection[0] !== 'read' ? undefined : expect.objectContaining({ block: true }))
  // A later connected/replacement server and tree restoration cannot widen it.
  host.set(['read', 'codemode', 'mcp__replacement__call'])
  await host.emit('session_tree')
  expect(host.active()).toEqual(selection.length === 0 ? [] : ['read'])
  host.set(['read', 'codemode', 'mcp__delayed__call'])
  expect(await host.prompt()).toEqual(selection.length === 0 ? [] : ['read'])
})

it.each([{ selection: ['+codemode'] }, { selection: ['+grep'] }])('retains initial SDK coding permissions for modifier-only selection $selection', async ({ selection }) => {
  const initial = ['read', 'bash', 'edit', 'write', selection[0].slice(1)]
  const host = boundaryHarness(selection, initial)
  await host.emit('session_start')
  for (const name of initial) expect(await host.call(name, true)).toBeUndefined()
  expect(await host.call('mcp__unselected__write', true)).toMatchObject({ block: true })
  host.set(['read']) // a temporary hide, e.g. the existing plan guard
  expect(await host.prompt()).toEqual(['read'])
  expect(host.setActiveTools).not.toHaveBeenCalled()
})

it('allows only explicit late MCP exact/*/? matches and applies negative expressions in order', async () => {
  const host = boundaryHarness(['read', 'codemode', 'mcp__docs__*', '-mcp__docs__delete*', '+mcp__docs__delete_one', '+mcp__x__get_?'], ['read', 'codemode'])
  for (const name of ['mcp__docs__get', 'mcp__docs__delete_one', 'mcp__x__get_a']) expect(await host.call(name, true)).toBeUndefined()
  for (const name of ['mcp__other__get', 'mcp__docs__delete_all', 'mcp__x__get_ab', 'write', 'tool_search']) expect(await host.call(name, true)).toMatchObject({ block: true })
  host.set(['read', 'mcp__docs__get', 'mcp__docs__delete_all'])
  expect(await host.prompt()).toEqual(['read', 'mcp__docs__get'])
})

it('resolves plain entries before modifiers and retains SDK re-added coding tools', async () => {
  const host = boundaryHarness(['-mcp__docs__*', 'mcp__docs__get', '-write', '+write'], ['read', 'write'])
  expect(await host.call('mcp__docs__get', true)).toMatchObject({ block: true })
  expect(await host.call('write', true)).toBeUndefined()
  expect(await host.call('edit', true)).toMatchObject({ block: true })
})

it('does not restrict normal native discovery without an explicit user loadout', async () => {
  const host = boundaryHarness(undefined, ['read', 'bash', 'edit', 'write'])
  host.set(['read', 'codemode', 'tool_search', 'mcp__late__get'])
  await host.emit('session_start')
  expect(await host.prompt()).toEqual(host.active())
  for (const name of host.active()) expect(await host.call(name, true)).toBeUndefined()
  expect(host.setActiveTools).not.toHaveBeenCalled()
})

it('fails closed with an explicit diagnostic for unsupported glob syntax', async () => {
  const host = boundaryHarness(['read', 'mcp__docs__[ab]'], ['read'])
  expect(await host.call('mcp__docs__a', true)).toMatchObject({ block: true, reason: expect.stringContaining('Unsupported') })
  expect(await host.call('read')).toMatchObject({ block: true })
  expect(await host.prompt()).toEqual([])
})

it('freezes each backend ceiling and never recaptures an expanded subset on reload', async () => {
  const first = boundaryHarness(['read'], ['read'])
  first.set(['read', 'codemode', 'mcp__late__get'])
  await first.emit('session_start')
  first.set(['read', 'write'])
  await first.emit('session_start')
  expect(await first.call('write', true)).toMatchObject({ block: true })
  const next = boundaryHarness(['+codemode'], ['read', 'bash', 'edit', 'write', 'codemode'])
  expect(await next.call('write', true)).toBeUndefined()
  expect(await first.call('codemode')).toMatchObject({ block: true })
})
