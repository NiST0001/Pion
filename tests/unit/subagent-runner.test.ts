import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsManager, type AgentSession, type AgentSessionEvent, type ModelRuntime, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { createSubagentRunner } from '../../src/main/agent/subagents'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'

const mocks = vi.hoisted(() => ({ create: vi.fn(), loader: vi.fn() }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...await original<typeof import('@earendil-works/pi-coding-agent')>(),
  createAgentSession: mocks.create,
  DefaultResourceLoader: class {
    constructor(options: unknown) { mocks.loader(options) }
    async reload() {}
  }
}))
beforeEach(() => vi.clearAllMocks())

function setup(block = false, cacheWarming: 'off' | 'streaming' | 'idle' = 'off') {
  const execute = vi.fn(async (_id: string, ..._args: unknown[]) => ({ content: [{ type: 'text', text: 'ok' }], details: {} }))
  const before = vi.fn(async () => block ? { block: true, reason: 'denied' } : undefined)
  const after = vi.fn(async () => undefined)
  const dispose = vi.fn()
  const active = ['write', 'pion_subagents', 'pion_ask_user', 'plugin_tool']
  const parent = {
    model: { provider: 'fixture', id: 'fixture' }, thinkingLevel: 'off', messages: [],
    systemPrompt: 'Inherited project rules',
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false }, cacheWarming }),
    agent: { state: { systemPrompt: '', tools: active.map((name) => ({ name, label: name, description: name, parameters: {}, execute })) }, beforeToolCall: before, afterToolCall: after },
    getActiveToolNames: () => active,
    getAllTools: () => active.map((name) => ({ name, sourceInfo: { source: name === 'write' ? 'builtin' : 'extension' } }))
  } as unknown as AgentSession
  mocks.create.mockImplementation(async (options) => {
    const session = {
      agent: {} as AgentSession['agent'],
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      subscribe: () => () => {}, abort: vi.fn(async () => {}), dispose,
      getLastAssistantText: () => 'child result',
      prompt: async () => {
        const context = { toolCall: { type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }, args: { path: 'a.ts', content: 'test' } } as Parameters<NonNullable<AgentSession['agent']['beforeToolCall']>>[0]
        const decision = await session.agent.beforeToolCall!(context)
        if (decision?.block) return
        const result = await options.customTools[0].execute('call-1', context.args, undefined, undefined)
        await session.agent.afterToolCall!({ ...context, result, isError: false } as Parameters<NonNullable<AgentSession['agent']['afterToolCall']>>[0])
      }
    }
    return { session }
  })
  return { run: createSubagentRunner(() => parent, () => ({} as ModelRuntime), '/project', '/agent'), execute, before, after, dispose, active, parent }
}

it('uses the parent model, only inherited built-ins and live permission hooks', async () => {
  const h = setup()
  await h.run({ name: 'worker', task: 'edit' }, new AbortController().signal, () => {})
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: 'fixture', id: 'fixture' }, tools: ['write'] }))
  expect(mocks.loader).toHaveBeenCalledWith(expect.objectContaining({ noExtensions: true, noSkills: true, noPromptTemplates: true }))
  const prompt = mocks.loader.mock.calls[0][0].systemPromptOverride()
  expect(prompt).toMatch(/^Inherited project rules\n/)
  expect(prompt).toContain('bounded Pion child agent (worker)')
  expect(h.parent.agent.state.systemPrompt).toBe('')
  expect(h.before).toHaveBeenCalledOnce()
  expect(h.after).toHaveBeenCalledOnce()
  expect(h.execute).toHaveBeenCalledOnce()
  expect(h.execute.mock.calls[0][0]).toMatch(/^subagent-.*-call-1$/)
  expect(h.dispose).toHaveBeenCalledOnce()
})

it.each(['off', 'streaming', 'idle'] as const)('inherits the complete SDK cache-warming mode %s without changing the parent', async (mode) => {
  const h = setup(false, mode)
  const save = vi.spyOn(h.parent.settingsManager, 'setCacheWarmingMode')
  await h.run({ name: 'worker', task: 'inspect' }, new AbortController().signal, () => {})
  const childSettings = mocks.create.mock.calls[0][0].settingsManager as SettingsManager
  expect(childSettings).not.toBe(h.parent.settingsManager)
  expect(childSettings.getCacheWarmingMode()).toBe(mode)
  expect(h.parent.settingsManager.getCacheWarmingMode()).toBe(mode)
  expect(save).not.toHaveBeenCalled()
})

it('does not execute a child tool when the parent denies it', async () => {
  const h = setup(true)
  await h.run({ name: 'worker', task: 'edit' }, new AbortController().signal, () => {})
  expect(h.before).toHaveBeenCalledOnce()
  expect(h.execute).not.toHaveBeenCalled()
})

it('does not create a model request after cancellation during setup', async () => {
  const h = setup()
  const controller = new AbortController()
  controller.abort()
  await expect(h.run({ name: 'worker', task: 'edit' }, controller.signal, () => {})).rejects.toThrow('中止')
  expect(mocks.create).not.toHaveBeenCalled()
})

