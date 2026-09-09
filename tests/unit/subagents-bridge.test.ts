import { expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import { applyBackendEvent } from '../../src/main/agent/backend-events'

function setup() {
  const backend = { key: 'a', startPromise: Promise.resolve(), client: {
    getState: vi.fn(async () => ({ sessionId: 'a' })),
    getCommands: vi.fn(async () => [{ name: 'pion-subagents' }]),
    prompt: vi.fn(async () => {})
  } } as unknown as BackendRecord
  const push = vi.fn(async () => {})
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: 'a', win: { webContents: { id: 1 } }, desiredModes: new Map(),
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
  vi.mocked(h.backend.client.prompt).mockImplementation(async () => { Object.assign(h.bridge, { activeKey: 'b' }) })
  await h.bridge.setSubagentsMode(true, 'a', 1)
  expect(h.backend.subagentsEnabled).toBe(true)
  expect(h.push).not.toHaveBeenCalled()
})

it('mirrors direct command state events into their own backend', () => {
  const h = setup()
  applyBackendEvent(h.backend, { type: 'entry_appended', entry: { type: 'custom', customType: 'pion-subagents-state', data: { enabled: true } } }, new Map())
  expect(h.backend.subagentsEnabled).toBe(true)
})

it('adds child billing only once without changing parent context usage', () => {
  const run = { tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: 0 }, contextTokens: 123, contextPressure: .5 }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    runStore: { update: (_id: string, update: (value: typeof run) => void) => update(run) }
  }) as { trackBackendEvent: (backend: BackendRecord, event: unknown, type: string) => void }
  const event = { toolCallId: 'batch', toolName: 'pion_subagents', isError: false,
    result: { usage: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: .2 } } } }
  const backend = { activeRunId: 'run' } as BackendRecord
  bridge.trackBackendEvent(backend, event, 'tool_execution_end')
  bridge.trackBackendEvent(backend, event, 'tool_execution_end')
  expect(run.usage.total).toBe(12)
  expect(run.usage.costUsd).toBe(.2)
  expect(run.contextTokens).toBe(123)
  expect(run.contextPressure).toBe(.5)
})
