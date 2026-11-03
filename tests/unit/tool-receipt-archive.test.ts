import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteToolReceiptArchive } from '../../src/main/agent/tool-receipt-archive'

let root: string
const archives: SqliteToolReceiptArchive[] = []
const archive = (file = join(root, 'private', 'receipts.sqlite')) => {
  const value = new SqliteToolReceiptArchive(file)
  archives.push(value)
  return value
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pion-receipt-archive-')) })
afterEach(() => {
  for (const value of archives.splice(0)) value.close()
  rmSync(root, { recursive: true, force: true })
})

describe('private completed tool receipt index', () => {
  it('creates lazily with private permissions and exact scope-isolated membership', () => {
    const value = archive()
    const path = join(root, 'private', 'receipts.sqlite')
    expect(existsSync(path)).toBe(false)
    value.remember('scope-a', ['call', 'call', 'CALL', 'call\0suffix'])
    expect(value.has('scope-a', 'call')).toBe(true)
    expect(value.has('scope-a', 'CALL')).toBe(true)
    expect(value.has('scope-a', 'call\0suffix')).toBe(true)
    expect(value.has('scope-a', 'Call')).toBe(false)
    expect(value.has('scope-b', 'call')).toBe(false)
    if (process.platform !== 'win32') {
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
      expect(lstatSync(join(root, 'private')).mode & 0o777).toBe(0o700)
    }
  })

  it('commits batches beyond 512, reopens, and forgets only the retired scope', () => {
    const ids = Array.from({ length: 2048 }, (_, index) => `call-${index}`)
    const first = archive()
    first.remember('scope-a', ids)
    first.remember('scope-b', ['call-0'])
    first.close()
    const second = archive()
    for (const id of ids) expect(second.has('scope-a', id)).toBe(true)
    second.forget('scope-a')
    expect(second.has('scope-a', 'call-0')).toBe(false)
    expect(second.has('scope-a', 'call-2047')).toBe(false)
    expect(second.has('scope-b', 'call-0')).toBe(true)
    second.close()
    expect(archive().has('scope-a', 'call-0')).toBe(false)
  })

  it('uses SQLite transactions across instances without clearing foreign scopes', () => {
    const first = archive()
    first.remember('a', ['one'])
    const second = archive()
    second.remember('b', ['two'])
    expect(first.has('b', 'two')).toBe(true)
    first.forget('a')
    expect(second.has('a', 'one')).toBe(false)
    expect(second.has('b', 'two')).toBe(true)
  })

  it('rolls back the whole failed batch and poisons subsequent reads/writes', () => {
    const value = archive()
    value.remember('a', ['prior'])
    expect(() => value.remember('a', ['first', null as unknown as string])).toThrow()
    expect(() => value.has('a', 'first')).toThrow()
    expect(() => value.remember('a', ['later'])).toThrow()
    value.close()
    const reopened = archive()
    expect(reopened.has('a', 'prior')).toBe(true)
    expect(reopened.has('a', 'first')).toBe(false)
  })

  it('preserves corrupt and unrelated existing sources and refuses reads and writes', () => {
    const file = join(root, 'bad.sqlite')
    const source = Buffer.from('existing corrupt source')
    writeFileSync(file, source)
    const value = archive(file)
    expect(() => value.has('a', 'id')).toThrow()
    expect(() => value.remember('a', ['id'])).toThrow()
    expect(readFileSync(file)).toEqual(source)
    const other = join(root, 'other.sqlite')
    const db = new DatabaseSync(other)
    db.exec('CREATE TABLE unrelated (value TEXT)')
    db.close()
    const bytes = readFileSync(other)
    expect(() => archive(other).remember('a', ['id'])).toThrow()
    expect(readFileSync(other)).toEqual(bytes)
  })

  it.skipIf(process.platform === 'win32')('preserves symlink targets and rejects non-regular paths and sidecars', () => {
    const target = join(root, 'source')
    writeFileSync(target, 'keep')
    const link = join(root, 'link.sqlite')
    symlinkSync(target, link)
    expect(() => archive(link).remember('a', ['id'])).toThrow()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('keep')
    const dir = join(root, 'directory.sqlite')
    mkdirSync(dir)
    expect(() => archive(dir).has('a', 'id')).toThrow()
    const value = archive()
    value.remember('a', ['id'])
    symlinkSync(target, join(root, 'private', 'receipts.sqlite-journal'))
    expect(() => value.has('a', 'missing')).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it.skipIf(process.platform === 'win32')('rejects unsafe parent directories before creating a database', () => {
    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    const link = join(root, 'linked-directory')
    symlinkSync(target, link)
    expect(() => archive(join(link, 'receipts.sqlite')).remember('a', ['id'])).toThrow()
    expect(existsSync(join(target, 'receipts.sqlite'))).toBe(false)
    const wide = join(root, 'wide')
    mkdirSync(wide)
    chmodSync(wide, 0o755)
    expect(() => archive(join(wide, 'receipts.sqlite')).has('a', 'id')).toThrow()
    expect(existsSync(join(wide, 'receipts.sqlite'))).toBe(false)
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
