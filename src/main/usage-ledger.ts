import { lstat, opendir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { UsageLedgerCollector, UsageOverview, UsageOverviewQuery, UsageOverviewWarning } from '../shared/usage-overview'
import { cycleMonth, usageDayPeriod, usagePeriod, usageYearPeriod, validateUsageOverviewQuery } from '../shared/usage-period'
import { readSessionUsageSnapshot, sessionUsageFileStamp, SessionUsageReadError, type SessionUsageSnapshot } from './agent/session-token-total'
import {
  addUsage, checkDirectories, directoryChain, UsageLedgerError, UsageLedgerStore, usageHash, zeroUsage,
  type LedgerDocument, type LedgerReceipt, type LedgerSession
} from './usage-ledger-store'

const SETTLE_MS = 30_000
const BACKGROUND_SCAN_MS = 5 * 60_000
const BACKGROUND_YIELD_MS = 20
interface Scan {
  paths: string[]
  failed: boolean
}
interface Collection {
  discovered: string[]
  successful: Set<string>
  unavailable: number
  failed: boolean
}
interface AliasProof {
  path: string
  id: string
  receipt: string
  stamp: string
}
interface Resolution {
  records: Map<string, LedgerReceipt>
  recordSessions: Map<string, string>
  resolved: Set<string>
  unresolved: Set<string>
  conflicts: Set<string>
}
const pathHash = (path: string): string => usageHash(['path', resolve(path)])
const sessionHash = (id: string): string => usageHash(['session', id])
const entryHash = (id: string): string => usageHash(['entry', id])
const sameProof = (a: LedgerReceipt, b: LedgerReceipt): boolean => a.digest === b.digest && a.event === b.event && a.eventDigest === b.eventDigest
const unavailable = (): UsageLedgerError => new UsageLedgerError('collection-failed')
class AliasConflict extends UsageLedgerError {
  constructor(readonly changed: boolean) { super('collection-failed') }
}

function snapshotProof(path: string, snapshot: SessionUsageSnapshot): AliasProof {
  return { path, id: sessionHash(snapshot.id), receipt: snapshot.receipt, stamp: snapshot.stamp }
}

/** Historical aliases alone cannot establish a new edge: their paths may be reused. */
async function bindLineage(data: LedgerDocument, proofs: Map<string, AliasProof>, rejected?: (path: string) => void): Promise<AliasProof[]> {
  const aliases = new Map(data.sessions.flatMap(session => session.aliases.map(alias => [alias.path, { id: session.id, alias }] as const)))
  const needed = new Set(data.sessions.filter(session => session.parent && !session.parentId).map(session => session.parent!))
  const verified = new Map<string, AliasProof>()
  for (const parent of needed) {
    const proof = proofs.get(parent)
    const current = aliases.get(parent)
    if (!proof || !current || current.id !== proof.id || current.alias.conflict
      || current.alias.receipt !== proof.receipt || current.alias.stamp !== proof.stamp) continue
    try {
      // Recheck this round's successful source immediately before establishing
      // durable edges. Missing/deferred/changed parents remain unresolved.
      await verifySource(proof.path, proof.stamp)
      verified.set(parent, proof)
    } catch { rejected?.(proof.path) }
  }
  for (const session of data.sessions) {
    if (session.parent && !session.parentId) {
      const parent = verified.get(session.parent)
      if (parent) session.parentId = parent.id
    }
  }
  return [...verified.values()]
}

/**
 * Resolve only explicit recorded lineage. The DFS's active identity indexes are
 * scoped to ancestors, never shared across unrelated roots (SDK entry IDs are
 * short). No text/clock/usage-equality matching, and no parent-path file reads.
 * Each receipt is visited once; the explicit stack also bounds deep fork chains.
 */
function resolveLineage(data: LedgerDocument): Resolution {
  const children = new Map<string, LedgerSession[]>()
  const sessions = new Map(data.sessions.map(session => [session.id, session]))
  const roots: LedgerSession[] = []
  for (const session of data.sessions) {
    if (!session.parent) roots.push(session)
    else {
      const parent = session.parentId ? sessions.get(session.parentId) : undefined
      if (parent) {
        const list = children.get(parent.id) ?? []
        list.push(session)
        children.set(parent.id, list)
      }
    }
  }
  const result: Resolution = { records: new Map(), recordSessions: new Map(), resolved: new Set(), unresolved: new Set(), conflicts: new Set() }
  type Active = { receipt: LedgerReceipt; canonical: string }
  const entries = new Map<string, Active>()
  const events = new Map<string, Active>()
  type Frame = { session: LedgerSession; exit?: { entries: string[]; events: string[] } }
  const stack: Frame[] = roots.map(session => ({ session }))
  while (stack.length) {
    const frame = stack.pop()!
    if (frame.exit) {
      for (const key of frame.exit.entries) entries.delete(key)
      for (const key of frame.exit.events) events.delete(key)
      continue
    }
    const addedEntries: string[] = []
    const addedEvents: string[] = []
    const ownRecords: string[] = []
    let conflict = false
    for (const receipt of frame.session.receipts) {
      const byEntry = entries.get(receipt.entry)
      const byEvent = receipt.event ? events.get(receipt.event) : undefined
      if ((byEntry && !sameProof(byEntry.receipt, receipt))
        || (byEvent && byEvent.receipt.eventDigest !== receipt.eventDigest)
        || (byEntry && byEvent && byEntry.canonical !== byEvent.canonical)) { conflict = true; break }
      const canonical = byEntry?.canonical ?? byEvent?.canonical ?? usageHash([frame.session.id, receipt.entry])
      const active = { receipt, canonical }
      if (!byEntry) { entries.set(receipt.entry, active); addedEntries.push(receipt.entry) }
      if (receipt.event && !byEvent) { events.set(receipt.event, active); addedEvents.push(receipt.event) }
      if (!byEntry && !byEvent) {
        result.records.set(canonical, receipt)
        result.recordSessions.set(canonical, frame.session.id)
        ownRecords.push(canonical)
      }
    }
    if (conflict) {
      for (const key of addedEntries) entries.delete(key)
      for (const key of addedEvents) events.delete(key)
      for (const key of ownRecords) { result.records.delete(key); result.recordSessions.delete(key) }
      result.conflicts.add(frame.session.id)
      continue
    }
    result.resolved.add(frame.session.id)
    stack.push({ session: frame.session, exit: { entries: addedEntries, events: addedEvents } })
    for (const session of children.get(frame.session.id) ?? []) stack.push({ session })
  }
  for (const session of data.sessions) if (!result.resolved.has(session.id)) result.unresolved.add(session.id)
  return result
}

/** Validate a whole snapshot before adding anything; old receipt evidence is immutable. */
function mergeSnapshot(data: LedgerDocument, path: string, snapshot: SessionUsageSnapshot): boolean {
  const id = sessionHash(snapshot.id)
  const alias = pathHash(path)
  const parent = snapshot.parentSession ? pathHash(snapshot.parentSession) : undefined
  const existing = data.sessions.find(session => session.id === id)
  const other = data.sessions.find(session => session.id !== id && session.aliases.some(value => value.path === alias))
  if (other) {
    const conflicted = other.aliases.find(value => value.path === alias)!
    const changed = !conflicted.conflict
    if (changed) conflicted.conflict = snapshot.receipt
    throw new AliasConflict(changed)
  }
  if (existing && (existing.createdAt !== snapshot.createdAt || existing.parent !== parent)) throw unavailable()
  const incoming: LedgerReceipt[] = snapshot.receipts.map(receipt => ({
    entry: entryHash(receipt.entryId), digest: receipt.digest, ...(receipt.event ? { event: receipt.event, eventDigest: receipt.eventDigest } : {}),
    source: receipt.source, ...(receipt.provider ? { provider: receipt.provider, modelId: receipt.modelId } : {}),
    at: receipt.at, usage: { ...receipt.usage }, cwd: snapshot.cwd
  }))
  const previous = new Map(existing?.receipts.map(receipt => [receipt.entry, receipt]))
  const events = new Map(existing?.receipts.filter(receipt => receipt.event).map(receipt => [receipt.event!, receipt.eventDigest]))
  const added: LedgerReceipt[] = []
  for (const receipt of incoming) {
    const old = previous.get(receipt.entry)
    if (old && !sameProof(old, receipt)) throw unavailable()
    if (receipt.event) {
      const event = events.get(receipt.event)
      if (event !== undefined && event !== receipt.eventDigest) throw unavailable()
      events.set(receipt.event, receipt.eventDigest)
    }
    if (!old) { added.push(receipt); previous.set(receipt.entry, receipt) }
  }
  const oldAlias = existing?.aliases.find(value => value.path === alias)
  if (oldAlias?.conflict) throw unavailable()
  if (existing) {
    for (const receipt of added) existing.receipts.push(receipt)
    if (oldAlias) {
      const changed = oldAlias.receipt !== snapshot.receipt || oldAlias.stamp !== snapshot.stamp
      oldAlias.receipt = snapshot.receipt
      oldAlias.stamp = snapshot.stamp
      return changed || added.length > 0
    }
    existing.aliases.push({ path: alias, receipt: snapshot.receipt, stamp: snapshot.stamp })
  } else {
    data.sessions.push({ id, createdAt: snapshot.createdAt, cwd: snapshot.cwd, ...(parent ? { parent } : {}),
      aliases: [{ path: alias, receipt: snapshot.receipt, stamp: snapshot.stamp }], receipts: added })
  }
  return true
}

async function discover(root: string, yieldWork: () => Promise<void>, shouldContinue: () => boolean): Promise<Scan> {
  const result: Scan = { paths: [], failed: false }
  let directories: Awaited<ReturnType<typeof directoryChain>>
  try { directories = await directoryChain(root) } catch (error) {
    // A not-yet-created SDK history root is a known empty local history.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.failed = true
    return result
  }
  const pending = [root]
  let entries = 0
  while (pending.length && shouldContinue()) {
    const path = pending.shift()!
    const beforeCount = result.paths.length
    let directory: Awaited<ReturnType<typeof opendir>> | undefined
    try {
      const before = await lstat(path, { bigint: true })
      if (!before.isDirectory() || before.isSymbolicLink()) throw unavailable()
      if (!shouldContinue()) break
      directory = await opendir(path)
      while (shouldContinue()) {
        const entry = await directory.read()
        if (!entry) break
        if (++entries % 64 === 0) await yieldWork()
        if (!shouldContinue()) break
        if (entry.isSymbolicLink()) continue
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          result.paths.push(join(path, entry.name))
        } else if (path === root && entry.isDirectory()) {
          pending.push(join(root, entry.name))
        }
      }
      const after = await lstat(path, { bigint: true })
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw unavailable()
    } catch {
      result.failed = true
      result.paths.length = beforeCount
    } finally {
      if (directory) {
        try { await directory.close() } catch { throw new UsageLedgerError('collection-failed', true) }
      }
    }
    await yieldWork()
  }
  await checkDirectories(directories)
  return result
}

