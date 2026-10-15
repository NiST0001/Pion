import { constants, type BigIntStats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionManager, VERSION } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PI_CHANGELOG_MAX_BYTES,
  SESSION_COMMAND_EXPORT_MAX_BYTES,
  SessionCommandFileStateUnknownError,
  publishSessionCommandExport,
  readPiChangelog,
  sessionCommandExportPath,
  sessionCommandJsonl,
  writeSessionCommandJsonl
} from '../../src/main/agent/slash-command-files'

const io = vi.hoisted(() => ({
  lstat: vi.fn(), link: vi.fn(), mkdtemp: vi.fn(), open: vi.fn(), realpath: vi.fn(), rmdir: vi.fn(), unlink: vi.fn()
}))
const sdk = vi.hoisted(() => ({ getPackageDir: vi.fn() }))
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), ...io }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...await original<typeof import('@earendil-works/pi-coding-agent')>(), getPackageDir: sdk.getPackageDir
}))

type VirtualFile = {
  kind: 'file' | 'directory' | 'symlink'; data: Buffer; ino: bigint; mode: bigint; ctimeNs: bigint; sizeOverride?: bigint
}
const files = new Map<string, VirtualFile>()
const handles: Array<ReturnType<typeof fileHandle>> = []
let inode = 0n
const parent = '/exports'
const destination = `${parent}/session.html`
const scratchDir = `${parent}/.pion-session-export-private`
const scratchPath = `${scratchDir}/session.html`
const packageDir = '/runtime/node_modules/@earendil-works/pi-coding-agent'
const changelogPath = join(packageDir, 'CHANGELOG.md')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function put(path: string, content = '', kind: VirtualFile['kind'] = 'file', mode = kind === 'directory' ? 0o40700n : 0o100600n) {
  const file: VirtualFile = { kind, data: Buffer.from(content), ino: ++inode, mode, ctimeNs: 1n }
  files.set(path, file)
  return file
}

function snapshot(file: VirtualFile): BigIntStats {
  return {
    dev: 1n, ino: file.ino, mode: file.mode,
    size: file.sizeOverride ?? BigInt(file.data.length), mtimeNs: 1n, ctimeNs: file.ctimeNs,
    isFile: () => file.kind === 'file', isDirectory: () => file.kind === 'directory'
  } as BigIntStats
}

function errno(code: string): Error { return Object.assign(new Error(code), { code }) }

function fileHandle(path: string, file: VirtualFile) {
  return {
    path, stat: vi.fn(async () => snapshot(file)),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: file.data.copy(buffer, offset, position, position + length), buffer
    })),
    chmod: vi.fn(async (mode: number) => { file.mode = 0o100000n | BigInt(mode); file.ctimeNs++ }),
    sync: vi.fn(async () => {}), close: vi.fn(async () => {}),
    writeFile: vi.fn(async (content: string) => { file.data = Buffer.from(content) })
  }
}

beforeEach(() => {
  files.clear()
  handles.length = 0
  inode = 0n
  sdk.getPackageDir.mockReset().mockReturnValue(packageDir)
  put(parent, '', 'directory')
  put(changelogPath, '# Bundled Pi changelog\n')
  for (const mock of Object.values(io)) mock.mockReset()
  io.realpath.mockImplementation(async (path: string) => path)
  io.lstat.mockImplementation(async (path: string) => {
    const file = files.get(path)
    if (!file) throw errno('ENOENT')
    return snapshot(file)
  })
  io.mkdtemp.mockImplementation(async (prefix: string) => {
    const path = `${prefix}private`
    put(path, '', 'directory')
    return path
  })
  io.open.mockImplementation(async (path: string, flags: number | string, mode?: number) => {
    if (flags === 'wx') {
      if (files.has(path)) throw errno('EEXIST')
      put(path, '', 'file', 0o100000n | BigInt(mode!))
    }
    const file = files.get(path)
    if (!file) throw errno('ENOENT')
    if (file.kind === 'symlink') throw errno('ELOOP')
    const handle = fileHandle(path, file)
    handles.push(handle)
    return handle
  })
  io.link.mockImplementation(async (source: string, target: string) => {
    if (files.has(target)) throw errno('EEXIST')
    const file = files.get(source)!
    file.ctimeNs++ // a real hard link changes ctime; it must not invalidate content identity
    files.set(target, file)
  })
  io.unlink.mockImplementation(async (path: string) => { files.delete(path) })
  io.rmdir.mockImplementation(async (path: string) => { files.delete(path) })
})

