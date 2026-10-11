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
    status: 'running', truncated: false, rows: [{ id: 'row-1', kind: 'assistant', text: 'Hello' }], ...overrides }
}
function widget(notice: unknown = packet(), overrides: Record<string, unknown> = {}) {
  return { type: 'extension_ui_request', method: 'setWidget', widgetKey: SUBAGENT_SESSION_WIDGET_KEY,
    widgetLines: [JSON.stringify(notice)], ...overrides }
}
function reserve(store: SubagentSessionStore, owner: { backendId: string; nonce: string; cwd: string; parentSessionPath?: string } = scope,
  notice: Partial<SubagentSessionNotice> = {}, count = 1,
  allow: (parentCallId: string) => boolean = () => true) {
  const value = packet(notice)
  return store.reserveBatch(owner, { version: 1, nonce: owner.nonce, runtimeId: value.runtimeId,
    parentToolCallId: value.parentToolCallId, count }, allow)
}
function fixture(admit = true) {
  let clock = 100
  const changed = vi.fn()
  const store = new SubagentSessionStore(changed, () => clock)
  stores.push(store)
  // Explicit display admission precedes every ordinary fixture's first starting notice.
  if (admit) expect(reserve(store)).toBe(true)
  return { store, changed, setTime: (time: number) => { clock = time }, advance: (ms: number) => { clock += ms } }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  vi.useRealTimers()
})

