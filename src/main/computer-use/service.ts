import {
  COMPUTER_USE_LIMITS as L, createDisabledComputerUseStatus, sameComputerUseOwner,
  validateComputerUseCapability, validateComputerUseConsent, validateComputerUseFrame,
  validateComputerUseOwner, validateComputerUseStatus,
  type ComputerUseActRequest, type ComputerUseConsent, type ComputerUseOwner, type ComputerUseStatus
} from '../../shared/computer-use'
import { copyComputerUseDiagnostics } from '../../shared/computer-use-diagnostics'
import { assertGeneratedPngData } from '../agent/png-validation'
import type { ComputerUseDriver, ComputerUseDriverFrame } from './driver'
import { decodeHelperPreview } from './helper-client'
import type { ComputerUseCoordination, ComputerUseCoordinationReceipt } from './coordination'
import { ComputerUseInputPolicy } from './input-policy'

export interface ComputerUseServiceOptions {
  /** Required actual durable ownership ledger; never a no-op production default. */
  coordination: ComputerUseCoordination
  driverFactory: () => ComputerUseDriver
  /** Host monotonic milliseconds. Invalid/backwards clocks fail closed. */
  clock: () => number
  randomId: () => string
  publish: (state: ComputerUseStatus) => void
  /** Required in production: host-derived IPC peer/owner, mode, deny, no-YOLO
   * and capture approval checks. Never authenticate model/payload identifiers.
   * Synchronous, checked before dispatch and again after every driver await. */
  assertOwned?: (owner: Readonly<ComputerUseOwner>, operation: 'start' | 'capture' | 'act', phase: 'before' | 'after') => void
  /** Development execution gate, never a substitute for this lease's approval. */
  allowVirtualInput?: boolean
  /** Pure development configuration projection; never probes GPU support or grants capture permission. */
  allowDmaBufReadback?: boolean
}
interface Lease {
  owner: ComputerUseOwner
  driver?: ComputerUseDriver
  /** Private proof: never projected into status or IPC. */
  receipt?: ComputerUseCoordinationReceipt
  claim: 'not-attempted' | 'pending' | 'held' | 'blocked' | 'clean' | 'unknown'
  abort: AbortController
  epoch: number
  startedAt: number
  pending?: Promise<unknown>
  closing?: Promise<ComputerUseStatus>
  revoked: boolean
  streamId?: string
  unsubscribeRevoked?: () => void
}

/** Frozen local-preview API for host integration:
 * getState(): ComputerUseStatus (pure, no probing);
 * start(owner, consent): Promise<ComputerUseStatus> (chooser only, no frame);
 * capture(owner): Promise<{ state: ComputerUseStatus; png: Uint8Array }>;
 * stop(owner?, reason?): Promise<ComputerUseStatus>; revoke(owner): void.
 * One host-created instance owns the lease across user waits. Local manual input
 * is separately development-gated. No model upload, SDK/history mutation,
 * retries or background re-observation.
 * Returned PNG is a bounded local attachment, NOT a generic UI thumbnail or
 * model image. IPC must separately bound/project preview; upload:true records
 * intent only. Portal window streams do not authenticate an application.
 */
export class ComputerUseService {
  private state = createDisabledComputerUseStatus()
  private lease?: Lease
  private epoch = 0
  private lastClock = 0
  private readonly inputPolicy = new ComputerUseInputPolicy()

  constructor(private readonly options: ComputerUseServiceOptions) {}

  getState(): ComputerUseStatus { return validateComputerUseStatus({ ...this.state, inputDevelopmentEnabled: this.options.allowVirtualInput === true, dmaBufDevelopmentEnabled: this.options.allowDmaBufReadback === true }) }

  private publish(): void {
    this.state.revision++
    // A display subscriber cannot release physical ownership or break cleanup.
    try { this.options.publish(this.getState()) } catch { /* display only */ }
  }

  private collectDiagnostics(lease: Lease): void {
    if (this.lease !== lease || !lease.driver) return
    // Optional diagnostics are display-only. A broken cache cannot weaken or
    // replace the actual close/coordination result, and state reads never query it.
    try {
      const read = lease.driver.getDiagnostics
      if (!read) return
      const snapshot = copyComputerUseDiagnostics(read.call(lease.driver))
      if (!snapshot || this.lease !== lease) return
      const previous = this.state.diagnostics ?? {}
      this.state.diagnostics = { ...snapshot, ...previous }
    } catch { /* Never project arbitrary getter/error text. */ }
  }

