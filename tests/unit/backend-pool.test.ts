import { describe, expect, it } from 'vitest'
import { BackendPool } from '../../src/main/agent/backend-pool'
import type { BackendRecord } from '../../src/main/agent/types'

function backend(key: string, overrides: Partial<BackendRecord> = {}): BackendRecord {
  return {
    key,
    cwd: `/tmp/${key}`,
    client: {} as BackendRecord['client'],
    phase: 'running',
    busy: false,
    compacting: false,
    pendingRunIds: [],
    startPromise: Promise.resolve(),
    ...overrides
  }
}

describe('BackendPool', () => {
  it('does not evict a backend while completion listeners are still running', async () => {
    const pool = new BackendPool()
    const completion = new Promise<void>(() => undefined)
    for (let index = 0; index < 10; index += 1) {
      pool.add(backend(`backend-${index}`, index === 0
        ? { runCompletionPromise: completion }
        : undefined))
    }

    const evicted: string[] = []
    await pool.startWithLimit(
      'backend-new',
      async () => backend('backend-new'),
      () => false,
      async (key) => {
        evicted.push(key)
        pool.delete(key)
      }
    )

    expect(evicted).toEqual(['backend-1'])
    expect(pool.get('backend-0')).toBeDefined()
  })
})
