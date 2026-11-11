import { afterEach, expect, it, vi } from 'vitest'
import { SessionManager, type ExtensionAPI, type ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createSubagentControl, type SubagentResult, type SubagentTask } from '../../src/main/agent/subagents'
import { nativePlanModeExtensionSource } from '../../src/main/agent/plan-mode'

import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings, type SubagentModelSelection } from '../../src/shared/subagents'
import type { SubagentBatch } from '../../src/shared/subagent-batches'
import { createSubagentSessionPublisher, type SubagentSessionObserver, type SubagentSessionPublisher } from '../../src/main/agent/subagent-session-observer'

const context = { tools: [], executeTool: vi.fn(async () => { throw new Error('Unexpected tool delegation') }) } as unknown as ExtensionToolContext
afterEach(() => vi.useRealTimers())
function setup(run: Parameters<typeof createSubagentControl>[0] = async (task) => ({ name: task.name, status: 'completed', text: 'done' }),
  getSettings: () => SubagentSettings | Promise<SubagentSettings> = () => ({ ...DEFAULT_SUBAGENT_SETTINGS }), publisher?: SubagentSessionPublisher, catalog?: () => readonly SubagentModelSelection[]) {
  const control = createSubagentControl(run, getSettings, publisher, catalog)
  const handlers = new Map<string, (...args: any[]) => any>()
  const commands = new Map<string, { handler: (args: string, ctx: { isIdle: () => boolean }) => Promise<void> }>()
  let tools = ['read', 'bash']
  const manager = SessionManager.inMemory('/fixture')
  const appendEntry = vi.fn((type: string, data: unknown) => manager.appendCustomEntry(type, data))
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, (event, ctx = { sessionManager: manager }) => handler(event, ctx)),
    registerCommand: (name: string, command: { handler: (args: string, ctx: { isIdle: () => boolean }) => Promise<void> }) => commands.set(name, command),
    getActiveTools: () => tools,
    setActiveTools: (names: string[]) => { tools = names }, appendEntry
  } as unknown as ExtensionAPI
  control.extension(pi)
  handlers.get('session_start')!()
  return { control, handlers, appendEntry, pi, manager, tools: () => tools,
    setPlanMode: (enabled: boolean) => manager.appendCustomEntry('plan-mode-state', { version: 1, enabled }),
    toggle: (value: string) => commands.get('pion-subagents')!.handler(value, { isIdle: () => true }),
    execute: (signal?: AbortSignal) => control.tool.execute('batch', { tasks: [{ name: 'one', task: 'inspect' }, { name: 'two', task: 'edit another file' }] }, signal, undefined, context)
  }
}

it('honors 300-minute timeout while retaining the real pending batch gate until the runner settles', async () => {
  vi.useFakeTimers()
  let finish!: (value: SubagentResult) => void
  let childSignal!: AbortSignal
  const run = vi.fn((_task: SubagentTask, signal: AbortSignal) => {
    childSignal = signal
    return new Promise<SubagentResult>((resolve) => { finish = resolve })
  })
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, timeoutMinutes: 300 }))
  const tasks = [{ name: 'one', task: 'inspect' }]
  const pending = h.control.tool.execute('long', { tasks }, undefined, undefined, context)
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(300 * 60_000 - 1)
  expect(childSignal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(childSignal.aborted).toBe(true)
  await expect(h.control.tool.execute('overlap', { tasks }, undefined, undefined, context)).rejects.toThrow('已有子代理批次')
  finish({ name: 'one', status: 'aborted', text: 'finished' })
  await pending
  expect(vi.getTimerCount()).toBe(0)
})

it('requires an explicit user choice to override the settings model in AI guidance and tool description', async () => {
  const h = setup()
  const { systemPrompt } = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  for (const text of [systemPrompt, h.control.tool.description]) {
    expect(text).toContain('omit task.model')
    expect(text).toContain('never choose a model autonomously or use null to bypass')
    expect(text).toContain('null is only for an explicit user choice to inherit the parent')
  }
})