  private now(): number {
    const now = this.options.clock()
    if (!Number.isFinite(now) || now < this.lastClock || now < 0 || now > Number.MAX_SAFE_INTEGER) throw new Error('ComputerUse clock unavailable')
    this.lastClock = now
    return now
  }

  private check(lease: Lease, operation: 'start' | 'capture' | 'act', phase: 'before' | 'after'): void {
    if (this.lease !== lease || lease.revoked || lease.epoch !== this.epoch || lease.abort.signal.aborted) throw new Error('ComputerUse lease revoked')
    this.options.assertOwned?.(Object.freeze({ ...lease.owner }), operation, phase)
    // Hooks may synchronously revoke the lease.
    if (this.lease !== lease || lease.revoked || lease.epoch !== this.epoch || lease.abort.signal.aborted) throw new Error('ComputerUse lease revoked')
    if (!this.state.consent?.capture) throw new Error('ComputerUse capture consent required')
    if (this.state.consent.control && (this.options.allowVirtualInput !== true || typeof this.options.assertOwned !== 'function' || this.state.consent.captureScope !== 'display')) throw new Error('ComputerUse input unavailable')
    if (operation === 'act' && !this.state.consent.control) throw new Error('ComputerUse input consent required')
    if (this.now() - lease.startedAt >= L.maxDurationMs) throw new Error('ComputerUse duration exhausted')
  }

  async start(owner: ComputerUseOwner, consent: ComputerUseConsent): Promise<ComputerUseStatus> {
    const identity = validateComputerUseOwner(owner)
    const approval = validateComputerUseConsent(consent)
    if (!approval.capture) throw new Error('ComputerUse explicit capture consent required')
    if (approval.control ? (approval.captureScope !== 'display' || this.options.allowVirtualInput !== true || typeof this.options.assertOwned !== 'function') : approval.captureScope === 'display') throw new Error('ComputerUse input unavailable')
    if (this.lease) throw new Error('ComputerUse desktop lease occupied')
    this.options.assertOwned?.(Object.freeze({ ...identity }), 'start', 'before')
    if (this.lease) throw new Error('ComputerUse desktop lease occupied')
    const lease: Lease = { owner: identity, abort: new AbortController(), epoch: ++this.epoch, startedAt: this.now(), revoked: false, claim: 'not-attempted' }
    this.lease = lease
    this.state = { ...createDisabledComputerUseStatus(), revision: this.state.revision, scopeRevision: this.state.scopeRevision + 1, state: 'preparing', actualPending: true, owner: identity, consent: approval }
    const work = Promise.resolve().then(async () => {
      this.check(lease, 'start', 'before')
      lease.claim = 'pending'
      try {
        const claim = await this.options.coordination.claim()
        // A stop during claim must still retain its durable receipt before any
        // epoch/document/policy check can throw. No chooser was dispatched yet.
        switch (claim.kind) {
          case 'claimed':
            if (!claim.receipt || claim.receipt.kind !== 'computer-use-coordination-receipt') throw new Error('ComputerUse receipt unavailable')
            lease.receipt = claim.receipt
            lease.claim = 'held'
            this.state.coordination = 'held'
            break
          case 'occupied':
            lease.claim = 'blocked'
            this.state.coordination = 'blocked'
            throw new Error('ComputerUse foreign coordination occupied')
          case 'failed-clean':
            lease.claim = 'clean'
            throw new Error('ComputerUse coordination failed cleanly')
          default:
            lease.claim = 'unknown'
            this.state.coordination = 'unknown'
            throw new Error('ComputerUse coordination unknown')
        }
      } catch (error) {
        if (lease.claim === 'pending') {
          lease.claim = 'unknown'
          this.state.coordination = 'unknown'
        }
        throw error
      }
      this.publish()
      this.check(lease, 'start', 'after')
      lease.driver = this.options.driverFactory()
      this.check(lease, 'start', 'before')
      lease.unsubscribeRevoked = lease.driver.onRevoked?.(() => {
        if (this.lease === lease) void this.stop(identity, 'portal-revoked')
      })
      this.check(lease, 'start', 'before')
      const limits = { maxFrameBytes: L.maxFrameBytes, maxFramePixels: L.maxFramePixels, maxFrameEdge: L.maxFrameEdge }
      // Preserve legacy three-argument window capture; never silently downgrade input.
      const capability = validateComputerUseCapability(await (approval.control
        ? lease.driver.open({ ...identity }, limits, lease.abort.signal, { control: true, captureScope: 'display' })
        : lease.driver.open({ ...identity }, limits, lease.abort.signal)))
      this.check(lease, 'start', 'after')
      if (approval.control) {
        if (!capability.capture || !capability.control || capability.method !== 'portal-screencast+wayland-virtual-input' || capability.scope !== 'display' || typeof lease.driver.act !== 'function' || capability.unsupportedReason !== undefined) throw new Error('ComputerUse display input unavailable')
        this.state.capability = capability
      } else {
        if (!capability.capture || capability.control || capability.method !== 'portal-screencast' || capability.scope !== 'window') throw new Error('ComputerUse window capture unavailable')
        this.state.capability = { ...capability, control: false, unsupportedReason: 'control-unavailable' }
      }
    })
    lease.pending = work
    this.publish()
    try {
      await work
      this.check(lease, 'start', 'after')
      lease.pending = undefined
      this.state.state = 'ready'
      this.state.actualPending = false
      this.publish()
      this.check(lease, 'start', 'after')
      return this.getState()
    } catch {
      this.collectDiagnostics(lease)
      if (lease.pending === work) lease.pending = undefined
      // Cleanup is owned separately; failure does not hide a hanging close.
      if (this.lease === lease) void this.stop(identity)
      throw new Error('ComputerUse start failed or revoked')
    }
  }