async function readSnapshot(path: string, knownDirectories?: Awaited<ReturnType<typeof directoryChain>>,
  yieldWork?: () => Promise<void>): Promise<SessionUsageSnapshot> {
  const directories = knownDirectories ?? await directoryChain(dirname(path))
  try {
    const snapshot = await readSessionUsageSnapshot(path, undefined, { yield: yieldWork })
    await checkDirectories(directories)
    return snapshot
  } catch (error) {
    if (error instanceof SessionUsageReadError && error.closeUnknown) throw new UsageLedgerError('collection-failed', true)
    throw error
  }
}

async function verifySource(path: string, stamp: string): Promise<void> {
  const directories = await directoryChain(dirname(path))
  const current = await lstat(path, { bigint: true })
  if (!current.isFile() || current.isSymbolicLink() || sessionUsageFileStamp(current) !== stamp) throw unavailable()
  await checkDirectories(directories)
  const latest = await lstat(path, { bigint: true })
  if (!latest.isFile() || latest.isSymbolicLink() || sessionUsageFileStamp(latest) !== stamp) throw unavailable()
}

async function verifyLineageProofs(proofs: AliasProof[]): Promise<void> {
  for (const proof of proofs) await verifySource(proof.path, proof.stamp)
}

function overview(data: LedgerDocument, collection: Collection, pendingFailure: boolean, query?: UsageOverviewQuery): UsageOverview {
  const resolution = resolveLineage(data)
  const totals = zeroUsage()
  const byProject = new Map<string, UsageOverview['byProject'][number]>()
  const byModel = new Map<string, UsageOverview['byModel'][number]>()
  const daily = new Map<string, UsageOverview['daily'][number]>()
  const today = new Date().toISOString().slice(0, 10)
  const start = new Date(`${today}T00:00:00.000Z`).getTime() - 29 * 86_400_000
  const end = start + 30 * 86_400_000
  const startDay = query?.startDay ?? 1
  const period = query?.year ? usageYearPeriod(query.year, startDay)
    : query?.date ? usageDayPeriod(query.date, startDay)
      : query?.month ? usagePeriod(query.month, startDay) : undefined
  const availableMonths = new Set([cycleMonth(Date.now(), startDay)])
  const availableYears = new Set([today.slice(0, 4)])
  const availableDates = new Set([today])
  const sessions = new Set<string>()
  const projectSessions = new Map<string, Set<string>>()
  let records = 0
  const project = (cwd: string): UsageOverview['byProject'][number] => {
    let value = byProject.get(cwd)
    if (!value) { value = { cwd, sessions: 0, usage: zeroUsage() }; byProject.set(cwd, value) }
    return value
  }
  if (!period) for (const session of data.sessions) project(session.cwd).sessions++
  let firstRecordAt: number | null = null
  for (const [key, receipt] of resolution.records) {
    availableMonths.add(cycleMonth(receipt.at, startDay))
    const recordDate = new Date(receipt.at).toISOString().slice(0, 10)
    availableYears.add(recordDate.slice(0, 4))
    availableDates.add(recordDate)
    if (period && (receipt.at < period.startAt || receipt.at >= period.endAt)) continue
    records++
    if (period) {
      const id = resolution.recordSessions.get(key)!
      sessions.add(id)
      const ids = projectSessions.get(receipt.cwd) ?? new Set<string>()
      ids.add(id)
      projectSessions.set(receipt.cwd, ids)
      project(receipt.cwd).sessions = ids.size
    }
    addUsage(totals, receipt.usage)
    addUsage(project(receipt.cwd).usage, receipt.usage)
    const modelKey = JSON.stringify([receipt.source, receipt.provider, receipt.modelId])
    let model = byModel.get(modelKey)
    if (!model) {
      model = { source: receipt.source, ...(receipt.provider ? { provider: receipt.provider, modelId: receipt.modelId } : {}), usage: zeroUsage() }
      byModel.set(modelKey, model)
    }
    addUsage(model.usage, receipt.usage)
    if (period || (receipt.at >= start && receipt.at < end)) {
      let day = daily.get(recordDate)
      if (!day) { day = { date: recordDate, usage: zeroUsage() }; daily.set(recordDate, day) }
      addUsage(day.usage, receipt.usage)
    }
    firstRecordAt = firstRecordAt === null ? receipt.at : Math.min(firstRecordAt, receipt.at)
  }
  const warnings = new Set<UsageOverviewWarning>()
  const aliasConflict = data.sessions.some(session => session.aliases.some(alias => alias.conflict))
  if (collection.failed || pendingFailure || resolution.conflicts.size || aliasConflict) warnings.add('collection-failed')
  if (resolution.unresolved.size) warnings.add('unresolved-lineage')
  if (collection.failed || pendingFailure || collection.unavailable || resolution.unresolved.size || aliasConflict) warnings.add('incomplete-history')
  const aliases = new Map(data.sessions.flatMap(session => session.aliases.map(alias => [alias.path, session.id] as const)))
  let collectedSessions = 0
  for (const path of collection.successful) {
    const id = aliases.get(pathHash(path))
    if (id && resolution.resolved.has(id)) collectedSessions++
  }
  return {
    revision: data.revision, collectedAt: data.collectedAt, firstRecordAt, totals,
    sessions: period ? sessions.size : data.sessions.length, projects: byProject.size, records,
    ...(period ? { period } : {}), availableMonths: [...availableMonths].sort().reverse(),
    availableYears: [...availableYears].sort().reverse(), availableDates: [...availableDates].sort().reverse(),
    byProject: [...byProject.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd || a.cwd.localeCompare(b.cwd)),
    byModel: [...byModel.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd), daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    coverage: { discoveredSessions: collection.discovered.length, collectedSessions, unavailableSessions: collection.unavailable,
      unresolvedSessions: resolution.unresolved.size, limitReached: false }, warnings: [...warnings]
  }
}

