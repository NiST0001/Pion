import {
  SUBAGENT_SESSION_WIDGET_KEY, SUBAGENT_SESSION_RETENTION_MS, SUBAGENT_SESSION_MAX_ROWS,
  SUBAGENT_SESSION_MAX_CHARS, SUBAGENT_SESSION_MAX_PACKET_CHARS, SUBAGENT_SESSION_MAX_RECORDS
} from '../../shared/subagent-sessions'
import type {
  SubagentSessionNotice, SubagentSessionRow, SubagentSessionSnapshot, SubagentSessionSummary,
  SubagentSessionList, SubagentSessionStatus
} from '../../shared/subagent-sessions'

interface Scope { backendId: string; nonce: string; cwd: string; parentSessionPath?: string }
interface RecordState {
  snapshot: SubagentSessionSnapshot
  /** Immutable producer identity; a later main binding only changes the display path. */
  sourcePath?: string
  packetRevision: number
  deadline?: number
}
interface BackendState { cwd: string; nonce: string; path?: string; runtime?: string; retired: Set<string>; gone: boolean }
const statuses = new Set(['starting', 'running', 'cancelling', 'completed', 'failed', 'aborted'])
const terminal = (status: SubagentSessionStatus) => status === 'completed' || status === 'failed' || status === 'aborted'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key))
const recordKey = (backendId: string, id: string) => JSON.stringify([backendId, id])

function parse(lines: unknown): SubagentSessionNotice | undefined {
  if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string' || lines[0].length > SUBAGENT_SESSION_MAX_PACKET_CHARS) return
  let value: unknown
  try { value = JSON.parse(lines[0]) } catch { return }
  if (!object(value) || !keys(value, ['version', 'nonce', 'source', 'runtimeId', 'id', 'parentToolCallId', 'parentSessionId', 'parentSessionPath', 'cwd', 'name', 'revision', 'status', 'truncated', 'rows'])
    || value.version !== 1 || value.source !== 'sdk:pion_subagents'
    || !string(value.nonce, 256) || !string(value.runtimeId, 256) || !string(value.id, 256)
    || !string(value.parentToolCallId, 256) || !string(value.parentSessionId, 256)
    || !string(value.cwd, 4096) || !string(value.name, 256)
    || (value.parentSessionPath !== undefined && !string(value.parentSessionPath, 4096))
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.status !== 'string' || !statuses.has(value.status) || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.rows) || value.rows.length > SUBAGENT_SESSION_MAX_ROWS) return
  const rows: SubagentSessionRow[] = []
  const ids = new Set<string>()
  let chars = 0
  for (const row of value.rows) {
    if (!object(row) || !keys(row, ['id', 'kind', 'text', 'toolName', 'state'])
      || !string(row.id, 256) || ids.has(row.id) || !['assistant', 'thinking', 'tool'].includes(row.kind as string)
      || typeof row.text !== 'string' || row.text.length > SUBAGENT_SESSION_MAX_CHARS
      || (row.toolName !== undefined && !string(row.toolName, 256))
      || (row.state !== undefined && !['running', 'completed', 'failed'].includes(row.state as string))) return
    chars += row.id.length + row.text.length + (typeof row.toolName === 'string' ? row.toolName.length : 0)
    if (chars > SUBAGENT_SESSION_MAX_CHARS) return
    ids.add(row.id)
    rows.push({ id: row.id, kind: row.kind as SubagentSessionRow['kind'], text: row.text,
      ...(row.toolName !== undefined ? { toolName: row.toolName as string } : {}),
      ...(row.state !== undefined ? { state: row.state as SubagentSessionRow['state'] } : {}) })
  }
  return { version: 1, source: 'sdk:pion_subagents', nonce: value.nonce, runtimeId: value.runtimeId,
    id: value.id, parentToolCallId: value.parentToolCallId, parentSessionId: value.parentSessionId,
    ...(value.parentSessionPath !== undefined ? { parentSessionPath: value.parentSessionPath as string } : {}),
    cwd: value.cwd, name: value.name, revision: value.revision as number,
    status: value.status as SubagentSessionStatus, truncated: value.truncated, rows }
}

/** Display-only in-memory store. The caller must fence captured backend/client ownership.
 * Nonce/source plus native start receipts are logical provenance, not an OS/plugin boundary.
 * No eviction before retention ends. Capacity bounds current records;
 * source replay fences live only as long as their real native root receipt.
 */
export class SubagentSessionStore {
  private records = new Map<string, RecordState>()
  private backends = new Map<string, BackendState>()
  private sources = new WeakMap<object, { runtime: string; seenChildIds: Set<string> }>()
  private revision = 0
  private clock = 0
  private disposed = false
  private timer: ReturnType<typeof setInterval>

