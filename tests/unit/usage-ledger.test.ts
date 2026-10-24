import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sessionUsage from '../../src/main/agent/session-token-total'
import { UsageLedger } from '../../src/main/usage-ledger'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) }
})

const timestamp = '2026-06-01T00:00:00.000Z'
const cwd = '/fixture/project'
const usage = (totalTokens = 10) => ({ input: totalTokens - 3, output: 1, cacheRead: 1, cacheWrite: 1,
  reasoning: 1, cacheWrite1h: 1, totalTokens, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } })
const header = (id: string, parentSession?: string, project = cwd) => ({ type: 'session', version: 3, id, cwd: project,
  timestamp, ...(parentSession ? { parentSession } : {}) })
const base = (type: string, id: string, parentId: string | null = null) => ({ type, id, parentId, timestamp })
const assistant = (id: string, totalTokens = 10, parentId: string | null = null) => ({ ...base('message', id, parentId),
  message: { role: 'assistant', timestamp: Date.parse(timestamp), provider: 'fixture', model: 'model', api: 'openai-responses',
    content: [{ type: 'text', text: 'PRIVATE-PROMPT' }], stopReason: 'stop', usage: usage(totalTokens) } })
const independent = (id: string, totalTokens = 10) => ({ ...base('usage', id), provider: 'fixture', model: 'model', kind: 'cache_warm', usage: usage(totalTokens) })
const jsonl = (entries: unknown[]) => entries.map(value => JSON.stringify(value)).join('\n') + '\n'
const dirs: string[] = []
const ledgers: UsageLedger[] = []
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pion-usage-ledger-'))
  dirs.push(dir)
  const root = join(dir, 'sessions')
  await fs.mkdir(join(root, 'bucket'), { recursive: true })
  const options = { ledgerPath: join(dir, 'ledger.json'), sessionRoot: root }
  const ledger = new UsageLedger(options)
  ledgers.push(ledger)
  return { ...options, dir, root, ledger,
    file: async (name: string, entries: unknown[]) => {
      const path = join(root, 'bucket', `${name}.jsonl`)
      await fs.writeFile(path, jsonl(entries))
      return path
    } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// Keep real IO/yield timers; manually release only the long scheduler deadlines.
function backgroundClock() {
  const timeout = globalThis.setTimeout
  const pending: { delay: number; fire: () => void }[] = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay < 30_000) return timeout(callback, delay, ...args)
    const timer = timeout(callback, 1_000_000_000, ...args)
    pending.push({ delay, fire: () => { clearTimeout(timer); callback() } })
    return timer
  }) as typeof setTimeout)
  return pending
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
})
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.stopBackgroundCollection()
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('durable local usage ledger', () => {
  it('is lazy, deduplicates rescans/restarts, and persists only bounded metadata and hashes', async () => {
    const f = await fixture()
    await f.file('root', [header('root'), assistant('1234abcd'), independent('warm')])
    const opens = vi.mocked(fs.open).mock.calls.length
    const ledger = new UsageLedger(f)
    expect(vi.mocked(fs.open).mock.calls).toHaveLength(opens)
    const first = await ledger.getOverview()
    expect(first).toMatchObject({ revision: 1, sessions: 1, records: 2, totals: { total: 20, costUsd: 0.4, reasoning: 2 }, warnings: [] })
    const rescanned = await ledger.getOverview()
    const restarted = await new UsageLedger(f).getOverview()
    expect(rescanned).toEqual(first)
    expect(restarted).toEqual(first)
    const saved = await fs.readFile(f.ledgerPath, 'utf8')
    expect(saved).not.toContain('PRIVATE-PROMPT')
    expect(saved).not.toContain('1234abcd')
    expect(saved).not.toContain('root.jsonl')
  })

  it('retains already-bound children after parent deletion/restart across a copy/fork chain', async () => {
    const f = await fixture()
    const a = assistant('1234abcd')
    const label = { ...base('label', 'label', '1234abcd'), targetId: '1234abcd', label: 'PRIVATE-LABEL' }
    const compact = { ...base('compaction', 'compact', 'label'), summary: 'PRIVATE-SUMMARY', firstKeptEntryId: 'label', tokensBefore: 100, usage: usage(20) }
    const source = await f.file('parent', [header('parent'), a, label, compact])
    await f.ledger.captureSession(source)
    const copied = [a, { ...compact, parentId: '1234abcd', firstKeptEntryId: '1234abcd' }]
    const child = await f.file('child', [header('child', source, '/fixture/child'), ...copied, assistant('child-new', 30, 'compact')])
    await f.ledger.captureSession(child)
    await fs.unlink(source)
    const grandchild = await f.file('grandchild', [header('grandchild', child, '/fixture/grandchild'), ...copied,
      assistant('child-new', 30, 'compact'), assistant('grand-new', 40, 'child-new')])
    await f.ledger.captureSession(grandchild)
    await fs.unlink(child)
    const value = await new UsageLedger(f).getOverview()
    expect(value).toMatchObject({ sessions: 3, records: 4, totals: { total: 100 }, warnings: [] })
    expect(value.byProject.find(project => project.cwd === cwd)?.usage.total).toBe(30)
    expect(value.byProject.find(project => project.cwd === '/fixture/child')?.usage.total).toBe(30)
    expect(value.byProject.find(project => project.cwd === '/fixture/grandchild')?.usage.total).toBe(40)
    await f.ledger.captureSession(grandchild)
    expect((await f.ledger.getOverview()).totals.total).toBe(100)
  })

  it('recognizes moved same-ID sessions without reattributing old receipts to the new cwd', async () => {
    const f = await fixture()
    const source = await f.file('before', [header('same-session'), assistant('first')])
    await f.ledger.captureSession(source)
    const moved = await f.file('after', [header('same-session', undefined, '/fixture/moved'), assistant('first'), assistant('second', 20, 'first')])
    await f.ledger.captureSession(moved)
    const child = await f.file('child', [header('child', source), assistant('first')])
    await f.ledger.captureSession(child)
    await fs.unlink(source)
    const value = await new UsageLedger(f).getOverview()
    expect(value).toMatchObject({ sessions: 2, records: 2, totals: { total: 30 }, warnings: [] })
    expect(value.byProject.find(project => project.cwd === cwd)?.usage.total).toBe(10)
    expect(value.byProject.find(project => project.cwd === '/fixture/moved')?.usage.total).toBe(20)
  })

  it('keeps equal numbers/short entry IDs in unrelated sessions distinct and honors native event IDs within lineage', async () => {
    const f = await fixture()
    const first = { ...assistant('1234abcd'), message: { ...assistant('1234abcd').message, responseId: 'native-response' } }
    await f.file('a', [header('a'), first, { ...first, id: 'duplicate', parentId: '1234abcd' }, independent('warm-a'), independent('warm-b')])
    await f.file('b', [header('b'), first])
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 4, totals: { total: 40 }, warnings: [] })
  })

  it('does not follow a missing parent path and can later resolve persisted orphan receipts', async () => {
    const f = await fixture()
    const missing = join(f.dir, 'not-in-history.jsonl')
    const orphan = await f.file('orphan', [header('orphan', missing), assistant('inherited'), assistant('new', 20, 'inherited')])
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 0, totals: { total: 0 }, coverage: { unresolvedSessions: 1 } })
    expect(value.warnings).toContain('unresolved-lineage')
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path) === missing)).toBe(false)
    await expect(f.ledger.captureSession(orphan)).rejects.toThrow('Usage ledger unavailable')
    expect(vi.mocked(fs.lstat).mock.calls.some(([path]) => String(path) === missing)).toBe(false)
    await fs.writeFile(missing, jsonl([header('parent'), assistant('inherited')]))
    await f.ledger.captureSession(missing)
    const recovered = await new UsageLedger(f).getOverview()
    expect(recovered).toMatchObject({ sessions: 2, records: 2, totals: { total: 30 }, warnings: [] })
  })

  it('refuses conflicting same-session receipts without overwriting durable evidence', async () => {
    const f = await fixture()
    const path = await f.file('root', [header('root'), assistant('same-entry')])
    await f.ledger.captureSession(path)
    const before = await fs.readFile(f.ledgerPath, 'utf8')
    await fs.writeFile(path, jsonl([header('root'), assistant('same-entry', 20)]))
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 1, totals: { total: 10 }, coverage: { unavailableSessions: 1 } })
    expect(value.warnings).toContain('collection-failed')
    await expect(f.ledger.captureSession(path)).rejects.toThrow('Usage ledger unavailable')
    expect(await fs.readFile(f.ledgerPath, 'utf8')).toBe(before)
  })

  it('quarantines conflicting inherited/native evidence rather than guessing a second charge', async () => {
    const f = await fixture()
    const path = await f.file('parent', [header('parent'), assistant('same-entry')])
    await f.ledger.captureSession(path)
    const child = await f.file('child', [header('child', path), assistant('same-entry', 20)])
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 1, totals: { total: 10 }, coverage: { unresolvedSessions: 1 } })
    expect(value.warnings).toContain('collection-failed')
    await expect(f.ledger.captureSession(child)).rejects.toThrow('Usage ledger unavailable')
  })

  it('retains established lineage but never guesses a new parent after a recorded path is reused', async () => {
    const f = await fixture()
    const path = await f.file('parent', [header('parent'), assistant('original')])
    await f.ledger.captureSession(path)
    const child = await f.file('old-child', [header('old-child', path), assistant('original'), assistant('old-new', 20, 'original')])
    await f.ledger.captureSession(child)
    await fs.writeFile(path, jsonl([header('different-parent'), assistant('different', 30)]))
    await f.file('new-child', [header('new-child', path), assistant('different', 30)])
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 2, totals: { total: 30 }, coverage: { unresolvedSessions: 1 } })
    expect(value.warnings).toContain('collection-failed')
    expect(value.warnings).toContain('unresolved-lineage')
    await fs.unlink(path)
    const restarted = await new UsageLedger(f).getOverview()
    expect(restarted.totals.total).toBe(30)
    expect(restarted.coverage.unresolvedSessions).toBe(1)
  })

  it('rejects direct capture through a reused parent alias and never binds an unproven missing parent', async () => {
    const f = await fixture()
    const path = await f.file('parent', [header('parent-a'), assistant('original')])
    await f.ledger.captureSession(path)
    const before = await fs.readFile(f.ledgerPath, 'utf8')
    const parentReads = vi.mocked(fs.open).mock.calls.filter(([file]) => String(file) === path).length
    await fs.writeFile(path, jsonl([header('parent-b'), assistant('different', 30)]))
    const child = await f.file('child', [header('child', path), assistant('different', 30), assistant('child-new', 20, 'different')])
    await expect(f.ledger.captureSession(child)).rejects.toThrow('Usage ledger unavailable')
    expect(await fs.readFile(f.ledgerPath, 'utf8')).toBe(before)
    expect(vi.mocked(fs.open).mock.calls.filter(([file]) => String(file) === path)).toHaveLength(parentReads)
    await fs.unlink(path)
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ sessions: 2, records: 1, totals: { total: 10 }, coverage: { unresolvedSessions: 1 } })
    expect(value.warnings).toContain('unresolved-lineage')
    expect(await new UsageLedger(f).getOverview()).toEqual(value)
  })

  it('rechecks parent proofs after the actual temporary close, before publishing a new lineage edge', async () => {
    const f = await fixture()
    const path = await f.file('parent', [header('parent-a'), assistant('original')])
    await f.ledger.captureSession(path)
    const before = await fs.readFile(f.ledgerPath, 'utf8')
    const publications = vi.mocked(fs.rename).mock.calls.length
    const child = await f.file('child', [header('child', path), assistant('original'), assistant('child-new', 20, 'original')])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let reused = false
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (String(file).startsWith(`${f.ledgerPath}.tmp-`)) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close()
          await fs.writeFile(path, jsonl([header('parent-b'), assistant('different', 30)]))
          reused = true
        })
      }
      return handle
    })
    await expect(f.ledger.captureSession(child)).rejects.toThrow('Usage ledger unavailable')
    expect(reused).toBe(true)
    expect(fs.rename).toHaveBeenCalledTimes(publications)
    expect(await fs.readFile(f.ledgerPath, 'utf8')).toBe(before)
  })

  it('reads every file despite large byte counts and rejects a changed parent alias', async () => {
    const f = await fixture()
    const path = await f.file('z-parent', [header('parent-a'), assistant('original')])
    await f.ledger.captureSession(path)
    await fs.writeFile(path, jsonl([header('parent-b'), assistant('different', 30)]))
    await f.file('a-child', [header('child', path), assistant('different', 30), assistant('child-new', 20, 'different')])
    await f.file('b-padding', [header('padding-b')])
    await f.file('c-padding', [header('padding-c')])
    const read = sessionUsage.readSessionUsageSnapshot
    vi.spyOn(sessionUsage, 'readSessionUsageSnapshot').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      // Model maximum-sized valid files without allocating their contents.
      return { ...snapshot, bytes: 32 * 1024 * 1024 }
    })
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 1, totals: { total: 10 }, coverage: { discoveredSessions: 4, unresolvedSessions: 1, unavailableSessions: 1, limitReached: false } })
    expect(value.warnings).toContain('unresolved-lineage')
    expect(value.warnings).toContain('collection-failed')
    expect(value.warnings).not.toContain('capacity-reached')
    expect(sessionUsage.readSessionUsageSnapshot).toHaveBeenCalledTimes(4)
    expect(vi.mocked(fs.open).mock.calls.filter(([file]) => String(file) === path)).toHaveLength(2)
    await fs.unlink(path)
    const restarted = await new UsageLedger(f).getOverview()
    expect(restarted).toMatchObject({ records: 1, totals: { total: 10 }, coverage: { unresolvedSessions: 1 } })
  })

  it('exposes partial history, bounds discovery to root/one bucket, and never follows symlinks', async () => {
    const f = await fixture()
    await f.file('valid', [header('valid'), assistant('entry')])
    await fs.writeFile(join(f.root, 'direct.jsonl'), jsonl([header('direct'), independent('warm')]))
    await fs.writeFile(join(f.root, 'bucket', 'bad.jsonl'), '{private invalid body}\n')
    await fs.writeFile(join(f.root, 'bucket', 'partial.jsonl'), jsonl([header('partial')]).trimEnd())
    await fs.mkdir(join(f.root, 'bucket', 'nested'))
    const deep = join(f.root, 'bucket', 'nested', 'deep.jsonl')
    await fs.writeFile(deep, jsonl([header('ignored'), assistant('ignored', 100)]))
    if (process.platform !== 'win32') {
      await fs.symlink(deep, join(f.root, 'link.jsonl'))
      await fs.symlink(join(f.root, 'bucket', 'nested'), join(f.root, 'linked-bucket'))
    }
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 2, totals: { total: 20 }, coverage: { discoveredSessions: 4, collectedSessions: 2, unavailableSessions: 2 } })
    expect(value.warnings).toContain('incomplete-history')
  })

  it('keeps tool/summary totals separate, trusts SDK totalTokens, and projects only 30 UTC days', async () => {
    const f = await fixture()
    const now = Date.now()
    const old = now - 60 * 86_400_000
    const model = assistant('model')
    model.message.timestamp = old
    model.message.usage = { ...usage(100), totalTokens: 777 }
    const tool = { ...base('message', 'tool', 'model'), message: { role: 'toolResult', toolName: 'pion_subagents', toolCallId: 'tool-call',
      timestamp: now, isError: false, content: [], usage: usage(20), details: { results: [{ usage: usage(999) }] } } }
    const compact = { ...base('branch_summary', 'summary', 'tool'), timestamp: new Date(now).toISOString(), fromId: 'model', summary: 'private', usage: usage(30) }
    await f.file('root', [header('root'), model, tool, compact])
    const value = await f.ledger.getOverview()
    expect(value.totals.total).toBe(827)
    expect(value.firstRecordAt).toBe(old)
    expect(value.byModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'model', provider: 'fixture', modelId: 'model', usage: expect.objectContaining({ total: 777 }) }),
      expect.objectContaining({ source: 'tool-summary', usage: expect.objectContaining({ total: 50 }) })
    ]))
    expect(value.byModel.find(model => model.source === 'tool-summary')?.provider).toBeUndefined()
    expect(value.daily).toHaveLength(1)
    expect(value.daily[0].date).toBe(new Date(now).toISOString().slice(0, 10))
    expect(value.daily.reduce((sum, day) => sum + day.usage.total, 0)).toBe(50)
  })

  it('has no synthetic daily dates but retains real zero-usage receipt dates inside the UTC window', async () => {
    const f = await fixture()
    expect((await f.ledger.getOverview()).daily).toEqual([])
    const today = new Date().toISOString().slice(0, 10)
    const start = Date.parse(`${today}T00:00:00.000Z`)
    const zero = (id: string, at: number) => {
      const receipt = assistant(id)
      receipt.message.timestamp = at
      receipt.message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheWrite1h: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      return receipt
    }
    await f.file('zero', [header('zero'), zero('today', start), zero('old', start - 30 * 86_400_000),
      zero('first-day', start - 29 * 86_400_000), zero('future', start + 86_400_000)])
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 4, totals: { total: 0, costUsd: 0 } })
    expect(value.daily.map(day => day.date)).toEqual([new Date(start - 29 * 86_400_000).toISOString().slice(0, 10), today])
    expect(value.daily.every(day => day.usage.total === 0 && day.usage.costUsd === 0)).toBe(true)
  })

  it('shares one main-process overview promise across concurrent callers until the actual save close settles', async () => {
    const f = await fixture()
    const path = await f.file('root', [header('root'), assistant('first')])
    const started = deferred()
    const release = deferred()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let sourceReads = 0
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (String(file) === path) sourceReads++
      if (String(file).startsWith(`${f.ledgerPath}.tmp-`)) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { started.resolve(); await release.promise; await close() })
      }
      return handle
    })
    const first = f.ledger.getOverview()
    await started.promise
    const calls = Array.from({ length: 32 }, () => f.ledger.getOverview())
    try {
      expect(calls.every(call => call === first)).toBe(true)
      expect(sourceReads).toBe(1)
      expect(fs.rename).not.toHaveBeenCalled()
      expect(f.ledger.getOverview()).toBe(first)
    } finally { release.resolve(); await Promise.allSettled([first, ...calls]) }
    const completed = await first
    expect((await Promise.all(calls)).every(value => value === completed)).toBe(true)
    const next = f.ledger.getOverview()
    expect(next).not.toBe(first)
    expect((await next).totals.total).toBe(10)
    expect(sourceReads).toBe(1)
  })

  it('refuses an existing foreign lock and damaged ledgers without resetting or cleaning them', async () => {
    const f = await fixture()
    const lock = `${f.ledgerPath}.lock`
    await fs.writeFile(lock, 'foreign-lock')
    await expect(f.ledger.getOverview()).rejects.toThrow('Usage ledger unavailable')
    expect(await fs.readFile(lock, 'utf8')).toBe('foreign-lock')
    await fs.unlink(lock)
    await fs.writeFile(f.ledgerPath, '{damaged private ledger}')
    await expect(f.ledger.getOverview()).rejects.toThrow('Usage ledger unavailable')
    expect(await fs.readFile(f.ledgerPath, 'utf8')).toBe('{damaged private ledger}')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('keeps the previous durable revision after a save failure and rejects destructive capture', async () => {
    const f = await fixture()
    const path = await f.file('root', [header('root'), assistant('first')])
    await f.ledger.captureSession(path)
    const before = await fs.readFile(f.ledgerPath, 'utf8')
    await fs.appendFile(path, jsonl([assistant('second', 20, 'first')]))
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('PRIVATE-DIAGNOSTIC'))
    await expect(f.ledger.captureSession(path)).rejects.toThrow('Usage ledger unavailable')
    expect(await fs.readFile(f.ledgerPath, 'utf8')).toBe(before)
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ revision: 2, records: 2, totals: { total: 30 } })
    expect((await fs.readdir(f.dir)).some(name => name.startsWith('ledger.json.tmp-'))).toBe(true)
  })

  it('records source read failures as partial without fabricating empty totals', async () => {
    const f = await fixture()
    const path = await f.file('root', [header('root'), assistant('first')])
    await f.ledger.captureSession(path)
    await fs.appendFile(path, jsonl([assistant('second', 20, 'first')]))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      if (String(file) === path) throw Object.assign(new Error('PRIVATE-SDK-BODY'), { code: 'EACCES' })
      return actual.open(file, flags, mode)
    })
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 1, totals: { total: 10 }, coverage: { unavailableSessions: 1 } })
    expect(value.warnings).toContain('incomplete-history')
    await expect(f.ledger.captureSession(path)).rejects.toThrow('Usage ledger unavailable')
  })

  it('keeps previous receipts while collecting every appended record without a capacity warning', async () => {
    const f = await fixture()
    const path = await f.file('root', [header('root'), assistant('first')])
    await f.ledger.captureSession(path)
    await fs.appendFile(path, jsonl(Array.from({ length: 128 }, (_, i) => assistant(`next-${i}`, 20))))
    const value = await f.ledger.getOverview()
    expect(value).toMatchObject({ records: 129, totals: { total: 2570 }, coverage: { limitReached: false }, warnings: [] })
    await expect(f.ledger.captureSession(path)).resolves.toBeUndefined()
    expect(await new UsageLedger(f).getOverview()).toEqual(value)
  })

  it('merges dirty notifications, retains the actual close slot/foreign lock, and waits in flush', async () => {
    const f = await fixture()
    f.ledger.setBackgroundCollectionEnabled(true)
    const path = await f.file('root', [header('root'), assistant('first')])
    const started = deferred()
    const release = deferred()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let sourceReads = 0
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (String(file) === path && ++sourceReads === 1) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { started.resolve(); await release.promise; await close() })
      }
      return handle
    })
    const capture = expect(f.ledger.captureSession(path)).rejects.toThrow('Usage ledger unavailable')
    await started.promise
    await fs.appendFile(path, jsonl([assistant('second', 20, 'first')]))
    for (let i = 0; i < 50; i++) f.ledger.scheduleSession(path)
    let flushed = false
    const flush = f.ledger.flush().then(() => { flushed = true })
    await expect(new UsageLedger(f).getOverview()).rejects.toThrow('Usage ledger unavailable')
    expect(sourceReads).toBe(1)
    expect(flushed).toBe(false)
    release.resolve()
    await Promise.all([capture, flush])
    expect(sourceReads).toBe(2)
    expect((await f.ledger.getOverview()).totals.total).toBe(30)
    expect(sourceReads).toBe(2)
  })

  it('does no background IO by default or after disabling, while foreground still scans all files', async () => {
    const f = await fixture()
    const first = await f.file('a', [header('a'), assistant('one')])
    await f.file('b', [header('b'), assistant('two', 20)])
    const read = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot')
    const clock = backgroundClock()
    f.ledger.scheduleSession(first)
    await f.ledger.flush()
    expect(read).not.toHaveBeenCalled()
    expect(clock).toHaveLength(0)
    f.ledger.setBackgroundCollectionEnabled(true)
    f.ledger.scheduleSession(first)
    f.ledger.setBackgroundCollectionEnabled(false)
    await f.ledger.flush()
    expect(read).not.toHaveBeenCalled()
    expect((await f.ledger.getOverview()).totals.total).toBe(30)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('coalesces dirty files on a 30-second deadline and runs later full scans every five minutes', async () => {
    const f = await fixture()
    const path = await f.file('a', [header('a'), assistant('one')])
    const read = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot')
    const clock = backgroundClock()
    f.ledger.setBackgroundCollectionEnabled(true)
    for (let i = 0; i < 50; i++) f.ledger.scheduleSession(path)
    expect(clock.map(timer => timer.delay)).toEqual([30_000, 30_000])
    expect(read).not.toHaveBeenCalled()
    clock[1].fire()
    await f.ledger.flush()
    expect(read).toHaveBeenCalledTimes(1)
    clock[0].fire()
    await f.ledger.flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(clock.at(-1)?.delay).toBe(300_000)
    await f.file('b', [header('b'), assistant('two', 20)])
    clock.at(-1)!.fire()
    await f.ledger.flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect((await f.ledger.getOverview()).totals.total).toBe(30)
    f.ledger.stopBackgroundCollection()
    f.ledger.setBackgroundCollectionEnabled(true)
    const deadlines = clock.length
    f.ledger.scheduleSession(path)
    await f.ledger.flush()
    expect(clock).toHaveLength(deadlines)
  })

  it('flushes notified files after stop before the deadline without discovering other files or restarting timers', async () => {
    const f = await fixture()
    const first = await f.file('a', [header('a'), assistant('one')])
    const unnotified = await f.file('b', [header('b'), assistant('two', 20)])
    const read = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot')
    const clock = backgroundClock()
    f.ledger.setBackgroundCollectionEnabled(true)
    f.ledger.scheduleSession(first)
    expect(clock.map(timer => timer.delay)).toEqual([30_000, 30_000])
    expect(read).not.toHaveBeenCalled()
    f.ledger.stopBackgroundCollection()
    await f.ledger.flush()
    expect(read.mock.calls.map(([path]) => path)).toEqual([first])
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path) === unnotified)).toBe(false)
    const saved = JSON.parse(await fs.readFile(f.ledgerPath, 'utf8'))
    expect(saved.data.sessions).toHaveLength(1)
    expect(saved.data.sessions[0].receipts).toHaveLength(1)
    expect(saved.data.sessions[0].receipts[0].usage.total).toBe(10)
    expect(clock).toHaveLength(2)
    await f.ledger.flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(clock).toHaveLength(2)
  })

  it.each(['disable', 'stop'] as const)('does not admit the next dirty file when %s happens during the 20ms sleep', async action => {
    const f = await fixture()
    const first = await f.file('a', [header('a'), assistant('one')])
    const second = await f.file('b', [header('b'), assistant('two', 20)])
    const started = deferred()
    const release = deferred()
    const actualRead = sessionUsage.readSessionUsageSnapshot
    let firstClosed = false
    const read = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot').mockImplementation(async (...args) => {
      const snapshot = await actualRead(...args)
      if (args[0] === first) firstClosed = true
      return snapshot
    })
    const clock = backgroundClock()
    const timeout = vi.mocked(globalThis.setTimeout).getMockImplementation()!
    let held = false
    vi.mocked(globalThis.setTimeout).mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 20 && firstClosed && !held) {
        held = true
        return timeout(() => { started.resolve(); void release.promise.then(callback) }, delay, ...args)
      }
      return timeout(callback, delay, ...args)
    }) as typeof setTimeout)
    f.ledger.setBackgroundCollectionEnabled(true)
    f.ledger.scheduleSession(first)
    f.ledger.scheduleSession(second)
    clock[1].fire()
    await started.promise
    // The first snapshot has completed its real close; only the next-file sleep is held.
    expect(read.mock.calls.map(([path]) => path)).toEqual([first])
    const pending = (f.ledger as unknown as { scheduled: Promise<void> }).scheduled
    try {
      if (action === 'stop') f.ledger.stopBackgroundCollection()
      else f.ledger.setBackgroundCollectionEnabled(false)
    } finally { release.resolve() }
    await pending
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path) === second)).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
    await f.ledger.flush()
    const saved = JSON.parse(await fs.readFile(f.ledgerPath, 'utf8'))
    expect(saved.data.sessions).toHaveLength(action === 'stop' ? 2 : 1)
    expect(read.mock.calls.map(([path]) => path)).toEqual(action === 'stop' ? [first, second] : [first])
    expect(clock).toHaveLength(2)
  })

  it('disabling waits for the actual source close and stops before the next file', async () => {
    const f = await fixture()
    const path = await f.file('a', [header('a'), assistant('one')])
    const second = await f.file('b', [header('b'), assistant('two', 20)])
    const started = deferred()
    const release = deferred()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (String(file) === path) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { started.resolve(); await release.promise; await close() })
      }
      return handle
    })
    const clock = backgroundClock()
    f.ledger.setBackgroundCollectionEnabled(true)
    clock[0].fire()
    await started.promise
    f.ledger.setBackgroundCollectionEnabled(false)
    let settled = false
    const flush = f.ledger.flush().then(() => { settled = true })
    try {
      await expect(new UsageLedger(f).getOverview()).rejects.toThrow('Usage ledger unavailable')
      expect(settled).toBe(false)
      expect(vi.mocked(fs.open).mock.calls.some(([file]) => String(file) === second)).toBe(false)
    } finally { release.resolve(); await flush }
    expect(vi.mocked(fs.open).mock.calls.some(([file]) => String(file) === second)).toBe(false)
    expect((await f.ledger.getOverview()).totals.total).toBe(30)
  })

  it('promotes background yields for a foreground scan without bypassing the real close', async () => {
    const f = await fixture()
    const path = await f.file('a', [header('a'), assistant('one')])
    await f.file('b', [header('b'), assistant('two', 20)])
    const started = deferred()
    const release = deferred()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (String(file) === path) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { started.resolve(); await release.promise; await close() })
      }
      return handle
    })
    const clock = backgroundClock()
    f.ledger.setBackgroundCollectionEnabled(true)
    clock[0].fire()
    await started.promise
    expect(vi.mocked(globalThis.setTimeout).mock.calls.some(([, delay]) => delay === 20)).toBe(true)
    const before = vi.mocked(globalThis.setTimeout).mock.calls.length
    let settled = false
    const overview = f.ledger.getOverview().then(value => { settled = true; return value })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
    } finally { release.resolve() }
    expect((await overview).totals.total).toBe(30)
    const delays = vi.mocked(globalThis.setTimeout).mock.calls.slice(before).map(([, delay]) => delay)
    expect(delays).toContain(0)
    expect(delays).not.toContain(20)
    await f.ledger.flush()
  })

  it('skips unchanged file contents and reads only changed stamps on later scans', async () => {
    const f = await fixture()
    const first = await f.file('a', [header('a'), assistant('one')])
    await f.file('b', [header('b'), assistant('two', 20)])
    const read = vi.spyOn(sessionUsage, 'readSessionUsageSnapshot')
    await f.ledger.getOverview()
    expect(read).toHaveBeenCalledTimes(2)
    await f.ledger.getOverview()
    expect(read).toHaveBeenCalledTimes(2)
    await fs.appendFile(first, jsonl([assistant('three', 30, 'one')]))
    expect((await f.ledger.getOverview()).totals.total).toBe(60)
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls[2][0]).toBe(first)
  })

  it('keeps an unknown-close lock quarantined and does not retry or declare flush complete', async () => {
    const f = await fixture()
    const path = await f.file('root', [header('root'), assistant('first')])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let closes = 0
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (String(file) === path) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { closes++; await close(); throw new Error('private close status') })
      }
      return handle
    })
    await expect(f.ledger.captureSession(path)).rejects.toThrow('Usage ledger unavailable')
    expect(closes).toBe(1)
    expect(await fs.readFile(`${f.ledgerPath}.lock`, 'utf8')).not.toBe('')
    await expect(f.ledger.flush()).rejects.toThrow('Usage ledger unavailable')
    const first = f.ledger.getOverview()
    expect(f.ledger.getOverview()).toBe(first)
    await expect(first).rejects.toThrow('Usage ledger unavailable')
    await expect(f.ledger.getOverview()).rejects.toThrow('Usage ledger unavailable')
    await expect(new UsageLedger(f).getOverview()).rejects.toThrow('Usage ledger unavailable')
    expect(closes).toBe(1)
  })
})
