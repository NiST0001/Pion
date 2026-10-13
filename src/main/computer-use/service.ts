import {
  COMPUTER_USE_LIMITS as L, createDisabledComputerUseStatus, sameComputerUseOwner,
  validateComputerUseCapability, validateComputerUseConsent, validateComputerUseFrame,
  validateComputerUseOwner, validateComputerUseStatus,
  type ComputerUseConsent, type ComputerUseOwner, type ComputerUseStatus
} from '../../shared/computer-use'
import { assertGeneratedPngData } from '../agent/png-validation'
import type { ComputerUseDriver, ComputerUseDriverFrame } from './driver'
import { decodeHelperPreview } from './helper-client'

export interface ComputerUseServiceOptions {
  driverFactory: () => ComputerUseDriver
  /** Host monotonic milliseconds. Invalid/backwards clocks fail closed. */
  clock: () => number
  randomId: () => string
  publish: (state: ComputerUseStatus) => void
  /** Required in production: host-derived IPC peer/owner, mode, deny, no-YOLO
   * and capture approval checks. Never authenticate model/payload identifiers.
   * Synchronous, checked before dispatch and again after every driver await. */
  assertOwned?: (owner: Readonly<ComputerUseOwner>, operation: 'start' | 'capture', phase: 'before' | 'after') => void
}
interface Lease {
  owner: ComputerUseOwner
  driver?: ComputerUseDriver
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
 * One host-created instance owns the lease across user waits. No control,
 * model upload, SDK/history mutation, retries or background re-observation.
 * Returned PNG is a bounded local attachment, NOT a generic UI thumbnail or
 * model image. IPC must separately bound/project preview; upload:true records
 * intent only. Portal window streams do not authenticate an application.
 */
export class ComputerUseService {
  private state = createDisabledComputerUseStatus()
  private lease?: Lease
  private epoch = 0
  private lastClock = 0

  constructor(private readonly options: ComputerUseServiceOptions) {}

  getState(): ComputerUseStatus { return validateComputerUseStatus(this.state) }

  private publish(): void {
    this.state.revision++
    // A display subscriber cannot release physical ownership or break cleanup.
    try { this.options.publish(this.getState()) } catch { /* display only */ }
  }

  private now(): number {
    const now = this.options.clock()
    if (!Number.isFinite(now) || now < this.lastClock || now < 0 || now > Number.MAX_SAFE_INTEGER) throw new Error('ComputerUse clock unavailable')
    this.lastClock = now
    return now
  }

  private check(lease: Lease, operation: 'start' | 'capture', phase: 'before' | 'after'): void {
    if (this.lease !== lease || lease.revoked || lease.epoch !== this.epoch || lease.abort.signal.aborted) throw new Error('ComputerUse lease revoked')
    this.options.assertOwned?.(Object.freeze({ ...lease.owner }), operation, phase)
    // Hooks may synchronously revoke the lease.
    if (lease.revoked || lease.epoch !== this.epoch) throw new Error('ComputerUse lease revoked')
    if (!this.state.consent?.capture || this.state.consent.control) throw new Error('ComputerUse capture consent required')
    if (this.now() - lease.startedAt >= L.maxDurationMs) throw new Error('ComputerUse duration exhausted')
  }

  async start(owner: ComputerUseOwner, consent: ComputerUseConsent): Promise<ComputerUseStatus> {
    const identity = validateComputerUseOwner(owner)
    const approval = validateComputerUseConsent(consent)
    if (!approval.capture || approval.control) throw new Error('ComputerUse is capture-only; explicit capture consent required')
    if (this.lease) throw new Error('ComputerUse desktop lease occupied')
    this.options.assertOwned?.(Object.freeze({ ...identity }), 'start', 'before')
    if (this.lease) throw new Error('ComputerUse desktop lease occupied')
    const lease: Lease = { owner: identity, abort: new AbortController(), epoch: ++this.epoch, startedAt: this.now(), revoked: false }
    this.lease = lease
    this.state = { ...createDisabledComputerUseStatus(), revision: this.state.revision, scopeRevision: this.state.scopeRevision + 1, state: 'preparing', actualPending: true, owner: identity, consent: approval }
    const work = Promise.resolve().then(async () => {
      this.check(lease, 'start', 'before')
      lease.driver = this.options.driverFactory()
      lease.unsubscribeRevoked = lease.driver.onRevoked?.(() => {
        if (this.lease === lease) void this.stop(identity, 'portal-revoked')
      })
      this.check(lease, 'start', 'before')
      const capability = validateComputerUseCapability(await lease.driver.open({ ...identity }, { maxFrameBytes: L.maxFrameBytes, maxFramePixels: L.maxFramePixels, maxFrameEdge: L.maxFrameEdge }, lease.abort.signal))
      this.check(lease, 'start', 'after')
      if (!capability.capture || capability.control || capability.method !== 'portal-screencast' || capability.scope !== 'window') throw new Error('ComputerUse window capture unavailable')
      this.state.capability = { ...capability, control: false, unsupportedReason: 'control-unavailable' }
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
      const frame = validateComputerUseFrame({ id: this.options.randomId(), width: raw.width, height: raw.height, createdAt: this.now(), scopeRevision: this.state.scopeRevision, captureScope: 'window', actualScope: 'window' })
      if (raw.sourceType !== 'window' || typeof raw.streamId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(raw.streamId) || (lease.streamId !== undefined && raw.streamId !== lease.streamId)) throw new Error('ComputerUse source changed')
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
      if (lease.pending === work) lease.pending = undefined
      if (this.lease === lease) void this.stop(lease.owner)
      throw new Error('ComputerUse capture failed or revoked')
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
    ++this.epoch
    delete this.state.frame
    this.state.scopeRevision++
    this.state.consent = { capture: false, upload: false, retention: 'sdk-session', control: false }
    this.state.state = 'quarantined'
    this.state.actualPending = true
    // Schedule once; close may unblock capture/open but must also really settle.
    const pending = lease.pending
    lease.closing = Promise.resolve().then(async () => {
      const close = Promise.resolve().then(() => lease.driver?.close())
      const results = await Promise.allSettled([pending, close])
      if (results[1].status === 'rejected' || results[1].value !== undefined) {
        this.state.capability = { platform: 'linux-wayland', method: 'unavailable', capture: false, control: false, scope: 'unknown-window-or-display', unsupportedReason: 'stop-unverified' }
        this.publish()
        return this.getState() // Keep lease and unknown physical pending forever.
      }
      try { lease.unsubscribeRevoked?.() } catch { /* inert listener: identity still fenced */ }
      this.lease = undefined
      this.state.state = 'stopped'
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
