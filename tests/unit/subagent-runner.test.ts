import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
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

function setup(block = false) {
  const execute = vi.fn(async (_id: string, ..._args: unknown[]) => ({ content: [{ type: 'text', text: 'ok' }], details: {} }))
  const before = vi.fn(async () => block ? { block: true, reason: 'denied' } : undefined)
  const after = vi.fn(async () => undefined)
  const dispose = vi.fn()
  const active = ['write', 'pion_subagents', 'pion_ask_user', 'plugin_tool']
  const parent = {
    model: { provider: 'fixture', id: 'fixture' }, thinkingLevel: 'off', messages: [],
    settingsManager: { getCompactionSettings: () => ({ enabled: true }), getRetrySettings: () => ({ enabled: false }) },
    agent: { state: { systemPrompt: 'Inherited project rules', tools: active.map((name) => ({ name, label: name, description: name, parameters: {}, execute })) }, beforeToolCall: before, afterToolCall: after },
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
  return { run: createSubagentRunner(() => parent, () => ({} as ModelRuntime), '/project', '/agent'), execute, before, after, dispose, active }
}

it('uses the parent model, only inherited built-ins and live permission hooks', async () => {
  const h = setup()
  await h.run({ name: 'worker', task: 'edit' }, new AbortController().signal, () => {})
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: 'fixture', id: 'fixture' }, tools: ['write'] }))
  expect(mocks.loader).toHaveBeenCalledWith(expect.objectContaining({ noExtensions: true, noSkills: true, noPromptTemplates: true }))
  expect(h.before).toHaveBeenCalledOnce()
  expect(h.after).toHaveBeenCalledOnce()
  expect(h.execute).toHaveBeenCalledOnce()
  expect(h.execute.mock.calls[0][0]).toMatch(/^subagent-.*-call-1$/)
  expect(h.dispose).toHaveBeenCalledOnce()
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
