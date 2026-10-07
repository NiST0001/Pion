import { describe, expect, it, vi } from 'vitest'
import type { Usage } from '@earendil-works/pi-ai'
import type { RunToolTiming, TokenUsage } from '../../src/shared/operations'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import { applyBackendEvent } from '../../src/main/agent/backend-events'

function setup() {
  const backend = { key: 'a', startPromise: Promise.resolve(), client: {
    getState: vi.fn(async () => ({ sessionId: 'a' })),
    getCommands: vi.fn(async () => [{ name: 'pion-subagents' }]),
    prompt: vi.fn(async () => 'handled' as const)
  } } as unknown as BackendRecord
  const push = vi.fn(async () => {})
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: 'a', win: { webContents: { id: 1 } }, desiredModes: new Map(),
    backendPool: { get: (key: string) => key === backend.key ? backend : undefined },
    getActiveBackend: () => backend, pushSessionInfo: push, clearSubagentPermissions: vi.fn()
  }) as AgentBridge
  return { backend, bridge, push }
}

it('rejects foreign windows, stale sessions and unsupported runtimes without sending a prompt', async () => {
  const h = setup()
  await expect(h.bridge.setSubagentsMode(true, 'a', 2)).rejects.toThrow('主窗口')
  await expect(h.bridge.setSubagentsMode(true, 'old', 1)).rejects.toThrow('会话已切换')
  vi.mocked(h.backend.client.getCommands).mockResolvedValue([])
  await expect(h.bridge.setSubagentsMode(true, 'a', 1)).rejects.toThrow('不支持')
  expect(h.backend.client.prompt).not.toHaveBeenCalled()
})

it('rejects an owner switch during state loading and serializes toggle requests', async () => {
  const h = setup()
  let release!: () => void
  h.backend.startPromise = new Promise<void>((resolve) => { release = resolve })
  const first = h.bridge.setSubagentsMode(true, 'a', 1)
  await expect(h.bridge.setSubagentsMode(false, 'a', 1)).rejects.toThrow('正在切换')
  Object.assign(h.bridge, { activeKey: 'b' })
  release()
  await expect(first).rejects.toThrow('会话已切换')
  expect(h.backend.client.prompt).not.toHaveBeenCalled()
  expect(h.backend.subagentsModePending).toBe(false)
})

it('sets only the captured backend and does not refresh a different active session', async () => {
  const h = setup()
  vi.mocked(h.backend.client.prompt).mockImplementation(async () => { Object.assign(h.bridge, { activeKey: 'b' }); return 'handled' })
  await h.bridge.setSubagentsMode(true, 'a', 1)
  expect(h.backend.subagentsEnabled).toBe(true)
  expect(h.push).not.toHaveBeenCalled()
})

it('archives nested task commits in their user turn without inventing duplicate tool rows', async () => {
  const task = { id: 1, subject: 'Nested plan', status: 'completed' }
  const branch = [
    { type: 'message', id: 'user', timestamp: '2026-01-01', message: { role: 'user', content: 'Make a plan' } },
    { type: 'custom', id: 'commit', customType: 'pion-task-state', data: { native: 'pion', tasks: [task], nextId: 2 } },
    { type: 'message', id: 'legacy-result', message: { role: 'toolResult', toolName: 'pion_task', details: { tasks: [task] } } }
  ]
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    resolveListedSession: vi.fn(async () => ({ sessionPath: '/project/session.jsonl' })),
    openCurrentSessionManager: vi.fn(async () => ({ getBranch: () => branch }))
  }) as AgentBridge
  const history = await bridge.getSessionTaskHistory('/project/session.jsonl')
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ entryId: 'user', prompt: 'Make a plan', tasks: [{ id: 1, title: 'Nested plan', status: 'completed' }] })
})

