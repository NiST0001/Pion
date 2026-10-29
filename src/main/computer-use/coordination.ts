/** Cooperative same-account coordination, not authentication or an OS sandbox.
 * Construction is pure. Only an explicit, host-approved start calls claim().
 * A marker is never cleared from PID, age, restart, timeout or UI intent.
 */
export interface ComputerUseCoordinationReceipt {
  /** Association only. Implementations must validate object identity privately. */
  readonly kind: 'computer-use-coordination-receipt'
}

export type ComputerUseCoordinationClaim =
  | { kind: 'claimed'; receipt: ComputerUseCoordinationReceipt }
  | { kind: 'occupied' }
  | { kind: 'failed-clean' }
  | { kind: 'unknown' }

export interface ComputerUseCoordination {
  /** Actual promise stays pending until every admitted filesystem operation closes.
   * No AbortSignal: stopping the wait cannot prove an exclusive create did not happen.
   * claimed requires durable creation; occupied never proves another peer is alive.
   */
  claim(): Promise<ComputerUseCoordinationClaim>
  /** Only after the owned Portal API closure is confirmed and all Pion-local
   * driver/PipeWire/FD/process/stdio/decode operations have actually closed; not
   * a claim about independent server internals or old unknown scopes.
   * Reject on foreign/replayed receipts, identity change or uncertain release.
   * No path, nonce, inode or receipt is projected through renderer IPC.
   */
  release(receipt: ComputerUseCoordinationReceipt): Promise<void>
}

import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { RECOVERY_FILES } from './recovery'

interface IdentityStat {
  dev: bigint
  ino: bigint
  uid: bigint
  mode: bigint
  nlink: bigint
  isDirectory(): boolean
  isFile(): boolean
}
interface CoordinationHandle {
  stat(): Promise<IdentityStat>
  write(payload: Uint8Array): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}
interface CoordinationFileSystem {
  mkdir(path: string, mode: number): Promise<void>
  open(path: string, flags: number, mode?: number): Promise<CoordinationHandle>
  lstat(path: string): Promise<IdentityStat>
  unlink(path: string): Promise<void>
}
interface CoordinationOptions {
  account?: () => { uid: number; homedir: string } | Promise<{ uid: number; homedir: string }>
  fs?: CoordinationFileSystem
}
interface ReceiptRecord {
  uid: bigint
  home: string
  directory: string
  marker: string
  homeStat: IdentityStat
  directoryStat: IdentityStat
  markerStat: IdentityStat
  // Recorded from the exclusive-create FD, never supplied by the caller.
}

const PAYLOAD = new TextEncoder().encode('pion-computer-use-coordination-v1\n')
const DIRECTORY = '.pion-computer-use-coordination-v1'
const nativeFS: CoordinationFileSystem = {
  mkdir: async (path, mode) => { await fs.mkdir(path, { mode }) },
  open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode)
    return {
      stat: () => handle.stat({ bigint: true }),
      write: (payload) => handle.write(payload),
      sync: () => handle.sync(),
      close: () => handle.close()
    }
  },
  lstat: (path) => fs.lstat(path, { bigint: true }),
  unlink: (path) => fs.unlink(path)
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW
function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
}
function sameInode(a: IdentityStat, b: IdentityStat): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function requireDirectory(stat: IdentityStat, uid: bigint, privateMode: boolean): void {
  if (!stat.isDirectory() || stat.uid !== uid || (privateMode && (stat.mode & 0o7777n) !== 0o700n)) {
    throw new Error('Unsafe coordination directory')
  }
}
function requireMarker(stat: IdentityStat, uid: bigint): void {
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n) {
    throw new Error('Unsafe coordination marker')
  }
}
async function closeAll(handles: CoordinationHandle[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const handle of handles.reverse()) {
    try { await handle.close() } catch (error) { failures.push(error) }
  }
  return failures
}

/** A durable cooperative exclusion marker shared by ordinary instances of the
 * same system account, regardless of Electron profile, HOME or XDG overrides.
 * Not authentication or a sandbox: malicious same-UID peers, changed account
 * homes and broken filesystem durability are outside this boundary.
 * No PID/age/content recovery, retries, fallback paths, or automatic unlocking.
 */
export class PersistentComputerUseCoordination implements ComputerUseCoordination {
  private readonly fileSystem: CoordinationFileSystem
  private readonly account: NonNullable<CoordinationOptions['account']>
  readonly #receipts = new WeakMap<ComputerUseCoordinationReceipt, ReceiptRecord>()

  constructor(options: CoordinationOptions = {}) {
    this.fileSystem = options.fs ?? nativeFS
    // userInfo is intentionally invoked only by claim(), not construction or reads.
    this.account = options.account ?? (() => userInfo())
  }

