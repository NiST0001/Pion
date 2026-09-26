import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  RunOperation,
  RunOperationState,
  RunTelemetryQuery,
  TokenUsage
} from '../shared/operations'

import { addTokenUsage, normalizeTokenUsage } from './agent/utils'
import { compareMetricsRuns, isRunMetricsCandidate } from '../shared/operations'

interface RunStoreFile {
  version: 1
  runs: RunOperation[]
  usageReceipts?: { key: string; at: number }[]
  usageReplayFloor?: number
}

export const MAX_USAGE_RECEIPTS = 2048
const MAX_PERSISTED_RUNS = 250
const WRITE_DEBOUNCE_MS = 300
const ACTIVE_STATES = new Set<RunOperationState>(['dispatching', 'running', 'ending'])

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  costUsd: 0
}

function cloneRun(run: RunOperation): RunOperation {
  return structuredClone(run)
}

function normalizeRun(value: unknown): RunOperation | null {
  if (!value || typeof value !== 'object') return null
  const run = value as Partial<RunOperation>
  if (typeof run.id !== 'string' || typeof run.cwd !== 'string' || typeof run.createdAt !== 'number') {
    return null
  }
  const state: RunOperationState = typeof run.state === 'string'
    ? run.state as RunOperationState
    : 'interrupted'
  return {
    id: run.id,
    cwd: resolve(run.cwd),
    sessionPath: typeof run.sessionPath === 'string' ? resolve(run.sessionPath) : undefined,
    sessionId: run.sessionId,
    usageBackendId: typeof run.usageBackendId === 'string' ? run.usageBackendId : undefined,
    kind: run.kind ?? 'prompt',
    state,
    createdAt: run.createdAt,
    dispatchedAt: run.dispatchedAt,
    agentStartedAt: run.agentStartedAt,
    agentEndedAt: run.agentEndedAt,
    settledAt: run.settledAt,
    interruptedAt: run.interruptedAt,
    provider: run.provider,
    modelId: run.modelId,
    contextWindow: run.contextWindow,
    prompt: run.prompt && typeof run.prompt.message === 'string'
      ? { message: run.prompt.message, images: Array.isArray(run.prompt.images) ? run.prompt.images : [] }
      : { message: '', images: [] },
    promptPreview: typeof run.promptPreview === 'string' ? run.promptPreview : '',
    recoveredFromRunId: run.recoveredFromRunId,
    checkpoint: run.checkpoint && typeof run.checkpoint.id === 'string'
      ? { ...run.checkpoint }
      : undefined,
    usage: { ...EMPTY_TOKEN_USAGE, ...(run.usage ?? {}) },
    liveUsage: run.liveUsage ? { ...EMPTY_TOKEN_USAGE, ...run.liveUsage } : undefined,
    contextTokens: run.contextTokens,
    contextPressure: run.contextPressure,
    contextUsagePending: run.contextUsagePending === true,
    tools: Array.isArray(run.tools) ? run.tools : [],
    compactions: Array.isArray(run.compactions) ? run.compactions : [],
    stopReason: run.stopReason,
    error: run.error,
    revision: typeof run.revision === 'number' ? run.revision : 0
  }
}