it('archives explicit goal identities across turns alongside legacy plans, using only the selected branch', async () => {
  const planA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const planB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const task = (subject: string, status: string, id = 1) => ({ id, subject, status })
  const user = (id: string, content: string) => ({ type: 'message', id, timestamp: '2026-01-01', message: { role: 'user', content } })
  const commit = (id: string, details: Record<string, unknown>) => ({ type: 'custom', id, customType: 'pion-task-state', data: { native: 'pion', ...details } })
  const tool = (id: string, details: Record<string, unknown>, toolName = 'pion_task') => ({
    type: 'message', id, message: { role: 'toolResult', toolName, details }
  })
  const first = { planId: planA, planStart: true, completed: false, tasks: [task('First goal', 'pending')], nextId: 2 }
  const complete = { planId: planA, completed: true, tasks: [task('First goal', 'completed')], nextId: 2 }
  const second = { planId: planB, planStart: true, completed: false,
    tasks: [task('Second goal', 'completed'), task('Await permission', 'pending', 2)], nextId: 3 }
  const branch = Object.freeze([
    user('legacy-user', 'Legacy goal'),
    tool('legacy-result', { tasks: [task('Legacy goal', 'completed')] }, 'todo'),
    user('first-user', 'First native goal'), commit('first-commit', first), tool('first-result', first),
    user('question', 'An unrelated question'),
    user('finish-user', 'Finish first goal'), commit('complete-commit', complete), tool('complete-result', complete),
    user('reopen-user', 'Correction to first goal'),
    commit('reopen-commit', { ...complete, completed: false, tasks: [task('First goal', 'in_progress')] }),
    commit('recomplete', complete),
    // A second goal can begin in this same user turn, with task #1 again.
    commit('new-goal', second), tool('new-goal-result', second),
    commit('clear', { tasks: [], nextId: 1, completed: false }),
    tool('failed-clear', { tasks: [] }, 'other'),
    user('final-question', 'Question without new tasks')
  ])
  const original = JSON.stringify(branch)
  const getBranch = vi.fn(() => branch)
  const appendEntry = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    resolveListedSession: vi.fn(async () => ({ sessionPath: '/project/selected.jsonl' })),
    openCurrentSessionManager: vi.fn(async () => ({ getBranch, appendEntry }))
  }) as AgentBridge
  const history = await bridge.getSessionTaskHistory('/project/selected.jsonl')
  expect(history).toHaveLength(3)
  expect(history[0]).toMatchObject({ entryId: 'legacy-user', ordinal: 1, tasks: [{ id: 1, title: 'Legacy goal', status: 'completed' }] })
  expect(history[1]).toMatchObject({ entryId: 'first-user', ordinal: 2, prompt: 'First native goal', tasks: [{ id: 1, title: 'First goal', status: 'completed' }] })
  expect(history[2]).toMatchObject({ entryId: 'reopen-user', ordinal: 5, tasks: [
    { id: 1, title: 'Second goal', status: 'completed' }, { id: 2, title: 'Await permission', status: 'pending' }
  ] })
  expect(new Set(history.map((run) => run.key)).size).toBe(3)
  expect(getBranch).toHaveBeenCalledTimes(1)
  expect(appendEntry).not.toHaveBeenCalled()
  expect(JSON.stringify(branch)).toBe(original)
})

it('uses the same task snapshot validation for custom and final tool messages', async () => {
  const branch = [
    { type: 'message', id: 'user', message: { role: 'user', content: 'Legacy fallback' } },
    { type: 'custom', customType: 'pion-task-state', data: {
      native: 'pion', planId: 'invalid', completed: 'false', tasks: [{ id: 1, subject: 'Keep', status: 'pending' }]
    } },
    { type: 'message', message: { role: 'toolResult', toolName: 'pion_task', isError: true, details: { tasks: [] } } },
    { type: 'message', message: { role: 'toolResult', toolName: 'pion_task', details: {
      tasks: [{ id: 1, subject: 'Keep', status: 'completed' }], nextId: 1
    } } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: {
      tasks: [{ id: 1, subject: 'Keep', status: 'completed' }], nextId: 2
    } } }
  ]
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    resolveListedSession: vi.fn(async () => ({ sessionPath: '/project/session.jsonl' })),
    openCurrentSessionManager: vi.fn(async () => ({ getBranch: () => branch }))
  }) as AgentBridge
  const history = await bridge.getSessionTaskHistory('/project/session.jsonl')
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ key: 'user', tasks: [{ id: 1, title: 'Keep', status: 'completed' }] })
})