  async claim(): Promise<ComputerUseCoordinationClaim> {
    const handles: CoordinationHandle[] = []
    let result: ComputerUseCoordinationClaim = { kind: 'failed-clean' }
    let record: ReceiptRecord | undefined
    let createAttempted = false
    let created = false
    let maintenanceOccupied = false
    try {
      const account = await this.account()
      if (!Number.isSafeInteger(account.uid) || account.uid < 0 || !isAbsolute(account.homedir)) {
        throw new Error('System account unavailable')
      }
      const uid = BigInt(account.uid)
      const home = account.homedir
      const directory = join(home, DIRECTORY)
      const marker = join(directory, 'capture.marker')
      const homeHandle = await this.fileSystem.open(home, directoryFlags)
      handles.push(homeHandle)
      const homeStat = await homeHandle.stat()
      requireDirectory(homeStat, uid, false)
      if (!sameInode(homeStat, await this.fileSystem.lstat(home))) throw new Error('Home changed')
      try { await this.fileSystem.mkdir(directory, 0o700) } catch (error) {
        if (code(error) !== 'EEXIST') throw error
      }
      const directoryHandle = await this.fileSystem.open(directory, directoryFlags)
      handles.push(directoryHandle)
      const directoryStat = await directoryHandle.stat()
      requireDirectory(directoryStat, uid, true)
      if (!sameInode(directoryStat, await this.fileSystem.lstat(directory))) throw new Error('Directory changed')
      // Only this explicitly admitted claim checks maintenance; getState/Stop stay
      // pure. Even malformed or incomplete maintenance guards prohibit a new scope.
      for (const name of Object.values(RECOVERY_FILES)) {
        try { await this.fileSystem.lstat(join(directory, name)) } catch (error) {
          if (code(error) === 'ENOENT') continue
          throw error
        }
        maintenanceOccupied = true
        throw new Error('Computer-use maintenance occupied')
      }
      createAttempted = true
      let markerHandle: CoordinationHandle
      try {
        markerHandle = await this.fileSystem.open(marker, createFlags, 0o600)
      } catch (error) {
        // Apart from exclusive-create EEXIST, errno alone is not proof that
        // an attempted create produced no filesystem side effects.
        result = code(error) === 'EEXIST' ? { kind: 'occupied' } : { kind: 'unknown' }
        throw error
      }
      created = true
      handles.push(markerHandle)
      const markerStat = await markerHandle.stat()
      requireMarker(markerStat, uid)
      if (!sameInode(markerStat, await this.fileSystem.lstat(marker))) throw new Error('Marker changed')
      const written = await markerHandle.write(PAYLOAD)
      if (written.bytesWritten !== PAYLOAD.byteLength) throw new Error('Partial coordination marker write')
      await markerHandle.sync()
      await directoryHandle.sync()
      // Also sync the parent for a newly created directory. Always doing this
      // covers an ordinary peer observing that directory before its creator syncs.
      await homeHandle.sync()
      record = { uid, home, directory, marker, homeStat, directoryStat, markerStat }
    } catch {
      if (created) result = { kind: 'unknown' }
      else if (!createAttempted) result = { kind: maintenanceOccupied ? 'occupied' : 'failed-clean' }
    }
    // A pending close remains pending; a rejected close is never clean/stopped.
    const closeFailures = await closeAll(handles)
    if (closeFailures.length) return { kind: 'unknown' }
    if (!record) return result
    const receipt: ComputerUseCoordinationReceipt = Object.freeze({ kind: 'computer-use-coordination-receipt' })
    this.#receipts.set(receipt, record)
    return { kind: 'claimed', receipt }
  }

  async release(receipt: ComputerUseCoordinationReceipt): Promise<void> {
    const record = this.#receipts.get(receipt)
    if (!record) throw new Error('Foreign or consumed coordination receipt')
    // Consume before any await. Failure does not authorize replay/retry/unlocking.
    this.#receipts.delete(receipt)
    const handles: CoordinationHandle[] = []
    const failures: unknown[] = []
    try {
      const homeHandle = await this.fileSystem.open(record.home, directoryFlags)
      handles.push(homeHandle)
      const homeStat = await homeHandle.stat()
      requireDirectory(homeStat, record.uid, false)
      if (!sameInode(homeStat, record.homeStat) || !sameInode(homeStat, await this.fileSystem.lstat(record.home))) {
        throw new Error('Coordination home changed')
      }
      const directoryHandle = await this.fileSystem.open(record.directory, directoryFlags)
      handles.push(directoryHandle)
      const directoryStat = await directoryHandle.stat()
      requireDirectory(directoryStat, record.uid, true)
      if (!sameInode(directoryStat, record.directoryStat) || !sameInode(directoryStat, await this.fileSystem.lstat(record.directory))) {
        throw new Error('Coordination directory changed')
      }
      const markerHandle = await this.fileSystem.open(record.marker, readFlags)
      handles.push(markerHandle)
      const markerStat = await markerHandle.stat()
      requireMarker(markerStat, record.uid)
      const pathStat = await this.fileSystem.lstat(record.marker)
      requireMarker(pathStat, record.uid)
      if (!sameInode(markerStat, record.markerStat) || !sameInode(markerStat, pathStat)) {
        throw new Error('Coordination marker changed')
      }
      // This check/unlink is not atomic against malicious same-UID mutations.
      await this.fileSystem.unlink(record.marker)
      // If this fails after unlink, report uncertainty; never recreate a marker
      // over a possible successor. The service must remain quarantined.
      await directoryHandle.sync()
    } catch (error) { failures.push(error) }
    failures.push(...await closeAll(handles))
    if (failures.length) throw new AggregateError(failures, 'Coordination release uncertain (marker may already be unlinked)')
  }
}
