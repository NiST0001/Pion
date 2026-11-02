import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { constants } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecoveryIO, type RecoveryFS } from '../../src/main/computer-use/recovery-io'
import { RECOVERY_FILES, finishRecovery, prepareRecovery, verifyRecovery } from '../../src/main/computer-use/recovery'
import { PersistentComputerUseCoordination } from '../../src/main/computer-use/coordination'

const children = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: children.spawn }))
// Exercise the Linux FD protocol against the synthetic FS on every host. Keep
// these flags and POSIX paths inside this module graph; native IO is never used.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, constants: { ...actual.constants, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 } }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual, isAbsolute: actual.posix.isAbsolute, join: actual.posix.join }
})
afterEach(() => { vi.unstubAllGlobals() })
// All accounts, files, boot generations and stat children below are synthetic.
// No temporary directories, actual /proc, user home, Portal or OS reset is used.
const HOME = '/synthetic-home'
const DIR = `${HOME}/.pion-computer-use-coordination-v1`
const MARKER = `${DIR}/capture.marker`
const BOOT = '/proc/sys/kernel/random/boot_id'
const MACHINE = '/etc/machine-id'
const oldBoot = '11111111-1111-4111-8111-111111111111'
const newBoot = '22222222-2222-4222-8222-222222222222'
const payload = 'pion-computer-use-coordination-v1\n'
function error(code: string) { return Object.assign(new Error('/private data'), { code }) }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}
interface Entry {
  ino: bigint; birthtimeNs: bigint; mtimeNs: bigint; uid: bigint; mode: bigint; nlink: bigint
  type: 'directory' | 'file' | 'symlink'; data: Buffer
}
function fixture(nativeProbe = false) {
  let inode = 1n; let fd = 10
  const nodes = new Map<string, Entry>()
  const live = new Map<number, { path: string; node: Entry }>()
  const events: string[] = []
  let hook: (event: string) => void | Promise<void> = () => {}
  function entry(type: Entry['type'], data = '', mode = type === 'directory' ? 0o700n : 0o600n): Entry {
    const ino = inode++
    return { ino, birthtimeNs: ino, mtimeNs: ino, uid: 42n, mode, nlink: 1n, type, data: Buffer.from(data) }
  }
  nodes.set(HOME, entry('directory', '', 0o755n)); nodes.set(DIR, entry('directory'))
  nodes.set(MARKER, entry('file', payload)); nodes.set(BOOT, entry('file', oldBoot + '\n'))
  nodes.set(MACHINE, entry('file', 'a'.repeat(32) + '\n'))
  for (const systemPath of [BOOT, MACHINE]) {
    nodes.get(systemPath)!.uid = 0n
    nodes.get(systemPath)!.mode = 0o444n
  }
  function pathOf(path: string): string {
    const matched = /^\/proc\/self\/fd\/(\d+)\/(.*)$/.exec(path)
    if (!matched) return path
    const opened = live.get(Number(matched[1]))
    if (!opened) throw error('EBADF')
    return `${opened.path}/${matched[2]}`
  }
  const label = (path: string) => path === HOME ? 'home' : path === DIR ? 'directory'
    : path === MARKER ? 'marker' : path === BOOT ? 'boot' : path === MACHINE ? 'machine'
      : path.slice(DIR.length + 1)
  async function step(event: string) { events.push(event); await hook(event) }
  const stat = (n: Entry) => ({ ...n, dev: 1n, size: BigInt(n.data.length),
    isDirectory: () => n.type === 'directory', isFile: () => n.type === 'file' })
  const fs: RecoveryFS = {
    open: async (raw, flags, mode) => {
      const path = pathOf(raw); const name = label(path)
      await step(`${name}:open`)
      expect(flags & constants.O_NOFOLLOW).not.toBe(0)
      if (flags & constants.O_CREAT) {
        expect(flags & constants.O_EXCL).not.toBe(0)
        expect(mode).toBe(0o600)
        if (nodes.has(path)) throw error('EEXIST')
        nodes.set(path, entry('file'))
      }
      const n = nodes.get(path)
      if (!n) throw error('ENOENT')
      if (n.type === 'symlink') throw error('ELOOP')
      if ((flags & constants.O_DIRECTORY) && n.type !== 'directory') throw error('ENOTDIR')
      const id = fd++; live.set(id, { path, node: n })
      return { fd: id,
        stat: async () => { await step(`${name}:stat`); return stat(n) },
        read: async (buffer, offset, length, position) => {
          await step(`${name}:read`)
          const data = n.data.subarray(position, position + length)
          buffer.set(data, offset); return { bytesRead: data.length }
        },
        write: async (buffer) => { await step(`${name}:write`); n.data = Buffer.from(buffer); n.mtimeNs++; return { bytesWritten: buffer.length } },
        sync: async () => { await step(`${name}:sync`) },
        close: async () => { await step(`${name}:close`); expect(live.has(id)).toBe(true); live.delete(id) }
      }
    },
    lstat: async (raw) => {
      const path = pathOf(raw); await step(`${label(path)}:lstat`)
      const n = nodes.get(path); if (!n) throw error('ENOENT'); return stat(n)
    },
    link: async (rawFrom, rawTo) => {
      const from = pathOf(rawFrom); const to = pathOf(rawTo)
      await step('archive:link')
      if (nodes.has(to)) throw error('EEXIST')
      const n = nodes.get(from); if (!n) throw error('ENOENT')
      n.nlink++; nodes.set(to, n)
    },
    unlink: async (raw) => {
      const path = pathOf(raw); await step(`${label(path)}:unlink`)
      const n = nodes.get(path); if (!n) throw error('ENOENT')
      nodes.delete(path); n.nlink--
    }
  }
  const account = vi.fn(() => ({ uid: 42, homedir: HOME }))
  const probe = vi.fn(async () => { await step('probe'); return 'ef53:123abc\n' })
  const options = { acknowledgeLocalStorage: true, account, fs, ...(nativeProbe ? {} : { probe }) }
  const io = createRecoveryIO(RECOVERY_FILES, options)
  function reboot() { nodes.get(BOOT)!.data = Buffer.from(newBoot + '\n') }
  return { io, fs, nodes, live, events, account, probe, options, entry, reboot,
    setHook: (value: typeof hook) => { hook = value } }
}
async function prepared() {
  const f = fixture()
  await prepareRecovery(f.io)
  const saved = JSON.parse(f.nodes.get(`${DIR}/${RECOVERY_FILES.prepared}`)!.data.toString())
  return { ...f, saved }
}