it('mirrors direct command state events into their own backend', () => {
  const h = setup()
  applyBackendEvent(h.backend, { type: 'entry_appended', entry: { type: 'custom', customType: 'pion-subagents-state', data: { enabled: true } } }, new Map())
  expect(h.backend.subagentsEnabled).toBe(true)
})

it('adds child billing only once without changing parent context usage', () => {
  const h = billingHarness()
  const { run, bridge, backend } = h
  const event = { toolCallId: 'batch', toolName: 'pion_subagents', isError: false,
    result: { usage: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: .2 } } } }
  bridge.trackBackendEvent(backend, event, 'tool_execution_start')
  bridge.trackBackendEvent(backend, event, 'tool_execution_end')
  bridge.trackBackendEvent(backend, event, 'tool_execution_end')
  expect(run.usage.total).toBe(12)
  expect(run.usage.costUsd).toBe(.2)
  expect(run.contextTokens).toBe(123)
  expect(run.contextPressure).toBe(.5)
})

// Standard SDK AgentToolResult.usage (also AssistantImages.usage), not a
// models-progress cost, image count, or a locally estimated price.
const nativeUsage: Usage = {
  input: 4, output: 8, cacheRead: 2, cacheWrite: 1, totalTokens: 15,
  cost: { input: .01, output: .02, cacheRead: .01, cacheWrite: .01, total: .05 }
}

function billingHarness() {
  const run = {
    tools: [] as RunToolTiming[],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: 0 } as TokenUsage,
    usageBackendId: 'billing-backend',
    contextTokens: 123, contextPressure: .5, contextUsagePending: true,
    liveUsage: { input: 123, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 124, costUsd: .01 }
  }
  let listener: (event: unknown) => void = () => undefined
  const backend = {
    key: 'billing', cwd: '/project', activeRunId: 'run', usageBackendId: 'billing-backend',
    sessionPath: '/project/session.jsonl', sidebarPublishedSessionPath: '/project/session.jsonl',
    client: { onEvent: (callback: typeof listener) => { listener = callback } }
  } as unknown as BackendRecord
  const pool = new Map([[backend.key, backend]])
  const runs = new Map([['run', run]])
  const update = vi.fn((id: string, mutate: (value: typeof run) => void) => {
    const source = runs.get(id)
    if (source) mutate(source)
  })
  const send = vi.fn()
  const clearSubagentPermissions = vi.fn()
  const recordUsageEntry = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: backend.key, backendPool: pool, desiredModes: new Map(),
    runStore: { update, get: (id: string) => runs.get(id), recordUsageEntry }, win: { webContents: { send } },
    clearSubagentPermissions, pushSessionInfo: vi.fn(), refreshSidebarSessions: vi.fn()
  }) as {
    trackBackendEvent: (backend: BackendRecord, event: unknown, type: string) => void
    attachBackendEvents: (backend: BackendRecord) => void
  }
  bridge.attachBackendEvents(backend)
  const emit = (type: string, fields: Record<string, unknown> = {}) => listener({ type, ...fields })
  return { bridge, backend, pool, run, runs, update, send, clearSubagentPermissions, recordUsageEntry, emit }
}