/** Atomic, bounded ledger for Agent runs and recovery intents. */
export class RunStore {
  private readonly runs = new Map<string, RunOperation>()
  private readonly listeners = new Set<(run: RunOperation) => void>()
  readonly filePath: string
  private readonly usageReceipts = new Map<string, number>()
  private usageReplayFloor = 0
  private loaded = false
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = resolve(filePath)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let recovered = false
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      const values = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as RunStoreFile).runs)
        ? (parsed as RunStoreFile).runs
        : []
      const ledger = parsed && typeof parsed === 'object' ? parsed as Partial<RunStoreFile> : {}
      const floor = ledger.usageReplayFloor
      this.usageReplayFloor = typeof floor === 'number' && Number.isFinite(floor) && floor >= 0 ? floor : 0
      for (const receipt of Array.isArray(ledger.usageReceipts) ? ledger.usageReceipts : []) {
        if (receipt && typeof receipt.key === 'string' && Number.isFinite(receipt.at)) this.usageReceipts.set(receipt.key, receipt.at)
      }
      this.trimUsageReceipts()
      for (const value of values) {
        const run = normalizeRun(value)
        if (!run) continue
        if (ACTIVE_STATES.has(run.state)) {
          const now = Date.now()
          run.state = 'interrupted'
          run.interruptedAt = now
          run.error = run.error ?? 'Pion 在本轮完成前退出；为避免重复工具副作用，未自动重放。'
          run.liveUsage = undefined
          run.tools = run.tools.map((tool) => tool.state === 'running'
            ? { ...tool, state: 'interrupted', endedAt: now, durationMs: Math.max(0, now - tool.startedAt) }
            : tool)
          run.revision += 1
          recovered = true
        }
        // Queued prompts never ran a tool: they stay queued and are restored
        // into the live queue when their session activates again.
        this.runs.set(run.id, run)
      }
      this.trim()
    } catch {
      // Missing or malformed ledgers start empty.
    }
    if (recovered) await this.flush()
  }

  onChanged(listener: (run: RunOperation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  create(run: RunOperation): RunOperation {
    const normalized = normalizeRun(run)
    if (!normalized) throw new Error('无效的运行记录')
    this.runs.set(normalized.id, normalized)
    this.trim()
    this.changed(normalized)
    return cloneRun(normalized)
  }

  get(id: string): RunOperation | null {
    const run = this.runs.get(id)
    return run ? cloneRun(run) : null
  }

  list(query: RunTelemetryQuery = {}): RunOperation[] {
    const sessionPath = query.sessionPath ? resolve(query.sessionPath) : undefined
    const cwd = query.cwd ? resolve(query.cwd) : undefined
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100))
    return [...this.runs.values()]
      .filter((run) => !sessionPath || run.sessionPath === sessionPath)
      .filter((run) => !cwd || run.cwd === cwd)
      .filter((run) => !query.metricsOnly || isRunMetricsCandidate(run))
      .sort(query.metricsOnly ? compareMetricsRuns : (left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(cloneRun)
  }

  /** Safety gates must examine the entire bounded ledger, not a display page. */
  hasUnsettledSessionRuns(sessionPath: string): boolean {
    const target = resolve(sessionPath)
    return [...this.runs.values()].some((run) => run.sessionPath === target
      && (run.state === 'queued' || ACTIVE_STATES.has(run.state)))
  }

  update(id: string, mutate: (run: RunOperation) => void): RunOperation | null {
    const run = this.runs.get(id)
    if (!run) return null
    mutate(run)
    run.revision += 1
    this.changed(run)
    return cloneRun(run)
  }

  /** Account SDK standalone usage, never streaming/context occupancy. The SDK JSONL
   * remains authoritative when there is no retained dispatched run (external or
   * trimmed history); we neither invent a run nor attach that cost to a future one.
   */
  recordUsageEntry(source: { cwd: string; sessionPath?: string; backendId?: string }, event: unknown): RunOperation | null {
    if (!source.sessionPath || !source.backendId || !event || typeof event !== 'object') return null
    const envelope = event as { type?: string; entry?: unknown }
    if (envelope.type !== 'entry_appended' || !envelope.entry || typeof envelope.entry !== 'object') return null
    const entry = envelope.entry as { type?: string; id?: string; kind?: string; timestamp?: string; provider?: string; model?: string; usage?: unknown }
    if (entry.type !== 'usage' || typeof entry.id !== 'string' || !entry.id || typeof entry.timestamp !== 'string'
      || typeof entry.kind !== 'string' || !entry.kind || typeof entry.provider !== 'string' || !entry.provider
      || typeof entry.model !== 'string' || !entry.model) return null
    const at = Date.parse(entry.timestamp)
    const usage = normalizeTokenUsage(entry.usage)
    if (!Number.isFinite(at) || at <= this.usageReplayFloor || !usage) return null
    const sessionPath = resolve(source.sessionPath)
    const key = JSON.stringify([sessionPath, entry.id])
    if (this.usageReceipts.has(key)) return null
    // Timestamp is the entry's persistence time, not delivery time. In particular
    // an old entry must not be charged to a newer dispatched/queued prompt.
    const target = [...this.runs.values()]
      .filter((run) => run.cwd === resolve(source.cwd) && run.sessionPath === sessionPath
        && run.usageBackendId === source.backendId && run.provider === entry.provider
        // cache_warm records the server's responseModel, which may be a dated
        // alias/fallback rather than the configured model ID. The SDK validates
        // the warming request against its current context before emitting it.
        && (entry.kind === 'cache_warm' || run.modelId === entry.model)
        && run.state !== 'queued' && (run.dispatchedAt ?? run.agentStartedAt) !== undefined
        && (run.dispatchedAt ?? run.agentStartedAt)! <= at)
      .sort((a, b) => (b.dispatchedAt ?? b.agentStartedAt)! - (a.dispatchedAt ?? a.agentStartedAt)!)[0]
    // Remember even out-of-window entries so later queue dispatch cannot adopt them.
    this.usageReceipts.set(key, at)
    this.trimUsageReceipts()
    this.scheduleWrite()
    return target ? this.update(target.id, (run) => { run.usage = addTokenUsage(run.usage, usage) }) : null
  }

  private trimUsageReceipts(): void {
    if (this.usageReceipts.size <= MAX_USAGE_RECEIPTS) return
    const sorted = [...this.usageReceipts.entries()].sort((a, b) => a[1] - b[1])
    this.usageReplayFloor = Math.max(this.usageReplayFloor, sorted[sorted.length - MAX_USAGE_RECEIPTS - 1][1])
    // Conservative replay policy: reject ALL entries at/below the discarded
    // timestamp, including previously unseen late entries and equal-time ties.
    // Unlike FIFO this never re-bills an evicted receipt; it can undercount late
    // usage across sessions. Full billing history remains in SDK session JSONL.
    for (const [key, at] of this.usageReceipts) if (at <= this.usageReplayFloor) this.usageReceipts.delete(key)
  }

  async markInterrupted(id: string, message?: string): Promise<RunOperation | null> {
    const now = Date.now()
    const run = this.update(id, (current) => {
      if (!ACTIVE_STATES.has(current.state)) return
      current.state = 'interrupted'
      current.interruptedAt = now
      current.liveUsage = undefined
      current.error = message ?? '运行在完成前中断。'
      current.tools = current.tools.map((tool) => tool.state === 'running'
        ? { ...tool, state: 'interrupted', endedAt: now, durationMs: Math.max(0, now - tool.startedAt) }
        : tool)
    })
    await this.flush()
    return run
  }

  private changed(run: RunOperation): void {
    const snapshot = cloneRun(run)
    for (const listener of this.listeners) listener(snapshot)
    this.scheduleWrite()
  }

  private trim(): void {
    if (this.runs.size <= MAX_PERSISTED_RUNS) return
    const oldestTerminal = [...this.runs.values()]
      .filter((run) => !ACTIVE_STATES.has(run.state) && run.state !== 'queued')
      .sort((left, right) => left.createdAt - right.createdAt)
    while (this.runs.size > MAX_PERSISTED_RUNS && oldestTerminal.length > 0) {
      const victim = oldestTerminal.shift()
      if (victim) this.runs.delete(victim.id)
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, WRITE_DEBOUNCE_MS)
  }

  flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const target = this.filePath
    const temp = `${target}.${randomUUID()}.tmp`
    const payload: RunStoreFile = {
      version: 1,
      usageReceipts: [...this.usageReceipts].map(([key, at]) => ({ key, at })),
      usageReplayFloor: this.usageReplayFloor,
      runs: [...this.runs.values()].sort((left, right) => left.createdAt - right.createdAt)
    }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temp, serialized, 'utf8')
      await rename(temp, target)
    })
    this.writeQueue = write.catch((error) => {
      console.error('[pion] failed to persist run ledger:', error)
    })
    return write
  }
}