  async capture(owner: ComputerUseOwner): Promise<{ state: ComputerUseStatus; png: Uint8Array; previewPng?: Uint8Array }> {
    const lease = this.requireOwner(owner)
    this.check(lease, 'capture', 'before')
    if (lease.pending || lease.closing || this.state.state !== 'ready' || !lease.driver) throw new Error('ComputerUse capture unavailable')
    const budget = this.state.budget
    if (budget.captures >= L.maxCaptures || budget.frameBytes >= L.maxTotalFrameBytes || budget.framePixels >= L.maxTotalFramePixels) throw new Error('ComputerUse capture budget exhausted')
    budget.captures++ // Failed, expired and interrupted attempts never roll back.
    delete this.state.frame
    this.state.state = 'observing'
    this.state.actualPending = true
    const driver = lease.driver
    const work = Promise.resolve().then(async () => {
      this.check(lease, 'capture', 'before')
      const raw = await driver.capture(lease.abort.signal, {
        maxFrameBytes: Math.min(L.maxFrameBytes, L.maxTotalFrameBytes - budget.frameBytes),
        maxFramePixels: Math.min(L.maxFramePixels, L.maxTotalFramePixels - budget.framePixels),
        maxFrameEdge: L.maxFrameEdge
      })
      // Count actual delivered bytes/pixels even for late or malformed output.
      const exceededBudget = this.account(raw)
      this.check(lease, 'capture', 'after')
      if (raw.deliverable === false) throw new Error('ComputerUse portal lease revoked')
      const scope = this.state.consent?.control ? 'display' : 'window'
      const frame = validateComputerUseFrame({ id: this.options.randomId(), width: raw.width, height: raw.height, createdAt: this.now(), scopeRevision: this.state.scopeRevision, captureScope: scope, actualScope: scope })
      if (raw.sourceType !== scope || typeof raw.streamId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(raw.streamId) || (lease.streamId !== undefined && raw.streamId !== lease.streamId)) throw new Error('ComputerUse source changed')
      if (!(raw.png instanceof Uint8Array) || !raw.png.byteLength || raw.png.byteLength > L.maxFrameBytes || exceededBudget) throw new Error('ComputerUse image budget exhausted')
      const png = new Uint8Array(raw.png)
      assertGeneratedPngData(png, frame)
      let previewPng: Uint8Array | undefined
      if (raw.previewPng !== undefined) {
        if (!(raw.previewPng instanceof Uint8Array) || !raw.previewPng.byteLength || raw.previewPng.byteLength > 96 * 1024) throw new Error('ComputerUse preview budget exhausted')
        previewPng = await decodeHelperPreview(Buffer.from(raw.previewPng).toString('base64'))
      }
      this.check(lease, 'capture', 'after')
      lease.streamId = raw.streamId // A portal stream token, not app/window identity.
      if (scope === 'display') {
        // Only a tiny copy of the actual validated driver frame reaches the kernel.
        // Never spread native tokens into status, IPC or a model image.
        this.inputPolicy.install(lease.owner, this.state.scopeRevision, frame, {
          sourceType: raw.sourceType, width: raw.width, height: raw.height,
          inputFrame: raw.inputFrame ? { sequence: raw.inputFrame.sequence, topology: raw.inputFrame.topology } : undefined
        })
      }
      return { png, frame, ...(previewPng ? { previewPng } : {}) }
    })
    lease.pending = work
    this.publish()
    try {
      const result = await work
      this.check(lease, 'capture', 'after')
      lease.pending = undefined
      this.state.frame = result.frame
      this.state.actualPending = false
      this.state.state = 'ready'
      this.publish()
      // A subscriber may have revoked during publication. Never return old pixels.
      this.check(lease, 'capture', 'after')
      return { state: this.getState(), png: result.png, ...(result.previewPng ? { previewPng: result.previewPng } : {}) }
    } catch {
      this.collectDiagnostics(lease)
      if (lease.pending === work) lease.pending = undefined
      if (this.lease === lease) void this.stop(lease.owner)
      throw new Error('ComputerUse capture failed or revoked')
    }
  }