it('starts 100 children, bounds metadata and rejects 101 before publication', async () => {
  const observer = { event: vi.fn(), running: vi.fn(), cancelling: vi.fn(), finish: vi.fn() }
  const publisher = { begin: vi.fn(() => observer), halt: vi.fn() }
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: '界'.repeat(2048) }))
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 100, timeoutMinutes: 300 }), publisher)
  const tasks = Array.from({ length: 100 }, (_, i) => ({ name: `worker-${i}`, task: 'inspect' }))
  const result = await h.control.tool.execute('hundred', { tasks }, undefined, undefined, context)
  expect(run).toHaveBeenCalledTimes(100)
  expect(publisher.begin).toHaveBeenCalledTimes(100)
  const batch = (result.details as { subagentBatch: SubagentBatch }).subagentBatch
  expect(batch.tasks).toHaveLength(100)
  expect(batch.tasks.every((task) => task.summary!.length > 0 && task.summaryTruncated)).toBe(true)
  expect(Buffer.byteLength(batch.tasks.map((task) => task.summary).join(''))).toBeLessThanOrEqual(16 * 1024)
  await expect(h.control.tool.execute('too-many', { tasks: [...tasks, tasks[0]] }, undefined, undefined, context)).rejects.toThrow('安全上限')
  expect(publisher.begin).toHaveBeenCalledTimes(100)
})

it('only opts into the fifth runner argument through the host publisher and keeps transcript out of tool results', async () => {
  const observer = { event: vi.fn(), running: vi.fn(), cancelling: vi.fn(), finish: vi.fn() }
  const publisher = { begin: vi.fn(() => observer), halt: vi.fn() }
  const run = vi.fn(async (task: { name: string }, _signal: AbortSignal, _progress: (text: string) => void,
    _settings?: Readonly<SubagentSettings>, display?: SubagentSessionObserver) => {
    display?.event({ privateTranscript: 'private-only-text' })
    return { name: task.name, status: 'completed' as const, text: 'summary' }
  })
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS }), publisher)
  const result = await h.execute()
  expect(publisher.begin).toHaveBeenCalledWith({ name: 'one' }, 'batch')
  expect(run.mock.calls.every((call) => call.length === 5 && call[4] === observer)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('private-only-text')
  h.handlers.get('session_shutdown')!()
  expect(publisher.halt).toHaveBeenCalledOnce()
  run.mockClear()
  await setup(run).execute()
  expect(run.mock.calls.every((call) => call.length === 4)).toBe(true)
})

it.each(['publication-failed', 'invalid-identity'])('executes once with a batch summary when private display is %s', async (mode) => {
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }))
  const ctx = { mode: 'rpc', cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined },
    ui: { setWidget: vi.fn(() => { throw new Error('display unavailable') }) } }
  const publisher = createSubagentSessionPublisher({ nonce: mode === 'invalid-identity' ? 'n'.repeat(257) : 'nonce', createContext: () => ctx })
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS }), publisher)
  const update = vi.fn()
  const result = await h.control.tool.execute('batch', { tasks: [{ name: 'one', task: 'inspect' }] }, undefined, update, context)
  expect(run).toHaveBeenCalledOnce()
  expect(run.mock.calls[0]).toHaveLength(4)
  expect(result.details).toMatchObject({ results: [{ name: 'one', status: 'completed', text: 'done' }],
    subagentBatch: { version: 1, tasks: [{ index: 0, name: 'one', status: 'completed', summary: 'done', summaryTruncated: false }] } })
  expect(update.mock.calls.some(([value]) => value.content[0].text.includes('仅保留批次摘要'))).toBe(true)
  expect(ctx.ui.setWidget).toHaveBeenCalledTimes(mode === 'publication-failed' ? 1 : 0)
  expect(result.usage?.totalTokens).toBe(3)
  publisher.halt()
})

it('keeps both sibling executions, summaries and usage when one child has no display slot', async () => {
  const observer = { event: vi.fn(), running: vi.fn(), cancelling: vi.fn(), finish: vi.fn() }
  const publisher = { begin: vi.fn().mockReturnValueOnce(observer).mockReturnValue(undefined), halt: vi.fn() }
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'existing-summary',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }))
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS }), publisher)
  const result = await h.execute()
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls.map((call) => call.length)).toEqual([5, 4])
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('existing-summary') })
  expect((result.details as { results: SubagentResult[] }).results.map((r) => r.status)).toEqual(['completed', 'completed'])
  expect(result.usage?.totalTokens).toBe(6)
})

