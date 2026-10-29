import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionDiscovery, sessionDiscoveryDirectory } from '../../src/main/agent/session-discovery'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const timestamp = '2026-01-01T00:00:00.000Z'
const at = Date.parse(timestamp)
const header = (cwd: string, id = 'actual-header-id') => ({ type: 'session', version: 3, id, cwd, timestamp })
const message = (role: string, content: unknown, time: unknown = at + 1000) => ({
  type: 'message', timestamp, message: { role, content, timestamp: time }
})
const jsonl = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
async function fixture(cwd?: string) {
  const root = await actual.mkdtemp(join(tmpdir(), 'pion-discovery-'))
  roots.push(root)
  const owner = cwd ?? join(root, 'project')
  const directory = sessionDiscoveryDirectory(owner, root)
  await actual.mkdir(directory, { recursive: true })
  return { root, owner, directory, path: join(directory, 'filename-is-not-the-id.jsonl'), discovery: new SessionDiscovery(() => root) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}
beforeEach(() => {
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
  vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })))
})

describe('strict lightweight session discovery', () => {
  it('returns empty only for a confirmed absent bucket or a successfully read empty directory, without creating storage', async () => {
    const { root, owner, directory, discovery } = await fixture()
    expect(await discovery.list(owner)).toEqual([])
    await actual.rmdir(directory)
    expect(await discovery.list(owner)).toEqual([])
    await expect(actual.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.open).not.toHaveBeenCalled()
    expect(sessionDiscoveryDirectory(owner, root)).toBe(directory)
  })

  it('rejects directory stat/read failures and a missing directory that appears during confirmation', async () => {
    const { owner, directory, discovery } = await fixture()
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    await actual.rmdir(directory)
    await actual.writeFile(directory, 'not a directory')
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
  })

  it.each(['EACCES', 'ENOENT'])('rejects a listed file open failure (%s) instead of dropping its row', async (code) => {
    const { owner, path, discovery } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]))
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code }))
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
  })

  it('rejects non-files and symlinks before opening them or following arbitrary parentSession paths', async () => {
    const { owner, path, root, discovery } = await fixture()
    const privatePath = join(root, 'private.json')
    await actual.writeFile(privatePath, 'credential-shaped data')
    await actual.mkdir(path)
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    await actual.rmdir(path)
    // A directory symlink also exercises the pre-open guard on Windows.
    await actual.symlink(root, path, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    expect(fs.open).not.toHaveBeenCalled()
    await actual.unlink(path)
    await actual.writeFile(path, jsonl([{ ...header(owner), parentSession: privatePath }]))
    expect((await discovery.list(owner))[0].id).toBe('actual-header-id')
    expect(vi.mocked(fs.open).mock.calls.map(([opened]) => opened)).toEqual([path])
  })

  it.each([
    '{broken', 'null', '[]', '{"type":"message","message":{}}',
    JSON.stringify({ type: 'session', id: 'different-header', cwd: '/other', timestamp }),
    JSON.stringify({ type: 'session_info', name: 3 }),
    JSON.stringify(message('user', [{ type: 'text', text: 7 }])),
    JSON.stringify(message('user', 'bad clock', 1e100))
  ])('rejects malformed or invalid metadata lines: %s', async (line) => {
    const { owner, path, discovery } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]) + line + '\n')
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
  })

  it('rejects invalid headers/UTF-8 and accepts a complete final JSON line without repairing the file', async () => {
    const { owner, path, discovery } = await fixture()
    for (const value of [{ ...header(owner), id: '' }, { ...header(owner), timestamp: 'bad' }, { ...header(owner), cwd: '' }, { ...header(owner), version: 4 }]) {
      await actual.writeFile(path, jsonl([value]))
      await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    }
    await actual.writeFile(path, Buffer.concat([Buffer.from(jsonl([header(owner)])), Buffer.from([0xff, 10])]))
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    const content = jsonl([header(owner)]) + JSON.stringify(message('user', 'last line'))
    await actual.writeFile(path, content)
    expect((await discovery.list(owner))[0]).toMatchObject({ preview: 'last line', messageCount: 1 })
    expect(await actual.readFile(path, 'utf8')).toBe(content)
  })

  it('matches SDK 1.4.0 metadata semantics without keeping assistant text or allMessagesText', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { owner, path, directory, discovery } = await fixture()
    await actual.writeFile(path, jsonl([
      header(owner), { type: 'session_info', name: ' old name ' },
      message('system', 'system', at + 999_999), message('user', [{ type: 'image', data: 'ignored' }]),
      message('user', ''), message('user', [{ type: 'text', text: 'first' }, { type: 'text', text: '🙂'.repeat(100) }], at + 5000),
      message('assistant', [{ type: 'text', text: 'PRIVATE ASSISTANT CONTENT' }], at + 4000),
      message('toolResult', [], at + 999_999), { type: 'custom_message', content: 'ignored' },
      { type: 'compaction', summary: 'ignored', timestamp: '2099-01-01T00:00:00Z' },
      message('user', 'older branch', at + 2000), { type: 'session_info', name: '   ' }
    ]))
    const sdk = (await SessionManager.list(owner, directory))[0]
    const row = (await discovery.list(owner))[0]
    expect(row).toEqual({ projectCwd: resolve(owner), path, id: sdk.id, name: sdk.name,
      timestamp: sdk.created.toISOString(), mtime: sdk.modified.getTime(), preview: sdk.firstMessage.slice(0, 120), messageCount: sdk.messageCount })
    expect(row.messageCount).toBe(7)
    expect(row.mtime).toBe(at + 5000)
    expect(JSON.stringify(row)).not.toContain('PRIVATE')
    expect(row).not.toHaveProperty('allMessagesText')
    expect(row).not.toHaveProperty('totalTokens')
    await actual.writeFile(path, jsonl([header(owner), { type: 'session_info', name: '  latest name  ' }]))
    expect((await discovery.list(owner))[0]).toMatchObject({ name: 'latest name', preview: '(no messages)', messageCount: 0, mtime: at })
  })

  it('matches SDK legacy/missing versions, empty separators, entry clocks and stable filename ties without migration', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { owner, directory, discovery } = await fixture()
    const contents = new Map<string, string>()
    for (const [name, version] of [['a.jsonl', undefined], ['b.jsonl', 1], ['y.jsonl', 2], ['z.jsonl', 3]] as const) {
      const path = join(directory, name)
      const content = jsonl([
        { ...header(owner, name), version }, { type: 'message', timestamp, message: {
          role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '' }]
        } }, message('hookMessage', 'legacy custom message', at + 999_999)
      ])
      contents.set(path, content)
      await actual.writeFile(path, content)
    }
    const rows = await discovery.list(owner)
    const sdk = await SessionManager.list(owner, directory)
    expect(rows.map((row) => [row.id, row.preview, row.mtime, row.messageCount])).toEqual(
      sdk.map((row) => [row.id, row.firstMessage.slice(0, 120), row.modified.getTime(), row.messageCount]))
    expect(rows.map((row) => row.id)).toEqual(['z.jsonl', 'y.jsonl', 'b.jsonl', 'a.jsonl'])
    expect(rows.every((row) => row.preview === ' ' && row.mtime === at && row.messageCount === 2)).toBe(true)
    for (const [path, content] of contents) expect(await actual.readFile(path, 'utf8')).toBe(content)
  })

  it('isolates exact persisted header cwd for Unix and Windows bucket-encoding collisions', async () => {
    const f = await fixture()
    for (const [first, second] of [[join(f.root, 'a-b'), join(f.root, 'a', 'b')], ['C:\\repo\\a-b', 'C:\\repo\\a\\b']]) {
      const directory = sessionDiscoveryDirectory(first, f.root)
      expect(directory).toBe(sessionDiscoveryDirectory(second, f.root))
      await actual.mkdir(directory, { recursive: true })
      await actual.writeFile(join(directory, 'misleading-first.jsonl'), jsonl([header(first, 'first-header')]))
      await actual.writeFile(join(directory, 'misleading-second.jsonl'), jsonl([header(second, 'second-header')]))
      expect((await f.discovery.list(first)).map((row) => [row.projectCwd, row.id])).toEqual([[resolve(first), 'first-header']])
      expect((await f.discovery.list(second)).map((row) => [row.projectCwd, row.id])).toEqual([[resolve(second), 'second-header']])
    }
  })

  it('preserves existing lexical cwd normalization and keeps registered symlink aliases separate', async () => {
    const { owner, root, path, discovery } = await fixture()
    await actual.writeFile(path, jsonl([header(`${owner}/nested/..`)]))
    expect((await discovery.list(owner))[0].projectCwd).toBe(owner)
    await actual.mkdir(owner)
    const alias = join(root, 'registered-alias')
    await actual.symlink(owner, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasDirectory = sessionDiscoveryDirectory(alias, root)
    await actual.mkdir(aliasDirectory)
    await actual.writeFile(join(aliasDirectory, 'foreign.jsonl'), jsonl([header(owner, 'real-target')]))
    expect(await discovery.list(alias)).toEqual([])
    await actual.writeFile(join(aliasDirectory, 'own.jsonl'), jsonl([header(alias, 'registered-alias')]))
    expect((await discovery.list(alias)).map(row => [row.projectCwd, row.id])).toEqual([[alias, 'registered-alias']])
  })

  it('shares a colliding bucket scan but filters each concurrent caller by its own persisted cwd', async () => {
    const { root } = await fixture()
    const firstCwd = join(root, 'a-b')
    const secondCwd = join(root, 'a', 'b')
    const directory = sessionDiscoveryDirectory(firstCwd, root)
    await actual.mkdir(directory)
    await actual.writeFile(join(directory, 'first.jsonl'), jsonl([header(firstCwd, 'first')]))
    await actual.writeFile(join(directory, 'second.jsonl'), jsonl([header(secondCwd, 'second')]))
    const entered = deferred()
    const release = deferred()
    let paused = false
    const discovery = new SessionDiscovery(() => root, async () => {
      if (paused) return
      paused = true
      entered.resolve()
      await release.promise
    }, 1)
    const first = discovery.list(firstCwd)
    await entered.promise
    const second = discovery.list(secondCwd)
    release.resolve()
    const results = await Promise.all([first, second])
    expect(results.map(rows => rows.map(row => [row.projectCwd, row.id]))).toEqual([
      [[firstCwd, 'first']], [[secondCwd, 'second']]
    ])
    expect(fs.open).toHaveBeenCalledTimes(2)
  })

  it('reuses unchanged parsed metadata, rechecks readability and preserves the prior cache after a failed scan', async () => {
    const { owner, directory, discovery } = await fixture()
    const existing = join(directory, 'z-existing.jsonl')
    const added = join(directory, 'y-added.jsonl')
    const bad = join(directory, 'a-bad.jsonl')
    await actual.writeFile(existing, jsonl([header(owner)]))
    const opened: { path: string; read: { mock: { calls: unknown[] } }; close: { mock: { calls: unknown[] } } }[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      opened.push({ path: String(args[0]), read: vi.spyOn(handle, 'read'), close: vi.spyOn(handle, 'close') })
      return handle
    })
    const first = await discovery.list(owner)
    first[0].preview = 'caller mutation'
    expect((await discovery.list(owner))[0].preview).toBe('(no messages)')
    expect(opened[1].read.mock.calls).toHaveLength(0)
    expect(opened[1].close.mock.calls).toHaveLength(1)
    await actual.writeFile(added, jsonl([header(owner, 'new-header')]))
    await actual.writeFile(bad, 'broken\n')
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    await actual.unlink(bad)
    await discovery.list(owner)
    const addedReads = opened.filter((entry) => entry.path === added)
    expect(addedReads).toHaveLength(2)
    expect(addedReads.every((entry) => entry.read.mock.calls.length > 0)).toBe(true)
    expect(opened.filter((entry) => entry.path === existing).slice(1).every((entry) => entry.read.mock.calls.length === 0)).toBe(true)
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
  })

  it('reparses actual growth, truncation and replacement instead of reusing stale cached metadata', async () => {
    const { owner, path, discovery } = await fixture()
    await actual.writeFile(path, jsonl([header(owner), message('user', 'original')]))
    expect((await discovery.list(owner))[0]).toMatchObject({ preview: 'original', messageCount: 1, mtime: at + 1000 })
    await actual.appendFile(path, jsonl([message('assistant', 'later', at + 9000), { type: 'session_info', name: 'new name' }]))
    expect((await discovery.list(owner))[0]).toMatchObject({ preview: 'original', messageCount: 2, mtime: at + 9000, name: 'new name' })
    await actual.writeFile(path, jsonl([header(owner)]))
    const truncated = (await discovery.list(owner))[0]
    expect(truncated).toMatchObject({ preview: '(no messages)', messageCount: 0, mtime: at })
    expect(truncated.name).toBeUndefined()
    await actual.rename(path, path + '.old')
    await actual.writeFile(path, jsonl([header(owner, 'replacement'), message('user', 'replacement')]))
    expect((await discovery.list(owner))[0]).toMatchObject({ id: 'replacement', preview: 'replacement', messageCount: 1 })
  })

  it.each([1, 2])('rechecks cached descriptor stamps at FD stat %s and closes the actual reader on change', async point => {
    const { owner, path, discovery } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]))
    await discovery.list(owner)
    const handle = await actual.open(path, 'r')
    const stat = handle.stat.bind(handle)
    let calls = 0
    vi.spyOn(handle, 'stat').mockImplementation(async () => {
      if (++calls === point) await actual.appendFile(path, '\n')
      return stat({ bigint: true })
    })
    const read = vi.spyOn(handle, 'read')
    const close = vi.spyOn(handle, 'close')
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect((await discovery.list(owner))[0].id).toBe('actual-header-id')
  })

  it.each(['content', 'path', 'directory'])('rejects changed %s stamps instead of publishing a mixed scan', async (change) => {
    const { owner, root, directory, path } = await fixture()
    const content = jsonl([header(owner), message('user', 'initial')])
    await actual.writeFile(path, content)
    let changed = false
    const discovery = new SessionDiscovery(() => root, async () => {
      if (changed) return
      changed = true
      if (change === 'content') await actual.appendFile(path, '\n')
      else if (change === 'path') {
        await actual.rename(path, path + '.old')
        await actual.writeFile(path, content)
      } else await actual.writeFile(join(directory, 'new.jsonl'), jsonl([header(owner, 'other')]))
    })
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
  })

  it('rechecks earlier cached files after later files settle, and closes readers on read failure', async () => {
    const { owner, root, directory } = await fixture()
    const first = join(directory, 'z-first.jsonl')
    const last = join(directory, 'a-last.jsonl')
    await actual.writeFile(first, jsonl([header(owner, 'first')]))
    await actual.writeFile(last, jsonl([header(owner, 'last')]))
    let armed = false
    let changed = false
    const discovery = new SessionDiscovery(() => root, async () => {
      if (armed && !changed && vi.mocked(fs.open).mock.calls.some(([path]) => path === last)) {
        changed = true
        await actual.appendFile(first, '\n')
      }
    })
    await discovery.list(owner)
    vi.mocked(fs.open).mockClear()
    armed = true
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    const handle = await actual.open(first, 'r')
    const close = vi.spyOn(handle, 'close')
    vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('read failed'))
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    expect(close).toHaveBeenCalledOnce()
  })

  it('streams lines past token-reader budgets and yields while retaining only the preview', async () => {
    const { owner, root, path } = await fixture()
    const large = '🙂'.repeat(300_000)
    await actual.writeFile(path, jsonl([header(owner), message('user', large), message('assistant', large)]))
    const yieldRead = vi.fn(async () => { await setImmediate() })
    const row = (await new SessionDiscovery(() => root, yieldRead).list(owner))[0]
    expect(row.preview).toBe(large.slice(0, 120))
    expect(row.messageCount).toBe(2)
    expect(JSON.stringify(row).length).toBeLessThan(1000)
    expect(yieldRead.mock.calls.length).toBeGreaterThan(30)
  })

  it('keeps the actual pending scan through close, then rejects cancelled or changed-root results', async () => {
    const { owner, root, path } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]))
    for (const reason of ['abort', 'root']) {
      const entered = deferred()
      const release = deferred()
      const handle = await actual.open(path, 'r')
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { entered.resolve(); await release.promise; await close() })
      vi.mocked(fs.open).mockResolvedValueOnce(handle)
      let currentRoot = root
      const discovery = new SessionDiscovery(() => currentRoot)
      const controller = new AbortController()
      let settled = false
      const reading = discovery.list(owner, { signal: controller.signal }).finally(() => { settled = true })
      const rejected = expect(reading).rejects.toThrow()
      await entered.promise
      if (reason === 'abort') controller.abort()
      else currentRoot = root + '-other'
      await setImmediate()
      expect(settled).toBe(false)
      release.resolve()
      await rejected
    }
  })

  it('bounds settled metadata with LRU eviction and reparses only an evicted bucket', async () => {
    const { root } = await fixture()
    const owners = ['first', 'second', 'third'].map(name => join(root, name))
    for (const owner of owners) {
      const directory = sessionDiscoveryDirectory(owner, root)
      await actual.mkdir(directory)
      await actual.writeFile(join(directory, 'session.jsonl'), jsonl([header(owner)]))
    }
    const opened: { path: string; read: { mock: { calls: unknown[] } } }[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      opened.push({ path: String(args[0]), read: vi.spyOn(handle, 'read') })
      return handle
    })
    const discovery = new SessionDiscovery(() => root, undefined, 2)
    await discovery.list(owners[0])
    await discovery.list(owners[1])
    await discovery.list(owners[0]) // First is now MRU; second must be evicted.
    await discovery.list(owners[2])
    await discovery.list(owners[0])
    await discovery.list(owners[1])
    const first = opened.filter(file => file.path === join(sessionDiscoveryDirectory(owners[0], root), 'session.jsonl'))
    const second = opened.filter(file => file.path === join(sessionDiscoveryDirectory(owners[1], root), 'session.jsonl'))
    expect(first.map(file => file.read.mock.calls.length > 0)).toEqual([true, false, false])
    expect(second.map(file => file.read.mock.calls.length > 0)).toEqual([true, true])
    for (const capacity of [0, -1, 1.5, Infinity]) {
      expect(() => new SessionDiscovery(() => root, undefined, capacity)).toThrow('Invalid discovery cache capacity')
    }
  })

  it('keeps the default 64-bucket capacity while every real scan is pending', async () => {
    const { root } = await fixture()
    const entered = deferred()
    const release = deferred()
    let waiting = 0
    const discovery = new SessionDiscovery(() => root, async () => {
      if (++waiting === 64) entered.resolve()
      await release.promise
    })
    const readers = Array.from({ length: 64 }, (_, index) => discovery.list(join(root, `pending-${index}`)))
    await entered.promise
    await expect(discovery.list(join(root, 'overflow'))).rejects.toThrow('Session discovery unavailable')
    release.resolve()
    expect((await Promise.all(readers)).every(rows => rows.length === 0)).toBe(true)
    expect(await discovery.list(join(root, 'overflow'))).toEqual([])
  })

  it('shares an actual scan through cancelled waits and delayed close, retaining capacity until settlement', async () => {
    const { root, owner, path } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]))
    const entered = deferred()
    const release = deferred()
    const handle = await actual.open(path, 'r')
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => { entered.resolve(); await release.promise; await close() })
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    const discovery = new SessionDiscovery(() => root, undefined, 1)
    const controller = new AbortController()
    const first = discovery.list(owner, { signal: controller.signal })
    const rejected = expect(first).rejects.toThrow()
    const shared = discovery.list(owner + '/.')
    await entered.promise
    controller.abort()
    await expect(discovery.list(owner + '-other')).rejects.toThrow('Session discovery unavailable')
    expect(fs.open).toHaveBeenCalledOnce()
    release.resolve()
    await rejected
    expect((await shared)[0].id).toBe('actual-header-id')
    expect(await discovery.list(owner + '-other')).toEqual([])
  })

  it('keeps unknown-close isolation under capacity pressure and rejects new buckets when every slot is isolated', async () => {
    const { root, owner, path } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]))
    const handle = await actual.open(path, 'r')
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('unknown close') })
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    let currentRoot = root
    const discovery = new SessionDiscovery(() => currentRoot, undefined, 1)
    await expect(discovery.list(owner)).rejects.toMatchObject({ closeUnknown: true })
    const statCalls = vi.mocked(fs.lstat).mock.calls.length
    await expect(discovery.list(owner + '-other')).rejects.toMatchObject({ closeUnknown: false })
    currentRoot = root + '-changed'
    await expect(discovery.list(owner)).rejects.toThrow('Session discovery unavailable')
    currentRoot = root
    await expect(discovery.list(owner)).rejects.toMatchObject({ closeUnknown: true })
    expect(fs.lstat).toHaveBeenCalledTimes(statCalls)
    expect(fs.open).toHaveBeenCalledOnce()
  })

  it('quarantines an unknown descriptor close within its bucket rather than reopening it', async () => {
    const { owner, path, discovery } = await fixture()
    await actual.writeFile(path, jsonl([header(owner)]))
    const handle = await actual.open(path, 'r')
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('unknown close') })
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(discovery.list(owner)).rejects.toMatchObject({ closeUnknown: true })
    await expect(discovery.list(owner)).rejects.toMatchObject({ closeUnknown: true })
    expect(fs.open).toHaveBeenCalledOnce()
    expect(await discovery.list(owner + '-other')).toEqual([])
  })
})
