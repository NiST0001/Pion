import { describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
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
  details: {
    action: string; tasks: Task[]; nextId: number; native: string
    planId?: string; planStart?: boolean; completed?: boolean
  }
}
type Entry =
  | { type: 'message'; message: { role: string; toolName?: string; details?: Result['details']; content?: string } }
  | { type: 'custom'; customType: string; data: { enabled: boolean } | Result['details'] }
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
  const appendEntry = vi.fn((customType: string, data: Result['details']) => {
    branch.push({ type: 'custom', customType, data: structuredClone(data) })
  })
  const pi = {
    appendEntry,
    registerTool: (registered: Tool) => { tool = registered },
    getActiveTools: () => [...activeTools],
    setActiveTools,
    on: (name: string, handler: Handler) => { handlers.set(name, handler) }
  }
  // Materialize only the bundled extension, injecting real TypeBox schemas;
  // no SDK process, global mocks, or unscoped hooks leak into coverage aggregation.
  const install = new Function('Type', 'StringEnum', 'randomUUID', nativeTaskExtensionSource()
    .replace(/^import .*;\n/gm, '')
    .replace('export default function (pi)', 'return function (pi)'))(
    Type, (values: string[]) => Type.Union(values.map((value) => Type.Literal(value))), randomUUID
  ) as (api: typeof pi) => void
  install(pi)
  const ctx: Context = { sessionManager: { getBranch: () => branch } }
  return {
    tool,
    appendEntry,
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
  it('commits nested mutations without toolResult and restores deleted IDs and clears', async () => {
    const h = runtime()
    await h.tool.execute('nested-create', { action: 'create', subject: 'Nested task' })
    await h.tool.execute('nested-delete', { action: 'delete', id: 1 })
    expect(h.appendEntry).toHaveBeenCalledTimes(2)
    expect(h.branch().every((entry) => entry.type === 'custom')).toBe(true)
    const restarted = runtime(h.branch())
    await restarted.event('session_start')
    expect(await restarted.inspect()).toMatchObject({ nextId: 2, tasks: [{ id: 1, status: 'deleted' }] })
    const continued = await restarted.tool.execute('nested-create-2', { action: 'create', subject: 'Continue' })
    expect(continued.details.tasks[1].id).toBe(2)
    await restarted.tool.execute('nested-update', { action: 'update', id: 2, status: 'completed' })
    await restarted.tool.execute('nested-clear', { action: 'clear' })
    const cleared = runtime(restarted.branch())
    await cleared.event('session_tree')
    expect(await cleared.inspect()).toMatchObject({ tasks: [], nextId: 1 })
    await cleared.tool.execute('get-missing', { action: 'get', id: 1 }).catch(() => undefined)
    expect(cleared.appendEntry).not.toHaveBeenCalled()
  })

  it.each(['clear', 'create', 'update', 'delete'] as const)('rolls back %s and nextId when durable append fails', async (action) => {
    const h = runtime()
    await h.tool.execute('create', { action: 'create', subject: 'Before' })
    const before = await h.inspect()
    const branch = h.branch()
    h.appendEntry.mockImplementationOnce(() => { throw new Error('append failed') })
    await expect(h.tool.execute('failed', { action, id: 1, subject: 'After', status: 'completed' })).rejects.toThrow('append failed')
    expect(await h.inspect()).toEqual(before)
    expect(h.branch()).toEqual(branch)
    await h.tool.execute('read', { action: 'get', id: 1 })
    expect(h.appendEntry).toHaveBeenCalledTimes(2)
    await h.event('session_compact')
    expect(await h.inspect()).toEqual(before)
  })

  it('restores legacy and custom snapshots in branch order while ignoring malformed later entries', async () => {
    const h = runtime()
    await h.call({ action: 'create', subject: 'Legacy ancestor' })
    const legacy = h.branch().filter((entry) => entry.type === 'message')
    const restored = runtime(legacy)
    await restored.event('session_tree')
    expect((await restored.inspect()).tasks[0].subject).toBe('Legacy ancestor')
    await restored.tool.execute('clear', { action: 'clear' })
    const branch = restored.branch()
    branch.push({ type: 'custom', customType: 'pion-task-state', data: {
      action: 'update', native: 'pion', nextId: 2,
      tasks: [{ id: 1, subject: 'Invalid', status: 'unknown' as Task['status'], blockedBy: [] }]
    } })
    restored.selectBranch(branch)
    await restored.event('session_tree')
    expect(await restored.inspect()).toMatchObject({ tasks: [], nextId: 1 })
  })

  it('keeps IDs, status, dependencies and nextId across follow-ups and simple conversation', async () => {
    const h = runtime()
    await h.event('session_start')
    await h.call({ action: 'create', subject: 'Inspect' })
    await h.call({ action: 'create', subject: 'Implement', status: 'in_progress', blockedBy: [1] })
    await h.call({ action: 'create', subject: 'Verify', blockedBy: [2] })
    await h.call({ action: 'update', id: 1, status: 'completed' })
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

  it('archives only a nonempty fully completed plan, leaving list/get and its durable snapshot intact', async () => {
    const h = runtime()
    expect(await h.inspect()).toMatchObject({ completed: false })
    const initial = await h.call({ action: 'create', subject: 'Implement', status: 'in_progress' })
    await h.call({ action: 'create', subject: 'Verify', blockedBy: [1] })
    await h.call({ action: 'create', subject: 'Dropped scope' })
    await h.call({ action: 'delete', id: 3 })
    const partial = await h.call({ action: 'update', id: 1, status: 'completed' })
    expect(partial).toMatchObject({ completed: false, planId: initial.planId, nextId: 4 })
    const branch = h.branch()
    await h.before('Waiting for test authorization')
    expect(await h.inspect()).toEqual({ ...partial, action: 'list' })
    expect(h.branch()).toEqual(branch)
    const final = await h.call({ action: 'update', id: 2, status: 'completed' })
    expect(final).toMatchObject({ completed: true, planId: initial.planId, nextId: 4 })
    expect(final.tasks).toHaveLength(3)
    expect((await h.tool.execute('get-completed', { action: 'get', id: 2 })).content[0].text).toContain('[completed]')
    const saved = h.branch()
    await h.before('Thanks')
    expect(h.branch()).toEqual(saved)
    const repeated = await h.call({ action: 'update', id: 2, status: 'completed' })
    expect(repeated).toEqual(final)
    expect(repeated.planStart).toBeUndefined()
    const restarted = runtime(h.branch())
    await restarted.event('session_start')
    expect(await restarted.inspect()).toEqual({ ...final, action: 'list' })
  })

  it('starts a fresh identified goal lazily and records the transition in one snapshot', async () => {
    const h = runtime()
    const old = await h.call({ action: 'create', subject: 'Old goal', status: 'completed' })
    const saved = h.branch()
    const newGoal = await h.tool.execute('new-goal', { action: 'create', subject: 'New goal' })
    expect(newGoal.details).toMatchObject({ planStart: true, completed: false, nextId: 2 })
    expect(newGoal.details.planId).not.toBe(old.planId)
    expect(newGoal.details.tasks).toEqual([expect.objectContaining({ id: 1, subject: 'New goal' })])
    expect(h.appendEntry).toHaveBeenCalledTimes(2)
    expect(h.branch().slice(saved.length)).toEqual([{
      type: 'custom', customType: 'pion-task-state', data: newGoal.details
    }])
    const next = await h.call({ action: 'create', subject: 'Dependent work', blockedBy: [1] })
    expect(next).toMatchObject({ planId: newGoal.details.planId, nextId: 3 })
    expect(next.planStart).toBeUndefined()
    expect(next.tasks[1]).toMatchObject({ id: 2, blockedBy: [1] })
    await h.call({ action: 'clear' })
    const replacement = await h.call({ action: 'create', subject: 'Explicit replacement' })
    expect(replacement.tasks[0].id).toBe(1)
    expect(replacement.planId).not.toBe(newGoal.details.planId)
    expect(replacement.planId).not.toBe(old.planId)
  })

  it('reopens a completed goal before appending same-goal work without losing IDs or dependencies', async () => {
    const h = runtime()
    await h.call({ action: 'create', subject: 'Implement' })
    await h.call({ action: 'create', subject: 'Verify', blockedBy: [1] })
    await h.call({ action: 'update', id: 1, status: 'completed' })
    const completed = await h.call({ action: 'update', id: 2, status: 'completed' })
    const reopened = await h.call({ action: 'update', id: 2, status: 'pending' })
    expect(reopened).toMatchObject({ completed: false, planId: completed.planId, nextId: 3 })
    const extra = await h.call({ action: 'create', subject: 'Regression follow-up', blockedBy: [2] })
    expect(extra.tasks.map((task) => task.id)).toEqual([1, 2, 3])
    expect(extra.tasks[1].blockedBy).toEqual([1])
    expect(extra.tasks[2].blockedBy).toEqual([2])
    expect(extra.planId).toBe(completed.planId)
    expect(extra.planStart).toBeUndefined()
    const injected = await h.before('Same-goal correction')
    expect(injected?.systemPrompt).toContain('first update an existing task back to pending/in_progress')
  })

  it('does not treat deleted-only or unfinished plans as completed goals', async () => {
    const h = runtime()
    const first = await h.call({ action: 'create', subject: 'Removed task' })
    const deleted = await h.call({ action: 'delete', id: 1 })
    expect(deleted.completed).toBe(false)
    const continued = await h.call({ action: 'create', subject: 'Waiting for approval' })
    expect(continued).toMatchObject({ completed: false, planId: first.planId, nextId: 3 })
    expect(continued.tasks.map((task) => task.id)).toEqual([1, 2])
    expect(continued.planStart).toBeUndefined()
    await h.call({ action: 'create', subject: 'Working', status: 'in_progress' })
    await h.call({ action: 'update', id: 2, status: 'completed' })
    expect((await h.inspect()).completed).toBe(false)
  })

  it('rolls back lazy replacement, completion and reopening together with plan identity on append failure', async () => {
    const h = runtime()
    await h.call({ action: 'create', subject: 'Goal' })
    for (const status of ['completed', 'pending'] as const) {
      if (status === 'pending') await h.call({ action: 'update', id: 1, status: 'completed' })
      const saved = await h.inspect()
      const branch = h.branch()
      h.appendEntry.mockImplementationOnce(() => { throw new Error('append failed') })
      await expect(h.call({ action: 'update', id: 1, status })).rejects.toThrow('append failed')
      expect(await h.inspect()).toEqual(saved)
      expect(h.branch()).toEqual(branch)
    }
    const completed = await h.inspect()
    const branch = h.branch()
    h.appendEntry.mockImplementationOnce(() => { throw new Error('append failed') })
    await expect(h.call({ action: 'create', subject: 'Next goal' })).rejects.toThrow('append failed')
    expect(await h.inspect()).toEqual(completed)
    expect(h.branch()).toEqual(branch)
    await h.event('session_compact')
    expect(await h.inspect()).toEqual(completed)
    const next = await h.call({ action: 'create', subject: 'Next goal' })
    expect(next.planId).not.toBe(completed.planId)
    expect(next.tasks[0].id).toBe(1)
  })

  it.each(['session_start', 'session_tree', 'session_compact'])(
    '%s restores completed/reopened/replacement identity along the selected branch', async (event) => {
      const h = runtime()
      const old = await h.call({ action: 'create', subject: 'Old goal', status: 'completed' })
      const completedBranch = h.branch()
      await h.call({ action: 'update', id: 1, status: 'pending' })
      const reopenedBranch = h.branch()
      await h.call({ action: 'update', id: 1, status: 'completed' })
      const next = await h.call({ action: 'create', subject: 'New goal' })
      const replacementBranch = h.branch()
      for (const [branch, expected] of [
        [completedBranch, { completed: true, planId: old.planId, subject: 'Old goal' }],
        [reopenedBranch, { completed: false, planId: old.planId, subject: 'Old goal' }],
        [replacementBranch, { completed: false, planId: next.planId, subject: 'New goal' }]
      ] as const) {
        h.selectBranch(branch)
        await h.event(event)
        expect(await h.inspect()).toMatchObject({
          completed: expected.completed, planId: expected.planId,
          tasks: [{ id: 1, subject: expected.subject }]
        })
      }
      h.selectBranch([])
      await h.event(event)
      expect(await h.inspect()).toMatchObject({ tasks: [], completed: false })
      expect((await h.inspect()).planId).toBeUndefined()
    }
  )

  it.each([
    { planId: '' }, { planId: 7 }, { planId: 'not-a-uuid' },
    { planId: '11111111-1111-4111-8111-111111111111', completed: 'yes' },
    { planId: '11111111-1111-4111-8111-111111111111', planStart: 'yes' }
  ])('keeps valid restored tasks when optional identity metadata is invalid: %j', async (metadata) => {
    const details = { action: 'update', native: 'pion', nextId: 2,
      tasks: [{ id: 1, subject: 'Preserve unfinished work', status: 'pending', blockedBy: [] }], ...metadata }
    const h = runtime([{ type: 'custom', customType: 'pion-task-state', data: details as Result['details'] }])
    await h.event('session_start')
    const restored = await h.inspect()
    expect(restored.tasks).toHaveLength(1)
    expect(restored.tasks[0].subject).toBe('Preserve unfinished work')
    expect(restored.planId).toBeUndefined()
    const changed = await h.call({ action: 'update', id: 1, status: 'in_progress' })
    expect(changed.planId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(changed.completed).toBe(false)
  })

  it('does not adopt an extra native plan ID from an old todo result', async () => {
    const details: Result['details'] = { action: 'list', native: 'pion', nextId: 2,
      tasks: [{ id: 1, subject: 'Legacy work', status: 'pending', blockedBy: [] }],
      planId: '11111111-1111-4111-8111-111111111111' }
    const h = runtime([{ type: 'message', message: { role: 'toolResult', toolName: 'todo', details } }])
    await h.event('session_start')
    expect(await h.inspect()).toMatchObject({ tasks: [{ id: 1, subject: 'Legacy work' }] })
    expect((await h.inspect()).planId).toBeUndefined()
  })

  it('restores legacy snapshots without invented plan identity and preserves missing-status pending work', async () => {
    const legacy = {
      action: 'list', native: 'pion', nextId: 3,
      tasks: [
        { id: 1, subject: 'Finished', status: 'completed', blockedBy: [] },
        { id: 2, subject: 'Unknown legacy status', blockedBy: [1] }
      ]
    } as Result['details']
    const h = runtime([{ type: 'custom', customType: 'pion-task-state', data: legacy }])
    await h.event('session_start')
    expect(await h.inspect()).toMatchObject({ completed: false, nextId: 3 })
    expect((await h.inspect()).planId).toBeUndefined()
    const saved = h.branch()
    await h.before('Thanks')
    expect(h.branch()).toEqual(saved)
    const continued = await h.call({ action: 'create', subject: 'Continue legacy', blockedBy: [2] })
    expect(continued.tasks.map((task) => task.id)).toEqual([1, 2, 3])
    expect(continued.planId).toEqual(expect.any(String))
    expect(continued.planStart).toBeUndefined()
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
      await original.call({ action: 'create', subject: 'Shared step' })
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
