// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import {
  COMPUTER_USE_AGENT_LIMITS as A, COMPUTER_USE_OBSERVE_TOOL, isComputerUseAgentTitle, parseComputerUseAgentTitle,
  validateComputerUseAgentResponse, type ComputerUseAgentError,
  type ComputerUseAgentRequest, type ComputerUseAgentResponse
} from '../../shared/computer-use-agent'
import {
  COMPUTER_USE_LIMITS as L, sameComputerUseOwner, validateComputerUseAction,
  validateComputerUseFrame, validateComputerUseOwner,
  type ComputerUseAction, type ComputerUseFrame, type ComputerUseOwner, type ComputerUseStatus
} from '../../shared/computer-use'
import { assertGeneratedPngData } from './png-validation'
import type { ComputerUseService } from '../computer-use/service'

export interface ComputerUseAgentAdmission {
  /** Minted from captured BackendRecord/client/root receipt and live document,
   * never copied from a model/renderer request. */
  owner: Readonly<ComputerUseOwner>
  cwd: string
  sessionPath: string
  sessionId: string
  /** Private, main-minted identity of this BackendRecord/client/factory/session.
   * It survives runs, not runtime replacements, imports or session switches. */
  sessionIdentity: object
  provider: string
  modelId: string
  imageSupported: boolean
  /** Backend/client/run/generation/cwd/session/document/plan/explicit subset. */
  assertCurrent(): void
  /** Additionally, observe/act require their still-running actual root receipt. */
  assertRequestCurrent(): void
  /** Cleanup only: captured actual client/runtime/session, without requiring a
   * still-running provider, root tool, permission or desktop lease. */
  assertCleanupCurrent(): void
}
export interface ComputerUseAgentModelProjection { png: Uint8Array; width: number; height: number }

/** Encoder output only. Validate before traversing, keep original CRC bytes and
 * the complete IDAT/IEND, then validate the stripped result independently. A
 * palette/tRNS cannot be removed without changing essential pixel information. */
export function normalizeComputerUseModelPng(png: Uint8Array, dimensions: { width: number; height: number }): Uint8Array {
  assertGeneratedPngData(png, dimensions)
  const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  const keep = (type: string): boolean => type === 'IHDR' || type === 'IDAT' || type === 'IEND'
  let byteLength = 8
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    if (type === 'PLTE' || type === 'tRNS') reject('capture-failed')
    if (keep(type)) byteLength += length + 12
    offset += length + 12
  }
  // No per-chunk array: tiny/empty IDAT fragments cannot inflate record count.
  const result = Buffer.allocUnsafe(byteLength)
  data.copy(result, 0, 0, 8)
  let written = 8
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset)
    if (keep(data.toString('ascii', offset + 4, offset + 8))) {
      data.copy(result, written, offset, offset + length + 12)
      written += length + 12
    }
    offset += length + 12
  }
  assertGeneratedPngData(result, dimensions)
  return result
}
export interface ComputerUseAgentTrustedTargetGuard {
  /** Must use trusted live focus/protected-target AND physical takeover evidence,
   * not screenshot text/title/app_id alone. Missing/unknown evidence must throw.
   * A returned value is not proof that the target application completed input. */
  assertAllowed(scope: Readonly<ComputerUseAgentAdmission>, frame: Readonly<ComputerUseFrame>, action: Readonly<ComputerUseAction>): void | Promise<void>
}
export interface ComputerUseAgentBridgeOptions {
  enabled: boolean
  /** The existing process-global ComputerUseService, not a second lease. */
  service: Pick<ComputerUseService, 'getState' | 'start' | 'capture' | 'act' | 'stop' | 'revoke'>
  randomId(): string
  clock(): number
  /** Must be an independent, non-rememberable real tool approval. Neither YOLO,
   * global external allow, project trust nor an ordinary question is approval. */
  authorize(scope: ComputerUseAgentAdmission, operation: 'observe' | 'act' | 'egress'): Promise<boolean>
  /** Independent current combined deny checks, including service dispatch hooks. */
  assertPolicy(scope: ComputerUseAgentAdmission, operation: 'observe' | 'act' | 'egress'): void
  /** A full model-sized PNG, never the UI's independent 512px thumbnail. */
  projectFrame?(png: Uint8Array, frame: Readonly<ComputerUseFrame>): Promise<ComputerUseAgentModelProjection>
  trustedTargetGuard?: ComputerUseAgentTrustedTargetGuard
  onRevoked?(scope: Readonly<ComputerUseAgentAdmission>): void
}
interface ModelFrame {
  id: string
  original: ComputerUseFrame
  width: number
  height: number
  consumed: boolean
}
interface RetainedDelivery {
  owner: Readonly<ComputerUseOwner>
  frameId: string
  scopeRevision: number
  width: number
  height: number
  imageHash: string
  imageBytes: number
  observationRequestId: string
  provider: string
  modelId: string
  entryId?: string
}
interface RetainedScope {
  owner: Readonly<ComputerUseOwner>
  sessionPath: string
  sessionId: string
  scopeRevision?: number
  deliveries: Map<string, RetainedDelivery>
}
interface WatchRegistration {
  request: ComputerUseAgentRequest
  admission: ComputerUseAgentAdmission
  scope: Scope
  settled: boolean
  finish(): void
  delivered: Promise<boolean>
  deliveryFinished(delivered: boolean): void
}
interface Scope {
  admission: ComputerUseAgentAdmission
  permit: boolean
  captureApproved: boolean
  revoked: boolean
  frame?: ModelFrame
  pending?: Promise<ComputerUseAgentResponse>
  watchers: Set<WatchRegistration>
}
export class ComputerUseAgentProtocolError extends Error {
  constructor(readonly code: ComputerUseAgentError) { super(code) }
}
function reject(code: ComputerUseAgentError): never { throw new ComputerUseAgentProtocolError(code) }

