import { describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import { nativeTaskExtensionSource } from '../../src/main/agent/task-planning'

type Task = {
  id: number
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blockedBy: number[]
}
type Params = {
  action: 'clear' | 'create' | 'update' | 'delete' | 'list' | 'get'
  id?: number
  subject?: string
  description?: string
  activeForm?: string
  status?: Task['status']
  blockedBy?: number[]
  addBlockedBy?: number[]
  removeBlockedBy?: number[]
}
type Result = {
  content: { type: string; text: string }[]
  details: { action: string; tasks: Task[]; nextId: number; native: string }
}
type Entry =
  | { type: 'message'; message: { role: string; toolName?: string; details?: Result['details']; content?: string } }
  | { type: 'custom'; customType: string; data: { enabled: boolean } }
type Event = { systemPrompt?: string; prompt?: string; systemPromptOptions?: { selectedTools: string[] } }
type Context = { sessionManager: { getBranch(): Entry[] } }
type Handler = (event: Event, ctx: Context) => Promise<{ systemPrompt: string } | undefined>
type Tool = {
  name: string
  promptSnippet: string
  promptGuidelines: string[]
  parameters: unknown
  execute(id: string, params: Params): Promise<Result>
}

function runtime(initialBranch: Entry[] = [], initialTools = ['read', 'pion_task']) {
  let branch = structuredClone(initialBranch)
  let activeTools = [...initialTools]
  const handlers = new Map<string, Handler>()
  let tool!: Tool
  const setActiveTools = vi.fn((tools: string[]) => { activeTools = [...tools] })
  const pi = {
    registerTool: (registered: Tool) => { tool = registered },
    getActiveTools: () => [...activeTools],
    setActiveTools,
    on: (name: string, handler: Handler) => { handlers.set(name, handler) }
  }
  // Materialize only the bundled extension, injecting real TypeBox schemas;
  // no SDK process, global mocks, or unscoped hooks leak into coverage aggregation.
  const install = new Function('Type', 'StringEnum', nativeTaskExtensionSource()
    .replace(/^import .*;\n/gm, '')
    .replace('export default function (pi)', 'return function (pi)'))(
    Type, (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)))
  ) as (api: typeof pi) => void
  install(pi)
  const ctx: Context = { sessionManager: { getBranch: () => branch } }
  return {
    tool,
    setActiveTools,
    activeTools: () => [...activeTools],
    branch: () => structuredClone(branch),
    selectBranch: (entries: Entry[]) => { branch = structuredClone(entries) },
    event: (name: string, event: Event = {}) => handlers.get(name)!(event, ctx),
    before: (prompt: string, selectedTools?: string[]) => handlers.get('before_agent_start')!({
      prompt, systemPrompt: 'Base system prompt',
      ...(selectedTools ? { systemPromptOptions: { selectedTools } } : {})
    }, ctx),
    async call(params: Params) {
      const result = await tool.execute('task-call', params)
      branch.push({ type: 'message', message: {
        role: 'toolResult', toolName: 'pion_task', details: structuredClone(result.details)
      } })
      return result.details
    },
    inspect: async () => (await tool.execute('inspect', { action: 'list' })).details
  }
}