it('keeps execution results and usage when batch display callbacks throw', async () => {
  const run = vi.fn(async (task: SubagentTask) => ({ name: task.name, status: 'completed' as const, text: 'summary',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }))
  const h = setup(run)
  const result = await h.control.tool.execute('display-failure', { tasks: [{ name: 'one', task: 'inspect' }] }, undefined,
    () => { throw new Error('display unavailable') }, context)
  expect(run).toHaveBeenCalledOnce()
  expect(result.usage?.totalTokens).toBe(3)
  expect(result.content[0]).toMatchObject({ text: '## one [completed]\nsummary' })
})

it('validates settings and batch width before publication', async () => {
  const publisher = { begin: vi.fn(), halt: vi.fn() }
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  await expect(setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 0 }), publisher).execute()).rejects.toThrow()
  await expect(setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 1 }), publisher).execute()).rejects.toThrow('每批最多 1')
  await expect(setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, defaultThinkingLevel: 'unknown' as never }), publisher).execute()).rejects.toThrow('思考等级无效')
  expect(publisher.begin).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it('defaults on and still gates execution after the user explicitly turns it off', async () => {
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  const h = setup(run)
  expect(h.tools()).toContain('pion_subagents')
  await h.execute()
  expect(run).toHaveBeenCalledTimes(2)
  await h.toggle('off')
  await expect(h.execute()).rejects.toThrow('已关闭')
  expect(h.tools()).not.toContain('pion_subagents')
  expect(h.appendEntry).toHaveBeenLastCalledWith('pion-subagents-state', { enabled: false })
})

it('restores the default-on tool after a backend session restart', async () => {
  const h = setup()
  await h.toggle('off')
  expect(h.tools()).not.toContain('pion_subagents')
  h.handlers.get('session_start')!()
  expect(h.tools()).toContain('pion_subagents')
  const prompt = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(prompt.systemPrompt).toContain('Subagents are enabled by default')
})

it.each(['visible', 'hidden', 'off'] as const)('preserves the real plan restoration for %s subagents despite prompt markers', async (selection) => {
  const h = setup()
  const planHandlers = new Map<string, (...args: any[]) => any>()
  let planCommand!: { handler: (args: string, ctx: unknown) => Promise<void> }
  const install = new Function(nativePlanModeExtensionSource().replace(
    'export default function (pi)', 'return function (pi)'
  ))() as (pi: ExtensionAPI) => void
  install({ ...h.pi,
    getAllTools: () => ['read', 'bash', 'pion_subagents'].map((name) => ({ name,
      sourceInfo: { source: name === 'pion_subagents' ? 'sdk' : 'builtin' } })),
    on: (name: string, handler: (...args: any[]) => any) => planHandlers.set(name, handler),
    registerCommand: (_name: string, command: typeof planCommand) => { planCommand = command }
  } as unknown as ExtensionAPI)
  const ctx = { sessionManager: h.manager, ui: { notify: vi.fn() } }
  const quoted = await h.handlers.get('before_agent_start')!({ systemPrompt: 'Documentation: [PION PLAN MODE]' })
  expect(quoted.systemPrompt).toContain('use pion_subagents early')
  if (selection === 'hidden') h.pi.setActiveTools(['read', 'bash'])
  await planCommand.handler('start', ctx)
  expect(h.tools()).toEqual(['read'])
  // Explicit off during a plan must survive restoration of its captured ON set.
  if (selection === 'off') await h.toggle('off')
  await planHandlers.get('before_agent_start')!({ systemPrompt: 'base' }, ctx)
  const plan = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(plan.systemPrompt).toContain(selection === 'off' ? 'Pion subagents: OFF.' : 'not available in the current active tool set')
  expect(h.tools()).not.toContain('pion_subagents')
  await expect(h.execute()).rejects.toThrow(selection === 'off' ? '已关闭' : '当前模式已停用子代理')
  await planCommand.handler('exit', ctx)
  expect(h.tools()).toEqual(selection === 'hidden' ? ['read', 'bash'] : ['read', 'bash', 'pion_subagents'])
  const build = await h.handlers.get('before_agent_start')!({ systemPrompt: '[PION PLAN MODE]' })
  expect(h.tools()).toEqual(selection === 'visible' ? ['read', 'bash', 'pion_subagents'] : ['read', 'bash'])
  expect(build.systemPrompt).toContain(selection === 'visible' ? 'use pion_subagents early'
    : selection === 'off' ? 'Pion subagents: OFF.' : 'not available in the current active tool set')
  if (selection === 'hidden') {
    await expect(h.execute()).rejects.toThrow('当前模式已停用子代理')
    await h.toggle('on')
    expect(h.tools()).toContain('pion_subagents')
  }
})

