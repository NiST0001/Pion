import { mkdtemp, rm, writeFile, truncate, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSessionTokenTotal, readSessionUsageSnapshot } from '../../src/main/agent/session-token-total'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) }
})
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
})

const timestamp = '2026-01-01T00:00:00.000Z'
const header = { type: 'session', version: 3, id: 'session-id', cwd: '/fixture/project', timestamp }
const usage = (totalTokens: number) => ({
  input: totalTokens - 3, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens,
  reasoning: 1, cacheWrite1h: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})
const base = (type: string, id: string, parentId: string | null = null) => ({ type, id, parentId, timestamp })
const assistant = (id: string, count = 10, parentId: string | null = null, responseId?: string) => ({
  ...base('message', id, parentId),
  message: {
    role: 'assistant', provider: 'fixture', model: 'model', api: 'openai-responses',
    timestamp: 1, content: [], stopReason: 'stop', usage: usage(count), ...(responseId ? { responseId } : {})
  }
})
const independent = (id: string, count = 10, parentId: string | null = null) => ({
  ...base('usage', id, parentId), kind: 'cache_warm', provider: 'fixture', model: 'model', usage: usage(count)
})
const dirs: string[] = []
async function file(entries: unknown[], suffix = '\n'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pion-session-token-'))
  dirs.push(dir)
  const path = join(dir, 'fixture.jsonl')
  await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + suffix)
  return path
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('persisted whole-file session token projection', () => {
  it('counts assistant/cache-warm/child tool usage plus SDK summary usage across every branch', async () => {
    const path = await file([
      header, assistant('root', 10), assistant('old-branch', 20, 'root'), assistant('new-branch', 30, 'root'),
      independent('warm', 40, 'new-branch'),
      { ...base('message', 'children', 'warm'), message: {
        role: 'toolResult', toolCallId: 'batch-call', toolName: 'pion_subagents', timestamp: 2,
        isError: false, content: [], usage: usage(50), details: { results: [{ usage: usage(999) }] }
      } },
      { ...base('compaction', 'compact', 'children'), summary: 'summary', firstKeptEntryId: 'new-branch', tokensBefore: 999, usage: usage(60) },
      { ...base('branch_summary', 'summary', 'root'), fromId: 'old-branch', summary: 'summary', usage: usage(70) },
      { ...base('custom', 'ignored', 'summary'), customType: 'metadata', data: { usage: usage(999) } },
      { ...base('message', 'user', 'ignored'), message: {
        role: 'user', timestamp: 3, content: [{ type: 'image', mimeType: 'image/png', data: 'not-decodable-base64' }]
      } }
    ])
    expect(await readSessionTokenTotal(path)).toBe(280)
  })

  it('projects bounded numeric receipts without content, preserves SDK total and summary/tool attribution', async () => {
    const entries = [header, { ...assistant('first'), message: { ...assistant('first').message,
      responseModel: 'response-model', content: [{ type: 'text', text: 'PRIVATE-PROMPT' }] } },
    { ...base('message', 'tool', 'first'), message: { role: 'toolResult', toolCallId: 'native-call', toolName: 'codemode',
      isError: false, timestamp: 2, content: [], usage: usage(20), details: { usage: usage(999) } } },
    { ...base('compaction', 'compact', 'tool'), summary: 'PRIVATE-SUMMARY', firstKeptEntryId: 'first', tokensBefore: 100, usage: usage(30) }]
    const path = await file(entries)
    const snapshot = await readSessionUsageSnapshot(path)
    expect(snapshot.total).toBe(60)
    expect(snapshot.receipts.map(receipt => receipt.source)).toEqual(['model', 'tool-summary', 'tool-summary'])
    expect(snapshot.receipts[0]).toMatchObject({ modelId: 'response-model', usage: { total: 10, output: 1, reasoning: 1, cacheWrite: 1 } })
    expect(snapshot.receipts[1].provider).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-')
    const clone = await file([{ ...header, id: 'child', parentSession: path }, entries[1],
      { ...entries[2], parentId: null }, { ...entries[3], parentId: null, firstKeptEntryId: 'compact' }])
    const copied = await readSessionUsageSnapshot(clone)
    expect(copied.parentSession).toBe(path)
    expect(copied.receipts.map(receipt => receipt.digest)).toEqual(snapshot.receipts.map(receipt => receipt.digest))
  })

  it('reads ledger lines past the sidebar limit and yields once per 64 KiB block without changing identity deduplication', async () => {
    const original = assistant('first', 10, null, 'response-1')
    const first = { ...original, message: { ...original.message, content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] } }
    const path = await file([header, first, first, { ...first, id: 'second', parentId: 'first' }])
    const yieldRead = vi.fn(async () => {})
    const snapshot = await readSessionUsageSnapshot(path, { id: header.id, cwd: header.cwd }, { yield: yieldRead })
    expect(snapshot.total).toBe(10)
    expect(snapshot.receipts.map(receipt => receipt.entryId)).toEqual(['first', 'second'])
    expect(yieldRead).toHaveBeenCalledTimes(Math.ceil(snapshot.bytes / (64 * 1024)))
    expect(await readSessionTokenTotal(path)).toBeUndefined()
  })

  it('streams ledger files past 32 MiB while the sidebar still refuses them', async () => {
    const path = await file([header])
    const handle = await fs.open(path, 'a')
    try {
      // Each line remains within the sidebar line limit; only total file size exceeds it.
      const content = 'x'.repeat(512 * 1024)
      for (let index = 0; index < 65; index++) {
        await handle.writeFile(JSON.stringify({ ...base('session_info', `name-${index}`), name: content }) + '\n')
      }
      await handle.writeFile(JSON.stringify(assistant('last')) + '\n')
    } finally { await handle.close() }
    expect((await readSessionUsageSnapshot(path)).total).toBe(10)
    expect(await readSessionTokenTotal(path)).toBeUndefined()
  })

  it('reads all ledger entries beyond the sidebar entry count', async () => {
    const path = await file([header])
    const handle = await fs.open(path, 'a')
    try {
      for (let batch = 0; batch < 100; batch++) {
        const lines = Array.from({ length: 1000 }, (_, index) => JSON.stringify(base('session_info', `entry-${batch * 1000 + index}`)))
        await handle.writeFile(lines.join('\n') + '\n')
      }
      await handle.writeFile(JSON.stringify(assistant('last')) + '\n')
    } finally { await handle.close() }
    expect((await readSessionUsageSnapshot(path)).total).toBe(10)
    expect(await readSessionTokenTotal(path)).toBeUndefined()
  })

  it('closes the actual reader when the cooperative yield callback fails', async () => {
    const path = await file([header])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const handle = await actual.open(path, 'r')
    const close = vi.spyOn(handle, 'close')
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(readSessionUsageSnapshot(path, undefined, { yield: async () => { throw new Error('pause failed') } }))
      .rejects.toMatchObject({ closeUnknown: false })
    expect(close).toHaveBeenCalledOnce()
  })

  it('distinguishes unconfirmed close for the ledger while the old API remains unknown', async () => {
    const path = await file([header])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('private failure') })
      return handle
    })
    await expect(readSessionUsageSnapshot(path)).rejects.toMatchObject({ closeUnknown: true, message: 'Session usage unavailable' })
    expect(await readSessionTokenTotal(path)).toBeUndefined()
  })

  it('refuses tokens belonging to a changed SDK header ID or cwd', async () => {
    const path = await file([header, assistant('first')])
    expect(await readSessionTokenTotal(path, { id: header.id, cwd: header.cwd })).toBe(10)
    expect(await readSessionTokenTotal(path, { id: 'other-session', cwd: header.cwd })).toBeUndefined()
    expect(await readSessionTokenTotal(path, { id: header.id, cwd: '/other/project' })).toBeUndefined()
  })

  it('returns a genuine zero only for valid files with no reported tokens', async () => {
    expect(await readSessionTokenTotal(await file([header]))).toBe(0)
    const zero = { ...assistant('zero'), message: { ...assistant('zero').message, usage: {
      ...usage(3), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cacheWrite1h: 0
    } } }
    expect(await readSessionTokenTotal(await file([header, zero]))).toBe(0)
    expect(await readSessionTokenTotal(await file([{ ...header, version: 2 }, assistant('v2')]))).toBe(10)
  })

  it('deduplicates identical entry IDs and explicit native original responses/results only', async () => {
    const first = assistant('first', 10, null, 'response-1')
    const duplicateResponse = { ...first, id: 'second', parentId: 'first' }
    const tool = { ...base('message', 'tool', 'second'), message: {
      role: 'toolResult', toolCallId: 'call', toolName: 'pion_subagents', timestamp: 2,
      content: [], isError: false, usage: usage(20)
    } }
    const path = await file([header, first, first, duplicateResponse, tool, { ...tool, id: 'tool-copy', parentId: 'tool' }])
    expect(await readSessionTokenTotal(path)).toBe(30)
  })

  it('does not guess identity from equal timestamps, text, usage values or custom details', async () => {
    expect(await readSessionTokenTotal(await file([
      header, assistant('a'), assistant('b'), independent('c'), independent('d')
    ]))).toBe(40)
  })

  it('returns unknown for conflicting IDs or native original response usage', async () => {
    expect(await readSessionTokenTotal(await file([header, assistant('a'), assistant('a', 11)]))).toBeUndefined()
    expect(await readSessionTokenTotal(await file([
      header, assistant('a', 10, null, 'response-1'), assistant('b', 11, 'a', 'response-1')
    ]))).toBeUndefined()
  })

  it.each([
    ['legacy header', [{ ...header, version: 1 }]],
    ['future header', [{ ...header, version: 4 }]],
    ['missing header', [assistant('a')]],
    ['duplicate header', [header, header]],
    ['invalid session ID', [{ ...header, id: '../other' }]],
    ['invalid header timestamp', [{ ...header, timestamp: 'bad' }]],
    ['missing cwd', [{ ...header, cwd: undefined }]],
    ['unknown entry', [header, base('future_usage', 'a')]],
    ['missing parent', [header, assistant('a', 10, 'missing')]],
    ['missing entry ID', [header, { ...assistant('a'), id: undefined }]],
    ['missing usage', [header, { ...assistant('a'), message: { ...assistant('a').message, usage: undefined } }]],
    ['negative usage', [header, independent('a', -1)]],
    ['fractional usage', [header, independent('a', 10.5)]],
    ['unsafe usage', [header, independent('a', Number.MAX_SAFE_INTEGER + 1)]],
    ['malformed cache counter', [header, { ...independent('a'), usage: { ...usage(10), cacheRead: '1' } }]],
    ['missing usage attribution', [header, { ...independent('a'), provider: undefined }]],
    ['unknown top-level usage source', [header, { ...base('custom', 'a'), customType: 'extension', usage: usage(10) }]]
  ])('keeps %s unknown instead of presenting partial or zero totals', async (_label, entries) => {
    expect(await readSessionTokenTotal(await file(entries))).toBeUndefined()
  })

  it('rejects total overflow', async () => {
    expect(await readSessionTokenTotal(await file([
      header, independent('a', Number.MAX_SAFE_INTEGER), independent('b')
    ]))).toBeUndefined()
  })

  it('rejects invalid JSON, UTF-8 and incomplete final appends', async () => {
    const path = await file([header, assistant('a')])
    await writeFile(path, `${JSON.stringify(header)}\n{bad}\n`)
    expect(await readSessionTokenTotal(path)).toBeUndefined()
    await writeFile(path, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), Buffer.from([0xff, 10])]))
    expect(await readSessionTokenTotal(path)).toBeUndefined()
    expect(await readSessionTokenTotal(await file([header, assistant('a')], ''))).toBeUndefined()
  })

  it('bounds line bytes, file bytes and record counts without reading attachments', async () => {
    const long = { ...base('custom', 'a'), customType: 'fixture', data: 'x'.repeat(1024 * 1024) }
    expect(await readSessionTokenTotal(await file([header, long]))).toBeUndefined()
    const path = await file([header])
    await truncate(path, 32 * 1024 * 1024 + 1)
    expect(await readSessionTokenTotal(path)).toBeUndefined()
    const lines = Array.from({ length: 100_001 }, (_, i) => ({ ...base('session_info', `id-${i}`), name: 'fixture' }))
    expect(await readSessionTokenTotal(await file([header, ...lines]))).toBeUndefined()
  })

  it.each(['read-failure', 'close-failure', 'growth', 'truncation', 'modified', 'replaced'])('keeps %s during a read unknown and closes the descriptor', async failure => {
    const data = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(assistant('a'))}\n`)
    const snapshot = { isFile: () => true, size: BigInt(data.length), dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n }
    let reads = 0
    const close = vi.fn(async () => { if (failure === 'close-failure') throw new Error('close') })
    const handle = {
      stat: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, mtimeNs: failure === 'modified' ? 5n : 3n }),
      close,
      read: vi.fn(async (buffer: Buffer) => {
        if (failure === 'read-failure') throw new Error('read')
        if (reads++ > 0) return { bytesRead: 0 }
        const payload = failure === 'growth' ? Buffer.concat([data, Buffer.from('x')])
          : failure === 'truncation' ? data.subarray(0, data.length - 2) : data
        payload.copy(buffer)
        return { bytesRead: payload.length }
      })
    }
    vi.mocked(fs.open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>)
    vi.mocked(fs.lstat).mockResolvedValue({ ...snapshot, ino: failure === 'replaced' ? 9n : 2n } as never)
    expect(await readSessionTokenTotal('/fixture/session.jsonl')).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('returns unknown for read failures, directories and symbolic links', async () => {
    const path = await file([header])
    expect(await readSessionTokenTotal(`${path}.missing`)).toBeUndefined()
    expect(await readSessionTokenTotal(dirs[dirs.length - 1])).toBeUndefined()
    if (process.platform !== 'win32') {
      await symlink(path, `${path}.link`)
      expect(await readSessionTokenTotal(`${path}.link`)).toBeUndefined()
    }
    await writeFile(path, '')
    expect(await readSessionTokenTotal(path)).toBeUndefined()
  })
})
