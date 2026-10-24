import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { TokenUsage } from '../shared/operations'

export const usageHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: 0 })

export interface LedgerReceipt {
  entry: string
  digest: string
  event?: string
  eventDigest?: string
  source: 'model' | 'tool-summary'
  provider?: string
  modelId?: string
  cwd: string
  at: number
  usage: TokenUsage
}
export interface LedgerSession {
  id: string
  createdAt: number
  cwd: string
  parent?: string
  /** Once established, retain the exact parent even if its old path is reused. */
  parentId?: string
  aliases: { path: string; receipt: string; stamp: string; conflict?: string }[]
  receipts: LedgerReceipt[]
}
export interface LedgerDocument {
  version: 1
  revision: number
  collectedAt: number
  sessions: LedgerSession[]
}
export class UsageLedgerError extends Error {
  constructor(readonly code: 'collection-failed', readonly closeUnknown = false) {
    super('Usage ledger unavailable')
  }
}

type Handle = Awaited<ReturnType<typeof open>>
type Snapshot = { dev: bigint; ino: bigint }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const date = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= 8_640_000_000_000_000
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).every(key => allowed.includes(key))
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'costUsd'] as const

export function addUsage(target: TokenUsage, value: TokenUsage): void {
  for (const field of fields) {
    const sum = target[field] + value[field]
    if (!Number.isFinite(sum) || (field !== 'costUsd' && !Number.isSafeInteger(sum))) throw new UsageLedgerError('collection-failed')
    target[field] = sum
  }
}

function validUsage(v: unknown): v is TokenUsage {
  return object(v) && keys(v, [...fields]) && fields.every(field => field === 'costUsd'
    ? typeof v[field] === 'number' && Number.isFinite(v[field]) && v[field] >= 0 : count(v[field]))
}

/** Reject unknown fields as well as broken receipts; never rewrite a damaged ledger as empty. */
function validate(v: unknown): asserts v is LedgerDocument {
  if (!object(v) || !keys(v, ['version', 'revision', 'collectedAt', 'sessions']) || v.version !== 1
    || !count(v.revision) || !date(v.collectedAt) || !Array.isArray(v.sessions)) throw new UsageLedgerError('collection-failed')
  const sessions = new Set<string>()
  const paths = new Map<string, string>()
  for (const session of v.sessions) {
    if (!object(session) || !keys(session, ['id', 'createdAt', 'cwd', 'parent', 'parentId', 'aliases', 'receipts'])
      || !hash(session.id) || sessions.has(session.id) || !date(session.createdAt) || !bounded(session.cwd, 4096)
      || (session.parent !== undefined && !hash(session.parent))
      || (session.parentId !== undefined && (!hash(session.parentId) || session.parent === undefined)) || !Array.isArray(session.aliases)
      || session.aliases.length === 0 || !Array.isArray(session.receipts)) throw new UsageLedgerError('collection-failed')
    sessions.add(session.id)
    for (const alias of session.aliases) {
      if (!object(alias) || !keys(alias, ['path', 'receipt', 'stamp', 'conflict']) || !hash(alias.path) || !hash(alias.receipt) || !hash(alias.stamp)
        || (alias.conflict !== undefined && !hash(alias.conflict))
        || paths.has(alias.path)) throw new UsageLedgerError('collection-failed')
      paths.set(alias.path, session.id)
    }
    const entries = new Set<string>()
    for (const receipt of session.receipts) {
      if (!object(receipt) || !keys(receipt, ['entry', 'digest', 'event', 'eventDigest', 'source', 'provider', 'modelId', 'cwd', 'at', 'usage'])
        || !hash(receipt.entry) || entries.has(receipt.entry) || !hash(receipt.digest) || !date(receipt.at)
        || !bounded(receipt.cwd, 4096) || !validUsage(receipt.usage)
        || (receipt.source !== 'model' && receipt.source !== 'tool-summary')
        || (receipt.source === 'model' && (!bounded(receipt.provider, 256) || !bounded(receipt.modelId, 256)))
        || (receipt.source === 'tool-summary' && (receipt.provider !== undefined || receipt.modelId !== undefined))
        || ((receipt.event === undefined) !== (receipt.eventDigest === undefined))
        || (receipt.event !== undefined && (!hash(receipt.event) || !hash(receipt.eventDigest)))) throw new UsageLedgerError('collection-failed')
      entries.add(receipt.entry)
    }
  }
  for (const session of v.sessions) {
    if (session.parentId !== undefined && (!sessions.has(session.parentId) || paths.get(session.parent) !== session.parentId)) {
      throw new UsageLedgerError('collection-failed')
    }
  }
}

