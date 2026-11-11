import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubagentSessionStore } from '../../src/main/agent/subagent-session-store'
import {
  SUBAGENT_SESSION_WIDGET_KEY, SUBAGENT_SESSION_RETENTION_MS,
  SUBAGENT_SESSION_MAX_RECORDS, SUBAGENT_SESSION_MAX_ROWS, SUBAGENT_SESSION_MAX_CHARS,
  SUBAGENT_SESSION_MAX_PACKET_CHARS
} from '../../src/shared/subagent-sessions'
import type { SubagentSessionNotice } from '../../src/shared/subagent-sessions'

const stores: SubagentSessionStore[] = []
const scope = { backendId: 'backend-1', nonce: 'private-nonce', cwd: '/project', parentSessionPath: '/sessions/parent.jsonl' }
function packet(overrides: Partial<SubagentSessionNotice> = {}): SubagentSessionNotice {
  return { version: 1, nonce: scope.nonce, source: 'sdk:pion_subagents', runtimeId: 'runtime-1',
    id: 'child-1', parentToolCallId: 'root-tool-1', parentSessionId: 'sdk-parent',
    parentSessionPath: scope.parentSessionPath, cwd: scope.cwd, name: 'Worker', revision: 1,
    status: 'starting', truncated: false, rows: [{ id: 'row-1', kind: 'assistant', text: 'Hello' }], ...overrides }
}
function widget(notice: unknown = packet(), overrides: Record<string, unknown> = {}) {
  return { type: 'extension_ui_request', method: 'setWidget', widgetKey: SUBAGENT_SESSION_WIDGET_KEY,
    widgetLines: [JSON.stringify(notice)], ...overrides }
}
function fixture() {
  let clock = 100
  const changed = vi.fn(), receipt = {}, getReceipt = vi.fn((): object | undefined => receipt)
  const store = new SubagentSessionStore(changed, () => clock)
  stores.push(store)
  const publish = (changes: Partial<SubagentSessionNotice> = {}, owner: { backendId: string; nonce: string; cwd: string; parentSessionPath?: string } = scope) => store.consume(owner, widget(packet(changes)), getReceipt)
  return { store, changed, receipt, getReceipt, publish,
    setTime: (time: number) => { clock = time }, advance: (ms: number) => { clock += ms } }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  vi.useRealTimers()
})