/** Local, serialized collection. Background work yields; foreground reads all files. */
export class UsageLedger implements UsageLedgerCollector {
  private readonly store: UsageLedgerStore
  private readonly root: string
  private tail: Promise<unknown> = Promise.resolve()
  private overviewPending: Promise<{ data: LedgerDocument; collection: Collection; pendingFailure: boolean }> | undefined
  private overviewQueries = new Map<string, Promise<UsageOverview>>()
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduled: Promise<void> | undefined
  private failures = new Set<string>()
  private backgroundEnabled = false
  private backgroundStopped = false
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined
  private foregroundRequests = 0

  constructor(options: { ledgerPath: string; sessionRoot: string }) {
    this.store = new UsageLedgerStore(options.ledgerPath)
    this.root = resolve(options.sessionRoot)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work)
    // The real operation, including every finally/FD close, retains this slot.
    this.tail = next.catch(() => undefined)
    return next
  }

  private normalize(path: string): string {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw unavailable()
    return resolve(path)
  }

  setBackgroundCollectionEnabled(enabled: boolean): void {
    this.backgroundEnabled = enabled
    if (!enabled) {
      this.clearBackgroundTimers()
      this.dirty.clear()
      return
    }
    if (!this.backgroundStopped) this.armBackgroundScan(SETTLE_MS)
  }

  stopBackgroundCollection(): void {
    this.backgroundStopped = true
    this.clearBackgroundTimers()
  }

  private clearBackgroundTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer)
    this.timer = undefined
    this.backgroundTimer = undefined
  }

  private backgroundActive(): boolean {
    return this.backgroundEnabled && !this.backgroundStopped
  }

  private armBackgroundScan(delay = BACKGROUND_SCAN_MS): void {
    if (!this.backgroundActive() || this.backgroundTimer) return
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined
      // One full discovery per interval, never overlapping a dirty-file pass.
      if (this.scheduled) { this.armBackgroundScan(); return }
      const operation = this.enqueue(async () => {
        if (!this.backgroundActive()) return
        try { await this.collect(undefined, true) } catch { /* Foreground reports actual read failures. */ }
      })
      this.scheduled = operation.finally(() => {
        this.scheduled = undefined
        if (this.dirty.size) this.arm()
        this.armBackgroundScan()
      })
    }, delay)
    this.backgroundTimer.unref?.()
  }

  scheduleSession(path: string): void {
    if (!this.backgroundActive()) return
    let target: string
    try { target = this.normalize(path) } catch { return }
    this.dirty.add(target)
    this.arm()
  }

  private arm(): void {
    if (!this.backgroundActive() || this.scheduled || this.timer) return
    // Coalesce notifications without resetting the first deadline indefinitely.
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain() }, SETTLE_MS)
    this.timer.unref?.()
  }

  private async yieldCollection(background: boolean): Promise<void> {
    // A queued panel read promotes an in-flight scan instead of waiting behind
    // its low-power sleeps. Neither route blocks Electron's event loop.
    await new Promise<void>(resolve => setTimeout(resolve,
      background && !this.foregroundRequests ? BACKGROUND_YIELD_MS : 0))
  }

  private drain(final = false): Promise<void> {
    if (this.scheduled) return this.scheduled
    if (!this.dirty.size) return Promise.resolve()
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const paths = [...this.dirty]
    this.dirty.clear()
    const operation = this.enqueue(async () => {
      if (!final && !this.backgroundActive()) {
        if (this.backgroundStopped) for (const path of paths) this.dirty.add(path)
        return
      }
      try { await this.collect(paths, !final) } catch {
        for (const path of paths) this.fail(path)
      }
    })
    this.scheduled = operation.finally(() => {
      this.scheduled = undefined
      if (this.dirty.size) this.arm()
    })
    return this.scheduled
  }

  private fail(path: string): void {
    this.failures.add(pathHash(path))
  }

  private async collect(paths?: string[], background = false): Promise<{ data: LedgerDocument; collection: Collection }> {
    const yieldWork = () => this.yieldCollection(background)
    const shouldContinue = () => !background || this.backgroundActive() || this.foregroundRequests > 0
    let bindings: AliasProof[] = []
    const result = await this.store.transaction(async data => {
      const scan = paths ? { paths, failed: false } : await discover(this.root, yieldWork, shouldContinue)
      const collection: Collection = { discovered: scan.paths, successful: new Set(), unavailable: 0, failed: scan.failed }
      let dirty = data.revision === 0
      const aliases = new Map(data.sessions.flatMap(session => session.aliases.map(alias => [alias.path, { id: session.id, alias }] as const)))
      const proofs = new Map<string, AliasProof>()
      const ordered = scan.paths.slice().sort()
      for (let index = 0; index < ordered.length; index++) {
        const path = ordered[index]
        await yieldWork()
        // Recheck after the low-power sleep, before admitting another file.
        if (!shouldContinue()) {
          if (paths && this.backgroundStopped) for (const remaining of ordered.slice(index)) this.dirty.add(remaining)
          break
        }
        try {
          const directories = await directoryChain(dirname(path))
          const size = await lstat(path, { bigint: true })
          if (!size.isFile() || size.isSymbolicLink()) throw unavailable()
          if (!shouldContinue()) {
            if (paths && this.backgroundStopped) for (const remaining of ordered.slice(index)) this.dirty.add(remaining)
            break
          }
          const known = aliases.get(pathHash(path))
          const previous = known?.alias
          if (previous && !previous.conflict && previous.stamp === sessionUsageFileStamp(size)) {
            // Previously validated, unchanged files need only their stat checks.
            await checkDirectories(directories)
            const current = await lstat(path, { bigint: true })
            if (!current.isFile() || current.isSymbolicLink() || sessionUsageFileStamp(current) !== previous.stamp) throw unavailable()
            proofs.set(pathHash(path), { path, id: known!.id, receipt: previous.receipt, stamp: previous.stamp })
          } else {
            const snapshot = await readSnapshot(path, directories, yieldWork)
            await verifySource(path, snapshot.stamp)
            dirty = mergeSnapshot(data, path, snapshot) || dirty
            proofs.set(pathHash(path), snapshotProof(path, snapshot))
          }
          collection.successful.add(path)
          this.dirty.delete(path)
          this.failures.delete(pathHash(path))
        } catch (error) {
          if (error instanceof AliasConflict && error.changed) dirty = true
          this.fail(path)
          if (error instanceof SessionUsageReadError && error.closeUnknown) throw new UsageLedgerError('collection-failed', true)
          if (error instanceof UsageLedgerError && error.closeUnknown) throw error
          collection.unavailable++
          if (!(error instanceof SessionUsageReadError)) collection.failed = true
        }
      }
      bindings = await bindLineage(data, proofs, path => {
        collection.successful.delete(path)
        collection.unavailable++
        collection.failed = true
        this.fail(path)
      })
      dirty = bindings.length > 0 || dirty
      // Validate aggregate arithmetic and projection before committing a new durable revision.
      overview(data, collection, false)
      return { dirty, value: collection }
    }, () => verifyLineageProofs(bindings))
    return { data: result.data, collection: result.value }
  }

  getOverview(query?: UsageOverviewQuery): Promise<UsageOverview> {
    let selection: UsageOverviewQuery | undefined
    try { selection = validateUsageOverviewQuery(query) } catch (error) { return Promise.reject(error) }
    const key = JSON.stringify([selection?.year ?? null, selection?.month ?? null, selection?.date ?? null, selection?.startDay ?? 1])
    const existing = this.overviewQueries.get(key)
    if (existing) return existing
    if (!this.overviewPending) {
      this.foregroundRequests++
      const operation = this.enqueue(async () => {
        const snapshot = await this.collect()
        return { ...snapshot, pendingFailure: this.failures.size > 0 }
      })
      // Queries share actual collection/FD closes, never another query's projection.
      this.overviewPending = operation.finally(() => {
        this.overviewPending = undefined
        this.overviewQueries.clear()
        this.foregroundRequests--
      })
    }
    const result = this.overviewPending.then(({ data, collection, pendingFailure }) => overview(data, collection, pendingFailure, selection))
    this.overviewQueries.set(key, result)
    return result
  }

  captureSession(path: string): Promise<void> {
    let target: string
    try { target = this.normalize(path) } catch { return Promise.reject(unavailable()) }
    this.foregroundRequests++
    return this.enqueue(async () => {
      this.dirty.delete(target)
      try {
        let bindings: AliasProof[] = []
        await this.store.transaction(async data => {
          const snapshot = await readSnapshot(target, undefined, () => this.yieldCollection(false))
          const changed = mergeSnapshot(data, target, snapshot)
          const proofs = new Map([[pathHash(target), snapshotProof(target, snapshot)]])
          const session = data.sessions.find(value => value.id === sessionHash(snapshot.id))!
          if (snapshot.parentSession && !session.parentId) {
            // Only stat-check an already-known exact alias, never chase an
            // arbitrary header path or infer a parent from another same-ID path.
            const parentPath = this.normalize(snapshot.parentSession)
            const parent = data.sessions.find(value => value.aliases.some(alias => alias.path === session.parent && !alias.conflict))
            const alias = parent?.aliases.find(value => value.path === session.parent)
            if (parent && alias) {
              try {
                await verifySource(parentPath, alias.stamp)
                proofs.set(session.parent!, { path: parentPath, id: parent.id, receipt: alias.receipt, stamp: alias.stamp })
              } catch { /* Unknown/changed parents must not acquire a durable edge. */ }
            }
          }
          await verifySource(target, snapshot.stamp)
          bindings = await bindLineage(data, proofs)
          const dirty = bindings.length > 0 || changed
          const resolution = resolveLineage(data)
          if (!resolution.resolved.has(sessionHash(snapshot.id))) throw unavailable()
          const collection: Collection = { discovered: [target], successful: new Set([target]), unavailable: 0, failed: false }
          overview(data, collection, false)
          return { dirty, value: snapshot.stamp }
        }, async stamp => {
          await verifySource(target, stamp)
          await verifyLineageProofs(bindings)
        })
        this.failures.delete(pathHash(target))
      } catch (error) {
        this.fail(target)
        if (error instanceof UsageLedgerError) throw error
        throw unavailable()
      }
    }).finally(() => { this.foregroundRequests-- })
  }

  /** Quit waits for admitted work; no timeout/Promise.race pretends that FS stopped. */
  async flush(): Promise<void> {
    while (true) {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
      await this.drain(true)
      const tail = this.tail
      await tail
      if (!this.dirty.size && !this.scheduled && tail === this.tail) {
        this.store.assertSettled()
        if (this.failures.size) throw unavailable()
        return
      }
    }
  }
}
