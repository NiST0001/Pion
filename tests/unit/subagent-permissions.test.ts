import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

// Exercise the emitted gate functions, not a second implementation of policy.
function gate() {
  const source = readFileSync('src/main/tool-permissions.ts', 'utf8')
  const code = source.slice(source.indexOf('async function checkpointGate'), source.indexOf('export default function (pi)'))
  return new Function('scope', `const { CHECKPOINT_READ_ONLY, PION_INTERNAL_TOOLS, CHECKPOINT_MARKER, CHECKPOINT_TIMEOUT, MARKER, TIMEOUT, classify, readPolicy, canonical, sessionAllows } = scope; ${code}; return gate;`)({
    CHECKPOINT_READ_ONLY: new Set(['read']), PION_INTERNAL_TOOLS: new Set(['pion_subagents']),
    CHECKPOINT_MARKER: 'checkpoint', CHECKPOINT_TIMEOUT: 1000, MARKER: 'permission:', TIMEOUT: 1000,
    classify: () => ({ policyCategories: ['write'], category: 'write', risks: [], toolName: 'write', summary: 'write', detail: 'a.ts' }),
    readPolicy: () => ({ write: 'ask' }), canonical: (cwd: string) => cwd, sessionAllows: new Set()
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

it('does not checkpoint the dispatcher itself before any child writes', async () => {
  const select = vi.fn()
  expect(await gate()({ toolName: 'pion_subagents', input: {} }, { hasUI: true, ui: { select } })).toBeUndefined()
  expect(select).not.toHaveBeenCalled()
})