it('does not inject the tool into a read-only mode during startup', async () => {
  const h = setup()
  h.tools().splice(h.tools().indexOf('bash'), 1)
  h.handlers.get('session_start')!()
  expect(h.tools()).not.toContain('pion_subagents')
  const prompt = await h.handlers.get('before_agent_start')!({ systemPrompt: 'plan' })
  expect(prompt.systemPrompt).toContain('not available in the current active tool set')
})

it('injects proactive delegation only while enabled and preserves the original prompt', async () => {
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  const h = setup(run)
  const prompt = () => h.handlers.get('before_agent_start')!({ systemPrompt: 'Project: no tests without approval.' })
  await h.toggle('off')
  expect((await prompt()).systemPrompt).toContain('Pion subagents: OFF.')
  await h.toggle('on')
  const on = (await prompt()).systemPrompt
  expect(on).toMatch(/^Project: no tests without approval\./)
  expect(on).toContain('Subagents are enabled by default')
  expect(on).toContain('use pion_subagents early')
  expect(on).toContain('without waiting for the user')
  expect(on).toContain('disjoint file ownership')
  expect(on).toContain('Handle trivial tasks, tightly dependent work, or conflicting edits directly')
  expect(on).toContain('not approval for otherwise restricted actions')
  // The default-on capability guides the model; it does not itself start children.
  expect(run).not.toHaveBeenCalled()
  await h.toggle('off')
  const off = (await prompt()).systemPrompt
  expect(off).toContain('Pion subagents: OFF.')
  expect(off).not.toContain('use pion_subagents early')
})

it('does not advertise usable delegation or restore a tool hidden by another mode', async () => {
  const h = setup()
  await h.toggle('on')
  h.tools().splice(h.tools().indexOf('pion_subagents'), 1)
  const { systemPrompt } = await h.handlers.get('before_agent_start')!({ systemPrompt: 'Read-only mode' })
  expect(systemPrompt).toContain('not available in the current active tool set')
  expect(systemPrompt).not.toContain('use pion_subagents early')
  expect(h.tools()).not.toContain('pion_subagents')
})

it('withholds proactive instructions if settings cannot be read', async () => {
  const h = setup(undefined, async () => { throw new Error('bad settings') })
  await h.toggle('on')
  const { systemPrompt } = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(systemPrompt).toContain('settings are unreadable. Do not delegate')
  expect(systemPrompt).not.toContain('use pion_subagents early')
})

it('does not restore ON guidance if switched off while settings are loading', async () => {
  let resolve!: (settings: SubagentSettings) => void
  const h = setup(undefined, () => new Promise<SubagentSettings>((done) => { resolve = done }))
  await h.toggle('on')
  const pending = h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  await h.toggle('off')
  resolve({ ...DEFAULT_SUBAGENT_SETTINGS })
  expect((await pending).systemPrompt).toContain('Pion subagents: OFF.')
  expect(h.tools()).not.toContain('pion_subagents')
})

it.each([1, 2, 4, 8, 100])('guides batch width using the current configured limit %i', async (maxParallel) => {
  const h = setup(undefined, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel }))
  await h.toggle('on')
  const { systemPrompt } = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  if (maxParallel === 1) {
    expect(systemPrompt).toContain('one child per batch')
    expect(systemPrompt).not.toContain('put 2–')
    await expect(h.control.tool.execute('single', { tasks: [{ name: 'one', task: 'inspect' }] }, undefined, undefined, context)).resolves.toBeDefined()
  } else {
    expect(systemPrompt).toContain(`put 2–${maxParallel} useful tasks in ONE pion_subagents call's tasks array`)
    expect(systemPrompt).toContain('Do not serialize independent work as separate one-task calls')
  }
  expect(systemPrompt).toContain('Keep dependent follow-up work for later batches')
  expect(systemPrompt).toContain('never invent tasks to fill slots')
  expect(systemPrompt).toContain('Reassess useful parallel work at each major stage')
})

