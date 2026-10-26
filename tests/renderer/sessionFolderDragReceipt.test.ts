import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInternalDrag } from '../../src/renderer/src/utils/internalDrag'
import {
  SESSION_DRAG_MIME,
  beginSessionDrag,
  endSessionDrag,
  getSessionDrag,
} from '../../src/renderer/src/utils/sessionDrag'
import {
  SESSION_FOLDER_DRAG_MIME,
  beginSessionFolderDrag,
  endSessionFolderDrag,
  getSessionFolderDrag,
} from '../../src/renderer/src/utils/sessionFolderDrag'

const owner = {}
const nextOwner = {}
const data = { cwd: '/project', id: 'folder', parentId: 'parent' }

function makeTransfer() {
  const values = new Map<string, string>()
  return {
    get types(): string[] { return [...values.keys()] },
    setData: vi.fn((type: string, value: string) => { values.set(type, value) }),
    getData: vi.fn((type: string) => values.get(type) ?? ''),
  }
}

afterEach(() => {
  for (const sourceOwner of [owner, nextOwner]) {
    endSessionFolderDrag(sourceOwner)
    endSessionDrag(sourceOwner)
  }
})

describe('renderer-local folder drag receipt', () => {
  it.each([undefined, 'parent'])('snapshots only folder metadata with parent %s and allows protected hover', (parentId) => {
    const transfer = makeTransfer()
    const input = { ...data, parentId, extra: 'omit' }
    const expected = { cwd: data.cwd, id: data.id, ...(parentId ? { parentId } : {}) }
    expect(beginSessionFolderDrag(transfer, input, owner, () => true)).toBe(true)
    input.id = 'changed'
    input.parentId = 'changed'
    transfer.getData.mockImplementationOnce(() => { throw new Error('protected mode') })
    const hovered = getSessionFolderDrag(transfer, data.cwd, 'over')!
    expect(hovered).toEqual(expected)
    expect(Object.hasOwn(hovered, 'parentId')).toBe(Boolean(parentId))
    hovered.id = 'mutated result'
    expect(getSessionFolderDrag(transfer, data.cwd, 'over')).toEqual(expected)
    expect(transfer.getData).not.toHaveBeenCalled()
    expect(transfer.setData).toHaveBeenCalledExactlyOnceWith(
      SESSION_FOLDER_DRAG_MIME,
      JSON.stringify({ version: 1, ...expected }),
    )
    transfer.getData.mockReset().mockReturnValue(JSON.stringify({ version: 1, ...expected }))
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toEqual(expected)
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
  })

  it('retires other MIME sources while wrong wrappers and old owners preserve the new drag', () => {
    const sessionTransfer = makeTransfer()
    const folderTransfer = makeTransfer()
    const session = { cwd: data.cwd, path: '/sessions/one.jsonl' }
    beginSessionDrag(sessionTransfer, session, owner, () => true)
    beginSessionFolderDrag(folderTransfer, data, nextOwner, () => true)
    expect(getSessionDrag(sessionTransfer, data.cwd, 'drop')).toBeNull()
    endSessionDrag(owner)
    endSessionFolderDrag(owner)
    expect(getSessionFolderDrag(folderTransfer, data.cwd, 'over')).toEqual(data)
    beginSessionDrag(sessionTransfer, session, owner, () => true)
    expect(getSessionFolderDrag(folderTransfer, data.cwd, 'drop')).toBeNull()
    endSessionFolderDrag(nextOwner)
    expect(getSessionDrag(sessionTransfer, data.cwd, 'drop')).toEqual(session)
  })

  it('requires this factory instance even when another instance uses the same MIME and owner', () => {
    const other = createInternalDrag(SESSION_FOLDER_DRAG_MIME, (input: typeof data) => ({ ...input }))
    const transfer = makeTransfer()
    other.begin(transfer, data, owner, () => true)
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    endSessionFolderDrag(owner)
    expect(other.get(transfer, data.cwd, 'drop')).toEqual(data)
  })

  it('rejects external MIME/text/files and consumes drops with wrong MIME or cwd', () => {
    const transfer = makeTransfer()
    transfer.setData(SESSION_FOLDER_DRAG_MIME, JSON.stringify({ version: 1, ...data }))
    transfer.setData('text/plain', data.id)
    transfer.setData('Files', '')
    expect(getSessionFolderDrag(transfer, data.cwd, 'over')).toBeNull()
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    beginSessionFolderDrag(transfer, data, owner, () => true)
    expect(getSessionFolderDrag(transfer, `${data.cwd}/`, 'over')).toBeNull()
    expect(getSessionFolderDrag(transfer, '/other', 'drop')).toBeNull()
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    beginSessionFolderDrag(transfer, data, owner, () => true)
    const wrongMime = { types: [SESSION_DRAG_MIME, 'text/plain', 'Files'], getData: vi.fn() }
    expect(getSessionFolderDrag(wrongMime, data.cwd, 'drop')).toBeNull()
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    expect(wrongMime.getData).not.toHaveBeenCalled()
    expect(transfer.getData).not.toHaveBeenCalled()
  })

  it.each(['tampered', 'throwing'] as const)('consumes a drop with %s payload access', (mode) => {
    const transfer = makeTransfer()
    beginSessionFolderDrag(transfer, data, owner, () => true)
    const original = transfer.getData(SESSION_FOLDER_DRAG_MIME)
    if (mode === 'tampered') transfer.setData(SESSION_FOLDER_DRAG_MIME, JSON.stringify({ version: 1, ...data, parentId: 'other' }))
    else transfer.getData.mockImplementationOnce(() => { throw new Error('read failed') })
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    transfer.setData(SESSION_FOLDER_DRAG_MIME, original)
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
  })

  it.each(['changed', 'throwing'] as const)('consumes a drop with a %s source', (mode) => {
    const transfer = makeTransfer()
    let current = true
    const isCurrent = () => {
      if (!current && mode === 'throwing') throw new Error('source retired')
      return current
    }
    beginSessionFolderDrag(transfer, data, owner, isCurrent)
    current = false
    expect(getSessionFolderDrag(transfer, data.cwd, 'over')).toBeNull()
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    current = true
    expect(getSessionFolderDrag(transfer, data.cwd, 'drop')).toBeNull()
    expect(transfer.getData).not.toHaveBeenCalled()
  })

  it('retires the old source even when a new start fails', () => {
    const transfer = makeTransfer()
    const session = { cwd: data.cwd, path: '/sessions/one.jsonl' }
    beginSessionDrag(transfer, session, owner, () => true)
    expect(beginSessionFolderDrag(transfer, data, nextOwner, () => false)).toBe(false)
    expect(getSessionDrag(transfer, data.cwd, 'over')).toBeNull()
    expect(beginSessionFolderDrag(transfer, data, owner, () => { throw new Error('stale') })).toBe(false)
    transfer.setData.mockImplementationOnce(() => { throw new Error('write failed') })
    expect(beginSessionFolderDrag(transfer, data, owner, () => true)).toBe(false)
    expect(getSessionFolderDrag(transfer, data.cwd, 'over')).toBeNull()
  })
})
