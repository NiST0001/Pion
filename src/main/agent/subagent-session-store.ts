import {
  SUBAGENT_SESSION_WIDGET_KEY, SUBAGENT_SESSION_RETENTION_MS, SUBAGENT_SESSION_MAX_ROWS,
  SUBAGENT_SESSION_MAX_CHARS, SUBAGENT_SESSION_MAX_PACKET_CHARS, SUBAGENT_SESSION_MAX_RECORDS
} from '../../shared/subagent-sessions'
import { SUBAGENT_LIMITS } from '../../shared/subagents'
import type {
  SubagentSessionNotice, SubagentSessionRow, SubagentSessionSnapshot, SubagentSessionSummary,
  SubagentSessionList, SubagentSessionStatus, SubagentSessionAdmission
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
interface Reservation { backendId: string; runtimeId: string; parentToolCallId: string; sourcePath?: string; remaining: number }
const MAX_TOMBSTONES = 1024
const MAX_RETIRED_RUNTIMES = 32
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
 * No eviction before retention ends. Saturated backend/tombstone bounds fail closed for new IDs.
 */
export class SubagentSessionStore {
  private records = new Map<string, RecordState>()
  private backends = new Map<string, BackendState>()
  private tombstones = new Set<string>()
  private reservations = new Map<string, Reservation>()
  private admittedBatches = new Set<string>()
  private creationClosed = false
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
      if (this.tombstones.size < MAX_TOMBSTONES) this.tombstones.add(key)
      else this.creationClosed = true // Never drop a fence and permit a late packet to resurrect it.
      changed = true
    }
    if (changed) this.changed()
  }

  private prunePlaceholders(): void {
    for (const [id, backend] of this.backends) {
      if (backend.gone || backend.runtime !== undefined || backend.retired.size > 0
        || backend.cwd !== '' || backend.nonce !== '') continue
      if ([...this.records.values()].some((record) => record.snapshot.backendId === id)) continue
      this.backends.delete(id)
    }
  }

  /** Synchronous display-quota reservation, NOT permission to execute tools or call models. */
  reserveBatch(scope: Scope, request: SubagentSessionAdmission, allowCreate: (parentToolCallId: string) => boolean): boolean {
    if (this.disposed) return false
    this.expire()
    if (!object(request) || !keys(request, ['version', 'nonce', 'runtimeId', 'parentToolCallId', 'count'])
      || request.version !== 1 || !string(scope.backendId, 256) || !string(scope.nonce, 256)
      || !string(scope.cwd, 4096) || (scope.parentSessionPath !== undefined && !string(scope.parentSessionPath, 4096))
      || request.nonce !== scope.nonce || !string(request.runtimeId, 256) || !string(request.parentToolCallId, 256)
      || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > SUBAGENT_LIMITS.maxParallel.max) return false
    let backend = this.backends.get(scope.backendId)
    const key = JSON.stringify([scope.backendId, request.runtimeId, request.parentToolCallId])
    if (this.creationClosed || this.admittedBatches.has(key) || this.admittedBatches.size >= MAX_TOMBSTONES
      || (backend && (backend.gone || (backend.cwd !== '' && backend.cwd !== scope.cwd)
        || (backend.nonce !== '' && backend.nonce !== scope.nonce) || backend.retired.has(request.runtimeId)
        || (backend.path !== undefined && scope.parentSessionPath !== backend.path)
        || (backend.runtime !== undefined && backend.runtime !== request.runtimeId && backend.retired.size >= MAX_RETIRED_RUNTIMES)))) return false
    // Replacement may release the old runtime's unused slots only after a native receipt.
    let pending = 0
    for (const reservation of this.reservations.values()) {
      if (reservation.backendId === scope.backendId && reservation.runtimeId !== request.runtimeId) continue
      pending += reservation.remaining
    }
    if (this.records.size + pending + request.count > SUBAGENT_SESSION_MAX_RECORDS) return false
    if (!backend && this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) this.prunePlaceholders()
    if (!backend && this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) return false
    if (!allowCreate(request.parentToolCallId)) return false
    if (!backend) {
      backend = { cwd: scope.cwd, nonce: scope.nonce, path: scope.parentSessionPath, retired: new Set(), gone: false }
      this.backends.set(scope.backendId, backend)
    }
    let changed = false
    if (backend.runtime !== undefined && backend.runtime !== request.runtimeId) {
      backend.retired.add(backend.runtime)
      for (const [reservationKey, reservation] of this.reservations) {
        if (reservation.backendId === scope.backendId) this.reservations.delete(reservationKey)
      }
      for (const record of this.records.values()) {
        if (record.snapshot.backendId === scope.backendId && record.deadline === undefined && record.snapshot.status !== 'cancelling') {
          record.snapshot.status = 'cancelling'
          record.snapshot.revision++
          changed = true
        }
      }
    }
    backend.cwd = scope.cwd
    backend.nonce = scope.nonce
    backend.path ??= scope.parentSessionPath
    backend.runtime = request.runtimeId
    this.admittedBatches.add(key)
    this.reservations.set(key, { backendId: scope.backendId, runtimeId: request.runtimeId,
      parentToolCallId: request.parentToolCallId, sourcePath: scope.parentSessionPath, remaining: request.count })
    if (changed) this.changed()
    return true
  }

  /** Release unconsumed display slots at parent tool_end; retained records keep their own TTL. */
  releaseBatch(backendId: string, parentCallId: string): void {
    for (const [key, reservation] of this.reservations) {
      if (reservation.backendId === backendId && reservation.parentToolCallId === parentCallId) this.reservations.delete(key)
    }
  }

  consume(scope: Scope, event: unknown, allowCreate: (parentToolCallId: string) => boolean): boolean {
    // The reserved key is always swallowed, even if its outer event is malformed.
    if (!object(event) || event.widgetKey !== SUBAGENT_SESSION_WIDGET_KEY) return false
    if (this.disposed) return true
    this.expire()
    if (event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.parentToolCallId !== undefined) return true
    const notice = parse(event.widgetLines)
    if (!notice || !string(scope.backendId, 256) || !string(scope.nonce, 256)
      || notice.nonce !== scope.nonce || notice.cwd !== scope.cwd) return true
    const backend = this.backends.get(scope.backendId)
    const reservation = this.reservations.get(JSON.stringify([scope.backendId, notice.runtimeId, notice.parentToolCallId]))
    if (backend && (backend.gone || (backend.cwd !== '' && backend.cwd !== scope.cwd) || (backend.nonce !== '' && backend.nonce !== scope.nonce)
      || backend.retired.has(notice.runtimeId))) return true
    const key = recordKey(scope.backendId, notice.id)
    const existing = this.records.get(key)
    // A producer (or batch admitted before binding) whose source path was absent
    // may keep that identity after main learns the display path. A later admission
    // against a known path cannot create an absent-path child or rewrite a source.
    const lateBoundSource = notice.parentSessionPath === undefined && (existing !== undefined
      ? existing.sourcePath === undefined : reservation !== undefined && reservation.sourcePath === undefined)
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
      if (this.creationClosed || this.tombstones.has(key) || this.records.size >= SUBAGENT_SESSION_MAX_RECORDS
        || !backend || backend.runtime !== notice.runtimeId || !reservation || reservation.remaining <= 0
        || (reservation.sourcePath !== undefined && reservation.sourcePath !== notice.parentSessionPath)) return true
      // Recheck the native root receipt; quota alone never authorizes a producer.
      if (!allowCreate(notice.parentToolCallId)) return true
      backend.path ??= notice.parentSessionPath
    }
    const snapshot: SubagentSessionSnapshot = {
      id: notice.id, backendId: scope.backendId, runtimeId: notice.runtimeId,
      parentToolCallId: notice.parentToolCallId, cwd: notice.cwd, parentSessionId: notice.parentSessionId,
      ...((backend?.path ?? notice.parentSessionPath) !== undefined ? { parentSessionPath: backend?.path ?? notice.parentSessionPath } : {}),
      name: notice.name, status: notice.status, revision: (existing?.snapshot.revision ?? 0) + 1, truncated: notice.truncated, rows: notice.rows
    }
    this.records.set(key, { snapshot, sourcePath: notice.parentSessionPath, packetRevision: notice.revision,
      ...(terminal(notice.status) ? { deadline: this.time() + SUBAGENT_SESSION_RETENTION_MS } : {}) })
    if (!existing) reservation!.remaining--
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
      if (this.backends.size >= SUBAGENT_SESSION_MAX_RECORDS) this.prunePlaceholders()
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
    for (const [key, reservation] of this.reservations) {
      if (reservation.backendId === backendId) this.reservations.delete(key)
    }
    const backend = this.backends.get(backendId)
    if (backend) backend.gone = true
    else if (this.backends.size < SUBAGENT_SESSION_MAX_RECORDS) {
      this.backends.set(backendId, { cwd: '', nonce: '', gone: true, retired: new Set() })
    } else this.creationClosed = true
    let changed = false
    for (const record of this.records.values()) {
      if (record.snapshot.backendId !== backendId || record.deadline !== undefined) continue
      const status = exitConfirmed ? 'aborted' : 'cancelling'
      const recordChanged = record.snapshot.status !== status || exitConfirmed
      if (recordChanged) {
        record.snapshot.status = status
        record.snapshot.revision++
        if (exitConfirmed) record.deadline = this.time() + SUBAGENT_SESSION_RETENTION_MS
        changed = true
      }
    }
    if (changed) this.changed()
  }
  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.records.clear()
    this.backends.clear()
    this.tombstones.clear()
    this.reservations.clear()
    this.admittedBatches.clear()
  }
}