describe('command export path and branch serialization (public SDK only)', () => {
  it('resolves relative/~/ paths without a shell and defaults to a fresh visible HTML filename', () => {
    expect(sessionCommandExportPath(parent, 'a b/session.jsonl')).toBe(`${parent}/a b/session.jsonl`)
    expect(sessionCommandExportPath(parent, '~/a b/session.html')).toBe(join(homedir(), 'a b/session.html'))
    expect(sessionCommandExportPath(parent, '/other/session.html')).toBe('/other/session.html')
    const first = sessionCommandExportPath(parent), second = sessionCommandExportPath(parent)
    expect(first).toMatch(/^\/exports\/session-[^/]+\.html$/)
    expect(second).not.toBe(first)
    expect(sessionCommandExportPath(parent, '$(touch secret).html')).toBe(`${parent}/$(touch secret).html`)
    expect(io.open).not.toHaveBeenCalled()
  })

  it.each(['', ' ', 'a\n.html', 'a\0.html', 'x'.repeat(4097)])('rejects invalid explicit paths before filesystem calls', (path) => {
    expect(() => sessionCommandExportPath(parent, path)).toThrow('路径无效')
    expect(io.open).not.toHaveBeenCalled()
  })

  it('rejects noncanonical cwd rather than resolving it against the main-process cwd', () => {
    expect(() => sessionCommandExportPath('relative', 'file.html')).toThrow('工作目录无效')
    expect(() => sessionCommandExportPath('/exports/../other', 'file.html')).toThrow('工作目录无效')
  })

  it('selects the real RPC leaf, including metadata, without opening a disk manager or copying abandoned branches', () => {
    const manager = SessionManager.inMemory(parent, { id: 'export-fixture' })
    const root = manager.appendMessage({ role: 'user', timestamp: 1, content: 'kept prompt' })
    manager.appendCustomEntry('fixture', { active: true })
    const leaf = manager.getLeafId()!
    manager.appendMessage({ role: 'user', timestamp: 2, content: 'abandoned prompt' })
    manager.appendCustomEntry('abandoned', { secret: 'not on branch' })
    manager.branch(leaf)
    const source = manager.getEntries()
    const sourceJson = JSON.stringify(source)
    const rows = sessionCommandJsonl(parent, manager.getSessionId(), { entries: source, leafId: leaf })
      .trim().split('\n').map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({ type: 'session', id: 'export-fixture', cwd: parent })
    expect(rows[0]).not.toHaveProperty('parentSession')
    expect(rows.slice(1).map((entry) => entry.id)).toEqual([root, leaf])
    expect(rows[1].parentId).toBeNull()
    expect(rows[2].parentId).toBe(root)
    expect(JSON.stringify(rows)).not.toContain('abandoned')
    expect(JSON.stringify(source)).toBe(sourceJson)
    expect(io.open).not.toHaveBeenCalled()
  })

  it('honors an explicitly empty current branch even when abandoned entries exist', () => {
    const manager = SessionManager.inMemory(parent, { id: 'empty-branch' })
    manager.appendMessage({ role: 'user', timestamp: 1, content: 'old branch' })
    const rows = sessionCommandJsonl(parent, manager.getSessionId(), { entries: manager.getEntries(), leafId: null })
      .trim().split('\n').map((line) => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'session', id: 'empty-branch' })
  })

  it.each(['cycle', 'missing-parent', 'duplicate', 'missing-leaf', 'large-line'])('rejects %s before SDK traversal can hang or silently truncate', (kind) => {
    const manager = SessionManager.inMemory(parent, { id: 'invalid-branch' })
    const id = manager.appendMessage({ role: 'user', timestamp: 1, content: 'fixture' })
    const entries = manager.getEntries()
    if (kind === 'cycle') entries[0].parentId = id
    if (kind === 'missing-parent') entries[0].parentId = 'unknown'
    if (kind === 'duplicate') entries.push({ ...entries[0] })
    if (kind === 'large-line') {
      const entry = entries[0]
      if (entry.type === 'message' && entry.message.role === 'user') entry.message.content = 'x'.repeat(1024 * 1024)
    }
    expect(() => sessionCommandJsonl(parent, manager.getSessionId(), { entries, leafId: kind === 'missing-leaf' ? 'unknown' : id })).toThrow()
    expect(io.open).not.toHaveBeenCalled()
  })
})

