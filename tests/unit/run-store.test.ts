import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunOperation } from '../../src/shared/operations'
import { EMPTY_TOKEN_USAGE, MAX_USAGE_RECEIPTS, RunStore } from '../../src/main/run-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function operation(overrides: Partial<RunOperation> = {}): RunOperation {
  return {
    id: 'run-1',
    cwd: '/tmp/project',
    kind: 'prompt',
    state: 'dispatching',
    createdAt: 100,
    prompt: { message: 'test', images: [] },
    promptPreview: 'test',
    usage: { ...EMPTY_TOKEN_USAGE },
    tools: [],
    compactions: [],
    revision: 0,
    ...overrides
  }
}

describe('RunStore standalone SDK usage', () => {
  const source = { cwd: '/tmp/project', sessionPath: '/tmp/session.jsonl', backendId: 'backend-1' }
  const event = (id: string, at = 200) => ({ type: 'entry_appended', entry: {
    type: 'usage', kind: 'cache_warm', id, timestamp: new Date(at).toISOString(),
    provider: 'provider', model: 'model', usage: { input: 2, cacheRead: 8, totalTokens: 10, cost: { total: 0.25 } }
  } })
  const billedRun = (overrides: Partial<RunOperation> = {}) => operation({
    sessionPath: source.sessionPath, usageBackendId: source.backendId, provider: 'provider', modelId: 'model',
    state: 'completed', dispatchedAt: 100, ...overrides
  })

  it('accounts active and idle entries without changing compacted context, and persists deduplication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-usage-')); roots.push(root)
    const file = join(root, 'runs.json')
    const store = new RunStore(file); await store.load()
    store.create(billedRun({ state: 'running', liveUsage: { ...EMPTY_TOKEN_USAGE, input: 77 }, contextTokens: 77, contextPressure: 0.7, contextUsagePending: true }))
    expect(store.recordUsageEntry(source, event('active'))?.usage.costUsd).toBe(0.25)
    store.update('run-1', (run) => { run.state = 'completed' })
    store.create(billedRun({ id: 'queue', state: 'queued', dispatchedAt: undefined, createdAt: 300 }))
    expect(store.recordUsageEntry(source, event('idle'))?.id).toBe('run-1')
    expect(store.recordUsageEntry(source, event('idle'))).toBeNull()
    expect(store.get('run-1')).toMatchObject({ usage: { costUsd: 0.5 }, liveUsage: { input: 77 }, contextTokens: 77, contextPressure: 0.7, contextUsagePending: true })
    await store.flush()
    const restored = new RunStore(file); await restored.load()
    expect(restored.recordUsageEntry(source, event('active'))).toBeNull()
    expect(restored.get('run-1')?.usage.costUsd).toBe(0.5)
    await restored.flush()
  })

  it('uses entry time and backend/session/model identity, never a new queue or undispatched failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-usage-')); roots.push(root)
    const store = new RunStore(join(root, 'runs.json')); await store.load()
    store.create(billedRun())
    store.create(billedRun({ id: 'new', dispatchedAt: 300 }))
    store.create(billedRun({ id: 'failed-before-dispatch', state: 'failed', dispatchedAt: undefined, createdAt: 400 }))
    store.create(billedRun({ id: 'other-backend', usageBackendId: 'backend-2', dispatchedAt: 150 }))
    expect(store.recordUsageEntry(source, event('old', 250))?.id).toBe('run-1')
    expect(store.recordUsageEntry(source, event('new', 350))?.id).toBe('new')
    expect(store.recordUsageEntry({ ...source, backendId: 'backend-2' }, event('late-backend', 350))?.id).toBe('other-backend')
    expect(store.recordUsageEntry(source, event('before', 50))).toBeNull()
    expect(store.recordUsageEntry({ ...source, sessionPath: '/tmp/other.jsonl' }, event('other'))).toBeNull()
    const mismatch = event('model'); mismatch.entry.model = 'different'; mismatch.entry.kind = 'other'
    expect(store.recordUsageEntry(source, mismatch)).toBeNull()
    const warmedAlias = event('warming-alias', 350); warmedAlias.entry.model = 'model-dated-server-alias'
    expect(store.recordUsageEntry(source, warmedAlias)?.id).toBe('new')
    const wrongProvider = event('provider'); wrongProvider.entry.provider = 'other-provider'
    expect(store.recordUsageEntry(source, wrongProvider)).toBeNull()
    await store.flush()
  })

  it.each([null, {}, [null, {}, { key: 'broken', at: 'invalid' }]])('keeps valid runs when optional usage receipts are malformed (%j)', async (usageReceipts) => {
    const root = await mkdtemp(join(tmpdir(), 'pion-usage-')); roots.push(root)
    const file = join(root, 'runs.json')
    await writeFile(file, JSON.stringify({ version: 1, runs: [billedRun()], usageReceipts, usageReplayFloor: 'invalid' }))
    const store = new RunStore(file); await store.load()
    expect(store.get('run-1')?.state).toBe('completed')
    expect(store.recordUsageEntry(source, event('valid'))?.usage.costUsd).toBe(0.25)
    await store.flush()
  })

  it('keeps no-run usage outside the window and cannot adopt it on future dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-usage-')); roots.push(root)
    const store = new RunStore(join(root, 'runs.json')); await store.load()
    expect(store.recordUsageEntry(source, event('external'))).toBeNull()
    expect(store.list()).toEqual([])
    store.create(billedRun())
    expect(store.recordUsageEntry(source, event('external'))).toBeNull()
    expect(store.get('run-1')?.usage.costUsd).toBe(0)
    await store.flush()
  })

  it('persists a conservative replay floor instead of re-billing evicted FIFO receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-usage-')); roots.push(root)
    const file = join(root, 'runs.json')
    const store = new RunStore(file); await store.load(); store.create(billedRun())
    for (let i = 0; i <= MAX_USAGE_RECEIPTS; i++) store.recordUsageEntry(source, event(`entry-${i}`, 200 + i))
    await store.flush()
    const disk = JSON.parse(await readFile(file, 'utf8'))
    expect(disk.usageReceipts.length).toBeLessThanOrEqual(MAX_USAGE_RECEIPTS)
    const restored = new RunStore(file); await restored.load()
    expect(restored.recordUsageEntry(source, event('entry-0'))).toBeNull()
    expect(restored.recordUsageEntry(source, event('unseen-old'))).toBeNull()
    expect(restored.recordUsageEntry(source, event('entry-1', 201))).toBeNull()
    expect(restored.get('run-1')?.usage.costUsd).toBe((MAX_USAGE_RECEIPTS + 1) * 0.25)
    expect(restored.recordUsageEntry(source, event('fresh', 10000))?.usage.costUsd).toBe((MAX_USAGE_RECEIPTS + 2) * 0.25)
    await restored.flush()
  })
})

