import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsManager, type AgentSession, type AgentSessionEvent, type ModelRuntime, type SessionEntry, type ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createSubagentControl, createSubagentRunner } from '../../src/main/agent/subagents'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'
import type { SubagentSessionObserver } from '../../src/main/agent/subagent-session-observer'

const mocks = vi.hoisted(() => ({ create: vi.fn(), loader: vi.fn(), reload: vi.fn() }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...await original<typeof import('@earendil-works/pi-coding-agent')>(),
  createAgentSession: mocks.create,
  DefaultResourceLoader: class {
    constructor(options: unknown) { mocks.loader(options) }
    async reload() { await mocks.reload() }
  }
}))
beforeEach(() => { vi.clearAllMocks(); mocks.reload.mockReset() })

function setup(block = false, cacheWarming: 'off' | 'streaming' | 'idle' = 'off', models = {} as ModelRuntime) {
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
  return { run: createSubagentRunner(() => parent, () => models, '/project', '/agent'), execute, before, after, dispose, active, parent }
}

it('uses the parent model, only inherited built-ins and live permission hooks', async () => {
  const h = setup()
  await h.run({ name: 'worker', task: 'edit' }, new AbortController().signal, () => {})
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: 'fixture', id: 'fixture' }, tools: ['write'] }))
  expect(mocks.create.mock.calls[0][0].sessionManager.getSessionFile()).toBeUndefined()
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

function displayObserver(): SubagentSessionObserver {
  return { event: vi.fn(), running: vi.fn(), cancelling: vi.fn(), finish: vi.fn() }
}

it('subscribes before prompt and finishes the private display only after actual shutdown and disposal', async () => {
  const h = setup()
  const observer = displayObserver()
  let notify!: (event: AgentSessionEvent) => void
  let release!: () => void
  const dispose = vi.fn(() => expect(observer.finish).not.toHaveBeenCalled())
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [], getLastAssistantText: () => 'summary', dispose,
    subscribe: (listener: typeof notify) => { notify = listener; return () => {} },
    prompt: async () => { expect(notify).toBeTypeOf('function'); notify({ type: 'turn_start' }) },
    abort: () => new Promise<void>((resolve) => { release = resolve })
  } }))
  const pending = h.run({ name: 'worker', task: 'inspect' }, new AbortController().signal, () => {}, DEFAULT_SUBAGENT_SETTINGS, observer)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(observer.event).toHaveBeenCalledWith({ type: 'turn_start' })
  expect(observer.finish).not.toHaveBeenCalled()
  release()
  await pending
  expect(dispose).toHaveBeenCalledOnce()
  expect(observer.finish).toHaveBeenCalledWith('completed')
})

it.each(['missing-model', 'loader/create-failure'] as const)('records a failed accepted child on %s', async (failure) => {
  const h = setup()
  const observer = displayObserver()
  if (failure === 'missing-model') Object.assign(h.parent, { model: undefined })
  else mocks.create.mockRejectedValueOnce(new Error('provider setup failed'))
  await expect(h.run({ name: 'worker', task: 'inspect' }, new AbortController().signal, () => {}, DEFAULT_SUBAGENT_SETTINGS, observer)).rejects.toThrow()
  expect(observer.finish).toHaveBeenCalledWith('failed')
  expect(observer.event).not.toHaveBeenCalled()
})

it('does not turn a settled abort into terminal state while the actual prompt is still pending', async () => {
  const h = setup()
  const observer = displayObserver()
  const controller = new AbortController()
  let release!: () => void
  const abort = vi.fn(async () => {})
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [], getLastAssistantText: () => '', dispose: h.dispose,
    subscribe: () => () => {}, abort,
    prompt: () => new Promise<void>((resolve) => { release = resolve })
  } }))
  const pending = h.run({ name: 'worker', task: 'inspect' }, controller.signal, () => {}, DEFAULT_SUBAGENT_SETTINGS, observer)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  controller.abort()
  await Promise.resolve()
  expect(abort).toHaveBeenCalledOnce()
  expect(observer.cancelling).toHaveBeenCalled()
  expect(observer.finish).not.toHaveBeenCalled()
  expect(h.dispose).not.toHaveBeenCalled()
  release()
  await pending
  expect(h.dispose).toHaveBeenCalledOnce()
  expect(observer.finish).toHaveBeenCalledWith('aborted')
})

