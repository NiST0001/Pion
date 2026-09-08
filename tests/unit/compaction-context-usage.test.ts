import { expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import type { RunOperation } from '../../src/shared/operations'

function setup(active = false) {
  const run = { id: 'run-a', contextTokens: 90_000, contextPressure: 0.9, contextWindow: 100_000,
    compactions: [], usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 90_100, cost: 1 } } as unknown as RunOperation
  const store = { list: vi.fn(() => [run]), update: vi.fn((_id: string, mutate: (run: RunOperation) => void) => { mutate(run); return run }) }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { runStore: store }) as {
    trackBackendEvent(backend: BackendRecord, event: unknown, type: string): void
  }
  const backend = { cwd: '/a', sessionPath: '/a/session.jsonl', activeRunId: active ? run.id : undefined } as BackendRecord
  return { run, store, backend, event: (event: unknown, type = 'compaction_end') => bridge.trackBackendEvent(backend, event, type) }
}

it('invalidates pre-compaction context for a settled session without clearing cumulative usage', () => {
  const { run, store, event } = setup()
  const usage = run.usage
  event({ reason: 'manual', aborted: false })
  expect(store.list).toHaveBeenCalledWith({ cwd: '/a', sessionPath: '/a/session.jsonl', limit: 1 })
  expect(run.contextTokens).toBeUndefined()
  expect(run.contextPressure).toBeUndefined()
  expect(run.contextUsagePending).toBe(true)
  expect(run.usage).toBe(usage)
})

it('retains prior context when compaction fails or is aborted', () => {
  const { run, event } = setup(true)
  event({ reason: 'manual', aborted: true })
  expect(run.contextPressure).toBe(0.9)
  event({ reason: 'manual', errorMessage: 'failed' })
  expect(run.contextTokens).toBe(90_000)
})

it('waits for nonzero fresh usage after automatic compaction', () => {
  const { run, event } = setup(true)
  event({ reason: 'threshold', aborted: false })
  event({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 'message_update')
  expect(run.contextUsagePending).toBe(true)
  event({ usage: { input: 10_000, output: 1, cacheRead: 5000, cacheWrite: 0 } }, 'message_update')
  expect(run.contextTokens).toBe(15_000)
  expect(run.contextPressure).toBe(0.15)
  expect(run.contextUsagePending).toBe(false)
})
