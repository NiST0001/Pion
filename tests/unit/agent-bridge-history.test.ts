import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { sessionBranch, sessionTurnTimings, toWireEntry } from '../../src/main/agent/wire'

const timing = { startedAt: 10, finishedAt: 30, durationMs: 20, outcome: 'completed' as const }
const entry = (id: string, parentId: string | null, fields: Record<string, unknown>): SessionEntry => ({
  id, parentId, timestamp: '2026-01-01T00:00:00.000Z', ...fields
}) as unknown as SessionEntry
const user = (id = 'user', parentId: string | null = null, timestamp: unknown = 10) => entry(id, parentId, {
  type: 'message', message: { role: 'user', timestamp, content: 'same' }
})
const receipt = (id = 'receipt', parentId = 'user', patch: Record<string, unknown> = {}) => entry(id, parentId, {
  type: 'custom', customType: 'pion-turn-timing',
  data: { version: 1, userEntryId: 'user', inputId: 'source', ...timing, ...patch }
})

function harness(entries: SessionEntry[], leafId: string) {
  const getActiveEntries = vi.fn(async () => ({ entries: [...entries], leafId }))
  const getState = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { getActiveEntries, getState }) as AgentBridge
  return { bridge, getActiveEntries, getState }
}

describe('main history timing projection', () => {
  it('projects full-branch receipts across page bounds and an omitted metadata tail, keeping the original tree and tool results', async () => {
    const original = user()
    const assistant = entry('assistant', 'user', { type: 'message', message: { role: 'assistant', timestamp: 11,
      content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] } })
    const tool = entry('tool', 'assistant', { type: 'message', message: { role: 'toolResult', toolCallId: 'call', content: 'done' } })
    const abandoned = user('abandoned', 'user')
    const abandonedReceipt = receipt('abandoned-receipt', 'abandoned', { userEntryId: 'abandoned', inputId: 'discarded' })
    const selectedReceipt = receipt('selected-receipt', 'tool')
    const tree = [original, abandoned, abandonedReceipt, assistant, tool, selectedReceipt]
    const { bridge, getState } = harness(tree, selectedReceipt.id)
    const page = await bridge.getEntriesPage(1, 1)
    expect(page?.entries[0].message?._pionTurnTiming).toEqual(timing)
    const latest = await bridge.getEntriesPage(undefined, 10)
    expect(latest).toMatchObject({ start: 0, end: 4, total: 4 })
    expect(latest?.entries.map((value) => value.id)).toEqual(['user', 'assistant'])
    expect(latest?.entries[0].message?._pionTurnTiming).toEqual(timing)
    expect(latest?.toolResults.map((value) => value.id)).toEqual(['tool'])
    expect(latest?.toolResults[0].message?._pionTurnTiming).toBeUndefined()
    const full = await bridge.getEntries()
    expect(full?.entries.map((value) => value.id)).toEqual(tree.map((value) => value.id))
    expect(full?.leafId).toBe(selectedReceipt.id)
    expect(full?.entries.find((value) => value.id === 'abandoned')?.message?._pionTurnTiming).toBeUndefined()
    expect((original as unknown as { message: object }).message).not.toHaveProperty('_pionTurnTiming')
    expect(toWireEntry(tool, timing).message?._pionTurnTiming).toBeUndefined()
    expect(getState).not.toHaveBeenCalled()
    const incomplete = await harness(tree, 'missing-leaf').bridge.getEntries()
    expect(incomplete?.leafId).toBe('missing-leaf')
    expect(incomplete?.entries.map((value) => value.id)).toEqual(tree.map((value) => value.id))
    expect(incomplete?.entries[0].message?._pionTurnTiming).toBeUndefined()
  })

  it('uses only the selected ancestry, including branches with no receipt', () => {
    const tree = [user(), receipt(), user('selected', 'user')]
    expect(sessionTurnTimings(sessionBranch(tree, 'selected')).size).toBe(0)
    expect(sessionTurnTimings(sessionBranch(tree, 'receipt')).get('user')).toEqual(timing)
  })

  it('keeps wrong clocks, conflicting records, input reuse and ambiguous entry ids unknown', () => {
    const cases = [
      [user('user', null, '10'), receipt()],
      [user(), receipt('wrong-clock', 'user', { startedAt: 11, durationMs: 19 })],
      [user(), receipt(), receipt('conflict', 'receipt', { finishedAt: 31, durationMs: 21 })],
      [user(), receipt(), receipt('source-conflict', 'receipt', { inputId: 'different' })],
      [user(), receipt(), user('other', 'receipt'), receipt('reused', 'other', { userEntryId: 'other' })],
      [user(), user('user', 'user'), receipt()],
      [receipt('before-user'), user('user', 'before-user')]
    ]
    for (const branch of cases) expect(sessionTurnTimings(branch).size).toBe(0)
    expect(sessionTurnTimings([user(), receipt(), receipt('same-record', 'receipt')]).get('user')).toEqual(timing)
  })
})