describe('SubagentSessionStore batch display admission', () => {
  it('needs a native callback at admission AND first creation, never infers quota from a notice', () => {
    const { store } = fixture(false)
    const allow = vi.fn(() => false)
    store.consume(scope, widget(), allow)
    expect(allow).not.toHaveBeenCalled()
    expect(reserve(store, scope, {}, 1, allow)).toBe(false)
    expect(allow).toHaveBeenCalledExactlyOnceWith('root-tool-1')
    allow.mockReturnValue(true)
    expect(reserve(store, scope, {}, 1, allow)).toBe(true)
    allow.mockReturnValue(false)
    store.consume(scope, widget(), allow)
    expect(store.list().sessions).toEqual([])
    allow.mockReturnValue(true)
    store.consume(scope, widget(), allow)
    expect(store.get('child-1', scope.backendId)).not.toBeNull()
    expect(allow).toHaveBeenCalledTimes(4)
  })

  it.each([
    { version: 2 }, { nonce: 'wrong' }, { runtimeId: '' }, { parentToolCallId: '' },
    { runtimeId: 'x'.repeat(257) }, { parentToolCallId: 'x'.repeat(257) },
    { count: 0 }, { count: 9 }, { count: 1.5 }, { count: NaN }, { extra: true }
  ])('rejects invalid admission before calling the native probe (%j)', (change) => {
    const { store } = fixture(false)
    const allow = vi.fn(() => true)
    const request = { version: 1, nonce: scope.nonce, runtimeId: 'runtime-1', parentToolCallId: 'root-tool-1', count: 1, ...change }
    expect(store.reserveBatch(scope, request as Parameters<SubagentSessionStore['reserveBatch']>[1], allow)).toBe(false)
    expect(allow).not.toHaveBeenCalled()
    expect(reserve(store)).toBe(true)
  })

  it('rejects duplicates before and after release and rejects stable-owner identity changes', () => {
    const { store } = fixture(false)
    expect(reserve(store, scope, {}, 8)).toBe(true)
    const allow = vi.fn(() => true)
    expect(reserve(store, scope, {}, 8, allow)).toBe(false)
    store.releaseBatch(scope.backendId, 'root-tool-1')
    expect(reserve(store, scope, {}, 1, allow)).toBe(false)
    for (const owner of [{ ...scope, nonce: 'different' }, { ...scope, cwd: '/other' },
      { ...scope, parentSessionPath: '/other' }, { ...scope, parentSessionPath: undefined }]) {
      expect(reserve(store, owner, { parentToolCallId: 'next-root' }, 1, allow)).toBe(false)
    }
    expect(allow).not.toHaveBeenCalled()
    expect(reserve(store, scope, { parentToolCallId: 'next-root' })).toBe(true)
  })

  it('atomically reserves all 256 slots across competing backends and observes every accepted child start', () => {
    const { store } = fixture(false)
    for (let batch = 0; batch < 32; batch++) {
      expect(reserve(store, { ...scope, backendId: `owner-${batch}` }, { parentToolCallId: `root-${batch}` }, 8)).toBe(true)
    }
    expect(store.list().sessions).toEqual([]) // Pending slots count even without a single notice.
    const allow = vi.fn(() => true)
    expect(reserve(store, { ...scope, backendId: 'overflow' }, {}, 1, allow)).toBe(false)
    expect(reserve(store, { ...scope, backendId: 'owner-0' }, { parentToolCallId: 'overflow' }, 1, allow)).toBe(false)
    expect(allow).not.toHaveBeenCalled()
    for (let batch = 0; batch < 32; batch++) {
      for (let child = 0; child < 8; child++) {
        const owner = { ...scope, backendId: `owner-${batch}` }
        const id = `child-${child}`
        store.consume(owner, widget(packet({ id, parentToolCallId: `root-${batch}`, status: 'starting' })), () => true)
        expect(store.get(id, owner.backendId)?.status).toBe('starting')
      }
    }
    expect(store.list().sessions).toHaveLength(SUBAGENT_SESSION_MAX_RECORDS)
    store.consume({ ...scope, backendId: 'owner-0' }, widget(packet({ id: 'ninth', parentToolCallId: 'root-0' })), allow)
    expect(store.get('ninth', 'owner-0')).toBeNull()
    expect(allow).not.toHaveBeenCalled()
  })

  it('does not overbook a partly used batch, releases only unused slots at parent tool_end, and keeps original TTL', () => {
    const { store, advance } = fixture(false)
    expect(reserve(store, scope, {}, 8)).toBe(true)
    store.consume(scope, widget(packet({ status: 'completed' })), () => true)
    for (let batch = 1; batch < 32; batch++) {
      expect(reserve(store, scope, { parentToolCallId: `root-${batch}` }, 8)).toBe(true)
    }
    expect(reserve(store, scope, { parentToolCallId: 'extra' })).toBe(false)
    advance(1000)
    store.get('child-1', scope.backendId)
    store.list()
    store.releaseBatch('wrong-owner', 'root-tool-1')
    store.releaseBatch(scope.backendId, 'wrong-call')
    expect(reserve(store, scope, { parentToolCallId: 'extra' })).toBe(false)
    store.releaseBatch(scope.backendId, 'root-tool-1')
    expect(reserve(store, scope, { parentToolCallId: 'extra' }, 8)).toBe(false)
    expect(reserve(store, scope, { parentToolCallId: 'extra' }, 7)).toBe(true)
    expect(reserve(store, scope, { parentToolCallId: 'extra-2' })).toBe(false)
    store.consume(scope, widget(packet({ id: 'late-unconsumed' })), () => true)
    expect(store.get('late-unconsumed', scope.backendId)).toBeNull()
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'completed', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    advance(SUBAGENT_SESSION_RETENTION_MS - 1000)
    expect(store.get('child-1', scope.backendId)).toBeNull()
    expect(reserve(store, scope, { parentToolCallId: 'extra-2' })).toBe(true)
  })

  it('does not consume slots on malformed, mismatched or native-denied creation', () => {
    const { store } = fixture()
    const allow = vi.fn(() => true)
    for (const change of [{ nonce: 'wrong' }, { runtimeId: 'different' }, { parentToolCallId: 'different' },
      { cwd: '/other' }, { parentSessionPath: '/other' }, { revision: 0 }]) {
      store.consume(scope, widget(packet({ id: 'invalid', ...change })), allow)
    }
    expect(allow).not.toHaveBeenCalled()
    store.consume(scope, widget(), () => false)
    expect(store.list().sessions).toEqual([])
    store.consume(scope, widget(packet({ status: 'starting' })), allow)
    expect(store.get('child-1', scope.backendId)?.status).toBe('starting')
    store.consume(scope, widget(packet({ id: 'extra' })), allow)
    expect(store.get('extra', scope.backendId)).toBeNull()
    expect(allow).toHaveBeenCalledExactlyOnceWith('root-tool-1')
  })

  it('updates receipted records after remaining reaches zero or the batch is released', () => {
    const { store } = fixture()
    store.consume(scope, widget(), () => true)
    store.releaseBatch(scope.backendId, 'root-tool-1')
    const deny = vi.fn(() => false)
    store.consume(scope, widget(packet({ revision: 2, status: 'completed' })), deny)
    expect(deny).not.toHaveBeenCalled()
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 2, status: 'completed' })
  })

  it.each([false, true])('releases unused allocations on backend gone (%s), never accepts late notices', (confirmed) => {
    const { store } = fixture(false)
    expect(reserve(store, scope, {}, 8)).toBe(true)
    store.consume(scope, widget(), () => true)
    for (let batch = 1; batch < 32; batch++) {
      expect(reserve(store, { ...scope, backendId: 'other' }, { parentToolCallId: `root-${batch}` }, 8)).toBe(true)
    }
    store.markBackendGone(scope.backendId, confirmed)
    const allow = vi.fn(() => true)
    expect(reserve(store, scope, { parentToolCallId: 'late' }, 1, allow)).toBe(false)
    store.consume(scope, widget(packet({ id: 'late' })), allow)
    expect(allow).not.toHaveBeenCalled()
    expect(reserve(store, { ...scope, backendId: 'other' }, { parentToolCallId: 'extra' }, 7)).toBe(true)
    expect(reserve(store, { ...scope, backendId: 'other' }, { parentToolCallId: 'over' })).toBe(false)
    expect(store.list().sessions).toHaveLength(1)
  })

  it('replaces runtime only with native proof, releases old allocations and fences late old notices', () => {
    const { store } = fixture(false)
    expect(reserve(store, scope, {}, 8)).toBe(true)
    store.consume(scope, widget(), () => true)
    for (let batch = 1; batch < 32; batch++) {
      expect(reserve(store, { ...scope, backendId: 'other' }, { parentToolCallId: `root-${batch}` }, 8)).toBe(true)
    }
    const next = { runtimeId: 'runtime-2', parentToolCallId: 'new-root' }
    expect(reserve(store, scope, next, 8)).toBe(false) // Existing record still occupies a slot.
    expect(reserve(store, scope, next, 7, () => false)).toBe(false)
    store.consume(scope, widget(packet({ id: 'old-2' })), () => true)
    expect(store.get('old-2', scope.backendId)).not.toBeNull() // Failed replacement did not release slots.
    expect(reserve(store, scope, next, 6)).toBe(true)
    expect(reserve(store, scope, { parentToolCallId: 'old-again' })).toBe(false)
    store.consume(scope, widget(packet({ id: 'old-3' })), () => true)
    expect(store.get('old-3', scope.backendId)).toBeNull()
    store.consume(scope, widget(packet({ id: 'new-1', ...next })), () => true)
    expect(store.get('new-1', scope.backendId)).not.toBeNull()
    expect(reserve(store, scope, { parentToolCallId: 'old-again-2' })).toBe(false)
  })

  it('keeps an early reserved starting notice when main binds the parent before its arrival', () => {
    const { store } = fixture(false)
    expect(reserve(store, { ...scope, parentSessionPath: undefined })).toBe(true)
    store.bindParent(scope.backendId, scope.parentSessionPath)
    store.consume(scope, widget(packet({ status: 'starting', parentSessionPath: undefined })), () => true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'starting', parentSessionPath: scope.parentSessionPath })
    store.consume(scope, widget(packet({ revision: 2, parentSessionPath: undefined })), () => true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'running', revision: 2 })
  })

  it('bounds released batch receipts without reopening a duplicate admission', () => {
    const { store } = fixture(false)
    for (let i = 0; i < 1024; i++) {
      const parentToolCallId = `root-${i}`
      expect(reserve(store, scope, { parentToolCallId })).toBe(true)
      store.releaseBatch(scope.backendId, parentToolCallId)
    }
    const allow = vi.fn(() => true)
    expect(reserve(store, scope, { parentToolCallId: 'root-0' }, 1, allow)).toBe(false)
    expect(reserve(store, scope, { parentToolCallId: 'overflow' }, 1, allow)).toBe(false)
    expect(allow).not.toHaveBeenCalled()
    expect(store.list().sessions).toEqual([])
  })

  it('bounds retired runtime fences and never allows their notices to consume new slots', () => {
    const { store } = fixture(false)
    for (let i = 0; i <= 32; i++) {
      expect(reserve(store, scope, { runtimeId: `runtime-${i}`, parentToolCallId: `root-${i}` })).toBe(true)
      store.releaseBatch(scope.backendId, `root-${i}`)
    }
    const allow = vi.fn(() => true)
    expect(reserve(store, scope, { runtimeId: 'runtime-33', parentToolCallId: 'overflow' }, 1, allow)).toBe(false)
    expect(reserve(store, scope, { runtimeId: 'runtime-0', parentToolCallId: 'late' }, 1, allow)).toBe(false)
    store.consume(scope, widget(packet({ runtimeId: 'runtime-0', parentToolCallId: 'root-0' })), allow)
    expect(allow).not.toHaveBeenCalled()
    expect(reserve(store, scope, { runtimeId: 'runtime-32', parentToolCallId: 'still-current' })).toBe(true)
  })

  it('clears pending admissions on disposal and cannot admit again', () => {
    const { store } = fixture()
    store.dispose()
    expect(reserve(store, scope, { parentToolCallId: 'next' })).toBe(false)
    store.releaseBatch(scope.backendId, 'root-tool-1')
    store.consume(scope, widget(), () => true)
    expect(store.list().sessions).toEqual([])
  })
})