describe('private no-replace command export publication (virtual filesystem)', () => {
  it('publishes a bounded private file by hard link, preserves content identity and awaits cleanup', async () => {
    const produce = vi.fn(async (path: string) => { put(path, '<html>session</html>', 'file', 0o100644n) })
    const assert = vi.fn()
    await expect(publishSessionCommandExport(destination, produce, assert)).resolves.toBe(destination)
    expect(produce).toHaveBeenCalledExactlyOnceWith(scratchPath)
    expect(io.link).toHaveBeenCalledExactlyOnceWith(scratchPath, destination)
    expect(files.get(destination)?.data.toString()).toBe('<html>session</html>')
    expect(files.get(destination)?.mode).toBe(0o100600n)
    expect(files.has(scratchPath)).toBe(false)
    expect(files.has(scratchDir)).toBe(false)
    expect(handles[0].close).toHaveBeenCalledOnce()
    expect(io.unlink).toHaveBeenCalledExactlyOnceWith(scratchPath)
    expect(io.rmdir).toHaveBeenCalledExactlyOnceWith(scratchDir)
    expect(io.open).toHaveBeenCalledExactlyOnceWith(scratchPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  })

  it('never invokes the producer or touches an existing file or final symlink', async () => {
    const original = put(destination, 'original', 'symlink')
    const produce = vi.fn()
    await expect(publishSessionCommandExport(destination, produce, () => {})).rejects.toThrow('目标文件已存在，未覆盖')
    expect(files.get(destination)).toBe(original)
    expect(produce).not.toHaveBeenCalled()
    expect(io.mkdtemp).not.toHaveBeenCalled()
    expect(io.unlink).not.toHaveBeenCalled()
  })

  it('keeps a complete private recovery file when a destination appears during publication', async () => {
    io.link.mockImplementationOnce(async (_source: string, target: string) => {
      put(target, 'concurrent original')
      throw errno('EEXIST')
    })
    await expect(publishSessionCommandExport(destination, async (path) => { put(path, 'complete export') }, () => {}))
      .rejects.toThrow(`私有恢复目录：${scratchDir}`)
    expect(files.get(destination)?.data.toString()).toBe('concurrent original')
    expect(files.get(scratchPath)?.data.toString()).toBe('complete export')
    expect(io.unlink).not.toHaveBeenCalled()
    expect(io.rmdir).not.toHaveBeenCalled()
  })

  it('rejects parent aliases and scratch-directory replacement before publication', async () => {
    io.realpath.mockResolvedValueOnce('/alias-target')
    const produce = vi.fn()
    await expect(publishSessionCommandExport(destination, produce, () => {})).rejects.toThrow('符号链接或路径别名')
    expect(produce).not.toHaveBeenCalled()
    await expect(publishSessionCommandExport(destination, async (path) => {
      put(path, 'export')
      put(dirname(path), '', 'symlink')
    }, () => {})).rejects.toThrow('暂存目录身份已变化')
    expect(io.link).not.toHaveBeenCalled()
  })

  it.each(['symlink', 'empty', 'large', 'device'])('rejects a %s scratch output without linking it', async (kind) => {
    await expect(publishSessionCommandExport(destination, async (path) => {
      const file = put(path, kind === 'empty' ? '' : 'output', kind === 'symlink' ? 'symlink' : 'file')
      if (kind === 'large') file.sizeOverride = BigInt(SESSION_COMMAND_EXPORT_MAX_BYTES) + 1n
      if (kind === 'device') file.kind = 'directory'
    }, () => {})).rejects.toThrow()
    expect(io.link).not.toHaveBeenCalled()
    expect(files.has(destination)).toBe(false)
  })

  it('rechecks the content bound after chmod/sync instead of accepting growth during preparation', async () => {
    const originalOpen = io.open.getMockImplementation()!
    io.open.mockImplementationOnce(async (...args: unknown[]) => {
      const handle = await originalOpen(...args)
      handle.sync.mockImplementationOnce(async () => {
        files.get(scratchPath)!.sizeOverride = BigInt(SESSION_COMMAND_EXPORT_MAX_BYTES) + 1n
      })
      return handle
    })
    await expect(publishSessionCommandExport(destination, async (path) => { put(path, 'output') }, () => {}))
      .rejects.toThrow('暂存文件内容已变化')
    expect(io.link).not.toHaveBeenCalled()
    expect(handles[0].close).toHaveBeenCalledOnce()
  })

  it('awaits the actual producer after ownership changes and keeps its scratch for recovery', async () => {
    const entered = deferred<void>(), finished = deferred<void>()
    let owned = true
    const exporting = publishSessionCommandExport(destination, async (path) => {
      put(path, 'output')
      entered.resolve()
      await finished.promise
    }, () => { if (!owned) throw new Error('owner changed') })
    const observed = expect(exporting).rejects.toThrow('owner changed')
    await entered.promise
    owned = false
    let settled = false
    void exporting.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(io.link).not.toHaveBeenCalled()
    finished.resolve()
    await observed
    expect(files.has(scratchPath)).toBe(true)
    expect(io.unlink).not.toHaveBeenCalled()
  })

  it('does not release a pending FD close and returns an unknown-state error when close rejects', async () => {
    const originalOpen = io.open.getMockImplementation()!
    const entered = deferred<void>(), closed = deferred<void>()
    io.open.mockImplementationOnce(async (...args: unknown[]) => {
      const handle = await originalOpen(...args)
      handle.close.mockImplementationOnce(async () => { entered.resolve(); await closed.promise; throw new Error('close failed') })
      return handle
    })
    const exporting = publishSessionCommandExport(destination, async (path) => { put(path, 'output') }, () => {})
    const observed = expect(exporting).rejects.toBeInstanceOf(SessionCommandFileStateUnknownError)
    await entered.promise
    expect(io.link).not.toHaveBeenCalled()
    expect(io.unlink).not.toHaveBeenCalled()
    closed.resolve()
    await observed
    expect(files.has(scratchPath)).toBe(true)
    expect(io.link).not.toHaveBeenCalled()
  })

  it('reports post-publication cleanup failure without deleting or rolling back the destination', async () => {
    io.rmdir.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(publishSessionCommandExport(destination, async (path) => { put(path, 'output') }, () => {}))
      .rejects.toThrow(`已导出到 ${destination}`)
    expect(files.get(destination)?.data.toString()).toBe('output')
    expect(io.unlink).toHaveBeenCalledExactlyOnceWith(scratchPath)
  })

  it('refuses a hard-link result whose destination inode is not the captured scratch inode', async () => {
    io.link.mockImplementationOnce(async (_source: string, target: string) => { put(target, 'replaced destination') })
    await expect(publishSessionCommandExport(destination, async (path) => { put(path, 'output') }, () => {}))
      .rejects.toThrow('已发布文件身份无法复核')
    expect(io.unlink).not.toHaveBeenCalled()
    expect(files.get(destination)?.data.toString()).toBe('replaced destination')
    expect(files.get(scratchPath)?.data.toString()).toBe('output')
  })

  it('writes JSONL only with exclusive creation, private permissions, sync and actual close', async () => {
    await expect(writeSessionCommandJsonl(`${parent}/private.jsonl`, 'jsonl\n', () => {})).resolves.toBeUndefined()
    expect(io.open).toHaveBeenCalledExactlyOnceWith(`${parent}/private.jsonl`, 'wx', 0o600)
    expect(handles[0].sync).toHaveBeenCalledOnce()
    expect(handles[0].close).toHaveBeenCalledOnce()
    await expect(writeSessionCommandJsonl(`${parent}/private.jsonl`, 'replacement', () => {})).rejects.toThrow('EEXIST')
    expect(files.get(`${parent}/private.jsonl`)?.data.toString()).toBe('jsonl\n')
  })

  it('preserves unknown JSONL write-handle close as an isolation error', async () => {
    const originalOpen = io.open.getMockImplementation()!
    io.open.mockImplementationOnce(async (...args: unknown[]) => {
      const handle = await originalOpen(...args)
      handle.close.mockRejectedValueOnce(new Error('close rejected'))
      return handle
    })
    await expect(writeSessionCommandJsonl(`${parent}/private.jsonl`, 'complete\n', () => {}))
      .rejects.toBeInstanceOf(SessionCommandFileStateUnknownError)
    expect(files.get(`${parent}/private.jsonl`)?.data.toString()).toBe('complete\n')
    expect(handles[0].close).toHaveBeenCalledOnce()
  })
})

describe('bundled Pi changelog bounded reads', () => {
  it('reads only the fixed package CHANGELOG.md and returns public SDK VERSION', async () => {
    await expect(readPiChangelog(() => {})).resolves.toEqual({ version: VERSION, markdown: '# Bundled Pi changelog\n' })
    expect(io.open).toHaveBeenCalledExactlyOnceWith(changelogPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    expect(handles[0].close).toHaveBeenCalledOnce()
    expect(io.mkdtemp).not.toHaveBeenCalled()
  })

  it.each(['app.asar', 'app.asar.unpacked'])('reads the real unpacked package when SDK reports %s (virtual filesystem only)', async (archive) => {
    const virtualPackage = join('/runtime/resources', 'app.asar', 'node_modules', '@earendil-works', 'pi-coding-agent')
    const unpackedPackage = join('/runtime/resources', 'app.asar.unpacked', 'node_modules', '@earendil-works', 'pi-coding-agent')
    const virtualPath = join(virtualPackage, 'CHANGELOG.md')
    const unpackedPath = join(unpackedPackage, 'CHANGELOG.md')
    sdk.getPackageDir.mockReturnValue(archive === 'app.asar' ? virtualPackage : unpackedPackage)
    put(virtualPath, '# Packaged Pi changelog\n')
    put(unpackedPath, '# Packaged Pi changelog\n') // different inode from Electron's virtual lstat
    const originalOpen = io.open.getMockImplementation()!
    io.open.mockImplementation(async (path: string, flags: number | string, mode?: number) => {
      // Model an asar open yielding a real FD while named lstat remains virtual.
      return originalOpen(path === virtualPath ? unpackedPath : path, flags, mode)
    })
    await expect(readPiChangelog(() => {})).resolves.toEqual({ version: VERSION, markdown: '# Packaged Pi changelog\n' })
    expect(io.open).toHaveBeenCalledExactlyOnceWith(unpackedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    expect(io.lstat).toHaveBeenCalledWith(unpackedPath, { bigint: true })
    expect(io.lstat).not.toHaveBeenCalledWith(virtualPath, expect.anything())
    expect(handles[0].close).toHaveBeenCalledOnce()
  })

  it('rejects oversized or invalid UTF-8 changelogs instead of truncating or replacing data', async () => {
    files.get(changelogPath)!.sizeOverride = BigInt(PI_CHANGELOG_MAX_BYTES) + 1n
    await expect(readPiChangelog(() => {})).rejects.toThrow('超过读取上限')
    delete files.get(changelogPath)!.sizeOverride
    files.get(changelogPath)!.data = Buffer.from([0xff])
    await expect(readPiChangelog(() => {})).rejects.toThrow()
    expect(handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
  })

  it('rejects file growth while still closing the real captured descriptor', async () => {
    const originalOpen = io.open.getMockImplementation()!
    io.open.mockImplementationOnce(async (...args: unknown[]) => {
      const handle = await originalOpen(...args)
      const read = handle.read.getMockImplementation()!
      handle.read.mockImplementationOnce(async (...readArgs: [Buffer, number, number, number]) => {
        const result = await read(...readArgs)
        files.get(changelogPath)!.data = Buffer.from('longer changelog content that grew during the read')
        return result
      })
      return handle
    })
    await expect(readPiChangelog(() => {})).rejects.toThrow('读取期间文件大小已变化')
    expect(handles[0].close).toHaveBeenCalledOnce()
  })
})
