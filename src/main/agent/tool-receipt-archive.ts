import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Private completion-ID index only; membership says nothing about provider/OS shutdown. */
export interface ToolReceiptArchive {
  has(scopeId: string, toolCallId: string): boolean
  remember(scopeId: string, toolCallIds: readonly string[]): void
  /** Only call after this scope is permanently retired. */
  forget(scopeId: string): void
  close(): void
}

const SCHEMA = 'CREATE TABLE tool_receipts (scope_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, PRIMARY KEY (scope_id, tool_call_id)) WITHOUT ROWID'

/** Synchronous SQLite transactions publish a whole batch before callers reclaim receipts.
 * Use a backend-owned private directory. Path checks are not an OS sandbox against
 * hostile same-account concurrent directory replacement. No in-memory ID mirror.
 */
export class SqliteToolReceiptArchive implements ToolReceiptArchive {
  private readonly filePath: string
  private database?: DatabaseSync
  private identity?: { dev: number; ino: number }
  private closed = false
  private failure?: unknown

  constructor(filePath: string) {
    this.filePath = resolve(filePath)
  }

  has(scopeId: string, toolCallId: string): boolean {
    return this.use((db) => db.prepare('SELECT 1 FROM tool_receipts WHERE scope_id = ? AND tool_call_id = ?').get(scopeId, toolCallId) !== undefined)
  }

  remember(scopeId: string, toolCallIds: readonly string[]): void {
    this.use((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT INTO tool_receipts (scope_id, tool_call_id) VALUES (?, ?) ON CONFLICT (scope_id, tool_call_id) DO NOTHING')
        if (typeof scopeId !== 'string') throw new TypeError('Expected a private scope ID')
        for (const id of toolCallIds) {
          if (typeof id !== 'string') throw new TypeError('Expected a completed tool call ID')
          insert.run(scopeId, id)
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* Preserve the first failure; the instance is poisoned below. */ }
        throw error
      }
    })
  }

  forget(scopeId: string): void {
    this.use((db) => { db.prepare('DELETE FROM tool_receipts WHERE scope_id = ?').run(scopeId) })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database?.close()
    this.database = undefined
  }

  private use<T>(operation: (database: DatabaseSync) => T): T {
    if (this.closed) throw new Error('Tool receipt archive is closed')
    if (this.failure !== undefined) throw this.failure
    try {
      const db = this.database ?? this.open()
      this.checkPaths()
      return operation(db)
    } catch (error) {
      this.failure = error
      throw error
    }
  }

  private checkDirectory(): void {
    const directory = lstatSync(dirname(this.filePath))
    if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)) {
      throw new Error('Tool receipt archive requires a private directory')
    }
  }

  private checkPaths(): void {
    this.checkDirectory()
    const file = lstatSync(this.filePath)
    if (!file.isFile() || (this.identity && (file.dev !== this.identity.dev || file.ino !== this.identity.ino))) {
      throw new Error('Tool receipt archive file identity changed or is not regular')
    }
    // SQLite opens these itself. Reject known symlinks/non-files before SQLite can touch them.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        if (!lstatSync(this.filePath + suffix).isFile()) throw new Error('Unsafe tool receipt archive sidecar')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private validate(db: DatabaseSync): void {
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Corrupt tool receipt archive')
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (schema.length !== 1 || schema[0].name !== 'tool_receipts' || schema[0].sql !== SCHEMA) {
      throw new Error('Unsupported tool receipt archive schema')
    }
  }

  private open(): DatabaseSync {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    this.checkDirectory()
    let created = false
    // Exclusive creation never truncates an existing source, including a dangling symlink.
    try {
      const fd = openSync(this.filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        const stat = fstatSync(fd)
        this.identity = { dev: stat.dev, ino: stat.ino }
        created = true
      } finally { closeSync(fd) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.checkPaths()
    const stat = lstatSync(this.filePath)
    this.identity = { dev: stat.dev, ino: stat.ino }
    // Validate existing sources read-only before any writable SQLite connection/PRAGMA.
    if (!created) {
      const reader = new DatabaseSync(this.filePath, { readOnly: true })
      try { this.validate(reader) } finally { reader.close() }
      this.checkPaths()
    }
    const db = new DatabaseSync(this.filePath)
    this.database = db
    if (!created) this.validate(db)
    // Bounded page cache, no mmap, one FULL-sync transaction per batch (no per-ID fsync).
    // DELETE journaling also avoids persistent WAL/shared-memory sidecars.
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA cache_size = -1024; PRAGMA mmap_size = 0; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE')
    if (created) db.exec(`BEGIN IMMEDIATE; ${SCHEMA}; COMMIT`)
    return db
  }
}