describe('SubagentSessionStore memory-only display projection', () => {
  it('requires native start receipt for creation and returns independent summaries/rows', () => {
    const { store } = fixture()
    const allow = vi.fn(() => false)
    expect(store.consume(scope, widget(), allow)).toBe(true)
    expect(store.list().sessions).toEqual([])
    allow.mockReturnValue(true)
    store.consume(scope, widget(), allow)
    expect(allow).toHaveBeenLastCalledWith('root-tool-1')
    const list = store.list()
    expect(list.sessions[0]).not.toHaveProperty('rows')
    for (const field of ['sourcePath', 'packetRevision', 'deadline', 'nonce']) {
      expect(list.sessions[0]).not.toHaveProperty(field)
      expect(store.get('child-1', scope.backendId)).not.toHaveProperty(field)
    }
    list.sessions[0].name = 'mutated'
    const snapshot = store.get('child-1', scope.backendId)!
    snapshot.rows[0].text = 'mutated'
    expect(store.get('child-1', scope.backendId)).toMatchObject({ name: 'Worker', rows: [{ text: 'Hello' }] })
    expect(store.get('child-1', 'other-backend')).toBeNull()
    expect(store.get('other-child', scope.backendId)).toBeNull()
  })

  it.each([
    { method: 'other' }, { type: 'wrong' }, { widgetLines: [] }, { widgetLines: ['{broken'] },
    { widgetLines: ['{}', '{}'] }, { widgetLines: ['x'.repeat(SUBAGENT_SESSION_MAX_PACKET_CHARS + 1)] },
    { parentToolCallId: 'nested' }, { parentToolCallId: '' }, { parentToolCallId: null }
  ])('swallows reserved malformed/nested widgets without display fallback (%j)', (overrides) => {
    const { store } = fixture()
    const allow = vi.fn(() => true)
    expect(store.consume(scope, widget(packet(), overrides), allow)).toBe(true)
    expect(store.list().sessions).toEqual([])
    expect(allow).not.toHaveBeenCalled()
    expect(store.consume(scope, { type: 'extension_ui_request', widgetKey: 'ordinary' }, allow)).toBe(false)
  })

  it.each([
    { nonce: 'wrong' }, { source: 'plugin' }, { cwd: '/other' }, { parentSessionPath: '/other' },
    { parentSessionPath: undefined }, { revision: 0 }, { revision: 1.5 }, { status: 'unknown' },
    { id: '' }, { id: 'x'.repeat(257) }, { name: 'x'.repeat(257) }, { version: 2 },
    { rows: [{ id: 'a', kind: 'image', text: '' }] },
    { rows: [{ id: 'a', kind: 'tool', text: '', images: [] }] },
    { rows: [{ id: 'a', kind: 'tool', text: '', state: 'unknown' }] },
    { rows: [{ id: 'a', kind: 'assistant', text: '' }, { id: 'a', kind: 'thinking', text: '' }] },
    { rows: Array.from({ length: SUBAGENT_SESSION_MAX_ROWS + 1 }, (_, i) => ({ id: String(i), kind: 'assistant', text: '' })) },
    { rows: [{ id: 'a', kind: 'assistant', text: 'x'.repeat(SUBAGENT_SESSION_MAX_CHARS) }] },
    { usage: { cost: 1 } }, { images: [] }
  ])('rejects invalid or non-whitelisted snapshots (%j)', (overrides) => {
    const { store } = fixture()
    store.consume(scope, widget({ ...packet(), ...overrides }), () => true)
    expect(store.list().sessions).toEqual([])
  })

  it('updates only strictly increasing revisions with the original identity tuple', () => {
    const { store } = fixture()
    store.consume(scope, widget(), () => true)
    const deny = vi.fn(() => false)
    store.consume(scope, widget(packet({ revision: 2, rows: [{ id: 'r2', kind: 'tool', text: 'Done', toolName: 'read', state: 'completed' }] })), deny)
    expect(deny).not.toHaveBeenCalled()
    for (const change of [{ revision: 1 }, { revision: 2 }, { revision: 3, parentToolCallId: 'other' },
      { revision: 3, parentSessionId: 'other' }, { revision: 3, runtimeId: 'other' }, { revision: 3, name: 'other' }]) {
      store.consume(scope, widget(packet(change)), () => true)
    }
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 2, rows: [{ text: 'Done' }] })
    store.consume(scope, widget(packet({ revision: 50 })), deny)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(3) // Display revision is not packet revision.
    store.consume(scope, widget(packet({ revision: 49, status: 'completed' })), deny)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 3, status: 'running' })
  })

  it('freezes first terminal snapshot; reads and repeated final packets never renew monotonic retention', () => {
    const { store, setTime, advance, changed } = fixture()
    store.consume(scope, widget(packet({ status: 'completed' })), () => true)
    expect(store.get('child-1', scope.backendId)?.retentionRemainingMs).toBe(SUBAGENT_SESSION_RETENTION_MS)
    advance(1000)
    store.consume(scope, widget(packet({ status: 'failed', revision: 2 })), () => true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'completed', revision: 1, retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    setTime(50) // A backwards clock cannot resurrect a deadline or increase remaining time.
    expect(store.list().sessions[0].retentionRemainingMs).toBe(SUBAGENT_SESSION_RETENTION_MS - 1000)
    const before = store.list().revision
    setTime(100 + SUBAGENT_SESSION_RETENTION_MS)
    expect(store.get('child-1', scope.backendId)).toBeNull()
    expect(store.list()).toEqual({ revision: before + 1, sessions: [] })
    expect(changed).toHaveBeenCalledTimes(2)
    store.consume(scope, widget(packet({ revision: 99 })), () => true)
    expect(store.list().sessions).toEqual([])
  })

  it('cleans expired sessions automatically and disposal removes the only timer', () => {
    vi.useFakeTimers()
    const { store, advance, changed } = fixture()
    expect(vi.getTimerCount()).toBe(1)
    store.consume(scope, widget(packet({ status: 'failed' })), () => true)
    advance(SUBAGENT_SESSION_RETENTION_MS)
    vi.advanceTimersByTime(1000)
    expect(changed).toHaveBeenCalledTimes(2) // No read API was necessary to expire.
    expect(store.list().sessions).toEqual([])
    store.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(store.consume(scope, widget(), () => true)).toBe(true)
    expect(store.list().sessions).toEqual([])
  })

  it('unknown backend exit cancels without TTL; confirmed exit aborts once and rejects all stale packets', () => {
    const { store, advance } = fixture()
    store.consume(scope, widget(), () => true)
    store.markBackendGone(scope.backendId, false)
    advance(SUBAGENT_SESSION_RETENTION_MS * 2)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'cancelling' })
    expect(store.get('child-1', scope.backendId)).not.toHaveProperty('retentionRemainingMs')
    store.consume(scope, widget(packet({ revision: 2, status: 'completed' })), () => true)
    store.consume(scope, widget(packet({ id: 'late-new-id' })), () => true)
    expect(store.list().sessions).toHaveLength(1)
    store.markBackendGone(scope.backendId, true)
    advance(1000)
    store.markBackendGone(scope.backendId, true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'aborted', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
  })

  it('keeps backend nonce and owner fences independent even for identical child IDs', () => {
    const { store } = fixture()
    store.consume(scope, widget(), () => true)
    store.consume({ ...scope, nonce: 'replacement-nonce' }, widget(packet({ nonce: 'replacement-nonce', revision: 2 })), () => true)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(1)
    expect(reserve(store, { ...scope, backendId: 'backend-2' })).toBe(true)
    store.consume({ ...scope, backendId: 'backend-2' }, widget(packet({ rows: [{ id: 'row-1', kind: 'thinking', text: 'Other owner' }] })), () => true)
    expect(store.get('child-1', 'backend-2')?.rows[0].text).toBe('Other owner')
    expect(store.get('child-1', scope.backendId)?.rows[0].text).toBe('Hello')
  })

  it('confirmed backend exit does not change or prolong already completed children', () => {
    const { store, advance } = fixture()
    store.consume(scope, widget(packet({ status: 'completed' })), () => true)
    advance(1000)
    store.markBackendGone(scope.backendId, true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'completed', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
  })

  it('fences gone backends even before any child is created', () => {
    const { store } = fixture()
    store.markBackendGone(scope.backendId, true)
    store.consume(scope, widget(), () => true)
    expect(store.list().sessions).toEqual([])
  })

  it('binds only compatible real parent paths without changing a nonempty source identity', () => {
    const { store } = fixture(false)
    const unbound = { backendId: scope.backendId, nonce: scope.nonce, cwd: scope.cwd }
    expect(reserve(store, unbound)).toBe(true)
    store.consume(unbound, widget(packet({ parentSessionPath: '/sdk/provisional' })), () => true)
    store.bindParent('other-backend', '/wrong')
    store.bindParent(scope.backendId, scope.parentSessionPath) // Nonempty producer identity cannot be rebound.
    expect(store.get('child-1', scope.backendId)).toMatchObject({ parentSessionPath: '/sdk/provisional', revision: 1 })
    store.consume(scope, widget(packet({ revision: 2 })), () => true)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(1)
    store.bindParent(scope.backendId, '/sdk/provisional')
    store.consume(unbound, widget(packet({ parentSessionPath: '/sdk/provisional', revision: 2 })), () => true)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(2)
    store.bindParent(scope.backendId, '/cannot-rebind')
    expect(store.get('child-1', scope.backendId)?.parentSessionPath).toBe('/sdk/provisional')
    store.bindParent('early-backend', scope.parentSessionPath)
    expect(reserve(store, { ...scope, backendId: 'early-backend' })).toBe(true)
    store.consume({ ...scope, backendId: 'early-backend', parentSessionPath: undefined }, widget(packet({ parentSessionPath: '/wrong', id: 'early' })), () => true)
    expect(store.get('early', 'early-backend')).toBeNull()
    store.consume({ ...scope, backendId: 'early-backend' }, widget(packet({ id: 'early' })), () => true)
    expect(store.get('early', 'early-backend')?.parentSessionPath).toBe(scope.parentSessionPath)
  })

  it('accepts originally absent paths after binding through updates and terminal TTL, without weakening identity', () => {
    const { store, advance } = fixture(false)
    const unbound = { ...scope, parentSessionPath: undefined }
    expect(reserve(store, unbound)).toBe(true)
    const producer = (changes: Partial<SubagentSessionNotice> = {}) => packet({ parentSessionPath: undefined, ...changes })
    store.consume(unbound, widget(producer()), () => true)
    const oldGet = store.get('child-1', scope.backendId)!
    const oldListRevision = store.list().revision
    store.bindParent(scope.backendId, scope.parentSessionPath)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ parentSessionPath: scope.parentSessionPath, revision: oldGet.revision + 1 })
    expect(store.list().revision).toBe(oldListRevision + 1)
    for (const change of [{ parentSessionPath: scope.parentSessionPath }, { parentSessionPath: '/different' },
      { parentSessionId: 'different' }, { runtimeId: 'different' }, { parentToolCallId: 'different' }]) {
      store.consume(scope, widget(producer({ revision: 2, ...change })), () => true)
    }
    expect(store.get('child-1', scope.backendId)?.revision).toBe(2)
    store.consume(scope, widget(producer({ id: 'new-unbound-child' })), () => true)
    expect(store.get('new-unbound-child', scope.backendId)).toBeNull()
    store.consume(scope, widget(producer({ revision: 2, rows: [{ id: 'r2', kind: 'assistant', text: 'Update' }] })), () => false)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 3, parentSessionPath: scope.parentSessionPath, rows: [{ text: 'Update' }] })
    store.consume(scope, widget(producer({ revision: 2, status: 'completed' })), () => false)
    expect(store.get('child-1', scope.backendId)?.status).toBe('running')
    store.consume(scope, widget(producer({ revision: 3, status: 'completed' })), () => false)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 4, status: 'completed', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS })
    advance(1000)
    store.bindParent(scope.backendId, scope.parentSessionPath)
    store.markBackendGone(scope.backendId, true)
    store.consume(scope, widget(producer({ revision: 4, status: 'completed' })), () => true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 4, retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    advance(SUBAGENT_SESSION_RETENTION_MS - 1000)
    expect(store.get('child-1', scope.backendId)).toBeNull()
  })

  it('increments display revision for each changed cancellation and confirmed exit, not repeated notifications', () => {
    const { store, advance } = fixture()
    store.consume(scope, widget(packet({ revision: 100 })), () => true)
    const oldGet = store.get('child-1', scope.backendId)!
    expect(oldGet.revision).toBe(1)
    store.markBackendGone(scope.backendId, false)
    expect(store.list().sessions[0]).toMatchObject({ status: 'cancelling', revision: oldGet.revision + 1 })
    store.markBackendGone(scope.backendId, false)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(2)
    const cancellingGet = store.get('child-1', scope.backendId)!
    store.markBackendGone(scope.backendId, true)
    expect(store.list().sessions[0]).toMatchObject({ status: 'aborted', revision: cancellingGet.revision + 1 })
    advance(1000)
    store.markBackendGone(scope.backendId, true)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 3, retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    expect(oldGet.status).toBe('running')
    expect(cancellingGet.status).toBe('cancelling')
  })

  it('increments a completed child display revision on first late binding without renewing its deadline', () => {
    const { store, advance } = fixture(false)
    expect(reserve(store, { ...scope, parentSessionPath: undefined })).toBe(true)
    store.consume({ ...scope, parentSessionPath: undefined }, widget(packet({ parentSessionPath: undefined, status: 'completed' })), () => true)
    advance(1000)
    store.bindParent(scope.backendId, scope.parentSessionPath)
    expect(store.get('child-1', scope.backendId)).toMatchObject({ revision: 2, status: 'completed', retentionRemainingMs: SUBAGENT_SESSION_RETENTION_MS - 1000 })
    store.bindParent(scope.backendId, scope.parentSessionPath)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(2)
  })

  it('switches runtime only with a new native creation receipt and permanently fences the retired runtime', () => {
    const { store } = fixture()
    store.consume(scope, widget(), () => true)
    const next = packet({ runtimeId: 'runtime-2', id: 'child-2', parentToolCallId: 'root-tool-2' })
    store.consume(scope, widget(next), () => false)
    expect(store.list().sessions).toHaveLength(1)
    const oldGet = store.get('child-1', scope.backendId)!
    expect(reserve(store, scope, next, 1, () => false)).toBe(false)
    expect(reserve(store, scope, next)).toBe(true)
    store.consume(scope, widget(next), () => true)
    expect(store.list().sessions.find((child) => child.id === 'child-1')).toMatchObject({ status: 'cancelling', revision: oldGet.revision + 1 })
    expect(oldGet.status).toBe('running')
    store.consume(scope, widget(packet({ revision: 2, status: 'completed' })), () => true)
    store.consume(scope, widget(packet({ id: 'late-old-runtime' })), () => true)
    expect(store.list().sessions).toHaveLength(2)
    expect(store.get('child-1', scope.backendId)?.revision).toBe(2)
  })

  it('retains every unexpired child at capacity instead of evicting old completed/running children', () => {
    const { store, advance } = fixture(false)
    for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) {
      const parentToolCallId = `root-${Math.floor(i / 8)}`
      if (i % 8 === 0) expect(reserve(store, scope, { parentToolCallId }, 8)).toBe(true)
      store.consume(scope, widget(packet({ id: `child-${i}`, parentToolCallId, status: i === 0 ? 'completed' : 'running' })), () => true)
    }
    const allow = vi.fn(() => true)
    store.consume(scope, widget(packet({ id: 'overflow' })), allow)
    expect(allow).not.toHaveBeenCalled()
    expect(store.list().sessions).toHaveLength(SUBAGENT_SESSION_MAX_RECORDS)
    expect(store.get('child-0', scope.backendId)?.status).toBe('completed')
    advance(SUBAGENT_SESSION_RETENTION_MS)
    expect(reserve(store)).toBe(true)
    store.consume(scope, widget(packet({ id: 'overflow' })), allow)
    expect(store.list().sessions).toHaveLength(SUBAGENT_SESSION_MAX_RECORDS)
    store.consume(scope, widget(packet({ id: 'child-0', revision: 2 })), allow)
    expect(store.get('child-0', scope.backendId)).toBeNull()
  })

  it('does not prune idle receipted backends at the backend bound even after every child expires', () => {
    const { store, advance } = fixture(false)
    for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) {
      expect(reserve(store, { ...scope, backendId: `owner-${i}` })).toBe(true)
      store.consume({ ...scope, backendId: `owner-${i}` }, widget(packet({ status: 'completed' })), () => true)
    }
    advance(SUBAGENT_SESSION_RETENTION_MS * 100)
    expect(store.list().sessions).toEqual([])
    const allow = vi.fn(() => true)
    expect(reserve(store, { ...scope, backendId: 'overflow-owner' }, {}, 1, allow)).toBe(false)
    store.consume({ ...scope, backendId: 'overflow-owner' }, widget(), allow)
    expect(allow).not.toHaveBeenCalled()
    expect(reserve(store, { ...scope, backendId: 'owner-0', nonce: 'new-nonce' }, { parentToolCallId: 'new-root' }, 1, allow)).toBe(false)
    store.consume({ ...scope, backendId: 'owner-0', nonce: 'new-nonce' }, widget(packet({ nonce: 'new-nonce', id: 'new-id' })), allow)
    expect(allow).not.toHaveBeenCalled()
    // Original owner remains trusted and usable, but its expired child ID stays fenced.
    expect(reserve(store, { ...scope, backendId: 'owner-0' }, { parentToolCallId: 'next-root' })).toBe(true)
    store.consume({ ...scope, backendId: 'owner-0' }, widget(packet({ id: 'new-id', parentToolCallId: 'next-root' })), allow)
    expect(store.get('new-id', 'owner-0')).not.toBeNull()
    store.consume({ ...scope, backendId: 'owner-0' }, widget(packet({ revision: 2 })), allow)
    expect(store.get('child-1', 'owner-0')).toBeNull()
  })

  it('prunes only unused binding placeholders, never gone-backend fences', () => {
    const { store } = fixture(false)
    for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) store.bindParent(`placeholder-${i}`, scope.parentSessionPath)
    expect(reserve(store)).toBe(true)
    store.consume(scope, widget(), () => true)
    expect(store.get('child-1', scope.backendId)).not.toBeNull()
    const other = fixture(false).store
    for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) other.markBackendGone(`gone-${i}`, false)
    const allow = vi.fn(() => true)
    expect(reserve(other, scope, {}, 1, allow)).toBe(false)
    other.consume(scope, widget(), allow)
    expect(allow).not.toHaveBeenCalled()
    other.bindParent('gone-0', scope.parentSessionPath)
    expect(reserve(other, { ...scope, backendId: 'gone-0' }, {}, 1, allow)).toBe(false)
    other.consume({ ...scope, backendId: 'gone-0' }, widget(), allow)
    expect(other.list().sessions).toEqual([])
  })

  it('preserves saturated unknown-exit fences instead of unblocking pending records after time elapses', () => {
    const { store, advance } = fixture()
    store.consume(scope, widget(), () => true)
    store.markBackendGone(scope.backendId, false)
    for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) store.markBackendGone(`gone-${i}`, false)
    advance(SUBAGENT_SESSION_RETENTION_MS * 100)
    store.consume(scope, widget(packet({ revision: 2, status: 'completed' })), () => true)
    const allow = vi.fn(() => true)
    expect(reserve(store, { ...scope, backendId: 'new-owner' }, {}, 1, allow)).toBe(false)
    store.consume({ ...scope, backendId: 'new-owner' }, widget(), allow)
    expect(allow).not.toHaveBeenCalled()
    expect(store.get('child-1', scope.backendId)).toMatchObject({ status: 'cancelling', revision: 2 })
    expect(store.get('child-1', scope.backendId)).not.toHaveProperty('retentionRemainingMs')
  })

  it('bounds tombstones fail-closed rather than discarding fences and resurrecting expired IDs', () => {
    const { store, advance } = fixture(false)
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < SUBAGENT_SESSION_MAX_RECORDS; i++) {
        const parentToolCallId = `batch-${batch}-root-${Math.floor(i / 8)}`
        if (i % 8 === 0) expect(reserve(store, scope, { parentToolCallId }, 8)).toBe(true)
        store.consume(scope, widget(packet({ id: `${batch}-${i}`, parentToolCallId, status: 'completed' })), () => true)
      }
      advance(SUBAGENT_SESSION_RETENTION_MS)
      expect(store.list().sessions).toEqual([])
    }
    store.consume(scope, widget(packet({ id: '0-0' })), () => true)
    expect(reserve(store, scope, { parentToolCallId: 'new-after-saturation' })).toBe(false)
    store.consume(scope, widget(packet({ id: 'new-after-saturation' })), () => true)
    expect(store.list().sessions).toEqual([])
  })
})