it('starts a full four-child batch before any child finishes', async () => {
  const releases: Array<() => void> = []
  const run = vi.fn((task: { name: string }) => new Promise<SubagentResult>((resolve) => {
    releases.push(() => resolve({ name: task.name, status: 'completed', text: 'done' }))
  }))
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 4 }))
  await h.toggle('on')
  const tasks = ['a', 'b', 'c', 'd'].map((name) => ({ name, task: `Inspect independent module ${name}` }))
  const pending = h.control.tool.execute('four', { tasks }, undefined, undefined, context)
  await Promise.resolve()
  expect(run).toHaveBeenCalledTimes(4)
  expect(h.control.tool.executionMode).toBe('sequential')
  releases.reverse().forEach((release) => release())
  const result = await pending
  expect((result.details as { results: SubagentResult[] }).results.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd'])
})

it('publishes four indexed child snapshots around out-of-order settlement without changing parent contracts', async () => {
  const observer = { event: vi.fn(), running: vi.fn(), cancelling: vi.fn(), finish: vi.fn() }
  const publisher = { begin: vi.fn(() => observer), halt: vi.fn() }
  const releases: Array<(result: SubagentResult) => void> = []
  const callbacks: Array<(text: string) => void> = []
  const run = vi.fn((_task: { name: string }, _signal: AbortSignal, progress: (text: string) => void) => new Promise<SubagentResult>((resolve) => {
    callbacks.push(progress)
    releases.push(resolve)
  }))
  const h = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 4 }), publisher)
  const tasks = ['duplicate', 'duplicate', 'third', 'fourth'].map((name) => ({ name, task: 'private delegated arguments' }))
  const update = vi.fn()
  const operation = h.control.tool.execute('four', { tasks }, undefined, update, context)
  await Promise.resolve()
  const pendingSnapshot = update.mock.calls[0][0].details.subagentBatch
  expect(pendingSnapshot).toEqual({ version: 1, tasks: tasks.map((task, index) => ({ index, name: task.name, status: 'pending' })) })
  expect(run).toHaveBeenCalledTimes(4)
  const runningSnapshot = update.mock.calls.at(-1)![0].details.subagentBatch
  expect(runningSnapshot.tasks.map((task: { status: string }) => task.status)).toEqual(Array(4).fill('running'))
  const starts = update.mock.calls.slice(1, 5).map(([value]) => value.details.subagentBatch.tasks.map((task: { status: string }) => task.status))
  expect(starts).toEqual([
    ['running', 'pending', 'pending', 'pending'], ['running', 'running', 'pending', 'pending'],
    ['running', 'running', 'running', 'pending'], ['running', 'running', 'running', 'running']
  ])
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } }
  const texts = ['a'.repeat(2048), 'b'.repeat(2049), '', 'd'.repeat(3000)]
  const statuses = ['completed', 'failed', 'aborted', 'completed'] as const
  const ordered = tasks.map((task, index) => ({ name: task.name, status: statuses[index], text: texts[index], usage }))
  releases[1](ordered[1])
  await Promise.resolve()
  const firstSettled = update.mock.calls.at(-1)![0]
  expect(firstSettled.details.subagentBatch.tasks.map((task: { status: string }) => task.status)).toEqual(['running', 'failed', 'running', 'running'])
  callbacks[0]('private transient tool body')
  releases[3](ordered[3])
  await Promise.resolve()
  expect(firstSettled.details.subagentBatch.tasks[3].status).toBe('running')
  releases[2](ordered[2])
  await Promise.resolve()
  releases[0](ordered[0])
  const result = await operation
  const details = result.details as { results: SubagentResult[]; subagentBatch: SubagentBatch }
  expect(details.results).toEqual(ordered)
  expect(update.mock.calls.at(-1)![0].details.results).toEqual([ordered[1], ordered[3], ordered[2], ordered[0]])
  expect(details.subagentBatch).toEqual({ version: 1, tasks: tasks.map((task, index) => ({
    index, name: task.name, status: statuses[index], summary: texts[index].slice(0, 2048), summaryTruncated: texts[index].length > 2048
  })) })
  expect(result.content).toEqual([{ type: 'text', text: ordered.map((child) => `## ${child.name} [${child.status}]\n${child.text}`).join('\n\n') }])
  expect(result.usage).toEqual({ input: 4, output: 8, cacheRead: 12, cacheWrite: 16, totalTokens: 40,
    cost: { input: 4, output: 8, cacheRead: 12, cacheWrite: 16, total: 40 } })
  expect(JSON.stringify(details.subagentBatch)).not.toMatch(/usage|private delegated arguments|private transient tool body/)
  expect(pendingSnapshot.tasks.every((task: { status: string }) => task.status === 'pending')).toBe(true)
  expect(runningSnapshot.tasks.every((task: { status: string }) => task.status === 'running')).toBe(true)
  const snapshots = [...update.mock.calls.map(([value]) => value.details.subagentBatch), details.subagentBatch]
  expect(new Set(snapshots).size).toBe(snapshots.length)
  expect(new Set(snapshots.map((snapshot) => snapshot.tasks)).size).toBe(snapshots.length)
  expect(new Set(snapshots.map((snapshot) => snapshot.tasks[0])).size).toBe(snapshots.length)
})