  constructor(private onChanged: () => void = () => {}, private now: () => number = () => performance.now()) {
    this.timer = setInterval(() => this.expire(), 1000)
    this.timer.unref?.()
  }

  private time(): number {
    const now = this.now()
    if (Number.isFinite(now)) this.clock = Math.max(this.clock, now)
    return this.clock
  }
  private changed(): void { this.revision++; this.onChanged() }
  private expire(): void {
    if (this.disposed) return
    const now = this.time()
    let changed = false
    for (const [key, record] of this.records) {
      if (record.deadline === undefined || now < record.deadline) continue
      this.records.delete(key)
      changed = true
    }
    this.pruneSources()
    if (changed) this.changed()
  }

  private pruneSources(prunePlaceholders = false): void {
    const retained = new Map<string, Set<string>>()
    for (const { snapshot } of this.records.values()) {
      let runtimes = retained.get(snapshot.backendId)
      if (!runtimes) retained.set(snapshot.backendId, runtimes = new Set())
      runtimes.add(snapshot.runtimeId)
    }
    for (const [id, backend] of this.backends) {
      const runtimes = retained.get(id)
      // Retained children keep their runtime fence; new sources need a live root.
      backend.retired = new Set([...(runtimes ?? [])].filter((runtime) => runtime !== backend.runtime))
      if (!runtimes && (backend.gone || (prunePlaceholders && backend.runtime === undefined))) this.backends.delete(id)
    }
  }

  consume(scope: Scope, event: unknown, getSourceReceipt: (parentToolCallId: string) => object | undefined,
    onSource: (runtimeId: string) => void = () => {}): boolean {
    // The reserved key is always swallowed, even if its outer event is malformed.
    if (!object(event) || event.widgetKey !== SUBAGENT_SESSION_WIDGET_KEY) return false
    if (this.disposed) return true
    this.expire()
    if (event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.parentToolCallId !== undefined) return true
    const notice = parse(event.widgetLines)
    if (!notice || !string(scope.backendId, 256) || !string(scope.nonce, 256) || !string(scope.cwd, 4096)
      || (scope.parentSessionPath !== undefined && !string(scope.parentSessionPath, 4096))
      || notice.nonce !== scope.nonce || notice.cwd !== scope.cwd) return true
    let backend = this.backends.get(scope.backendId)
    if (backend && (backend.gone || (backend.cwd !== '' && backend.cwd !== scope.cwd) || (backend.nonce !== '' && backend.nonce !== scope.nonce)
      || backend.retired.has(notice.runtimeId))) return true
    const key = recordKey(scope.backendId, notice.id)
    const existing = this.records.get(key)
    // The producer may publish its first packet after main has learned the path.
    // Keep the original absent source path separate from the bound display path.
    const lateBoundSource = notice.parentSessionPath === undefined && (!existing || existing.sourcePath === undefined)
    if ((scope.parentSessionPath !== undefined && notice.parentSessionPath !== scope.parentSessionPath && !lateBoundSource)
      || (backend?.path !== undefined && notice.parentSessionPath !== backend.path && !lateBoundSource)
      || (scope.parentSessionPath !== undefined && backend?.path !== undefined && scope.parentSessionPath !== backend.path)) return true
    if (existing) {
      const old = existing.snapshot
      if (existing.deadline !== undefined || backend?.runtime !== notice.runtimeId
        || old.runtimeId !== notice.runtimeId || old.parentToolCallId !== notice.parentToolCallId
        || old.parentSessionId !== notice.parentSessionId || old.cwd !== notice.cwd
        || existing.sourcePath !== notice.parentSessionPath || old.name !== notice.name
        || notice.revision <= existing.packetRevision) return true
    } else {
      if (notice.status !== 'starting' || this.records.size >= SUBAGENT_SESSION_MAX_RECORDS) return true
      if (!backend && this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) this.pruneSources(true)
      if (!backend && this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) return true
      const receipt = getSourceReceipt(notice.parentToolCallId)
      if (!receipt) return true
      let source = this.sources.get(receipt)
      if (source && (source.runtime !== notice.runtimeId || source.seenChildIds.has(key))) return true
      if (!source) this.sources.set(receipt, source = { runtime: notice.runtimeId, seenChildIds: new Set() })
      source.seenChildIds.add(key)
      if (!backend) {
        backend = { cwd: scope.cwd, nonce: scope.nonce, retired: new Set(), gone: false }
        this.backends.set(scope.backendId, backend)
      }
      if (backend.runtime !== undefined && backend.runtime !== notice.runtimeId) this.retireRecords(scope.backendId, false)
      backend.cwd = scope.cwd
      backend.nonce = scope.nonce
      backend.path ??= scope.parentSessionPath ?? notice.parentSessionPath
      backend.runtime = notice.runtimeId
      this.pruneSources()
      onSource(notice.runtimeId)
    }
    const snapshot: SubagentSessionSnapshot = {
      id: notice.id, backendId: scope.backendId, runtimeId: notice.runtimeId,
      parentToolCallId: notice.parentToolCallId, cwd: notice.cwd, parentSessionId: notice.parentSessionId,
      ...((backend?.path ?? notice.parentSessionPath) !== undefined ? { parentSessionPath: backend?.path ?? notice.parentSessionPath } : {}),
      name: notice.name, status: notice.status, revision: (existing?.snapshot.revision ?? 0) + 1, truncated: notice.truncated, rows: notice.rows
    }
    this.records.set(key, { snapshot, sourcePath: notice.parentSessionPath, packetRevision: notice.revision,
      ...(terminal(notice.status) ? { deadline: this.time() + SUBAGENT_SESSION_RETENTION_MS } : {}) })
    this.changed()
    return true
  }

