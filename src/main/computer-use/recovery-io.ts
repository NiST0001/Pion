/** Explicit maintenance IO, not normal coordination release or a stopped receipt.
 * Deployment prerequisite: this account home is on local, non-shared storage.
 * statfs type/ID cannot prove that premise (including shared block devices).
 * No Portal, PID, service, environment HOME/XDG, or SDK access. Construction is pure.
 * Only Node builtins at runtime, for Node's native TypeScript stripping CLI.
 */
import type { RecoveryIO, RecoverySnapshot } from './recovery'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

type Witness = Parameters<RecoveryIO['persist']>[0]
type Completion = { version: 1; kind: 'boot-bound-maintenance-retired'; witness: Witness; retiredInBoot: string }
export interface RecoveryStat {
  dev: bigint; ino: bigint; birthtimeNs: bigint; mtimeNs: bigint; size: bigint
  uid: bigint; mode: bigint; nlink: bigint
  isDirectory(): boolean
  isFile(): boolean
}
export interface RecoveryHandle {
  fd: number
  stat(): Promise<RecoveryStat>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}
export interface RecoveryFS {
  open(path: string, flags: number, mode?: number): Promise<RecoveryHandle>
  lstat(path: string): Promise<RecoveryStat>
  link(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}
export interface RecoveryIOOptions {
  acknowledgeLocalStorage?: boolean
  /** Test seams only. Production callers supply only the deployment acknowledgement. */
  fs?: RecoveryFS
  account?: () => { uid: number; homedir: string } | Promise<{ uid: number; homedir: string }>
  probe?: (directoryFD: number) => Promise<string>
}
const nativeFS: RecoveryFS = {
  open: async (path, flags, mode) => {
    const h = await fs.open(path, flags, mode)
    return { fd: h.fd, stat: () => h.stat({ bigint: true }),
      read: (buffer, offset, length, position) => h.read(buffer, offset, length, position),
      write: (buffer) => h.write(buffer), sync: () => h.sync(), close: () => h.close() }
  },
  lstat: (path) => fs.lstat(path, { bigint: true }),
  link: (from, to) => fs.link(from, to), unlink: (path) => fs.unlink(path)
}
const DIRECTORY = '.pion-computer-use-coordination-v1'
const MARKER = 'capture.marker'
const PAYLOAD = 'pion-computer-use-coordination-v1\n'
const SAFE_ERROR = 'ComputerUse maintenance IO refused or uncertain'
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/
const SNAPSHOT_KEYS = ['version', 'uid', 'bootId', 'machineHash', 'homeHash', 'fsType', 'fsId', 'homeIdentity', 'directoryIdentity', 'markerIdentity'] as const
function refuse(): never { throw new Error(SAFE_ERROR) }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function identity(s: RecoveryStat): string { return `${s.ino}:${s.birthtimeNs}` }
function markerIdentity(s: RecoveryStat): string { return `${identity(s)}:${s.mtimeNs}:${s.size}` }
function same(a: RecoveryStat, b: RecoveryStat): boolean { return a.dev === b.dev && identity(a) === identity(b) }
function absent(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every((k) => Object.hasOwn(descriptors, k) && Object.hasOwn(descriptors[k], 'value'))
}
function snapshotEqual(a: RecoverySnapshot, b: RecoverySnapshot): boolean {
  return exactKeys(a, SNAPSHOT_KEYS) && exactKeys(b, SNAPSHOT_KEYS) && SNAPSHOT_KEYS.every((key) => a[key] === b[key])
}
function witnessValid(value: unknown): value is Witness {
  if (!exactKeys(value, ['version', 'kind', 'id', 'snapshot']) || value.version !== 1 || value.kind !== 'boot-bound-maintenance' || typeof value.id !== 'string' || !UUID.test(value.id)) return false
  const s = value.snapshot
  return exactKeys(s, SNAPSHOT_KEYS) && s.version === 1 && Number.isSafeInteger(s.uid) && Number(s.uid) >= 0 &&
    typeof s.bootId === 'string' && UUID.test(s.bootId) &&
    ['machineHash', 'homeHash'].every((k) => typeof s[k] === 'string' && /^[a-f0-9]{64}$/.test(s[k] as string)) &&
    typeof s.fsType === 'string' && /^(ef53|58465342|9123683e)$/.test(s.fsType) &&
    typeof s.fsId === 'string' && /^[a-f0-9]+$/.test(s.fsId) &&
    ['homeIdentity', 'directoryIdentity'].every((k) => typeof s[k] === 'string' && /^\d+:\d+$/.test(s[k] as string)) &&
    typeof s.markerIdentity === 'string' && /^\d+:\d+:\d+:\d+$/.test(s.markerIdentity)
}
function witnessEqual(a: unknown, b: Witness): boolean {
  return witnessValid(a) && a.id === b.id && snapshotEqual(a.snapshot, b.snapshot)
}

/** Wait for actual child close (which follows exit AND stdio closure). Never
 * resolve on exit, error, timeout, or output limit. Uncertain children stay pending.
 */
async function nativeProbe(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0)
    let failed = false
    const child = spawn('/usr/bin/stat', ['--file-system', '--format=%t:%i', '--', '/proc/self/fd/3'], {
      shell: false, env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore', fd]
    })
    child.on('error', () => { failed = true })
    if (!child.stdout) failed = true
    child.stdout?.on('error', () => { failed = true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 256) { failed = true; return }
      output = Buffer.concat([output, chunk])
    })
    child.on('close', (code, signal) => {
      if (failed || code !== 0 || signal !== null) reject(new Error(SAFE_ERROR))
      else resolve(output.toString('utf8'))
    })
  })
}
interface Context {
  uid: number; home: string; directory: string
  homeStat: RecoveryStat; directoryStat: RecoveryStat
  homeHandle: RecoveryHandle; directoryHandle: RecoveryHandle
  handles: RecoveryHandle[]
  path(name: string): string
}

