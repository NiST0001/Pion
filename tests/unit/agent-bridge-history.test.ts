import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { AgentBridge, projectAgentDisplay } from '../../src/main/agent/agent-bridge'
import { sessionBranch, sessionTurnTimings, toWireEntry } from '../../src/main/agent/wire'
import { messageText, messageToolCalls, type WireMessage } from '../../src/shared/types'

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
  it('preserves SDK event/queue envelopes and identities while stripping structured results only at live/history display boundaries', async () => {
    const result = { content: [{ type: 'text', text: 'preview' }], details: { result: { applicationField: 'kept' } },
      structuredContent: { sdkOnly: 'programmatic' }, externalPayload: 'unbounded-secret' }
    const assistant = entry('assistant', 'user', { type: 'message', message: { role: 'assistant',
      content: [{ type: 'toolCall', id: 'call', name: 'mcp__server_tool', arguments: {} }] } })
    const wire = entry('tool', 'assistant', { type: 'message', message: { role: 'toolResult', toolName: 'mcp__server_tool',
      toolCallId: 'call', ...result } })
    const h = harness([user(), assistant, wire], wire.id)
    for (const value of [(await h.bridge.getEntries())?.entries[2], (await h.bridge.getEntriesPage(undefined, 10))?.toolResults[0],
      projectAgentDisplay({ type: 'tool_execution_end', result, preserved: 'root-field' }),
      projectAgentDisplay({ type: 'tool_execution_update', partialResult: result })]) {
      expect(JSON.stringify(value)).not.toContain('programmatic')
      expect(JSON.stringify(value)).toContain('externalPayload')
    }
    const projected = projectAgentDisplay({ type: 'tool_execution_end', result, preserved: 'root-field', parentToolCallId: 'root' })
    expect(projected).toMatchObject({ preserved: 'root-field', parentToolCallId: 'root' })
    expect(projected.result.details).toEqual(result.details)
    const queue = { type: 'queue_update', followUpMessages: ['same', 'same'], followUpRunIds: ['first', 'second'],
      steeringMessages: ['steering'], futureSdkField: { preserved: true } }
    expect(projectAgentDisplay(queue)).toEqual(queue)
    const message = { role: 'user', content: 'question', _pionLiveMessageId: 'actual-live-id', futureSdkField: 'kept' }
    expect(projectAgentDisplay({ type: 'entry_appended', preserved: 'entry-field', entry: {
      type: 'message', id: 'actual-entry', parentId: 'actual-parent', message
    } })).toEqual({ type: 'entry_appended', preserved: 'entry-field', entry: {
      type: 'message', id: 'actual-entry', parentId: 'actual-parent', message
    } })
    expect(result.structuredContent).toEqual({ sdkOnly: 'programmatic' })
    expect(projectAgentDisplay({ type: 'tool_execution_end', result: { details: { huge: 'x'.repeat(1024 * 1024 + 1) } } })
      .result.details.huge).toContain('显示已省略')
  })

  it.each([
    { count: 2732, part: { type: 'text', text: 'visible' } },
    { count: 2, part: { type: 'toolCall', arguments: { values: Array(4096).fill('argument') }, id: 'call', name: 'read' } }
  ])('keeps budget-exhausted $part.type content valid in live and history displays', async ({ count, part }) => {
    const original: WireMessage = { role: 'assistant', content: Array(count).fill(part) }
    const h = harness([entry('assistant', null, { type: 'message', message: original })], 'assistant')
    for (const message of [(await h.bridge.getEntries())!.entries[0].message!,
      projectAgentDisplay({ type: 'message_end', message: original }).message]) {
      expect(() => { messageText(message); messageToolCalls(message) }).not.toThrow()
      const parts = message.content as unknown[]
      expect(parts.length).toBeGreaterThan(0)
      expect(parts.length).toBeLessThan(count)
      expect(parts).toEqual(Array(parts.length).fill(part))
    }
    expect(original.content).toHaveLength(count)
  })

  it('marks only text/thinking actually lost in the same message projection, keeping empty finals authoritative', async () => {
    const calls = Array.from({ length: 2 }, (_, index) => ({ type: 'toolCall', id: `call-${index}`, name: 'read',
      arguments: { values: Array(4096).fill('argument') } }))
    for (const [content, lost] of [
      [[{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }, ...calls], []],
      [[{ type: 'text', text: 'kept' }, { type: 'thinking', text: 'kept thinking' }], []],
      [[{ type: 'thinking', text: 'kept thinking' }, ...calls, { type: 'text', text: 'tail' }], ['text']],
      [[{ type: 'text', text: 'kept' }, ...calls, { type: 'thinking', thinking: 'tail thinking' }], ['thinking']]
    ] as const) {
      const original: WireMessage = { role: 'assistant', content: [...content], details: { huge: 'x'.repeat(1024 * 1024 + 1) } }
      const h = harness([entry('assistant', null, { type: 'message', message: original })], 'assistant')
      for (const message of [(await h.bridge.getEntries())!.entries[0].message!,
        projectAgentDisplay({ type: 'message_end', message: original }).message]) {
        expect(message._pionLiveTruncatedFields).toEqual([...lost, 'error', 'diff', 'outputText', 'subagentBatch'])
      }
      expect(original).not.toHaveProperty('_pionLiveTruncatedFields')
    }
  })

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
