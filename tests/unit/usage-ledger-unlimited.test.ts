import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageLedger } from '../../src/main/usage-ledger'
import { addUsage, UsageLedgerStore, usageHash, zeroUsage } from '../../src/main/usage-ledger-store'
import type { LedgerDocument, LedgerSession } from '../../src/main/usage-ledger-store'
import { createUsageLedgerDirectoryIo } from '../fixtures/usage-ledger-directory-io'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat), unlink: vi.fn(actual.unlink) }
})
const dirs: string[] = []
const directoryIo = createUsageLedgerDirectoryIo()
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(directoryIo.open(actual))
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
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

  it('streams legacy envelopes over 64 MiB, ignores old checksums, and preserves extension fields', async () => {
    const { path, store } = await fixture()
    const data: LedgerDocument = Object.assign({ version: 1 as const, revision: 7, collectedAt: 0, sessions: [session(0)] }, { futureDocument: true })
    Object.assign(data.sessions[0], { futureSession: true })
    Object.assign(data.sessions[0].aliases[0], { futureAlias: true })
    data.sessions[0].receipts.push({ entry: hash('entry'), digest: hash('usage'), source: 'tool-summary', cwd: '/fixture', at: 0,
      usage: Object.assign(zeroUsage(), { futureUsage: 42 }), ...{ futureReceipt: true } })
    const envelope = { checksum: 'obsolete', futureEnvelope: { value: true }, data }
    const handle = await fs.open(path, 'w')
    try {
      const padding = Buffer.alloc(1024 * 1024, 32)
      for (let index = 0; index < 64; index++) await handle.writeFile(padding)
      await handle.writeFile(JSON.stringify(envelope) + '\n')
    } finally { await handle.close() }
    const loaded = await store.transaction(async value => ({ value: value.revision, dirty: false }))
    expect(loaded.value).toBe(7)
    expect(loaded.data).toEqual(data)
    await store.transaction(async () => ({ value: undefined, dirty: true }))
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ ...envelope,
      data: { ...data, revision: 8, collectedAt: expect.any(Number) } })
  }, 30_000)

  it('checks only the direct parent and exact lock identity before releasing a transaction', async () => {
    const { dir, path, store } = await fixture()
    vi.mocked(fs.lstat).mockClear()
    await store.transaction(async () => ({ value: undefined, dirty: false }))
    const checked = vi.mocked(fs.lstat).mock.calls.map(([file]) => String(file))
    expect(checked.filter(file => file === dir)).toHaveLength(2)
    expect(checked.every(file => file === dir || file === `${path}.lock`)).toBe(true)
  })

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
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.data.revision).toBe(1)
    expect(saved).not.toHaveProperty('checksum')
    await expect(new UsageLedgerStore(path).transaction(async data => ({ value: data.revision, dirty: false })))
      .resolves.toMatchObject({ value: 1 })
    expect(vi.mocked(fs.open).mock.calls.some(([file]) => String(file) === path)).toBe(true)
    if (process.platform === 'win32') {
      expect(directoryIo.handles).toHaveLength(1)
      for (const handle of directoryIo.handles) {
        expect(handle.sync).toHaveBeenCalledTimes(1)
        expect(handle.close).toHaveBeenCalledTimes(1)
      }
    } else {
      expect(directoryIo.handles).toHaveLength(0)
    }
  })

  it('probes actual host directory sync and reports unsupported durability as a retryable error', async () => {
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
      await expect(actual.stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(transaction()).rejects.toMatchObject({ code: 'collection-failed' })
      await expect(actual.stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await actual.readFile(path, 'utf8')).data.revision).toBe(1)
      await expect(store.transaction(async data => ({ value: data.revision, dirty: false })))
        .resolves.toMatchObject({ value: 1 })
    }
    expect(directoryIo.handles).toHaveLength(0)
  })

  it('releases its lock and allows flush after directory sync fails with a successful close', async () => {
    const { dir, path } = await fixture()
    const ledger = new UsageLedger({ ledgerPath: path, sessionRoot: join(dir, 'sessions') })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const sync = vi.fn<() => Promise<void>>(async () => { throw Object.assign(new Error('directory sync unsupported'), { code: 'ENOTSUP' }) })
    const close = vi.fn(async () => {})
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      if (String(file) === dir) {
        expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW)
        return { sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>
      }
      return actual.open(file, flags, mode)
    })
    await expect(ledger.getOverview()).rejects.toMatchObject({ code: 'collection-failed' })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    await expect(ledger.flush()).resolves.toBeUndefined()
    await expect(fs.stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await fs.readFile(path, 'utf8')).data.revision).toBe(1)
    // Pure overview reads do not repeat sync; explicit archival still requires it.
    await expect(ledger.getOverview()).resolves.toMatchObject({ revision: 1 })
    expect(sync).toHaveBeenCalledTimes(1)
    const store = new UsageLedgerStore(path)
    const unchanged = async () => ({ value: undefined, dirty: false })
    await expect(store.transaction(unchanged, undefined, true)).rejects.toMatchObject({ code: 'collection-failed' })
    expect(sync).toHaveBeenCalledTimes(2)
    sync.mockResolvedValue(undefined)
    await expect(store.transaction(unchanged, undefined, true)).resolves.toMatchObject({ data: { revision: 1 } })
    expect(sync).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(3)
  })

  it.each(['owned', 'foreign', 'replaced', 'missing', 'replaced-foreign'] as const)('retries settled lock cleanup only for its own identity (%s)', async state => {
    const { dir, path, store } = await fixture()
    const lockPath = `${path}.lock`
    vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error('unlink denied'), { code: 'EACCES' }))
    await expect(store.transaction(async () => ({ value: undefined, dirty: true })))
      .rejects.toMatchObject({ code: 'collection-failed' })
    expect((await fs.stat(lockPath)).isFile()).toBe(true)
    const source = await fs.readFile(path, 'utf8')
    const retired = ['replaced', 'missing', 'replaced-foreign'].includes(state) ? `${dir}.retired` : undefined
    if (retired) {
      await fs.rename(dir, retired)
      dirs.push(retired)
      if (state !== 'missing') {
        await fs.mkdir(dir)
        await fs.writeFile(path, source)
      }
    } else if (state === 'foreign') await fs.rename(lockPath, `${lockPath}.retired`)
    const foreign = state === 'foreign' || state === 'replaced-foreign'
    if (foreign) await fs.writeFile(lockPath, 'foreign-lock')
    const change = vi.fn(async () => ({ value: undefined, dirty: false }))
    if (state === 'owned') {
      for (const code of ['EACCES', 'EIO']) {
        vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('directory stat failed'), { code }))
        await expect(store.transaction(change)).rejects.toMatchObject({ code: 'collection-failed' })
      }
      expect(change).not.toHaveBeenCalled()
      expect(fs.unlink).toHaveBeenCalledTimes(1)
    }
    if (foreign) {
      await expect(store.transaction(change)).rejects.toMatchObject({ code: 'collection-failed' })
      expect(change).not.toHaveBeenCalled()
      expect(await fs.readFile(lockPath, 'utf8')).toBe('foreign-lock')
      expect(fs.unlink).toHaveBeenCalledTimes(1)
    } else {
      await expect(store.transaction(change)).resolves.toMatchObject({ data: { revision: state === 'missing' ? 0 : 1 } })
      expect(change).toHaveBeenCalledTimes(1)
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const original = retired ? join(retired, 'ledger.json') : path
    expect(await fs.readFile(original, 'utf8')).toBe(source)
    if (retired) expect((await fs.stat(`${original}.lock`)).isFile()).toBe(true)
  })

  it('refuses publication through a ledger parent replaced during temporary close', async () => {
    const { dir, path, store } = await fixture()
    await store.transaction(async () => ({ value: undefined, dirty: true }))
    const before = await fs.readFile(path, 'utf8')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let replaced = false
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await directoryIo.open(actual)(file, flags, mode)
      if (String(file).startsWith(`${path}.tmp-`)) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); replaced = true })
      }
      return handle
    })
    vi.mocked(fs.lstat).mockImplementation(async file => {
      const stat = await actual.lstat(file, { bigint: true })
      if (replaced && String(file) === dir) stat.ino += 1n
      return stat
    })
    await expect(store.transaction(async () => ({ value: undefined, dirty: true })))
      .rejects.toMatchObject({ code: 'collection-failed' })
    expect(replaced).toBe(true)
    expect(await fs.readFile(path, 'utf8')).toBe(before)
    expect((await fs.stat(`${path}.lock`)).isFile()).toBe(true)
    vi.mocked(fs.lstat).mockImplementation(actual.lstat)
    const opens = vi.mocked(fs.open).mock.calls.length
    const change = vi.fn(async () => ({ value: undefined, dirty: false }))
    await expect(store.transaction(change)).rejects.toMatchObject({ code: 'collection-failed' })
    expect(change).not.toHaveBeenCalled()
    expect(fs.open).toHaveBeenCalledTimes(opens + 1)
    expect((await fs.stat(`${path}.lock`)).isFile()).toBe(true)
  })

  it('retains a failed private temporary, releases its lock, and permits a later save after close rejects', async () => {
    const { dir, path, store } = await fixture()
    await store.transaction(async () => ({ value: undefined, dirty: true }))
    const before = await fs.readFile(path, 'utf8')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let failClose = true
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await directoryIo.open(actual)(file, flags, mode)
      if (String(file).startsWith(`${path}.tmp-`) && failClose) {
        failClose = false
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('close rejected') })
      }
      return handle
    })
    await expect(store.transaction(async () => ({ value: undefined, dirty: true })))
      .rejects.toMatchObject({ code: 'collection-failed' })
    expect(await fs.readFile(path, 'utf8')).toBe(before)
    expect((await fs.readdir(dir)).some(name => name.startsWith('ledger.json.tmp-'))).toBe(true)
    await expect(fs.stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.transaction(async () => ({ value: undefined, dirty: true })))
      .resolves.toMatchObject({ data: { revision: 2 } })
  })
})