/** Check each ancestor rather than following a directory symlink. Not an OS sandbox. */
export async function directoryChain(path: string): Promise<{ path: string; dev: bigint; ino: bigint }[]> {
  let current = resolve(path)
  const snapshots: { path: string; dev: bigint; ino: bigint }[] = []
  while (true) {
    const value = await lstat(current, { bigint: true })
    if (!value.isDirectory() || value.isSymbolicLink()) throw new UsageLedgerError('collection-failed')
    snapshots.push({ path: current, dev: value.dev, ino: value.ino })
    const parent = dirname(current)
    if (parent === current) return snapshots
    current = parent
  }
}
export async function checkDirectories(snapshots: Awaited<ReturnType<typeof directoryChain>>): Promise<void> {
  for (const previous of snapshots) {
    const current = await lstat(previous.path, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== previous.dev || current.ino !== previous.ino) {
      throw new UsageLedgerError('collection-failed')
    }
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const missing: string[] = []
  let current = path
  while (true) {
    try { await directoryChain(current); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) throw new UsageLedgerError('collection-failed')
      current = parent
    }
  }
  for (const child of missing.reverse()) {
    await directoryChain(dirname(child))
    try { await mkdir(child, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await directoryChain(child)
  }
}
/** A short exclusive transaction, not an Electron-profile/PID/age-based lock. */
export class UsageLedgerStore {
  private poisoned = false
  private readonly path: string
  constructor(path: string) { this.path = resolve(path) }

  assertSettled(): void {
    if (this.poisoned) throw new UsageLedgerError('collection-failed', true)
  }

  private async close(handle: Handle): Promise<void> {
    try { await handle.close() } catch { this.poisoned = true; throw new UsageLedgerError('collection-failed', true) }
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await this.close(directory) }
  }

  private async load(): Promise<LedgerDocument> {
    let file: Handle
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, collectedAt: 0, sessions: [] }
      throw error
    }
    let text: string
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || before.size <= 0n) throw new UsageLedgerError('collection-failed')
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        const buffer = Buffer.alloc(64 * 1024)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        size += bytesRead
        if (!Number.isSafeInteger(size) || BigInt(size) > before.size) throw new UsageLedgerError('collection-failed')
        chunks.push(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat({ bigint: true })
      const current = await lstat(this.path, { bigint: true })
      for (const snapshot of [after, current]) {
        if (!snapshot.isFile() || snapshot.dev !== before.dev || snapshot.ino !== before.ino || snapshot.size !== before.size
          || snapshot.mtimeNs !== before.mtimeNs || snapshot.ctimeNs !== before.ctimeNs) throw new UsageLedgerError('collection-failed')
      }
      if (BigInt(size) !== before.size) throw new UsageLedgerError('collection-failed')
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally { await this.close(file) }
    const envelope: unknown = JSON.parse(text)
    if (!object(envelope) || !keys(envelope, ['checksum', 'data']) || !hash(envelope.checksum)
      || envelope.checksum !== usageHash(envelope.data)) throw new UsageLedgerError('collection-failed')
    validate(envelope.data)
    return envelope.data
  }

  private async save(data: LedgerDocument, verify?: () => Promise<void>): Promise<void> {
    validate(data)
    const content = JSON.stringify({ checksum: usageHash(data), data }) + '\n'
    const temporary = `${this.path}.tmp-${randomUUID()}`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await this.close(file) }
    // A failed private temporary is retained for recovery, never mistaken for the ledger.
    // Source proofs must survive the actual write/sync/close, before publication.
    if (verify) await verify()
    await rename(temporary, this.path)
    try { await this.syncDirectory() } catch (error) { this.poisoned = true; throw error }
  }

  async transaction<T>(change: (data: LedgerDocument) => Promise<{ value: T; dirty: boolean }>, verify?: (value: T) => Promise<void>): Promise<{ data: LedgerDocument; value: T }> {
    this.assertSettled()
    const parent = dirname(this.path)
    let directories: Awaited<ReturnType<typeof directoryChain>>
    try { await ensureDirectory(parent); directories = await directoryChain(parent) } catch (error) {
      throw error instanceof UsageLedgerError ? error : new UsageLedgerError('collection-failed')
    }
    const lockPath = `${this.path}.lock`
    let lock: Handle | undefined
    let lockSnapshot: Snapshot | undefined
    let result: { data: LedgerDocument; value: T } | undefined
    let failure: unknown
    try {
      // EEXIST is a hard refusal. Never probe a PID or delete another process's lock.
      lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      lockSnapshot = await lock.stat({ bigint: true })
      await lock.writeFile(randomUUID(), 'utf8')
      await lock.sync()
      const ownedLock = lock
      lock = undefined
      await this.close(ownedLock)
      const data = await this.load()
      const changeResult = await change(data)
      if (changeResult.dirty) {
        if (!Number.isSafeInteger(data.revision + 1)) throw new UsageLedgerError('collection-failed')
        data.revision++
        data.collectedAt = Date.now()
        await checkDirectories(directories)
        await this.save(data, verify ? () => verify(changeResult.value) : undefined)
      }
      if (verify) await verify(changeResult.value)
      await checkDirectories(directories)
      result = { data, value: changeResult.value }
    } catch (error) {
      failure = error
      if (error instanceof UsageLedgerError && error.closeUnknown) this.poisoned = true
    } finally {
      if (lock) {
        try { await this.close(lock) } catch (error) { failure = error }
      }
      if (lockSnapshot && !this.poisoned) {
        try {
          await checkDirectories(directories)
          const current = await lstat(lockPath, { bigint: true })
          if (!current.isFile() || current.dev !== lockSnapshot.dev || current.ino !== lockSnapshot.ino) throw new UsageLedgerError('collection-failed')
          // Ledger rename/sync and all descriptors have settled before release.
          // Unlink is last: a crash may leave a stale lock, which is safely refused.
          await unlink(lockPath)
        } catch (error) { this.poisoned = true; failure = error }
      }
    }
    if (failure || !result) throw failure instanceof UsageLedgerError ? failure : new UsageLedgerError('collection-failed', this.poisoned)
    return result
  }
}
