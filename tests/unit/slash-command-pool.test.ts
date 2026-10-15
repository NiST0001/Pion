import { describe, expect, it, vi } from 'vitest'
import type { BackendRecord } from '../../src/main/agent/types'
import { BackendPool } from '../../src/main/agent/backend-pool'
import { MAX_RETAINED_BACKENDS } from '../../src/main/agent/constants'

// Pool bookkeeping only: no backend, filesystem, SDK process or model is started.
function fill(pool: BackendPool): BackendRecord[] {
  return Array.from({ length: MAX_RETAINED_BACKENDS }, (_, index) => {
    const backend = { key: `backend-${index}`, busy: false, phase: 'running',
      pendingRunIds: [] } as unknown as BackendRecord
    pool.add(backend)
    return backend
  })
}

describe('slash-command export pool ownership', () => {
  it('does not evict the oldest backend while its actual export is pending', async () => {
    const pool = new BackendPool()
    const backends = fill(pool)
    backends[0].sessionExportPending = true
    const stop = vi.fn(async (key: string) => { pool.delete(key) })
    await pool.evictOldest(undefined, stop)
    expect(stop).toHaveBeenCalledExactlyOnceWith('backend-1')
    expect(pool.get('backend-0')).toBe(backends[0])
    expect(backends[0].historyMutation).toBeUndefined()
  })

  it('refuses eviction when every backend has a real pending export', async () => {
    const pool = new BackendPool()
    for (const backend of fill(pool)) backend.sessionExportPending = true
    const stop = vi.fn(async (_key: string) => {})
    await expect(pool.evictOldest(undefined, stop)).rejects.toThrow('后台运行会话已达上限')
    expect(stop).not.toHaveBeenCalled()
  })

  it('makes an idle backend eligible after the public export operation actually settles', async () => {
    const pool = new BackendPool()
    const backends = fill(pool)
    backends[0].sessionExportPending = true
    backends[0].sessionExportPending = false
    const stop = vi.fn(async (key: string) => { pool.delete(key) })
    await pool.evictOldest(undefined, stop)
    expect(stop).toHaveBeenCalledExactlyOnceWith('backend-0')
  })
})
