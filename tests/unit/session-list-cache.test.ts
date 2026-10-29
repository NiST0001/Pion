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

async function flushBackground() {
  for (let i = 0; i < 32; i++) await Promise.resolve()
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

describe('session sidebar background token totals', () => {
  it('returns slim rows while tokens are pending and leaves all four SDK slots available', async () => {
    const scans = Array.from({ length: 6 }, () => deferred<SessionMeta[]>())
    const tokens = deferred<number | undefined>()
    let started = 0
    const load = vi.fn(() => scans[started++].promise)
    const read = vi.fn(() => tokens.promise)
    const publish = vi.fn()
    const cache = new SessionListCache(load, Date.now, 1500, 64, { read, capturePublish: () => publish })
    const lists = scans.map((_, index) => cache.list(`/tmp/project-${index}`))
    expect(started).toBe(4)
    for (let i = 0; i < 4; i++) scans[i].resolve([row(`session-${i}`)])
    expect(await Promise.all(lists.slice(0, 4))).toEqual(Array.from({ length: 4 }, (_, i) => [row(`session-${i}`)]))
    expect(started).toBe(6)
    for (let i = 4; i < 6; i++) scans[i].resolve([row(`session-${i}`)])
    expect(await Promise.all(lists.slice(4))).toEqual([[row('session-4')], [row('session-5')]])
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(4)
    expect(publish).not.toHaveBeenCalled()
    tokens.resolve(17)
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(6)
    expect(publish).toHaveBeenCalledTimes(6)
    expect(await cache.list('/tmp/project-5')).toEqual([{ ...row('session-5'), totalTokens: 17 }])
    expect(load).toHaveBeenCalledTimes(6)
  })

  it('bounds each directory to four readers and all directories to four actual batches', async () => {
    const pending: Array<{ cwd: string; task: ReturnType<typeof deferred<number | undefined>> }> = []
    const read = vi.fn((_session: SessionMeta, cwd: string) => {
      const task = deferred<number | undefined>()
      pending.push({ cwd, task })
      return task.promise
    })
    const cache = new SessionListCache(async () => Array.from({ length: 5 }, (_, index) => row(`session-${index}`)), Date.now, 1500, 64, {
      read, capturePublish: () => undefined
    })
    await Promise.all(Array.from({ length: 5 }, (_, index) => cache.list(`/tmp/project-${index}`)))
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(16)
    for (let i = 0; i < 4; i++) expect(pending.filter(({ cwd }) => cwd === `/tmp/project-${i}`)).toHaveLength(4)
    expect(pending.some(({ cwd }) => cwd === '/tmp/project-4')).toBe(false)
    pending[0].task.resolve(1)
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(17) // same directory's fifth row, not a fifth directory
    expect(pending[16].cwd).toBe('/tmp/project-0')
    pending[16].task.resolve(1)
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(17) // three siblings still own the batch
    for (let i = 1; i < 4; i++) pending[i].task.resolve(1)
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(21)
    expect(pending.slice(17).every(({ cwd }) => cwd === '/tmp/project-4')).toBe(true)
    // Drain subsequent fifth-row workers as well as all original siblings.
    for (let i = 0; i < 5; i++) {
      for (const { task } of pending) task.resolve(1)
      await flushBackground()
    }
    expect(read).toHaveBeenCalledTimes(25)
  })

  it.each(['hard', 'soft', 'ttl'] as const)('rejects old totals after %s invalidation or a newer scan starts', async (kind) => {
    let now = 0
    const scan = deferred<SessionMeta[]>()
    const oldTokens = deferred<number | undefined>()
    const freshTokens = deferred<number | undefined>()
    const load = vi.fn().mockResolvedValueOnce([row('old')]).mockImplementationOnce(() => scan.promise)
    const read = vi.fn().mockImplementationOnce(() => oldTokens.promise).mockImplementationOnce(() => freshTokens.promise)
    const publish = vi.fn()
    const cache = new SessionListCache(load, () => now, 10, 64, { read, capturePublish: () => publish })
    expect(await cache.list('/tmp/project')).toEqual([row('old')])
    if (kind === 'ttl') now = 11
    else cache.invalidate('/tmp/project', kind === 'soft' ? { soft: true } : undefined)
    const latest = cache.list('/tmp/project')
    oldTokens.resolve(999)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    scan.resolve([row('fresh')])
    expect(await latest).toEqual([row('fresh')])
    await flushBackground()
    freshTokens.resolve(7)
    await flushBackground()
    expect(publish).toHaveBeenCalledExactlyOnceWith([{ ...row('fresh'), totalTokens: 7 }])
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('fresh'), totalTokens: 7 }])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('rejects an old token source even when the newer TTL scan fails without replacing cached rows', async () => {
    let now = 0
    const tokens = deferred<number | undefined>()
    const load = vi.fn().mockResolvedValueOnce([row('old')]).mockRejectedValueOnce(new Error('SDK failed')).mockResolvedValueOnce([row('fresh')])
    const read = vi.fn().mockImplementationOnce(() => tokens.promise).mockResolvedValue(undefined)
    const publish = vi.fn()
    const cache = new SessionListCache(load, () => now, 10, 64, { read, capturePublish: () => publish })
    await cache.list('/tmp/project')
    now = 11
    await expect(cache.list('/tmp/project')).rejects.toThrow('SDK failed')
    tokens.resolve(999)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(await cache.list('/tmp/project')).toEqual([row('fresh')])
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(2)
    expect(publish).not.toHaveBeenCalled()
  })

  it.each(['hard', 'soft'] as const)('does not publish an invalidated batch even without a replacement %s scan', async (kind) => {
    const tokens = deferred<number | undefined>()
    const load = vi.fn().mockResolvedValueOnce([row('old')]).mockResolvedValueOnce([row('fresh')])
    const read = vi.fn().mockImplementationOnce(() => tokens.promise).mockResolvedValue(undefined)
    const publish = vi.fn()
    const cache = new SessionListCache(load, Date.now, 1500, 64, { read, capturePublish: () => publish })
    await cache.list('/tmp/project')
    cache.invalidate('/tmp/project', kind === 'soft' ? { soft: true } : undefined)
    tokens.resolve(999)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(await cache.list('/tmp/project')).toEqual([row('fresh')])
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
  })

  it('coalesces same-cwd scans to the newest source until the old actual reader settles', async () => {
    const oldTokens = deferred<number | undefined>()
    const newestTokens = deferred<number | undefined>()
    let scan = 0
    const load = vi.fn(async () => [row(`scan-${++scan}`)])
    const read = vi.fn().mockImplementationOnce(() => oldTokens.promise).mockImplementationOnce(() => newestTokens.promise)
    const publish = vi.fn()
    const cache = new SessionListCache(load, Date.now, 1500, 64, { read, capturePublish: () => publish })
    await cache.list('/tmp/project')
    await cache.list('/tmp/project/.')
    cache.invalidate('/tmp/project', { soft: true })
    expect(await cache.list('/tmp/project')).toEqual([row('scan-2')])
    cache.invalidate('/tmp/project')
    expect(await cache.list('/tmp/project')).toEqual([row('scan-3')])
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(3)
    oldTokens.resolve(999)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]).toEqual([row('scan-3'), '/tmp/project'])
    newestTokens.resolve(3)
    await flushBackground()
    expect(publish).toHaveBeenCalledExactlyOnceWith([{ ...row('scan-3'), totalTokens: 3 }])
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('scan-3'), totalTokens: 3 }])
    expect(read).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('keeps actual token-pending cwd entries within the capacity bound until real settlement', async () => {
    const aTokens = deferred<number | undefined>()
    const bTokens = deferred<number | undefined>()
    const load = vi.fn(async (cwd: string) => [row(cwd)])
    const read = vi.fn((_session: SessionMeta, cwd: string) => cwd === '/tmp/a' ? aTokens.promise : bTokens.promise)
    const cache = new SessionListCache(load, Date.now, 1500, 2, { read, capturePublish: () => undefined })
    await cache.list('/tmp/a')
    await cache.list('/tmp/b')
    cache.invalidate('/tmp/a')
    await expect(cache.list('/tmp/c')).rejects.toThrow('cache is busy')
    expect(load).toHaveBeenCalledTimes(2)
    aTokens.resolve(undefined)
    await flushBackground()
    expect(await cache.list('/tmp/c')).toEqual([row('/tmp/c')])
    expect(load).toHaveBeenCalledTimes(3)
    // The still-live b entry was not evicted just because a became evictable.
    expect(await cache.list('/tmp/b')).toEqual([row('/tmp/b')])
    expect(load).toHaveBeenCalledTimes(3)
    bTokens.resolve(undefined)
    await flushBackground()
  })

  it('preserves the default 64-cwd cap across real token work and queued SDK scans', async () => {
    const tokens = deferred<number | undefined>()
    const scans = deferred<SessionMeta[]>()
    const load = vi.fn(async (cwd: string) => cwd.startsWith('/tmp/token-') ? [row(cwd)] : scans.promise)
    const cache = new SessionListCache(load, undefined, undefined, undefined, {
      read: () => tokens.promise, capturePublish: () => undefined
    })
    await Promise.all(Array.from({ length: 4 }, (_, i) => cache.list(`/tmp/token-${i}`)))
    const lists = Array.from({ length: 60 }, (_, i) => cache.list(`/tmp/scan-${i}`))
    await expect(cache.list('/tmp/overflow')).rejects.toThrow('cache is busy')
    expect(load).toHaveBeenCalledTimes(8) // four token-owning rows plus four real SDK scans
    tokens.resolve(undefined)
    await flushBackground()
    const replacement = cache.list('/tmp/replacement')
    scans.resolve([])
    await Promise.all([...lists, replacement])
    expect(load).toHaveBeenCalledTimes(65)
  })

  it('stops unstarted row readers when their source expires but waits for all started readers', async () => {
    const tokens = deferred<number | undefined>()
    const read = vi.fn(() => tokens.promise)
    const publish = vi.fn()
    const cache = new SessionListCache(async () => Array.from({ length: 6 }, (_, i) => row(`row-${i}`)), Date.now, 1500, 64, {
      read, capturePublish: () => publish
    })
    await cache.list('/tmp/project')
    expect(read).toHaveBeenCalledTimes(4)
    cache.invalidate('/tmp/project', { soft: true })
    tokens.resolve(9)
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(4)
    expect(publish).not.toHaveBeenCalled()
  })

  it('never reads expired queued sources and coalesces a queued cwd before taking a directory slot', async () => {
    const blockers = deferred<number | undefined>()
    let queuedScans = 0
    const load = vi.fn(async (cwd: string) => [row(cwd === '/tmp/queued' ? `queued-${++queuedScans}` : cwd)])
    const read = vi.fn((session: SessionMeta) => session.id.startsWith('/tmp/blocker') ? blockers.promise : Promise.resolve(5))
    const publish = vi.fn()
    const cache = new SessionListCache(load, Date.now, 1500, 64, { read, capturePublish: () => publish })
    await Promise.all(Array.from({ length: 4 }, (_, i) => cache.list(`/tmp/blocker-${i}`)))
    await cache.list('/tmp/queued')
    cache.invalidate('/tmp/queued')
    await cache.list('/tmp/queued')
    await cache.list('/tmp/expired')
    cache.invalidate('/tmp/expired', { soft: true })
    expect(read).toHaveBeenCalledTimes(4)
    blockers.resolve(1)
    await flushBackground()
    expect(read.mock.calls.map(([session]) => session.id)).toEqual([
      '/tmp/blocker-0', '/tmp/blocker-1', '/tmp/blocker-2', '/tmp/blocker-3', 'queued-2'
    ])
    expect(publish).toHaveBeenCalledTimes(5)
    expect(await cache.list('/tmp/queued')).toEqual([{ ...row('queued-2'), totalTokens: 5 }])
  })

  it('evicts only queued idle cwd sources and never reads their old entry identity', async () => {
    const blockers = deferred<number | undefined>()
    const load = vi.fn(async (cwd: string) => [row(cwd)])
    const read = vi.fn((session: SessionMeta) => session.id.startsWith('/tmp/blocker') ? blockers.promise : Promise.resolve(5))
    const cache = new SessionListCache(load, Date.now, 1500, 5, { read, capturePublish: () => undefined })
    await Promise.all(Array.from({ length: 4 }, (_, i) => cache.list(`/tmp/blocker-${i}`)))
    await cache.list('/tmp/evicted')
    await cache.list('/tmp/replacement')
    expect(load).toHaveBeenCalledTimes(6)
    blockers.resolve(1)
    await flushBackground()
    expect(read.mock.calls.some(([session]) => session.id === '/tmp/evicted')).toBe(false)
    expect(read.mock.calls.some(([session]) => session.id === '/tmp/replacement')).toBe(true)
  })

  it('clones SDK rows, reader inputs, caller results and published enriched rows independently', async () => {
    const tokens = deferred<number | undefined>()
    const source = [row('own')]
    const read = vi.fn((session: SessionMeta) => {
      session.name = 'reader mutation'
      return tokens.promise
    })
    const publish = vi.fn((sessions: SessionMeta[]) => {
      sessions[0].preview = 'publisher mutation'
      sessions[0].totalTokens = 999
      sessions.push(row('publisher-extra'))
    })
    const cache = new SessionListCache(async () => source, Date.now, 1500, 64, { read, capturePublish: () => publish })
    const first = await cache.list('/tmp/project')
    first[0].name = 'caller mutation'
    first.push(row('caller-extra'))
    source[0].preview = 'SDK mutation'
    tokens.resolve(9)
    await flushBackground()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('own'), totalTokens: 9 }])
    const cached = await cache.list('/tmp/project')
    cached[0].totalTokens = 888
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('own'), totalTokens: 9 }])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not release a batch on unknown/rejected rows while a started sibling is actually pending', async () => {
    const sibling = deferred<number | undefined>()
    const sessions = ['reject', 'pending', 'unknown', 'throw', 'last'].map(row)
    const load = vi.fn(async (cwd: string) => cwd === '/tmp/project' ? sessions : [])
    const read = vi.fn((session: SessionMeta) => {
      if (session.id === 'reject') return Promise.reject(new Error('unreadable'))
      if (session.id === 'throw') throw new Error('synchronous failure')
      if (session.id === 'pending') return sibling.promise
      return Promise.resolve(undefined)
    })
    const publish = vi.fn()
    const cache = new SessionListCache(load, Date.now, 1500, 1, { read, capturePublish: () => publish })
    expect(await cache.list('/tmp/project')).toEqual(sessions)
    await flushBackground()
    expect(read).toHaveBeenCalledTimes(5)
    expect(publish).not.toHaveBeenCalled()
    await expect(cache.list('/tmp/other')).rejects.toThrow('cache is busy')
    sibling.resolve(undefined)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(await cache.list('/tmp/project')).toEqual(sessions)
    expect(read).toHaveBeenCalledTimes(5) // no unconditional retry for all-unknown totals
    expect(await cache.list('/tmp/other')).toEqual([])
  })

  it('publishes known totals including zero but never fills unknown rows with zero', async () => {
    const sessions = ['zero', 'unknown', 'reject'].map(row)
    const read = vi.fn(async (session: SessionMeta) => {
      if (session.id === 'reject') throw new Error('unreadable')
      return session.id === 'zero' ? 0 : undefined
    })
    const publish = vi.fn()
    const cache = new SessionListCache(async () => sessions, Date.now, 1500, 64, { read, capturePublish: () => publish })
    expect(await cache.list('/tmp/project')).toEqual(sessions)
    await flushBackground()
    const expected = [{ ...row('zero'), totalTokens: 0 }, row('unknown'), row('reject')]
    expect(publish).toHaveBeenCalledExactlyOnceWith(expected)
    expect(await cache.list('/tmp/project')).toEqual(expected)
  })

  it('uses the latest per-list publish receipt even for a cache hit while totals remain pending', async () => {
    const tokens = deferred<number | undefined>()
    const firstPublish = vi.fn()
    const secondPublish = vi.fn()
    let currentPublish = firstPublish
    const capturePublish = vi.fn(() => currentPublish)
    const read = vi.fn(() => tokens.promise)
    const cache = new SessionListCache(async () => [row('own')], Date.now, 1500, 64, { read, capturePublish })
    await cache.list('/tmp/project')
    currentPublish = secondPublish
    await cache.list('/tmp/project/.')
    tokens.resolve(12)
    await flushBackground()
    expect(firstPublish).not.toHaveBeenCalled()
    expect(secondPublish).toHaveBeenCalledExactlyOnceWith([{ ...row('own'), totalTokens: 12 }])
    expect(capturePublish.mock.calls).toEqual([['/tmp/project'], ['/tmp/project']])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('clears an earlier publish receipt when the latest legitimate caller has no publisher', async () => {
    const tokens = deferred<number | undefined>()
    const publish = vi.fn()
    let currentPublish: ((sessions: SessionMeta[]) => void) | undefined = publish
    const cache = new SessionListCache(async () => [row('own')], Date.now, 1500, 64, {
      read: () => tokens.promise, capturePublish: () => currentPublish
    })
    await cache.list('/tmp/project')
    currentPublish = undefined
    await cache.list('/tmp/project')
    tokens.resolve(12)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('own'), totalTokens: 12 }])
  })

  it('does not send old totals to a replacement window that has never read that cwd', async () => {
    const tokens = deferred<number | undefined>()
    let currentWindow = 1
    const publish = vi.fn()
    const capturePublish = vi.fn(() => {
      const capturedWindow = currentWindow
      return (sessions: SessionMeta[]) => {
        if (currentWindow === capturedWindow) publish(currentWindow, sessions)
      }
    })
    const cache = new SessionListCache(async () => [row('own')], Date.now, 1500, 64, {
      read: () => tokens.promise, capturePublish
    })
    await cache.list('/tmp/project')
    currentWindow = 2
    tokens.resolve(12)
    await flushBackground()
    expect(publish).not.toHaveBeenCalled()
    expect(capturePublish).toHaveBeenCalledTimes(1)
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('own'), totalTokens: 12 }])
    expect(capturePublish).toHaveBeenCalledTimes(2)
  })

  it('keeps successful cached totals when a publisher throws without rejecting background work', async () => {
    const publish = vi.fn(() => { throw new Error('window closed') })
    const cache = new SessionListCache(async () => [row('own')], Date.now, 1500, 64, {
      read: async () => 4, capturePublish: () => publish
    })
    expect(await cache.list('/tmp/project')).toEqual([row('own')])
    await flushBackground()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await cache.list('/tmp/project')).toEqual([{ ...row('own'), totalTokens: 4 }])
  })
})
