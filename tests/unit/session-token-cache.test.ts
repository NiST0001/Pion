import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SessionTokenCache } from '../../src/main/agent/session-token-cache'
import {
  readSessionTokenSnapshot, type SessionTokenFileHandle, type SessionTokenFileSystem
} from '../../src/main/agent/session-token-total'

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
  it('reopens with no-follow and checks both FD/path snapshots, without reading unchanged JSONL again', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    expect(await cache.read(path, expected)).toBe(10)
    expect(file.reads).toHaveBeenCalledTimes(2)
    expect(file.filesystem.open).toHaveBeenCalledTimes(2)
    for (const call of file.filesystem.open.mock.calls) {
      expect(call).toEqual([path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK])
    }
    expect(file.filesystem.lstat).toHaveBeenCalledTimes(4)
    for (const handle of file.handles) {
      expect(handle.stat).toHaveBeenCalledTimes(2)
      expect(handle.close).toHaveBeenCalledOnce()
    }
  })

  it.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)('reparses when %s changes, even with the old mtime otherwise preserved', async field => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    const total = field === 'size' ? 120 : 20
    file.rewrite(content(total))
    if (field !== 'size') file.stat[field] += 1n
    expect(await cache.read(path, expected)).toBe(total)
    expect(file.reads).toHaveBeenCalledTimes(4)
  })

  it.each(['fd', 'path-before', 'path-after'])('rejects a replacement during a fast-path %s check', async phase => {
    const { file, cache } = setup()
    await cache.read(path, expected)
    const replaced = { ...file.stat, ino: 99n }
    if (phase === 'fd') file.onOpen = handle => {
      handle.stat.mockResolvedValueOnce({ ...file.stat }).mockResolvedValueOnce(replaced)
    }
    else if (phase === 'path-before') file.filesystem.lstat.mockResolvedValueOnce(replaced)
    else file.filesystem.lstat.mockResolvedValueOnce({ ...file.stat }).mockResolvedValueOnce(replaced)
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(file.handles[1].close).toHaveBeenCalledOnce()
    file.onOpen = undefined
    expect(await cache.read(path, expected)).toBe(10)
    // A failed verification discards the prior receipt, even if the old stamp returns.
    expect(file.reads).toHaveBeenCalledTimes(4)
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
    expect(file.handles.map(handle => handle.read.mock.calls.length)).toEqual([2, 1, 1, 2, 2, 2])
  })

  it('accepts only an actual immutable receipt from the same exact identity', async () => {
    const { file } = setup()
    const options = { filesystem: file.filesystem }
    const receipt = await readSessionTokenSnapshot(path, expected, { ...options, previous: { total: 999 } })
    expect(receipt.total).toBe(10)
    expect(Object.isFrozen(receipt)).toBe(true)
    await expect(readSessionTokenSnapshot(path, { ...expected, cwd: '/other/project' }, { ...options, previous: receipt }))
      .rejects.toMatchObject({ closeUnknown: false })
    expect((await readSessionTokenSnapshot('/fixture/alias.jsonl', expected, { ...options, previous: receipt })).total).toBe(10)
    expect((await readSessionTokenSnapshot(path, expected, { filesystem: { ...file.filesystem }, previous: receipt })).total).toBe(10)
    expect(file.handles.map(handle => handle.read.mock.calls.length)).toEqual([2, 1, 2, 2])
  })

  it('ignores forged receipt getters, copies and prototype wrappers without trusting their total', async () => {
    const { file } = setup()
    const options = { filesystem: file.filesystem }
    const total = vi.fn(() => 999)
    const forged = Object.defineProperty({}, 'total', { get: total }) as { readonly total: number }
    const receipt = await readSessionTokenSnapshot(path, expected, { ...options, previous: forged })
    for (const previous of [Object.freeze({ ...receipt, total: 999 }), Object.create(receipt) as typeof receipt]) {
      expect((await readSessionTokenSnapshot(path, expected, { ...options, previous })).total).toBe(10)
    }
    expect(total).not.toHaveBeenCalled()
    expect(file.handles.map(handle => handle.read.mock.calls.length)).toEqual([2, 2, 2])
  })

  it('rejects ownership accessors before cache admission and captures shared mutable data', async () => {
    const { file, cache } = setup()
    const access = vi.fn(() => expected.id)
    const accessor = Object.defineProperties({}, { id: { get: access }, cwd: { value: expected.cwd } }) as typeof expected
    expect(await cache.read(path, accessor)).toBeUndefined()
    await expect(readSessionTokenSnapshot(path, accessor, { filesystem: file.filesystem })).rejects.toMatchObject({ closeUnknown: false })
    expect(access).not.toHaveBeenCalled()
    expect(file.filesystem.open).not.toHaveBeenCalled()
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

  it('rejects path lookup/open failures and non-files on a previously successful fast path', async () => {
    const { file, cache } = setup()
    expect(await cache.read(path, expected)).toBe(10)
    file.filesystem.open.mockRejectedValueOnce(new Error('no-follow refused'))
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(await cache.read(path, expected)).toBe(10)
    file.filesystem.lstat.mockResolvedValueOnce({ ...file.stat, isFile: () => false })
    expect(await cache.read(path, expected)).toBeUndefined()
    file.filesystem.lstat.mockRejectedValueOnce(new Error('lookup failed'))
    expect(await cache.read(path, expected)).toBeUndefined()
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

  it('performs no I/O for a caller already cancelled before admission', async () => {
    const { file, cache } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await cache.read(path, expected, { signal: controller.signal })).toBeUndefined()
    expect(file.filesystem.open).not.toHaveBeenCalled()
  })

  it('quarantines unknown closes across identities and retains their capacity without a retry', async () => {
    const { file, cache } = setup(1)
    file.onOpen = handle => { handle.close.mockRejectedValueOnce(new Error('close unknown')) }
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(await cache.read(path, expected)).toBeUndefined()
    expect(await cache.read(path, { ...expected, cwd: '/other/project' })).toBeUndefined()
    expect(await cache.read('/fixture/other.jsonl', expected)).toBeUndefined()
    expect(file.filesystem.open).toHaveBeenCalledOnce()
  })

  it('evicts only settled least-recently-used entries at the fixed capacity', async () => {
    const { file, cache } = setup(2)
    await cache.read(path, expected)
    await cache.read('/fixture/second.jsonl', expected)
    await cache.read(path, expected)
    await cache.read('/fixture/third.jsonl', expected)
    await cache.read('/fixture/second.jsonl', expected)
    expect(file.handles.map(handle => handle.read.mock.calls.length)).toEqual([2, 2, 0, 2, 2])
  })
})
