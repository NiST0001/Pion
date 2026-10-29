import { resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'

export interface SessionListTokenTotals {
  read: (session: SessionMeta, cwd: string) => Promise<number | undefined>
  capturePublish: (cwd: string) => ((sessions: SessionMeta[]) => void) | undefined
}

interface TokenSource {
  value: SessionMeta[]
  revision: number
  dirtyRevision: number
}

interface Entry {
  revision: number
  dirtyRevision: number
  expires: number
  value?: SessionMeta[]
  pending?: Promise<SessionMeta[]>
  totalsPending?: Promise<void>
  totalsSource?: TokenSource
  publish?: (sessions: SessionMeta[]) => void
}

/** Cache only the sidebar projection, never SDK allMessagesText or mutable managers. */
export class SessionListCache {
  private readonly entries = new Map<string, Entry>()
  private active = 0
  private readonly waiters: Array<() => void> = []
  private activeTotals = 0
  private readonly totalsQueue = new Map<Entry, string>()

  constructor(
    private readonly load: (cwd: string) => Promise<SessionMeta[]>,
    private readonly now: () => number = Date.now,
    private readonly ttl = 1500,
    private readonly maxEntries = 64,
    private readonly totals?: SessionListTokenTotals
  ) {}

  invalidate(cwd: string, options?: { soft?: true }): void {
    const entry = this.entries.get(resolve(cwd))
    if (entry) {
      if (options?.soft) entry.dirtyRevision += 1
      else entry.revision += 1
      entry.expires = 0
      entry.totalsSource = undefined
      this.totalsQueue.delete(entry)
    }
  }

  async list(cwd: string): Promise<SessionMeta[]> {
    const key = resolve(cwd)
    let entry = this.entries.get(key)
    if (!entry) {
      // Real scans and token readers retain identity until their work settles.
      for (const [oldKey, oldEntry] of this.entries) {
        if (this.entries.size < this.maxEntries) break
        if (!oldEntry.pending && !oldEntry.totalsPending) {
          this.entries.delete(oldKey)
          this.totalsQueue.delete(oldEntry)
        }
      }
      // Pending work retains its slots; do not grow the cwd map without bound.
      if (this.entries.size >= this.maxEntries) throw new Error('Session list cache is busy; retry discovery later')
      entry = { revision: 0, dirtyRevision: 0, expires: 0 }
      this.entries.set(key, entry)
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    // A new window must explicitly read this cwd before it can receive totals.
    entry.publish = this.totals?.capturePublish(key)
    if (entry.value && entry.expires > this.now()) return entry.value.map((item) => ({ ...item }))
    if (!entry.pending) {
      const captured = entry
      // Even a failed newer scan makes the previous token source obsolete.
      captured.totalsSource = undefined
      this.totalsQueue.delete(captured)
      captured.pending = (async () => {
        const initialDirtyRevision = captured.dirtyRevision
        let softRescanned = false
        let hardRetries = 0
        while (true) {
          const revision = captured.revision
          const dirtyRevision = captured.dirtyRevision
          const value = await this.scan(key)
          // Hard mutations must not resurrect deleted/renamed rows. Bound the
          // retries and reject rather than publishing stale data under churn.
          if (revision !== captured.revision) {
            if (++hardRetries > 3) throw new Error('Session list changed repeatedly during discovery; retry later')
            continue
          }
          // Persistence can happen after an initial empty scan starts. Allow
          // one reread, but ongoing message completions must not starve callers.
          if (dirtyRevision !== captured.dirtyRevision && !softRescanned) {
            softRescanned = true
            continue
          }
          captured.value = value.map((item) => ({ ...item }))
          captured.expires = initialDirtyRevision === captured.dirtyRevision ? this.now() + this.ttl : 0
          if (this.totals && captured.value.length) {
            captured.totalsSource = { value: captured.value, revision, dirtyRevision }
          }
          return captured.value
        }
      })().finally(() => {
        captured.pending = undefined
        this.queueTotals(key, captured)
        // Bound settled entries even if many different cwd requests overlapped.
        for (const [oldKey, oldEntry] of this.entries) {
          if (this.entries.size <= this.maxEntries) break
          if (!oldEntry.pending && !oldEntry.totalsPending) {
            this.entries.delete(oldKey)
            this.totalsQueue.delete(oldEntry)
          }
        }
      })
    }
    // Failures reject rather than disguising a stale/unknown list as empty.
    return (await entry.pending!).map((item) => ({ ...item }))
  }

  private isCurrentSource(cwd: string, entry: Entry, source: TokenSource): boolean {
    return this.entries.get(cwd) === entry && entry.totalsSource === source &&
      entry.value === source.value && entry.revision === source.revision &&
      entry.dirtyRevision === source.dirtyRevision
  }

  private queueTotals(cwd: string, entry: Entry): void {
    if (!entry.totalsPending && entry.totalsSource) this.totalsQueue.set(entry, cwd)
    this.drainTotals()
  }

  private drainTotals(): void {
    // Token batches use separate slots: slow files cannot hold SDK scan slots.
    while (this.activeTotals < 4 && this.totalsQueue.size) {
      const [entry, cwd] = this.totalsQueue.entries().next().value!
      this.totalsQueue.delete(entry)
      const source = entry.totalsSource
      if (!source || !this.isCurrentSource(cwd, entry, source)) continue
      this.activeTotals += 1
      // Install the pending receipt before invoking even a synchronous reader.
      entry.totalsPending = Promise.resolve().then(() => this.readTotals(cwd, entry, source)).finally(() => {
        entry.totalsPending = undefined
        this.activeTotals -= 1
        if (entry.totalsSource === source) entry.totalsSource = undefined
        // Only the latest accepted scan survives while an older batch settles.
        this.queueTotals(cwd, entry)
      })
    }
  }

  private async readTotals(cwd: string, entry: Entry, source: TokenSource): Promise<void> {
    const totals: Array<number | undefined> = new Array(source.value.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, source.value.length) }, async () => {
      while (next < source.value.length && this.isCurrentSource(cwd, entry, source)) {
        const index = next++
        try {
          totals[index] = await this.totals!.read({ ...source.value[index]! }, cwd)
        } catch {
          // Unknown for this row only. Other actual reader promises still own
          // their workers and the directory slot until every worker settles.
        }
      }
    }))
    if (!this.isCurrentSource(cwd, entry, source) || !totals.some((total) => total !== undefined)) return
    const value = source.value.map((item, index) => totals[index] === undefined
      ? { ...item }
      : { ...item, totalTokens: totals[index] })
    entry.value = value
    try {
      entry.publish?.(value.map((item) => ({ ...item })))
    } catch {
      // A destroyed window or throwing subscriber must not reject background
      // work or turn a successfully discovered list into an empty result.
    }
  }

  private async scan(cwd: string): Promise<SessionMeta[]> {
    if (this.active >= 4) await new Promise<void>((accept) => this.waiters.push(accept))
    else this.active += 1
    try {
      return await this.load(cwd)
    } finally {
      const next = this.waiters.shift()
      if (next) next() // hand the slot directly to the oldest waiting scan
      else this.active -= 1
    }
  }
}
