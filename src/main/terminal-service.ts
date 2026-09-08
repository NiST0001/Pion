import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { BrowserWindow, WebContents } from 'electron'
import type { IPty } from 'node-pty'
import { IPC_EVENTS } from '../shared/ipc'
import type { TerminalSnapshot, TerminalUpdate } from '../shared/terminal'

const MAX_OUTPUT = 256 * 1024
const MAX_TERMINALS = 8
interface RecordEntry {
  owner: number
  snapshot: TerminalSnapshot
  pty: IPty
  pending: string
  truncated: boolean
  timer?: ReturnType<typeof setTimeout>
  disposables: Array<{ dispose(): void }>
}

/** Terminals belong to a window and an initial real project directory, never to
 * the agent's currently selected session. Hiding the UI does not stop a shell. */
export class TerminalService {
  private readonly owners = new Map<number, WebContents>()
  private readonly entries = new Map<string, RecordEntry>()
  private readonly opening = new Map<string, Promise<TerminalSnapshot>>()

  bind(win: BrowserWindow): void {
    const owner = win.webContents.id
    this.owners.set(owner, win.webContents)
    win.once('closed', () => this.disposeOwner(owner))
  }

  async open(owner: number, cwd: string, cols: number, rows: number): Promise<TerminalSnapshot> {
    this.assertOwner(owner)
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('终端需要有效的绝对项目路径')
    const directory = await realpath(cwd)
    if (!(await stat(directory)).isDirectory()) throw new Error('终端工作目录不存在')
    this.assertOwner(owner)
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
      return { ...existing.snapshot }
    }
    const { spawn } = await import('node-pty')
    this.assertOwner(owner)
    if ([...this.entries.values()].filter((entry) => entry.owner === owner).length >= MAX_TERMINALS) {
      throw new Error('最多保留 8 个项目终端，请先结束不再使用的终端')
    }
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/bash'
    const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    delete env.ELECTRON_RUN_AS_NODE
    const pty = spawn(shell, [], { cwd, cols: this.size(cols, 80), rows: this.size(rows, 24),
      name: 'xterm-256color', env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
    const entry: RecordEntry = {
      owner, pty, snapshot: { id: randomUUID(), cwd, shell, output: '', sequence: 0 },
      pending: '', truncated: false, disposables: []
    }
    this.entries.set(entry.snapshot.id, entry)
    entry.disposables.push(pty.onData((data) => {
      entry.pending += data
      if (entry.pending.length > MAX_OUTPUT) { entry.pending = entry.pending.slice(-MAX_OUTPUT); entry.truncated = true }
      if (!entry.timer) entry.timer = setTimeout(() => this.flush(entry), 32)
    }))
    entry.disposables.push(pty.onExit(({ exitCode }) => {
      entry.snapshot.exitCode = exitCode
      this.flush(entry, true)
    }))
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
    entry.disposables.forEach((disposable) => disposable.dispose())
    try { entry.pty.kill() } catch { /* already exited */ }
  }
  disposeOwner(owner: number): void {
    for (const entry of this.entries.values()) if (entry.owner === owner) this.disposeEntry(entry)
    this.owners.delete(owner)
  }
  dispose(): void { for (const owner of this.owners.keys()) this.disposeOwner(owner) }
  private assertOwner(owner: number): void {
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