/** Private protocol controller only. Construction/status do not probe desktop,
 * start a backend, authorize, read credentials, or send a provider request. */
export class ComputerUseAgentBridge {
  private scope?: Scope
  private readonly seen = new Set<string>()
  /** Actual delivered screenshot provenance, not a reusable upload grant. */
  private readonly retainedScopes = new Map<object, RetainedScope>()
  /** Settled tombstones are bounded by maxRequests; IDs alone grant nothing. */
  private readonly watches = new Map<string, WatchRegistration>()
  private lastClock = 0

  constructor(private readonly options: ComputerUseAgentBridgeOptions) {}

  /** Always consume a reserved title, including malformed/non-input/nested ones,
   * before normal questions, chat/live snapshots and billing. */
  handle(event: unknown, admit: (request: ComputerUseAgentRequest) => Promise<ComputerUseAgentAdmission>, respond: (id: string, value: string) => void): boolean {
    if (!event || typeof event !== 'object') return false
    const input = event as { title?: unknown; id?: unknown; type?: unknown; method?: unknown; parentToolCallId?: unknown }
    if (!isComputerUseAgentTitle(input.title)) return false
    const id = typeof input.id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(input.id) ? input.id : undefined
    let request: ComputerUseAgentRequest
    try {
      request = parseComputerUseAgentTitle(input.title)
      if (input.type !== 'extension_ui_request' || input.method !== 'input' || input.parentToolCallId !== undefined || !id) reject('invalid-request')
    } catch {
      if (id) this.reply(respond, id, { version: 1, ok: false, operation: 'observe', requestId: 'invalid', error: 'invalid-request' })
      return true
    }
    const captured = request
    let admission: ComputerUseAgentAdmission | undefined
    void this.execute(captured, async value => { admission = await admit(value); return admission })
      .catch(error => this.failure(captured, error)).then(result => {
        if (result.ok) {
          try {
            // Fence actual delivery as well as the asynchronous work. Cleanup
            // grants no capture/egress and need not keep a retired run alive.
            if (!admission) reject('scope-revoked')
            if (captured.operation === 'unwatch') admission.assertCleanupCurrent()
            else if (captured.operation === 'retained') {
              admission.assertRequestCurrent()
              this.options.assertPolicy(admission, 'egress')
            } else {
              if (!this.scope || !this.scope.permit || !sameComputerUseOwner(this.scope.admission.owner, admission.owner)
                || this.scope.admission.sessionIdentity !== admission.sessionIdentity) reject('scope-revoked')
              this.check(this.scope, captured.operation === 'watch' ? 'egress' : captured.operation)
              admission.assertRequestCurrent()
            }
          } catch (error) { result = this.failure(captured, error) }
        }
        const delivered = !!id && this.reply(respond, id, result)
        if (delivered && result.ok && captured.operation === 'observe' && admission) this.deliverScreenshot(captured, admission, result)
        const registration = this.watches.get(`${captured.runtimeId}:${captured.requestId}`)
        // A replayed watch cannot finish the original watch's delivery receipt.
        if (registration?.request === captured) registration.deliveryFinished(delivered)
      })
    return true
  }

