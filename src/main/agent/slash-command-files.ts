import { constants, type BigIntStats } from 'node:fs'
import { lstat, link, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { SessionManager, VERSION, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { piPackageDir } from '../pi-runtime'
import type { PiChangelog } from '../../shared/slash-command-protocol'

export const SESSION_COMMAND_TEXT_MAX_BYTES = 1024 * 1024
export const PI_CHANGELOG_MAX_BYTES = 2 * 1024 * 1024
export const SESSION_COMMAND_EXPORT_MAX_BYTES = 32 * 1024 * 1024
const EXPORT_MAX_ENTRIES = 100_000
const EXPORT_MAX_LINE_BYTES = 1024 * 1024

/** A rejected close is not evidence that the underlying handle closed. */
export class SessionCommandFileStateUnknownError extends Error {}

type AssertOwned = () => void

function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** Never follows a final symlink, reads a device, or allocates from an unchecked size. */
async function readBoundedFile(path: string, maxBytes: number, assertOwned: AssertOwned, prepareExport = false) {
  assertOwned()
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error('当前系统不支持安全读取导出文件')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    assertOwned()
    const before = await handle.stat({ bigint: true })
    assertOwned()
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxBytes)) {
      throw new Error('文件为空、不是普通文件或超过读取上限')
    }
    const named = await lstat(path, { bigint: true })
    assertOwned()
    if (!named.isFile() || !sameSnapshot(before, named)) throw new Error('读取文件身份已变化')
    const data = Buffer.alloc(Number(before.size) + 1)
    let position = 0
    while (position < data.length) {
      const result = await handle.read(data, position, Math.min(64 * 1024, data.length - position), position)
      assertOwned()
      if (result.bytesRead === 0) break
      position += result.bytesRead
    }
    if (position !== Number(before.size)) throw new Error('读取期间文件大小已变化')
    let after = await handle.stat({ bigint: true })
    assertOwned()
    if (!sameSnapshot(before, after)) throw new Error('读取期间文件已变化')
    if (prepareExport) {
      // The SDK writes HTML with its normal permissions; make our export private
      // through the captured descriptor, never chmod a potentially replaced path.
      await handle.chmod(0o600)
      assertOwned()
      await handle.sync()
      assertOwned()
      after = await handle.stat({ bigint: true })
      assertOwned()
      // chmod legitimately changes ctime, not the checked bytes/size/mtime.
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw new Error('导出暂存文件内容已变化')
    }
    const current = await lstat(path, { bigint: true })
    assertOwned()
    if (!current.isFile() || !sameSnapshot(after, current)) throw new Error('读取文件身份已变化')
    return { data: data.subarray(0, position), snapshot: after }
  } finally {
    try { await handle.close() } catch {
      throw new SessionCommandFileStateUnknownError('无法确认导出读取句柄已关闭，请重启 Pion 后再试')
    }
  }
}

export async function readPiChangelog(assertOwned: AssertOwned): Promise<PiChangelog> {
  // Use the real unpacked package: Electron's virtual asar lstat identity need
  // not match the descriptor. No discovery, user configuration or network.
  const { data } = await readBoundedFile(join(piPackageDir(), 'CHANGELOG.md'), PI_CHANGELOG_MAX_BYTES, assertOwned)
  assertOwned()
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(data)
  return { version: VERSION, markdown }
}

/** Quoting belongs to the renderer's command parser, not to a shell or this API. */
export function sessionCommandExportPath(cwd: string, outputPath?: string): string {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new Error('导出工作目录无效')
  if (outputPath === undefined) {
    return join(cwd, `session-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.html`)
  }
  if (typeof outputPath !== 'string' || !outputPath.trim() || outputPath.length > 4096
    || /[\x00-\x1f\x7f]/.test(outputPath)) throw new Error('导出路径无效')
  const expanded = outputPath.startsWith('~/') || outputPath.startsWith('~\\')
    ? join(homedir(), outputPath.slice(2)) : outputPath
  return resolve(cwd, expanded)
}

/** Use only public SDK APIs on an in-memory manager. Opening a disk manager can
 * migrate/repair the source, so must not be used for a command's read-only export.
 * Like Pi's official JSONL export, make a fresh header and linearize the active
 * branch; abandoned branches, parentSession and unrelated labels are not copied.
 */
export function sessionCommandJsonl(
  cwd: string, sessionId: string, history: { entries: SessionEntry[]; leafId: string | null }
): string {
  if (!history || !Array.isArray(history.entries) || history.entries.length > EXPORT_MAX_ENTRIES
    || (history.leafId !== null && (typeof history.leafId !== 'string' || !history.leafId))) {
    throw new Error('会话分支数据无效或超过导出上限')
  }
  const entries = new Map<string, SessionEntry>()
  let inputBytes = 0
  for (const entry of history.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' || (entry as { type: string }).type === 'session'
      || typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 || entries.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !entry.parentId))
      || typeof entry.timestamp !== 'string') throw new Error('会话分支条目无效')
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    inputBytes += size
    if (size > EXPORT_MAX_LINE_BYTES || inputBytes > SESSION_COMMAND_EXPORT_MAX_BYTES) {
      throw new Error('会话超过 JSONL 导出上限')
    }
    entries.set(entry.id, entry)
  }
  // Validate before SDK traversal: broken chains/cycles must not truncate an
  // export or hang the main process. The SDK still selects the branch itself.
  const seen = new Set<string>()
  let id = history.leafId
  while (id !== null) {
    const entry = entries.get(id)
    if (!entry || seen.has(id)) throw new Error('会话分支链无效')
    seen.add(id)
    id = entry.parentId
  }
  const manager = SessionManager.inMemory(cwd, { id: sessionId }, history.entries)
  const header = manager.getHeader()
  if (!header || header.id !== sessionId || header.cwd !== cwd) throw new Error('会话导出身份无效')
  const branch = history.leafId === null ? [] : manager.getBranch(history.leafId)
  if (branch.length !== seen.size) throw new Error('会话分支已变化')
  const lines = [JSON.stringify(header)]
  let parentId: string | null = null
  for (const entry of branch) {
    lines.push(JSON.stringify({ ...entry, parentId }))
    parentId = entry.id
  }
  const result = `${lines.join('\n')}\n`
  if (Buffer.byteLength(result, 'utf8') > SESSION_COMMAND_EXPORT_MAX_BYTES) throw new Error('会话超过 JSONL 导出上限')
  return result
}

