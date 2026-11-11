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
  constructor(readonly code: 'collection-failed') {
    super('Usage ledger unavailable')
  }
}

type Handle = Awaited<ReturnType<typeof open>>
type Snapshot = { dev: bigint; ino: bigint }
type LedgerFile = { data: LedgerDocument; [field: string]: unknown }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const date = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= 8_640_000_000_000_000
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'costUsd'] as const

export function addUsage(target: TokenUsage, value: TokenUsage): void {
  for (const field of fields) {
    const sum = target[field] + value[field]
    if (!Number.isFinite(sum) || (field !== 'costUsd' && !Number.isSafeInteger(sum))) throw new UsageLedgerError('collection-failed')
    target[field] = sum
  }
}

function validUsage(v: unknown): v is TokenUsage {
  return object(v) && fields.every(field => field === 'costUsd'
    ? typeof v[field] === 'number' && Number.isFinite(v[field]) && v[field] >= 0 : count(v[field]))
}

/** Validate required fields and receipt identities while retaining extension fields. */
function validate(v: unknown): asserts v is LedgerDocument {
  if (!object(v) || v.version !== 1
    || !count(v.revision) || !date(v.collectedAt) || !Array.isArray(v.sessions)) throw new UsageLedgerError('collection-failed')
  const sessions = new Set<string>()
  const paths = new Map<string, string>()
  for (const session of v.sessions) {
    if (!object(session) || !hash(session.id) || sessions.has(session.id) || !date(session.createdAt) || !bounded(session.cwd, 4096)
      || (session.parent !== undefined && !hash(session.parent))
      || (session.parentId !== undefined && (!hash(session.parentId) || session.parent === undefined)) || !Array.isArray(session.aliases)
      || session.aliases.length === 0 || !Array.isArray(session.receipts)) throw new UsageLedgerError('collection-failed')
    sessions.add(session.id)
    for (const alias of session.aliases) {
      if (!object(alias) || !hash(alias.path) || !hash(alias.receipt) || !hash(alias.stamp)
        || (alias.conflict !== undefined && !hash(alias.conflict))
        || paths.has(alias.path)) throw new UsageLedgerError('collection-failed')
      paths.set(alias.path, session.id)
    }
    const entries = new Set<string>()
    for (const receipt of session.receipts) {
      if (!object(receipt) || !hash(receipt.entry) || entries.has(receipt.entry) || !hash(receipt.digest) || !date(receipt.at)
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

/** Capture a directly owned directory; callers add the SDK root/bucket as needed. */
export async function directoryProof(path: string): Promise<{ path: string; dev: bigint; ino: bigint }[]> {
  path = resolve(path)
  const value = await lstat(path, { bigint: true })
  if (!value.isDirectory() || value.isSymbolicLink()) throw new UsageLedgerError('collection-failed')
  return [{ path, dev: value.dev, ino: value.ino }]
}
export async function checkDirectories(snapshots: Awaited<ReturnType<typeof directoryProof>>): Promise<void> {
  for (const previous of snapshots) {
    const current = await lstat(previous.path, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== previous.dev || current.ino !== previous.ino) {
      throw new UsageLedgerError('collection-failed')
    }
  }
}

/** A short exclusive transaction, not an Electron-profile/PID/age-based lock. */
export class UsageLedgerStore {
  private retryRelease?: () => Promise<void>
  private readonly path: string
  constructor(path: string) { this.path = resolve(path) }

  private async syncDirectory(): Promise<void> {
    const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  }

  private async load(): Promise<LedgerFile> {
    let file: Handle
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: { version: 1, revision: 0, collectedAt: 0, sessions: [] } }
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
    } finally { await file.close() }
    const envelope: unknown = JSON.parse(text)
    if (!object(envelope)) throw new UsageLedgerError('collection-failed')
    validate(envelope.data)
    // Legacy checksum and extension fields remain opaque and round-trip unchanged.
    return envelope as LedgerFile
  }

  private async save(envelope: LedgerFile, verify?: () => Promise<void>): Promise<void> {
    validate(envelope.data)
    const content = JSON.stringify(envelope) + '\n'
    const temporary = `${this.path}.tmp-${randomUUID()}`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
    // A failed private temporary is retained for recovery, never mistaken for the ledger.
    // Source proofs must survive the actual write/sync/close, before publication.
    if (verify) await verify()
    await rename(temporary, this.path)
  }

  async transaction<T>(change: (data: LedgerDocument) => Promise<{ value: T; dirty: boolean }>, verify?: (value: T) => Promise<void>, durable = false): Promise<{ data: LedgerDocument; value: T }> {
    try { await this.retryRelease?.() } catch (error) {
      throw error instanceof UsageLedgerError ? error : new UsageLedgerError('collection-failed')
    }
    const parent = dirname(this.path)
    let directories: Awaited<ReturnType<typeof directoryProof>>
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      directories = await directoryProof(parent)
    } catch (error) {
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
      const ownedLock = lock
      lock = undefined
      await ownedLock.close()
      const envelope = await this.load()
      const { data } = envelope
      const changeResult = await change(data)
      if (changeResult.dirty) {
        if (!Number.isSafeInteger(data.revision + 1)) throw new UsageLedgerError('collection-failed')
        data.revision++
        data.collectedAt = Date.now()
        await this.save(envelope, async () => {
          if (verify) await verify(changeResult.value)
          // Recheck the ledger destination after temporary write/sync/close and
          // source verification, before rename can publish through a new parent.
          await checkDirectories(directories)
        })
      } else if (verify) await verify(changeResult.value)
      // Explicit archival still confirms directory durability for an unchanged source.
      if (changeResult.dirty || durable) await this.syncDirectory()
      // The finally block checks these same directories immediately before lock release.
      result = { data, value: changeResult.value }
    } catch (error) {
      failure = error
    } finally {
      if (lock) {
        try { await lock.close() } catch (error) { failure = error }
      }
      if (lockSnapshot) {
        const snapshot = lockSnapshot
        const release = async (retry = false) => {
          try { await checkDirectories(directories) } catch (error) {
            // Retiring old cleanup leaves the replacement directory and every lock untouched.
            if (retry && (error instanceof UsageLedgerError || (error as NodeJS.ErrnoException).code === 'ENOENT')) return
            throw error
          }
          try {
            const current = await lstat(lockPath, { bigint: true })
            if (!current.isFile() || current.dev !== snapshot.dev || current.ino !== snapshot.ino) throw new UsageLedgerError('collection-failed')
            // Only this settled transaction's exact lock may be released.
            await unlink(lockPath)
          } catch (error) {
            if (!retry || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        try { await release() } catch (error) {
          if (!(error instanceof UsageLedgerError)) {
            let pending: Promise<void> | undefined
            this.retryRelease = () => pending ??= release(true).then(
              () => { this.retryRelease = undefined },
              error => { pending = undefined; throw error }
            )
          }
          failure = error
        }
      }
    }
    if (failure || !result) throw failure instanceof UsageLedgerError ? failure : new UsageLedgerError('collection-failed')
    return result
  }
}