describe('Pion native task plan continuity', () => {
  it('keeps IDs, status, dependencies and nextId across follow-ups and simple conversation', async () => {
    const h = runtime()
    await h.event('session_start')
    await h.call({ action: 'create', subject: 'Inspect', status: 'completed' })
    await h.call({ action: 'create', subject: 'Implement', status: 'in_progress', blockedBy: [1] })
    await h.call({ action: 'create', subject: 'Verify', blockedBy: [2] })
    const saved = await h.inspect()
    const branch = h.branch()
    for (const prompt of ['Continue the plan', 'What does the second step mean?', 'Thanks', 'Add a migration step']) {
      const injected = await h.before(prompt, ['read', 'pion_task'])
      expect(injected?.systemPrompt).toContain('Base system prompt')
      expect(injected?.systemPrompt).toContain('pion_task')
      expect(await h.inspect()).toEqual(saved)
      expect(h.branch()).toEqual(branch)
    }
    await h.call({ action: 'update', id: 2, subject: 'Implement and migrate', status: 'completed' })
    const continued = await h.call({ action: 'update', id: 3, status: 'in_progress', addBlockedBy: [1] })
    expect(continued.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 1, status: 'completed' }, { id: 2, status: 'completed' }, { id: 3, status: 'in_progress' }
    ])
    expect(continued.tasks[2].blockedBy).toEqual([2, 1])
    expect(continued.nextId).toBe(4)
  })

  it('supports a long plan with more than twelve tasks and dependency adjustments', async () => {
    const h = runtime()
    for (let id = 1; id <= 15; id++) {
      await h.call({ action: 'create', subject: `Step ${id}`, blockedBy: id === 1 ? [] : [id - 1, id - 1] })
    }
    await h.before('Continue the remaining steps')
    const longPlan = await h.inspect()
    expect(longPlan.tasks).toHaveLength(15)
    expect(longPlan.nextId).toBe(16)
    expect(longPlan.tasks.map((task) => task.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    expect(longPlan.tasks.map((task) => task.blockedBy)).toEqual(Array.from({ length: 15 }, (_, i) => i ? [i] : []))
    const adjusted = await h.call({ action: 'update', id: 15, addBlockedBy: [12, 13, 13], removeBlockedBy: [14] })
    expect(adjusted.tasks[14]).toMatchObject({ id: 15, blockedBy: [12, 13] })
    await expect(h.call({ action: 'update', id: 15, addBlockedBy: [15] })).rejects.toThrow('cannot block itself')
    expect((await h.inspect()).tasks).toEqual(adjusted.tasks)
  })

  it('preserves the single in_progress constraint when continuing a plan', async () => {
    const h = runtime()
    await h.call({ action: 'create', subject: 'First', status: 'in_progress' })
    await h.call({ action: 'create', subject: 'Second' })
    await h.before('Continue')
    await expect(h.call({ action: 'update', id: 2, status: 'in_progress' })).rejects.toThrow('already in_progress')
    await expect(h.call({ action: 'create', subject: 'Third', status: 'in_progress' })).rejects.toThrow('already in_progress')
    await h.call({ action: 'update', id: 1, status: 'completed' })
    const advanced = await h.call({ action: 'update', id: 2, status: 'in_progress' })
    expect(advanced.tasks.filter((task) => task.status === 'in_progress').map((task) => task.id)).toEqual([2])
    expect(advanced.nextId).toBe(3)
  })

  it('clears only on an explicit tool action and resets IDs for a replacement plan', async () => {
    const h = runtime()
    await h.call({ action: 'create', subject: 'Old objective', status: 'in_progress' })
    await h.call({ action: 'create', subject: 'Old follow-up', blockedBy: [1] })
    await h.before('Switch to a different objective')
    expect((await h.inspect()).tasks).toHaveLength(2)
    expect(await h.call({ action: 'clear' })).toMatchObject({ action: 'clear', tasks: [], nextId: 1 })
    await h.event('session_compact')
    await h.before('A quick question before the new plan')
    expect((await h.inspect()).tasks).toEqual([])
    const replacement = await h.call({ action: 'create', subject: 'New objective', status: 'in_progress' })
    expect(replacement.tasks).toEqual([expect.objectContaining({ id: 1, subject: 'New objective', blockedBy: [] })])
    expect(replacement.nextId).toBe(2)
  })

  it.each(['session_start', 'session_tree', 'session_compact'])(
    '%s restores only the selected branch snapshot, including explicit empty snapshots', async (event) => {
      const original = runtime()
      await original.call({ action: 'create', subject: 'Shared step', status: 'completed' })
      const ancestor = original.branch()
      await original.call({ action: 'create', subject: 'Selected branch step', status: 'in_progress', blockedBy: [1] })
      const selected = original.branch()
      const expected = await original.inspect()
      await original.call({ action: 'clear' })
      const cleared = original.branch()
      const h = runtime()
      await h.call({ action: 'create', subject: 'Unrelated stale state' })
      h.selectBranch(selected)
      await h.event(event)
      expect(await h.inspect()).toEqual(expected)
      expect(h.branch()).toEqual(selected)
      const next = await h.call({ action: 'create', subject: 'Continue selected branch', blockedBy: [2] })
      expect(next.tasks[2]).toMatchObject({ id: 3, blockedBy: [2] })
      h.selectBranch(ancestor)
      await h.event(event)
      expect((await h.inspect()).tasks).toEqual([expected.tasks[0]])
      expect((await h.inspect()).nextId).toBe(2)
      h.selectBranch(cleared)
      await h.event(event)
      expect(await h.inspect()).toMatchObject({ tasks: [], nextId: 1 })
      h.selectBranch([])
      await h.event(event)
      expect(await h.inspect()).toMatchObject({ tasks: [], nextId: 1 })
    }
  )

  it('does not inject policy or reactivate tasks when mode filtering hides the tool', async () => {
    const h = runtime([{ type: 'custom', customType: 'plan-mode-state', data: { enabled: true } }], ['read'])
    await h.event('session_start')
    expect(h.activeTools()).toEqual(['read'])
    for (const selectedTools of [[], ['read'], ['read', 'pion_ask_user']]) {
      expect(await h.before('Continue planning', selectedTools)).toBeUndefined()
    }
    expect(h.setActiveTools).not.toHaveBeenCalled()
    expect((await h.before('Continue planning', ['read', 'pion_task']))?.systemPrompt).toContain('pion_task')
  })

  it('removes mandatory turn-local rebuilding from policy and tool hints', async () => {
    const h = runtime()
    const injected = await h.before('Continue')
    const hints = [injected?.systemPrompt, h.tool.promptSnippet, ...h.tool.promptGuidelines].join('\n')
    for (const obsolete of [
      'turn-scoped task policy',
      'Scope tasks to the current user message only',
      'clear exactly once before creating the current turn',
      'Create a fresh plan from the current user message',
      'Do not reuse task ids',
      'current-turn task',
      "current user turn's multi-step plan",
      'clear once before creating a new turn plan'
    ]) expect(hints).not.toContain(obsolete)
    expect(hints).toContain('pion_task')
    expect(hints).toContain('clear')
    expect(hints).toContain('in_progress')
    expect(hints).toMatch(/continu(?:e|ing|ation)/i)
  })
})