  private reply(respond: (id: string, value: string) => void, id: string, response: ComputerUseAgentResponse): boolean {
    try { respond(id, JSON.stringify(validateComputerUseAgentResponse(response))); return true }
    catch { return false } // Old transports are never replaced/retried here.
  }

  /** Seed provenance only after a checked screenshot response was actually
   * accepted by its captured transport. This is not yet a retained SDK entry. */
  private deliverScreenshot(request: ComputerUseAgentRequest, admission: ComputerUseAgentAdmission, response: ComputerUseAgentResponse): void {
    try {
      admission.assertRequestCurrent()
      const scope = this.scope
      if (!request.toolCallId || !response.image || !response.frameId || !response.width || !response.height || response.scopeRevision === undefined
        || !scope || scope.revoked || !scope.permit || scope.admission.sessionIdentity !== admission.sessionIdentity
        || !sameComputerUseOwner(scope.admission.owner, admission.owner) || scope.frame?.id !== response.frameId) return
      let retained = this.retainedScopes.get(admission.sessionIdentity)
      if (!retained) {
        retained = { owner: admission.owner, sessionPath: admission.sessionPath, sessionId: admission.sessionId, deliveries: new Map() }
        this.retainedScopes.set(admission.sessionIdentity, retained)
      }
      if (retained.sessionPath !== admission.sessionPath || retained.sessionId !== admission.sessionId || retained.owner.backendId !== admission.owner.backendId
        || retained.owner.runtimeId !== admission.owner.runtimeId || retained.deliveries.has(request.toolCallId)) return
      const bytes = Buffer.from(response.image.data, 'base64')
      retained.deliveries.set(request.toolCallId, { owner: admission.owner, frameId: response.frameId, scopeRevision: response.scopeRevision,
        width: response.width, height: response.height, imageHash: createHash('sha256').update(bytes).digest('hex'), imageBytes: bytes.byteLength,
        observationRequestId: request.requestId, provider: request.provider, modelId: request.modelId })
    } catch { /* Failed/late delivery never manufactures retained provenance. */ }
  }

  /** Preserve actual entry_appended paths where SDK emits them. Ordinary pinned
   * tool results instead use the factory's post-append retained operation below.
   * Neither path can seed provenance without the original delivered response. */
  recordScreenshotEntry(sessionIdentity: object, source: { backendId: string; runtimeId: string; runId: string; toolCallId: string }, entry: unknown): void {
    const retained = this.retainedScopes.get(sessionIdentity)
    const delivery = retained?.deliveries.get(source.toolCallId)
    if (!retained || !delivery || delivery.entryId || delivery.owner.backendId !== source.backendId
      || delivery.owner.runtimeId !== source.runtimeId || delivery.owner.runId !== source.runId || !entry || typeof entry !== 'object') return
    const e = entry as { id?: unknown; type?: unknown; message?: { role?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown; details?: Record<string, unknown> } }
    const m = e.message
    const details = m?.details
    if (e.type !== 'message' || typeof e.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(e.id)
      || m?.role !== 'toolResult' || m.toolName !== COMPUTER_USE_OBSERVE_TOOL || m.toolCallId !== source.toolCallId || m.isError === true
      || !details || details.frameId !== delivery.frameId || details.scopeRevision !== delivery.scopeRevision
      || details.width !== delivery.width || details.height !== delivery.height || details.retention !== 'sdk-session'
      || !Array.isArray(m.content) || m.content.length > 8) return
    const images = m.content.filter(part => part && typeof part === 'object' && part.type === 'image')
    if (images.length !== 1 || images[0].mimeType !== 'image/png' || typeof images[0].data !== 'string'
      || images[0].data.length >= A.maxModelBase64) return
    const bytes = Buffer.from(images[0].data, 'base64')
    if (bytes.byteLength !== delivery.imageBytes || createHash('sha256').update(bytes).digest('hex') !== delivery.imageHash) return
    this.confirmEntry(retained, delivery, e.id)
  }

