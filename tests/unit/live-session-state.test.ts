import { describe, expect, it } from 'vitest'
import { LIVE_MAX_BYTES, LIVE_MAX_ROWS, LiveSessionProjection } from '../../src/main/agent/live-session-state'
import type { WireEntry, WireEvent, WireEventInput, WireMessage } from '../../src/shared/types'

function messageOf(event: WireEventInput | undefined): WireMessage {
  if (event?.type !== 'message_start' && event?.type !== 'message_end') throw new Error('Expected a message lifecycle event')
  return (event as Extract<WireEvent, { type: 'message_start' | 'message_end' }>).message
}

function entryOf(event: WireEventInput | undefined): WireEntry {
  if (event?.type !== 'entry_appended') throw new Error('Expected an appended entry event')
  return (event as Extract<WireEvent, { type: 'entry_appended' }>).entry
}

const start = (state: LiveSessionProjection, timestamp = 1) => state.record({ type: 'message_start', message: { role: 'assistant', timestamp, content: [] } })
const delta = (state: LiveSessionProjection, text: string) => state.record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })

describe('bounded backend live projection', () => {
  it('compacts background tokens and advances revisions even for ignored root lifecycle events', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'agent_start' }); start(state)
    delta(state, 'one'); delta(state, 'two')
    state.record({ type: 'queue_update', followUp: ['next'] })
    const snapshot = state.snapshot('/project', '/session')
    expect(snapshot.revision).toBe(5)
    expect(snapshot.events).toEqual([
      { type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [], _pionLiveMessageId: `${state.backendId}:1` } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'onetwo' } }
    ])
    delta(state, 'later')
    expect(JSON.stringify(snapshot)).not.toContain('later')
    state.record({ type: 'agent_settled' })
    expect(state.snapshot('/project').events).toHaveLength(2)
    state.record({ type: 'agent_start' })
    expect(state.snapshot('/project').events).toEqual([])
  })

  it('keeps sequential assistants distinct, associates disk identity and respects empty final messages', () => {
    const state = new LiveSessionProjection(); start(state, 10); delta(state, 'discard draft')
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'persisted', timestamp: 'date', message: { role: 'assistant', timestamp: 10, content: [] } } })
    state.record({ type: 'message_end', message: { role: 'assistant', timestamp: 10, content: [] } })
    start(state, 11); delta(state, 'new draft')
    const events = state.snapshot('/project').events
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_end', 'entry_appended', 'message_start', 'message_update'])
    expect(JSON.stringify(events)).not.toContain('discard draft')
    expect(JSON.stringify(events)).toContain('persisted')
  })

  it('does not replay nested rows, raw model objects or arbitrary result details', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'message_start', parentToolCallId: 'parent', message: { role: 'assistant' } })
    state.record({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: { path: 'file' } })
    state.record({ type: 'tool_execution_end', toolCallId: 't', result: { content: [{ type: 'text', text: 'done' }], details: { secret: 'not retained' }, model: { apiKey: 'private' } } })
    state.record({ type: 'message_end', message: { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'authoritative' }] } })
    state.record({ type: 'tool_execution_end', toolCallId: 't', result: { content: [{ type: 'text', text: 'late' }] } })
    const snapshot = state.snapshot('/project')
    expect(snapshot.revision).toBe(4)
    expect(snapshot.events.map((e) => e.type)).toEqual(['tool_execution_start', 'message_end'])
    expect(JSON.stringify(snapshot)).toContain('authoritative')
    expect(JSON.stringify(snapshot)).not.toMatch(/late|private|not retained/)
  })

  it('rejects original/oversized images while retaining validated static previews only', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'tool_execution_start', toolCallId: 'image', toolName: 'pion_generate_image', args: {} })
    state.record({ type: 'tool_execution_end', toolCallId: 'image', result: { content: [
      { type: 'image', mimeType: 'image/png', data: 'a'.repeat(200_000) },
      { type: 'image', mimeType: 'image/svg+xml', data: 'unsafe' },
      { type: 'text', text: 'saved image.png' }
    ] } })
    const snapshot = state.snapshot('/project')
    expect(snapshot.truncated).toBeUndefined()
    expect(JSON.stringify(snapshot.events)).not.toContain('"type":"image"')
    expect(JSON.stringify(snapshot.events)).toContain('saved image.png')
  })

  it('bounds row count and serialized bytes, preserves current stream and signals every overflow', () => {
    const state = new LiveSessionProjection()
    for (let index = 0; index < LIVE_MAX_ROWS + 10; index++) {
      state.record({ type: 'tool_execution_start', toolCallId: `tool-${index}`, toolName: 'read', args: { text: 'x'.repeat(100_000) } })
    }
    start(state); delta(state, 'current')
    let snapshot = state.snapshot('/project')
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.events.filter((e) => e.type === 'tool_execution_start').length).toBeLessThan(LIVE_MAX_ROWS)
    expect(JSON.stringify(snapshot)).toContain('current')
    delta(state, 'x'.repeat(LIVE_MAX_BYTES * 2))
    snapshot = state.snapshot('/project')
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(LIVE_MAX_BYTES)
    expect(JSON.stringify(snapshot)).toContain('current')
    state.record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(LIVE_MAX_BYTES * 2) }] } })
    expect(Buffer.byteLength(JSON.stringify(state.snapshot('/project')))).toBeLessThan(LIVE_MAX_BYTES)
  })

  it('does not mark intentional attachment/secret redaction as budget overflow or freeze later text', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'message_start', message: { role: 'user', timestamp: 1, content: [
      { type: 'text', text: 'question' }, { type: 'image', data: 'original', mimeType: 'image/png' }
    ] } })
    state.record({ type: 'tool_execution_start', toolCallId: 't', toolName: 'pion_generate_image', args: {
      path: 'images/output.png', apiKey: 'private', referenced_image_paths: ['images/source.png']
    } })
    start(state, 2); delta(state, 'first'); delta(state, ' later')
    const snapshot = state.snapshot('/project')
    expect(snapshot.truncated).toBeUndefined()
    expect(JSON.stringify(snapshot)).toContain('first later')
    expect(JSON.stringify(snapshot)).toContain('question')
    expect(JSON.stringify(snapshot)).not.toMatch(/original|private|source.png/)
  })

  it('preserves only safe final image metadata and validated previews, including the disk result name and identity', () => {
    const state = new LiveSessionProjection()
    const preview = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }
    const imageGeneration = {
      provider: 'openai-codex', version: 2, requestedModel: 'gpt-image-2.5-flare', resolvedModel: 'untrusted echo',
      path: 'images/output.png', operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high',
      referenceCount: 1, width: 1024, height: 1536, byteLength: 100_000,
      referenced_image_paths: ['images/secret-input.png'], metadata: { exif: 'private' }
    }
    state.record({ type: 'tool_execution_start', toolCallId: 'image', toolName: 'pion_generate_image', args: {} })
    state.record({ type: 'tool_execution_end', toolCallId: 'image', result: { content: [preview], details: { imageGeneration } } })
    state.record({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'image', toolName: 'pion_generate_image',
      timestamp: 12, content: [preview], details: { imageGeneration, arbitrary: 'not retained' } } })
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'disk-tool', timestamp: 'date',
      message: { role: 'toolResult', toolCallId: 'image', timestamp: 12 } } })
    const snapshot = state.snapshot('/project')
    expect(snapshot.events.map((event) => event.type)).toEqual(['tool_execution_start', 'message_end', 'entry_appended'])
    expect(snapshot.events[1]).toMatchObject({ message: { role: 'toolResult', toolName: 'pion_generate_image', content: [preview], details: {
      imageGeneration: { provider: 'openai-codex', version: 2, requestedModel: 'gpt-image-2.5-flare', resolvedModel: null,
        path: 'images/output.png', operation: 'edit', requestedSize: '2048x3072', requestedQuality: 'high',
        referenceCount: 1, width: 1024, height: 1536, byteLength: 100_000 }
    } } })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-input|private|untrusted echo|not retained/)
    expect(snapshot.truncated).toBeUndefined()
  })

  it('preserves preview part positions for renderer final-result identity comparisons', () => {
    const state = new LiveSessionProjection()
    const preview = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }
    state.record({ type: 'tool_execution_start', toolCallId: 'image', toolName: 'pion_generate_image', args: {} })
    state.record({ type: 'tool_execution_end', toolCallId: 'image', result: { content: [preview, { type: 'text', text: 'saved' }] } })
    expect(state.snapshot('/project').events[1]).toMatchObject({ result: { content: [
      { ...preview, partIndex: 0 }, { type: 'text', text: 'saved' }
    ] } })
  })

  it('keeps old image history settings unknown and rejects invalid model/dimension echoes', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'tool_execution_start', toolCallId: 'old-image', toolName: 'pion_generate_image', args: {} })
    state.record({ type: 'tool_execution_end', toolCallId: 'old-image', result: { content: [], details: { imageGeneration: {
      version: 1, provider: 'openai-codex', model: 'gpt-image-2', resolvedModel: 'echo', path: 'images/old.png',
      width: 10_000, height: 10_000, referenceCount: 999, requestedSize: 'bogus'
    } } } })
    const snapshot = state.snapshot('/project')
    expect(snapshot.events[1]).toMatchObject({ result: { details: { imageGeneration: {
      version: 1, provider: 'openai-codex', model: 'gpt-image-2', resolvedModel: null, path: 'images/old.png'
    } } } })
    expect(JSON.stringify(snapshot)).not.toMatch(/requestedSize|requestedQuality|operation|referenceCount|width|height|echo/)
  })

  it('retains a bounded provisional error until an authoritative successful final clears it', () => {
    const state = new LiveSessionProjection(); start(state); delta(state, 'draft')
    state.record({ type: 'message_update', assistantMessageEvent: { type: 'error', error: {
      role: 'assistant', stopReason: 'error', errorMessage: 'stream failed', content: [{ type: 'text', text: 'private draft' }], model: { apiKey: 'private' }
    } } })
    expect(state.snapshot('/project').events.at(-1)).toMatchObject({ assistantMessageEvent: {
      type: 'error', error: { role: 'assistant', stopReason: 'error', errorMessage: 'stream failed' }
    } })
    expect(JSON.stringify(state.snapshot('/project'))).not.toContain('private')
    state.record({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } })
    expect(JSON.stringify(state.snapshot('/project'))).not.toMatch(/stream failed|draft/)
  })

  it('keeps start/final replay events and accounts wrappers even for worst-case escaped final fields', () => {
    const state = new LiveSessionProjection(); start(state)
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'x'.repeat(512), timestamp: 'd'.repeat(128),
      message: { role: 'assistant', timestamp: 1, content: [] } } })
    state.record({ type: 'message_end', message: { role: 'assistant', content: Array.from({ length: 128 }, () => ({
      type: 'text', text: '\u0000'.repeat(64_000)
    })), errorMessage: '\u0000'.repeat(LIVE_MAX_BYTES), stopReason: 'error' } })
    const snapshot = state.snapshot('/project', '/session')
    expect(snapshot.events.every(Boolean)).toBe(true)
    expect(snapshot.events[0].type).toBe('message_start')
    expect(snapshot.events[1].type).toBe('message_end')
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(LIVE_MAX_BYTES)
    expect(snapshot.truncated).toBe(true)
  })

  it('retains the current nearly-full stream start when a bounded late provisional error arrives', () => {
    const state = new LiveSessionProjection(); start(state)
    delta(state, 'x'.repeat(LIVE_MAX_BYTES - 40 * 1024))
    state.record({ type: 'message_update', assistantMessageEvent: { type: 'error', error: {
      role: 'assistant', errorMessage: 'e'.repeat(32 * 1024), stopReason: 'error'
    } } })
    const snapshot = state.snapshot('/project')
    expect(snapshot.events.every(Boolean)).toBe(true)
    expect(snapshot.events[0].type).toBe('message_start')
    expect(snapshot.events.at(-1)).toMatchObject({ assistantMessageEvent: { type: 'error' } })
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(LIVE_MAX_BYTES)
  })

  it('stops a field after the first dropped delta without stopping unrelated thinking', () => {
    const state = new LiveSessionProjection(); start(state); delta(state, 'prefix')
    delta(state, 'x'.repeat(LIVE_MAX_BYTES))
    delta(state, 'wrong suffix')
    state.record({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' } })
    const snapshot = state.snapshot('/project')
    expect(snapshot.events[0]).toMatchObject({ message: { _pionLiveTruncatedFields: ['text'] } })
    expect(snapshot.events[1]).toMatchObject({ assistantMessageEvent: { delta: 'prefix' } })
    expect(JSON.stringify(snapshot)).toContain('reasoning')
    expect(JSON.stringify(snapshot)).not.toContain('wrong suffix')
    state.record({ type: 'message_end', message: { role: 'assistant', content: 'short final' } })
    expect(state.snapshot('/project').events[1]).toMatchObject({ message: { content: 'short final' } })
    expect(JSON.stringify(state.snapshot('/project'))).not.toContain('_pionLiveTruncatedFields')
  })

  it('marks actual final thinking emptied by the preceding text budget, not empty final fields', () => {
    const state = new LiveSessionProjection(); start(state)
    // These escaped characters consume exactly the available message string budget.
    const budget = LIVE_MAX_BYTES - 32 * 1024 - 16 * 1024
    const text = '\u0000'.repeat(Math.floor((budget - 2) / 6)) + 'x'.repeat((budget - 2) % 6)
    state.record({ type: 'message_end', message: { role: 'assistant', content: [
      { type: 'text', text }, { type: 'thinking', thinking: 'nonempty original' }
    ] } })
    expect(state.snapshot('/project').events[1]).toMatchObject({ message: {
      _pionLiveTruncatedFields: ['thinking'], content: [{ type: 'text', text }, { type: 'thinking', thinking: '' }]
    } })
    state.record({ type: 'agent_start' }); start(state)
    state.record({ type: 'message_end', message: { role: 'assistant', content: [] } })
    expect(JSON.stringify(state.snapshot('/project'))).not.toContain('_pionLiveTruncatedFields')
  })

  it('marks bounded diff separately from complete tool output and unlabelled redacted args', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'tool_execution_start', toolCallId: 'diff', toolName: 'edit', args: { huge: 'x'.repeat(LIVE_MAX_BYTES) } })
    state.record({ type: 'tool_execution_end', toolCallId: 'diff', toolName: 'edit', result: {
      content: [{ type: 'text', text: 'done' }], details: { diff: 'x'.repeat(LIVE_MAX_BYTES) }
    } })
    expect(state.snapshot('/project').events[1]).toMatchObject({ result: {
      _pionLiveTruncatedFields: ['diff'], content: [{ type: 'text', text: 'done' }]
    } })
  })

  it('annotates forwarded originals and snapshots with the same stable lifecycle identity without mutating SDK events', () => {
    const state = new LiveSessionProjection()
    const message = { role: 'user', timestamp: '1700000000000', content: 'question' }
    const startEvent = { type: 'message_start', message, other: 'preserved' }
    state.record(startEvent)
    const id = `${state.backendId}:1`
    expect(state.annotateEvent(startEvent)).toMatchObject({ other: 'preserved', message: { _pionLiveMessageId: id } })
    expect(message).not.toHaveProperty('_pionLiveMessageId')
    const endEvent = { type: 'message_end', message }
    state.record(endEvent)
    expect(state.annotateEvent(endEvent)).toMatchObject({ message: { _pionLiveMessageId: id } })
    expect(state.snapshot('/project').events.every((event) => messageOf(event)._pionLiveMessageId === id)).toBe(true)
    state.record({ type: 'agent_start' })
    state.record(startEvent)
    expect(state.annotateEvent(startEvent)).toMatchObject({ message: { _pionLiveMessageId: `${state.backendId}:2` } })
  })

  it('keeps missing/invalid timestamps unknown and learns a real late user timestamp', () => {
    const state = new LiveSessionProjection()
    const message = { role: 'user', content: 'question' }
    state.record({ type: 'message_start', message })
    expect(messageOf(state.snapshot('/project').events[0])).not.toHaveProperty('timestamp')
    const orphan = { type: 'entry_appended', entry: { type: 'message', id: 'unknown', message: { ...message } } }
    state.record(orphan)
    expect(state.annotateEvent(orphan)).toBe(orphan)
    const end = { type: 'message_end', message: { ...message, timestamp: '1700000000000' } }
    state.record(end)
    expect(state.annotateEvent(end)).toMatchObject({ message: { _pionLiveMessageId: `${state.backendId}:1`, timestamp: '1700000000000' } })
    expect(state.snapshot('/project').events[0]).toMatchObject({ message: { timestamp: '1700000000000' } })
    state.record({ type: 'agent_start' })
    state.record({ type: 'message_start', message: { role: 'assistant', timestamp: Number.NaN } })
    expect(messageOf(state.snapshot('/project').events[0])).not.toHaveProperty('timestamp')
  })

  it('associates only unique timestamp/content proof, normalizes numeric strings, and preserves the actual parent', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'message_start', message: { role: 'user', timestamp: 1700000000000, content: 'question' } })
    const entry = { type: 'entry_appended', entry: { type: 'message', id: 'disk', parentId: 'real-parent', timestamp: 'date',
      message: { role: 'user', timestamp: '1700000000000', content: 'question' } } }
    state.record(entry)
    expect(state.annotateEvent(entry)).toMatchObject({ entry: { parentId: 'real-parent', message: {
      _pionLiveMessageId: `${state.backendId}:1`, _pionLiveEntryId: 'disk'
    } } })
    expect(state.snapshot('/project').events[1]).toMatchObject({ entry: { parentId: 'real-parent' } })
    expect(state.snapshot('/project').events[0]).toMatchObject({ message: { _pionLiveEntryId: 'disk' } })
  })

  it('gives identical real starts different identities and never transfers a first entry onto the second', () => {
    const state = new LiveSessionProjection()
    const first = { role: 'user', timestamp: 1, content: 'same' }
    const second = { ...first }
    const firstStart = { type: 'message_start', message: first }
    const secondStart = { type: 'message_start', message: second }
    state.record(firstStart)
    state.record({ type: 'message_end', message: first })
    state.record(secondStart)
    state.record({ type: 'message_end', message: second })
    expect(state.annotateEvent(firstStart)).toMatchObject({ message: { _pionLiveMessageId: `${state.backendId}:1` } })
    expect(state.annotateEvent(secondStart)).toMatchObject({ message: { _pionLiveMessageId: `${state.backendId}:2` } })
    const ambiguous = { type: 'entry_appended', entry: { type: 'message', id: 'ambiguous', message: { ...first } } }
    state.record(ambiguous)
    expect(state.annotateEvent(ambiguous)).toBe(ambiguous)
    const late = { type: 'entry_appended', entry: { type: 'message', id: 'first-disk', parentId: null, message: first } }
    state.record(late)
    expect(state.annotateEvent(late)).toMatchObject({ entry: { message: { _pionLiveMessageId: `${state.backendId}:1` } } })
    expect(state.annotateEvent(secondStart).message).not.toHaveProperty('_pionLiveEntryId')
    state.record(ambiguous)
    expect(state.annotateEvent(ambiguous)).toBe(ambiguous)
  })

  it('does not transfer a previous turn entry to a new identical start and accepts a known generated identity without a timestamp', () => {
    const state = new LiveSessionProjection()
    const message = { role: 'user', timestamp: 1, content: 'same' }
    state.record({ type: 'message_start', message })
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'old-entry', message } })
    state.record({ type: 'agent_start' })
    state.record({ type: 'message_start', message: { ...message } })
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'old-entry', message: { ...message } } })
    expect(state.snapshot('/project').events).toHaveLength(1)
    expect(messageOf(state.snapshot('/project').events[0])).not.toHaveProperty('_pionLiveEntryId')
    const known = { type: 'entry_appended', entry: { type: 'message', id: 'new-entry', message: {
      role: 'user', _pionLiveMessageId: `${state.backendId}:2`
    } } }
    state.record(known)
    expect(state.annotateEvent(known)).toMatchObject({ entry: { message: { _pionLiveEntryId: 'new-entry' } } })
    expect(entryOf(state.snapshot('/project').events.at(-1))).not.toHaveProperty('parentId')
  })

  it('normalizes ISO timestamps only for proof and preserves original wire values', () => {
    const state = new LiveSessionProjection()
    state.record({ type: 'message_start', message: { role: 'user', timestamp: 1700000000000, content: 'question' } })
    const event = { type: 'entry_appended', entry: { type: 'message', id: 'iso-entry', message: {
      role: 'user', timestamp: '2023-11-14T22:13:20.000Z', content: [{ type: 'text', text: 'question' }]
    } } }
    state.record(event)
    expect(state.annotateEvent(event)).toMatchObject({ entry: { message: {
      timestamp: '2023-11-14T22:13:20.000Z', _pionLiveMessageId: `${state.backendId}:1`
    } } })
    expect(state.snapshot('/project').events[0]).toMatchObject({ message: { timestamp: 1700000000000 } })
  })

  it('does not invent an entry mapping for entry-before-start or missing content/time', () => {
    const state = new LiveSessionProjection()
    const orphan = { type: 'entry_appended', entry: { type: 'message', id: 'orphan', message: { role: 'user', timestamp: 1, content: 'same' } } }
    state.record(orphan)
    state.record({ type: 'message_start', message: { role: 'user', timestamp: 1, content: 'same' } })
    expect(state.annotateEvent(orphan)).toBe(orphan)
    expect(state.snapshot('/project').events).toHaveLength(1)
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'no-content', message: { role: 'user', timestamp: 1 } } })
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'no-time', message: { role: 'user', content: 'same' } } })
    expect(state.snapshot('/project').events).toHaveLength(1)
  })

  it('preserves all four planned names and partial/final batch rows across background snapshots', () => {
    const state = new LiveSessionProjection()
    const tasks = Array.from({ length: 4 }, (_, index) => ({ name: `child-${index}`, task: 'private instruction'.repeat(10000) }))
    state.record({ type: 'tool_execution_start', toolCallId: 'batch', toolName: 'pion_subagents', args: { tasks, secret: 'private arg' } })
    const planned = state.snapshot('/project').events[0] as Extract<WireEvent, { type: 'tool_execution_start' }>
    expect(planned.args).toEqual({ tasks: tasks.map(({ name }) => ({ name })) })
    const rows = tasks.map(({ name }, index) => ({ index, name, status: index === 2 ? 'completed' : 'running', summary: `summary-${index}` }))
    const details = { subagentBatch: { version: 1, tasks: rows }, usage: { secret: 'usage' }, privateChildRecords: 'child body' }
    state.record({ type: 'tool_execution_update', toolCallId: 'batch', partialResult: { content: [], details } })
    const update = state.snapshot('/project').events[1] as Extract<WireEvent, { type: 'tool_execution_update' }>
    expect((update.partialResult as WireMessage).details).toEqual({ subagentBatch: details.subagentBatch })
    const final = { version: 1, tasks: rows.map((row) => ({ ...row, status: 'completed' })) }
    state.record({ type: 'tool_execution_end', toolCallId: 'batch', result: { content: [], details: { ...details, subagentBatch: final } } })
    state.record({ type: 'tool_execution_update', toolCallId: 'batch', partialResult: { details } })
    const end = state.snapshot('/project').events[1] as Extract<WireEvent, { type: 'tool_execution_end' }>
    expect((end.result as WireMessage).details).toEqual({ subagentBatch: final })
    state.record({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'batch', content: [], details: { subagentBatch: final } } })
    expect(messageOf(state.snapshot('/project').events[1]).details).toEqual({ subagentBatch: final })
    expect(JSON.stringify(state.snapshot('/project'))).not.toMatch(/private instruction|private arg|privateChildRecords|child body|usage/)
  })

  it('keeps four independent batch results in their own rows during partial and final STATE recovery', () => {
    const state = new LiveSessionProjection()
    const batches = Array.from({ length: 4 }, (_, batchIndex) => ({ version: 1,
      tasks: Array.from({ length: 4 }, (_, index) => ({ index, name: `batch-${batchIndex}-child-${index}`, status: 'running' })) }))
    batches.forEach((batch, index) => {
      state.record({ type: 'tool_execution_start', toolCallId: `batch-${index}`, toolName: 'pion_subagents', args: { tasks: batch.tasks } })
      state.record({ type: 'tool_execution_update', toolCallId: `batch-${index}`, partialResult: { details: { subagentBatch: batch } } })
    })
    expect(state.snapshot('/project').events.filter((event) => event.type === 'tool_execution_update')
      .map((event) => ((event as Extract<WireEvent, { type: 'tool_execution_update' }>).partialResult as WireMessage).details)).toEqual(batches.map((subagentBatch) => ({ subagentBatch })))
    const finals = batches.map((batch) => ({ ...batch, tasks: batch.tasks.map((task) => ({ ...task, status: 'completed' })) }))
    finals.forEach((batch, index) => state.record({ type: 'message_end', message: { role: 'toolResult', toolCallId: `batch-${index}`, details: { subagentBatch: batch } } }))
    expect(state.snapshot('/project').events.filter((event) => event.type === 'message_end')
      .map((event) => messageOf(event).details)).toEqual(finals.map((subagentBatch) => ({ subagentBatch })))
  })

  it('keeps only names in native assistant tool-call arguments even with huge task bodies', () => {
    const state = new LiveSessionProjection(); start(state)
    const tasks = Array.from({ length: 4 }, (_, index) => ({ task: 'body'.repeat(100000), name: `worker-${index}` }))
    state.record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'pion_subagents', id: 'batch', arguments: { tasks, other: 'private' } }] } })
    expect(messageOf(state.snapshot('/project').events[1]).content).toEqual([
      { type: 'toolCall', name: 'pion_subagents', id: 'batch', arguments: { tasks: tasks.map(({ name }) => ({ name })) } }
    ])
    expect(JSON.stringify(state.snapshot('/project'))).not.toMatch(/body|private/)
  })

  it('requires scoped native provenance, not arbitrary details or another same-id backend', () => {
    const native = new LiveSessionProjection(), other = new LiveSessionProjection()
    const batch = { version: 1, tasks: [{ index: 0, name: 'worker', status: 'completed' }] }
    native.record({ type: 'tool_execution_start', toolCallId: 'same', toolName: 'pion_subagents', args: { tasks: [{ name: 'worker' }] } })
    other.record({ type: 'tool_execution_start', toolCallId: 'same', toolName: 'read', args: {} })
    for (const state of [native, other]) state.record({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'same', content: [], details: { subagentBatch: batch } } })
    expect(messageOf(native.snapshot('/project').events[1]).details).toEqual({ subagentBatch: batch })
    expect(messageOf(other.snapshot('/project').events[1]).details).toBeUndefined()
    const standalone = new LiveSessionProjection()
    standalone.record({ type: 'message_end', message: { role: 'toolResult', toolName: 'pion_subagents', toolCallId: 'standalone', details: { subagentBatch: batch } } })
    expect(messageOf(standalone.snapshot('/project').events[0]).details).toEqual({ subagentBatch: batch })
    const unnamed = new LiveSessionProjection()
    unnamed.record({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'standalone', details: { subagentBatch: batch } } })
    expect(unnamed.snapshot('/project').events).toEqual([])
  })

  it('charges encoded batch metadata to result budgets and preserves statuses when dropping summaries', () => {
    const state = new LiveSessionProjection()
    const tasks = Array.from({ length: 8 }, (_, index) => ({ name: `worker-${index}` }))
    state.record({ type: 'tool_execution_start', toolCallId: 'batch', toolName: 'pion_subagents', args: { tasks } })
    const batch = { version: 1, tasks: tasks.map(({ name }, index) => ({ index, name, status: 'running', summary: '\u0000'.repeat(2048) })) }
    state.record({ type: 'tool_execution_update', toolCallId: 'batch', partialResult: { content: [{ type: 'text', text: 'x'.repeat(100000) }], details: { subagentBatch: batch }, usage: { input: 123 } } })
    const event = state.snapshot('/project').events[1] as Extract<WireEvent, { type: 'tool_execution_update' }>
    expect((event.partialResult as WireMessage).details).toEqual({ subagentBatch: { version: 1, tasks: tasks.map(({ name }, index) => ({ index, name, status: 'running', summaryTruncated: true })) } })
    expect(Buffer.byteLength(JSON.stringify(event.partialResult))).toBeLessThan(32 * 1024)
    expect(state.snapshot('/project').truncated).toBe(true)
    expect((event.partialResult as WireMessage)._pionLiveTruncatedFields).toContain('subagentBatch')
    expect(JSON.stringify(event)).not.toContain('usage')
    state.record({ type: 'tool_execution_end', toolCallId: 'batch', result: { content: [] } })
    const final = state.snapshot('/project').events[1] as Extract<WireEvent, { type: 'tool_execution_end' }>
    expect((final.result as WireMessage).details).toEqual({ subagentBatch: { version: 1, tasks: tasks.map(({ name }, index) => ({ index, name, status: 'unknown' })) } })
    expect((final.result as WireMessage)._pionLiveTruncatedFields).toBeUndefined()
    state.record({ type: 'tool_execution_update', toolCallId: 'batch', partialResult: { details: { subagentBatch: batch } } })
    expect(state.snapshot('/project').events[1]).toEqual(final)
    expect(Buffer.byteLength(JSON.stringify(state.snapshot('/project')))).toBeLessThan(LIVE_MAX_BYTES)
  })

  it('marks entire batch budget omission, not native missing/invalid metadata', () => {
    const state = new LiveSessionProjection()
    // Exercise the serializer's smaller remaining-budget boundary directly.
    const serialize = (state as unknown as { message(raw: Record<string, unknown>, budget: number, images: boolean): WireMessage }).message.bind(state)
    const tasks = Array.from({ length: 4 }, (_, index) => ({ index, name: `worker-${index}`, status: 'completed', summary: `done-${index}` }))
    const raw = { role: 'toolResult', toolName: 'pion_subagents', details: { subagentBatch: { version: 1, tasks } } }
    const omitted = serialize(raw, 16 * 1024 + 1, true)
    expect(omitted.details).toBeUndefined()
    expect(omitted._pionLiveTruncatedFields).toEqual(['subagentBatch'])
    for (const details of [undefined, { subagentBatch: { version: 2, tasks } }]) {
      const native = serialize({ ...raw, details }, 16 * 1024 + 1, true)
      expect(native._pionLiveTruncatedFields).toBeUndefined()
    }
  })

  it('uses unique backend identities instead of nullable usage ids', () => {
    expect(new LiveSessionProjection().backendId).not.toBe(new LiveSessionProjection().backendId)
  })
})
