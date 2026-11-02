import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addUsage, directoryChain, UsageLedgerStore, usageHash, zeroUsage } from '../../src/main/usage-ledger-store'
import type { LedgerDocument, LedgerSession } from '../../src/main/usage-ledger-store'
import { createUsageLedgerDirectoryIo } from '../fixtures/usage-ledger-directory-io'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const dirs: string[] = []
const directoryIo = createUsageLedgerDirectoryIo()
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(directoryIo.open(actual))
})
afterEach(async () => {
  vi.restoreAllMocks()
  directoryIo.reset()
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pion-ledger-unlimited-'))
  dirs.push(dir)
  directoryIo.register(dir)
  const path = join(dir, 'ledger.json')
  return { dir, path, store: new UsageLedgerStore(path) }
}
const hash = (value: string) => usageHash(value)
function session(index: number): LedgerSession {
  return { id: hash(`session-${index}`), cwd: '/fixture', createdAt: 0,
    aliases: [0, 1].map(alias => ({ path: hash(`path-${index}-${alias}`), receipt: hash('file'), stamp: hash('stamp') })), receipts: [] }
}

describe('usage ledger without artificial capacity limits', () => {
  it('persists and reloads more than 10k sessions, 20k aliases and 100k receipts without dropping evidence', async () => {
    const { path, store } = await fixture()
    await store.transaction(async data => {
      data.sessions = Array.from({ length: 10_001 }, (_, index) => session(index))
      data.sessions[0].receipts = Array.from({ length: 100_001 }, (_, index) => ({
        entry: hash(`entry-${index}`), digest: hash(`usage-${index}`), source: 'tool-summary' as const,
        cwd: '/fixture', at: index, usage: zeroUsage()
      }))
      return { value: undefined, dirty: true }
    })
    const reopened = await new UsageLedgerStore(path).transaction(async data => ({ value: {
      sessions: data.sessions.length, aliases: data.sessions.reduce((count, item) => count + item.aliases.length, 0),
      receipts: data.sessions[0].receipts.length, first: data.sessions[0].receipts[0].entry,
      last: data.sessions[0].receipts.at(-1)?.entry
    }, dirty: false }))
    expect(reopened.value).toEqual({ sessions: 10_001, aliases: 20_002, receipts: 100_001,
      first: hash('entry-0'), last: hash('entry-100000') })
    expect(reopened.data.revision).toBe(1)
    // Capacity removal does not permit conflicting evidence or overwrite the last good revision.
    await expect(new UsageLedgerStore(path).transaction(async data => {
      data.sessions[0].receipts.push(data.sessions[0].receipts[0])
      return { value: undefined, dirty: true }
    })).rejects.toMatchObject({ code: 'collection-failed' })
  }, 30_000)

  it('loads a valid v1 envelope larger than 64 MiB using chunked reads', async () => {
    const { path, store } = await fixture()
    const data: LedgerDocument = { version: 1, revision: 7, collectedAt: 0, sessions: [session(0)] }
    const handle = await fs.open(path, 'w')
    try {
      const padding = Buffer.alloc(1024 * 1024, 32)
      for (let index = 0; index < 64; index++) await handle.writeFile(padding)
      await handle.writeFile(JSON.stringify({ checksum: usageHash(data), data }) + '\n')
    } finally { await handle.close() }
    const loaded = await store.transaction(async value => ({ value: value.revision, dirty: false }))
    expect(loaded.value).toBe(7)
    expect(loaded.data).toEqual(data)
  }, 30_000)

  it('walks and creates directory chains deeper than 64 to the actual root', async () => {
    const { dir } = await fixture()
    const parent = join(dir, ...Array.from({ length: 70 }, () => 'd'))
    directoryIo.register(parent)
    const store = new UsageLedgerStore(join(parent, 'ledger.json'))
    await store.transaction(async () => ({ value: undefined, dirty: true }))
    const chain = await directoryChain(parent)
    expect(chain.length).toBeGreaterThan(64)
    expect(chain[0].path).toBe(parent)
  }, 30_000)

  it('reports genuine arithmetic overflow as invalid data rather than capacity', async () => {
    const total = zeroUsage()
    total.total = Number.MAX_SAFE_INTEGER
    expect(() => addUsage(total, { ...zeroUsage(), total: 1 })).toThrow(expect.objectContaining({ code: 'collection-failed' }))
    const { store } = await fixture()
    await expect(store.transaction(async data => {
      data.revision = Number.MAX_SAFE_INTEGER
      return { value: undefined, dirty: true }
    })).rejects.toMatchObject({ code: 'collection-failed' })
  })

  it('uses the registered directory model only for Windows algorithm fixtures', async () => {
    const { path, store } = await fixture()
    await store.transaction(async () => ({ value: undefined, dirty: true }))
    expect(JSON.parse(await fs.readFile(path, 'utf8')).data.revision).toBe(1)
    await expect(new UsageLedgerStore(path).transaction(async data => ({ value: data.revision, dirty: false })))
      .resolves.toMatchObject({ value: 1 })
    expect(vi.mocked(fs.open).mock.calls.some(([file]) => String(file) === path)).toBe(true)
    if (process.platform === 'win32') {
      expect(directoryIo.handles).toHaveLength(1)
      expect(directoryIo.handles[0].sync).toHaveBeenCalledTimes(1)
      expect(directoryIo.handles[0].close).toHaveBeenCalledTimes(1)
    } else {
      expect(directoryIo.handles).toHaveLength(0)
    }
  })

  it('probes actual host directory sync and preserves the store quarantine on unsupported hosts', async () => {
    const { dir, path, store } = await fixture()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    // Bypass the fixture model for both the probe and the complete store transaction.
    vi.mocked(fs.open).mockImplementation(actual.open)
    let supported = true
    try {
      const handle = await actual.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
    } catch (error) {
      expect(['EACCES', 'EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EBADF'])
        .toContain((error as NodeJS.ErrnoException).code)
      supported = false
    }
    const transaction = () => store.transaction(async () => ({ value: undefined, dirty: true }))
    if (supported) {
      await expect(transaction()).resolves.toMatchObject({ data: { revision: 1 } })
      expect(() => store.assertSettled()).not.toThrow()
      await expect(actual.stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(transaction()).rejects.toMatchObject({ code: 'collection-failed', closeUnknown: true })
      expect(() => store.assertSettled()).toThrow(expect.objectContaining({ closeUnknown: true }))
      expect((await actual.stat(`${path}.lock`)).isFile()).toBe(true)
      expect(JSON.parse(await actual.readFile(path, 'utf8')).data.revision).toBe(1)
      await expect(transaction()).rejects.toMatchObject({ code: 'collection-failed', closeUnknown: true })
      await expect(new UsageLedgerStore(path).transaction(async () => ({ value: undefined, dirty: false })))
        .rejects.toMatchObject({ code: 'collection-failed' })
    }
    expect(directoryIo.handles).toHaveLength(0)
  })

  it('retains the lock and quarantines the store when directory sync is unsupported', async () => {
    const { dir, path, store } = await fixture()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const sync = vi.fn(async () => { throw Object.assign(new Error('directory sync unsupported'), { code: 'ENOTSUP' }) })
    const close = vi.fn(async () => {})
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      if (String(file) === dir) {
        expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW)
        return { sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>
      }
      return actual.open(file, flags, mode)
    })
    await expect(store.transaction(async () => ({ value: undefined, dirty: true })))
      .rejects.toMatchObject({ code: 'collection-failed', closeUnknown: true })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(() => store.assertSettled()).toThrow(expect.objectContaining({ closeUnknown: true }))
    expect((await fs.stat(`${path}.lock`)).isFile()).toBe(true)
    expect(JSON.parse(await fs.readFile(path, 'utf8')).data.revision).toBe(1)
  })

  it('still quarantines an actual close failure and retains its lock', async () => {
    const { path, store } = await fixture()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await directoryIo.open(actual)(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('close unknown') })
      return handle
    })
    await expect(store.transaction(async () => ({ value: undefined, dirty: false })))
      .rejects.toMatchObject({ closeUnknown: true })
    expect(() => store.assertSettled()).toThrow(expect.objectContaining({ closeUnknown: true }))
    expect((await fs.stat(`${path}.lock`)).isFile()).toBe(true)
  })
})