  private confirmEntry(retained: RetainedScope, delivery: RetainedDelivery, entryId: string): void {
    if (delivery.entryId !== undefined && delivery.entryId !== entryId) reject('source-unverified')
    delivery.entryId = entryId
    if (retained.scopeRevision === undefined || delivery.scopeRevision >= retained.scopeRevision) retained.scopeRevision = delivery.scopeRevision
  }

  private recordFactoryRetention(request: ComputerUseAgentRequest, admission: ComputerUseAgentAdmission): ComputerUseAgentResponse {
    const proof = request.retained
    const retained = this.retainedScopes.get(admission.sessionIdentity)
    const delivery = request.toolCallId && retained?.deliveries.get(request.toolCallId)
    const scope = this.scope
    if (!proof || !retained || !delivery || !scope || scope.admission.sessionIdentity !== admission.sessionIdentity
      || !sameComputerUseOwner(scope.admission.owner, admission.owner) || !sameComputerUseOwner(delivery.owner, admission.owner)
      || retained.sessionPath !== admission.sessionPath || retained.sessionId !== admission.sessionId
      || proof.sessionFile !== admission.sessionPath || proof.sessionId !== admission.sessionId
      || proof.observationRequestId !== delivery.observationRequestId || request.provider !== delivery.provider || request.modelId !== delivery.modelId
      || proof.frameId !== delivery.frameId || proof.scopeRevision !== delivery.scopeRevision || proof.width !== delivery.width || proof.height !== delivery.height
      || proof.imageHash !== delivery.imageHash || proof.imageBytes !== delivery.imageBytes) reject('source-unverified')
    this.confirmEntry(retained, delivery, proof.entryId)
    return { version: 1, ok: true, operation: 'retained', requestId: request.requestId, scopeRevision: delivery.scopeRevision }
  }

  private failure(request: ComputerUseAgentRequest, error: unknown): ComputerUseAgentResponse {
    return { version: 1, ok: false, operation: request.operation, requestId: request.requestId,
      error: error instanceof ComputerUseAgentProtocolError ? error.code : 'scope-revoked' }
  }

  private now(): number {
    const value = this.options.clock()
    if (!Number.isFinite(value) || value < this.lastClock || value < 0 || value > Number.MAX_SAFE_INTEGER) reject('scope-revoked')
    this.lastClock = value
    return value
  }

  private check(scope: Scope, operation: 'observe' | 'act' | 'egress', request = false): void {
    if (!this.options.enabled || this.scope !== scope || scope.revoked) reject('scope-revoked')
    scope.admission.assertCurrent()
    this.options.assertPolicy(scope.admission, operation)
    if (request) scope.admission.assertRequestCurrent()
    if (this.scope !== scope || scope.revoked) reject('scope-revoked')
  }

  /** Called only by the existing service's real assertOwned hook. An arbitrary
   * ComputerUseOwner-shaped object cannot install a grant or a lease. */
  assertOwned(owner: Readonly<ComputerUseOwner>, operation: 'start' | 'capture' | 'act'): void {
    const scope = this.scope
    if (!scope || !sameComputerUseOwner(owner, scope.admission.owner) || !scope.captureApproved || !scope.permit) reject('scope-revoked')
    this.check(scope, operation === 'act' ? 'act' : 'observe')
  }

