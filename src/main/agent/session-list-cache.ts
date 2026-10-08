import { resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'

interface Entry {
  revision: number
  dirtyRevision: number
  expires: number
  value?: SessionMeta[]
  pending?: Promise<SessionMeta[]>
}

/** Cache only the sidebar projection, never SDK allMessagesText or mutable managers. */
export class SessionListCache {
  private readonly entries = new Map<string, Entry>()
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly load: (cwd: string) => Promise<SessionMeta[]>,
    private readonly now: () => number = Date.now,
    private readonly ttl = 1500,
    private readonly maxEntries = 64
  ) {}

  invalidate(cwd: string, options?: { soft?: true }): void {
    const entry = this.entries.get(resolve(cwd))
    if (entry) {
      if (options?.soft) entry.dirtyRevision += 1
      else entry.revision += 1
      entry.expires = 0
    }
  }

  async list(cwd: string): Promise<SessionMeta[]> {
    const key = resolve(cwd)
    let entry = this.entries.get(key)
    if (!entry) {
      // In-flight entries must retain their identity until the real scan ends.
      for (const [oldKey, oldEntry] of this.entries) {
        if (this.entries.size < this.maxEntries) break
        if (!oldEntry.pending) this.entries.delete(oldKey)
      }
      // Pending scans retain their slots; do not grow the cwd map without bound.
      if (this.entries.size >= this.maxEntries) throw new Error('Session list cache is busy; retry discovery later')
      entry = { revision: 0, dirtyRevision: 0, expires: 0 }
      this.entries.set(key, entry)
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (entry.value && entry.expires > this.now()) return entry.value.map((item) => ({ ...item }))
    if (!entry.pending) {
      const captured = entry
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
          return captured.value
        }
      })().finally(() => {
        captured.pending = undefined
        // Bound settled entries even if many different cwd requests overlapped.
        for (const [oldKey, oldEntry] of this.entries) {
          if (this.entries.size <= this.maxEntries) break
          if (!oldEntry.pending) this.entries.delete(oldKey)
        }
      })
    }
    // Failures reject rather than disguising a stale/unknown list as empty.
    return (await entry.pending!).map((item) => ({ ...item }))
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