  /** Local manual transaction submission, not SDK/tool or application success. */
  async act(owner: ComputerUseOwner, request: ComputerUseActRequest): Promise<ComputerUseStatus> {
    const lease = this.requireOwner(owner)
    this.check(lease, 'act', 'before')
    const driver = lease.driver
    if (lease.pending || lease.closing || this.state.state !== 'ready' || !this.state.frame || !driver?.act || !this.state.capability || !this.state.consent) throw new Error('ComputerUse input unavailable')
    const frameId = this.state.frame.id
    const descriptor = request && typeof request === 'object' ? Object.getOwnPropertyDescriptor(request, 'frameId') : undefined
    let reservation: ReturnType<ComputerUseInputPolicy['reserve']>
    try {
      reservation = this.inputPolicy.reserve(lease.owner, this.state.scopeRevision, request, {
        now: this.now(), startedAt: lease.startedAt, consent: this.state.consent,
        capability: this.state.capability, budget: this.state.budget,
        assertAllowed: (_identity, phase) => this.check(lease, 'act', phase)
      })
    } catch {
      // Matching failures consume the policy slot too; a new observation is needed.
      if (descriptor && 'value' in descriptor && descriptor.value === frameId) {
        delete this.state.frame
        this.publish()
      }
      throw new Error('ComputerUse input unavailable')
    }
    delete this.state.frame
    this.check(lease, 'act', 'before')
    this.state.budget = reservation.budget // Commit before dispatch; never refund.
    this.state.state = 'acting'
    this.state.actualPending = true
    const work = Promise.resolve().then(async () => {
      this.check(lease, 'act', 'before')
      const result = await driver.act!(reservation.action, reservation.nativeFence, lease.abort.signal)
      this.check(lease, 'act', 'after')
      if (result !== undefined) throw new Error('ComputerUse input submission unverified')
    })
    lease.pending = work
    this.publish()
    try {
      await work
      this.check(lease, 'act', 'after')
      lease.pending = undefined
      this.state.actualPending = false
      this.state.state = 'ready'
      this.publish()
      this.check(lease, 'act', 'after')
      return this.getState()
    } catch {
      this.collectDiagnostics(lease)
      if (lease.pending === work) lease.pending = undefined
      if (this.lease === lease) void this.stop(lease.owner)
      throw new Error('ComputerUse input failed or revoked')
    }
  }