describe('RunStore', () => {
  it('persists updates atomically and filters by project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-runs-'))
    roots.push(root)
    const file = join(root, 'runs.json')
    const store = new RunStore(file)
    await store.load()
    store.create(operation())
    store.update('run-1', (run) => {
      run.state = 'completed'
      run.usage.total = 42
      run.contextUsagePending = true
    })
    await store.flush()

    const parsed = JSON.parse(await readFile(file, 'utf8')) as { runs: RunOperation[] }
    expect(parsed.runs[0]).toMatchObject({ id: 'run-1', state: 'completed' })
    expect(store.list({ cwd: '/tmp/project' })[0].usage.total).toBe(42)
    expect(store.list({ cwd: '/tmp/other' })).toEqual([])
    const restored = new RunStore(file)
    await restored.load()
    expect(restored.get('run-1')?.contextUsagePending).toBe(true)
    expect(restored.get('run-1')?.contextPressure).toBeUndefined()
  })

  it('filters queue-only metrics before limiting without changing recovery queries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-runs-'))
    roots.push(root)
    const store = new RunStore(join(root, 'runs.json'))
    await store.load()
    store.create(operation({ id: 'active', state: 'running', createdAt: 1, agentStartedAt: 1 }))
    store.create(operation({ id: 'finished', state: 'completed', createdAt: 2, agentStartedAt: 2 }))
    for (let n = 0; n < 30; n++) store.create(operation({ id: `queued-${n}`, state: 'queued', createdAt: 100 + n }))
    store.create(operation({ id: 'discarded', state: 'discarded', createdAt: 200 }))
    expect(store.list({ metricsOnly: true, limit: 1 }).map((run) => run.id)).toEqual(['active'])
    expect(store.list({ metricsOnly: true }).map((run) => run.id)).toEqual(['active', 'finished'])
    expect(store.list().some((run) => run.state === 'queued')).toBe(true)
    expect(store.list()[0].id).toBe('discarded')
    await store.flush()
  })

  it.each(['queued', 'dispatching', 'running', 'ending'] as const)(
    'detects an older %s run outside the latest 100 displayed session runs without mutating the ledger',
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), 'pion-runs-'))
      roots.push(root)
      const file = join(root, 'runs.json')
      const sessionPath = join(root, 'current.jsonl')
      const store = new RunStore(file)
      await store.load()
      const runs = [store.create(operation({ id: 'old-unsettled', sessionPath, state, createdAt: 1 }))]
      for (let n = 0; n < 101; n++) {
        runs.push(store.create(operation({
          id: `finished-${n}`, sessionPath, state: 'completed', createdAt: 100 + n
        })))
      }
      await store.flush()
      const persisted = await readFile(file, 'utf8')
      const changed = vi.fn()
      const unsubscribe = store.onChanged(changed)

      const displayed = store.list({ sessionPath, limit: 100 })
      expect(displayed).toHaveLength(100)
      expect(displayed.every((run) => run.state === 'completed')).toBe(true)
      expect(displayed.some((run) => run.id === 'old-unsettled')).toBe(false)
      expect(store.hasUnsettledSessionRuns(sessionPath)).toBe(true)
      expect(store.hasUnsettledSessionRuns(sessionPath)).toBe(true)
      expect(runs.map((run) => store.get(run.id))).toEqual(runs)
      expect(changed).not.toHaveBeenCalled()
      unsubscribe()
      await store.flush()
      expect(await readFile(file, 'utf8')).toBe(persisted)
    }
  )

  it('does not block terminal or missing sessions for unsettled runs belonging to another or no session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-runs-'))
    roots.push(root)
    const file = join(root, 'runs.json')
    const sessionPath = join(root, 'current.jsonl')
    const otherPath = join(root, 'other.jsonl')
    const store = new RunStore(file)
    await store.load()
    const runs = (['completed', 'aborted', 'failed', 'interrupted', 'discarded'] as const).map((state) =>
      store.create(operation({ id: `terminal-${state}`, sessionPath, state }))
    )
    for (const state of ['queued', 'dispatching', 'running', 'ending'] as const) {
      runs.push(store.create(operation({ id: `other-${state}`, sessionPath: otherPath, state })))
      runs.push(store.create(operation({ id: `unassigned-${state}`, state })))
    }
    await store.flush()
    const persisted = await readFile(file, 'utf8')
    const changed = vi.fn()
    const unsubscribe = store.onChanged(changed)

    expect(store.hasUnsettledSessionRuns(sessionPath)).toBe(false)
    expect(store.hasUnsettledSessionRuns(join(root, 'missing.jsonl'))).toBe(false)
    expect(store.hasUnsettledSessionRuns(otherPath)).toBe(true)
    expect(store.hasUnsettledSessionRuns(sessionPath)).toBe(false)
    expect(runs.map((run) => store.get(run.id))).toEqual(runs)
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
    await store.flush()
    expect(await readFile(file, 'utf8')).toBe(persisted)
  })

  it('marks uncertain active runs interrupted without replaying queued prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-runs-'))
    roots.push(root)
    const file = join(root, 'runs.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      runs: [
        operation({ id: 'active', state: 'running', tools: [{
          toolCallId: 'tool-1', name: 'bash', state: 'running', startedAt: Date.now() - 100
        }] }),
        operation({ id: 'queued', state: 'queued' })
      ]
    }))

    const store = new RunStore(file)
    await store.load()

    expect(store.get('active')).toMatchObject({ state: 'interrupted' })
    expect(store.get('active')?.tools[0].state).toBe('interrupted')
    expect(store.get('queued')).toMatchObject({ state: 'queued' })
  })
})