describe('SubagentSessionStore first-packet display', () => {
  it('creates only from a starting packet with the real native root receipt, without a reservation', () => {
    const h = fixture()
    h.publish({ status: 'running' })
    h.publish({ status: 'completed' })
    expect(h.getReceipt).not.toHaveBeenCalled()
    h.getReceipt.mockReturnValue(undefined)
    h.publish()
    expect(h.store.list().sessions).toEqual([])
    h.getReceipt.mockReturnValue(h.receipt)
    h.publish()
    expect(h.getReceipt).toHaveBeenLastCalledWith('root-tool-1')
    expect(h.store.get('child-1', scope.backendId)?.status).toBe('starting')
    h.getReceipt.mockReturnValue(undefined) // Subsequent revisions keep the captured display identity.
    h.publish({ revision: 2, status: 'completed' })
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ revision: 2, status: 'completed' })
  })

  it('counts current records only, retains every unexpired child and fences expired IDs for the live root', () => {
    const h = fixture()
    for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) {
      h.publish({ id: `child-${i}` })
      if (i === 0) h.publish({ id: 'child-0', status: 'completed', revision: 2 })
    }
    h.getReceipt.mockClear()
    h.publish({ id: 'overflow' })
    expect(h.getReceipt).not.toHaveBeenCalled()
    expect(h.store.list().sessions).toHaveLength(SUBAGENT_SESSION_MAX_RECORDS)
    expect(h.store.get('child-0', scope.backendId)?.status).toBe('completed')
    h.advance(SUBAGENT_SESSION_RETENTION_MS)
    h.publish({ id: 'child-0', revision: 99 })
    expect(h.store.get('child-0', scope.backendId)).toBeNull()
    h.publish({ id: 'overflow' })
    expect(h.store.list().sessions).toHaveLength(SUBAGENT_SESSION_MAX_RECORDS)
    expect(SUBAGENT_SESSION_MAX_RECORDS).toBe(256)
  })

  it('binds one runtime per actual root object and reclaims expired sources without a lifetime gate', () => {
    const h = fixture()
    h.publish()
    h.publish({ runtimeId: 'spoofed', id: 'other' })
    expect(h.store.get('other', scope.backendId)).toBeNull()
    h.publish({ status: 'completed', revision: 2 })
    h.advance(SUBAGENT_SESSION_RETENTION_MS)
    h.publish({ revision: 99 })
    expect(h.store.list().sessions).toEqual([])
    for (let i = 0; i < 1100; i++) {
      h.getReceipt.mockReturnValue({}) // Each real root has its own object lifetime.
      h.publish({ id: `child-${i}`, parentToolCallId: `root-${i}` })
      h.publish({ id: `child-${i}`, parentToolCallId: `root-${i}`, status: 'completed', revision: 2 })
      h.advance(SUBAGENT_SESSION_RETENTION_MS)
    }
    h.getReceipt.mockReturnValue(undefined)
    h.publish({ revision: 99 })
    expect(h.store.list().sessions).toEqual([])
    h.getReceipt.mockReturnValue({})
    h.publish({ id: 'next', parentToolCallId: 'next-root', runtimeId: 'next-runtime' })
    expect(h.store.get('next', scope.backendId)?.status).toBe('starting')
  })

  it('stores an absent producer path even when main binds before the first packet', () => {
    const h = fixture()
    h.store.bindParent(scope.backendId, scope.parentSessionPath)
    h.publish({ parentSessionPath: undefined })
    expect(h.store.get('child-1', scope.backendId)?.parentSessionPath).toBe(scope.parentSessionPath)
    h.publish({ parentSessionPath: scope.parentSessionPath, revision: 2, status: 'running' })
    expect(h.store.get('child-1', scope.backendId)?.revision).toBe(1)
    h.publish({ parentSessionPath: undefined, revision: 2, status: 'completed' })
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ revision: 2, status: 'completed' })
  })
})