  private account(raw: ComputerUseDriverFrame): boolean {
    const b = this.state.budget
    const bytes = raw?.png instanceof Uint8Array ? raw.png.byteLength : 0
    const pixels = Number.isSafeInteger(raw?.width) && Number.isSafeInteger(raw?.height) && raw.width > 0 && raw.height > 0 ? raw.width * raw.height : 0
    const totalBytes = b.frameBytes + bytes
    const totalPixels = b.framePixels + (Number.isFinite(pixels) ? pixels : L.maxTotalFramePixels + 1)
    // Preserve over-limit evidence before projecting saturated display counters.
    const exceeded = totalBytes > L.maxTotalFrameBytes || totalPixels > L.maxTotalFramePixels
    b.frameBytes = Math.min(L.maxTotalFrameBytes, totalBytes)
    b.framePixels = Math.min(L.maxTotalFramePixels, totalPixels)
    return exceeded
  }

  private requireOwner(owner: ComputerUseOwner): Lease {
    const identity = validateComputerUseOwner(owner)
    if (!this.lease || !sameComputerUseOwner(this.lease.owner, identity)) throw new Error('ComputerUse owner mismatch')
    return this.lease
  }

  stop(owner?: ComputerUseOwner, _reason?: string): Promise<ComputerUseStatus> {
    if (!this.lease) {
      if (owner) validateComputerUseOwner(owner)
      return Promise.resolve(this.getState())
    }
    const lease = owner ? this.requireOwner(owner) : this.lease
    if (!lease) return Promise.resolve(this.getState())
    if (lease.closing) return lease.closing
    lease.revoked = true
    this.inputPolicy.clear()
    ++this.epoch
    delete this.state.frame
    this.state.scopeRevision++
    this.state.consent = { capture: false, upload: false, retention: 'sdk-session', control: false }
    // Revocation starts an actual cleanup, not proof that cleanup failed.
    // Unknown FS ownership is already unverified; an ordinary claim/close or
    // release keeps the same slot while its real result is still pending.
    this.state.state = lease.claim === 'unknown' ? 'quarantined' : 'stopping'
    this.state.actualPending = true
    // Schedule once; close may unblock capture/open but must also really settle.
    const pending = lease.pending
    lease.closing = Promise.resolve().then(async () => {
      const quarantine = (): ComputerUseStatus => {
        this.collectDiagnostics(lease)
        this.state.state = 'quarantined'
        this.state.capability = { platform: 'linux-wayland', method: 'unavailable', capture: false, control: false, scope: 'unknown-window-or-display', unsupportedReason: 'stop-unverified' }
        this.publish()
        return this.getState()
      }
      const close = Promise.resolve().then(() => lease.driver?.close()).then(result => {
        // A known close failure is uncertain even if other actual work still
        // hangs. Publish that failure without resolving closing or freeing slots.
        if (result !== undefined) quarantine()
        return result
      }, error => { quarantine(); throw error })
      const results = await Promise.allSettled([pending, close])
      this.collectDiagnostics(lease)
      if (results[1].status === 'rejected' || results[1].value !== undefined || lease.claim === 'unknown' || lease.claim === 'pending') {
        return quarantine() // No void driver close can clear unknown FS ownership.
      }
      if (lease.claim === 'held') {
        // Keep actualPending and the local slot throughout the real release.
        // Rejection/non-void is permanent uncertainty: never retry unlink.
        try {
          if (!lease.receipt) throw new Error('ComputerUse receipt unavailable')
          const released = await this.options.coordination.release(lease.receipt)
          if (released !== undefined) throw new Error('ComputerUse release unverified')
          this.state.coordination = 'released'
        } catch {
          this.state.coordination = 'unknown'
          return quarantine()
        }
      }
      // These branches positively never acquired a marker. Only after work and
      // driver close really settle can they certify zero resources of our own.
      // not-checked/default metadata is deliberately not this proof.
      if (lease.claim === 'not-attempted' || lease.claim === 'clean') this.state.coordination = 'unclaimed'
      try { lease.unsubscribeRevoked?.() } catch { /* listener removal is not resource proof */ }
      // occupied is positive zero OWN resources, not proof that the foreign
      // desktop stopped. Only a later explicit start may attempt a new claim.
      this.lease = undefined
      this.state.state = lease.claim === 'blocked' ? 'quarantined' : 'stopped'
      this.state.actualPending = false
      delete this.state.owner
      this.publish()
      return this.getState()
    })
    lease.abort.abort()
    this.publish()
    return lease.closing
  }

  revoke(owner: ComputerUseOwner): void { void this.stop(owner, 'revoked') }
}
