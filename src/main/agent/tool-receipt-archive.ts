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

/** Connection-private temporary SQLite file, with a bounded page cache and no ID mirror.
 * Transactions publish a whole batch before callers reclaim receipts.
 */
export class SqliteToolReceiptArchive implements ToolReceiptArchive {
  private database?: DatabaseSync
  private closed = false
  private failure?: unknown

  has(scopeId: string, toolCallId: string): boolean {
    return this.use((db) => db.prepare('SELECT 1 FROM tool_receipts WHERE scope_id = ? AND tool_call_id = ?').get(scopeId, toolCallId) !== undefined)
  }

  remember(scopeId: string, toolCallIds: readonly string[]): void {
    this.use((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT INTO tool_receipts (scope_id, tool_call_id) VALUES (?, ?) ON CONFLICT (scope_id, tool_call_id) DO NOTHING')
        for (const id of toolCallIds) insert.run(scopeId, id)
        db.exec('COMMIT')
      } catch (error) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK') } catch (rollbackError) {
            this.failure = new AggregateError([error, rollbackError], 'Tool receipt archive rollback is unconfirmed')
            throw this.failure
          }
        }
        throw error
      }
    })
  }

  forget(scopeId: string): void {
    this.use((db) => { db.prepare('DELETE FROM tool_receipts WHERE scope_id = ?').run(scopeId) })
  }

  close(): void {
    if (this.closed) {
      if (this.failure !== undefined) throw this.failure
      return
    }
    this.closed = true
    try {
      this.database?.close()
      this.database = undefined
      this.failure = undefined
    } catch (error) {
      this.failure = error
      throw error
    }
  }

  private use<T>(operation: (database: DatabaseSync) => T): T {
    if (this.failure !== undefined) throw this.failure
    if (this.closed) throw new Error('Tool receipt archive is closed')
    return operation(this.database ?? this.open())
  }

  private open(): DatabaseSync {
    // An empty filename lets SQLite own the temporary file and its removal on close.
    const db = new DatabaseSync('')
    try {
      db.exec(`PRAGMA cache_size = -1024; ${SCHEMA}`)
    } catch (error) {
      try { db.close() } catch (closeError) {
        this.database = db
        this.closed = true
        this.failure = new AggregateError([error, closeError], 'Tool receipt archive initialization close is unconfirmed')
        throw this.failure
      }
      throw error
    }
    this.database = db
    return db
  }
}