  /** Revoke provider permission first, then stop ONLY this controller's lease.
   * Logical stop does not release its pending slot or any coordination marker. */
  revoke(owner?: Readonly<ComputerUseOwner>): void {
    const scope = this.scope
    if (!scope || (owner && !sameComputerUseOwner(owner, scope.admission.owner))) return
    scope.permit = false
    scope.revoked = true
    delete scope.frame
    for (const watcher of [...scope.watchers]) watcher.finish()
    try { this.options.onRevoked?.(scope.admission) } catch { /* UI cleanup cannot suppress physical revocation. */ }
    // Never call revoke/stop with a foreign manual or newer owner; service
    // requireOwner intentionally throws on such mismatches.
    const state = this.options.service.getState()
    if (state.owner && sameComputerUseOwner(state.owner, scope.admission.owner)) {
      try {
        this.options.service.revoke(scope.admission.owner)
        void this.options.service.stop(scope.admission.owner, 'agent-scope-revoked').catch(() => undefined)
      } catch { /* Actual service pending/unknown state remains authoritative. */ }
    }
  }

  revokeBackend(backendId: string): void {
    if (this.scope?.admission.owner.backendId === backendId) this.revoke(this.scope.admission.owner)
  }

  onServiceState(state: ComputerUseStatus): void {
    const scope = this.scope
    if (!scope || scope.revoked || !scope.captureApproved) return
    if (state.owner && !sameComputerUseOwner(state.owner, scope.admission.owner)) return
    if (!state.consent?.capture || !state.consent.upload || ['stopping', 'stopped', 'quarantined'].includes(state.state)) this.revoke(scope.admission.owner)
  }

  /** Pure scope check used when a captured backend/document/policy changes. */
  recheck(): void {
    const scope = this.scope
    if (!scope || scope.revoked) return
    try { this.check(scope, 'egress') } catch { this.revoke(scope.admission.owner) }
  }