it('abort rejection keeps display cancelling without falsely starting terminal retention', async () => {
  const h = setup()
  const observer = displayObserver()
  const controller = new AbortController()
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [], getLastAssistantText: () => '', dispose: h.dispose,
    subscribe: () => () => {},
    prompt: async () => { controller.abort() },
    abort: async () => { throw new Error('abort not settled') }
  } }))
  const result = await h.run({ name: 'worker', task: 'inspect' }, controller.signal, () => {}, DEFAULT_SUBAGENT_SETTINGS, observer)
  expect(result.status).toBe('aborted')
  expect(observer.cancelling).toHaveBeenCalled()
  expect(observer.finish).not.toHaveBeenCalled()
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

function modelRuntimeFixture() {
  // Same ID across providers is intentional: neither API type nor display name
  // may collapse the exact provider+ID identity.
  const models = [{ provider: 'provider-a', id: 'same-id', api: 'shared-api', name: 'Same display' },
    { provider: 'provider-b', id: 'same-id', api: 'shared-api', name: 'Same display' }]
  const getModel = vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id))
  const getAvailableSnapshot = vi.fn(() => models)
  const getAuth = vi.fn(() => { throw new Error('must not look up credentials') })
  const runtime = { getModel, getAvailableSnapshot, getAuth } as unknown as ModelRuntime
  return { models, runtime, getModel, getAvailableSnapshot, getAuth }
}

it.each(['default', 'override', 'parent-null', 'legacy'] as const)('resolves %s model without changing parent model or runtime', async (mode) => {
  const fixture = modelRuntimeFixture()
  const h = setup(false, 'off', fixture.runtime)
  const original = h.parent.model
  const settings = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'provider-a', id: 'same-id' } }
  const task = { name: 'worker', task: 'inspect', ...(mode === 'override' ? { model: { provider: 'provider-b', id: 'same-id' } }
    : mode === 'parent-null' ? { model: null } : {}) }
  await h.run(task, new AbortController().signal, () => {}, mode === 'legacy' ? DEFAULT_SUBAGENT_SETTINGS : settings)
  const options = mocks.create.mock.calls[0][0]
  expect(options.model).toBe(mode === 'default' ? fixture.models[0] : mode === 'override' ? fixture.models[1] : original)
  expect(options.modelRuntime).toBe(fixture.runtime)
  expect(options.thinkingLevel).toBe(h.parent.thinkingLevel)
  expect(h.parent.model).toBe(original)
  expect(h.parent.messages).toEqual([])
  if (mode === 'legacy' || mode === 'parent-null') {
    expect(fixture.getModel).not.toHaveBeenCalled()
    expect(fixture.getAvailableSnapshot).not.toHaveBeenCalled()
  } else expect(fixture.getModel).toHaveBeenCalledWith(mode === 'default' ? 'provider-a' : 'provider-b', 'same-id')
  expect(fixture.getAuth).not.toHaveBeenCalled()
})

it('captures selected model and its existing runtime before asynchronous loader work', async () => {
  const fixture = modelRuntimeFixture()
  const h = setup()
  let activeRuntime = fixture.runtime
  const getModels = vi.fn(() => activeRuntime)
  const run = createSubagentRunner(() => h.parent, getModels, '/project', '/agent')
  let release!: () => void
  mocks.reload.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
  const selection = { provider: 'provider-b', id: 'same-id' }
  const pending = run({ name: 'worker', task: 'inspect', model: selection }, new AbortController().signal, () => {})
  selection.provider = 'provider-a'
  activeRuntime = {} as ModelRuntime
  Object.assign(h.parent, { model: { provider: 'changed-parent', id: 'later' } })
  release()
  await pending
  expect(getModels).toHaveBeenCalledOnce()
  expect(mocks.create.mock.calls[0][0].model).toBe(fixture.models[1])
  expect(mocks.create.mock.calls[0][0].modelRuntime).toBe(fixture.runtime)
})