it('honors the snapshotted turn and result-length limits', async () => {
  const h = setup()
  let notify!: (event: { type: 'turn_start' }) => void
  const abort = vi.fn(async () => {})
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [{ role: 'assistant', stopReason: 'stop' }], abort, dispose: h.dispose,
    subscribe: (listener: typeof notify) => { notify = listener; return () => {} },
    getLastAssistantText: () => 'x'.repeat(2000),
    prompt: async () => { for (let n = 0; n < 3; n++) notify({ type: 'turn_start' }) }
  } }))
  const result = await h.run({ name: 'worker', task: 'inspect' }, new AbortController().signal, () => {},
    { ...DEFAULT_SUBAGENT_SETTINGS, maxTurns: 2, maxResultChars: 1000 })
  expect(result.status).toBe('aborted')
  expect(result.text).toContain('轮数上限')
  expect(result.text).toContain('[结果已截断]')
  expect(result.text.match(/x/g)).toHaveLength(1000)
  expect(abort).toHaveBeenCalled()
})

const unitUsage = () => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } })
const usageEntry = (id: string, kind = 'cache_warm'): SessionEntry => ({
  type: 'usage', id, parentId: null, timestamp: '2026-09-22T00:00:00.000Z',
  kind, provider: 'fixture', model: 'fixture', usage: unitUsage()
})

it.each(['completed', 'aborted', 'failed'] as const)('includes independent usage once and shutdown usage on %s', async (status) => {
  const h = setup()
  const controller = new AbortController()
  let notify!: (event: AgentSessionEvent) => void
  let shutdownUsageSent = false
  const unsubscribe = vi.fn()
  const assistant = { role: 'assistant' as const, content: [], api: 'anthropic-messages' as const,
    provider: 'fixture', model: 'fixture', usage: unitUsage(), stopReason: 'stop' as const, timestamp: 1 }
  const toolResult = { role: 'toolResult' as const, toolCallId: 'child-tool', toolName: 'read',
    content: [], isError: false, timestamp: 2, usage: unitUsage() }
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [assistant], dispose: h.dispose,
    subscribe: (listener: typeof notify) => { notify = listener; return unsubscribe },
    getLastAssistantText: () => 'done',
    abort: async () => {
      expect(unsubscribe).not.toHaveBeenCalled()
      if (!shutdownUsageSent) {
        shutdownUsageSent = true
        notify({ type: 'entry_appended', entry: usageEntry('shutdown') })
      }
    },
    prompt: async () => {
      notify({ type: 'message_end', message: assistant })
      notify({ type: 'message_end', message: toolResult })
      // Persisted message mirrors must not add their usage for a second time.
      for (const message of [assistant, toolResult]) notify({ type: 'entry_appended', entry: {
        type: 'message', id: message.role, parentId: null, timestamp: '2026-09-22T00:00:00.000Z', message
      } })
      notify({ type: 'entry_appended', entry: usageEntry('warm') })
      notify({ type: 'entry_appended', entry: usageEntry('warm') })
      notify({ type: 'entry_appended', entry: usageEntry('other', 'future_usage_kind') })
      if (status === 'aborted') controller.abort()
      if (status === 'failed') throw new Error('fixture failure')
    }
  } }))
  const result = await h.run({ name: 'worker', task: 'inspect' }, controller.signal, () => {})
  expect(result.status).toBe(status)
  expect(result.usage).toEqual({ input: 5, output: 10, cacheRead: 15, cacheWrite: 20, totalTokens: 50,
    cost: { input: 5, output: 10, cacheRead: 15, cacheWrite: 20, total: 50 } })
  expect(h.parent.messages).toEqual([])
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(h.dispose).toHaveBeenCalledOnce()
})

it('bounds the independent usage-entry dedupe window', async () => {
  const h = setup()
  let notify!: (event: AgentSessionEvent) => void
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [], abort: async () => {}, dispose: h.dispose,
    subscribe: (listener: typeof notify) => { notify = listener; return () => {} },
    getLastAssistantText: () => 'done',
    prompt: async () => {
      for (let n = 0; n < 4097; n++) notify({ type: 'entry_appended', entry: usageEntry(String(n)) })
      notify({ type: 'entry_appended', entry: usageEntry('4096') })
      // The oldest ID is evicted, rather than growing memory without a bound.
      notify({ type: 'entry_appended', entry: usageEntry('0') })
    }
  } }))
  const result = await h.run({ name: 'worker', task: 'inspect' }, new AbortController().signal, () => {})
  expect(result.usage?.totalTokens).toBe(4098 * 10)
})

it('namespaces child tool IDs and serializes sibling writes', async () => {
  const h = setup()
  let release!: () => void
  h.execute.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ content: [{ type: 'text', text: 'ok' }], details: {} }) }))
  const a = h.run({ name: 'a', task: 'edit a' }, new AbortController().signal, () => {})
  const b = h.run({ name: 'b', task: 'edit b' }, new AbortController().signal, () => {})
  await vi.waitFor(() => expect(h.before).toHaveBeenCalledTimes(2))
  expect(h.execute).toHaveBeenCalledTimes(1)
  release()
  await Promise.all([a, b])
  expect(h.execute).toHaveBeenCalledTimes(2)
  expect(h.execute.mock.calls[0][0]).not.toBe(h.execute.mock.calls[1][0])
})
