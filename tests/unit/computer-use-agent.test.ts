import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_USE_AGENT_TITLE_PREFIX as PREFIX, COMPUTER_USE_AGENT_SOURCE_FIELD, COMPUTER_USE_AGENT_LIMITS as A,
  COMPUTER_USE_OBSERVE_TOOL, parseComputerUseAgentRequest, parseComputerUseAgentTitle, parseComputerUseAgentSource,
  validateComputerUseAgentResponse, stripComputerUseAgentImages, type ComputerUseAgentRequest, type ComputerUseAgentResponse
} from '../../src/shared/computer-use-agent'
import { createDisabledComputerUseStatus, type ComputerUseOwner, type ComputerUseStatus } from '../../src/shared/computer-use'
import { ComputerUseAgentBridge, normalizeComputerUseModelPng, type ComputerUseAgentAdmission, type ComputerUseAgentBridgeOptions } from '../../src/main/agent/computer-use-bridge'
import { makeStaticPng } from '../fixtures/static-png'

// Source/mock only: no desktop, Portal, subprocess, credential or model call.
const OWNER: ComputerUseOwner = { ownerWindowId: 7, backendId: 'actual-backend', runtimeId: 'factory-1', runId: 'actual-run', generation: 1 }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
afterEach(() => vi.useRealTimers())
function harness(extra: Partial<ComputerUseAgentBridgeOptions> = {}, control = false, width = 16, height = 9) {
  let valid = true
  let transportValid = true
  let deny = false
  let id = 0
  let state: ComputerUseStatus = createDisabledComputerUseStatus()
  if (control) state = { ...state, state: 'ready', coordination: 'held', scopeRevision: 1, owner: { ...OWNER }, consent: { capture: true, upload: true, control: true, captureScope: 'display', retention: 'sdk-session' } }
  const admission: ComputerUseAgentAdmission = {
    owner: Object.freeze({ ...OWNER }), cwd: '/mock-project', sessionPath: '/mock-project/session.jsonl', sessionId: 'sdk-session', sessionIdentity: Object.freeze({}), provider: 'openai-codex', modelId: 'exact-model', imageSupported: true,
    assertCurrent: () => { if (!valid) throw new Error('old document/backend/run') },
    assertRequestCurrent: () => { if (!valid) throw new Error('root ended') },
    assertCleanupCurrent: () => { if (!transportValid) throw new Error('old actual transport') }
  }
  const service = {
    getState: vi.fn(() => structuredClone(state)),
    start: vi.fn(async (owner, consent) => {
      state = { ...state, scopeRevision: state.scopeRevision + 1, state: 'ready', coordination: 'held', owner, consent }
      return structuredClone(state)
    }),
    capture: vi.fn(async () => {
      state = { ...state, frame: { id: `native-${++id}`, width, height, createdAt: 10, scopeRevision: state.scopeRevision, captureScope: control ? 'display' : 'window', actualScope: control ? 'display' : 'window' } }
      return { state: structuredClone(state), png: new Uint8Array(makeStaticPng(width, height)) }
    }),
    act: vi.fn(async () => { delete state.frame; return structuredClone(state) }),
    revoke: vi.fn(() => { state = { ...state, state: 'stopping', actualPending: true, consent: { capture: false, upload: false, control: false, retention: 'sdk-session' } } }),
    stop: vi.fn(async () => structuredClone(state))
  }
  const authorize = vi.fn(async () => true)
  const broker = new ComputerUseAgentBridge({ enabled: true, service, randomId: () => `model-${++id}`, clock: () => 10, authorize,
    assertPolicy: () => { if (deny) throw new Error('deny') }, ...extra })
  let requests = 0
  const payload = (operation: ComputerUseAgentRequest['operation'] = 'observe', fields: Partial<ComputerUseAgentRequest> = {}): ComputerUseAgentRequest => ({ version: 1, operation, runtimeNonce: 'transport-nonce', runtimeId: OWNER.runtimeId, requestId: `request-${++requests}`, provider: admission.provider, modelId: admission.modelId, ...(operation === 'observe' || operation === 'act' ? { toolCallId: `actual-tool-${requests}` } : {}), ...fields })
  const submit = (request: ComputerUseAgentRequest, eventFields: Record<string, unknown> = {}, admit = async () => admission) => {
    const response = deferred<ReturnType<typeof validateComputerUseAgentResponse>>()
    const consumed = broker.handle({ type: 'extension_ui_request', method: 'input', id: `dialog-${requests}`, title: PREFIX + JSON.stringify(request), ...eventFields }, admit,
      (_id, value) => response.resolve(validateComputerUseAgentResponse(JSON.parse(value))))
    expect(consumed).toBe(true)
    return response.promise
  }
  const retain = (request: ComputerUseAgentRequest, result: ComputerUseAgentResponse, current = admission, fields: Record<string, unknown> = {}) => broker.recordScreenshotEntry(current.sessionIdentity,
    { backendId: current.owner.backendId, runtimeId: current.owner.runtimeId, runId: current.owner.runId, toolCallId: request.toolCallId! },
    { type: 'message', id: `entry-${request.requestId}`, message: { role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: request.toolCallId, isError: false,
      content: [{ type: 'image', mimeType: 'image/png', data: result.image?.data }], details: { frameId: result.frameId, scopeRevision: result.scopeRevision, width: result.width, height: result.height, retention: 'sdk-session' }, ...fields } })
  const report = (request: ComputerUseAgentRequest, result: ComputerUseAgentResponse): ComputerUseAgentRequest => payload('retained', { toolCallId: request.toolCallId,
    retained: { observationRequestId: request.requestId, entryId: `entry-${request.requestId}`, sessionFile: admission.sessionPath, sessionId: admission.sessionId,
      frameId: result.frameId!, scopeRevision: result.scopeRevision!, width: result.width!, height: result.height!,
      imageHash: createHash('sha256').update(Buffer.from(result.image!.data, 'base64')).digest('hex'), imageBytes: Buffer.from(result.image!.data, 'base64').byteLength } })
  return { broker, service, authorize, admission, payload, submit, retain, report, invalidate: () => { valid = false }, replaceTransport: () => { transportValid = false }, deny: () => { deny = true }, replaceState: (s: ComputerUseStatus) => { state = s }, state: () => structuredClone(state) }
}