export async function writeSessionCommandJsonl(path: string, content: string, assertOwned: AssertOwned): Promise<void> {
  assertOwned()
  const handle = await open(path, 'wx', 0o600)
  try {
    assertOwned()
    await handle.writeFile(content, 'utf8')
    assertOwned()
    await handle.sync()
    assertOwned()
  } finally {
    try { await handle.close() } catch {
      throw new SessionCommandFileStateUnknownError('无法确认导出写入句柄已关闭，请重启 Pion 后再试')
    }
  }
  assertOwned()
}

/** Private same-directory scratch + atomic hard-link no-replace publication.
 * Filesystem checks are cooperative race defenses, not an OS sandbox. The
 * destination directory must already exist; never invent a fallback path.
 * Every actual FS/RPC promise remains awaited, including cleanup. On failure,
 * preserve the private scratch for recovery (and for a possibly late SDK writer).
 */
export async function publishSessionCommandExport(
  destination: string, produce: (scratchPath: string) => Promise<void>, assertOwned: AssertOwned
): Promise<string> {
  let scratchDir: string | undefined
  let published = false
  try {
    assertOwned()
    const parent = dirname(destination)
    const canonicalParent = await realpath(parent)
    assertOwned()
    if (canonicalParent !== parent) throw new Error('导出目录包含符号链接或路径别名')
    const directory = await lstat(parent, { bigint: true })
    assertOwned()
    if (!directory.isDirectory()) throw new Error('导出目录无效')
    const checkDirectory = async () => {
      const canonical = await realpath(parent)
      assertOwned()
      const current = await lstat(parent, { bigint: true })
      assertOwned()
      if (canonical !== parent || !current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) {
        throw new Error('导出目录身份已变化')
      }
    }
    let exists = false
    try { await lstat(destination); exists = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    assertOwned()
    if (exists) throw new Error('目标文件已存在，未覆盖')
    scratchDir = await mkdtemp(join(parent, '.pion-session-export-'))
    assertOwned()
    await checkDirectory()
    const scratch = await lstat(scratchDir, { bigint: true })
    assertOwned()
    if (!scratch.isDirectory() || (scratch.mode & 0o077n) !== 0n || scratch.dev !== directory.dev) {
      throw new Error('导出暂存目录不是同设备私有目录')
    }
    const privateDirectory = scratchDir
    const checkScratch = async () => {
      await checkDirectory()
      const canonical = await realpath(privateDirectory)
      assertOwned()
      const current = await lstat(privateDirectory, { bigint: true })
      assertOwned()
      if (canonical !== privateDirectory || !current.isDirectory() || current.dev !== scratch.dev
        || current.ino !== scratch.ino || (current.mode & 0o077n) !== 0n) throw new Error('导出暂存目录身份已变化')
    }
    await checkScratch()
    const scratchPath = join(scratchDir, basename(destination).toLowerCase().endsWith('.jsonl') ? 'session.jsonl' : 'session.html')
    await produce(scratchPath)
    assertOwned()
    await checkScratch()
    const { snapshot } = await readBoundedFile(scratchPath, SESSION_COMMAND_EXPORT_MAX_BYTES, assertOwned, true)
    assertOwned()
    await checkScratch()
    const named = await lstat(scratchPath, { bigint: true })
    assertOwned()
    if (!named.isFile() || !sameSnapshot(named, snapshot)) throw new Error('导出暂存文件身份已变化')
    // No overwrite-capable rename/copy, even if the destination appeared after preflight.
    await link(scratchPath, destination)
    published = true
    assertOwned()
    await checkScratch()
    const final = await lstat(destination, { bigint: true })
    assertOwned()
    // link() itself changes ctime/link count; retain content/inode identity.
    if (!final.isFile() || final.dev !== snapshot.dev || final.ino !== snapshot.ino
      || final.size !== snapshot.size || final.mtimeNs !== snapshot.mtimeNs) throw new Error('已发布文件身份无法复核')
    await unlink(scratchPath)
    assertOwned()
    await checkScratch()
    await rmdir(scratchDir)
    scratchDir = undefined
    assertOwned()
    return destination
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? '目标文件已存在，未覆盖' : error instanceof Error ? error.message : '导出失败'
    const message = `${published ? `已导出到 ${destination}，但后续收尾未完成` : '未发布导出文件'}：${reason}`
      + (scratchDir ? `；私有恢复目录：${scratchDir}` : '')
    if (error instanceof SessionCommandFileStateUnknownError) throw new SessionCommandFileStateUnknownError(message)
    throw new Error(message)
  }
}
