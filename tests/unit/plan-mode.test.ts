import { describe, expect, it, vi } from 'vitest'
import { nativePlanModeExtensionSource } from '../../src/main/agent/plan-mode'
import { nativeTaskExtensionSource } from '../../src/main/agent/task-planning'

type PlanState = { version?: number; enabled: boolean; toolsBeforePlanMode?: string[] }
type PlanEntry = { id: string; type: 'custom'; customType: string; data: PlanState }
type PlanContext = { sessionManager: { getBranch(): PlanEntry[] }; ui: { notify: ReturnType<typeof vi.fn> } }
type LifecycleHandler = (event: unknown, ctx: PlanContext) => void | Promise<void>

function runtime(saved?: PlanState) {
  const initialTools = ['read', 'bash', 'edit', 'write', 'pion_ask_user', 'custom-tool']
  let tools = [...initialTools]
  const branch: PlanEntry[] = saved
    ? [{ id: 'saved', type: 'custom', customType: 'plan-mode-state', data: saved }]
    : []
  const handlers = new Map<string, LifecycleHandler>()
  let command!: { handler(args: string, ctx: PlanContext): Promise<void> }
  const appendEntry = vi.fn((customType: string, data: PlanState) => {
    branch.push({ id: `entry-${branch.length}`, type: 'custom', customType, data: structuredClone(data) })
  })
  const pi = {
    getAllTools: () => initialTools.map((name) => ({ name,
      sourceInfo: { source: name === 'pion_ask_user' ? 'sdk' : name === 'custom-tool' ? 'extension' : 'builtin' } })),
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
  return { initialTools, branch, appendEntry, tools: () => tools,
    event: (name: string) => handlers.get(name)!({}, ctx),
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
    expect(source).toContain('const restored = previous && previous.length > 0 ? previous : normalTools()')
    expect(source).toContain('...restored, ...nativeAsk')
    expect(source).toContain('只有用户明确切换回构建模式并发送执行请求后')
  })

  it('allows only the SDK-owned question tool alongside read-only built-ins', () => {
    const source = nativePlanModeExtensionSource()
    expect(source).toContain('if (name === "pion_ask_user") return tool?.sourceInfo?.source === "sdk"')
    expect(source).toContain('[...READ_ONLY_TOOL_NAMES, "pion_ask_user"]')
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