describe('ComputerUse private protocol (pure)', () => {
  it('bounds exact shape and consumes malformed prefixed titles instead of ordinary questions', async () => {
    const h = harness()
    expect(() => parseComputerUseAgentRequest({ ...h.payload(), owner: OWNER })).toThrow()
    expect(() => parseComputerUseAgentTitle(PREFIX + '{bad')).toThrow()
    expect(() => parseComputerUseAgentRequest({ ...h.payload('watch'), toolCallId: 'self-reported-root' })).toThrow()
    expect(() => parseComputerUseAgentRequest(h.payload('unwatch'))).toThrow()
    expect(parseComputerUseAgentRequest(h.payload('unwatch', { watchRequestId: 'actual-watch' })).watchRequestId).toBe('actual-watch')
    expect(() => parseComputerUseAgentRequest(h.payload('watch', { watchRequestId: 'foreign-watch' }))).toThrow()
    expect(() => parseComputerUseAgentRequest({ ...h.payload('act'), frameId: 'frame', action: { type: 'click', x: 2000, y: 0, button: 'left' } })).toThrow()
    const reply = vi.fn()
    expect(h.broker.handle({ type: 'extension_ui_request', method: 'input', id: 'dialog', title: PREFIX + '{broken' }, vi.fn(), reply)).toBe(true)
    expect(reply).toHaveBeenCalledWith('dialog', expect.stringContaining('invalid-request'))
    expect(h.service.start).not.toHaveBeenCalled()
    expect(h.broker.handle({ title: 'ordinary question' }, vi.fn(), reply)).toBe(false)
  })

  it('preserves the pinned Responses call_id|item_id source rather than rejecting real Codex calls as nonce tokens', () => {
    const h = harness()
    const toolCallId = `call_actual|fc_${'A'.repeat(400)}+/=`
    expect(parseComputerUseAgentRequest(h.payload('observe', { toolCallId })).toolCallId).toBe(toolCallId)
    expect(parseComputerUseAgentSource({ version: 1, runtimeId: 'factory-1', runtimeNonce: 'nonce', toolCallId }).toolCallId).toBe(toolCallId)
    for (const invalid of ['', 'x'.repeat(2049), 'call\nitem', 'call item']) expect(() => parseComputerUseAgentRequest(h.payload('observe', { toolCallId: invalid }))).toThrow()
  })

  it('does not retain image/source bytes in live, tool results, appended entries or ordinary history', () => {
    const result = { role: 'toolResult', toolName: COMPUTER_USE_OBSERVE_TOOL, toolCallId: 'root', content: [{ type: 'image', data: 'private-full-image' }], details: { nested: 'private-full-image' }, structuredContent: { image: 'private-full-image' } }
    for (const input of [result, { type: 'tool_execution_end', toolName: COMPUTER_USE_OBSERVE_TOOL, result }, { type: 'message_end', message: result }, { type: 'entry_appended', entry: { type: 'message', id: 'real-entry', message: result } }, { type: 'message', id: 'real-entry', message: result }, { type: 'agent_end', messages: [result] }, { type: 'turn_end', toolResults: [result] }, { type: 'tool_execution_start', [COMPUTER_USE_AGENT_SOURCE_FIELD]: { runtimeNonce: 'private-nonce' } }]) {
      const safe = stripComputerUseAgentImages(input)
      expect(JSON.stringify(safe)).not.toMatch(/private-full-image|private-nonce|structuredContent/)
    }
    const ordinary = { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'keep existing behavior' }] }
    expect(stripComputerUseAgentImages(ordinary)).toBe(ordinary)
  })

  it('enforces the SDK strict base64 boundary, including the exact 4.5 MiB edge', () => {
    const response = { version: 1, ok: true, operation: 'observe', requestId: 'r', width: 1, height: 1, frameId: 'f', scopeRevision: 1 }
    expect(() => validateComputerUseAgentResponse({ ...response, image: { mimeType: 'image/png', data: 'A'.repeat(A.maxModelBase64) } })).toThrow()
    expect(validateComputerUseAgentResponse({ ...response, image: { mimeType: 'image/png', data: 'A'.repeat(A.maxModelBase64 - 4) } }).ok).toBe(true)
    expect(Math.ceil(A.maxModelImageBytes / 3) * 4).toBeLessThan(A.maxModelBase64)
  })

  it('rejects arbitrary diagnostics or non-observe image responses', () => {
    expect(() => validateComputerUseAgentResponse({ version: 1, ok: false, operation: 'observe', requestId: 'r', error: 'raw secret' })).toThrow()
    expect(() => validateComputerUseAgentResponse({ version: 1, ok: true, operation: 'act', requestId: 'r', image: { mimeType: 'image/png', data: 'YQ==' }, width: 1, height: 1, frameId: 'f', scopeRevision: 1 })).toThrow()
  })
})

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

