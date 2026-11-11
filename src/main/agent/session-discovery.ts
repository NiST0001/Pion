import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { SessionMeta } from '../../shared/types'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const validTime = (value: number): boolean => Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
const missing = (error: unknown): boolean => record(error) && error.code === 'ENOENT'
const stamp = (stat: BigIntStats): string => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
const identity = (stat: BigIntStats): string => [stat.dev, stat.ino].join(':')

/** SDK 1.4.0 bucket encoding, without getDefaultSessionDir's mkdir side effect. */
export function sessionDiscoveryDirectory(cwd: string, agentDir: string): string {
  const name = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(resolve(agentDir), 'sessions', name)
}

export class SessionDiscoveryError extends Error {
  constructor(readonly sourceChanged = false) { super('Session discovery unavailable') }
}

interface CachedFile {
  identity: string
  stamp: string
  meta: SessionMeta
}
interface Bucket {
  identity?: string
  files: Map<string, CachedFile>
  pending?: Promise<SessionMeta[]>
}

/**
 * Read-only sidebar projection of SDK 1.4.0 buildSessionInfo. No SDK factories,
 * writers, migrations, parent-session reads, credentials or allMessagesText.
 *
 * Preserve the SDK's physical message count (all roles, across branches), first
 * nonempty user text, latest trimmed name/clear, activity clock and stable sort.
 * File failures retain that file's verified metadata while healthy files advance.
 * Directory failures retain the whole prior bucket. Unchanged metadata needs one
 * path stamp, not another open/read. Stamps are cache hints, not authentication
 * or a filesystem snapshot/OS sandbox. Each admitted scan owns
 * its actual reads/closes through settlement; signal only fences its result.
 */
export class SessionDiscovery {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly agentDir: () => string,
    private readonly yieldRead: () => Promise<void> = () => setImmediate(),
    private readonly maxBuckets = 64
  ) {
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) throw new RangeError('Invalid discovery cache capacity')
  }

  async list(cwd: string, options?: { signal?: AbortSignal }): Promise<SessionMeta[]> {
    options?.signal?.throwIfAborted()
    const owner = resolve(cwd)
    const root = resolve(this.agentDir())
    const directory = sessionDiscoveryDirectory(owner, root)
    let bucket = this.buckets.get(directory)
    if (!bucket) {
      // Sidebar metadata only: evict settled LRU buckets, never an actual scan.
      for (const [oldDirectory, oldBucket] of this.buckets) {
        if (this.buckets.size < this.maxBuckets) break
        if (!oldBucket.pending) this.buckets.delete(oldDirectory)
      }
      if (this.buckets.size >= this.maxBuckets) throw new SessionDiscoveryError()
      bucket = { files: new Map() }
    }
    this.buckets.delete(directory)
    this.buckets.set(directory, bucket)
    if (!bucket.pending) {
      const captured = bucket
      captured.pending = this.scan(directory, captured).catch((error: unknown) => {
        throw error instanceof SessionDiscoveryError ? error : new SessionDiscoveryError()
      }).finally(() => { captured.pending = undefined })
    }
    const sessions = await bucket.pending!
    options?.signal?.throwIfAborted()
    if (root !== resolve(this.agentDir())) throw new SessionDiscoveryError()
    // Header ownership remains exact even when Windows/Unix bucket names collide.
    return sessions.filter((session) => session.projectCwd === owner).map((session) => ({ ...session }))
  }

  private async scan(directory: string, bucket: Bucket): Promise<SessionMeta[]> {
    let before: BigIntStats
    try {
      before = await lstat(directory, { bigint: true })
    } catch (error) {
      if (!missing(error)) throw error
      await this.yieldRead()
      try { await lstat(directory, { bigint: true }) } catch (confirmed) {
        if (!missing(confirmed)) throw confirmed
        bucket.identity = undefined
        bucket.files = new Map()
        return []
      }
      throw new SessionDiscoveryError()
    }
    if (!before.isDirectory()) throw new SessionDiscoveryError()
    // A replacement directory starts a new source even when filenames match.
    const previousFiles = bucket.identity === identity(before) ? bucket.files : new Map<string, CachedFile>()
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort((a, b) => b.localeCompare(a))
    const discovered = new Map<string, CachedFile>()
    let failed = false
    for (const name of names) {
      const path = join(directory, name)
      try {
        discovered.set(path, await this.readFile(path, previousFiles.get(path)))
      } catch (error) {
        let previous = previousFiles.get(path)
        if (previous && !(error instanceof SessionDiscoveryError && error.sourceChanged)) {
          try {
            const current = await lstat(path, { bigint: true })
            if (!current.isFile() || identity(current) !== previous.identity) previous = undefined
          } catch { previous = undefined }
        } else previous = undefined
        if (previous) discovered.set(path, previous)
        failed = true
      }
      await this.yieldRead()
    }
    const afterNames = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort((a, b) => b.localeCompare(a))
    const after = await lstat(directory, { bigint: true })
    if (!after.isDirectory() || stamp(before) !== stamp(after)
      || names.length !== afterNames.length || names.some((name, index) => name !== afterNames[index])) throw new SessionDiscoveryError()
    bucket.identity = identity(before)
    bucket.files = discovered
    // An unreadable bucket stays unknown; healthy files can still advance.
    if (!discovered.size && failed) throw new SessionDiscoveryError()
    const result = [...discovered.values()].map((file) => file.meta).sort((a, b) => b.mtime - a.mtime)
    return result
  }

  private async readFile(path: string, cached?: CachedFile): Promise<CachedFile> {
    const named = await lstat(path, { bigint: true })
    if (!named.isFile() || named.size === 0n) throw new SessionDiscoveryError()
    const expected = stamp(named)
    if (cached?.stamp === expected) return cached
    let handle: FileHandle | undefined
    let sourceChanged = false
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || stamp(before) !== expected) throw new SessionDiscoveryError()
      const meta = await readMetadata(handle, path, before.size, this.yieldRead, header => {
        sourceChanged = !header || !!cached && (header.id !== cached.meta.id
          || header.projectCwd !== cached.meta.projectCwd || header.timestamp !== cached.meta.timestamp)
      })
      const after = await handle.stat({ bigint: true })
      const current = await lstat(path, { bigint: true })
      if (!after.isFile() || !current.isFile() || stamp(after) !== expected || stamp(current) !== expected) throw new SessionDiscoveryError()
      return { identity: identity(before), stamp: expected, meta }
    } catch (error) {
      if (sourceChanged) throw new SessionDiscoveryError(true)
      throw error
    } finally {
      if (handle) {
        try { await handle.close() } catch {
          throw new SessionDiscoveryError(sourceChanged)
        }
      }
    }
  }
}

