// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  applyToolResult,
  assistantErrorText,
  collectToolResults,
  deriveAgentTodos,
  deriveLatestRunChanges,
  diffStats,
  entriesToTimeline,
  getViewportHistoryPageSize,
  orderTimelineAroundAnchors,
  parseToolArgs,
  preserveTimelineToolState,
  reconcileCompletedAssistantRows,
  reconcileNewerTimelineItems,
  reconcileOlderTimelineItems,
  uniqueTimelineItems,
  wireMessageTimestamp
} from '../../src/renderer/src/agent/timeline'
import type { TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'
import type { WireEntry } from '../../src/shared/types'
import { CODEX_IMAGE_REQUEST_ALIAS, IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import { MAX_TOOL_IMAGE_BASE64_LENGTH, MAX_TOOL_IMAGES } from '../../src/shared/tool-images'

const previewPart = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const imageTool: ToolItem = {
  id: 'image-call', name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true
}

describe('bounded newest-page restore and older-page identity', () => {
  const clock = 1_780_000_000_000
  type MessageRow = Extract<TimelineItem, { kind: 'user' | 'assistant' }>
  const messageKinds = ['user', 'assistant'] as const

  function liveMessage(kind: MessageRow['kind'], id = 5000): MessageRow {
    const common = { id, liveMessageId: `synthetic:${id}`, messageTimestamp: clock,
      text: 'synthetic final body', live: true, historical: true, noReveal: true }
    return kind === 'user' ? { ...common, kind } : {
      ...common, kind, thinking: 'synthetic final thought', streaming: false
    }
  }

  function diskMessage(live: MessageRow, entryId = 'synthetic-entry', id = live.id + 100): MessageRow {
    const { liveMessageId: _liveId, live: _live, noReveal: _noReveal,
      historyReconciled: _reconciled, ...row } = live
    return { ...row, id, entryId }
  }

  function liveTool(id: number, callId: string, name = 'read'): Extract<TimelineItem, { kind: 'tool' }> {
    return { kind: 'tool', id, historical: true, noReveal: true,
      tool: applyToolResult({ id: callId, name, status: 'running', isError: false, live: true },
        { content: [{ type: 'text', text: `synthetic final ${callId}` }] }, false, 'message') }
  }

  function syntheticTimeline() {
    // One opening user and one opening assistant, followed by its six calls.
    // Later task/subagent batches put these rows outside the newest page. This
    // is a display projection, not a fake ordinary-message entry_appended event.
    const user = liveMessage('user', 5100)
    const assistant = { ...liveMessage('assistant', 5101), messageTimestamp: clock + 1 }
    const tools = Array.from({ length: 6 }, (_, index) => liveTool(5102 + index, `T${index + 1}`))
    const batches = [liveTool(5108, 'task', 'pion_task'), liveTool(5109, 'subagents', 'pion_subagents')]
    const streamtail: TimelineItem = { kind: 'assistant', id: 5110, liveMessageId: 'synthetic:streamtail',
      messageTimestamp: clock + 100, text: 'synthetic streaming tail', thinking: '', streaming: true,
      live: true, historical: true, noReveal: true }
    const fullLive: TimelineItem[] = [user, assistant, ...tools, ...batches, streamtail]
    const disk: TimelineItem[] = fullLive.slice(0, -1).map((row) => {
      if (row.kind === 'user' || row.kind === 'assistant') return diskMessage(row, `entry-${row.kind}`)
      if (row.kind !== 'tool') throw new Error('Expected a synthetic tool')
      // A call-only history row cannot erase a completed live result.
      return { kind: 'tool', id: row.id + 100, historical: true,
        tool: { id: row.tool.id, name: row.tool.name, status: 'done', isError: false } }
    })
    return { fullLive, newestPage: disk.slice(8), olderPage: disk.slice(0, 8) }
  }

  function order(items: TimelineItem[]): string[] {
    return items.map((row) => row.kind === 'tool' ? row.tool.id
      : row.kind === 'assistant' && row.streaming ? 'streamtail' : row.kind)
  }

  it('keeps the whole live turn in order when the newest slice omits its opening and six early calls', () => {
    const { fullLive, newestPage } = syntheticTimeline()
    expect(order(newestPage)).toEqual(['task', 'subagents'])
    const restored = preserveTimelineToolState(fullLive, newestPage)
    expect(order(restored)).toEqual(['user', 'assistant', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6',
      'task', 'subagents', 'streamtail'])
    expect(restored.map((row) => row.id)).toEqual(fullLive.map((row) => row.id))
  })

  it('joins the older opening once, preserving the full turn order, mounted keys, live IDs, finals and markers', () => {
    const { fullLive, newestPage, olderPage } = syntheticTimeline()
    const restored = preserveTimelineToolState(fullLive, newestPage)
    const merged = reconcileOlderTimelineItems(restored, olderPage)
    // IDs are the actual ChatTimeline React keys, not a second synthetic key.
    expect.soft(order(merged.items)).toEqual(['user', 'assistant', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6',
      'task', 'subagents', 'streamtail'])
    expect.soft(merged.items.map((row) => row.id)).toEqual(fullLive.map((row) => row.id))
    expect.soft(merged.prepended).toEqual([])
    for (const original of fullLive) {
      const rows = merged.items.filter((row) => row.id === original.id)
      expect.soft(rows).toHaveLength(1)
      expect.soft(rows[0]).toMatchObject({ historical: true, noReveal: true })
      if (original.kind === 'user' || original.kind === 'assistant') {
        expect.soft(rows[0]).toMatchObject({ liveMessageId: original.liveMessageId })
        if (original.id !== 5110) expect.soft(rows[0]).toMatchObject({
          entryId: `entry-${original.kind}`, historyReconciled: true
        })
      }
      if (original.kind === 'tool') {
        expect.soft(rows[0]).toMatchObject({ historyReconciled: true, tool: original.tool })
        expect.soft(rows[0]?.kind === 'tool' && rows[0].tool).toBe(original.tool)
      }
    }
  })

  it.each([
    { name: 'immediately preceding', start: 6, end: 8 },
    { name: 'middle', start: 3, end: 6 }
  ])('retains the full snapshot order across a $name older page, its repeat, then the opening', ({ start, end }) => {
    const { fullLive, newestPage, olderPage } = syntheticTimeline()
    const restored = preserveTimelineToolState(fullLive, newestPage)
    const middle = olderPage.slice(start, end)
    const first = reconcileOlderTimelineItems(restored, middle)
    expect.soft(first.items.map((row) => row.id)).toEqual(fullLive.map((row) => row.id))
    expect.soft(first.prepended).toEqual([])
    const repeated = reconcileOlderTimelineItems(first.items, middle.map((row) => ({ ...row })))
    expect.soft(repeated.items).toEqual(first.items)
    expect.soft(repeated.items.map((row) => row.id)).toEqual(fullLive.map((row) => row.id))
    expect.soft(repeated.prepended).toEqual([])
    // The next older page excludes the middle rather than repairing order
    // accidentally by replaying the entire turn in one complete page.
    const openingPage = olderPage.slice(0, start)
    const opening = reconcileOlderTimelineItems(repeated.items, openingPage)
    expect.soft(opening.items.map((row) => row.id)).toEqual(fullLive.map((row) => row.id))
    expect.soft(opening.prepended).toEqual([])
    for (const original of fullLive) {
      const row = opening.items.find((item) => item.id === original.id)
      expect.soft(row).toMatchObject({ historical: true, noReveal: true })
      if (original.kind === 'tool') expect.soft(row?.kind === 'tool' && row.tool).toBe(original.tool)
      if (original.kind === 'user' || original.kind === 'assistant') {
        expect.soft(row).toMatchObject({ liveMessageId: original.liveMessageId })
      }
    }
    expect(reconcileOlderTimelineItems(opening.items, openingPage).items).toEqual(opening.items)
  })

  it('keeps an unlocated prefix before a single newly located middle call and an already located later call', () => {
    const early = liveMessage('user', 5600)
    const middle = liveTool(5601, 'middle')
    const later = { ...liveTool(5602, 'later'), historyReconciled: true }
    const persisted: TimelineItem = { kind: 'tool', id: 5701,
      tool: { id: 'middle', name: 'read', status: 'done', isError: false } }
    const result = reconcileOlderTimelineItems([early, middle, later], [persisted])
    expect(result).toEqual({ items: [early, { ...middle, historyReconciled: true }, later], prepended: [] })
    expect(reconcileOlderTimelineItems(result.items, [persisted])).toEqual(result)
  })

  it('uses both message and tool anchors without reordering the live-only runs between them', () => {
    const early = liveTool(5800, 'early')
    const message = liveMessage('assistant', 5801)
    const between = liveTool(5802, 'between')
    const call = liveTool(5803, 'anchor-call')
    const later = { ...liveTool(5804, 'located-later'), historyReconciled: true }
    const tail = liveMessage('user', 5805)
    const fullLive = [early, message, between, call, later, tail]
    const page: TimelineItem[] = [diskMessage(message, 'message-anchor'), {
      kind: 'tool', id: 5903, tool: { id: call.tool.id, name: 'read', status: 'done', isError: false }
    }]
    const first = reconcileOlderTimelineItems(fullLive, page)
    expect.soft(first.items.map((row) => row.id)).toEqual(fullLive.map((row) => row.id))
    expect.soft(first.prepended).toEqual([])
    expect.soft(first.items.find((row) => row.id === message.id)).toMatchObject({
      entryId: 'message-anchor', liveMessageId: message.liveMessageId, historyReconciled: true
    })
    expect(reconcileOlderTimelineItems(first.items, page).items).toEqual(first.items)
  })

  it.each(messageKinds.flatMap((kind) => ['entryId', 'liveMessageId'].map((identity) => ({ kind, identity }))))(
    'reconciles an older $kind by strong $identity without remounting', ({ kind, identity }) => {
      const live = liveMessage(kind)
      if (identity === 'entryId') live.entryId = 'synthetic-entry'
      const persisted = diskMessage(live)
      if (identity === 'liveMessageId') persisted.liveMessageId = live.liveMessageId
      // Strong identity, not equal text or clock, is the proof in this case.
      persisted.messageTimestamp = clock + 1
      if (persisted.kind === 'assistant') persisted.text = 'synthetic authoritative final'
      // This row belongs to the already loaded newest page, not an earlier
      // unlocated row in the same full-live snapshot as the matched message.
      const later = { ...liveTool(5200, 'later'), historyReconciled: true }
      const result = reconcileOlderTimelineItems([later, live], [persisted])
      expect(result.items).toEqual([
        expect.objectContaining({ id: live.id, entryId: persisted.entryId,
          liveMessageId: live.liveMessageId, historical: true, noReveal: true, historyReconciled: true }), later
      ])
      if (kind === 'assistant') expect(result.items[0]).toMatchObject({ text: persisted.text, streaming: false })
      expect(result.prepended).toEqual([])
    }
  )

  it('keeps a proven full-live prefix before a strongly matched older message if that prefix is not yet located', () => {
    const early = liveTool(5250, 'unlocated-prefix')
    const live = { ...liveMessage('user', 5251), entryId: 'matched-user' }
    const result = reconcileOlderTimelineItems([early, live], [diskMessage(live, live.entryId)])
    expect(result.items.map((row) => row.id)).toEqual([early.id, live.id])
    expect(result.items[0]).toBe(early)
    expect(result.items[1]).toMatchObject({ entryId: live.entryId, liveMessageId: live.liveMessageId,
      historyReconciled: true })
    expect(result.prepended).toEqual([])
  })

  it('places unanchored older history before the loaded newer window without guessing live row positions', () => {
    const early = liveTool(5260, 'unlocated')
    const located = { ...liveTool(5261, 'located-newer'), historyReconciled: true }
    const page = [diskMessage(liveMessage('user', 5262), 'unrelated-older')]
    const result = reconcileOlderTimelineItems([early, located], page)
    expect(result).toEqual({ items: [...page, early, located], prepended: page })
    expect(result.items[1].historyReconciled).toBeUndefined()
    expect(result.items[1]).not.toHaveProperty('entryId')
  })

  it.each(messageKinds.flatMap((kind) => ['older', 'newer'].map((direction) => ({ kind, direction }))))(
    'does not multiply a bare $kind disk row on $direction revisits after a known entry/live identity conflict', ({ kind, direction }) => {
      const a = { ...liveMessage(kind, 5280), entryId: 'shared-entry', historyReconciled: true }
      const b = { ...a, id: 5281, liveMessageId: 'synthetic:conflicting' }
      // Preserve the existing conflict; do not guess which live identity owns
      // the entry. A later bare disk copy is already represented, not a third
      // message or a trustworthy anchor for selecting either mounted row.
      let rows = reconcileNewerTimelineItems([a], [b]).items
      expect(rows).toEqual([a, b])
      const disk = diskMessage(a, a.entryId, 5380)
      for (let repeat = 0; repeat < 3; repeat++) {
        const page = [{ ...disk }]
        const result = direction === 'older'
          ? reconcileOlderTimelineItems(rows, page) : reconcileNewerTimelineItems(rows, page)
        expect(result.items).toEqual([a, b])
        expect(new Set(result.items.map((row) => row.id)).size).toBe(2)
        expect('prepended' in result ? result.prepended : result.appended).toEqual([])
        rows = result.items
      }
    }
  )

  it.each(messageKinds)('binds a unique actual SDK clock and full final %s body on an older page', (kind) => {
    // Old cache markers without a real entry ID are not proof of reconciliation.
    const live = { ...liveMessage(kind), historyReconciled: true }
    const persisted = diskMessage(live)
    const result = reconcileOlderTimelineItems([live], [persisted])
    expect(result.items).toEqual([expect.objectContaining({ id: live.id, entryId: persisted.entryId,
      liveMessageId: live.liveMessageId, messageTimestamp: clock, historyReconciled: true })])
    expect(result.prepended).toEqual([])
  })

  it.each([
    { messageTimestamp: undefined }, { messageTimestamp: clock + 1 },
    { text: 'synthetic different final' }, { thinking: 'synthetic different thought' },
    { error: 'synthetic provider error' }
  ])('does not identify an older assistant by text alone or an incomplete final body: %j', (patch) => {
    const live = liveMessage('assistant')
    const persisted = { ...diskMessage(live), ...patch } as MessageRow
    expect(reconcileOlderTimelineItems([live], [persisted])).toEqual({
      items: [persisted, live], prepended: [persisted]
    })
  })

  it.each(messageKinds.flatMap((kind) => [1, 0].map((clockOffset) => ({ kind, clockOffset }))))(
    'keeps real same-text $kind sends distinct with clock offset $clockOffset', ({ kind, clockOffset }) => {
      const first = liveMessage(kind, 5300)
      const second = { ...liveMessage(kind, 5301), messageTimestamp: clock + clockOffset }
      const page = [diskMessage(first, 'entry-first'), diskMessage(second, 'entry-second')]
      const result = reconcileOlderTimelineItems([first, second], page)
      if (clockOffset === 0) {
        expect(result).toEqual({ items: [...page, first, second], prepended: page })
      } else {
        expect(result.items).toEqual([
          expect.objectContaining({ id: first.id, entryId: 'entry-first', liveMessageId: first.liveMessageId }),
          expect.objectContaining({ id: second.id, entryId: 'entry-second', liveMessageId: second.liveMessageId })
        ])
        expect(result.prepended).toEqual([])
      }
    }
  )

  it.each(messageKinds)('never deletes an older %s with a conflicting entry or live ID', (kind) => {
    const base = liveMessage(kind)
    const page = diskMessage(base)
    const pairs: Array<[MessageRow, MessageRow]> = [
      [{ ...base, entryId: 'entry-other' }, { ...page, liveMessageId: base.liveMessageId }],
      [base, { ...page, liveMessageId: 'synthetic:other' }],
      [{ ...base, entryId: page.entryId, historyReconciled: true }, { ...page, liveMessageId: 'synthetic:other' }]
    ]
    for (const [live, persisted] of pairs) {
      expect(reconcileOlderTimelineItems([live], [persisted])).toEqual({
        items: [persisted, live], prepended: [persisted]
      })
    }
  })

  it.each(messageKinds)('requires both sides to be unique for an older %s clock/body bridge', (kind) => {
    const live = liveMessage(kind)
    const otherLive = { ...live, id: live.id + 1, liveMessageId: 'synthetic:other' }
    const persisted = diskMessage(live)
    const otherPersisted = { ...persisted, id: persisted.id + 1, entryId: 'entry-other' }
    expect(reconcileOlderTimelineItems([live, otherLive], [persisted])).toEqual({
      items: [persisted, live, otherLive], prepended: [persisted]
    })
    expect(reconcileOlderTimelineItems([live], [persisted, otherPersisted])).toEqual({
      items: [persisted, otherPersisted, live], prepended: [persisted, otherPersisted]
    })
    // An earlier strong match cannot make the remaining same-clock body unique.
    const strong = { ...persisted, liveMessageId: live.liveMessageId }
    const result = reconcileOlderTimelineItems([live, otherLive], [strong, otherPersisted])
    expect(result.items).toEqual([
      expect.objectContaining({ id: live.id, entryId: strong.entryId }), otherPersisted, otherLive
    ])
    expect(result.prepended).toEqual([otherPersisted])
  })

  it('returns only genuinely new history as prepended and is idempotent across repeated older pages', () => {
    const { fullLive, olderPage } = syntheticTimeline()
    const earlier = diskMessage({ ...liveMessage('user', 5400), messageTimestamp: clock - 1 }, 'entry-before')
    const page = [earlier, ...olderPage]
    const first = reconcileOlderTimelineItems(fullLive, page)
    expect.soft(first.prepended).toEqual([earlier])
    expect.soft(first.items.map((row) => row.id)).toEqual([earlier.id, ...fullLive.map((row) => row.id)])
    const repeated = reconcileOlderTimelineItems(first.items, page.map((row) => ({ ...row })))
    expect.soft(repeated.items).toEqual(first.items)
    expect.soft(repeated.prepended).toEqual([])
  })

  it('finishes result-only older pages without orphan rows or false placement, then locates the call once', () => {
    const running: TimelineItem = { kind: 'tool', id: 5500, historical: true, noReveal: true,
      tool: { id: 'result-only', name: 'read', status: 'running', live: true, isError: false } }
    const resultEntry: WireEntry = { type: 'message', id: 'entry-result', parentId: 'entry-call',
      timestamp: new Date(clock + 20_000).toISOString(), message: { role: 'toolResult',
        toolCallId: running.tool.id, toolName: running.tool.name, isError: false,
        content: [{ type: 'text', text: 'synthetic final result' }] } }
    const page = entriesToTimeline([resultEntry])
    expect(page).toEqual([])
    const first = reconcileOlderTimelineItems([running], page, collectToolResults([resultEntry]))
    expect(first.prepended).toEqual([])
    expect(first.items).toEqual([expect.objectContaining({ id: running.id, historical: true, noReveal: true,
      tool: expect.objectContaining({ status: 'done', resultReceived: true, resultSource: 'history',
        live: true, outputText: 'synthetic final result' }) })])
    expect(first.items[0].historyReconciled).toBeUndefined()
    expect(reconcileOlderTimelineItems(first.items, page, collectToolResults([resultEntry]))).toEqual(first)
    const call: TimelineItem = { kind: 'tool', id: 5501,
      tool: { id: running.tool.id, name: 'read', status: 'done', isError: false } }
    const located = reconcileOlderTimelineItems(first.items, [call])
    expect(located.items).toEqual([{ ...first.items[0], historyReconciled: true }])
    expect(located.prepended).toEqual([])
    const staleFinal = { ...call, tool: applyToolResult(call.tool,
      { content: [{ type: 'text', text: 'synthetic stale result' }] }, true, 'history') }
    expect(reconcileOlderTimelineItems(located.items, [staleFinal])).toEqual(located)
  })
})

describe('already-reconciled timeline anchor ordering', () => {
  const user: TimelineItem = { kind: 'user', id: 6000, entryId: 'anchor-user',
    liveMessageId: 'synthetic:user', messageTimestamp: 200, text: 'same body' }
  const call: TimelineItem = { kind: 'tool', id: 6001,
    tool: { id: 'anchor-call', name: 'read', status: 'done', isError: false } }
  const assistant: TimelineItem = { kind: 'assistant', id: 6002, entryId: 'anchor-assistant',
    liveMessageId: 'synthetic:assistant', text: 'same body', thinking: '', streaming: false }
  const before: TimelineItem = { kind: 'user', id: 6100, text: 'same body', messageTimestamp: 300 }
  const between: TimelineItem = { kind: 'user', id: 6101, text: 'same body', messageTimestamp: 100 }
  const tail: TimelineItem = { kind: 'user', id: 6102, text: 'same body', messageTimestamp: 200 }

  it('weaves secondary-only runs around several message/tool anchors, preserving primary row objects', () => {
    expect(orderTimelineAroundAnchors([user, call, assistant], [before, { ...user }, between, { ...call }, { ...assistant }, tail]))
      .toEqual([before, user, between, call, assistant, tail])
  })

  it('keeps primary then secondary without shared keys, never sorting or deduplicating equal bodies/clocks', () => {
    expect(orderTimelineAroundAnchors([user], [before, between, tail])).toEqual([user, before, between, tail])
    expect(orderTimelineAroundAnchors([], [before, between, tail])).toEqual([before, between, tail])
    expect(orderTimelineAroundAnchors([user], [])).toEqual([user])
  })

  it('falls back to primary order for reversed anchors without losing secondary-only rows', () => {
    expect(orderTimelineAroundAnchors([user, call], [before, { ...call }, between, { ...user }, tail]))
      .toEqual([user, call, before, between, tail])
  })

  it.each([
    { name: 'entry ID', row: { ...user, entryId: 'other-entry' } as TimelineItem },
    { name: 'private live ID', row: { ...user, liveMessageId: 'synthetic:other' } as TimelineItem },
    { name: 'row kind', row: { ...assistant, id: user.id } as TimelineItem }
  ])('does not drop a same-key row with a conflicting $name', ({ row }) => {
    expect(orderTimelineAroundAnchors([user], [before, row, tail])).toEqual([user, before, row, tail])
  })

  it('does not mistake a colliding numeric key for a shared tool call identity', () => {
    const other: TimelineItem = { ...call, tool: { ...call.tool, id: 'different-call' } }
    expect(orderTimelineAroundAnchors([call], [before, other, tail])).toEqual([call, before, other, tail])
  })

  it('does not amplify duplicate shared keys outside the unique-key contract', () => {
    const copy = { ...user }
    // Invalid input remains invalid; do not invent replacement React/entry IDs
    // or use the ambiguous key to weave rows. Suppress only proven one-to-one
    // overlap, preserving the larger multiplicity instead of creating a third.
    expect(orderTimelineAroundAnchors([user], [copy, copy])).toEqual([user, copy])
    expect(orderTimelineAroundAnchors([user, copy], [copy])).toEqual([user, copy])
    expect(orderTimelineAroundAnchors([user, copy], [copy, copy])).toEqual([user, copy])
    expect(orderTimelineAroundAnchors([user], [before, copy, copy, tail])).toEqual([user, before, copy, tail])
    expect(orderTimelineAroundAnchors([user], [before, before])).toEqual([user, before, before])
    const liveOnly: TimelineItem = { ...user, entryId: undefined }
    const liveCopy = { ...liveOnly }
    expect(orderTimelineAroundAnchors([liveOnly], [liveCopy, liveCopy])).toEqual([liveOnly, liveCopy])
  })

  it('preserves conflicting duplicate keys rather than assigning fake identities or dropping distinct rows', () => {
    const other: TimelineItem = { ...user, entryId: 'different-entry' }
    expect(orderTimelineAroundAnchors([user], [other, other])).toEqual([user, other, other])
    const bare: TimelineItem = { kind: 'user', id: user.id, text: user.text }
    // The duplicated key voids the helper precondition; absent shared true
    // identity, matching text/key alone cannot prove any overlap to remove.
    expect(orderTimelineAroundAnchors([user], [bare, bare])).toEqual([user, bare, bare])
    const emptyIdentity: TimelineItem = { ...bare, liveMessageId: '' }
    const emptyCopy = { ...emptyIdentity }
    expect(orderTimelineAroundAnchors([emptyIdentity], [emptyCopy, emptyCopy]))
      .toEqual([emptyIdentity, emptyCopy, emptyCopy])
  })
})

describe('timeline derivation', () => {
  it('normalizes SDK numeric and ISO wire timestamps without inventing missing identity', () => {
    const timestamp = 1780000000000
    expect(wireMessageTimestamp({ role: 'user', timestamp })).toBe(timestamp)
    expect(wireMessageTimestamp({ role: 'user', timestamp: String(timestamp) })).toBe(timestamp)
    expect(wireMessageTimestamp({ role: 'user', timestamp: new Date(timestamp).toISOString() })).toBe(timestamp)
    for (const value of [undefined, '', 'invalid', 0, NaN, Infinity]) {
      expect(wireMessageTimestamp({ role: 'user', timestamp: value })).toBeUndefined()
    }
  })

  it('does not content-match two equal-time users with different stable live identities', () => {
    const first: TimelineItem = { kind: 'user', id: 1, liveMessageId: 'backend:1', live: true,
      messageTimestamp: 100, text: 'same' }
    const second: TimelineItem = { kind: 'user', id: 2, liveMessageId: 'backend:2', live: true,
      messageTimestamp: 100, text: 'same' }
    expect(reconcileNewerTimelineItems([first], [second]).items).toHaveLength(2)
    const persisted = { ...second, entryId: 'user-2' }
    expect(reconcileNewerTimelineItems([first, second], [persisted]).items).toEqual([
      expect.objectContaining({ id: second.id, entryId: 'user-2' }), first
    ])
  })

  it('preserves different persisted user IDs even when timestamp and contents are identical', () => {
    const first: TimelineItem = { kind: 'user', id: 1, entryId: 'user-1', liveMessageId: 'same-live', live: true,
      messageTimestamp: 100, text: 'same' }
    const second: TimelineItem = { ...first, id: 2, entryId: 'user-2' }
    expect(reconcileNewerTimelineItems([first], [second]).items).toHaveLength(2)
  })

  describe('live cache and persisted message identity', () => {
    const sdkClock = 1_780_000_000_000
    const liveUser: Extract<TimelineItem, { kind: 'user' }> = {
      kind: 'user', id: 1200, liveMessageId: 'backend:turn:user', messageTimestamp: sdkClock,
      text: 'check the result', live: true
    }
    const liveAssistant: Extract<TimelineItem, { kind: 'assistant' }> = {
      kind: 'assistant', id: 1201, liveMessageId: 'backend:turn:assistant', messageTimestamp: sdkClock + 1,
      text: 'final answer', thinking: 'checked the result', streaming: false, live: true
    }
    // Entry append time is deliberately different from the SDK message clock.
    const entries: WireEntry[] = [
      { type: 'message', id: 'stored-turn-user', parentId: null,
        timestamp: new Date(sdkClock + 30_000).toISOString(), message: {
          role: 'user', timestamp: liveUser.messageTimestamp, content: liveUser.text
        } },
      { type: 'message', id: 'stored-turn-assistant', parentId: 'stored-turn-user',
        timestamp: new Date(sdkClock + 30_001).toISOString(), message: {
          role: 'assistant', timestamp: liveAssistant.messageTimestamp, stopReason: 'stop', content: [
            { type: 'thinking', thinking: liveAssistant.thinking },
            { type: 'text', text: liveAssistant.text }
          ]
        } }
    ]
    const historyReconciliations = [
      { name: 'appended history', reconcile: (existing: TimelineItem[], incoming: TimelineItem[]) => (
        reconcileNewerTimelineItems(existing, incoming).items
      ) },
      { name: 'same-scope replacement', reconcile: (existing: TimelineItem[], incoming: TimelineItem[]) => (
        preserveTimelineToolState(existing, incoming)
      ) }
    ]
    const assistantReconciliations = [
      ...historyReconciliations,
      { name: 'completed assistant cleanup', reconcile: (existing: TimelineItem[], incoming: TimelineItem[]) => (
        reconcileCompletedAssistantRows([...incoming, ...existing])
      ) }
    ]

    function assistantPage(entryIds: string[]): Array<Extract<TimelineItem, { kind: 'assistant' }>> {
      const page = entriesToTimeline(entryIds.map((id) => ({ ...entries[1], id })))
      expect(page).toHaveLength(entryIds.length)
      expect(page.every((item) => item.kind === 'assistant')).toBe(true)
      return page.filter((item): item is Extract<TimelineItem, { kind: 'assistant' }> => item.kind === 'assistant')
    }

    function expectPersistedTurn(items: TimelineItem[]): void {
      expect(items).toEqual([
        expect.objectContaining({ kind: 'user', id: liveUser.id, liveMessageId: liveUser.liveMessageId,
          messageTimestamp: liveUser.messageTimestamp, text: liveUser.text,
          entryId: entries[0].id, historyReconciled: true }),
        expect.objectContaining({ kind: 'assistant', id: liveAssistant.id,
          liveMessageId: liveAssistant.liveMessageId, messageTimestamp: liveAssistant.messageTimestamp,
          text: liveAssistant.text, thinking: liveAssistant.thinking, streaming: false,
          entryId: entries[1].id, historyReconciled: true })
      ])
    }

    it('does not mark a same-stable-ID live cache copy as persisted history', () => {
      const existing: TimelineItem[] = [{ ...liveUser }, { ...liveAssistant }]
      const cache = existing.map((item) => ({ ...item, id: item.id + 100 }))
      const restored = preserveTimelineToolState(existing, cache)

      expect(restored).toHaveLength(2)
      expect(restored.map((item) => item.id)).toEqual([liveUser.id, liveAssistant.id])
      expect(restored.map((item) => item.historyReconciled)).not.toContain(true)
      expect(restored).toEqual([
        expect.objectContaining({ liveMessageId: liveUser.liveMessageId, live: true }),
        expect.objectContaining({ liveMessageId: liveAssistant.liveMessageId, live: true, streaming: false })
      ])
      for (const item of restored) expect(item).not.toMatchObject({ entryId: expect.any(String) })

      expectPersistedTurn(reconcileNewerTimelineItems(restored, entriesToTimeline(entries)).items)
    })

    it('keeps one mounted turn when a restored live cache is followed by its actual disk page', () => {
      const existing: TimelineItem[] = [{ ...liveUser }, { ...liveAssistant }]
      const restored = preserveTimelineToolState(existing, existing.map((item) => ({ ...item })))
      const first = reconcileNewerTimelineItems(restored, entriesToTimeline(entries))
      expectPersistedTurn(first.items)

      const repeated = reconcileNewerTimelineItems(first.items, entriesToTimeline(entries))
      expect(repeated.items).toEqual(first.items)
      expect(repeated.appended).toEqual([])
    })

    it.each(historyReconciliations)('recovers an old cache marked reconciled without entry IDs through $name', ({ reconcile }) => {
      const badCache: TimelineItem[] = [
        { ...liveUser, historyReconciled: true },
        { ...liveAssistant, historyReconciled: true }
      ]
      const first = reconcile(badCache, entriesToTimeline(entries))
      expectPersistedTurn(first)
      expect(reconcile(first, entriesToTimeline(entries))).toEqual(first)
    })

    it.each([undefined, true])('keeps a known assistant entry ID when a live-only cache has none (reconciled=%s)', (historyReconciled) => {
      const existing: TimelineItem = { ...liveAssistant, entryId: 'known-assistant', historyReconciled }
      const cache: TimelineItem = { ...liveAssistant, id: liveAssistant.id + 100 }
      const restored = preserveTimelineToolState([existing], [cache])
      expect(restored).toHaveLength(1)
      expect(restored[0]).toMatchObject({
        id: existing.id, entryId: 'known-assistant', liveMessageId: liveAssistant.liveMessageId,
        text: liveAssistant.text, thinking: liveAssistant.thinking, streaming: false
      })
    })

    it.each([undefined, true])('preserves a mounted persisted turn when both cache entries omit their entry IDs (reconciled=%s)', (historyReconciled) => {
      const existing: Array<Extract<TimelineItem, { kind: 'user' | 'assistant' }>> = [
        { ...liveUser, entryId: 'known-user', timestamp: entries[0].timestamp,
          images: [{ type: 'image', mimeType: previewPart.mimeType, data: previewPart.data }], historyReconciled },
        { ...liveAssistant, entryId: 'known-assistant', historyReconciled }
      ]
      const cache = existing.map(({ entryId: _entryId, ...row }) => ({
        ...row, id: row.id + 100, historyReconciled: undefined
      }))
      const restored = preserveTimelineToolState(existing, cache)
      expect(restored).toEqual(existing)
      expect(restored.map((item) => item.historyReconciled)).toEqual([historyReconciled, historyReconciled])
      expect(preserveTimelineToolState(restored, cache)).toEqual(existing)
    })

    it.each(historyReconciliations)('does not use a live compaction cache fingerprint as persisted entry proof through $name', ({ reconcile }) => {
      for (const historyReconciled of [undefined, true]) {
        const live: TimelineItem = { kind: 'compaction', id: 1203, summary: '上下文已压缩',
          compactionFingerprint: '["summary",null,1000]', live: true, historyReconciled }
        const cache: TimelineItem = { ...live, id: 1303 }
        const restored = reconcile([live], [cache])
        expect(restored).toHaveLength(1)
        expect(restored[0]).toMatchObject({ id: live.id, live: true, compactionFingerprint: live.compactionFingerprint })
        expect(restored[0].historyReconciled).not.toBe(true)
        const stored: TimelineItem = { ...cache, id: 1403, entryId: 'stored-compaction',
          live: undefined, historyReconciled: undefined }
        expect(reconcile(restored, [stored])).toEqual([
          expect.objectContaining({ id: live.id, entryId: 'stored-compaction', historyReconciled: true })
        ])
      }
    })

    it.each(assistantReconciliations)('binds a unique SDK-clock/full-body assistant without remounting through $name', ({ reconcile }) => {
      const other: TimelineItem = { ...liveAssistant, id: 1202,
        liveMessageId: 'backend:other-assistant', thinking: 'a different thought' }
      for (const historyReconciled of [undefined, true]) {
        const live: TimelineItem = { ...liveAssistant, historyReconciled }
        const [stored] = assistantPage(['unique-assistant'])
        const items = reconcile([other, live], [stored])
        expect(items).toHaveLength(2)
        expect(items.find((item) => item.id === live.id)).toMatchObject({
          entryId: 'unique-assistant', liveMessageId: liveAssistant.liveMessageId,
          messageTimestamp: liveAssistant.messageTimestamp, text: liveAssistant.text,
          thinking: liveAssistant.thinking, streaming: false, historyReconciled: true
        })
        expect(items.find((item) => item.id === other.id)).toEqual(other)
      }
    })

    it.each(assistantReconciliations)('does not pick the first of two equal-clock/full-body live assistants through $name', ({ reconcile }) => {
      const first: TimelineItem = { ...liveAssistant }
      const second: TimelineItem = { ...liveAssistant, id: 1202, liveMessageId: 'backend:other-assistant' }
      const incoming = assistantPage(['unidentified-assistant'])
      const items = reconcile([first, second], incoming)

      expect(items).toHaveLength(3)
      expect(items.filter((item) => item.kind === 'assistant' && item.liveMessageId)).toEqual([first, second])
      expect(items.filter((item) => item.kind === 'assistant' && item.entryId)).toEqual(incoming)
    })

    it.each(assistantReconciliations)('does not assign one live assistant to the first of two equal-clock/full-body disk entries through $name', ({ reconcile }) => {
      const live: TimelineItem = { ...liveAssistant }
      const incoming = assistantPage(['assistant-copy-a', 'assistant-copy-b'])
      const items = reconcile([live], incoming)

      expect(items).toHaveLength(3)
      expect(items.find((item) => item.id === live.id)).toEqual(live)
      expect(items.filter((item) => item.kind === 'assistant' && item.entryId)).toEqual(incoming)
    })

    it.each(assistantReconciliations)('does not bridge conflicting known assistant entry or live IDs through $name', ({ reconcile }) => {
      const [stored] = assistantPage(['stored-assistant'])
      const pairs: Array<[TimelineItem, TimelineItem]> = [
        [{ ...liveAssistant, entryId: 'different-entry' }, { ...stored, liveMessageId: liveAssistant.liveMessageId }],
        [{ ...liveAssistant }, { ...stored, liveMessageId: 'backend:different-assistant' }],
        [{ ...liveAssistant, entryId: 'stored-assistant' }, { ...stored, liveMessageId: 'backend:different-assistant' }]
      ]
      for (const [live, persisted] of pairs) {
        const items = reconcile([live], [persisted])
        expect(items).toHaveLength(2)
        expect(items.find((item) => item.id === live.id)).toEqual(live)
        expect(items.find((item) => item.id === persisted.id)).toEqual(persisted)
      }
    })

    it.each(assistantReconciliations)('requires the actual clock and the complete final assistant body through $name', ({ reconcile }) => {
      const live: TimelineItem = { ...liveAssistant }
      const [stored] = assistantPage(['different-assistant'])
      const differentMessages: TimelineItem[] = [
        { ...stored, messageTimestamp: undefined },
        { ...stored, messageTimestamp: sdkClock + 2 },
        { ...stored, text: 'final answer with another suffix' },
        { ...stored, thinking: 'a different thought' },
        { ...stored, error: 'provider unavailable' }
      ]
      for (const persisted of differentMessages) {
        const items = reconcile([live], [persisted])
        expect(items).toHaveLength(2)
        expect(items.find((item) => item.id === live.id)).toEqual(live)
        expect(items.find((item) => item.id === persisted.id)).toEqual(persisted)
      }
    })

    it.each(historyReconciliations)('does not make a colliding assistant body unique after an earlier stable-ID match through $name', ({ reconcile }) => {
      const first: TimelineItem = { ...liveAssistant }
      const second: TimelineItem = { ...liveAssistant, id: 1202, liveMessageId: 'backend:second-assistant' }
      const incoming = assistantPage(['first-assistant', 'unidentified-assistant'])
      incoming[0] = { ...incoming[0], liveMessageId: liveAssistant.liveMessageId }
      const items = reconcile([first, second], incoming)
      expect(items).toEqual([
        expect.objectContaining({ id: first.id, entryId: 'first-assistant', liveMessageId: first.liveMessageId }),
        incoming[1], second
      ])
    })

    it.each(historyReconciliations)('does not treat a streaming cache body as a completed assistant identity through $name', ({ reconcile }) => {
      const live: TimelineItem = { ...liveAssistant }
      const incoming: TimelineItem = { ...liveAssistant, id: 1301, liveMessageId: undefined, streaming: true }
      const items = reconcile([live], [incoming])
      expect(items).toEqual([incoming, live])
    })

    it('does not drop a reconciled prefix row when its persisted ID has a conflicting private live ID', () => {
      const rows: Array<Extract<TimelineItem, { kind: 'user' | 'assistant' }>> = [
        { ...liveUser, entryId: 'known-user', historyReconciled: true },
        { ...liveAssistant, entryId: 'known-assistant', historyReconciled: true }
      ]
      for (const row of rows) {
        const incoming: TimelineItem = { ...row, id: row.id + 100, liveMessageId: 'backend:different-message' }
        expect(reconcileNewerTimelineItems([row], [incoming])).toEqual({
          items: [row, incoming], appended: [incoming]
        })
      }
    })

    it('does not pick the first of duplicate stable live IDs in a cache projection', () => {
      for (const row of [liveUser, liveAssistant]) {
        const copies = [{ ...row, id: row.id + 100 }, { ...row, id: row.id + 200 }]
        const items = preserveTimelineToolState([row], copies)
        expect(items).toEqual([...copies, row])
      }
    })

    it.each(historyReconciliations)('keeps real repeated user sends with the same text and different SDK clocks through $name', ({ reconcile }) => {
      const users: TimelineItem[] = [
        { ...liveUser, text: 'same request' },
        { ...liveUser, id: 1202, text: 'same request', messageTimestamp: sdkClock + 2,
          liveMessageId: 'backend:second-user' }
      ]
      const repeatedEntries: WireEntry[] = [
        { ...entries[0], id: 'first-send', message: { role: 'user', timestamp: sdkClock, content: 'same request' } },
        { ...entries[0], id: 'second-send', parentId: 'first-send',
          message: { role: 'user', timestamp: sdkClock + 2, content: 'same request' } }
      ]
      const items = reconcile(users, entriesToTimeline(repeatedEntries))
      expect(items).toEqual([
        expect.objectContaining({ id: liveUser.id, entryId: 'first-send',
          liveMessageId: liveUser.liveMessageId, messageTimestamp: sdkClock, text: 'same request' }),
        expect.objectContaining({ id: 1202, entryId: 'second-send', liveMessageId: 'backend:second-user',
          messageTimestamp: sdkClock + 2, text: 'same request' })
      ])
      expect(reconcile(items, entriesToTimeline(repeatedEntries))).toEqual(items)
    })
  })

  it('retains an unpersisted partial on same-scope replacement, but a same-entry disk final is authoritative', () => {
    const draft: TimelineItem = { kind: 'assistant', id: 1999, entryId: 'same-message',
      messageTimestamp: 100, text: 'partial', thinking: 'partial thought', streaming: true, live: true }
    const unrelated: TimelineItem = { kind: 'user', id: 2000, entryId: 'page-user', text: 'history page' }
    expect(preserveTimelineToolState([draft], [unrelated])).toEqual([unrelated, draft])
    const final: TimelineItem = { kind: 'assistant', id: 2001, entryId: 'same-message',
      messageTimestamp: 100, text: 'disk final', thinking: '', streaming: false }
    const merged = preserveTimelineToolState([draft], [unrelated, final])
    expect(merged).toEqual([unrelated, expect.objectContaining({
      id: draft.id, text: 'disk final', thinking: '', streaming: false, historyReconciled: true
    })])
    const completed = { ...draft, text: 'stale live final', streaming: false }
    expect(preserveTimelineToolState([completed], [final])[0]).toMatchObject({
      id: draft.id, text: 'disk final', thinking: '', streaming: false
    })
  })

  it('keeps only unpersisted live rows on replacement and reconciles their first persisted copy without remounting', () => {
    const persisted: TimelineItem = { kind: 'user', id: 800, entryId: 'old', text: 'off window' }
    const draft: TimelineItem = { kind: 'assistant', id: 801, live: true,
      messageTimestamp: 100, text: 'partial', thinking: '', streaming: true }
    const user: TimelineItem = { kind: 'user', id: 802, entryId: 'new', text: 'new page' }
    expect(preserveTimelineToolState([persisted, draft], [user])).toEqual([user, draft])
    const final: TimelineItem = { kind: 'assistant', id: 803, entryId: 'final',
      messageTimestamp: 100, text: 'complete', thinking: '', streaming: false }
    expect(preserveTimelineToolState([persisted, draft], [user, final])).toEqual([
      user, expect.objectContaining({ id: draft.id, entryId: 'final', text: 'complete', streaming: false })
    ])
    expect(preserveTimelineToolState([persisted, draft], [user], false)).toEqual([user])
  })

  it('preserves mounted reconciled message keys without pulling off-window rows into repeated reads', () => {
    const first: TimelineItem = { kind: 'user', id: 820, entryId: 'send-1', liveMessageId: 'native-1',
      text: 'same', messageTimestamp: 100, live: true, historyReconciled: true }
    const second: TimelineItem = { ...first, id: 821, entryId: 'send-2', liveMessageId: 'native-2' }
    const offWindow: TimelineItem = { ...first, id: 822, entryId: 'off-window', liveMessageId: 'native-3' }
    const page = [first, second].map(({ liveMessageId: _liveId, ...row }, index) => ({ ...row, id: 900 + index }))
    const merged = preserveTimelineToolState([first, second, offWindow], page)
    expect(merged.map((row) => row.id)).toEqual([820, 821])
    expect(preserveTimelineToolState(merged, page).map((row) => row.id)).toEqual([820, 821])
    const final: TimelineItem = { kind: 'assistant', id: 823, entryId: 'assistant', liveMessageId: 'native-4',
      text: 'old final', thinking: '', streaming: false, live: true, historyReconciled: true }
    expect(preserveTimelineToolState([final], [{ ...final, id: 903, text: 'disk final' }])[0])
      .toMatchObject({ id: 823, text: 'disk final', liveMessageId: 'native-4', historyReconciled: true })
  })

  it('retains a located but unfinished live tool outside the next history window', () => {
    const active: TimelineItem = { kind: 'tool', id: 824, historyReconciled: true,
      tool: { id: 'active', name: 'read', status: 'running', live: true, resultReceived: false, isError: false } }
    const placeholder: TimelineItem = { ...active, id: 904,
      tool: { ...active.tool, status: 'done', live: undefined } }
    const first = preserveTimelineToolState([active], [placeholder])
    expect(first[0]).toMatchObject({ id: 824, tool: { status: 'running', resultReceived: false } })
    expect(preserveTimelineToolState(first, [])).toEqual(first)
    expect(preserveTimelineToolState(first, [], false)).toEqual([])
    const final: TimelineItem = { ...placeholder, tool: applyToolResult(placeholder.tool, { content: [{ type: 'text', text: 'finished' }] }, false, 'history') }
    const done = preserveTimelineToolState(first, [final])
    expect(done[0]).toMatchObject({ id: 824, tool: { status: 'done', resultReceived: true, outputText: 'finished' } })
    expect(preserveTimelineToolState(done, [])).toEqual([])
  })

  it('does not duplicate a pinned streaming row or regress a matching finalized image tool', () => {
    const current: TimelineItem = { kind: 'assistant', id: 810, live: true,
      messageTimestamp: 100, text: 'latest token', thinking: '', streaming: true }
    const stale = { ...current, text: 'stale token' }
    const tool: TimelineItem = { kind: 'tool', id: 811, tool: applyToolResult(imageTool,
      { content: [{ type: 'text', text: 'live final' }, previewPart] }, false, 'message') }
    const incoming: TimelineItem = { kind: 'tool', id: 812,
      tool: { ...imageTool, outputText: 'stale partial' } }
    const items = preserveTimelineToolState([tool, current], [incoming, stale])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: tool.id, tool: { outputText: 'live final', resultSource: 'message' } })
    expect(items[0].kind === 'tool' && items[0].tool.images).toBe(tool.tool.images)
    expect(items[1]).toBe(current)
  })

  it('projects native argument schemas without serializing MCP image payloads', () => {
    expect(parseToolArgs('codemode', { code: 'return await tools.read({ path: "README.md" })' })).toEqual({ command: 'return await tools.read({ path: "README.md" })' })
    expect(parseToolArgs('tool_search', { query: 'find browser tools', limit: 5 })).toEqual({ command: 'find browser tools' })
    expect(parseToolArgs('mcp__server__image', { data: previewPart.data, metadata: { secret: 'not-for-display' } })).toEqual({})
  })

  it('does not invent nested history rows or roots from execution-like parts', () => {
    const entries: WireEntry[] = [{ type: 'message', id: 'script-entry', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: {
      role: 'assistant', content: [
        { type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: 'return "done"' } },
        { type: 'toolCall', id: 'child', name: 'read', parentToolCallId: 'script', arguments: { path: 'file' } }
      ]
    } }, { type: 'message', id: 'child-result', parentId: 'script-entry', timestamp: '2026-01-01T00:00:01Z', message: {
      role: 'toolResult', toolCallId: 'child', toolName: 'read', parentToolCallId: 'script', content: [previewPart]
    } }]
    const rows = entriesToTimeline(entries)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tool', tool: { id: 'script', name: 'codemode' } })
    expect(entriesToTimeline(entries)[0].id).toBe(rows[0].id)
  })

  it('scales the initial history window to the available viewport', () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 })
    expect(getViewportHistoryPageSize()).toBe(8)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1_600 })
    expect(getViewportHistoryPageSize()).toBe(19)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 2_400 })
    expect(getViewportHistoryPageSize()).toBe(24)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('deduplicates paged items against live transcript entries', () => {
    const existing = [
      { kind: 'user' as const, id: 1, entryId: 'entry-1', text: '已有' },
      { kind: 'tool' as const, id: 2, tool: { id: 'tool-1', name: 'read', status: 'done' as const, isError: false } }
    ]
    const incoming = [
      { kind: 'user' as const, id: 3, entryId: 'entry-1', text: '重复' },
      { kind: 'assistant' as const, id: 4, entryId: 'entry-2', text: '新增', thinking: '', streaming: false }
    ]

    expect(uniqueTimelineItems(existing, incoming)).toEqual([incoming[1]])
  })

  it('places a persisted final assistant after messages that preceded its live row', () => {
    const liveError: TimelineItem = {
      kind: 'assistant',
      id: 5,
      messageTimestamp: 1_780_000_000_000,
      text: '',
      thinking: '',
      streaming: false,
      live: true,
      error: 'provider unavailable'
    }
    const persistedError: TimelineItem = {
      kind: 'assistant',
      id: 8,
      entryId: 'persisted-error',
      messageTimestamp: 1_780_000_000_000,
      text: '',
      thinking: '',
      streaming: false,
      error: 'provider unavailable'
    }
    const existing: TimelineItem[] = [
      { kind: 'user', id: 4, entryId: 'old', text: 'old page' },
      liveError
    ]
    const incoming: TimelineItem[] = [
      { kind: 'user', id: 6, entryId: 'middle', text: 'middle page' },
      { kind: 'user', id: 7, entryId: 'latest', text: 'latest page' },
      persistedError
    ]

    const reconciledError: TimelineItem = {
      ...liveError, entryId: persistedError.entryId, historyReconciled: true
    }
    expect(reconcileNewerTimelineItems(existing, incoming)).toEqual({
      items: [existing[0], incoming[0], incoming[1], reconciledError],
      appended: [incoming[0], incoming[1], reconciledError]
    })
  })

  it('links an image-free stable user projection to its unique persisted page without losing images', () => {
    const timestamp = 1_780_000_000_000
    const live: TimelineItem = { kind: 'user', id: 301, live: true,
      liveMessageId: 'backend-a:1', messageTimestamp: timestamp, text: 'install' }
    const stored: Extract<TimelineItem, { kind: 'user' }> = { kind: 'user', id: 302, entryId: 'user-a',
      messageTimestamp: timestamp, text: 'install', images: [{ type: 'image' as const, mimeType: 'image/png', data: 'original' }] }
    const result = reconcileNewerTimelineItems([live], [stored])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ id: live.id, liveMessageId: 'backend-a:1',
      entryId: 'user-a', images: stored.images, historyReconciled: true })
  })

  it('does not assign a persisted user to ambiguous equal-time live or incoming users', () => {
    const timestamp = 1_780_000_000_000
    const live: TimelineItem = { kind: 'user', id: 303, live: true,
      liveMessageId: 'backend-a:1', messageTimestamp: timestamp, text: 'same' }
    const stored: TimelineItem = { kind: 'user', id: 305, entryId: 'user-a',
      messageTimestamp: timestamp, text: 'same' }
    expect(reconcileNewerTimelineItems([live, { ...live, id: 304, liveMessageId: 'backend-a:2' }], [stored]).items).toHaveLength(3)
    expect(reconcileNewerTimelineItems([live], [stored, { ...stored, id: 306, entryId: 'user-b' }]).items).toHaveLength(3)
    expect(reconcileNewerTimelineItems([live], [{ ...stored, liveMessageId: 'backend-a:2' }]).items).toHaveLength(2)
  })

  it('matches same-timestamp live assistants one-to-one by final content', () => {
    const timestamp = 1_780_000_000_000
    const liveFirst: TimelineItem = {
      kind: 'assistant', id: 9, messageTimestamp: timestamp,
      text: 'first', thinking: '', streaming: false, live: true
    }
    const liveSecond: TimelineItem = {
      kind: 'assistant', id: 10, messageTimestamp: timestamp,
      text: 'second', thinking: '', streaming: false, live: true
    }
    const persistedSecond: TimelineItem = {
      kind: 'assistant', id: 11, entryId: 'second', messageTimestamp: timestamp,
      text: 'second', thinking: '', streaming: false
    }

    const reconciledSecond: TimelineItem = {
      ...liveSecond, entryId: persistedSecond.entryId, historyReconciled: true
    }
    expect(reconcileNewerTimelineItems([liveFirst, liveSecond], [persistedSecond])).toEqual({
      items: [reconciledSecond, liveFirst],
      appended: [reconciledSecond]
    })
  })

  it('reconciles a persisted final snapshot seen before message_end without changing its key', () => {
    const streaming: TimelineItem = {
      kind: 'assistant', id: 23, messageTimestamp: 1_780_000_000_002,
      text: 'partial', thinking: '', streaming: true, live: true, error: 'provisional error'
    }
    const persisted: TimelineItem = {
      kind: 'assistant', id: 24, entryId: 'stored-before-event', messageTimestamp: streaming.messageTimestamp,
      text: 'final response', thinking: 'final thinking', streaming: false
    }
    const reconciled = reconcileNewerTimelineItems([streaming], [persisted])

    expect(reconciled.items).toHaveLength(1)
    expect(reconciled.items[0]).toMatchObject({
      id: streaming.id, entryId: persisted.entryId, text: 'final response', thinking: 'final thinking',
      streaming: false, historyReconciled: true
    })
    expect(reconciled.items[0]).not.toHaveProperty('error')
  })

  it('keeps an unmatched streaming assistant pinned after appended history', () => {
    const live: TimelineItem = {
      kind: 'assistant', id: 12, messageTimestamp: 1_780_000_000_001,
      text: 'streaming', thinking: '', streaming: true, live: true
    }
    const existing: TimelineItem[] = [{ kind: 'user', id: 11, entryId: 'old', text: 'old' }, live]
    const incoming: TimelineItem[] = [{ kind: 'user', id: 13, entryId: 'newer', text: 'newer' }]

    expect(reconcileNewerTimelineItems(existing, incoming)).toEqual({
      items: [existing[0], incoming[0], live],
      appended: incoming
    })
  })

  it('moves live user, tool, and compaction rows behind newly loaded history', () => {
    const liveUser: TimelineItem = {
      kind: 'user', id: 14, entryId: 'live-user', text: 'live user', live: true
    }
    const liveTool: TimelineItem = {
      kind: 'tool', id: 15,
      tool: { id: 'tool-call', name: 'read', status: 'done', isError: false, live: true }
    }
    const liveCompaction: TimelineItem = {
      kind: 'compaction', id: 16, entryId: 'live-compaction', summary: '上下文已压缩', live: true
    }
    const existing: TimelineItem[] = [
      { kind: 'user', id: 13, entryId: 'old', text: 'old' },
      liveUser,
      liveTool,
      liveCompaction
    ]
    const middle: TimelineItem = { kind: 'user', id: 17, entryId: 'middle', text: 'middle' }
    const afterLive: TimelineItem = { kind: 'user', id: 21, entryId: 'after-live', text: 'after live' }
    const incoming: TimelineItem[] = [
      middle,
      { ...liveUser, id: 18, live: undefined },
      { ...liveTool, id: 19, tool: { ...liveTool.tool, live: undefined } },
      { ...liveCompaction, id: 20, live: undefined },
      afterLive
    ]

    const placedUser = { ...liveUser, timestamp: undefined, historyReconciled: true }
    const placedTool = { ...liveTool, historyReconciled: true }
    const placedCompaction = { ...liveCompaction, historyReconciled: true }
    const reconciled = reconcileNewerTimelineItems(existing, incoming)
    expect(reconciled).toEqual({
      items: [existing[0], middle, placedUser, placedTool, placedCompaction, afterLive],
      appended: [middle, placedUser, placedTool, placedCompaction, afterLive]
    })
    const next: TimelineItem = { kind: 'user', id: 22, entryId: 'next', text: 'next page' }
    expect(reconcileNewerTimelineItems(reconciled.items, [afterLive, next])).toEqual({
      items: [...reconciled.items, next],
      appended: [next]
    })
  })

  it('projects pure and mixed final image results without treating image data as text', () => {
    const pure = applyToolResult(imageTool, { content: [previewPart] }, false)
    expect(pure).toMatchObject({
      status: 'done', resultReceived: true, outputText: '',
      images: [{ ...previewPart, width: 1, height: 1, partIndex: 0 }]
    })
    expect(pure.imageNotice).toBeUndefined()

    const mixed = applyToolResult(imageTool, {
      content: [{ type: 'text', text: '已保存 images/result.png' }, previewPart, { type: 'text', text: '小图预览' }],
      details: { imageGeneration: { path: 'images/result.png', width: 1024, height: 1024, byteLength: 100_000 } }
    }, false)
    expect(mixed.outputText).toBe('已保存 images/result.png\n小图预览')
    expect(mixed.images).toEqual([{ ...previewPart, width: 1, height: 1, partIndex: 1 }])
    expect(mixed.path).toBe('images/result.png')
    expect(mixed).not.toHaveProperty('details')
  })

  it.each([
    { model: undefined, requestedModel: CODEX_IMAGE_REQUEST_ALIAS, label: 'Codex 自动（官方别名）', experimental: false },
    { model: 'gpt-image-2.5-flare', requestedModel: 'gpt-image-2.5-flare', label: 'Images 2.5 Flare（实验性）', experimental: true },
    { model: 'gpt-image-2.5-sunburst', requestedModel: 'gpt-image-2.5-sunburst', label: 'Images 2.5 Sunburst（实验性）', experimental: true },
    { model: 'unknown-sensitive-string', requestedModel: null, label: '未知请求型号', experimental: false },
    { model: null, requestedModel: null, label: '未知请求型号', experimental: false }
  ])('previews only allowlisted request models from tool arguments: $model', ({ model, requestedModel, label, experimental }) => {
    expect(parseToolArgs(IMAGE_GENERATION_TOOL_NAME, { path: 'images/request.png', model })).toEqual({
      path: 'images/request.png', imageModelInfo: { requestedModel, requestLabel: label, experimental, resolvedModel: null }
    })
    expect(parseToolArgs('read', { model, path: 'images/request.png' })).toEqual({ path: 'images/request.png' })
  })

  it.each([
    { args: {}, expected: undefined },
    { args: { size: '2048x3072', quality: 'high' }, expected: { requestedSize: '2048x3072', requestedQuality: 'high' } },
    { args: { size: 'auto', quality: 'auto', referenced_image_paths: [] },
      expected: { requestedSize: 'auto', requestedQuality: 'auto', referenceCount: 0, operation: 'generate' } },
    { args: { referenced_image_paths: ['images/source.png', 'images/other.jpeg'] },
      expected: { referenceCount: 2, operation: 'edit' } },
    { args: { size: 'bad-size-sensitive', quality: 'medium', referenced_image_paths: ['images/source.png'] },
      expected: { requestedQuality: 'medium', referenceCount: 1, operation: 'edit' } },
    { args: { size: '1024x1536', quality: 'bad-quality-sensitive', referenced_image_paths: ['../private.png'] },
      expected: { requestedSize: '1024x1536' } },
    { args: { referenced_image_paths: Array.from({ length: 5 }, (_, index) => `images/source-${index}.jpg`) },
      expected: { referenceCount: 5, operation: 'edit' } },
    { args: { referenced_image_paths: Array(6).fill('images/source.png') }, expected: undefined },
    { args: { referenced_image_paths: 'images/source.png' }, expected: undefined },
    { args: { referenced_image_paths: null }, expected: undefined },
    { args: { requestedSize: '2048x3072', requestedQuality: 'high', operation: 'edit', referenceCount: 5,
        width: 4096, height: 4096, byteLength: 100_000, mask: 'images/source.png' }, expected: undefined }
  ])('projects only explicit valid image arguments, with no absent defaults or original metadata: %j', ({ args, expected }) => {
    const result = parseToolArgs(IMAGE_GENERATION_TOOL_NAME, args)
    expect(result.imageSettingsInfo).toEqual(expected)
    expect(result.imageSettingsInfo ?? {}).not.toHaveProperty('savedWidth')
    expect(result.imageSettingsInfo ?? {}).not.toHaveProperty('savedHeight')
    expect(result.imageSettingsInfo ?? {}).not.toHaveProperty('savedByteLength')
    expect(JSON.stringify(result)).not.toContain('images/source')
    expect(JSON.stringify(result)).not.toContain('private.png')
    expect(JSON.stringify(result)).not.toContain('sensitive')
    expect(parseToolArgs('read', args).imageSettingsInfo).toBeUndefined()
  })

  it.each([1, 2])('replays v%s original dimensions without backfilling missing settings from call arguments', (version) => {
    const metadata = Object.freeze({ version, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
      requestedModel: CODEX_IMAGE_REQUEST_ALIAS, path: 'images/saved.png', width: 1024, height: 1536,
      byteLength: 100_000, actualSize: '4096x4096', quality: 'untrusted-quality-echo',
      referenced_image_paths: ['images/private-source.png'], referenceBytes: 'original-sensitive-bytes' })
    const entries: WireEntry[] = [
      { type: 'message', id: 'settings-call', parentId: null, timestamp: '', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: imageTool.id, name: imageTool.name,
          arguments: { path: 'images/argument.png', size: '2048x3072', quality: 'high',
            referenced_image_paths: ['images/argument-source.png'], width: 2048, height: 3072 } }]
      } },
      { type: 'message', id: 'settings-result', parentId: 'settings-call', timestamp: '', message: {
        role: 'toolResult', toolCallId: imageTool.id, toolName: imageTool.name, isError: false,
        content: [previewPart], details: { imageGeneration: metadata }
      } }
    ]
    const before = JSON.stringify(entries)
    const replay = entriesToTimeline(entries)
    if (replay[0]?.kind !== 'tool') throw new Error('Missing tool')
    expect(replay[0].tool.imageSettingsInfo).toEqual({ savedWidth: 1024, savedHeight: 1536, savedByteLength: 100_000 })
    expect(replay[0].tool.images?.[0]).toMatchObject({ width: 1, height: 1 })
    expect(JSON.stringify(replay)).not.toContain('private-source')
    expect(JSON.stringify(replay)).not.toContain('argument-source')
    expect(JSON.stringify(replay)).not.toContain('original-sensitive-bytes')
    expect(JSON.stringify(replay)).not.toContain('untrusted-quality-echo')
    expect(JSON.stringify(entries)).toBe(before)
  })

  it('keeps request settings separate from saved PNG dimensions and ignores damaged fields independently', () => {
    const result = applyToolResult({ ...imageTool, ...parseToolArgs(imageTool.name, {
      size: '1024x1024', quality: 'low', referenced_image_paths: []
    }) }, {
      content: [previewPart], details: { imageGeneration: {
        version: 2, provider: 'openai-codex', operation: 'edit', requestedSize: '2048x3072',
        requestedQuality: 'high', referenceCount: 2, width: 1024, height: 1536, byteLength: 100_000,
        actualQuality: 'untrusted-quality-echo', actualWidth: 4096, actualHeight: 4096,
        referenced_image_paths: ['images/private-source.png'], referenceBytes: 'original-sensitive-bytes'
      } }
    }, false)
    expect(result.imageSettingsInfo).toEqual({ operation: 'edit', requestedSize: '2048x3072',
      requestedQuality: 'high', referenceCount: 2, savedWidth: 1024, savedHeight: 1536, savedByteLength: 100_000 })
    expect(result.images?.[0]).toMatchObject({ width: 1, height: 1 })
    expect(JSON.stringify(result)).not.toContain('untrusted-quality-echo')
    expect(JSON.stringify(result)).not.toContain('private-source')
    expect(JSON.stringify(result)).not.toContain('original-sensitive-bytes')
    const damaged = applyToolResult(result, { content: [previewPart], details: { imageGeneration: {
      version: 2, provider: 'openai-codex', operation: 'unknown-sensitive-operation',
      requestedSize: '2048X3072', requestedQuality: 'medium', referenceCount: 6,
      width: 1024, height: 1536, byteLength: 'unknown-sensitive-bytes'
    } } }, false, 'message')
    expect(damaged.imageSettingsInfo).toEqual({ requestedQuality: 'medium', savedWidth: 1024, savedHeight: 1536 })
    expect(damaged.images).toBe(result.images)
    expect(JSON.stringify(damaged)).not.toContain('unknown-sensitive')
  })

  it.each([
    undefined,
    {},
    { version: 99, provider: 'openai-codex' },
    { version: 2, provider: 'other-provider' }
  ])('clears argument settings for missing or unsupported final metadata: %j', (metadata) => {
    const requested = { ...imageTool, ...parseToolArgs(imageTool.name, {
      size: '2048x3072', quality: 'high', referenced_image_paths: ['images/source.png']
    }) }
    const result = applyToolResult(requested, { content: [previewPart], details: {
      imageGeneration: metadata && { ...metadata, operation: 'edit', requestedSize: '2048x3072',
        requestedQuality: 'high', referenceCount: 1, width: 1024, height: 1536 }
    } }, false, 'history')
    expect(result.imageSettingsInfo).toBeUndefined()
    expect(result.images).toHaveLength(1)
  })

  it.each([
    { metadata: { version: 1, provider: 'openai-codex', model: CODEX_IMAGE_REQUEST_ALIAS,
        requestedModel: 'gpt-image-2.5-flare' },
      requestedModel: CODEX_IMAGE_REQUEST_ALIAS, label: 'Codex 自动（官方别名）', experimental: false },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare',
        model: CODEX_IMAGE_REQUEST_ALIAS },
      requestedModel: 'gpt-image-2.5-flare', label: 'Images 2.5 Flare（实验性）', experimental: true },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-sunburst' },
      requestedModel: 'gpt-image-2.5-sunburst', label: 'Images 2.5 Sunburst（实验性）', experimental: true },
    { metadata: { version: 1, provider: 'openai-codex', model: 'unknown-sensitive-string' },
      requestedModel: null, label: '未知请求型号', experimental: false },
    { metadata: { version: 2, provider: 'openai-codex', requestedModel: 'unknown-sensitive-string' },
      requestedModel: null, label: '未知请求型号', experimental: false }
  ])('replays v$metadata.version request metadata without trusting an actual-model echo: $label', ({ metadata, requestedModel, label, experimental }) => {
    const generated = Object.freeze({ ...metadata, resolvedModel: 'gpt-image-2.5-sunburst',
      actualModel: 'untrusted-provider-echo', path: 'images/saved.png', mimeType: 'image/png',
      byteLength: 100_000, width: 1024, height: 1024, previewAvailable: true })
    const entries: WireEntry[] = [
      { type: 'message', id: 'model-call', parentId: null, timestamp: '', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: imageTool.id, name: imageTool.name,
          arguments: { path: 'images/argument.png', model: 'gpt-image-2.5-sunburst' } }]
      } },
      { type: 'message', id: 'model-result', parentId: 'model-call', timestamp: '', message: {
        role: 'toolResult', toolCallId: imageTool.id, toolName: imageTool.name, isError: false,
        content: [previewPart], details: { imageGeneration: generated }
      } }
    ]
    const original = JSON.stringify(entries)
    const replay = entriesToTimeline(entries)
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({ kind: 'tool', historical: true, tool: {
      path: 'images/saved.png', resultSource: 'history',
      images: [{ partIndex: 0, width: 1, height: 1 }],
      imageModelInfo: { requestedModel, requestLabel: label, experimental, resolvedModel: null }
    } })
    if (replay[0].kind !== 'tool') throw new Error('Missing historical tool')
    expect(replay[0].tool.imageModelInfo).not.toHaveProperty('actualModel')
    expect(replay[0].tool).not.toHaveProperty('details')
    expect(JSON.stringify(entries)).toBe(original)
    expect(entriesToTimeline(entries)[0].id).toBe(replay[0].id)
  })

  it.each([
    {},
    { version: 99, provider: 'openai-codex', requestedModel: 'gpt-image-2.5-flare' },
    { version: 2, provider: 'other-provider', requestedModel: 'gpt-image-2.5-flare' }
  ])('keeps paths and valid previews when saved model metadata is missing or damaged: %j', (metadata) => {
    const result = applyToolResult({ ...imageTool, ...parseToolArgs(imageTool.name, {}) }, {
      content: [previewPart], details: { imageGeneration: { ...metadata,
        path: 'images/saved.png', resolvedModel: 'unknown-sensitive-string' } }
    }, false, 'history')
    expect(result.path).toBe('images/saved.png')
    expect(result.images).toEqual([{ ...previewPart, width: 1, height: 1, partIndex: 0 }])
    expect(result.imageModelInfo).toBeUndefined()
  })

  it('keeps valid bounded previews and reports invalid or over-limit image parts', () => {
    const rejected = applyToolResult(imageTool, {
      content: [
        { type: 'text', text: '保留文字' },
        { ...previewPart, data: 'not-base64!' },
        { ...previewPart, mimeType: 'image/svg+xml' },
        { ...previewPart, data: 'A'.repeat(MAX_TOOL_IMAGE_BASE64_LENGTH + 4) },
        previewPart
      ]
    }, false)
    expect(rejected.outputText).toBe('保留文字')
    expect(rejected.images).toEqual([{ ...previewPart, width: 1, height: 1, partIndex: 4 }])
    expect(rejected.imageNotice).toBe('部分图片因格式或大小限制未显示。')

    const overCount = applyToolResult(imageTool, { content: Array.from({ length: MAX_TOOL_IMAGES + 1 }, () => previewPart) }, false)
    expect(overCount.images?.map(({ partIndex }) => partIndex)).toEqual([0, 1, 2, 3])
    expect(overCount.imageNotice).toBe(rejected.imageNotice)
    const replaced = applyToolResult(rejected, { content: [{ type: 'text', text: 'new final' }] }, false)
    expect(replaced.images).toEqual([])
    expect(replaced.imageNotice).toBeUndefined()
  })

  it('replays final previews through the same projection with stable tool and part identities', () => {
    const payload = { content: [{ type: 'text', text: '已保存' }, previewPart] }
    const entries: WireEntry[] = [
      {
        type: 'message', id: 'image-assistant', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: imageTool.id, name: imageTool.name, arguments: {} }] }
      },
      {
        type: 'message', id: 'image-result', parentId: 'image-assistant', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'toolResult', toolCallId: imageTool.id, toolName: imageTool.name, isError: false, ...payload }
      }
    ]
    const first = entriesToTimeline(entries)
    const second = entriesToTimeline(entries)
    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first[0]).toMatchObject({
      kind: 'tool', historical: true,
      tool: applyToolResult({ id: imageTool.id, name: imageTool.name, status: 'running', isError: false }, payload, false, 'history')
    })
    expect(first[0].kind === 'tool' && first[0].tool.live).toBeUndefined()
  })

  it('finishes a running live tool from its persisted page while retaining its key and live tail order', () => {
    const live: TimelineItem = { kind: 'tool', id: 40, tool: { ...imageTool, outputText: '生成中' }, noReveal: true }
    const tail: TimelineItem[] = [
      { kind: 'tool', id: 41, tool: { id: 'tail-tool', name: 'read', status: 'running', isError: false, live: true } },
      { kind: 'assistant', id: 42, text: 'live tail', thinking: '', streaming: true, live: true }
    ]
    const finalTool = applyToolResult({ ...imageTool, live: undefined }, { content: [previewPart] }, false)
    const page: TimelineItem[] = [
      { kind: 'user', id: 43, entryId: 'middle-image', text: 'middle' },
      { kind: 'tool', id: 44, tool: finalTool, historical: true },
      { kind: 'user', id: 45, entryId: 'after-image', text: 'after' }
    ]
    const merged = reconcileNewerTimelineItems([live, ...tail], page)
    expect(merged.items.map(({ id }) => id)).toEqual([43, live.id, 45, 41, 42])
    expect(merged.items[1]).toMatchObject({
      noReveal: true, historyReconciled: true,
      tool: { status: 'done', outputText: '', live: true, images: finalTool.images }
    })
    expect(merged.items[1].kind === 'tool' && merged.items[1].tool.images).toBe(finalTool.images)
  })

  it('does not overwrite an already final live tool with an older page result', () => {
    const live: TimelineItem = {
      kind: 'tool', id: 46,
      tool: applyToolResult(imageTool, { content: [previewPart, { type: 'text', text: 'new final' }] }, false)
    }
    const persisted: TimelineItem = {
      kind: 'tool', id: 47,
      tool: applyToolResult({ ...imageTool, live: undefined }, { content: [{ type: 'text', text: 'old final' }] }, true)
    }
    const merged = reconcileNewerTimelineItems([live], [persisted])
    expect(merged.items).toEqual([{ ...live, historyReconciled: true }])
    expect(merged.items[0].kind === 'tool' && merged.items[0].tool).toBe(live.tool)
  })

  it('does not finish a call-only page but accepts a later overlapping final without moving the prefix', () => {
    const live: TimelineItem = { kind: 'tool', id: 48, tool: imageTool }
    const callOnly: TimelineItem = {
      kind: 'tool', id: 49, tool: { ...imageTool, live: undefined, status: 'done' }
    }
    const first = reconcileNewerTimelineItems([live], [callOnly])
    expect(first.items[0]).toMatchObject({ id: live.id, tool: { status: 'running' }, historyReconciled: true })
    const after: TimelineItem = { kind: 'user', id: 50, entryId: 'after-call', text: 'after' }
    const final: TimelineItem = {
      ...callOnly, tool: applyToolResult(callOnly.tool, { content: [previewPart] }, false)
    }
    const completed = reconcileNewerTimelineItems([...first.items, after], [final])
    expect(completed.appended).toEqual([])
    expect(completed.items.map(({ id }) => id)).toEqual([live.id, after.id])
    expect(completed.items[0]).toMatchObject({ tool: { status: 'done', images: final.tool.images } })
  })

  it('fills a call-only historical done row from a later result without moving its key', () => {
    const callOnly: TimelineItem = {
      kind: 'tool', id: 151, historical: true,
      tool: { ...imageTool, live: undefined, status: 'done', resultReceived: undefined }
    }
    const after: TimelineItem = { kind: 'user', id: 152, entryId: 'after-image', text: 'after' }
    const final: TimelineItem = {
      kind: 'tool', id: 153,
      tool: applyToolResult({ ...imageTool, live: undefined }, { content: [previewPart] }, false, 'history')
    }
    const reconciled = reconcileNewerTimelineItems([callOnly, after], [final])
    expect(reconciled.items.map(({ id }) => id)).toEqual([callOnly.id, after.id])
    expect(reconciled.appended).toEqual([])
    expect(reconciled.items[0]).toMatchObject({
      historical: true, tool: { images: final.tool.images, resultReceived: true, resultSource: 'history' }
    })
  })

  it('counts display-diff additions and deletions', () => {
    expect(diffStats(' 4 context\n-5 old\n+5 new\n+6 next')).toEqual({ additions: 2, deletions: 1 })
  })

  it('keeps the latest tool result and task snapshot', () => {
    const tool: ToolItem = { id: 't1', name: 'pion_task', status: 'running', isError: false }
    const result = applyToolResult(tool, {
      content: [{ type: 'text', text: 'updated' }],
      details: { tasks: [{ id: 1, subject: 'Validate', status: 'in_progress' }] }
    }, false)

    expect(result).toMatchObject({ status: 'done', outputText: 'updated' })
    expect(result.todos).toEqual([
      expect.objectContaining({ id: 1, title: 'Validate', status: 'in_progress' })
    ])
  })

  it('derives changes only after the latest user turn', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'old' },
      { kind: 'tool', id: 2, tool: { id: 'a', name: 'write', status: 'done', isError: false, path: 'old.ts', writeContent: 'old' } },
      { kind: 'user', id: 3, text: 'new' },
      { kind: 'tool', id: 4, tool: { id: 'b', name: 'edit', status: 'done', isError: false, path: 'new.ts', diff: '-1 old\n+1 new' } }
    ]

    expect(deriveLatestRunChanges(timeline)).toEqual([
      { path: 'new.ts', kind: 'edit', diff: '-1 old\n+1 new', additions: 1, deletions: 1 }
    ])
  })

  it('retains every captured edit for the same file in the current turn', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'update twice' },
      { kind: 'tool', id: 2, tool: { id: 'a', name: 'edit', status: 'done', isError: false, path: 'src/a.ts', diff: '-1 old\n+1 middle' } },
      { kind: 'tool', id: 3, tool: { id: 'b', name: 'edit', status: 'done', isError: false, path: 'src/a.ts', diff: '-3 before\n+3 after' } }
    ]

    expect(deriveLatestRunChanges(timeline)).toEqual([
      {
        path: 'src/a.ts',
        kind: 'edit',
        diff: '-1 old\n+1 middle\n  ...\n-3 before\n+3 after',
        additions: 2,
        deletions: 2
      }
    ])
  })

  it('replays persisted task snapshots into the current plan', () => {
    const timeline = entriesToTimeline([
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Implement tests' }
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'pion_task', arguments: {} }] }
      },
      {
        type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'toolResult', toolCallId: 't1', toolName: 'pion_task', isError: false,
          content: [{ type: 'text', text: 'ok' }],
          details: { tasks: [{ id: 1, subject: 'Implement tests', status: 'pending' }] }
        }
      }
    ])

    expect(deriveAgentTodos(timeline)).toEqual([
      expect.objectContaining({ title: 'Implement tests', status: 'pending' })
    ])
  })

  it('keeps a completed plan until the next turn starts planning', () => {
    const completedPlan: TimelineItem[] = [
      { kind: 'user', id: 1, entryId: 'u1', text: 'First turn' },
      {
        kind: 'tool',
        id: 2,
        tool: {
          id: 'tasks-1',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: [{ id: 1, title: 'Finish first turn', status: 'completed' }]
        }
      },
      { kind: 'user', id: 3, entryId: 'u2', text: 'Second turn' }
    ]

    expect(deriveAgentTodos(completedPlan)).toEqual([
      { id: 1, title: 'Finish first turn', status: 'completed' }
    ])

    const clearedPlan: TimelineItem[] = [
      ...completedPlan,
      {
        kind: 'tool',
        id: 4,
        tool: {
          id: 'tasks-2',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: []
        }
      }
    ]
    expect(deriveAgentTodos(clearedPlan)).toBeNull()

    expect(deriveAgentTodos([
      ...clearedPlan,
      {
        kind: 'tool',
        id: 5,
        tool: {
          id: 'tasks-3',
          name: 'pion_task',
          status: 'done',
          isError: false,
          todos: [{ id: 1, title: 'Start second turn', status: 'pending' }]
        }
      }
    ])).toEqual([{ id: 1, title: 'Start second turn', status: 'pending' }])
  })

  it('produces stable ids across rebuilds of the same entries', () => {
    const entries = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: '问题' }] }
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }
          ]
        }
      }
    ] as never[]
    const first = entriesToTimeline(entries).map((item) => item.id)
    const second = entriesToTimeline(entries).map((item) => item.id)
    expect(second).toEqual(first)
    expect(new Set(first).size).toBe(first.length)
  })

  it('extracts real assistant diagnostics but suppresses aborted messages by stop reason', () => {
    expect(assistantErrorText({ role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable' }))
      .toBe('provider unavailable')
    expect(assistantErrorText({ role: 'assistant', stopReason: 'error', errorMessage: 'Request was aborted' }))
      .toBe('Request was aborted')
    expect(assistantErrorText({ role: 'assistant', stopReason: 'error', content: [] }))
      .toBe('模型请求失败，但提供商未返回技术详情。')
    expect(assistantErrorText({ role: 'assistant', stopReason: 'stop', errorMessage: 'stale diagnostic' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', stopReason: 'aborted', errorMessage: 'This operation was aborted' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', errorMessage: 'Request was aborted' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', errorMessage: 'request aborted.' }))
      .toBeUndefined()
    expect(assistantErrorText({ role: 'assistant', content: 'not an errorMessage' }))
      .toBeUndefined()
  })

  it('replays pure and partial assistant errors with stable historical identity', () => {
    const entries = [
      {
        type: 'message', id: 'error-only', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant', content: [], timestamp: 1_780_000_000_000,
          stopReason: 'error', errorMessage: 'provider unavailable'
        }
      },
      {
        type: 'message', id: 'partial-error', parentId: 'error-only', timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '正在检查' },
            { type: 'text', text: '部分回答' }
          ],
          stopReason: 'error',
          errorMessage: 'connection lost'
        }
      },
      {
        type: 'message', id: 'aborted', parentId: 'partial-error', timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'assistant', content: [], stopReason: 'aborted',
          errorMessage: 'This operation was aborted by the provider SDK'
        }
      }
    ] as never[]

    const first = entriesToTimeline(entries)
    const second = entriesToTimeline(entries)

    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({
      kind: 'assistant',
      entryId: 'error-only',
      messageTimestamp: 1_780_000_000_000,
      text: '',
      thinking: '',
      streaming: false,
      error: 'provider unavailable',
      historical: true
    })
    expect(first[1]).toMatchObject({
      kind: 'assistant',
      entryId: 'partial-error',
      text: '部分回答',
      thinking: '正在检查',
      streaming: false,
      error: 'connection lost',
      historical: true
    })
    expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id))
    expect(second.map((item) => item.kind === 'assistant' ? item.entryId : undefined))
      .toEqual(['error-only', 'partial-error'])
    expect(second.every((item) => item.historical)).toBe(true)
  })
})
