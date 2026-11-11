import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { BrowserWindow, WebContents } from 'electron'
import type { IPty } from 'node-pty'
import { IPC_EVENTS } from '../shared/ipc'
import type { TerminalSnapshot, TerminalUpdate } from '../shared/terminal'

const MAX_OUTPUT = 256 * 1024
const MAX_TERMINALS = 8
const MAX_EXITED_SNAPSHOTS = 8
interface RecordEntry {
  owner: number
  snapshot: TerminalSnapshot
  pty: IPty
  pending: string
  truncated: boolean
  timer?: ReturnType<typeof setTimeout>
  dataSubscription?: { dispose(): void }
  exitSubscription?: { dispose(): void }
  closed: Promise<void>
  confirmClosed(): void
}

/** Terminals belong to a window and an initial real project directory, never to
 * the agent's currently selected session. Hiding the UI does not stop a shell. */
export class TerminalService {
  private readonly owners = new Map<number, WebContents>()
  private readonly entries = new Map<string, RecordEntry>()
  private readonly closing = new Map<string, RecordEntry>()
  private readonly opening = new Map<string, Promise<TerminalSnapshot>>()
  private readonly ownerOpenings = new Map<number, Set<Promise<TerminalSnapshot>>>()
  private readonly ownerDisposals = new Map<number, Promise<void>>()
  private shutdownPromise?: Promise<void>
  private closed = false

  private openingCount = 0
  private mutationGuard?: () => void

  setMutationGuard(guard: () => void): void { this.mutationGuard = guard }

  assertWorktreeDeletionIdle(cwd: string): void {
    if (this.openingCount || this.opening.size) throw new Error('终端正在打开，不能删除工作树')
    const target = resolve(cwd)
    const related = (directory: string): boolean => {
      const bound = resolve(directory)
      return bound === target || bound.startsWith(`${target}${sep}`) || target.startsWith(`${bound}${sep}`)
    }
    if ([...this.entries.values(), ...this.closing.values()].some((entry) => entry.snapshot.exitCode === undefined && related(entry.snapshot.cwd))) {
      throw new Error('相关终端尚未确认退出，请等待终端实际退出后删除工作树')
    }
  }

  bind(win: BrowserWindow): void {
    if (this.closed) throw new Error('终端服务已关闭')
    const owner = win.webContents.id
    this.owners.set(owner, win.webContents)
    win.once('closed', () => { void this.disposeOwner(owner) })
  }

  async open(owner: number, cwd: string, cols: number, rows: number): Promise<TerminalSnapshot> {
    this.assertOwner(owner)
    this.mutationGuard?.()
    this.openingCount += 1
    const opening = this.openReserved(owner, cwd, cols, rows)
    const openings = this.ownerOpenings.get(owner) ?? new Set<Promise<TerminalSnapshot>>()
    openings.add(opening)
    this.ownerOpenings.set(owner, openings)
    try { return await opening }
    finally {
      this.openingCount -= 1
      openings.delete(opening)
      if (!openings.size) this.ownerOpenings.delete(owner)
    }
  }

  private async openReserved(owner: number, cwd: string, cols: number, rows: number): Promise<TerminalSnapshot> {
    this.assertOwner(owner)
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('终端需要有效的绝对项目路径')
    const directory = await realpath(cwd)
    if (!(await stat(directory)).isDirectory()) throw new Error('终端工作目录不存在')
    this.assertOwner(owner)
    this.mutationGuard?.()
    const key = `${owner}\0${directory}`
    const inFlight = this.opening.get(key)
    if (inFlight) return inFlight
    const create = this.openDirectory(owner, directory, cols, rows)
    this.opening.set(key, create)
    try { return await create } finally { this.opening.delete(key) }
  }