  private async execute(request: ComputerUseAgentRequest, admit: (request: ComputerUseAgentRequest) => Promise<ComputerUseAgentAdmission>): Promise<ComputerUseAgentResponse> {
    if (!this.options.enabled) reject('unavailable')
    const key = `${request.runtimeId}:${request.requestId}`
    const watchKey = request.watchRequestId && `${request.runtimeId}:${request.watchRequestId}`
    if (this.seen.has(key) || (request.operation !== 'unwatch' && this.seen.size >= A.maxRequests)) reject('invalid-request')
    // Cleanup grants nothing and must remain available even at request capacity.
    // Idempotence comes from the bounded exact watch tombstone, not more IDs.
    if (request.operation !== 'unwatch') this.seen.add(key)
    const admission = await admit(request)
    if (request.operation === 'unwatch') {
      admission.assertCleanupCurrent()
      const registration = watchKey && this.watches.get(watchKey)
      if (!registration || registration.admission !== admission || registration.request.runtimeId !== request.runtimeId
        || registration.request.provider !== request.provider || registration.request.modelId !== request.modelId
        || registration.request.runtimeNonce !== request.runtimeNonce) reject('source-unverified')
      // Remove this exact registration and settle its original response before
      // acknowledging cleanup. Never touch this.scope or another/new run.
      registration.finish()
      if (!await registration.delivered) reject('protocol-error')
      admission.assertCleanupCurrent()
      return { version: 1, ok: true, operation: 'unwatch', requestId: request.requestId }
    }
    admission.assertCurrent()
    admission.assertRequestCurrent()
    const owner = Object.freeze(validateComputerUseOwner(admission.owner))
    if (request.provider !== admission.provider || request.modelId !== admission.modelId || !admission.imageSupported) reject('model-unavailable')
    if (request.operation === 'retained') {
      // Evidence only: no scope creation, capture, upload approval or lease.
      this.options.assertPolicy(admission, 'egress')
      return this.recordFactoryRetention(request, admission)
    }
    let scope = this.scope
    if (!scope || scope.revoked || !sameComputerUseOwner(scope.admission.owner, owner)
      || scope.admission.sessionIdentity !== admission.sessionIdentity
      || scope.admission.provider !== admission.provider || scope.admission.modelId !== admission.modelId) {
      if (scope && !scope.revoked) this.revoke(scope.admission.owner)
      scope = { admission: { ...admission, owner }, permit: false, captureApproved: false, revoked: false, watchers: new Set() }
      this.scope = scope
    }
    // Use this request's source receipt rather than the first observe's now-ended
    // tool receipt. Broad service checks remain the exact same host incarnation.
    const local = scope
    const check = (op: 'observe' | 'act' | 'egress'): void => {
      this.check(local, op)
      admission.assertRequestCurrent()
    }
    const retained = (): RetainedScope | undefined => {
      const value = this.retainedScopes.get(admission.sessionIdentity)
      return value?.sessionPath === admission.sessionPath && value.sessionId === admission.sessionId && value.owner.backendId === owner.backendId && value.owner.runtimeId === owner.runtimeId ? value : undefined
    }
    const result = (): ComputerUseAgentResponse => ({ version: 1, ok: true, operation: request.operation, requestId: request.requestId,
      ...(retained()?.scopeRevision !== undefined ? { scopeRevision: retained()!.scopeRevision! } : {}) })
    if (request.operation === 'watch') {
      check('egress')
      if (!local.permit || retained()?.scopeRevision === undefined) reject('egress-revoked')
      if (local.watchers.size >= 4) reject('busy')
      return new Promise<ComputerUseAgentResponse>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let deliveryFinished!: (delivered: boolean) => void
        const delivered = new Promise<boolean>(accept => { deliveryFinished = accept })
        const registration: WatchRegistration = { request, admission, scope: local, settled: false, delivered, deliveryFinished,
          finish: () => {
            if (registration.settled) return
            registration.settled = true
            clearTimeout(timer)
            local.watchers.delete(registration)
            try { check('egress'); if (!local.permit) reject('egress-revoked'); resolve(result()) }
            catch { resolve({ ...result(), ok: false, error: 'egress-revoked' }) }
          }
        }
        this.watches.set(key, registration)
        local.watchers.add(registration)
        timer = setTimeout(registration.finish, A.watchMs)
        timer.unref?.()
      })
    }
    if (local.pending) reject('busy')
    const work = (async (): Promise<ComputerUseAgentResponse> => {
      if (request.operation === 'egress') {
        check('egress')
        if (retained()?.scopeRevision === undefined) reject('egress-revoked')
        if (!local.permit) {
          const approved = await this.options.authorize(admission, 'egress')
          check('egress')
          if (!approved) { this.revoke(owner); reject('permission-denied') }
          local.permit = true
        }
        check('egress')
        return result()
      }
      if (request.operation === 'observe') {
        check('observe')
        const approved = await this.options.authorize(admission, 'observe')
        check('observe')
        if (!approved) { this.revoke(owner); reject('permission-denied') }
        local.captureApproved = true
        local.permit = true
        const before = this.options.service.getState()
        if (!before.owner) {
          await this.options.service.start(owner, { capture: true, upload: true, control: false, captureScope: 'window', retention: 'sdk-session' })
          check('observe')
        } else if (!sameComputerUseOwner(before.owner, owner)) reject('busy')
        check('observe')
        delete local.frame
        const captured = await this.options.service.capture(owner)
        check('observe')
        const original = validateComputerUseFrame(captured.state.frame)
        if (original.scopeRevision !== captured.state.scopeRevision || !captured.state.owner
          || !sameComputerUseOwner(captured.state.owner, owner) || !captured.state.consent?.capture || !captured.state.consent.upload) reject('capture-failed')
        if (!(captured.png instanceof Uint8Array) || captured.png.byteLength > L.maxFrameBytes) reject('capture-failed')
        assertGeneratedPngData(captured.png, original)
        let projected: ComputerUseAgentModelProjection
        if (this.options.projectFrame) {
          projected = await this.options.projectFrame(captured.png, original)
          check('observe')
        } else {
          if (original.width > A.maxModelEdge || original.height > A.maxModelEdge) reject('model-unavailable')
          projected = { png: captured.png, width: original.width, height: original.height }
        }
        if (!(projected.png instanceof Uint8Array) || !projected.png.byteLength || projected.png.byteLength > A.maxModelImageBytes
          || !Number.isSafeInteger(projected.width) || projected.width < 1 || projected.width > A.maxModelEdge
          || !Number.isSafeInteger(projected.height) || projected.height < 1 || projected.height > A.maxModelEdge
          || projected.width > original.width || projected.height > original.height
          || Math.abs(projected.width / projected.height - original.width / original.height) > 1 / Math.min(projected.width, projected.height)) reject('capture-failed')
        projected = { ...projected, png: normalizeComputerUseModelPng(projected.png, projected) }
        if (Buffer.byteLength(Buffer.from(projected.png).toString('base64')) >= A.maxModelBase64) reject('capture-failed')
        check('observe')
        const current = this.options.service.getState()
        if (current.scopeRevision !== original.scopeRevision || current.frame?.id !== original.id || current.state !== 'ready') reject('frame-stale')
        const id = this.options.randomId()
        local.frame = { id, original, width: projected.width, height: projected.height, consumed: false }
        return { ...result(), scopeRevision: original.scopeRevision, frameId: id, width: projected.width, height: projected.height, image: { mimeType: 'image/png', data: Buffer.from(projected.png).toString('base64') } }
      }
      check('act')
      const frame = local.frame
      if (!frame || frame.id !== request.frameId || frame.consumed || this.now() - frame.original.createdAt < 0 || this.now() - frame.original.createdAt > L.frameMaxAgeMs) reject('frame-stale')
      // Burn eligibility before any await, including failed approval/guard.
      frame.consumed = true
      const state = this.options.service.getState()
      if (!state.owner || !sameComputerUseOwner(state.owner, owner) || state.frame?.id !== frame.original.id || state.scopeRevision !== frame.original.scopeRevision) reject('frame-stale')
      // No silent window->display upgrade; a separately explicit display/control
      // scope and real native mapping must already exist. No guard = NO input.
      if (!state.consent?.control || state.consent.captureScope !== 'display' || !state.consent.upload) reject('input-unavailable')
      if (!this.options.trustedTargetGuard) reject('target-unverified')
      const action = this.mapAction(request.action, frame)
      const approved = await this.options.authorize(admission, 'act')
      check('act')
      if (!approved) { this.revoke(owner); reject('permission-denied') }
      await this.options.trustedTargetGuard.assertAllowed(admission, frame.original, action)
      check('act')
      const latest = this.options.service.getState()
      if (latest.frame?.id !== frame.original.id || latest.scopeRevision !== frame.original.scopeRevision) reject('frame-stale')
      const after = await this.options.service.act(owner, { frameId: frame.original.id, action })
      check('act')
      if (after.state !== 'ready' || after.actualPending || !after.owner || !sameComputerUseOwner(after.owner, owner) || after.scopeRevision !== frame.original.scopeRevision || after.frame) reject('input-unavailable')
      return { ...result(), scopeRevision: frame.original.scopeRevision }
    })()
    local.pending = work
    try {
      const response = await work
      check(request.operation)
      return response
    } catch (error) {
      if (request.operation === 'observe' || request.operation === 'act') this.revoke(owner)
      throw error
    } finally {
      if (local.pending === work) local.pending = undefined
    }
  }

  private mapAction(value: unknown, projection: ModelFrame): ComputerUseAction {
    const frame = { ...projection.original, width: projection.width, height: projection.height }
    const action = validateComputerUseAction(value, frame)
    if (action.type !== 'click' && action.type !== 'scroll') return action
    const x = Math.min(projection.original.width - 1, Math.floor((action.x + 0.5) * projection.original.width / projection.width))
    const y = Math.min(projection.original.height - 1, Math.floor((action.y + 0.5) * projection.original.height / projection.height))
    return validateComputerUseAction({ ...action, x, y }, projection.original)
  }
}
