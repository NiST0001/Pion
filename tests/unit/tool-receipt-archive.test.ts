import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteToolReceiptArchive } from '../../src/main/agent/tool-receipt-archive'

const archives: SqliteToolReceiptArchive[] = []
const archive = () => {
  const value = new SqliteToolReceiptArchive()
  archives.push(value)
  return value
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const value of archives.splice(0)) value.close()
})

describe('private completed tool receipt index', () => {
  it('opens a temporary database lazily with bounded cache and exact scope-isolated membership', () => {
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    const value = archive()
    expect(exec).not.toHaveBeenCalled()
    value.remember('scope-a', ['call', 'call', 'CALL', 'call\0suffix'])
    value.remember('scope-a\0suffix', ['call'])
    const db = exec.mock.contexts[0] as DatabaseSync
    expect(db.prepare('PRAGMA database_list').get()?.file).toBe('')
    expect(db.prepare('PRAGMA cache_size').get()?.cache_size).toBe(-1024)
    expect(db.prepare('SELECT count(*) AS count FROM tool_receipts').get()?.count).toBe(4)
    for (const id of ['call', 'CALL', 'call\0suffix']) expect(value.has('scope-a', id)).toBe(true)
    expect(value.has('scope-a', 'call\0other')).toBe(false)
    expect(value.has('scope-a', 'Call')).toBe(false)
    expect(value.has('scope-b', 'call')).toBe(false)
    value.forget('scope-a')
    expect(value.has('scope-a\0suffix', 'call')).toBe(true)
  })

  it('keeps batches beyond 512 for the connection lifetime and forgets only the retired scope', () => {
    const ids = Array.from({ length: 2048 }, (_, index) => `call-${index}`)
    const value = archive()
    value.remember('scope-a', ids)
    value.remember('scope-b', ['call-0'])
    value.remember('scope-a', ids)
    for (const id of ids) expect(value.has('scope-a', id)).toBe(true)
    value.forget('scope-a')
    for (const id of ids) expect(value.has('scope-a', id)).toBe(false)
    expect(value.has('scope-b', 'call-0')).toBe(true)
    expect(archive().has('scope-b', 'call-0')).toBe(false)
    value.close()
    expect(archive().has('scope-b', 'call-0')).toBe(false)
  })

  it('rolls back the whole failed batch and permits a later retry', () => {
    const value = archive()
    value.remember('a', ['prior'])
    expect(() => value.remember('a', ['first', null as unknown as string])).toThrow()
    expect(value.has('a', 'first')).toBe(false)
    expect(value.has('a', 'prior')).toBe(true)
    value.remember('a', ['first', 'later'])
    expect(value.has('a', 'first')).toBe(true)
    expect(value.has('a', 'later')).toBe(true)
  })

  it('permits retry when SQLite itself has already rolled back the failed batch', () => {
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    const value = archive()
    value.remember('a', ['prior'])
    const db = exec.mock.contexts[0] as DatabaseSync
    db.exec("CREATE TRIGGER rollback_test BEFORE INSERT ON tool_receipts WHEN NEW.tool_call_id = 'fail' BEGIN SELECT RAISE(ROLLBACK, 'batch failed'); END")
    expect(() => value.remember('a', ['first', 'fail'])).toThrow('batch failed')
    expect(value.has('a', 'first')).toBe(false)
    value.remember('a', ['later'])
    expect(value.has('a', 'later')).toBe(true)
  })

  it('retries ordinary SQL and initialization failures without losing existing IDs', () => {
    const value = archive()
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => { throw new Error('initialization failed') })
    expect(() => value.has('a', 'prior')).toThrow('initialization failed')
    value.remember('a', ['prior'])
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => { throw new Error('query failed') })
    expect(() => value.has('a', 'prior')).toThrow('query failed')
    expect(value.has('a', 'prior')).toBe(true)
    vi.mocked(DatabaseSync.prototype.prepare).mockImplementationOnce(() => { throw new Error('delete failed') })
    expect(() => value.forget('a')).toThrow('delete failed')
    expect(value.has('a', 'prior')).toBe(true)
    value.forget('a')
    expect(value.has('a', 'prior')).toBe(false)
  })

  it('retains an unconfirmed rollback error and rejects further operations on that instance', () => {
    const value = archive()
    value.remember('a', ['prior'])
    const exec: (this: DatabaseSync, sql: string) => void = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string): void {
      if (sql === 'ROLLBACK') throw new Error('rollback failed')
      return exec.call(this, sql)
    })
    expect(() => value.remember('a', ['first', null as unknown as string])).toThrow('rollback is unconfirmed')
    expect(() => value.has('a', 'prior')).toThrow('rollback is unconfirmed')
    expect(() => value.remember('a', ['later'])).toThrow('rollback is unconfirmed')
    expect(() => value.forget('a')).toThrow('rollback is unconfirmed')
    const healthy = archive()
    healthy.remember('a', ['later'])
    expect(healthy.has('a', 'prior')).toBe(false)
    expect(healthy.has('a', 'later')).toBe(true)
  })

  it.each([false, true])('retains an unconfirmed close without retrying it (initialization failure: %s)', (initializationFailure) => {
    const value = new SqliteToolReceiptArchive()
    const close: (this: DatabaseSync) => void = DatabaseSync.prototype.close
    const failure = new Error('close failed')
    // Actually release the test connection before simulating an unknown close receipt.
    const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(function (this: DatabaseSync): void {
      close.call(this)
      throw failure
    })
    if (initializationFailure) {
      vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => { throw new Error('initialization failed') })
      expect(() => value.has('a', 'id')).toThrow('initialization close is unconfirmed')
    } else {
      value.remember('a', ['id'])
      expect(() => value.close()).toThrow(failure)
    }
    expect(() => value.has('a', 'id')).toThrow()
    expect(() => value.close()).toThrow()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects every operation after close, including an unopened archive', () => {
    for (const opened of [false, true]) {
      const value = archive()
      if (opened) value.remember('a', ['id'])
      value.close()
      value.close()
      expect(() => value.has('a', 'id')).toThrow(/closed/)
      expect(() => value.remember('a', [])).toThrow(/closed/)
      expect(() => value.forget('a')).toThrow(/closed/)
    }
  })
})
