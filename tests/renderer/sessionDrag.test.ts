import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_DRAG_MIME,
  beginSessionDrag,
  endSessionDrag,
  getSessionDrag,
} from '../../src/renderer/src/utils/sessionDrag'

const owner = {}
const nextOwner = {}
const data = { cwd: '/project', path: '/sessions/one.jsonl' }

function makeTransfer() {
  const values = new Map<string, string>()
  return {
    get types(): string[] { return [...values.keys()] },
    setData: vi.fn((type: string, value: string) => { values.set(type, value) }),
    getData: vi.fn((type: string) => values.get(type) ?? ''),
  }
}

afterEach(() => {
  endSessionDrag(owner)
  endSessionDrag(nextOwner)
})

describe('renderer-local session drag receipt', () => {
  it('allows protected-mode hover without reading the payload', () => {
    const transfer = makeTransfer()
    expect(beginSessionDrag(transfer, data, owner, () => true)).toBe(true)
    transfer.getData.mockImplementation(() => { throw new Error('protected mode') })
    expect(getSessionDrag(transfer, data.cwd, 'over')).toEqual(data)
    expect(getSessionDrag(transfer, data.cwd, 'over')).toEqual(data)
    expect(transfer.getData).not.toHaveBeenCalled()
    expect(transfer.setData).toHaveBeenCalledExactlyOnceWith(
      SESSION_DRAG_MIME,
      JSON.stringify({ version: 1, ...data }),
    )
  })

  it('consumes a successful drop so it dispatches at most once', () => {
    const transfer = makeTransfer()
    beginSessionDrag(transfer, data, owner, () => true)
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toEqual(data)
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'over')).toBeNull()
    expect(transfer.getData).toHaveBeenCalledExactlyOnceWith(SESSION_DRAG_MIME)
  })

  it('requires exact cwd and consumes even a rejected drop', () => {
    const transfer = makeTransfer()
    beginSessionDrag(transfer, data, owner, () => true)
    expect(getSessionDrag(transfer, `${data.cwd}/`, 'over')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd.toUpperCase(), 'over')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'over')).toEqual(data)
    expect(getSessionDrag(transfer, '/other', 'drop')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
    expect(transfer.getData).not.toHaveBeenCalled()
  })

  it.each([
    '',
    '{malformed',
    JSON.stringify({ version: 1, ...data, path: '/sessions/other.jsonl' }),
    JSON.stringify({ path: data.path, cwd: data.cwd, version: 1 }),
  ])('rejects a payload differing from the fixed serialized source: %s', (payload) => {
    const transfer = makeTransfer()
    beginSessionDrag(transfer, data, owner, () => true)
    const original = transfer.getData(SESSION_DRAG_MIME)
    transfer.setData(SESSION_DRAG_MIME, payload)
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
    transfer.setData(SESSION_DRAG_MIME, original)
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
  })

  it('rejects matching external MIME, plain text, and files without a local source', () => {
    const transfer = makeTransfer()
    transfer.setData(SESSION_DRAG_MIME, JSON.stringify({ version: 1, ...data }))
    transfer.setData('text/plain', data.path)
    transfer.setData('Files', '')
    expect(getSessionDrag(transfer, data.cwd, 'over')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
  })

  it('requires the dedicated MIME even while a local source exists', () => {
    const transfer = makeTransfer()
    beginSessionDrag(transfer, data, owner, () => true)
    const textOnly = { types: ['text/plain'], getData: vi.fn(() => data.path) }
    expect(getSessionDrag(textOnly, data.cwd, 'over')).toBeNull()
    expect(getSessionDrag(textOnly, data.cwd, 'drop')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
    expect(textOnly.getData).not.toHaveBeenCalled()
  })

  it.each(['stale', 'throwing'] as const)('rejects a %s lifecycle source', (mode) => {
    const transfer = makeTransfer()
    let current = true
    const isCurrent = () => {
      if (!current && mode === 'throwing') throw new Error('source retired')
      return current
    }
    beginSessionDrag(transfer, data, owner, isCurrent)
    current = false
    expect(getSessionDrag(transfer, data.cwd, 'over')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
    current = true
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
  })

  it('only lets the matching owner end the active drag', () => {
    const oldTransfer = makeTransfer()
    const transfer = makeTransfer()
    beginSessionDrag(oldTransfer, data, owner, () => true)
    const nextData = { ...data, path: '/sessions/two.jsonl' }
    beginSessionDrag(transfer, nextData, nextOwner, () => true)
    endSessionDrag(owner)
    expect(getSessionDrag(transfer, data.cwd, 'over')).toEqual(nextData)
    endSessionDrag(nextOwner)
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
  })

  it('copies source and returned data to preserve the starting identity', () => {
    const transfer = makeTransfer()
    const input = { ...data, extra: 'omit' }
    beginSessionDrag(transfer, input, owner, () => true)
    expect(transfer.setData).toHaveBeenCalledExactlyOnceWith(
      SESSION_DRAG_MIME,
      JSON.stringify({ version: 1, ...data }),
    )
    input.cwd = '/other'
    input.path = '/sessions/other.jsonl'
    const hovered = getSessionDrag(transfer, data.cwd, 'over')!
    hovered.cwd = '/changed'
    hovered.path = '/sessions/changed.jsonl'
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toEqual(data)
  })

  it('rejects failed starts and drops with inaccessible payloads', () => {
    const transfer = makeTransfer()
    expect(beginSessionDrag(transfer, data, owner, () => false)).toBe(false)
    expect(beginSessionDrag(transfer, data, owner, () => { throw new Error('stale') })).toBe(false)
    transfer.setData.mockImplementationOnce(() => { throw new Error('write failed') })
    expect(beginSessionDrag(transfer, data, owner, () => true)).toBe(false)
    expect(getSessionDrag(transfer, data.cwd, 'over')).toBeNull()
    beginSessionDrag(transfer, data, owner, () => true)
    transfer.getData.mockImplementationOnce(() => { throw new Error('read failed') })
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
    expect(getSessionDrag(transfer, data.cwd, 'drop')).toBeNull()
  })
})
