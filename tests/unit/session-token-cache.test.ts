import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SessionTokenCache } from '../../src/main/agent/session-token-cache'
import { readSessionTokenSnapshot, type SessionTokenFileHandle, type SessionTokenFileSystem } from '../../src/main/agent/session-token-total'

const expected = { id: 'session-id', cwd: '/fixture/project' }
const path = '/fixture/session.jsonl'
const timestamp = '2026-01-01T00:00:00.000Z'
function content(total = 10, cwd = expected.cwd, id = expected.id): Buffer {
  return Buffer.from([
    { type: 'session', version: 3, ...expected, id, cwd, timestamp },
    { type: 'usage', id: 'usage-id', parentId: null, timestamp, kind: 'cache_warm', provider: 'fixture', model: 'model',
      usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}
function fixture() {
  let data = content()
  const stat = { dev: 1n, ino: 2n, size: BigInt(data.length), mtimeNs: 3n, ctimeNs: 4n, isFile: () => true }
  const reads = vi.fn()
  const handles: Array<{
    stat: ReturnType<typeof vi.fn<SessionTokenFileHandle['stat']>>
    read: ReturnType<typeof vi.fn<SessionTokenFileHandle['read']>>
    close: ReturnType<typeof vi.fn<SessionTokenFileHandle['close']>>
  }> = []
  const file = {
    stat, reads, handles,
    onOpen: undefined as ((handle: typeof handles[number]) => void) | undefined,
    rewrite(next: Buffer) { data = next; stat.size = BigInt(data.length) }
  }
  const filesystem = {
    open: vi.fn<SessionTokenFileSystem['open']>(async () => {
      const bytes = data
      let offset = 0
      const handle = {
        stat: vi.fn<SessionTokenFileHandle['stat']>(async () => ({ ...stat })),
        read: vi.fn<SessionTokenFileHandle['read']>(async buffer => {
          reads()
          const bytesRead = Math.min(buffer.length, bytes.length - offset)
          bytes.copy(buffer, 0, offset, offset + bytesRead)
          offset += bytesRead
          return { bytesRead }
        }),
        close: vi.fn<SessionTokenFileHandle['close']>(async () => {})
      }
      handles.push(handle)
      file.onOpen?.(handle)
      return handle
    }),
    lstat: vi.fn<SessionTokenFileSystem['lstat']>(async () => ({ ...stat }))
  }
  return Object.assign(file, { filesystem })
}

function setup(maxEntries = 8) {
  const file = fixture()
  return { file, cache: new SessionTokenCache({ filesystem: file.filesystem, maxEntries }) }
}

describe('validated sidebar token snapshot cache', () => {
  it('reuses an unchanged validated total after one lstat without opening or reading again', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    expect(file.filesystem.open).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    file.filesystem.open.mockClear()
    file.filesystem.lstat.mockClear()
    file.reads.mockClear()
    expect(await cache.read(path, expected)).toBe(10)
    expect(file.filesystem.lstat).toHaveBeenCalledExactlyOnceWith(path, { bigint: true })
    expect(file.filesystem.open).not.toHaveBeenCalled()
    expect(file.reads).not.toHaveBeenCalled()
  })

  it('reparses a changed stamp even when size and mtime remain unchanged', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    file.rewrite(content(20))
    file.stat.ctimeNs += 1n
    expect(await cache.read(path, expected)).toBe(20)
    expect(file.filesystem.open).toHaveBeenCalledTimes(2)
  })

  it('rejects a changed FD during a fresh read and discards the previous receipt', async () => {
    const { file, cache } = setup()
    await cache.read(path, expected)
    file.stat.ctimeNs += 1n
    file.onOpen = handle => {
      handle.stat.mockResolvedValueOnce({ ...file.stat }).mockResolvedValueOnce({ ...file.stat, ino: 99n })
    }
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(file.handles[1].close).toHaveBeenCalledOnce()
    file.onOpen = undefined
    file.stat.ctimeNs -= 1n
    expect(await cache.read(path, expected)).toBe(10)
    expect(file.filesystem.open).toHaveBeenCalledTimes(3)
  })

  it.each(['id', 'cwd'] as const)('checks the actual header %s after a file change', async field => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    file.rewrite(content(10, field === 'cwd' ? '/fixture/another' : expected.cwd,
      field === 'id' ? 'another-id' : expected.id))
    file.stat.ctimeNs += 1n
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(file.handles[1].close).toHaveBeenCalledOnce()
  })

  it('keys by exact path/header ID/cwd and keeps different cache owners independent', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    expect(await cache.read(path, { ...expected, cwd: '/other/project' })).toBeUndefined()
    expect(await cache.read(path, { ...expected, id: 'other-id' })).toBeUndefined()
    expect(await cache.read('/fixture/alias.jsonl', expected)).toBe(10)
    expect(await cache.read(path, { ...expected, cwd: '/fixture/project/.' })).toBe(10)
    const other = new SessionTokenCache({ filesystem: file.filesystem })
    expect(await other.read(path, expected)).toBe(10)
    expect(file.filesystem.open).toHaveBeenCalledTimes(6)
  })

  it('keeps snapshot receipts scoped to their filesystem instance', async () => {
    const first = fixture(), second = fixture()
    const previous = await readSessionTokenSnapshot(path, expected, { filesystem: first.filesystem })
    second.rewrite(content(20))
    expect((await readSessionTokenSnapshot(path, expected, { filesystem: second.filesystem, previous })).total).toBe(20)
    expect(second.filesystem.open).toHaveBeenCalledOnce()
  })

  it('captures caller ownership before asynchronous cache admission', async () => {
    const { cache } = setup()
    const mutable = { ...expected }
    const pending = cache.read(path, mutable)
    mutable.id = 'other-id'
    mutable.cwd = '/other/project'
    expect(await pending).toBe(10)
    expect(await cache.read(path, mutable)).toBeUndefined()
  })

  it('does not turn unknown reads into zero or preserve a stale successful total after failure', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    file.stat.ctimeNs += 1n
    file.onOpen = handle => { handle.read.mockRejectedValueOnce(new Error('read failed')) }
    expect(await cache.read(path, expected)).toBeUndefined()
    file.onOpen = undefined
    file.stat.ctimeNs -= 1n
    expect(await cache.read(path, expected)).toBe(10)
    expect(file.handles[2].read).toHaveBeenCalledTimes(2)
    file.rewrite(Buffer.from('{broken}\n'))
    expect(await cache.read(path, expected)).toBeUndefined()
    file.rewrite(content(0))
    expect(await cache.read(path, expected)).toBe(0)
  })

  it('keeps lookup/open failures and non-files unknown and permits later reads', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    file.stat.ctimeNs += 1n
    file.filesystem.open.mockRejectedValueOnce(new Error('no-follow refused'))
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(await cache.read(path, expected)).toBe(10)
    file.filesystem.lstat.mockResolvedValueOnce({ ...file.stat, isFile: () => false })
    expect(await cache.read(path, expected)).toBeUndefined()
    file.filesystem.lstat.mockRejectedValueOnce(new Error('lookup failed'))
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(await cache.read(path, expected)).toBe(10)
  })

  it('keeps a cancelled caller, singleflight and capacity held through actual reading and close', async () => {
    const { file, cache } = setup(1)
    const reading = deferred(), releaseRead = deferred(), closing = deferred(), releaseClose = deferred()
    file.onOpen = handle => {
      const read = handle.read.getMockImplementation()!
      handle.read.mockImplementationOnce(async (...args) => { reading.resolve(); await releaseRead.promise; return read(...args) })
      handle.close.mockImplementation(async () => { closing.resolve(); await releaseClose.promise })
    }
    const controller = new AbortController()
    let settled = false
    const cancelled = cache.read(path, expected, { signal: controller.signal }).then(total => { settled = true; return total })
    await reading.promise
    const shared = cache.read(path, expected)
    controller.abort()
    expect(await cache.read('/fixture/other.jsonl', expected)).toBeUndefined()
    expect(file.filesystem.open).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    releaseRead.resolve()
    await closing.promise
    expect(settled).toBe(false)
    expect(await cache.read('/fixture/other.jsonl', expected)).toBeUndefined()
    releaseClose.resolve()
    expect(await cancelled).toBeUndefined()
    expect(await shared).toBe(10)
    file.onOpen = undefined
    expect(await cache.read('/fixture/other.jsonl', expected)).toBe(10)
    expect(file.filesystem.open).toHaveBeenCalledTimes(2)
  })

  it('admits one actual path reader across competing identities until its rejected close settles', async () => {
    const { file, cache } = setup(2)
    const closing = deferred(), release = deferred()
    file.onOpen = handle => {
      handle.close.mockImplementation(async () => {
        closing.resolve()
        await release.promise
        throw new Error('unknown close')
      })
    }
    const first = cache.read(path, expected)
    await closing.promise
    const shared = cache.read(path, expected)
    const otherOwner = cache.read(path, { ...expected, id: 'other-id' })
    await Promise.resolve()
    expect(file.filesystem.open).toHaveBeenCalledOnce()
    release.resolve()
    expect(await Promise.all([first, shared, otherOwner])).toEqual([undefined, undefined, undefined])
    file.onOpen = undefined
    expect(await cache.read(path, expected)).toBe(10)
    expect(await cache.read('/fixture/another.jsonl', expected)).toBe(10)
    expect(file.filesystem.open).toHaveBeenCalledTimes(3)
  })

  it('performs no I/O for a caller already cancelled before admission', async () => {
    const { file, cache } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await cache.read(path, expected, { signal: controller.signal })).toBeUndefined()
    expect(file.filesystem.open).not.toHaveBeenCalled()
  })

  it('evicts only settled least-recently-used entries at the fixed capacity', async () => {
    const { file, cache } = setup(2)
    await cache.read(path, expected)
    await cache.read('/fixture/second.jsonl', expected)
    await cache.read(path, expected)
    await cache.read('/fixture/third.jsonl', expected)
    await cache.read('/fixture/second.jsonl', expected)
    expect(file.filesystem.open.mock.calls.map(([opened]) => opened)).toEqual([
      path, '/fixture/second.jsonl', '/fixture/third.jsonl', '/fixture/second.jsonl'
    ])
  })
})
