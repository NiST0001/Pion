import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  RunOperation,
  RunOperationState,
  RunTelemetryQuery,
  TokenUsage
} from '../shared/operations'

interface RunStoreFile {
  version: 1
  runs: RunOperation[]
}

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
        } else if (run.state === 'queued' && run.interruptedAt === undefined) {
          run.interruptedAt = Date.now()
          run.error = run.error ?? 'Pion 重启前这条消息仍在队列中，尚未确认执行。'
          run.revision += 1
          recovered = true
        }
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
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(cloneRun)
  }

  update(id: string, mutate: (run: RunOperation) => void): RunOperation | null {
    const run = this.runs.get(id)
    if (!run) return null
    mutate(run)
    run.revision += 1
    this.changed(run)
    return cloneRun(run)
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
