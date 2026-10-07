import { describe, expect, it, vi } from 'vitest'
import { nativePlanModeExtensionSource } from '../../src/main/agent/plan-mode'
import { nativeTaskExtensionSource } from '../../src/main/agent/task-planning'
import { IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'

type PlanState = { version?: number; enabled: boolean; toolsBeforePlanMode?: string[] }
type PlanEntry = { id: string; type: 'custom'; customType: string; data: PlanState }
type PlanContext = { sessionManager: { getBranch(): PlanEntry[] }; ui: { notify: ReturnType<typeof vi.fn> } }
type LifecycleHandler = (event: unknown, ctx: PlanContext) => unknown | Promise<unknown>

function runtime(saved?: PlanState, options: { activeTools?: string[]; imageAvailable?: boolean } = {}) {
  const initialTools = ['read', 'bash', 'edit', 'write', 'pion_ask_user',
    ...(options.imageAvailable === false ? [] : [IMAGE_GENERATION_TOOL_NAME]), 'custom-tool']
  let tools = [...(options.activeTools ?? initialTools)]
  const branch: PlanEntry[] = saved
    ? [{ id: 'saved', type: 'custom', customType: 'plan-mode-state', data: saved }]
    : []
  const handlers = new Map<string, LifecycleHandler>()
  let command!: { handler(args: string, ctx: PlanContext): Promise<void> }
  const appendEntry = vi.fn((customType: string, data: PlanState) => {
    branch.push({ id: `entry-${branch.length}`, type: 'custom', customType, data: structuredClone(data) })
  })
  const registered = initialTools.map((name) => ({ name,
    sourceInfo: { source: name === 'pion_ask_user' || name === IMAGE_GENERATION_TOOL_NAME
      ? 'sdk' : name === 'custom-tool' ? 'extension' : 'builtin' }, exposure: 'direct',
    annotations: { readOnlyHint: false } }))
  const pi = {
    getAllTools: () => registered,
    getActiveTools: () => [...tools],
    setActiveTools: (names: string[]) => { tools = [...names] },
    appendEntry,
    on: (name: string, handler: LifecycleHandler) => { handlers.set(name, handler) },
    registerCommand: (_name: string, registered: typeof command) => { command = registered }
  }
  // Exercise the materialized first-party JS without launching an SDK runtime.
  const install = new Function(nativePlanModeExtensionSource().replace(
    'export default function (pi)', 'return function (pi)'
  ))() as (api: typeof pi) => void
  install(pi)
  const ctx: PlanContext = { sessionManager: { getBranch: () => branch }, ui: { notify: vi.fn() } }
  return { initialTools, registered, branch, appendEntry, tools: () => tools, setTools: pi.setActiveTools,
    event: (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx),
    command: (args: string) => command.handler(args, ctx) }
}

describe('Pion native plan mode', () => {
  it('uses a command and execution gate instead of model-facing plan tools', () => {
    const source = nativePlanModeExtensionSource()

    expect(source).toContain('registerCommand("plan"')
    expect(source).toContain('READ_ONLY_TOOL_NAMES')
    expect(source).toContain('tool_call')
    expect(source).toContain('pion_task')
    expect(source).not.toContain('registerTool')
    expect(source).not.toContain('plan_mode_question')
    expect(source).not.toContain('plan_mode_complete')
  })

  it('restores the previous active tools after leaving plan mode', () => {
    const source = nativePlanModeExtensionSource()

    expect(source).toContain('toolsBeforePlanMode = pi.getActiveTools()')
    expect(source).toContain('const restored = previous ?? normalTools()')
    expect(source).toContain('...restored, ...nativeAsk')
    expect(source).toContain('只有用户明确切换回构建模式并发送执行请求后')
  })

  it('allows only the SDK-owned question tool alongside read-only built-ins', () => {
    const source = nativePlanModeExtensionSource()
    expect(source).toContain('if (name === "pion_ask_user") return tool?.sourceInfo?.source === "sdk"')
    expect(source).toContain('[...READ_ONLY_TOOL_NAMES, "pion_ask_user"]')
  })

  it.each(['command', 'restored session'] as const)('hides image generation and blocks it at execution time in a %s plan', async (entry) => {
    const h = runtime(entry === 'restored session'
      ? { version: 1, enabled: true, toolsBeforePlanMode: ['read', IMAGE_GENERATION_TOOL_NAME] }
      : undefined)
    await h.event('session_start')
    if (entry === 'command') await h.command('start')
    expect(h.tools()).toEqual(['read', 'pion_ask_user'])
    const call = { toolName: IMAGE_GENERATION_TOOL_NAME, input: { prompt: 'A mock image', path: 'art/test.png' } }
    expect(await h.event('tool_call', call)).toMatchObject({ block: true })
    // A different extension cannot bypass the guard by reactivating the tool.
    h.setTools(['read', IMAGE_GENERATION_TOOL_NAME])
    expect(await h.event('tool_call', call)).toMatchObject({ block: true })
    await h.command('exit')
    expect(h.tools()).toContain(IMAGE_GENERATION_TOOL_NAME)
    expect(await h.event('tool_call', call)).toBeUndefined()
  })

  it.each(['codemode', 'tool_search', 'mcp__server__read', 'mcp__server__delete',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'mcp', 'mcpScript'])('blocks dynamically exposed %s including nested calls despite readOnlyHint', async (name) => {
    const h = runtime(undefined, { activeTools: ['read'] })
    await h.event('session_start')
    await h.command('start')
    // Server connects / schema search activates a newly registered tool after entry.
    h.registered.push({ name, sourceInfo: { source: 'builtin' }, exposure: 'deferred', annotations: { readOnlyHint: true } })
    h.setTools(['read', name])
    const prompt = await h.event('before_agent_start', { systemPrompt: 'base' })
    expect(prompt).toMatchObject({ systemPrompt: expect.stringContaining('[PION PLAN MODE]') })
    expect(h.tools()).toEqual(['read', 'pion_ask_user'])
    h.setTools(['read', name]) // race with automatic server activation after prompt
    expect(await h.event('tool_call', { toolName: name, toolCallId: 'parent/1', parentToolCallId: 'parent', input: {} })).toMatchObject({ block: true })
    expect(h.tools()).toEqual(['read', 'pion_ask_user'])
    await h.command('exit')
    expect(h.tools()).toEqual(['read', 'pion_ask_user'])
    expect(h.tools()).not.toContain(name)
  })

  it('does not restore newly loaded deferred write tools after an explicitly empty plan loadout', async () => {
    const h = runtime(undefined, { activeTools: [] })
    await h.command('start')
    h.registered.push({ name: 'mcp__server__write', sourceInfo: { source: 'builtin' }, exposure: 'deferred', annotations: { readOnlyHint: true } })
    h.setTools(['codemode', 'tool_search', 'mcp__server__write'])
    await h.event('before_agent_start', { systemPrompt: 'base' })
    await h.command('exit')
    expect(h.tools()).toEqual(['pion_ask_user'])
  })

  it('does not allow a same-named plugin read tool or schema search to create an indirect plan escape', async () => {
    const h = runtime()
    await h.command('start')
    h.registered.find((tool) => tool.name === 'read')!.sourceInfo.source = 'extension'
    expect(await h.event('tool_call', { toolName: 'read', toolCallId: 'parent/2', parentToolCallId: 'parent' })).toMatchObject({ block: true })
    expect(h.tools()).toEqual(['pion_ask_user'])
    expect(await h.event('tool_call', { toolName: 'tool_search' })).toMatchObject({ block: true })
    expect(await h.event('tool_call', { toolName: 'codemode' })).toMatchObject({ block: true })
  })

  it('preserves an explicit active subset on exit instead of enabling the image fallback', async () => {
    const h = runtime(undefined, { activeTools: ['read', 'bash'] })
    await h.event('session_start')
    await h.command('start')
    await h.command('exit')
    expect(h.tools()).toEqual(['read', 'bash', 'pion_ask_user'])
    expect(h.tools()).not.toContain(IMAGE_GENERATION_TOOL_NAME)
  })

  it('preserves an explicitly empty active set instead of enabling all normal tools on exit', async () => {
    const h = runtime(undefined, { activeTools: [] })
    await h.event('session_start')
    await h.command('start')
    await h.command('exit')
    // Retain the existing native-question exception, but never add hidden mutating tools.
    expect(h.tools()).toEqual(['pion_ask_user'])
    expect(h.tools()).not.toContain(IMAGE_GENERATION_TOOL_NAME)
  })

  it.each([{ previous: [] }, { previous: ['read', 'custom-tool'] }])('preserves a persisted explicit subset $previous when leaving a restored plan', async ({ previous }) => {
    const h = runtime({ version: 1, enabled: true, toolsBeforePlanMode: previous })
    await h.event('session_start')
    await h.command('exit')
    expect(h.tools()).toEqual([...previous, 'pion_ask_user'])
    expect(h.tools()).not.toContain(IMAGE_GENERATION_TOOL_NAME)
  })

  it('does not enable a hidden image tool on normal build session startup or navigation', async () => {
    const h = runtime(undefined, { activeTools: ['read', 'bash'] })
    await h.event('session_start')
    await h.event('session_tree')
    expect(h.tools()).toEqual(['read', 'bash'])
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves a captured subset when navigating to a pre-plan branch (image available=%s)', async (imageAvailable) => {
    const h = runtime(undefined, { activeTools: ['read'], imageAvailable })
    await h.event('session_start')
    expect(h.tools()).not.toContain(IMAGE_GENERATION_TOOL_NAME)
    await h.command('start')
    h.branch.length = 0
    await h.event('session_tree')
    expect(h.tools()).toEqual(['read', 'pion_ask_user'])
    expect(h.tools()).not.toContain(IMAGE_GENERATION_TOOL_NAME)
    await h.event('session_shutdown')
    expect(h.branch).toEqual([])
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
  })

  it('does not reactivate the task tool while a plan session is restored', () => {
    const source = nativeTaskExtensionSource()

    expect(source).toContain('function planModeEnabled(ctx)')
    expect(source).toContain('if (!planModeEnabled(ctx)) ensureToolActive()')
  })

  it('does not create a plan entry when an untouched build session shuts down', async () => {
    const h = runtime()
    await h.event('session_start')
    await h.event('session_shutdown')
    expect(h.appendEntry).not.toHaveBeenCalled()
    expect(h.branch).toEqual([])
  })

  it.each(['plan', 'build'] as const)('does not advance the leaf on shutdown after persisted %s mode commands', async (mode) => {
    const h = runtime()
    await h.event('session_start')
    await h.command('start')
    expect(h.appendEntry).toHaveBeenLastCalledWith('plan-mode-state', {
      version: 1, enabled: true, toolsBeforePlanMode: h.initialTools
    })
    expect(h.tools()).toEqual(['read', 'pion_ask_user'])
    if (mode === 'build') {
      await h.command('exit')
      expect(h.tools()).toEqual(h.initialTools)
    }
    const savedBranch = structuredClone(h.branch)
    await h.command(mode === 'plan' ? 'start' : 'off') // a no-op is not a state mutation
    await h.event('session_shutdown')
    await h.event('session_shutdown')
    expect(h.branch).toEqual(savedBranch)
    expect(h.appendEntry).toHaveBeenCalledTimes(mode === 'plan' ? 1 : 2)
  })

  it.each([true, false])('does not rewrite an unchanged restored state (enabled=%s)', async (enabled) => {
    const saved = { version: 1, enabled, ...(enabled ? { toolsBeforePlanMode: ['read', 'bash'] } : {}) }
    const h = runtime(saved)
    await h.event('session_start')
    await h.event('session_tree')
    await h.event('session_shutdown')
    expect(h.appendEntry).not.toHaveBeenCalled()
    expect(h.branch).toEqual([{ id: 'saved', type: 'custom', customType: 'plan-mode-state', data: saved }])
  })

  it('persists tools first captured while restoring a legacy enabled plan, once', async () => {
    const h = runtime({ version: 1, enabled: true })
    await h.event('session_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
    await h.event('session_shutdown')
    expect(h.appendEntry).toHaveBeenCalledExactlyOnceWith('plan-mode-state', {
      version: 1, enabled: true, toolsBeforePlanMode: h.initialTools
    })
    await h.event('session_shutdown')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
    await h.command('exit')
    expect(h.tools()).toEqual(h.initialTools)
  })

  it('persists clearing paused saved tools while restoring build mode, once', async () => {
    const h = runtime({ version: 1, enabled: false, toolsBeforePlanMode: ['read', 'custom-tool'] })
    await h.event('session_start')
    expect(h.tools()).toEqual(['read', 'custom-tool', 'pion_ask_user'])
    expect(h.appendEntry).not.toHaveBeenCalled()
    await h.event('session_shutdown')
    expect(h.appendEntry).toHaveBeenCalledExactlyOnceWith('plan-mode-state', {
      version: 1, enabled: false, toolsBeforePlanMode: undefined
    })
    await h.event('session_shutdown')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
  })

  it('retries genuinely changed state at shutdown when a command append failed', async () => {
    const h = runtime()
    await h.event('session_start')
    h.appendEntry.mockImplementationOnce(() => { throw new Error('paused append') })
    await expect(h.command('start')).rejects.toThrow('paused append')
    expect(h.branch).toHaveLength(0)
    await h.event('session_shutdown')
    expect(h.branch).toHaveLength(1)
    expect(h.branch[0].data).toEqual({ version: 1, enabled: true, toolsBeforePlanMode: h.initialTools })
    await h.event('session_shutdown')
    expect(h.appendEntry).toHaveBeenCalledTimes(2)
  })

  it('uses the selected branch baseline instead of carrying plan state across tree navigation', async () => {
    const h = runtime()
    await h.event('session_start')
    await h.command('start')
    h.branch.length = 0 // selected branch predates plan mode
    await h.event('session_tree')
    await h.event('session_shutdown')
    expect(h.branch).toEqual([])
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
    expect(h.tools()).toContain('bash')
    await h.command('start')
    expect(h.appendEntry).toHaveBeenCalledTimes(2)
  })
})