/** Only the currently decoded JSONL line is retained, plus the 120-char preview. */
async function readMetadata(
  handle: FileHandle, path: string, size: bigint, yieldRead: () => Promise<void>, onHeader: (header?: SessionMeta) => void
): Promise<SessionMeta> {
  let meta: SessionMeta | undefined
  let headerTime = 0
  let lastActivity: number | undefined
  let preview: string | undefined
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const consume = (line: Buffer): void => {
    if (!meta) onHeader()
    const raw = decoder.decode(line)
    if (!raw.trim()) return
    const entry: unknown = JSON.parse(raw)
    if (!record(entry) || !text(entry.type)) throw new SessionDiscoveryError()
    if (!meta) {
      if (entry.type !== 'session' || !text(entry.id) || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(entry.id)
        || !text(entry.cwd) || entry.cwd.includes('\0') || !text(entry.timestamp)
        || (entry.version !== undefined && ![1, 2, 3].includes(entry.version as number))) throw new SessionDiscoveryError()
      headerTime = Date.parse(entry.timestamp)
      if (!validTime(headerTime)) throw new SessionDiscoveryError()
      // Preserve the Bridge's lexical resolve semantics, including registered
      // symlink aliases; a realpath lookup would merge distinct worktree owners.
      meta = { projectCwd: resolve(entry.cwd), path, id: entry.id, timestamp: new Date(headerTime).toISOString(),
        mtime: headerTime, preview: '(no messages)', messageCount: 0 }
      onHeader(meta)
      return
    }
    if (entry.type === 'session') throw new SessionDiscoveryError()
    if (entry.type === 'session_info') {
      if (entry.name !== undefined && typeof entry.name !== 'string') throw new SessionDiscoveryError()
      meta.name = (entry.name as string | undefined)?.trim() || undefined
    }
    if (entry.type !== 'message') return
    if (!record(entry.message) || !text(entry.message.role)) throw new SessionDiscoveryError()
    meta.messageCount += 1
    const message = entry.message
    if (message.role !== 'user' && message.role !== 'assistant') return
    if (!('content' in message)) return
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) throw new SessionDiscoveryError()
    const activity = typeof message.timestamp === 'number' ? message.timestamp
      : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined
    if (typeof activity === 'number') {
      if (!validTime(activity)) throw new SessionDiscoveryError()
      lastActivity = Math.max(lastActivity ?? 0, activity)
    }
    // Validate text blocks while avoiding the SDK's full-message join and its
    // accumulated allMessages array; empty blocks still contribute separators.
    if (typeof message.content === 'string') {
      if (message.role === 'user' && preview === undefined && message.content) preview = message.content.slice(0, 120)
    } else {
      let prefix = ''
      let blocks = 0
      let nonempty = false
      for (const block of message.content) {
        if (!record(block) || !text(block.type)) throw new SessionDiscoveryError()
        if (block.type !== 'text') continue
        if (typeof block.text !== 'string') throw new SessionDiscoveryError()
        if (blocks++ > 0) prefix = (prefix + ' ').slice(0, 120)
        if (block.text.length) nonempty = true
        if (prefix.length < 120) prefix += block.text.slice(0, 120 - prefix.length)
      }
      if (message.role === 'user' && preview === undefined && (nonempty || blocks > 1)) preview = prefix
    }
  }
  const chunk = Buffer.alloc(64 * 1024)
  let pending: Buffer[] = []
  let pendingBytes = 0
  let bytes = 0n
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) break
    bytes += BigInt(bytesRead)
    if (bytes > size) throw new SessionDiscoveryError()
    const data = chunk.subarray(0, bytesRead)
    let start = 0
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      const segment = data.subarray(start, end)
      consume(pendingBytes ? Buffer.concat([...pending, segment], pendingBytes + segment.length) : segment)
      pending = []
      pendingBytes = 0
      start = end + 1
    }
    if (start < data.length) {
      pending.push(Buffer.from(data.subarray(start)))
      pendingBytes += data.length - start
    }
    await yieldRead()
  }
  // A complete final JSON line is valid in SDK list(); no repair/write is made.
  if (pendingBytes) consume(Buffer.concat(pending, pendingBytes))
  if (!meta || bytes !== size) throw new SessionDiscoveryError()
  meta.mtime = lastActivity !== undefined && lastActivity > 0 ? lastActivity : headerTime
  meta.preview = preview ?? '(no messages)'
  return meta
}
