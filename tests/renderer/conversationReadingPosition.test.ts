// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readConversationReadingPosition,
  saveConversationReadingPosition,
  type ConversationReadingPosition
} from '../../src/renderer/src/utils/conversationReadingPosition'

const cwd = '/project'
const sessionPath = '/sessions/session.jsonl'
const key = (root = cwd, path = sessionPath): string =>
  `pion:conversation-reading-v1:${JSON.stringify([root, path])}`
const position: ConversationReadingPosition = { version: 1, end: false, entryId: 'entry-1', offset: -12.5 }

beforeEach(() => localStorage.clear())

describe('conversation reading position', () => {
  it('round-trips the exact metadata and supports the explicit end position', () => {
    expect(saveConversationReadingPosition(cwd, sessionPath, position)).toBe(true)
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual(position)
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: true, position })
    const end: ConversationReadingPosition = { version: 1, end: true, offset: 0 }
    expect(saveConversationReadingPosition(cwd, sessionPath, end)).toBe(true)
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: true, position: end })
  })

  it('isolates exact cwd and session paths with JSON tuple keys', () => {
    const end: ConversationReadingPosition = { version: 1, end: true, offset: 0 }
    expect(saveConversationReadingPosition('/a', '/b:/c', position)).toBe(true)
    expect(saveConversationReadingPosition('/a:/b', '/c', end)).toBe(true)
    expect(readConversationReadingPosition('/a', '/b:/c')).toEqual({ ok: true, position })
    expect(readConversationReadingPosition('/a:/b', '/c')).toEqual({ ok: true, position: end })
    expect(readConversationReadingPosition('/a/', '/b:/c')).toEqual({ ok: true, position: null })
    expect(readConversationReadingPosition('/a', '/b:/c/')).toEqual({ ok: true, position: null })
  })

  it('reports missing records independently from unreadable records', () => {
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: true, position: null })
    localStorage.setItem(key(), 'broken')
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: false, position: null })
    expect(localStorage.getItem(key())).toBe('broken')
  })

  it('round-trips Unicode identities without normalization or text indexing', () => {
    const unicode = { ...position, entryId: '消息-🪷-e\u0301-"\\' }
    const root = '/项目/é'
    const path = '/会话/🪷.jsonl'
    expect(saveConversationReadingPosition(root, path, unicode)).toBe(true)
    expect(readConversationReadingPosition(root, path)).toEqual({ ok: true, position: unicode })
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe(key(root, path))
  })

  it.each([
    'null',
    '[]',
    '{}',
    '{"version":2,"end":true,"offset":0}',
    '{"version":1,"end":"true","offset":0}',
    '{"version":1,"end":false,"offset":0}',
    '{"version":1,"end":false,"entryId":"","offset":0}',
    '{"version":1,"end":false,"entryId":"  ","offset":0}',
    '{"version":1,"end":true,"entryId":null,"offset":0}',
    '{"version":1,"end":true,"offset":null}',
    '{"version":1,"end":true,"offset":NaN}',
    '{"version":1,"end":true,"offset":1e999}',
    '{"version":1,"end":true,"offset":0,"text":"private"}',
    '{"version":1,"end":true,"offset":0,"__proto__":{}}'
  ])('rejects damaged or non-whitelisted stored JSON without changing it: %s', raw => {
    localStorage.setItem(key(), raw)
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: false, position: null })
    expect(localStorage.getItem(key())).toBe(raw)
  })

  it.each([
    { ...position, offset: NaN },
    { ...position, offset: Infinity },
    { ...position, offset: -Infinity },
    { version: 1, end: false, offset: 0 },
    { ...position, entryId: '' },
    { ...position, entryId: 'e'.repeat(1025) },
    { ...position, text: 'private' },
    { ...position, rowId: 'temporary' },
    { ...position, timestamp: 123 },
    { ...position, ratio: 0.5 }
  ])('preserves an existing record when a write is rejected', invalid => {
    localStorage.setItem(key(), JSON.stringify(position))
    expect(saveConversationReadingPosition(cwd, sessionPath, invalid as ConversationReadingPosition)).toBe(false)
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: true, position })
  })

  it.each([
    ['', sessionPath],
    ['  ', sessionPath],
    [cwd, ''],
    [cwd, '\t'],
    ['a'.repeat(8193), sessionPath],
    [cwd, 'b'.repeat(8193)],
    ['x' + '\n'.repeat(8191), 'y' + '\n'.repeat(8191)]
  ])('rejects empty or unbounded identities before accessing storage', (root, path) => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() }
    expect(readConversationReadingPosition(root, path, storage)).toEqual({ ok: false, position: null })
    expect(saveConversationReadingPosition(root, path, position, storage)).toBe(false)
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('rejects oversized stored metadata without erasing it', () => {
    const raw = JSON.stringify({ ...position, entryId: 'e'.repeat(9000) })
    localStorage.setItem(key(), raw)
    expect(readConversationReadingPosition(cwd, sessionPath)).toEqual({ ok: false, position: null })
    expect(localStorage.getItem(key())).toBe(raw)
  })

  it('accepts injected storage and preserves records when storage throws', () => {
    const records = new Map<string, string>([[key(), JSON.stringify(position)]])
    const storage = {
      getItem: vi.fn((storageKey: string) => records.get(storageKey) ?? null),
      setItem: vi.fn((storageKey: string, value: string) => { records.set(storageKey, value) })
    }
    expect(readConversationReadingPosition(cwd, sessionPath, storage)).toEqual({ ok: true, position })
    expect(saveConversationReadingPosition(cwd, sessionPath, position, storage)).toBe(true)
    const saved = records.get(key())
    storage.getItem.mockImplementation(() => { throw new Error('permission denied') })
    expect(readConversationReadingPosition(cwd, sessionPath, storage)).toEqual({ ok: false, position: null })
    storage.setItem.mockImplementation(() => { throw new Error('quota exceeded') })
    expect(saveConversationReadingPosition(cwd, sessionPath, { version: 1, end: true, offset: 0 }, storage)).toBe(false)
    expect(records.get(key())).toBe(saved)
  })
})
