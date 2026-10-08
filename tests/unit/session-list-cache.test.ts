import { describe, expect, it, vi } from 'vitest'
import { SessionListCache } from '../../src/main/agent/session-list-cache'
import type { SessionMeta } from '../../src/shared/types'

const row = (id: string): SessionMeta => ({ path: `/tmp/${id}.jsonl`, id, timestamp: '', mtime: 0, preview: id, messageCount: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

describe('session sidebar discovery cache', () => {
  it('deduplicates in-flight scans and copies slim rows for every caller', async () => {
    const pending = deferred<SessionMeta[]>()
    const load = vi.fn(() => pending.promise)
    const cache = new SessionListCache(load)
    const first = cache.list('/tmp/project')
    const second = cache.list('/tmp/project/.')
    expect(load).toHaveBeenCalledTimes(1)
    pending.resolve([row('own')])
    const [a, b] = await Promise.all([first, second])
    a[0].name = 'caller mutation'
    expect(b[0].name).toBeUndefined()
    expect((await cache.list('/tmp/project'))[0].name).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect deleted files when an old scan resolves after invalidation', async () => {
    const pending = deferred<SessionMeta[]>()
    const load = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue([])
    const cache = new SessionListCache(load)
    const first = cache.list('/tmp/project')
    cache.invalidate('/tmp/project')
    const second = cache.list('/tmp/project')
    pending.resolve([row('deleted')])
    expect(await first).toEqual([])
    expect(await second).toEqual([])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('returns under continuous soft invalidation after at most one reread and leaves TTL expired', async () => {
    const scans = [deferred<SessionMeta[]>(), deferred<SessionMeta[]>()]
    const load = vi.fn().mockImplementationOnce(() => scans[0].promise)
      .mockImplementationOnce(() => scans[1].promise).mockResolvedValue([row('fresh')])
    const cache = new SessionListCache(load)
    const first = cache.list('/tmp/project')
    cache.invalidate('/tmp/project', { soft: true })
    scans[0].resolve([row('first')])
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 20; i++) cache.invalidate('/tmp/project', { soft: true })
    scans[1].resolve([row('usable')])
    expect(await first).toEqual([row('usable')])
    expect(load).toHaveBeenCalledTimes(2)
    expect(await cache.list('/tmp/project')).toEqual([row('fresh')])
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('rereads a pre-persistence empty scan and does not cache its soft-dirty result as fresh', async () => {
    const pending = deferred<SessionMeta[]>()
    const load = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue([row('persisted')])
    const cache = new SessionListCache(load)
    const first = cache.list('/tmp/project')
    cache.invalidate('/tmp/project', { soft: true })
    const publication = cache.list('/tmp/project')
    pending.resolve([])
    expect(await first).toEqual([row('persisted')])
    expect(await publication).toEqual([row('persisted')])
    expect(load).toHaveBeenCalledTimes(2)
    await cache.list('/tmp/project')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('soft-invalidates an existing result without reusing its TTL', async () => {
    const load = vi.fn().mockResolvedValueOnce([row('old')]).mockResolvedValueOnce([row('new')])
    const cache = new SessionListCache(load)
    await cache.list('/tmp/project')
    cache.invalidate('/tmp/project', { soft: true })
    expect(await cache.list('/tmp/project')).toEqual([row('new')])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('rejects repeated hard mutations after three retries without publishing old rows', async () => {
    let cache!: SessionListCache
    const load = vi.fn(async () => {
      cache.invalidate('/tmp/project')
      return [row('deleted')]
    })
    cache = new SessionListCache(load)
    await expect(cache.list('/tmp/project')).rejects.toThrow('changed repeatedly')
    expect(load).toHaveBeenCalledTimes(4)
    load.mockImplementation(async () => [])
    expect(await cache.list('/tmp/project')).toEqual([])
  })

  it('keeps a hard upper bound even when every cwd slot is pending', async () => {
    const pending = deferred<SessionMeta[]>()
    const load = vi.fn(() => pending.promise)
    const cache = new SessionListCache(load, Date.now, 1500, 2)
    const a = cache.list('/tmp/a')
    const b = cache.list('/tmp/b')
    await expect(cache.list('/tmp/c')).rejects.toThrow('cache is busy')
    expect(load).toHaveBeenCalledTimes(2)
    pending.resolve([])
    await Promise.all([a, b])
    expect(await cache.list('/tmp/c')).toEqual([])
  })

  it('expires and bounds settled cwd entries while keeping exact cwd isolated', async () => {
    let now = 0
    const load = vi.fn(async (cwd: string) => [row(cwd)])
    const cache = new SessionListCache(load, () => now, 10, 2)
    await cache.list('/tmp/a-b')
    await cache.list('/tmp/a/b')
    cache.invalidate('/tmp/a-b')
    await cache.list('/tmp/a/b')
    expect(load).toHaveBeenCalledTimes(2)
    await cache.list('/tmp/a-b')
    expect(load).toHaveBeenCalledTimes(3)
    now = 11
    await cache.list('/tmp/a/b')
    await cache.list('/tmp/third')
    await cache.list('/tmp/a-b')
    expect(load).toHaveBeenCalledTimes(6)
  })

  it('rejects failed discovery without claiming an empty or stale list was freshly loaded', async () => {
    const load = vi.fn().mockResolvedValueOnce([row('old')]).mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce([])
    const cache = new SessionListCache(load)
    await cache.list('/tmp/project')
    cache.invalidate('/tmp/project')
    await expect(cache.list('/tmp/project')).rejects.toThrow('read failed')
    expect(await cache.list('/tmp/project')).toEqual([])
  })

  it('limits real SDK discoveries to four even across many worktrees', async () => {
    const pending = Array.from({ length: 6 }, () => deferred<SessionMeta[]>())
    let started = 0
    const load = vi.fn(() => pending[started++].promise)
    const cache = new SessionListCache(load)
    const lists = pending.map((_, index) => cache.list(`/tmp/project-${index}`))
    expect(started).toBe(4)
    pending[0].resolve([])
    await lists[0]
    expect(started).toBe(5)
    pending[1].resolve([])
    await lists[1]
    expect(started).toBe(6)
    for (const item of pending) item.resolve([])
    await Promise.all(lists)
  })
})
