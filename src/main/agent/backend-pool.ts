import type { BackendRecord } from './types'
import { MAX_RETAINED_BACKENDS } from './constants'

/**
 * Owns the global retained-backend pool. AgentBridge supplies lifecycle
 * callbacks so eviction remains responsible for cancelling runs and clearing
 * UI requests, while pool ordering/concurrency stays independent of IPC.
 */
export class BackendPool {
  private readonly records = new Map<string, BackendRecord>()
  private readonly order: string[] = []
  private readonly starts = new Map<string, Promise<BackendRecord>>()
  private queue: Promise<void> = Promise.resolve()

  get size(): number {
    return this.records.size
  }

  get pendingStartCount(): number {
    return this.starts.size
  }

  get(key: string): BackendRecord | undefined {
    return this.records.get(key)
  }

  values(): IterableIterator<BackendRecord> {
    return this.records.values()
  }

  keys(): IterableIterator<string> {
    return this.records.keys()
  }

  getStart(key: string): Promise<BackendRecord> | undefined {
    return this.starts.get(key)
  }

  add(backend: BackendRecord): void {
    if (!this.records.has(backend.key)) this.order.push(backend.key)
    this.records.set(backend.key, backend)
  }

  delete(key: string): boolean {
    const deleted = this.records.delete(key)
    const index = this.order.indexOf(key)
    if (index >= 0) this.order.splice(index, 1)
    return deleted
  }

  clear(): void {
    this.records.clear()
    this.order.length = 0
    this.starts.clear()
    this.queue = Promise.resolve()
  }

  pendingStarts(): Promise<BackendRecord>[] {
    return [...this.starts.values()]
  }

  /** Stop the oldest idle backend until there is room for one more. */
  async evictOldest(
    excludeKey: string | undefined,
    stopBackend: (key: string) => Promise<void>
  ): Promise<void> {
    while (this.records.size >= MAX_RETAINED_BACKENDS) {
      const victim = this.order.find((key) => {
        if (key === excludeKey) return false
        const backend = this.records.get(key)
        return Boolean(
          backend
          && !backend.busy
          && backend.phase !== 'starting'
          && backend.pendingRunIds.length === 0
          && !backend.localQueueDispatching
          && !backend.runCompletionPromise
        )
      })
      if (!victim) throw new Error('后台运行会话已达上限，请等待一个会话完成后再打开新会话')
      console.log('[pion] evicting oldest session backend:', victim)
      await stopBackend(victim)
    }
  }

  /** Serialize backend starts so concurrent selections cannot exceed the pool limit. */
  startWithLimit(
    key: string,
    createBackend: () => Promise<BackendRecord>,
    isStopping: () => boolean,
    stopBackend: (key: string) => Promise<void>
  ): Promise<BackendRecord> {
    const existing = this.starts.get(key)
    if (existing) return existing

    const start = this.queue.then(async () => {
      if (isStopping()) throw new Error('agent 正在停止')
      await this.evictOldest(key, stopBackend)
      return createBackend()
    })
    this.starts.set(key, start)
    const clear = (): void => {
      if (this.starts.get(key) === start) this.starts.delete(key)
    }
    void start.then(clear, clear)
    this.queue = start.then(() => undefined, () => undefined)
    return start
  }
}
