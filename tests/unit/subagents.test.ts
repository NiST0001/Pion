import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createSubagentControl, type SubagentResult } from '../../src/main/agent/subagents'

import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from '../../src/shared/subagents'

const context = {} as ExtensionContext
afterEach(() => vi.useRealTimers())
function setup(run: Parameters<typeof createSubagentControl>[0] = async (task) => ({ name: task.name, status: 'completed', text: 'done' }),
  getSettings: () => SubagentSettings | Promise<SubagentSettings> = () => ({ ...DEFAULT_SUBAGENT_SETTINGS })) {
  const control = createSubagentControl(run, getSettings)
  const handlers = new Map<string, (...args: any[]) => any>()
  const commands = new Map<string, { handler: (args: string, ctx: { isIdle: () => boolean }) => Promise<void> }>()
  let tools = ['read', 'bash', 'pion_subagents']
  const appendEntry = vi.fn()
  control.extension({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: { isIdle: () => boolean }) => Promise<void> }) => commands.set(name, command),
    getActiveTools: () => tools,
    setActiveTools: (names: string[]) => { tools = names }, appendEntry
  } as unknown as ExtensionAPI)
  handlers.get('session_start')!()
  return { control, handlers, appendEntry, tools: () => tools,
    toggle: (value: string) => commands.get('pion-subagents')!.handler(value, { isIdle: () => true }),
    execute: (signal?: AbortSignal) => control.tool.execute('batch', { tasks: [{ name: 'one', task: 'inspect' }, { name: 'two', task: 'edit another file' }] }, signal, undefined, context)
  }
}

it('defaults off and gates execution even if a stale tool list advertises delegation', async () => {
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  const h = setup(run)
  expect(h.tools()).not.toContain('pion_subagents')
  await expect(h.execute()).rejects.toThrow('已关闭')
  expect(run).not.toHaveBeenCalled()
  await h.toggle('on')
  expect(h.tools()).toContain('pion_subagents')
  await h.execute()
  await h.toggle('off')
  expect(h.tools()).not.toContain('pion_subagents')
  expect(h.appendEntry).toHaveBeenLastCalledWith('pion-subagents-state', { enabled: false })
})

it('injects proactive delegation only while enabled and preserves the original prompt', async () => {
  const run = vi.fn(async (task: { name: string }) => ({ name: task.name, status: 'completed' as const, text: 'done' }))
  const h = setup(run)
  const prompt = () => h.handlers.get('before_agent_start')!({ systemPrompt: 'Project: no tests without approval.' })
  expect((await prompt()).systemPrompt).toContain('Pion subagents: OFF.')
  await h.toggle('on')
  const on = (await prompt()).systemPrompt
  expect(on).toMatch(/^Project: no tests without approval\./)
  expect(on).toContain('The user has enabled proactive delegation')
  expect(on).toContain('use pion_subagents early')
  expect(on).toContain('without waiting for the user')
  expect(on).toContain('disjoint file ownership')
  expect(on).toContain('Handle trivial tasks, tightly dependent work, or conflicting edits directly')
  expect(on).toContain('not approval for otherwise restricted actions')
  // Opt-in guides the model; opening the switch does not itself start children.
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

it('snapshots global settings per batch and applies changed limits only to the next batch', async () => {
  let settings = { ...DEFAULT_SUBAGENT_SETTINGS }
  const release: (() => void)[] = []
  const snapshots: Readonly<SubagentSettings>[] = []
  const h = setup((task, _signal, _progress, limits) => {
    snapshots.push(limits!)
    return new Promise((resolve) => release.push(() => resolve({ name: task.name, status: 'completed', text: 'ok' })))
  }, () => settings)
  await h.toggle('on')
  const pending = h.execute()
  await Promise.resolve()
  settings = { ...settings, maxParallel: 1, maxTurns: 5 }
  expect(snapshots).toHaveLength(2)
  expect(snapshots[0].maxTurns).toBe(24)
  expect(Object.isFrozen(snapshots[0])).toBe(true)
  release.forEach((done) => done())
  await pending
  await expect(h.execute()).rejects.toThrow('最多 1 个')
  expect(snapshots).toHaveLength(2)
  const prompt = await h.handlers.get('before_agent_start')!({ systemPrompt: 'base' })
  expect(prompt.systemPrompt).toContain('1 children per batch')
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
  await a.toggle('on')
  expect(b.tools()).not.toContain('pion_subagents')
  await expect(b.execute()).rejects.toThrow('已关闭')
  await expect(a.toggle('enable')).rejects.toThrow('用法')
  expect(a.tools()).toContain('pion_subagents')
})