it('keeps running metadata and the batch slot during cancellation until runners actually settle', async () => {
  const releases: Array<() => void> = []
  const callbacks: Array<(text: string) => void> = []
  const run = vi.fn((task: { name: string }, _signal: AbortSignal, progress: (text: string) => void) => new Promise<SubagentResult>((resolve) => {
    callbacks.push(progress)
    releases.push(() => resolve({ name: task.name, status: 'aborted', text: 'actually settled' }))
  }))
  const h = setup(run)
  const update = vi.fn()
  const controller = new AbortController()
  const tasks = [{ name: 'same', task: 'first' }, { name: 'same', task: 'second' }]
  const operation = h.control.tool.execute('cancel', { tasks }, controller.signal, update, context)
  await Promise.resolve()
  controller.abort()
  callbacks[1]('waiting for actual cleanup')
  expect(update.mock.calls.at(-1)![0].details.subagentBatch.tasks.map((task: { status: string }) => task.status)).toEqual(['running', 'running'])
  await expect(h.execute()).rejects.toThrow('批次')
  releases[1]()
  await Promise.resolve()
  expect(update.mock.calls.at(-1)![0].details.subagentBatch.tasks.map((task: { status: string }) => task.status)).toEqual(['running', 'aborted'])
  releases[0]()
  const result = await operation
  expect((result.details as { subagentBatch: SubagentBatch }).subagentBatch.tasks.map((task) => task.status)).toEqual(['aborted', 'aborted'])
})

it('does not publish fictitious child states for validation, disabled or pre-aborted invocations', async () => {
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  const update = vi.fn()
  const tasks = [{ name: 'one', task: 'inspect' }]
  const invalid = setup(run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 0 }))
  await expect(invalid.control.tool.execute('invalid', { tasks }, undefined, update, context)).rejects.toThrow()
  const h = setup(run)
  await expect(h.control.tool.execute('empty', { tasks: [] }, undefined, update, context)).rejects.toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(h.control.tool.execute('aborted', { tasks }, controller.signal, update, context)).rejects.toThrow('中止')
  await h.toggle('off')
  await expect(h.control.tool.execute('off', { tasks }, undefined, update, context)).rejects.toThrow('关闭')
  expect(run).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it('starts siblings concurrently, preserves result order and rejects overlapping batches', async () => {
  const releases: Array<() => void> = []
  const run = vi.fn((task: { name: string }) => new Promise<{ name: string; status: 'completed'; text: string }>((resolve) => {
    releases.push(() => resolve({ name: task.name, status: 'completed', text: 'done' }))
  }))
  const h = setup(run)
  await h.toggle('on')
  const pending = h.execute()
  await Promise.resolve()
  expect(run).toHaveBeenCalledTimes(2)
  await expect(h.execute()).rejects.toThrow('批次')
  releases[1](); releases[0]()
  const result = await pending
  expect((result.details as { results: SubagentResult[] }).results.map((child) => child.name)).toEqual(['one', 'two'])
})

