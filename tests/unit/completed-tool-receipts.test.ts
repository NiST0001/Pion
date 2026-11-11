import { describe, expect, it, vi } from 'vitest'
import { reclaimCompletedToolReceipts } from '../../src/main/agent/completed-tool-receipts'
import type { ToolReceiptArchive } from '../../src/main/agent/tool-receipt-archive'
import type { BackendRecord } from '../../src/main/agent/types'

type Receipts = NonNullable<BackendRecord['nativeToolReceipts']>
type Receipt = Receipts extends Map<string, infer Value> ? Value : never

function receipt(id: string, overrides: Partial<Receipt> = {}): Receipt {
  return { runId: 'run', backendId: 'backend', rootId: id, name: 'read', state: 'ended', usageConsumed: true, ...overrides }
}

function archive(): ToolReceiptArchive {
  return { has: vi.fn(() => false), remember: vi.fn(), forget: vi.fn(), close: vi.fn() }
}

describe('reclaimCompletedToolReceipts', () => {
  it('archives completed IDs together before deleting their receipts', () => {
    const receipts: Receipts = new Map(['a', 'b'].map(id => [id, receipt(id)]))
    const index = archive()
    vi.mocked(index.remember).mockImplementation((scope, ids) => {
      expect(scope).toBe('scope')
      expect(ids).toEqual(['a', 'b'])
      expect([...receipts.keys()]).toEqual(['a', 'b'])
    })
    expect(reclaimCompletedToolReceipts(receipts, 'scope', index)).toBe(2)
    expect(index.remember).toHaveBeenCalledTimes(1)
    expect(receipts.size).toBe(0)
  })

  it('protects running, unconsumed and ComputerUse receipts plus their parent/root ancestors', () => {
    const receipts: Receipts = new Map()
    for (const id of ['running', 'unconsumed', 'cua']) {
      receipts.set(`${id}-root`, receipt(`${id}-root`))
      receipts.set(`${id}-parent`, receipt(`${id}-parent`, { rootId: `${id}-root` }))
      receipts.set(id, receipt(id, { parentId: `${id}-parent`, rootId: `${id}-root`,
        ...(id === 'running' ? { state: 'running' } : id === 'unconsumed' ? { usageConsumed: false } : {
          computerUseSource: { version: 1, runtimeId: 'runtime', runtimeNonce: 'nonce' }
        }) }))
    }
    receipts.set('free', receipt('free'))
    const index = archive()
    expect(reclaimCompletedToolReceipts(receipts, 'scope', index)).toBe(1)
    expect([...receipts.keys()]).toHaveLength(9)
    expect(index.remember).toHaveBeenCalledWith('scope', ['free'])
  })

  it('protects indirect parent dependencies and handles cyclic links', () => {
    const receipts: Receipts = new Map([
      ['root', receipt('root')],
      ['ancestor', receipt('ancestor', { parentId: 'parent', rootId: 'root' })],
      ['parent', receipt('parent', { parentId: 'ancestor', rootId: 'root' })],
      ['active', receipt('active', { parentId: 'parent', rootId: 'root', state: 'running' })]
    ])
    const index = archive()
    expect(reclaimCompletedToolReceipts(receipts, 'scope', index)).toBe(0)
    expect(receipts.size).toBe(4)
    expect(index.remember).not.toHaveBeenCalled()
  })

  it('reclaims sequential completed leaves while their codemode parent keeps running', () => {
    const parent = receipt('codemode', { state: 'running', usageConsumed: false, name: 'codemode' })
    const receipts: Receipts = new Map([['codemode', parent]])
    const index = archive()
    for (let i = 0; i < 600; i++) {
      const id = `child-${i}`
      receipts.set(id, receipt(id, { parentId: 'codemode', rootId: 'codemode' }))
      expect(reclaimCompletedToolReceipts(receipts, 'scope', index)).toBe(1)
      expect([...receipts.values()]).toEqual([parent])
    }
    expect(index.remember).toHaveBeenCalledTimes(600)
  })

  it('preserves the entire original map when archiving fails and permits retry', () => {
    const receipts: Receipts = new Map(['a', 'b', 'live'].map(id => [id, receipt(id, id === 'live' ? { state: 'running' } : {})]))
    const original = [...receipts.entries()]
    const index = archive()
    vi.mocked(index.remember).mockImplementationOnce(() => { throw new Error('archive failed') })
    expect(() => reclaimCompletedToolReceipts(receipts, 'scope', index)).toThrow('archive failed')
    expect([...receipts.entries()]).toEqual(original)
    expect(reclaimCompletedToolReceipts(receipts, 'scope', index)).toBe(2)
    expect([...receipts.keys()]).toEqual(['live'])
  })
})
