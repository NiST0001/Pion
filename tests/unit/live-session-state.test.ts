import { describe, expect, it } from 'vitest'
import { LIVE_MAX_BYTES, LIVE_MAX_ROWS, LiveSessionProjection } from '../../src/main/agent/live-session-state'

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
      { type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } },
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
    state.record({ type: 'entry_appended', entry: { type: 'message', id: 'persisted', timestamp: 'date', message: { role: 'assistant', timestamp: 10 } } })
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
      message: { role: 'assistant', timestamp: 1 } } })
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

  it('uses unique backend identities instead of nullable usage ids', () => {
    expect(new LiveSessionProjection().backendId).not.toBe(new LiveSessionProjection().backendId)
  })
})