function actualHostProjector(budget = A.maxModelImageBytes) {
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('projectFrame: async (png, frame) => {')
  const callback = source.slice(start + 'projectFrame: '.length, source.indexOf('\n  // No default trusted', start)).trim()
  const js = transpileModule(`const projectFrame = ${callback};`, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText
  const encoded: Array<{ width: number; height: number }> = []
  const makeImage = (width: number, height: number): unknown => ({ isEmpty: () => false, getSize: () => ({ width, height }),
    resize: (dimensions: { width: number; height: number }) => makeImage(dimensions.width, dimensions.height),
    toPNG: () => { encoded.push({ width, height }); const png = makeStaticPng(width, height); return Buffer.concat([png.subarray(0, 33), pngChunk('sRGB', Buffer.from([0])), png.subarray(33)]) } })
  const original = makeStaticPng(3200, 1800)
  const nativeImage = { createFromBuffer: vi.fn(() => makeImage(3200, 1800)) }
  const project = new Function('nativeImage', 'COMPUTER_USE_AGENT_IMAGE_LIMITS', 'normalizeComputerUseModelPng', 'Buffer', `${js}; return projectFrame;`)(
    nativeImage, { ...A, maxModelImageBytes: budget }, normalizeComputerUseModelPng, Buffer) as NonNullable<ComputerUseAgentBridgeOptions['projectFrame']>
  return { project, original, encoded }
}

describe('ComputerUse exact SDK model projection (pure PNG)', () => {
  it('strips encoder ancillary chunks while preserving the exact complete IHDR/IDAT/IEND and CRC bytes', () => {
    const original = makeStaticPng(16, 9)
    const nativeOutput = Buffer.concat([original.subarray(0, 33), pngChunk('sRGB', Buffer.from([0])), pngChunk('eXIf', Buffer.from('not sent to SDK')), original.subarray(33)])
    expect(Buffer.from(normalizeComputerUseModelPng(nativeOutput, { width: 16, height: 9 }))).toEqual(original)
  })

  it.each(['PLTE', 'tRNS'])('refuses to strip essential %s pixel information', kind => {
    const original = makeStaticPng(16, 9)
    const data = kind === 'PLTE' ? Buffer.from([1, 2, 3]) : Buffer.from([0, 1, 0, 2, 0, 3])
    const nativeOutput = Buffer.concat([original.subarray(0, 33), pngChunk(kind, data), original.subarray(33)])
    expect(() => normalizeComputerUseModelPng(nativeOutput, { width: 16, height: 9 })).toThrow()
  })

  it('uses the actual host bounded downscale loop and returns exact model/original dimensions without mutating the original', async () => {
    const budget = makeStaticPng(1500, 843).length
    const h = actualHostProjector(budget)
    const snapshot = Buffer.from(h.original)
    const frame = { id: 'actual-original', width: 3200, height: 1800, createdAt: 0, scopeRevision: 1, captureScope: 'window' as const, actualScope: 'window' as const }
    const result = await h.project(h.original, frame)
    expect(result.width).toBeLessThan(2000)
    expect(result.png.byteLength).toBeLessThanOrEqual(budget)
    expect(h.encoded[0]).toEqual({ width: 2000, height: 1125 })
    expect(h.encoded.at(-1)).toEqual({ width: result.width, height: result.height })
    expect(Buffer.from(result.png)).toEqual(makeStaticPng(result.width, result.height))
    expect(h.original).toEqual(snapshot)
  })

  it('refuses the model view after the fixed resize budget instead of transmitting oversized bytes', async () => {
    const h = actualHostProjector(1)
    await expect(h.project(h.original, { id: 'original', width: 3200, height: 1800, createdAt: 0, scopeRevision: 1, captureScope: 'window', actualScope: 'window' })).rejects.toThrow('budget exhausted')
    expect(h.encoded).toHaveLength(12)
  })

  it.each(['CRC', 'truncated-IEND', 'trailing-bytes', 'wrong-dimensions'])('does not repair malformed %s into an accepted projection', kind => {
    let png = makeStaticPng(16, 9)
    if (kind === 'CRC') png[41] ^= 1
    if (kind === 'truncated-IEND') png = png.subarray(0, png.length - 1)
    if (kind === 'trailing-bytes') png = Buffer.concat([png, Buffer.from([0])])
    expect(() => normalizeComputerUseModelPng(png, { width: kind === 'wrong-dimensions' ? 15 : 16, height: 9 })).toThrow()
  })
})

describe('ComputerUse model broker (mock)', () => {
  it('does not perform any work by construction or disabled/missing source admission', async () => {
    const h = harness({ enabled: false })
    expect(h.service.getState).not.toHaveBeenCalled()
    expect((await h.submit(h.payload())).error).toBe('unavailable')
    expect(h.authorize).not.toHaveBeenCalled()
    const enabled = harness()
    expect((await enabled.submit(enabled.payload(), {}, async () => { throw new Error('missing true root source') })).ok).toBe(false)
    expect(enabled.authorize).not.toHaveBeenCalled()
    expect(enabled.service.start).not.toHaveBeenCalled()
  })

  it('independently approves capture/upload/retention and returns a model frame distinct from the native fence', async () => {
    const h = harness()
    const result = await h.submit(h.payload())
    expect(result).toMatchObject({ ok: true, operation: 'observe', scopeRevision: 1, width: 16, height: 9 })
    expect(result.frameId).not.toBe(h.state().frame!.id)
    expect(h.authorize).toHaveBeenCalledWith(h.admission, 'observe')
    expect(h.service.start).toHaveBeenCalledWith(OWNER, { capture: true, upload: true, control: false, captureScope: 'window', retention: 'sdk-session' })
    expect(result.image!.data).toBe(makeStaticPng(16, 9).toString('base64'))
    expect(() => h.broker.assertOwned({ ...OWNER, generation: 9 }, 'capture')).toThrow()
    expect(() => h.broker.assertOwned(OWNER, 'capture')).not.toThrow()
  })

  it('rejects a late approval/new deny and never dispatches capture', async () => {
    const approval = deferred<boolean>()
    const h = harness({ authorize: vi.fn(() => approval.promise) })
    const pending = h.submit(h.payload())
    await Promise.resolve(); await Promise.resolve()
    h.deny(); approval.resolve(true)
    expect((await pending).ok).toBe(false)
    expect(h.service.start).not.toHaveBeenCalled()
    expect(h.service.capture).not.toHaveBeenCalled()
  })

  it('rejects a stale document/root after an actual pending capture and keeps old pixels out of the response', async () => {
    const capture = deferred<Awaited<ReturnType<ReturnType<typeof harness>['service']['capture']>>>()
    const h = harness()
    const original = h.service.capture.getMockImplementation()!
    h.service.capture.mockImplementation(() => capture.promise)
    const pending = h.submit(h.payload())
    for (let i = 0; i < 8; i++) await Promise.resolve()
    h.invalidate()
    capture.resolve(await original())
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.image).toBeUndefined()
    expect(h.service.revoke).toHaveBeenCalledWith(OWNER)
  })

  it('uses exact configured provider/model, not the request target or an image preview', async () => {
    const h = harness()
    expect((await h.submit(h.payload('observe', { modelId: 'other-model' }))).error).toBe('model-unavailable')
    expect(h.authorize).not.toHaveBeenCalled()
    const large = harness({}, false, 3200, 1800)
    expect((await large.submit(large.payload())).error).toBe('model-unavailable')
    expect(large.service.capture).toHaveBeenCalledTimes(1)
  })

  it('does not replay request IDs or execute duplicate capture while real work is pending', async () => {
    const approval = deferred<boolean>()
    const h = harness({ authorize: vi.fn(() => approval.promise) })
    const request = h.payload()
    const pending = h.submit(request)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect((await h.submit(request)).error).toBe('invalid-request')
    expect((await h.submit(h.payload())).error).toBe('busy')
    approval.resolve(true)
    expect((await pending).ok).toBe(true)
    expect(h.service.capture).toHaveBeenCalledTimes(1)
  })

  it('revokes long-poll model permission immediately, and never stops a different manual/new lease', async () => {
    const h = harness()
    const observed = h.payload()
    h.retain(observed, await h.submit(observed))
    const egress = await h.submit(h.payload('egress'))
    expect(egress).toMatchObject({ ok: true, scopeRevision: 1 })
    const watching = h.submit(h.payload('watch'))
    for (let i = 0; i < 4; i++) await Promise.resolve()
    h.broker.revokeBackend('different-backend')
    expect(h.service.stop).not.toHaveBeenCalled()
    h.broker.revoke()
    expect(await watching).toMatchObject({ ok: false, error: 'egress-revoked', scopeRevision: 1 })
    expect(h.service.stop).toHaveBeenCalledWith(OWNER, 'agent-scope-revoked')
    const foreign = harness()
    await foreign.submit(foreign.payload())
    foreign.replaceState({ ...foreign.state(), owner: { ...OWNER, backendId: 'manual-or-new' } })
    foreign.broker.revoke()
    expect(foreign.service.revoke).not.toHaveBeenCalled()
    expect(foreign.service.stop).not.toHaveBeenCalled()
  })

  it('an egress request alone cannot create screenshot provenance or bypass a new permission', async () => {
    const h = harness()
    expect((await h.submit(h.payload('egress'))).error).toBe('egress-revoked')
    expect(h.authorize).not.toHaveBeenCalled()
    const observed = h.payload()
    h.retain(observed, await h.submit(observed))
    h.broker.revoke()
    const count = h.authorize.mock.calls.length
    expect((await h.submit(h.payload('egress'))).ok).toBe(true)
    expect(h.authorize.mock.calls.length).toBe(count + 1)
    expect(h.authorize).toHaveBeenLastCalledWith(h.admission, 'egress')
  })

  it('requires an actual delivered screenshot AND its matching real SDK entry, not markers/bytes alone', async () => {
    const h = harness()
    const observed = h.payload()
    const image = await h.submit(observed)
    // Even successful transport delivery is not proof of persisted SDK entry.
    expect((await h.submit(h.payload('egress'))).error).toBe('egress-revoked')
    h.retain(observed, image, h.admission, { isError: true })
    expect((await h.submit(h.payload('egress'))).error).toBe('egress-revoked')
    h.retain(observed, image, { ...h.admission, sessionIdentity: Object.freeze({}) })
    expect((await h.submit(h.payload('egress'))).error).toBe('egress-revoked')
    h.retain(observed, image)
    expect((await h.submit(h.payload('egress'))).ok).toBe(true)
    const restored = { ...h.admission, sessionIdentity: Object.freeze({}) }
    expect((await h.submit(h.payload('egress'), {}, async () => restored)).error).toBe('egress-revoked')
  })

  it('confirms a factory-scanned actual entry privately without manufacturing an SDK event or another capture/upload grant', async () => {
    const h = harness()
    const observe = h.payload()
    const image = await h.submit(observe)
    const report = h.report(observe, image)
    expect(parseComputerUseAgentRequest(report)).toEqual(report)
    expect((await h.submit(report))).toMatchObject({ ok: true, operation: 'retained', scopeRevision: image.scopeRevision })
    expect((await h.submit(h.payload('egress'))).ok).toBe(true)
    expect(h.authorize).toHaveBeenCalledTimes(1)
    expect(h.service.capture).toHaveBeenCalledTimes(1)
    expect(h.service.act).not.toHaveBeenCalled()
    expect(() => parseComputerUseAgentRequest({ ...report, operation: 'egress' })).toThrow()
    expect(() => parseComputerUseAgentRequest({ ...report, retained: { ...report.retained, imageHash: 'invented' } })).toThrow()
    expect(() => parseComputerUseAgentRequest({ ...report, retained: undefined })).toThrow()
  })

  it.each(['request', 'tool', 'session-file', 'session-id', 'scope', 'frame', 'dimensions', 'digest', 'bytes', 'identity', 'owner'] as const)('rejects a retained report with mismatched %s instead of promoting delivered pixels into a grant', async kind => {
    const h = harness()
    const observe = h.payload()
    const report = h.report(observe, await h.submit(observe))
    const proof = report.retained!
    let admission = h.admission
    if (kind === 'request') proof.observationRequestId = 'other-request'
    if (kind === 'tool') report.toolCallId = 'other-root'
    if (kind === 'session-file') proof.sessionFile = '/mock-project/other.jsonl'
    if (kind === 'session-id') proof.sessionId = 'other-session'
    if (kind === 'scope') proof.scopeRevision++
    if (kind === 'frame') proof.frameId = 'other-frame'
    if (kind === 'dimensions') proof.width++
    if (kind === 'digest') proof.imageHash = '0'.repeat(64)
    if (kind === 'bytes') proof.imageBytes++
    if (kind === 'identity') admission = { ...admission, sessionIdentity: {} }
    if (kind === 'owner') admission = { ...admission, owner: { ...OWNER, generation: 2 } }
    expect((await h.submit(report, {}, async () => admission)).ok).toBe(false)
    expect((await h.submit(h.payload('egress'))).error).toBe('egress-revoked')
    expect(h.authorize).toHaveBeenCalledTimes(1)
  })

  it('does not seed retention after a response transport rejects actual screenshot delivery', async () => {
    const h = harness()
    const request = h.payload()
    let rejected!: ComputerUseAgentResponse
    h.broker.handle({ type: 'extension_ui_request', method: 'input', id: 'broken-transport', title: PREFIX + JSON.stringify(request) }, async () => h.admission,
      (_id, value) => { rejected = JSON.parse(value); throw new Error('captured stdin destroyed') })
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    expect(rejected.ok).toBe(true)
    h.retain(request, rejected)
    expect((await h.submit(h.payload('egress'))).error).toBe('egress-revoked')
  })

  it('a new run needs its own historical upload approval without capture/control or inheriting the retired desktop permit', async () => {
    const h = harness()
    const request = h.payload()
    h.retain(request, await h.submit(request))
    h.broker.revoke()
    const next = { ...h.admission, owner: Object.freeze({ ...OWNER, runId: 'new-actual-run', generation: 2 }) }
    const before = h.authorize.mock.calls.length
    expect((await h.submit(h.payload('egress'), {}, async () => next)).ok).toBe(true)
    expect(h.authorize).toHaveBeenCalledTimes(before + 1)
    expect(h.authorize).toHaveBeenLastCalledWith(next, 'egress')
    expect(h.service.start).toHaveBeenCalledTimes(1)
    expect(h.service.capture).toHaveBeenCalledTimes(1)
    expect(() => h.broker.assertOwned(next.owner, 'capture')).toThrow()
    expect(h.service.act).not.toHaveBeenCalled()
  })

  it('unsubscribes repeated short provider watches without waiting for the heartbeat or filling four live slots', async () => {
    const h = harness()
    const observed = h.payload()
    h.retain(observed, await h.submit(observed))
    for (let turn = 0; turn < 8; turn++) {
      const request = h.payload('watch')
      const order: string[] = []
      const watched = h.submit(request).then(value => { order.push('watch'); return value })
      for (let tick = 0; tick < 4; tick++) await Promise.resolve()
      const unwatch = h.payload('unwatch', { watchRequestId: request.requestId })
      expect((await h.submit(unwatch)).ok).toBe(true)
      order.push('unwatch')
      expect((await watched).ok).toBe(true)
      expect(order).toEqual(['watch', 'unwatch'])
      expect((await h.submit(unwatch)).ok).toBe(true) // exact own settled replay
    }
    expect(h.service.capture).toHaveBeenCalledTimes(1)
    expect(h.service.stop).not.toHaveBeenCalled()
  })

  it('retains cleanup at the ordinary request capacity rather than stranding a live watch until its deadline', async () => {
    const h = harness()
    const observed = h.payload()
    h.retain(observed, await h.submit(observed))
    for (let request = 0; request < A.maxRequests - 2; request++) expect((await h.submit(h.payload('egress'))).ok).toBe(true)
    const watch = h.payload('watch')
    const pending = h.submit(watch)
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    expect((await h.submit(h.payload('egress'))).error).toBe('invalid-request')
    expect((await h.submit(h.payload('unwatch', { watchRequestId: watch.requestId }))).ok).toBe(true)
    expect((await pending).ok).toBe(true)
  })

  it('cleans up only the original captured watch even after run withdrawal, never another source or a newer run', async () => {
    const h = harness()
    const observed = h.payload()
    h.retain(observed, await h.submit(observed))
    const oldWatch = h.payload('watch')
    const oldPending = h.submit(oldWatch)
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    h.broker.revoke()
    expect((await oldPending).ok).toBe(false)
    const next = { ...h.admission, owner: Object.freeze({ ...OWNER, runId: 'actual-next-run', generation: 2 }) }
    expect((await h.submit(h.payload('egress'), {}, async () => next)).ok).toBe(true)
    const newWatch = h.payload('watch')
    const newPending = h.submit(newWatch, {}, async () => next)
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    expect((await h.submit(h.payload('unwatch', { watchRequestId: newWatch.requestId }))).error).toBe('source-unverified')
    expect((await h.submit(h.payload('unwatch', { watchRequestId: oldWatch.requestId }))).ok).toBe(true)
    expect((await h.submit(h.payload('unwatch', { watchRequestId: newWatch.requestId }), {}, async () => next)).ok).toBe(true)
    expect((await newPending).ok).toBe(true)
  })

  it.each([false, true])('fails closed for missing independent control scope / trusted target guard (control=%s)', async control => {
    const h = harness({}, control)
    const frame = await h.submit(h.payload())
    const result = await h.submit(h.payload('act', { frameId: frame.frameId, action: { type: 'key', keys: 'Enter' } }))
    expect(result.error).toBe(control ? 'target-unverified' : 'input-unavailable')
    expect(h.service.act).not.toHaveBeenCalled()
  })

  it('privately maps model pixels to the actual full frame once, never using a 512px preview/native token from input', async () => {
    const guard = { assertAllowed: vi.fn() }
    const h = harness({ trustedTargetGuard: guard, projectFrame: async () => ({ png: new Uint8Array(makeStaticPng(800, 450)), width: 800, height: 450 }) }, true, 1600, 900)
    const frame = await h.submit(h.payload())
    expect(frame).toMatchObject({ ok: true, width: 800, height: 450 })
    const native = h.state().frame!
    const action = { type: 'click' as const, x: 10, y: 20, button: 'left' as const }
    expect((await h.submit(h.payload('act', { frameId: frame.frameId, action }))).ok).toBe(true)
    expect(h.service.act).toHaveBeenCalledWith(OWNER, { frameId: native.id, action: { ...action, x: 21, y: 41 } })
    expect(guard.assertAllowed).toHaveBeenCalledWith(h.admission, native, { ...action, x: 21, y: 41 })
    expect((await h.submit(h.payload('act', { frameId: frame.frameId, action }))).error).toBe('frame-stale')
    expect(h.service.act).toHaveBeenCalledTimes(1)
  })
})