  private async openDirectory(owner: number, cwd: string, cols: number, rows: number): Promise<TerminalSnapshot> {
    const existing = [...this.entries.values()].find((entry) => entry.owner === owner && entry.snapshot.cwd === cwd)
    if (existing) {
      this.flush(existing)
      if (existing.snapshot.exitCode !== undefined) this.cacheExited(existing)
      return { ...existing.snapshot }
    }
    const { spawn } = await import('node-pty')
    this.assertOwner(owner)
    if ([...this.entries.values(), ...this.closing.values()].filter((entry) => entry.owner === owner && entry.snapshot.exitCode === undefined).length >= MAX_TERMINALS) {
      throw new Error('最多运行 8 个项目终端，请先结束不再使用的终端并等待退出')
    }
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/bash'
    const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    delete env.ELECTRON_RUN_AS_NODE
    this.mutationGuard?.()
    const pty = spawn(shell, [], { cwd, cols: this.size(cols, 80), rows: this.size(rows, 24),
      name: 'xterm-256color', env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
    let confirmClosed!: () => void
    const closed = new Promise<void>((done) => { confirmClosed = done })
    const entry: RecordEntry = {
      owner, pty, snapshot: { id: randomUUID(), cwd, shell, output: '', sequence: 0 },
      pending: '', truncated: false, closed, confirmClosed
    }
    this.entries.set(entry.snapshot.id, entry)
    entry.dataSubscription = pty.onData((data) => {
      if (this.entries.get(entry.snapshot.id) !== entry || entry.snapshot.exitCode !== undefined) return
      entry.pending += data
      if (entry.pending.length > MAX_OUTPUT) { entry.pending = entry.pending.slice(-MAX_OUTPUT); entry.truncated = true }
      if (!entry.timer) entry.timer = setTimeout(() => this.flush(entry), 32)
    })
    entry.exitSubscription = pty.onExit(({ exitCode }) => {
      entry.snapshot.exitCode = exitCode
      entry.dataSubscription?.dispose()
      entry.dataSubscription = undefined
      entry.exitSubscription?.dispose()
      entry.exitSubscription = undefined
      entry.confirmClosed()
      if (this.closing.delete(entry.snapshot.id)) return
      this.flush(entry, true)
      this.cacheExited(entry)
    })
    return { ...entry.snapshot }
  }

  private flush(entry: RecordEntry, force = false): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    if (!entry.pending && !force) return
    const data = entry.pending
    entry.pending = ''
    entry.snapshot.output = (entry.snapshot.output + data).slice(-MAX_OUTPUT)
    const update: TerminalUpdate = { id: entry.snapshot.id, sequence: ++entry.snapshot.sequence, data,
      reset: entry.truncated || undefined, exitCode: entry.snapshot.exitCode }
    entry.truncated = false
    const owner = this.owners.get(entry.owner)
    if (owner && !owner.isDestroyed()) owner.send(IPC_EVENTS.TerminalData, update)
  }

  write(owner: number, id: string, data: string): void {
    const entry = this.get(owner, id)
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new Error('终端输入过大')
    if (entry.snapshot.exitCode !== undefined) throw new Error('终端已经退出')
    entry.pty.write(data)
  }
  resize(owner: number, id: string, cols: number, rows: number): void {
    const entry = this.get(owner, id)
    if (entry.snapshot.exitCode === undefined) entry.pty.resize(this.size(cols, 80), this.size(rows, 24))
  }
  close(owner: number, id: string): void {
    this.disposeEntry(this.get(owner, id))
  }
  private disposeEntry(entry: RecordEntry): void {
    this.entries.delete(entry.snapshot.id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.pending = ''
    entry.dataSubscription?.dispose()
    entry.dataSubscription = undefined
    if (entry.snapshot.exitCode !== undefined) return
    // Keep the exit listener and quota slot until this PTY actually exits.
    this.closing.set(entry.snapshot.id, entry)
    try { entry.pty.kill() } catch { /* retain the unconfirmed closing entry */ }
  }
  private cacheExited(entry: RecordEntry): void {
    // Completion and replay both refresh this window's bounded snapshot LRU.
    this.entries.delete(entry.snapshot.id)
    this.entries.set(entry.snapshot.id, entry)
    const exited = [...this.entries.values()].filter((item) => item.owner === entry.owner && item.snapshot.exitCode !== undefined)
    for (const expired of exited.slice(0, -MAX_EXITED_SNAPSHOTS)) this.entries.delete(expired.snapshot.id)
  }
  /** Retire one window and join its admitted opens and real PTY exits. Reusable on macOS. */
  disposeOwner(owner: number): Promise<void> {
    const pending = this.ownerDisposals.get(owner)
    if (pending) return pending
    this.owners.delete(owner)
    for (const entry of this.entries.values()) if (entry.owner === owner) this.disposeEntry(entry)
    const disposal = (async () => {
      // An open may still be resolving its real cwd or importing node-pty. Owner
      // retirement blocks its spawn, while its original operation stays joined.
      await Promise.allSettled([...(this.ownerOpenings.get(owner) ?? [])])
      await Promise.all([...this.closing.values()].filter((entry) => entry.owner === owner).map((entry) => entry.closed))
    })().finally(() => {
      if (this.ownerDisposals.get(owner) === disposal) this.ownerDisposals.delete(owner)
    })
    this.ownerDisposals.set(owner, disposal)
    return disposal
  }

  /** Application quit only: permanently close admission and join all owners, including prior closes. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    const owners = new Set([...this.owners.keys(), ...this.ownerOpenings.keys(), ...this.ownerDisposals.keys(),
      ...[...this.closing.values()].map((entry) => entry.owner)])
    return this.shutdownPromise = Promise.all([...owners].map((owner) => this.disposeOwner(owner))).then(() => undefined)
  }

  dispose(): void { for (const owner of this.owners.keys()) void this.disposeOwner(owner) }
  private assertOwner(owner: number): void {
    if (this.closed) throw new Error('终端服务已关闭')
    const contents = this.owners.get(owner)
    if (!contents || contents.isDestroyed()) throw new Error('终端窗口已关闭')
  }
  private get(owner: number, id: string): RecordEntry {
    this.assertOwner(owner)
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) throw new Error('终端不存在或不属于此窗口')
    return entry
  }
  private size(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(2, Math.min(500, Math.floor(value))) : fallback
  }
}
