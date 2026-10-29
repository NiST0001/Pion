import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

// Exercise the emitted gate functions, not a second implementation of policy.
function gate(readPolicy = () => ({ write: 'ask' })) {
  const source = readFileSync('src/main/tool-permissions.ts', 'utf8')
  const code = source.slice(source.indexOf('async function checkpointGate'), source.indexOf('export default function (pi)'))
  return new Function('scope', `const { CHECKPOINT_READ_ONLY, PION_INTERNAL_TOOLS, CHECKPOINT_MARKER, CHECKPOINT_TIMEOUT, COMPUTER_USE_OBSERVE_TOOL, COMPUTER_USE_ACT_TOOL, MARKER, TIMEOUT, classify, readPolicy, canonical, sessionAllows } = scope; ${code}; return gate;`)({
    CHECKPOINT_READ_ONLY: new Set(['read']), PION_INTERNAL_TOOLS: new Set(['pion_subagents']),
    CHECKPOINT_MARKER: 'checkpoint', CHECKPOINT_TIMEOUT: 1000, COMPUTER_USE_OBSERVE_TOOL: 'pion_computer_observe', COMPUTER_USE_ACT_TOOL: 'pion_computer_act',
    MARKER: 'permission:', TIMEOUT: 1000,
    classify: () => ({ policyCategories: ['write'], category: 'write', risks: [], toolName: 'write', summary: 'write', detail: 'a.ts' }),
    readPolicy, canonical: (cwd: string) => cwd, sessionAllows: new Set()
  }) as (event: unknown, ctx: unknown) => Promise<{ block: boolean } | undefined>
}

it.each(['checkpoint', 'permission'])('aborts a child waiting for %s without granting permission', async (stage) => {
  const controller = new AbortController()
  const input = { path: 'a.ts' }
  Object.defineProperty(input, Symbol.for('pion.subagent.abort'), { value: controller.signal })
  const select = vi.fn(async (title: string, _options: string[], options: { signal: AbortSignal }) => {
    if (stage === 'permission' && title === 'checkpoint') return 'ready'
    expect(options.signal).toBe(controller.signal)
    return new Promise<undefined>((resolve) => controller.signal.addEventListener('abort', () => resolve(undefined), { once: true }))
  })
  const pending = gate()({ toolName: 'write', toolCallId: 'subagent-test-call', input }, {
    cwd: '/project', hasUI: true, ui: { select }, sessionManager: { getSessionFile: () => '/session' }
  })
  await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(stage === 'checkpoint' ? 1 : 2))
  controller.abort()
  expect(await pending).toMatchObject({ block: true })
})

it.each(['checkpoint', 'permission'])('rejects a new deny while a child waits for %s without repeating its approval', async (stage) => {
  const controller = new AbortController()
  const input = { path: 'a.ts' }
  Object.defineProperty(input, Symbol.for('pion.subagent.abort'), { value: controller.signal })
  let decision = 'ask'
  let approve!: () => void
  const select = vi.fn(async (title: string) => {
    if (stage === 'permission' && title === 'checkpoint') return 'ready'
    return new Promise<string>((resolve) => { approve = () => resolve(title === 'checkpoint' ? 'ready' : 'allow-once') })
  })
  const pending = gate(() => ({ write: decision }))({ toolName: 'write', toolCallId: 'subagent-test-call', input }, {
    cwd: '/project', hasUI: true, ui: { select }, sessionManager: { getSessionFile: () => '/session' }
  })
  await vi.waitFor(() => expect(approve).toBeTypeOf('function'))
  decision = 'deny'
  approve()
  expect(await pending).toMatchObject({ block: true })
  expect(select).toHaveBeenCalledTimes(stage === 'checkpoint' ? 1 : 2)
})

it('does not checkpoint the dispatcher itself before any child writes', async () => {
  const select = vi.fn()
  expect(await gate()({ toolName: 'pion_subagents', input: {} }, { hasUI: true, ui: { select } })).toBeUndefined()
  expect(select).not.toHaveBeenCalled()
})