it.each(['unknown', 'unavailable', 'missing-snapshot', 'missing-getModel', 'api-confusion', 'display-confusion'] as const)(
  'fails %s explicit selection before creating/loading a child without fallback', async (reason) => {
    const fixture = modelRuntimeFixture()
    if (reason === 'unavailable') fixture.getAvailableSnapshot.mockReturnValue([])
    if (reason === 'missing-snapshot') Object.assign(fixture.runtime, { getAvailableSnapshot: undefined })
    if (reason === 'missing-getModel') Object.assign(fixture.runtime, { getModel: undefined })
    const h = setup(false, 'off', fixture.runtime)
    const selection = { provider: reason === 'api-confusion' ? 'shared-api' : 'provider-a',
      id: reason === 'unknown' ? 'unknown' : reason === 'display-confusion' ? 'Same display' : 'same-id' }
    await expect(h.run({ name: 'worker', task: 'inspect', model: selection }, new AbortController().signal, () => {})).rejects.toThrow(reason === 'display-confusion' ? 'provider/id 无效' : '未启动')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.loader).not.toHaveBeenCalled()
    expect(fixture.getAuth).not.toHaveBeenCalled()
    expect(h.parent.model).toEqual({ provider: 'fixture', id: 'fixture' })
  })

it('accounts actual selected-child usage without charging parent context or altering model', async () => {
  const fixture = modelRuntimeFixture()
  const h = setup(false, 'off', fixture.runtime)
  let notify!: (event: AgentSessionEvent) => void
  const assistant = { role: 'assistant' as const, content: [], api: 'anthropic-messages' as const,
    provider: 'provider-b', model: 'same-id', usage: unitUsage(), stopReason: 'stop' as const, timestamp: 1 }
  mocks.create.mockImplementationOnce(async () => ({ session: {
    agent: {}, messages: [assistant], abort: async () => {}, dispose: h.dispose,
    subscribe: (listener: typeof notify) => { notify = listener; return () => {} }, getLastAssistantText: () => 'done',
    prompt: async () => { notify({ type: 'message_end', message: assistant }) }
  } }))
  const result = await h.run({ name: 'worker', task: 'inspect', model: { provider: 'provider-b', id: 'same-id' } }, new AbortController().signal, () => {})
  expect(result.usage).toEqual(unitUsage())
  expect(h.parent.messages).toEqual([])
  expect(h.parent.model).toEqual({ provider: 'fixture', id: 'fixture' })
})

it('an unknown catalog model fails only its child while a legal sibling still runs', async () => {
  const fixture = modelRuntimeFixture()
  const h = setup(false, 'off', fixture.runtime)
  const control = createSubagentControl(h.run, () => ({ ...DEFAULT_SUBAGENT_SETTINGS }))
  const result = await control.tool.execute('mixed-models', { tasks: [
    { name: 'unknown', task: 'inspect', model: { provider: 'provider-a', id: 'missing' } },
    { name: 'known', task: 'inspect', model: { provider: 'provider-b', id: 'same-id' } }
  ] }, undefined, undefined, {} as ExtensionToolContext)
  expect((result.details as { results: { name: string; status: string }[] }).results.map(({ name, status }) => [name, status]))
    .toEqual([['unknown', 'failed'], ['known', 'completed']])
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(mocks.create.mock.calls[0][0].model).toBe(fixture.models[1])
  expect(h.parent.model).toEqual({ provider: 'fixture', id: 'fixture' })
})