export function createRecoveryIO(files: Readonly<{ prepared: string; consumed: string }>, options: RecoveryIOOptions = {}): RecoveryIO {
  const io = options.fs ?? nativeFS
  const account = options.account ?? (() => userInfo())
  const probe = options.probe ?? nativeProbe
  // Capture configuration: mutating a caller's object cannot enable methods later.
  const acknowledged = options.acknowledgeLocalStorage === true
  const names = { prepared: files.prepared, consumed: files.consumed }
  function enabled(): void {
    if (!acknowledged || names.prepared !== 'maintenance.prepared.json' || names.consumed !== 'maintenance.consumed.json') refuse()
  }
  function directory(s: RecoveryStat, uid: number, privateMode: boolean): void {
    if (!s.isDirectory() || s.uid !== BigInt(uid) || s.ino <= 0n || s.birthtimeNs <= 0n ||
        (privateMode ? (s.mode & 0o7777n) !== 0o700n : (s.mode & 0o022n) !== 0n)) refuse()
  }
  function file(s: RecoveryStat, uid: number, links = 1n): void {
    if (!s.isFile() || s.uid !== BigInt(uid) || s.ino <= 0n || s.birthtimeNs <= 0n ||
        (s.mode & 0o7777n) !== 0o600n || s.nlink !== links) refuse()
  }
  async function opened(c: Context, path: string, flags: number, mode?: number): Promise<RecoveryHandle> {
    const h = await io.open(path, flags, mode); c.handles.push(h); return h
  }
  async function stable(c: Context): Promise<void> {
    const h = await io.lstat(c.home)
    const d = await io.lstat(c.directory)
    directory(h, c.uid, false); directory(d, c.uid, true)
    if (!same(h, c.homeStat) || !same(d, c.directoryStat)) refuse()
  }
  async function within<T>(run: (c: Context) => Promise<T>, afterClose?: (c: Context, value: T) => Promise<void>): Promise<T> {
    enabled()
    const handles: RecoveryHandle[] = []
    let context: Context | undefined
    let value: T | undefined
    let failed = false
    try {
      const a = await account()
      if (!Number.isSafeInteger(a.uid) || a.uid < 0 || !isAbsolute(a.homedir) || a.homedir.includes('\0')) refuse()
      const homeHandle = await io.open(a.homedir, DIRECTORY_FLAGS); handles.push(homeHandle)
      const homeStat = await homeHandle.stat(); directory(homeStat, a.uid, false)
      const homePathStat = await io.lstat(a.homedir)
      directory(homePathStat, a.uid, false)
      if (!same(homeStat, homePathStat)) refuse()
      const directoryHandle = await io.open(`/proc/self/fd/${homeHandle.fd}/${DIRECTORY}`, DIRECTORY_FLAGS); handles.push(directoryHandle)
      const directoryStat = await directoryHandle.stat(); directory(directoryStat, a.uid, true)
      context = { uid: a.uid, home: a.homedir, directory: join(a.homedir, DIRECTORY), homeHandle, directoryHandle, homeStat, directoryStat, handles,
        path: (name) => `/proc/self/fd/${directoryHandle.fd}/${name}` }
      await stable(context)
      value = await run(context)
      // Compare open descriptions too; identity intentionally excludes dir mtime.
      if (!same(homeStat, await homeHandle.stat()) || !same(directoryStat, await directoryHandle.stat())) refuse()
      await stable(context)
    } catch { failed = true }
    for (const h of handles.reverse()) {
      try { await h.close() } catch { failed = true }
    }
    // Only return after every close has actually settled, then recheck path identity.
    if (context) {
      try {
        await stable(context)
        if (!failed && afterClose) await afterClose(context, value as T)
        await stable(context)
      } catch { failed = true }
    }
    if (failed) refuse()
    return value as T
  }
  async function bounded(c: Context, path: string, limit: number, owned: boolean, links = 1n): Promise<{ text: string; stat: RecoveryStat; handle: RecoveryHandle }> {
    const h = await opened(c, path, READ_FLAGS)
    const before = await h.stat()
    if (!before.isFile() || before.size < 0n || before.size > BigInt(limit)) refuse()
    if (owned) file(before, c.uid, links)
    const pathBefore = await io.lstat(path)
    if (!same(before, pathBefore) || markerIdentity(before) !== markerIdentity(pathBefore)) refuse()
    const bytes = Buffer.alloc(limit + 1)
    let total = 0
    while (total <= limit) {
      const { bytesRead } = await h.read(bytes, total, bytes.length - total, total)
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - total) refuse()
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > limit) refuse()
    const after = await h.stat()
    const pathAfter = await io.lstat(path)
    if (!same(before, after) || !same(before, pathAfter) || markerIdentity(before) !== markerIdentity(after) || markerIdentity(before) !== markerIdentity(pathAfter)) refuse()
    if (owned) { file(after, c.uid, links); file(pathAfter, c.uid, links) }
    // Reject invalid UTF-8 rather than silently replacing bytes.
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total)), stat: after, handle: h }
  }
  async function noFile(c: Context, name: string): Promise<void> {
    try { await io.lstat(c.path(name)) } catch (error) { if (absent(error)) return; throw error }
    refuse()
  }
  async function readWitness(c: Context, name: string): Promise<Witness> {
    const value: unknown = JSON.parse((await bounded(c, c.path(name), 8192, true)).text)
    if (!witnessValid(value)) refuse()
    return value
  }
  async function sync(c: Context): Promise<void> { await c.directoryHandle.sync(); await c.homeHandle.sync() }
  async function readCompletion(c: Context, name: string, witness: Witness, bootId: string): Promise<void> {
    const value: unknown = JSON.parse((await bounded(c, c.path(name), 8192, true)).text)
    if (!exactKeys(value, ['version', 'kind', 'witness', 'retiredInBoot']) || value.version !== 1 ||
        value.kind !== 'boot-bound-maintenance-retired' || value.retiredInBoot !== bootId ||
        !witnessEqual(value.witness, witness)) refuse()
  }
  async function writeWitness(c: Context, name: string, witness: Witness | Completion): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(witness) + '\n')
    if (bytes.length > 8192) refuse()
    const h = await opened(c, c.path(name), CREATE_FLAGS, 0o600)
    const before = await h.stat(); file(before, c.uid)
    const written = await h.write(bytes)
    if (written.bytesWritten !== bytes.length) refuse()
    await h.sync()
    const after = await h.stat(); file(after, c.uid)
    const pathStat = await io.lstat(c.path(name)); file(pathStat, c.uid)
    if (!same(before, after) || !same(after, pathStat) || markerIdentity(after) !== markerIdentity(pathStat) || after.size !== BigInt(bytes.length)) refuse()
    await sync(c)
  }
  async function snapshot(c: Context, links = 1n): Promise<RecoverySnapshot> {
    const bootFile = await bounded(c, '/proc/sys/kernel/random/boot_id', 64, false)
    const machineFile = await bounded(c, '/etc/machine-id', 64, false)
    for (const systemFile of [bootFile, machineFile]) {
      if (systemFile.stat.uid !== 0n || (systemFile.stat.mode & 0o022n) !== 0n) refuse()
    }
    const boot = bootFile.text
    const machine = machineFile.text
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$(?![\s\S])/.test(boot) || !/^[0-9a-f]{32}\n?$(?![\s\S])/.test(machine)) refuse()
    const result = await probe(c.directoryHandle.fd)
    const match = /^(ef53|58465342|9123683e):([0-9a-f]{1,32})\n$(?![\s\S])/.exec(result)
    if (!match || /^0+$/.test(match[2]) || result.length > 256) refuse()
    const marker = await bounded(c, c.path(MARKER), 64, true, links)
    if (marker.text !== PAYLOAD) refuse()
    return { version: 1, uid: c.uid, bootId: boot.trim(), machineHash: digest(machine.trim()), homeHash: digest(c.home), fsType: match[1], fsId: match[2],
      homeIdentity: identity(c.homeStat), directoryIdentity: identity(c.directoryStat), markerIdentity: markerIdentity(marker.stat) }
  }
  async function check(c: Context, expected: RecoverySnapshot, links = 1n): Promise<void> {
    if (!snapshotEqual(await snapshot(c, links), expected)) refuse()
  }
  async function guards(c: Context, witness: Witness): Promise<void> {
    if (!witnessEqual(await readWitness(c, names.prepared), witness) || !witnessEqual(await readWitness(c, names.consumed), witness)) refuse()
  }
  function expectedDirectories(c: Context, expected: RecoverySnapshot): void {
    if (c.uid !== expected.uid || digest(c.home) !== expected.homeHash || identity(c.homeStat) !== expected.homeIdentity || identity(c.directoryStat) !== expected.directoryIdentity) refuse()
  }
  return {
    inspect: () => within((c) => snapshot(c)),
    load: () => within(async (c) => { await noFile(c, names.consumed); return readWitness(c, names.prepared) }),
    persist: async (input) => {
      if (!witnessValid(input)) refuse()
      const witness: Witness = { ...input, snapshot: { ...input.snapshot } }
      await within(async (c) => {
        await check(c, witness.snapshot)
        await noFile(c, names.prepared); await noFile(c, names.consumed)
        await writeWitness(c, names.prepared, witness)
        await check(c, witness.snapshot)
        return (await bounded(c, c.path(names.prepared), 8192, true)).stat
      }, async (c, prepared) => {
        const marker = await io.lstat(join(c.directory, MARKER)); file(marker, c.uid)
        const saved = await io.lstat(join(c.directory, names.prepared)); file(saved, c.uid)
        if (markerIdentity(marker) !== witness.snapshot.markerIdentity || !same(prepared, saved) || markerIdentity(prepared) !== markerIdentity(saved)) refuse()
      })
    },
    retire: async (input, inputCurrent) => {
      if (!witnessValid(input) || !witnessValid({ version: 1, kind: 'boot-bound-maintenance', id: input.id, snapshot: inputCurrent })) refuse()
      const witness: Witness = { ...input, snapshot: { ...input.snapshot } }
      const current = { ...inputCurrent }
      if (witness.snapshot.bootId === current.bootId || SNAPSHOT_KEYS.some((key) => key !== 'bootId' && witness.snapshot[key] !== current[key])) refuse()
      // A new boot is required by the pure core; IO binds this operation to the
      // supplied current snapshot, never interprets reboot as a stopped receipt.
      const archive = `capture.retired.${witness.id}.marker`
      const completed = `maintenance.completed.${witness.id}.json`
      await within(async (c) => {
        await check(c, current)
        if (!witnessEqual(await readWitness(c, names.prepared), witness)) refuse()
        await noFile(c, names.consumed)
        // Exclusive consume is the cross-process finish gate. Failure never cleans it.
        await writeWitness(c, names.consumed, witness)
      })
      // Every phase closes all descriptions before the next destructive phase.
      await within(async (c) => {
        await check(c, current); await guards(c, witness)
        await io.link(c.path(MARKER), c.path(archive)) // hardlink never replaces
        const original = await bounded(c, c.path(MARKER), 64, true, 2n)
        const backup = await bounded(c, c.path(archive), 64, true, 2n)
        if (!same(original.stat, backup.stat) || original.text !== PAYLOAD || backup.text !== PAYLOAD || markerIdentity(original.stat) !== current.markerIdentity) refuse()
        await backup.handle.sync()
        await sync(c)
      })
      await within(async (c) => {
        await check(c, current, 2n); await guards(c, witness)
        const original = await bounded(c, c.path(MARKER), 64, true, 2n)
        const backup = await bounded(c, c.path(archive), 64, true, 2n)
        if (!same(original.stat, backup.stat) || backup.text !== PAYLOAD) refuse()
        await stable(c)
        const last = await io.lstat(c.path(MARKER)); file(last, c.uid, 2n)
        if (!same(last, original.stat) || markerIdentity(last) !== current.markerIdentity) refuse()
        await io.unlink(c.path(MARKER)); await sync(c)
      })
      await within(async (c) => {
        expectedDirectories(c, current); await guards(c, witness)
        const backup = await bounded(c, c.path(archive), 64, true)
        if (backup.text !== PAYLOAD || markerIdentity(backup.stat) !== current.markerIdentity) refuse()
        await noFile(c, MARKER)
        await writeWitness(c, completed, { version: 1, kind: 'boot-bound-maintenance-retired', witness, retiredInBoot: current.bootId })
      })
      await within(async (c) => {
        expectedDirectories(c, current); await guards(c, witness)
        await readCompletion(c, completed, witness, current.bootId)
        await io.unlink(c.path(names.prepared)); await sync(c)
      })
      await within(async (c) => {
        expectedDirectories(c, current)
        await noFile(c, names.prepared)
        if (!witnessEqual(await readWitness(c, names.consumed), witness)) refuse()
        await readCompletion(c, completed, witness, current.bootId)
        await io.unlink(c.path(names.consumed)); await sync(c)
      })
      // A final unlink followed by sync/close failure may leave no guards. Reject
      // uncertainty; never claim that a guard necessarily survived or recreate it.
    }
  }
}