it.each(['off', 'parent', 'shutdown', 'timeout'])('cancels children through %s', async (reason) => {
  vi.useFakeTimers()
  const run = vi.fn((task: { name: string }, signal: AbortSignal) => new Promise<{ name: string; status: 'aborted'; text: string }>((resolve) => {
    signal.addEventListener('abort', () => resolve({ name: task.name, status: 'aborted', text: 'cancelled' }), { once: true })
  }))
  const h = setup(run)
  await h.toggle('on')
  const parent = new AbortController()
  const pending = h.execute(parent.signal)
  await Promise.resolve()
  if (reason === 'off') await h.toggle('off')
  if (reason === 'parent') parent.abort()
  if (reason === 'shutdown') h.handlers.get('session_shutdown')!()
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(10 * 60_000)
  const result = await pending
  expect((result.details as { results: SubagentResult[] }).results.every((child) => child.status === 'aborted')).toBe(true)
})

it('snapshots global settings per batch and applies changed limits/thinking only to the next batch', async () => {
  let settings: SubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS, defaultThinkingLevel: 'high' }
  const release: (() => void)[] = []
  const snapshots: Readonly<SubagentSettings>[] = []
  const h = setup((task, _signal, _progress, limits) => {
    snapshots.push(limits!)
    return new Promise((resolve) => release.push(() => resolve({ name: task.name, status: 'completed', text: 'ok' })))
  }, () => settings)
  await h.toggle('on')
  const pending = h.execute()
  await Promise.resolve()
  settings.defaultThinkingLevel = 'off'
  settings = { ...settings, maxParallel: 1, maxTurns: 5 }
  expect(snapshots).toHaveLength(2)
  expect(snapshots.every((snapshot) => snapshot.defaultThinkingLevel === 'high')).toBe(true)
  expect(snapshots[0].maxTurns).toBe(24)
  expect(Object.isFrozen(snapshots[0])).toBe(true)
  release.forEach((done) => done())
  await pending
  await expect(h.execute()).rejects.toThrow('最多 1 个')
  expect(snapshots).toHaveLength(2)
  const next = h.control.tool.execute('next', { tasks: [{ name: 'next', task: 'inspect' }] }, undefined, undefined, context)
  await Promise.resolve()
  expect(snapshots[2]).toMatchObject({ defaultThinkingLevel: 'off', maxTurns: 5 })
  release.at(-1)!()
  await next
  const prompt = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(prompt.systemPrompt).toContain('1 children per batch')
  expect(prompt.systemPrompt).toContain('Configured default thinking level: "off"')
})

it('rejects overlapping calls while settings are loading and releases the batch lock on failure', async () => {
  let reject!: (error: Error) => void
  const getSettings = vi.fn<() => Promise<SubagentSettings>>().mockImplementationOnce(() => new Promise<SubagentSettings>((_resolve, fail) => { reject = fail }))
    .mockResolvedValue({ ...DEFAULT_SUBAGENT_SETTINGS })
  const h = setup(undefined, getSettings)
  await h.toggle('on')
  const pending = h.execute()
  await expect(h.execute()).rejects.toThrow('批次')
  const failed = expect(pending).rejects.toThrow('配置不可读')
  reject(new Error('配置不可读'))
  await failed
  await expect(h.execute()).resolves.toBeDefined()
})

it('uses the configured batch timeout', async () => {
  vi.useFakeTimers()
  const h = setup((task, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ name: task.name, status: 'aborted', text: 'timeout' }), { once: true })
  }), () => ({ ...DEFAULT_SUBAGENT_SETTINGS, timeoutMinutes: 1 }))
  await h.toggle('on')
  const pending = h.execute()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(((await pending).details as { results: SubagentResult[] }).results.every((child) => child.status === 'aborted')).toBe(true)
})

it('keeps controllers isolated between parent sessions and rejects invalid commands', async () => {
  const a = setup(), b = setup()
  await a.toggle('off')
  expect(a.tools()).not.toContain('pion_subagents')
  expect(b.tools()).toContain('pion_subagents')
  await b.toggle('off')
  await expect(b.execute()).rejects.toThrow('已关闭')
  await expect(a.toggle('enable')).rejects.toThrow('用法')
  await a.toggle('on')
  expect(a.tools()).toContain('pion_subagents')
})