describe('SubagentSessionStore memory-only display projection', () => {
  it('returns independent summaries and rows without producer internals', () => {
    const h = fixture()
    h.publish()
    const list = h.store.list()
    expect(list.sessions[0]).not.toHaveProperty('rows')
    for (const field of ['sourcePath', 'packetRevision', 'deadline', 'nonce']) {
      expect(list.sessions[0]).not.toHaveProperty(field)
      expect(h.store.get('child-1', scope.backendId)).not.toHaveProperty(field)
    }
    list.sessions[0].name = 'mutated'
    h.store.get('child-1', scope.backendId)!.rows[0].text = 'mutated'
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ name: 'Worker', rows: [{ text: 'Hello' }] })
    expect(h.store.get('child-1', 'other-backend')).toBeNull()
  })

  it.each([
    { method: 'other' }, { type: 'wrong' }, { widgetLines: [] }, { widgetLines: ['{broken'] },
    { widgetLines: ['{}', '{}'] }, { widgetLines: ['x'.repeat(SUBAGENT_SESSION_MAX_PACKET_CHARS + 1)] },
    { parentToolCallId: 'nested' }, { parentToolCallId: '' }, { parentToolCallId: null }
  ])('swallows malformed/nested private widgets (%j)', (overrides) => {
    const h = fixture()
    expect(h.store.consume(scope, widget(packet(), overrides), h.getReceipt)).toBe(true)
    expect(h.store.list().sessions).toEqual([])
    expect(h.getReceipt).not.toHaveBeenCalled()
    expect(h.store.consume(scope, { widgetKey: 'ordinary' }, h.getReceipt)).toBe(false)
  })

  it.each([
    { nonce: 'wrong' }, { source: 'plugin' }, { cwd: '/other' }, { parentSessionPath: '/other' },
    { revision: 0 }, { revision: 1.5 }, { status: 'unknown' }, { id: '' }, { id: 'x'.repeat(257) },
    { name: 'x'.repeat(257) }, { version: 2 }, { usage: { cost: 1 } }, { images: [] },
    { rows: [{ id: 'a', kind: 'image', text: '' }] },
    { rows: [{ id: 'a', kind: 'tool', text: '', images: [] }] },
    { rows: [{ id: 'a', kind: 'tool', text: '', state: 'unknown' }] },
    { rows: [{ id: 'a', kind: 'assistant', text: '' }, { id: 'a', kind: 'thinking', text: '' }] },
    { rows: Array.from({ length: SUBAGENT_SESSION_MAX_ROWS + 1 }, (_, i) => ({ id: String(i), kind: 'assistant', text: '' })) },
    { rows: [{ id: 'a', kind: 'assistant', text: 'x'.repeat(SUBAGENT_SESSION_MAX_CHARS) }] }
  ])('rejects non-whitelisted or oversized snapshots (%j)', (overrides) => {
    const h = fixture()
    h.store.consume(scope, widget({ ...packet(), ...overrides }), h.getReceipt)
    expect(h.store.list().sessions).toEqual([])
    expect(h.getReceipt).not.toHaveBeenCalled()
  })

  it('updates only increasing packet revisions with the original identity tuple', () => {
    const h = fixture()
    h.publish()
    h.publish({ revision: 2, status: 'running', rows: [{ id: 'r2', kind: 'tool', text: 'Done', toolName: 'read', state: 'completed' }] })
    for (const change of [{ revision: 1 }, { revision: 2 }, { revision: 3, parentToolCallId: 'other' },
      { revision: 3, parentSessionId: 'other' }, { revision: 3, runtimeId: 'other' }, { revision: 3, name: 'other' }]) h.publish(change)
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ revision: 2, rows: [{ text: 'Done' }] })
    h.publish({ revision: 50, status: 'running' })
    h.publish({ revision: 49, status: 'completed' })
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ revision: 3, status: 'running' })
    expect(h.getReceipt).toHaveBeenCalledOnce()
  })

  it('freezes the first terminal snapshot and never renews monotonic retention on reads or repeats', () => {
    const h = fixture()
    h.publish()
    h.publish({ status: 'completed', revision: 2 })
    h.advance(1000)
    h.publish({ status: 'failed', revision: 3 })
    h.setTime(50)
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ status: 'completed', revision: 2, retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    const before = h.store.list().revision
    h.setTime(100 + SUBAGENT_SESSION_RETENTION_MS)
    expect(h.store.list()).toEqual({ revision: before + 1, sessions: [] })
    h.publish({ revision: 99 })
    expect(h.store.list().sessions).toEqual([])
    expect(h.changed).toHaveBeenCalledTimes(3)
  })

  it('expires automatically and disposes the only timer', () => {
    vi.useFakeTimers()
    const h = fixture()
    expect(vi.getTimerCount()).toBe(1)
    h.publish()
    h.publish({ status: 'failed', revision: 2 })
    h.advance(SUBAGENT_SESSION_RETENTION_MS)
    vi.advanceTimersByTime(1000)
    expect(h.changed).toHaveBeenCalledTimes(3)
    expect(h.store.list().sessions).toEqual([])
    h.store.dispose()
    expect(vi.getTimerCount()).toBe(0)
    h.publish()
    expect(h.store.list().sessions).toEqual([])
  })

  it('keeps nonce/cwd/backend fences independent for identical child IDs', () => {
    const h = fixture()
    h.publish()
    h.store.consume({ ...scope, nonce: 'replacement' }, widget(packet({ nonce: 'replacement', revision: 2 })), h.getReceipt)
    h.publish({ cwd: '/other', revision: 2 }, { ...scope, cwd: '/other' })
    expect(h.store.get('child-1', scope.backendId)?.revision).toBe(1)
    h.publish({ rows: [{ id: 'row-1', kind: 'thinking', text: 'Other owner' }] }, { ...scope, backendId: 'backend-2' })
    expect(h.store.get('child-1', 'backend-2')?.rows[0].text).toBe('Other owner')
    expect(h.store.get('child-1', scope.backendId)?.rows[0].text).toBe('Hello')
  })

  it('binds compatible display paths once while retaining the immutable source identity and terminal deadline', () => {
    const h = fixture(), unbound = { ...scope, parentSessionPath: undefined }
    h.publish({ parentSessionPath: undefined }, unbound)
    h.store.bindParent(scope.backendId, scope.parentSessionPath)
    h.store.bindParent(scope.backendId, '/different')
    h.publish({ parentSessionPath: scope.parentSessionPath, revision: 2 })
    expect(h.store.get('child-1', scope.backendId)?.revision).toBe(2)
    h.publish({ parentSessionPath: undefined, revision: 2, status: 'completed' })
    h.advance(1000)
    h.store.bindParent(scope.backendId, scope.parentSessionPath)
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ revision: 3, status: 'completed', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    const other = fixture()
    other.publish({ parentSessionPath: '/sdk/provisional' }, unbound)
    other.store.bindParent(scope.backendId, scope.parentSessionPath)
    expect(other.store.get('child-1', scope.backendId)?.parentSessionPath).toBe('/sdk/provisional')
  })

  it('retires only the captured runtime, keeps unknown exits nonterminal and preserves completed TTL', () => {
    const h = fixture()
    h.publish()
    h.getReceipt.mockReturnValue({})
    h.publish({ id: 'child-2', runtimeId: 'runtime-2', parentToolCallId: 'root-2' })
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ status: 'cancelling', revision: 2 })
    h.store.markRuntimeGone(scope.backendId, 'runtime-1', false)
    h.advance(SUBAGENT_SESSION_RETENTION_MS * 2)
    expect(h.store.get('child-1', scope.backendId)?.retentionRemainingMs).toBeUndefined()
    h.store.markRuntimeGone(scope.backendId, 'runtime-1', true)
    h.advance(1000)
    h.store.markRuntimeGone(scope.backendId, 'runtime-1', true)
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ status: 'aborted', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    expect(h.store.get('child-2', scope.backendId)?.status).toBe('starting')
    h.publish({ id: 'child-2', runtimeId: 'runtime-2', parentToolCallId: 'root-2', status: 'completed', revision: 2 })
    h.store.markBackendGone(scope.backendId, false)
    h.store.markBackendGone(scope.backendId, true)
    expect(h.store.get('child-2', scope.backendId)?.status).toBe('completed')
    h.publish({ id: 'too-late', runtimeId: 'runtime-2', parentToolCallId: 'root-2' })
    expect(h.store.get('too-late', scope.backendId)).toBeNull()
  })

  it('increments cancellation/exit display revisions once and retains unknown-exit records', () => {
    const h = fixture()
    h.publish({ revision: 100 })
    const before = h.store.get('child-1', scope.backendId)!
    h.store.markBackendGone(scope.backendId, false)
    h.store.markBackendGone(scope.backendId, false)
    h.advance(SUBAGENT_SESSION_RETENTION_MS * 2)
    h.publish({ revision: 101, status: 'completed' })
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ status: 'cancelling', revision: 2 })
    expect(h.store.get('child-1', scope.backendId)?.retentionRemainingMs).toBeUndefined()
    h.store.markBackendGone(scope.backendId, true)
    h.advance(1000)
    h.store.markBackendGone(scope.backendId, true)
    expect(h.store.get('child-1', scope.backendId)).toMatchObject({ status: 'aborted', revision: 3, retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    expect(before.status).toBe('starting')
  })
})
