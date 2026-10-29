import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { PersistentComputerUseCoordination, type ComputerUseCoordinationReceipt } from '../../src/main/computer-use/coordination'

// Entirely synthetic account and filesystem. No userInfo, OS probes, temporary
// directories, Electron userData, desktop helpers, or actual marker operations.
const HOME = '/synthetic-account-home'
const DIR = `${HOME}/.pion-computer-use-coordination-v1`
const MARKER = `${DIR}/capture.marker`
const uid = 42n
function error(code: string) { return Object.assign(new Error(code), { code }) }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}
interface Node {
  ino: bigint
  mode: bigint
  uid: bigint
  type: 'directory' | 'file' | 'symlink'
  data: Uint8Array
  nlink: bigint
}
function memoryFS() {
  let nextInode = 1n
  const nodes = new Map<string, Node>()
  const events: string[] = []
  const live = new Set<object>()
  let hook: (event: string) => void | Promise<void> = () => {}
  const node = (type: Node['type'], mode: bigint): Node => ({ ino: nextInode++, mode, uid, type, data: new Uint8Array(), nlink: 1n })
  nodes.set(HOME, node('directory', 0o755n))
  const label = (path: string) => path === HOME ? 'home' : path === DIR ? 'directory'
    : path.endsWith('/maintenance.prepared.json') ? 'prepared'
      : path.endsWith('/maintenance.consumed.json') ? 'consumed' : 'marker'
  const step = async (event: string) => { events.push(event); await hook(event) }
  const stat = (entry: Node) => ({
    dev: 1n, ino: entry.ino, mode: entry.mode, uid: entry.uid, nlink: entry.nlink,
    isDirectory: () => entry.type === 'directory', isFile: () => entry.type === 'file'
  })
  const api = {
    mkdir: async (path: string, mode: number) => {
      await step('mkdir')
      if (nodes.has(path)) throw error('EEXIST')
      expect(path).toBe(DIR)
      expect(mode).toBe(0o700)
      nodes.set(path, node('directory', BigInt(mode)))
    },
    open: async (path: string, flags: number, mode?: number) => {
      const name = label(path)
      const create = (flags & constants.O_CREAT) !== 0
      await step(`${name}:open`)
      expect(flags & constants.O_NOFOLLOW).not.toBe(0)
      if (create) {
        expect(flags & constants.O_EXCL).not.toBe(0)
        expect(flags & constants.O_WRONLY).not.toBe(0)
        expect(mode).toBe(0o600)
        if (nodes.has(path)) throw error('EEXIST')
        nodes.set(path, node('file', BigInt(mode!)))
      }
      const entry = nodes.get(path)
      if (!entry) throw error('ENOENT')
      if (entry.type === 'symlink') throw error('ELOOP')
      if ((flags & constants.O_DIRECTORY) !== 0 && entry.type !== 'directory') throw error('ENOTDIR')
      const identity = {}
      live.add(identity)
      let closed = false
      const handle = {
        stat: async () => { await step(`${name}:stat`); return stat(entry) },
        write: async (payload: Uint8Array) => {
          await step('marker:write')
          entry.data = payload.slice()
          return { bytesWritten: payload.length }
        },
        sync: async () => { await step(`${name}:sync`) },
        close: async () => {
          expect(closed).toBe(false)
          await step(`${name}:close`)
          closed = true
          live.delete(identity)
        }
      }
      return handle
    },
    lstat: async (path: string) => {
      await step(`${label(path)}:lstat`)
      const entry = nodes.get(path)
      if (!entry) throw error('ENOENT')
      return stat(entry)
    },
    unlink: async (path: string) => {
      await step('unlink')
      if (!nodes.delete(path)) throw error('ENOENT')
    }
  }
  return { api, nodes, events, live, node, setHook: (value: typeof hook) => { hook = value } }
}
function fixture(f = memoryFS()) {
  const account = vi.fn(() => ({ uid: Number(uid), homedir: HOME }))
  const coordinator = new PersistentComputerUseCoordination({ fs: f.api, account })
  return { f, account, coordinator }
}
async function claimReceipt(coordinator: PersistentComputerUseCoordination): Promise<ComputerUseCoordinationReceipt> {
  const result = await coordinator.claim()
  expect(result.kind).toBe('claimed')
  if (result.kind !== 'claimed') throw new Error('fixture did not claim')
  return result.receipt
}
const claimSteps = ['home:open', 'home:stat', 'home:lstat', 'mkdir', 'directory:open',
  'directory:stat', 'directory:lstat', 'prepared:lstat', 'consumed:lstat', 'marker:open', 'marker:stat', 'marker:lstat',
  'marker:write', 'marker:sync', 'directory:sync', 'home:sync', 'marker:close', 'directory:close', 'home:close']