describe('boot-bound maintenance IO (synthetic storage and process only)', () => {
  it('constructs without account, filesystem or process access; acknowledgement is not mutable', async () => {
    const f = fixture()
    expect(f.events).toEqual([]); expect(f.account).not.toHaveBeenCalled()
    const options = { ...f.options, acknowledgeLocalStorage: false }
    const denied = createRecoveryIO(RECOVERY_FILES, options)
    options.acknowledgeLocalStorage = true
    await expect(denied.inspect()).rejects.toThrow('maintenance IO')
    expect(f.events).toEqual([]); expect(f.account).not.toHaveBeenCalled()
  })
  it('prepares without touching the original marker, then verifies and archives only in a different boot', async () => {
    const f = fixture(); const original = f.nodes.get(MARKER)
    await prepareRecovery(f.io)
    expect(f.nodes.get(MARKER)).toBe(original)
    expect(f.events).not.toContain('archive:link'); expect(f.events).not.toContain('marker:unlink')
    await expect(verifyRecovery(f.io)).rejects.toThrow('verify failed')
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(false)
    f.reboot()
    expect((await verifyRecovery(f.io)).kind).toBe('maintenance-verified')
    expect((await finishRecovery(f.io)).kind).toBe('maintenance-retired')
    expect(f.nodes.has(MARKER)).toBe(false)
    const archive = [...f.nodes.keys()].find((p) => p.includes('/capture.retired.'))!
    expect(f.nodes.get(archive)).toBe(original); expect(original?.nlink).toBe(1n)
    const completedPath = [...f.nodes.keys()].find((p) => p.includes('/maintenance.completed.'))!
    expect(JSON.parse(f.nodes.get(completedPath)!.data.toString())).toMatchObject({
      kind: 'boot-bound-maintenance-retired', retiredInBoot: newBoot, witness: { snapshot: { bootId: oldBoot } }
    })
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.prepared}`)).toBe(false)
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(false)
    expect(f.live.size).toBe(0)
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
  })
  it.each(['uid', 'mode', 'type', 'nlink', 'data'] as const)('rejects unsafe marker %s before preparing', async (field) => {
    const f = fixture(); const m = f.nodes.get(MARKER)!
    if (field === 'uid') m.uid = 99n
    if (field === 'mode') m.mode = 0o644n
    if (field === 'type') m.type = 'symlink'
    if (field === 'nlink') m.nlink = 2n
    if (field === 'data') m.data = Buffer.from('unrecognized legacy record')
    await expect(prepareRecovery(f.io)).rejects.toThrow('prepare failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.prepared}`)).toBe(false)
    expect(f.events).not.toContain('marker:unlink'); expect(f.live.size).toBe(0)
  })
  it.each(['marker', 'directory', 'machine', 'filesystem'] as const)('rejects changed %s identity without consuming', async (kind) => {
    const f = await prepared(); f.reboot()
    if (kind === 'marker') f.nodes.set(MARKER, f.entry('file', payload))
    if (kind === 'directory') f.nodes.set(DIR, f.entry('directory'))
    if (kind === 'machine') f.nodes.get(MACHINE)!.data = Buffer.from('b'.repeat(32) + '\n')
    if (kind === 'filesystem') f.probe.mockResolvedValue('ef53:ffff\n')
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(false)
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.live.size).toBe(0)
  })
  it.each(['794c7630:abc\n', '6969:abc\n', 'ef53:abc\nextra', 'ef53:abc\n\n', 'EF53:ABC\n', 'a'.repeat(300)])('refuses unsupported/malformed storage probe', async (output) => {
    const f = fixture(); f.probe.mockResolvedValue(output)
    await expect(prepareRecovery(f.io)).rejects.toThrow('prepare failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.prepared}`)).toBe(false)
    expect(f.live.size).toBe(0)
  })
  it('never overwrites an existing witness, including malformed data', async () => {
    const f = fixture(); const guard = f.entry('file', 'broken')
    f.nodes.set(`${DIR}/${RECOVERY_FILES.prepared}`, guard)
    await expect(prepareRecovery(f.io)).rejects.toThrow('prepare failed')
    expect(f.nodes.get(`${DIR}/${RECOVERY_FILES.prepared}`)).toBe(guard)
    expect(f.nodes.get(MARKER)?.data.toString()).toBe(payload)
  })
  it('consumes before mutation and never retries a failed retirement', async () => {
    const f = await prepared(); f.reboot()
    f.setHook((event) => { if (event === 'archive:link') throw error('EIO') })
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(true)
    expect(f.nodes.has(MARKER)).toBe(true)
    f.setHook(() => {})
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.events.filter((e) => e === 'archive:link')).toHaveLength(1)
    expect(f.live.size).toBe(0)
  })
  it('exclusive consumption permits only one simultaneous finish', async () => {
    const f = await prepared(); f.reboot()
    const results = await Promise.allSettled([finishRecovery(f.io), finishRecovery(f.io)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(f.events.filter((e) => e === 'archive:link')).toHaveLength(1)
    expect(f.live.size).toBe(0)
  })
  it('no-replace archive refuses an existing destination', async () => {
    const f = await prepared(); f.reboot()
    const path = `${DIR}/capture.retired.${f.saved.id}.marker`
    const foreign = f.entry('file', 'preserve'); f.nodes.set(path, foreign)
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.get(path)).toBe(foreign)
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(true)
  })
  it('failed consumed sync cannot unlink the original marker', async () => {
    const f = await prepared(); f.reboot()
    f.setHook((event) => { if (event === `${RECOVERY_FILES.consumed}:sync`) throw error('EIO') })
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.events).not.toContain('archive:link')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(true)
    expect(f.live.size).toBe(0)
  })
  it.each(['marker:read', 'probe', `${RECOVERY_FILES.prepared}:sync`, `${RECOVERY_FILES.prepared}:close`])('does not settle prepare while %s is actually pending', async (target) => {
    const f = fixture(); const entered = deferred(); const wait = deferred(); let held = false
    f.setHook(async (event) => { if (event === target && !held) { held = true; entered.resolve(); await wait.promise } })
    let settled = false
    const pending = prepareRecovery(f.io).then((r) => { settled = true; return r })
    await Promise.race([entered.promise, pending.then(() => { throw new Error(`prepare settled before ${target}`) })])
    expect(settled).toBe(false); expect(f.nodes.has(MARKER)).toBe(true)
    wait.resolve(); await pending
    expect(f.live.size).toBe(0)
  })
  it('close rejection is uncertainty, retains the guard and never reports prepare success', async () => {
    const f = fixture()
    let rejected = false
    f.setHook((event) => {
      if (event === `${RECOVERY_FILES.prepared}:close` && !rejected) { rejected = true; throw error('EIO') }
    })
    await expect(prepareRecovery(f.io)).rejects.toThrow('prepare failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.prepared}`)).toBe(true)
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.live.size).toBe(1)
  })
  it('does not pretend a final guard remains when unlink succeeded but sync failed', async () => {
    const f = await prepared(); f.reboot(); let removed = false
    f.setHook((event) => {
      if (event === `${RECOVERY_FILES.consumed}:unlink`) removed = true
      if (removed && event === 'directory:sync') throw error('EIO')
    })
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(false)
    expect(f.nodes.has(MARKER)).toBe(false)
    expect([...f.nodes.keys()].some((p) => p.includes('/capture.retired.'))).toBe(true)
  })
  it.each(['home-writable', 'missing-birth', 'zero-fsid', 'system-owner', 'system-writable', 'marker-bom', 'marker-utf8'])('refuses unsupported identity metadata: %s', async (kind) => {
    const f = fixture()
    if (kind === 'home-writable') f.nodes.get(HOME)!.mode = 0o777n
    if (kind === 'missing-birth') f.nodes.get(MARKER)!.birthtimeNs = 0n
    if (kind === 'zero-fsid') f.probe.mockResolvedValue('ef53:0000\n')
    if (kind === 'system-owner') f.nodes.get(MACHINE)!.uid = 42n
    if (kind === 'system-writable') f.nodes.get(BOOT)!.mode = 0o666n
    if (kind === 'marker-bom') f.nodes.get(MARKER)!.data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload)])
    if (kind === 'marker-utf8') f.nodes.get(MARKER)!.data = Buffer.from([0xff, 0xfe])
    await expect(prepareRecovery(f.io)).rejects.toThrow('prepare failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.prepared}`)).toBe(false)
    expect(f.live.size).toBe(0)
  })
  it.each([RECOVERY_FILES.prepared, RECOVERY_FILES.consumed])('retains partial %s write and never unlinks original', async (name) => {
    const f = fixture()
    if (name === RECOVERY_FILES.consumed) { await prepareRecovery(f.io); f.reboot() }
    const originalOpen = f.fs.open
    f.fs.open = async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (path.endsWith(`/${name}`) && (flags & constants.O_CREAT)) {
        const write = handle.write
        handle.write = async (bytes) => { await write(bytes.subarray(0, 1)); return { bytesWritten: 1 } }
      }
      return handle
    }
    await expect(name === RECOVERY_FILES.prepared ? prepareRecovery(f.io) : finishRecovery(f.io)).rejects.toThrow('failed')
    expect(f.nodes.get(`${DIR}/${name}`)?.data.length).toBe(1)
    expect(f.nodes.has(MARKER)).toBe(true)
    expect(f.events).not.toContain('marker:unlink')
    expect(f.live.size).toBe(0)
  })
  it.each(['consume', 'archive', 'completed'])('waits for actual %s close before advancing retirement', async (phase) => {
    const f = await prepared(); f.reboot(); const entered = deferred(); const wait = deferred(); let held = false
    f.setHook(async (event) => {
      const target = phase === 'consume' ? event === `${RECOVERY_FILES.consumed}:close`
        : phase === 'archive' ? event.startsWith('capture.retired.') && event.endsWith(':close')
          : event.startsWith('maintenance.completed.') && event.endsWith(':close')
      if (target && !held) { held = true; entered.resolve(); await wait.promise }
    })
    let settled = false
    const pending = finishRecovery(f.io).then((r) => { settled = true; return r })
    await Promise.race([entered.promise, pending.then(() => { throw new Error(`finish settled before ${phase}`) })])
    expect(settled).toBe(false)
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(true)
    expect(f.nodes.has(MARKER)).toBe(phase !== 'completed')
    if (phase === 'consume') expect(f.events).not.toContain('archive:link')
    wait.resolve(); await pending
    expect(f.live.size).toBe(0)
  })
  it('does not claim global isolation after the final guard removal followed by close failure', async () => {
    const f = await prepared(); f.reboot(); let removed = false; let failed = false
    f.setHook((event) => {
      if (event === `${RECOVERY_FILES.consumed}:unlink`) removed = true
      if (removed && event === 'directory:close' && !failed) { failed = true; throw error('EIO') }
    })
    await expect(finishRecovery(f.io)).rejects.toThrow('finish failed')
    expect(f.nodes.has(`${DIR}/${RECOVERY_FILES.consumed}`)).toBe(false)
    expect(f.nodes.has(MARKER)).toBe(false)
    // Matches ordinary coordination.release: a failed final close does not prove
    // the pathname survived, nor that unrelated future instances remain blocked.
    f.setHook(() => {})
    const another = new PersistentComputerUseCoordination({ account: f.account,
      fs: { ...f.fs, mkdir: async () => { throw error('EEXIST') } } })
    expect((await another.claim()).kind).toBe('claimed')
  })

  it.each(['prepare', 'verify', 'finish'])('Windows CLI rejects %s before loading maintenance IO', async (operation) => {
    const cliModule = '../../scripts/computer-use-maintenance.mjs'
    const { runMaintenance } = await import(cliModule)
    const load = vi.fn()
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
    const result = await runMaintenance([operation, '--local-only-storage'], load)
    expect(result.code).toBe(2)
    expect(load).not.toHaveBeenCalled()
  })

  it('native metadata probe uses only fixed stat and waits for actual process/stdio close', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough }
    child.stdout = new PassThrough(); children.spawn.mockReturnValue(child)
    const f = fixture(true)
    let settled = false
    const pending = f.io.inspect().then((result) => { settled = true; return result })
    await vi.waitFor(() => expect(children.spawn).toHaveBeenCalled())
    const [binary, args, options] = children.spawn.mock.calls.at(-1)!
    expect(binary).toBe('/usr/bin/stat')
    expect(args).toEqual(['--file-system', '--format=%t:%i', '--', '/proc/self/fd/3'])
    expect(options.shell).toBe(false); expect(options.env).toEqual({ LANG: 'C', LC_ALL: 'C' })
    expect(options.stdio[3]).toEqual(expect.any(Number))
    child.stdout.write('ef53:abc\n'); child.emit('exit', 0, null)
    await Promise.resolve(); expect(settled).toBe(false)
    child.stdout.end(); child.emit('close', 0, null)
    expect((await pending).fsId).toBe('abc'); expect(f.live.size).toBe(0)
  })
})
