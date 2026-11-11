import {
  readSessionTokenSnapshot, snapshotSessionTokenOwner,
  type SessionTokenFileSystem, type SessionTokenOwner, type SessionTokenSnapshot
} from './session-token-total'

interface Entry {
  snapshot?: SessionTokenSnapshot
  pending?: Promise<number | undefined>
}

/** One instance per sidebar owner. The list cache still owns discovery, limits and publishing. */
export class SessionTokenCache {
  private readonly entries = new Map<string, Entry>()
  private readonly pendingPaths = new Set<string>()
  private readonly maxEntries: number
  private readonly filesystem?: SessionTokenFileSystem

  constructor(options: { filesystem?: SessionTokenFileSystem; maxEntries?: number } = {}) {
    this.filesystem = options.filesystem
    this.maxEntries = options.maxEntries ?? 512
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new RangeError('Invalid token cache capacity')
  }

  async read(path: string, expected: { id: string; cwd: string }, options?: { signal?: AbortSignal }): Promise<number | undefined> {
    const signal = options?.signal
    if (signal?.aborted || typeof path !== 'string' || !path || path.includes('\0')) return undefined
    // Exact caller identity; neither a basename, resolved cwd nor an mtime is a key.
    let owner: SessionTokenOwner
    try { owner = snapshotSessionTokenOwner(expected) } catch { return undefined }
    const key = JSON.stringify([path, owner.id, owner.cwd])
    let entry = this.entries.get(key)
    // Different ownership claims share the path's actual read/close admission.
    if (!entry?.pending && this.pendingPaths.has(path)) return undefined
    if (!entry) {
      for (const [oldKey, oldEntry] of this.entries) {
        if (this.entries.size < this.maxEntries) break
        if (!oldEntry.pending) this.entries.delete(oldKey)
      }
      // Actual readers retain capacity through their real close settlement.
      if (this.entries.size >= this.maxEntries) return undefined
      entry = {}
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (!entry.pending) {
      this.pendingPaths.add(path)
      const current = entry
      current.pending = Promise.resolve().then(() => readSessionTokenSnapshot(path, owner, {
        filesystem: this.filesystem, previous: current.snapshot
      })).then(snapshot => {
        current.snapshot = snapshot
        return snapshot.total
      }, () => {
        current.snapshot = undefined
        return undefined
      }).finally(() => { current.pending = undefined; this.pendingPaths.delete(path) })
    }
    // Cancellation retires this caller only, after the actual read/finally/close.
    // Other callers may still need the same validated, in-flight snapshot.
    const total = await entry.pending
    return signal?.aborted ? undefined : total
  }
}