// Waiting for the observed synthetic event avoids making timing claims based on
// a fixed number of microtasks; a pending operation remains truly unresolved.
function gate(f: ReturnType<typeof memoryFS>, target: string) {
  const entered = deferred()
  const wait = deferred()
  f.setHook(async (event) => {
    if (event === target) { entered.resolve(); await wait.promise }
  })
  return { entered: entered.promise, release: wait.resolve }
}

describe('PersistentComputerUseCoordination (synthetic filesystem only)', () => {
  it('constructs without filesystem/account access; has no read/probe API', () => {
    const { f, account, coordinator } = fixture()
    expect(f.events).toEqual([])
    expect(account).not.toHaveBeenCalled()
    expect('getState' in coordinator).toBe(false)
    new PersistentComputerUseCoordination() // No default account lookup or FS operation.
    expect(f.events).toEqual([])
  })

  it('coordinates simultaneous ordinary profiles sharing one system account home', async () => {
    const f = memoryFS()
    const a = fixture(f)
    const b = fixture(f)
    const results = await Promise.all([a.coordinator.claim(), b.coordinator.claim()])
    expect(results.map((r) => r.kind).sort()).toEqual(['claimed', 'occupied'])
    expect(a.account).toHaveBeenCalledOnce()
    expect(b.account).toHaveBeenCalledOnce()
    expect([...f.nodes.keys()]).toEqual([HOME, DIR, MARKER])
    expect(f.live.size).toBe(0)
    expect(f.nodes.get(MARKER)?.data).toEqual(new TextEncoder().encode('pion-computer-use-coordination-v1\n'))
    expect(f.events.indexOf('marker:sync')).toBeLessThan(f.events.indexOf('directory:sync'))
    expect(f.events.indexOf('directory:sync')).toBeLessThan(f.events.indexOf('home:sync'))
  })

  it.each(['empty', 'garbage', 'symlink'] as const)('never reads/parses/removes a %s existing marker', async (type) => {
    const { f, coordinator } = fixture()
    f.nodes.set(DIR, f.node('directory', 0o700n))
    const existing = f.node(type === 'symlink' ? 'symlink' : 'file', 0o600n)
    existing.data = new TextEncoder().encode(type === 'garbage' ? 'not a version, dead PID, ancient timestamp' : '')
    f.nodes.set(MARKER, existing)
    expect(await coordinator.claim()).toEqual({ kind: 'occupied' })
    expect(f.nodes.get(MARKER)).toBe(existing)
    expect(f.events).not.toContain('marker:stat')
    expect(f.events).not.toContain('marker:lstat')
    expect(f.events).not.toContain('unlink')
    expect(f.live.size).toBe(0)
  })

  it.each(['maintenance.prepared.json', 'maintenance.consumed.json'].flatMap((name) =>
    (['empty', 'garbage', 'directory', 'symlink'] as const).map((type) => ({ name, type }))))('blocks new capture for $type $name without reading or changing it', async ({ name, type }) => {
    const { f, coordinator } = fixture()
    f.nodes.set(DIR, f.node('directory', 0o700n))
    const guard = f.node(type === 'directory' || type === 'symlink' ? type : 'file', 0o600n)
    if (type === 'garbage') guard.data = new TextEncoder().encode('malformed maintenance')
    f.nodes.set(`${DIR}/${name}`, guard)
    expect(await coordinator.claim()).toEqual({ kind: 'occupied' })
    expect(f.nodes.get(`${DIR}/${name}`)).toBe(guard)
    expect(f.nodes.has(MARKER)).toBe(false)
    expect(f.events).not.toContain('marker:open')
    expect(f.events).not.toContain('unlink')
    expect(f.live.size).toBe(0)
  })

  it('a fresh coordinator after simulated crash cannot recover or unlock the marker', async () => {
    const { f, coordinator } = fixture()
    await claimReceipt(coordinator)
    const restarted = fixture(f).coordinator
    expect(await restarted.claim()).toEqual({ kind: 'occupied' })
    expect(f.nodes.has(MARKER)).toBe(true)
  })

  it.each(claimSteps)('claim stays pending at %s until actual completion (including closes)', async (target) => {
    const { f, coordinator } = fixture()
    const g = gate(f, target)
    let settled = false
    const pending = coordinator.claim().then((result) => { settled = true; return result })
    await g.entered
    expect(settled).toBe(false)
    g.release()
    expect((await pending).kind).toBe('claimed')
    expect(f.live.size).toBe(0)
  })

  it.each(claimSteps)('classifies %s failure and closes every admitted handle', async (target) => {
    const { f, coordinator } = fixture()
    f.setHook((event) => { if (event === target) throw error('EACCES') })
    const result = await coordinator.claim()
    const afterCreation = claimSteps.indexOf(target) > claimSteps.indexOf('marker:open')
    const createAttempted = claimSteps.indexOf(target) >= claimSteps.indexOf('marker:open')
    expect(result.kind).toBe(createAttempted ? 'unknown' : 'failed-clean')
    expect(f.nodes.has(MARKER)).toBe(afterCreation)
    expect(f.events).not.toContain('unlink')
    // Rejected close is unknown, not a claimed/clean result, even if a different
    // FD can close. The synthetic rejected FD remains open to model uncertainty.
    expect(f.live.size).toBe(target.endsWith(':close') ? 1 : 0)
  })

  it.each(['EACCES', 'ENOSPC'])('does not infer no side effects from an exclusive-open %s rejection', async code => {
    const { f, coordinator } = fixture()
    f.setHook(event => {
      if (event === 'marker:open') {
        f.nodes.set(MARKER, f.node('file', 0o600n))
        throw error(code)
      }
    })
    expect(await coordinator.claim()).toEqual({ kind: 'unknown' })
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.events).not.toContain('unlink')
    f.setHook(() => {})
    expect(await fixture(f).coordinator.claim()).toEqual({ kind: 'occupied' })
  })

  it('a proven pre-create failure becomes unknown if any cleanup close fails', async () => {
    const { f, coordinator } = fixture()
    f.setHook((event) => {
      if (event === 'directory:stat') throw error('EACCES')
      if (event === 'directory:close') throw error('EIO')
    })
    expect(await coordinator.claim()).toEqual({ kind: 'unknown' })
    expect(f.nodes.has(MARKER)).toBe(false)
    expect(f.events).toContain('home:close')
    expect(f.live.size).toBe(1)
  })

  it('unclassified exclusive-open failure is unknown even with no observable marker', async () => {
    const { f, coordinator } = fixture()
    f.setHook((event) => { if (event === 'marker:open') throw error('EIO') })
    expect(await coordinator.claim()).toEqual({ kind: 'unknown' })
    expect(f.live.size).toBe(0)
  })

  it('unknown exclusive-open failure may have created a marker; never deletes or retries', async () => {
    const { f, coordinator } = fixture()
    f.setHook((event) => {
      if (event === 'marker:open') {
        f.nodes.set(MARKER, f.node('file', 0o600n))
        throw error('EIO')
      }
    })
    expect(await coordinator.claim()).toEqual({ kind: 'unknown' })
    expect(f.events.filter((event) => event === 'marker:open')).toHaveLength(1)
    expect(f.events).not.toContain('unlink')
    expect(f.nodes.has(MARKER)).toBe(true)
  })

  it('partial write quarantines the created marker rather than removing it', async () => {
    const f = memoryFS()
    const open = f.api.open
    f.api.open = async (...args) => {
      const handle = await open(...args)
      if (args[0] === MARKER) handle.write = async () => ({ bytesWritten: 1 })
      return handle
    }
    expect(await fixture(f).coordinator.claim()).toEqual({ kind: 'unknown' })
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.events).not.toContain('unlink')
    expect(f.live.size).toBe(0)
  })

  it.each(['mode', 'uid', 'type'] as const)('rejects unsafe private directory %s before creating marker', async (field) => {
    const { f, coordinator } = fixture()
    const dir = f.node('directory', 0o700n)
    if (field === 'mode') dir.mode = 0o755n
    if (field === 'uid') dir.uid = 100n
    if (field === 'type') dir.type = 'symlink'
    f.nodes.set(DIR, dir)
    expect(await coordinator.claim()).toEqual({ kind: 'failed-clean' })
    expect(f.events).not.toContain('marker:open')
    expect(f.live.size).toBe(0)
  })

  it.each(['mode', 'uid', 'nlink', 'inode'] as const)('retains a newly created marker on %s validation failure', async (field) => {
    const { f, coordinator } = fixture()
    f.setHook((event) => {
      const entry = f.nodes.get(MARKER)
      if (event === 'marker:stat' && entry) {
        if (field === 'mode') entry.mode = 0o644n
        if (field === 'uid') entry.uid = 100n
        if (field === 'nlink') entry.nlink = 2n
      }
      if (event === 'marker:lstat' && field === 'inode') f.nodes.set(MARKER, f.node('file', 0o600n))
    })
    expect(await coordinator.claim()).toEqual({ kind: 'unknown' })
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.events).not.toContain('unlink')
    expect(f.live.size).toBe(0)
  })

  it('rejects forged, foreign, simultaneous replay and old receipts without affecting successors', async () => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    await expect(coordinator.release({ ...receipt })).rejects.toThrow('Foreign')
    await expect(fixture(f).coordinator.release(receipt)).rejects.toThrow('Foreign')
    const g = gate(f, 'unlink')
    const pending = coordinator.release(receipt)
    await g.entered
    await expect(coordinator.release(receipt)).rejects.toThrow('consumed')
    g.release()
    await pending
    f.setHook(() => {})
    const successor = fixture(f)
    const next = await claimReceipt(successor.coordinator)
    const current = f.nodes.get(MARKER)
    await expect(coordinator.release(receipt)).rejects.toThrow('consumed')
    expect(f.nodes.get(MARKER)).toBe(current)
    await successor.coordinator.release(next)
    expect(f.live.size).toBe(0)
  })

  it.each(['changed', 'missing'] as const)('refuses unlink when receipt path is %s', async (type) => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    if (type === 'missing') f.nodes.delete(MARKER)
    else f.nodes.set(MARKER, f.node('file', 0o600n))
    const current = f.nodes.get(MARKER)
    await expect(coordinator.release(receipt)).rejects.toThrow('uncertain')
    expect(f.events).not.toContain('unlink')
    expect(f.nodes.get(MARKER)).toBe(current)
    expect(f.live.size).toBe(0)
  })

  it('rejects an inode substitution between release FD stat and path stat', async () => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    const replacement = f.node('file', 0o600n)
    f.setHook((event) => { if (event === 'marker:lstat') f.nodes.set(MARKER, replacement) })
    await expect(coordinator.release(receipt)).rejects.toThrow('uncertain')
    expect(f.nodes.get(MARKER)).toBe(replacement)
    expect(f.events).not.toContain('unlink')
    expect(f.live.size).toBe(0)
  })

  it.each([HOME, DIR])('refuses release through a replaced directory %s', async (path) => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    f.nodes.set(path, f.node('directory', path === HOME ? 0o755n : 0o700n))
    await expect(coordinator.release(receipt)).rejects.toThrow('uncertain')
    expect(f.events).not.toContain('unlink')
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.live.size).toBe(0)
  })

  const releaseSteps = ['home:open', 'home:stat', 'home:lstat', 'directory:open', 'directory:stat',
    'directory:lstat', 'marker:open', 'marker:stat', 'marker:lstat', 'unlink',
    'directory:sync', 'marker:close', 'directory:close', 'home:close']
  it.each(releaseSteps)('release remains pending at %s until actual completion', async (target) => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    const g = gate(f, target)
    let settled = false
    const pending = coordinator.release(receipt).then(() => { settled = true })
    await g.entered
    expect(settled).toBe(false)
    g.release()
    await pending
    expect(f.live.size).toBe(0)
  })

  it.each(releaseSteps)('release rejects %s failure, never claims stopped or reinstalls a lock', async (target) => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    f.events.length = 0
    f.setHook((event) => { if (event === target) throw error('EIO') })
    await expect(coordinator.release(receipt)).rejects.toThrow('uncertain')
    expect(f.nodes.has(MARKER)).toBe(releaseSteps.indexOf(target) <= releaseSteps.indexOf('unlink'))
    expect(f.events).not.toContain('mkdir')
    expect(f.live.size).toBe(target.endsWith(':close') ? 1 : 0)
    await expect(coordinator.release(receipt)).rejects.toThrow('consumed')
  })

  it('post-unlink sync failure never recreates a lock over a successor', async () => {
    const { f, coordinator } = fixture()
    const receipt = await claimReceipt(coordinator)
    const successor = f.node('file', 0o600n)
    f.setHook((event) => {
      if (event === 'directory:sync') {
        f.nodes.set(MARKER, successor)
        throw error('EIO')
      }
    })
    await expect(coordinator.release(receipt)).rejects.toThrow('uncertain')
    expect(f.nodes.get(MARKER)).toBe(successor)
    expect(f.live.size).toBe(0)
  })
})