  private summary(record: RecordState): SubagentSessionSummary {
    const { rows: _rows, ...summary } = record.snapshot
    return { ...summary, ...(record.deadline !== undefined ? { retentionRemainingMs: Math.max(0, record.deadline - this.time()) } : {}) }
  }
  list(): SubagentSessionList {
    this.expire()
    return { revision: this.revision, sessions: [...this.records.values()].map((record) => this.summary(record)) }
  }
  get(id: string, backendId: string): SubagentSessionSnapshot | null {
    this.expire()
    const record = this.records.get(recordKey(backendId, id))
    return record ? { ...this.summary(record), rows: record.snapshot.rows.map((row) => ({ ...row })) } : null
  }
  bindParent(backendId: string, path: string): void {
    if (this.disposed || !string(path, 4096)) return
    this.expire()
    if (!string(backendId, 256)) return
    let backend = this.backends.get(backendId)
    if (!backend) {
      if (this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) this.pruneSources(true)
      if (this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) return
      backend = { cwd: '', nonce: '', path, retired: new Set(), gone: false }
      this.backends.set(backendId, backend)
    }
    if (backend.path !== undefined && backend.path !== path) return
    if ([...this.records.values()].some((record) => record.snapshot.backendId === backendId
      && record.sourcePath !== undefined && record.sourcePath !== path)) return
    backend.path = path
    let changed = false
    for (const record of this.records.values()) {
      if (record.snapshot.backendId === backendId && record.snapshot.parentSessionPath !== path) {
        record.snapshot.parentSessionPath = path
        record.snapshot.revision++
        changed = true
      }
    }
    if (changed) this.changed()
  }
  markBackendGone(backendId: string, exitConfirmed: boolean): void {
    if (this.disposed || !string(backendId, 256)) return
    this.expire()
    const backend = this.backends.get(backendId)
    if (backend) backend.gone = true
    const changed = this.retireRecords(backendId, exitConfirmed)
    this.pruneSources()
    if (changed) this.changed()
  }
  /** Called only with the captured runtime's real retirement/exit receipt.
   * A new runtime's first packet leaves old in-flight children uncertain. */
  markRuntimeGone(backendId: string, runtimeId: string, exitConfirmed: boolean): void {
    if (this.disposed || !string(backendId, 256) || !string(runtimeId, 256)) return
    this.expire()
    const backend = this.backends.get(backendId)
    if (backend?.runtime === runtimeId) backend.runtime = undefined
    const changed = this.retireRecords(backendId, exitConfirmed, runtimeId)
    this.pruneSources()
    if (changed) this.changed()
  }
  private retireRecords(backendId: string, exitConfirmed: boolean, runtimeId?: string): boolean {
    let changed = false
    for (const record of this.records.values()) {
      const { snapshot } = record
      if (snapshot.backendId !== backendId || record.deadline !== undefined || (runtimeId !== undefined && snapshot.runtimeId !== runtimeId)) continue
      const status = exitConfirmed ? 'aborted' : 'cancelling'
      if (snapshot.status === status && !exitConfirmed) continue
      snapshot.status = status
      snapshot.revision++
      if (exitConfirmed) record.deadline = this.time() + SUBAGENT_SESSION_RETENTION_MS
      changed = true
    }
    return changed
  }
  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.records.clear()
    this.backends.clear()
    this.sources = new WeakMap()
  }
}