it('captures task model selections before settings load and deep-freezes batch defaults', async () => {
  let resolve!: (settings: SubagentSettings) => void
  const defaultModel = { provider: 'default-provider', id: 'default-id' }
  const settings = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel }
  const explicit = { provider: 'other-provider', id: 'explicit-id' }
  const tasks: SubagentTask[] = [{ name: 'default', task: 'one' }, { name: 'explicit', task: 'two', model: explicit }, { name: 'parent', task: 'three', model: null }]
  const captured: SubagentTask[] = []
  const snapshots: Readonly<SubagentSettings>[] = []
  const run = vi.fn(async (task: SubagentTask, _signal: AbortSignal, _update: (text: string) => void, limits?: Readonly<SubagentSettings>) => {
    captured.push(task); snapshots.push(limits!)
    defaultModel.id = 'mutated-after-validation'
    return { name: task.name, status: 'completed' as const, text: 'summary' }
  })
  const h = setup(run, () => new Promise((done) => { resolve = done }))
  const pending = h.control.tool.execute('models', { tasks }, undefined, undefined, context)
  explicit.id = 'mutated-during-settings'
  tasks[0].model = { provider: 'late', id: 'late' }
  resolve(settings)
  const result = await pending
  expect(captured.map((task) => task.model)).toEqual([undefined, { provider: 'other-provider', id: 'explicit-id' }, null])
  expect(captured.every(Object.isFrozen)).toBe(true)
  expect(Object.isFrozen(captured[1].model)).toBe(true)
  expect(snapshots[0].defaultModel).toEqual({ provider: 'default-provider', id: 'default-id' })
  expect(snapshots.every((snapshot) => snapshot === snapshots[0] && Object.isFrozen(snapshot) && Object.isFrozen(snapshot.defaultModel))).toBe(true)
  expect(JSON.stringify(result.details)).not.toMatch(/default-provider|other-provider|explicit-id|model/)
  expect(run.mock.calls.every((call) => call.length === 4)).toBe(true)
})

it.each([false, 42, 'id', [], {}, { provider: 'x', id: '' }, { provider: 'with space', id: 'id' },
  { provider: 'x', id: 'id', api: 'chat' }, { provider: 'x', id: 'x'.repeat(257) }, { provider: 'x'.repeat(129), id: 'id' },
  { provider: 'x', id: 'control\u0001' }])('rejects invalid task model %j before publication or runner', async (model) => {
  const run = vi.fn(async (task: SubagentTask) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  const publisher = { begin: vi.fn(), halt: vi.fn() }
  const h = setup(run, undefined, publisher)
  await expect(h.control.tool.execute('invalid-model', { tasks: [
    { name: 'valid', task: 'one' }, { name: 'invalid', task: 'two', model }
  ] } as never, undefined, undefined, context)).rejects.toThrow()
  expect(publisher.begin).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it('advertises exact ID priorities and a bounded diverse partial catalog only in active build mode', async () => {
  const catalog = vi.fn(() => Array.from({ length: 100 }, (_, index) => ({ provider: 'first', id: `model-${index}` }))
    .concat([{ provider: 'second', id: 'same-id' }]))
  const h = setup(undefined, () => ({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'second', id: 'same-id' } }), undefined, catalog)
  const { systemPrompt } = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(systemPrompt).toContain('explicit task.model overrides the batch default')
  expect(systemPrompt).toContain('null explicitly uses the parent model')
  expect(systemPrompt).toContain('If the user has not explicitly specified a child model, omit task.model')
  expect(systemPrompt).toContain('never choose a model autonomously or use null to bypass the settings default')
  expect(systemPrompt).toContain('No silent fallback')
  expect(systemPrompt).toContain('cost is not authorization')
  const section = systemPrompt.match(/Available child models.*?: (\[.*?\])\./)![1]
  expect(JSON.parse(section)).toHaveLength(64)
  expect(JSON.parse(section)).toContainEqual({ provider: 'second', id: 'same-id' })
  expect(Buffer.byteLength(section)).toBeLessThan(8192)
  expect(systemPrompt).toContain('possibly partial')
  expect(systemPrompt).toContain('ask the user')
  catalog.mockClear()
  h.setPlanMode(true)
  const plan = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(plan.systemPrompt).not.toContain('Available child models')
  expect(plan.systemPrompt).not.toContain('Child model priority')
  expect(catalog).not.toHaveBeenCalled()
})