describe('native root tool billing', () => {
  it.each(['codemode', 'pion_subagents'])('keeps charged %s failure usage, context and duplicate final timing', (toolName) => {
    const h = billingHarness()
    const context = { tokens: h.run.contextTokens, pressure: h.run.contextPressure,
      pending: h.run.contextUsagePending, live: h.run.liveUsage }
    h.emit('tool_execution_start', { toolCallId: 'root', toolName })
    h.emit('tool_execution_update', { toolCallId: 'root', toolName,
      partialResult: { usage: nativeUsage, details: { calls: [{ name: 'models.generateImages', cost: .05 }] } } })
    expect(h.run.usage.total).toBe(0)
    const result = { toolCallId: 'root', toolName, isError: true, result: { usage: nativeUsage } }
    h.emit('tool_execution_end', result)
    const timing = { ...h.run.tools[0] }
    // A later contradictory replay cannot overwrite the authoritative final.
    h.emit('tool_execution_end', { ...result, isError: false })
    expect(h.run.usage).toMatchObject({ input: 4, output: 8, cacheRead: 2, cacheWrite: 1, total: 15, costUsd: .05 })
    expect(h.run.tools).toEqual([timing])
    expect(timing).toMatchObject({ name: toolName, state: 'failed', isError: true })
    expect({ tokens: h.run.contextTokens, pressure: h.run.contextPressure,
      pending: h.run.contextUsagePending, live: h.run.liveUsage }).toEqual(context)
    // Tool billing never invents standalone SDK usage ledger entries.
    expect(h.recordUsageEntry).not.toHaveBeenCalled()
  })

  it('adds independent nested child and root model usage once without forwarding nested rows', () => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode', parentToolCallId: '' })
    for (const toolName of ['models.classify', 'models.generateImages', 'pion_subagents', 'read']) {
      const nested = { toolCallId: `root/${toolName}`, parentToolCallId: 'root', toolName }
      h.emit('tool_execution_start', nested)
      h.emit('tool_execution_end', { ...nested, isError: false, result: { usage: nativeUsage } })
      // The tracking method also fails closed if called without the RPC path.
      h.bridge.trackBackendEvent(h.backend, { ...nested, result: { usage: nativeUsage } }, 'tool_execution_end')
    }
    expect(h.run.tools).toHaveLength(1)
    expect(h.run.usage.total).toBe(15)
    expect(h.clearSubagentPermissions).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)
    h.emit('tool_execution_end', { toolCallId: 'root', toolName: 'codemode', result: { usage: nativeUsage } })
    expect(h.run.usage.total).toBe(30)
    expect(h.run.usage.costUsd).toBe(.1)
    expect(h.run.contextTokens).toBe(123)
    expect(h.run.contextPressure).toBe(.5)
    expect(h.run.contextUsagePending).toBe(true)
    expect(h.run.tools).toHaveLength(1)
    expect(h.send).toHaveBeenCalledTimes(2)
  })

  it('rejects unmatched roots, missing IDs and end-only nested usage', () => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode' })
    for (const fields of [
      { toolCallId: 'orphan', parentToolCallId: 'missing' },
      { parentToolCallId: 'root' },
      { toolCallId: '', parentToolCallId: 'root' }
    ]) {
      h.emit('tool_execution_start', { ...fields, toolName: 'pion_subagents' })
      h.emit('tool_execution_end', { ...fields, toolName: 'pion_subagents', result: { usage: nativeUsage } })
    }
    h.emit('tool_execution_end', { toolCallId: 'end-only', parentToolCallId: 'root',
      toolName: 'pion_subagents', result: { usage: nativeUsage } })
    expect(h.run.usage.total).toBe(0)
    expect(h.backend.nativeToolReceipts?.size).toBe(1)
    expect(h.run.tools).toHaveLength(1)
  })

  it('retains late depth-chain receipts on the original settled run, not the next active run', () => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode' })
    h.emit('tool_execution_start', { toolCallId: 'middle', toolName: 'read', parentToolCallId: 'root' })
    const child = { toolCallId: 'child', toolName: 'pion_subagents', parentToolCallId: 'middle' }
    h.emit('tool_execution_start', child)
    h.emit('tool_execution_end', { toolCallId: 'root', toolName: 'codemode', isError: true })
    const next = { ...h.run, tools: [], usage: { ...h.run.usage } }
    h.runs.set('next', next)
    h.backend.activeRunId = 'next'
    Object.assign(h.bridge, { activeKey: 'another-background-session' })
    const end = { ...child, result: { usage: nativeUsage } }
    h.emit('tool_execution_end', end)
    h.emit('tool_execution_end', end)
    h.emit('tool_execution_start', child)
    h.emit('tool_execution_end', end)
    // New starts cannot borrow an already completed root in a later dispatch.
    h.emit('tool_execution_start', { ...child, toolCallId: 'new-late-child' })
    h.emit('tool_execution_end', { ...end, toolCallId: 'new-late-child' })
    expect(h.run.usage.total).toBe(15)
    expect(next.usage.total).toBe(0)
    expect(next.tools).toEqual([])
    expect(h.run.tools).toHaveLength(1)
    expect(h.backend.nativeToolReceipts?.get('child')).toMatchObject({
      runId: 'run', rootId: 'root', parentId: 'middle', state: 'ended', usageConsumed: true
    })
  })

  it.each(['replaced', 'unmatched-source', 'removed-source'])('drops nested receipts for %s backends/runs', (reason) => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode' })
    const child = { toolCallId: 'child', toolName: 'pion_subagents', parentToolCallId: 'root' }
    h.emit('tool_execution_start', child)
    if (reason === 'replaced') h.pool.set(h.backend.key, { ...h.backend, usageBackendId: 'replacement' })
    if (reason === 'unmatched-source') h.run.usageBackendId = 'prior-backend'
    if (reason === 'removed-source') h.runs.delete('run')
    const result = { ...child, result: { usage: nativeUsage } }
    h.emit('tool_execution_end', result)
    // Private tracking must also reject callers bypassing the RPC listener.
    h.bridge.trackBackendEvent(h.backend, result, 'tool_execution_end')
    expect(h.run.usage.total).toBe(0)
  })

  it('bounds backend receipts and run timing while retaining replay protection at saturation', () => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode' })
    for (let index = 0; index < 520; index++) {
      const child = { toolCallId: `child-${index}`, parentToolCallId: 'root', toolName: 'pion_subagents' }
      h.emit('tool_execution_start', child)
      h.emit('tool_execution_end', { ...child, result: { usage: nativeUsage } })
    }
    expect(h.backend.nativeToolReceipts?.size).toBe(512)
    expect(h.run.usage.total).toBe(511 * 15)
    const replay = { toolCallId: 'child-0', parentToolCallId: 'root', toolName: 'pion_subagents' }
    h.emit('tool_execution_start', replay)
    h.emit('tool_execution_end', { ...replay, result: { usage: nativeUsage } })
    expect(h.run.usage.total).toBe(511 * 15)
    for (let index = 0; index < 90; index++) {
      h.emit('tool_execution_start', { toolCallId: `timing-${index}`, toolName: 'read' })
      h.emit('tool_execution_end', { toolCallId: `timing-${index}`, toolName: 'read' })
    }
    expect(h.run.tools).toHaveLength(80)
    expect(h.backend.nativeToolReceipts?.size).toBe(512)
    const rootEnd = { toolCallId: 'root', toolName: 'codemode', result: { usage: nativeUsage } }
    h.emit('tool_execution_end', rootEnd)
    h.emit('tool_execution_end', rootEnd)
    expect(h.run.usage.total).toBe(512 * 15)
    expect(h.run.tools).toHaveLength(80)
  })

  it.each(['codemode', 'pion_subagents'])('fails closed for %s end-only roots even with a final timing row', (toolName) => {
    const h = billingHarness()
    h.run.tools.push({ toolCallId: 'unproven', name: toolName, state: 'completed', startedAt: 1, endedAt: 2 })
    h.emit('tool_execution_end', { toolCallId: 'unproven', toolName, result: { usage: nativeUsage } })
    h.emit('tool_execution_end', { toolCallId: 'no-start', toolName, result: { usage: nativeUsage } })
    expect(h.run.usage.total).toBe(0)
    expect(h.run.tools).toHaveLength(1)
    expect(h.update).not.toHaveBeenCalled()
  })

  it('uses the unconsumed start receipt rather than final timing as billing proof', () => {
    const h = billingHarness()
    const root = { toolCallId: 'captured', toolName: 'codemode' }
    h.emit('tool_execution_start', root)
    h.run.tools[0].endedAt = 1
    h.run.tools[0].state = 'completed'
    h.emit('tool_execution_end', { ...root, isError: true, result: { usage: nativeUsage } })
    h.emit('tool_execution_end', { ...root, result: { usage: nativeUsage } })
    expect(h.run.usage.total).toBe(15)
    expect(h.run.tools[0].state).toBe('failed')
    expect(h.backend.nativeToolReceipts?.get(root.toolCallId)?.usageConsumed).toBe(true)
  })

  it.each(['codemode', 'pion_subagents'])('denies new %s billing at receipt saturation through timing eviction and cross-run replay', (toolName) => {
    const h = billingHarness()
    // Completed roots occupy the bounded proof window permanently.
    for (let index = 0; index < 512; index++) {
      const root = { toolCallId: `captured-${index}`, toolName: 'read' }
      h.emit('tool_execution_start', root)
      h.emit('tool_execution_end', root)
    }
    const unproven = { toolCallId: 'saturated-root', toolName }
    const end = { ...unproven, result: { usage: nativeUsage } }
    h.emit('tool_execution_start', unproven)
    h.emit('tool_execution_end', end)
    expect(h.backend.nativeToolReceipts?.has(unproven.toolCallId)).toBe(false)
    expect(h.run.usage.total).toBe(0)
    expect(h.run.tools.some((tool) => tool.toolCallId === unproven.toolCallId)).toBe(true)
    for (let index = 0; index < 81; index++) {
      h.emit('tool_execution_start', { toolCallId: `uncaptured-${index}`, toolName: 'read' })
    }
    expect(h.run.tools).toHaveLength(80)
    expect(h.run.tools.some((tool) => tool.toolCallId === unproven.toolCallId)).toBe(false)
    h.emit('tool_execution_start', unproven)
    h.emit('tool_execution_end', end)
    // Even a previously captured final whose timing was pruned remains consumed.
    h.emit('tool_execution_start', { toolCallId: 'captured-0', toolName: 'read' })
    h.emit('tool_execution_end', { toolCallId: 'captured-0', toolName: 'read' })
    const next = { ...h.run, tools: [], usage: { ...h.run.usage } }
    h.runs.set('next', next)
    h.backend.activeRunId = 'next'
    h.emit('tool_execution_start', unproven)
    h.emit('tool_execution_end', end)
    h.emit('tool_execution_start', { toolCallId: 'captured-0', toolName: 'read' })
    h.emit('tool_execution_end', { toolCallId: 'captured-0', toolName: 'read' })
    expect(h.run.usage.total).toBe(0)
    expect(next.usage.total).toBe(0)
    expect(h.backend.nativeToolReceipts?.size).toBe(512)
    expect(h.backend.nativeToolReceipts?.get('captured-0')).toMatchObject({ runId: 'run', state: 'ended', usageConsumed: true })
  })

  it.each(['inactive', 'next-active', 'pruned', 'wrong-source', 'wrong-name', 'wrong-backend'])('requires a matching captured root source for %s late failures', (scenario) => {
    const h = billingHarness()
    const root = { toolCallId: 'late-root', toolName: 'codemode' }
    h.emit('tool_execution_start', root)
    const next = { ...h.run, tools: [], usage: { ...h.run.usage } }
    h.runs.set('next', next)
    h.backend.activeRunId = scenario === 'inactive' ? undefined : 'next'
    if (scenario === 'pruned') h.runs.delete('run')
    if (scenario === 'wrong-source') h.run.usageBackendId = 'different'
    if (scenario === 'wrong-backend') h.backend.usageBackendId = 'different'
    const end = { ...root, toolName: scenario === 'wrong-name' ? 'pion_subagents' : root.toolName,
      isError: true, result: { usage: nativeUsage } }
    h.emit('tool_execution_end', end)
    h.emit('tool_execution_end', end)
    expect(h.run.usage.total).toBe(['inactive', 'next-active'].includes(scenario) ? 15 : 0)
    expect(next.usage.total).toBe(0)
    expect(next.tools).toEqual([])
    expect(h.runs.size).toBe(scenario === 'pruned' ? 1 : 2)
  })

  it('retains once-only proof after the captured root final timing is evicted', () => {
    const h = billingHarness()
    const root = { toolCallId: 'paid-root', toolName: 'codemode' }
    const end = { ...root, result: { usage: nativeUsage } }
    h.emit('tool_execution_start', root)
    h.emit('tool_execution_end', end)
    for (let index = 0; index < 81; index++) {
      const tool = { toolCallId: `other-${index}`, toolName: 'read' }
      h.emit('tool_execution_start', tool)
      h.emit('tool_execution_end', tool)
    }
    expect(h.run.tools.some((tool) => tool.toolCallId === root.toolCallId)).toBe(false)
    h.emit('tool_execution_start', root)
    h.emit('tool_execution_end', end)
    const next = { ...h.run, tools: [], usage: { ...h.run.usage, total: 0, costUsd: 0 } }
    h.runs.set('next', next)
    h.backend.activeRunId = 'next'
    h.emit('tool_execution_start', root)
    h.emit('tool_execution_end', end)
    expect(h.run.usage.total).toBe(15)
    expect(next.usage.total).toBe(0)
    expect(next.tools).toEqual([])
  })

  it('does not use tool-result message usage as parent context or bill it twice', () => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode' })
    h.emit('tool_execution_end', { toolCallId: 'root', toolName: 'codemode', result: { usage: nativeUsage } })
    h.emit('message_end', { message: { role: 'toolResult', toolCallId: 'root', toolName: 'codemode', usage: nativeUsage } })
    expect(h.run.usage.total).toBe(15)
    expect(h.run.contextTokens).toBe(123)
    expect(h.run.contextPressure).toBe(.5)
    expect(h.run.contextUsagePending).toBe(true)
  })

  it('retains SDK cost-only usage without inventing tokens from image units or progress prices', () => {
    const h = billingHarness()
    h.emit('tool_execution_start', { toolCallId: 'images', toolName: 'codemode' })
    h.emit('tool_execution_end', { toolCallId: 'images', toolName: 'codemode', result: {
      usage: { ...nativeUsage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      details: { calls: [{ name: 'models.generateImages', images: 2, cost: 99 }] }
    } })
    expect(h.run.usage).toMatchObject({ total: 0, input: 0, output: 0, costUsd: .05 })
    expect(h.run.contextTokens).toBe(123)
  })

  it('ignores late results from a replaced backend and does not assign a settled result to queued runs', () => {
    const h = billingHarness()
    const result = { toolCallId: 'late', toolName: 'codemode', result: { usage: nativeUsage } }
    h.pool.set(h.backend.key, { ...h.backend, activeRunId: 'replacement-run' })
    h.emit('tool_execution_end', result)
    expect(h.update).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    h.pool.set(h.backend.key, h.backend)
    h.backend.activeRunId = undefined
    h.backend.pendingRunIds = ['queued-run']
    h.emit('tool_execution_end', result)
    expect(h.update).not.toHaveBeenCalled()
    expect(h.run.usage.total).toBe(0)
    expect(h.run.tools).toEqual([])
  })
})
