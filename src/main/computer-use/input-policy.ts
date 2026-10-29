import {
  COMPUTER_USE_LIMITS as L, reserveComputerUseAction, sameComputerUseOwner,
  validateComputerUseActRequest, validateComputerUseFrame, validateComputerUseOwner,
  type ComputerUseAction, type ComputerUseBudget, type ComputerUseConsent,
  type ComputerUseFrame, type ComputerUseOwner
} from '../../shared/computer-use'

/** Private native tokens, only from the helper's validated capture response.
 * Never include these in status, UI, receipts or model image bodies. */
export interface ComputerUseNativeInputFence { sequence: number; topology: number }
export interface ComputerUseInputContext {
  /** Trusted host monotonic time and lease start, NOT tool-request fields. */
  now: number
  startedAt: number
  consent: ComputerUseConsent & { captureScope?: string }
  capability: { platform: string; method: string; capture: boolean; control: boolean; scope: string }
  budget: ComputerUseBudget
  /** Required trusted service/bridge callback: actual root/runtime identity,
   * current deny/plan/YOLO policy and live owner approval. Synchronous, no resources.
   * No caller-provided booleans or request-embedded context authenticate a source. */
  assertAllowed: (owner: Readonly<ComputerUseOwner>, phase: 'before' | 'after') => void
}
export interface ComputerUseInputReservation {
  action: ComputerUseAction
  nativeFence: ComputerUseNativeInputFence
  /** Service MUST commit this budget before driver dispatch; never roll back on
   * errors/timeouts/unknown outcome. Capture counters are unchanged. */
  budget: ComputerUseBudget
}
interface Slot { frame: ComputerUseFrame; fence: ComputerUseNativeInputFence }
interface Scope {
  owner: ComputerUseOwner
  revision: number
  retired: boolean
  sequence: number
  topology: number
  ids: Set<string>
}
function invalid(): never { throw new Error('ComputerUse input unavailable') }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length > required.length + optional.length) return invalid()
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid()
  }
  if (required.some(key => !Object.hasOwn(value, key))) return invalid()
  return value as Record<string, unknown>
}
function positive(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : invalid()
}
function time(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : invalid()
}

/** Pure single-frame admission kernel, NOT source authentication, permission
 * granting, an OS sandbox, PNG validation, native coordinate mapping, lifecycle
 * management or input dispatch. Constructing it touches no OS/SDK/callback.
 * A single host service owns this instance; scopeRevision must monotonically
 * increase across owner/generation changes, revocation and native restarts.
 * Revisions fence same frame IDs across scopes; IDs and sequences cannot repeat
 * within a scope. The native implementation independently enforces one-use.
 */
export class ComputerUseInputPolicy {
  private scope?: Scope
  private slot?: Slot
  private lastClock = 0
  private reserving = false

  /** Host-only admission after actual PCU source/PNG/dimension validation.
   * Pass a copied bounded projection of the real DriverFrame, never model/UI
   * parameters. No window->display mapping, crops or synthetic fence fallback.
   * Only inputFrame's two positive safe integers are the private native fence. */
  install(owner: ComputerUseOwner, scopeRevision: number, frame: unknown, nativeFrame: unknown): void {
    if (this.reserving) return invalid()
    const identity = validateComputerUseOwner(owner)
    const revision = positive(scopeRevision)
    const f = validateComputerUseFrame(frame)
    const native = record(nativeFrame, ['sourceType', 'width', 'height', 'inputFrame'])
    const tokens = record(native.inputFrame, ['sequence', 'topology'])
    const fence = { sequence: positive(tokens.sequence), topology: positive(tokens.topology) }
    if (f.scopeRevision !== revision || f.captureScope !== 'display' || f.actualScope !== 'display' || f.windowId !== undefined || native.sourceType !== 'display' || native.width !== f.width || native.height !== f.height) return invalid()
    let scope = this.scope
    if (scope && revision <= scope.revision) {
      if (scope.retired || revision !== scope.revision || !sameComputerUseOwner(identity, scope.owner) || fence.sequence <= scope.sequence || fence.topology !== scope.topology || scope.ids.has(f.id) || scope.ids.size >= L.maxCaptures) return invalid()
    } else {
      scope = { owner: identity, revision, retired: false, sequence: 0, topology: fence.topology, ids: new Set() }
    }
    scope.sequence = fence.sequence
    scope.ids.add(f.id)
    this.scope = scope
    this.slot = { frame: f, fence }
  }

  /** Reserve consumes the matching slot synchronously, including any subsequent
   * validation/callback failure. There is no rollback/retry or pending outcome
   * recovery. Foreign owner/scope/frame requests cannot consume another slot.
   * Returned action/fence/budget are fresh copies; reserve accepts no fence. */
  reserve(owner: ComputerUseOwner, scopeRevision: number, request: unknown, context: ComputerUseInputContext): ComputerUseInputReservation {
    const identity = validateComputerUseOwner(owner)
    const scope = this.scope, slot = this.slot
    if (this.reserving || !scope || scope.retired || !slot || scopeRevision !== scope.revision || !sameComputerUseOwner(identity, scope.owner)) return invalid()
    const raw = record(request, ['frameId', 'action'])
    if (raw.frameId !== slot.frame.id) return invalid()
    this.slot = undefined // Never revive on any error or unknown driver outcome.
    this.reserving = true
    try {
      const { action } = validateComputerUseActRequest(request, slot.frame)
      // Initial native protocol supports only printable ASCII, never partial
      // text injection, control sequences or silent Unicode truncation.
      if (action.type === 'type' && !/^[\x20-\x7e]+$/.test(action.text)) return invalid()
      const consent = record(context.consent, ['capture', 'upload', 'control', 'retention'], ['captureScope'])
      const capability = record(context.capability, ['platform', 'method', 'capture', 'control', 'scope'])
      if (consent.capture !== true || consent.control !== true || typeof consent.upload !== 'boolean' || consent.retention !== 'sdk-session' || consent.captureScope !== 'display' || capability.platform !== 'linux-wayland' || capability.method !== 'portal-screencast+wayland-virtual-input' || capability.capture !== true || capability.control !== true || capability.scope !== 'display') return invalid()
      const now = time(context.now), startedAt = time(context.startedAt)
      if (now < this.lastClock || now < startedAt || now < slot.frame.createdAt) return invalid()
      this.lastClock = now
      if (now - slot.frame.createdAt > L.frameMaxAgeMs || now - startedAt >= L.maxDurationMs) return invalid()
      const budget = reserveComputerUseAction(context.budget)
      if (typeof context.assertAllowed !== 'function') return invalid()
      const check = (phase: 'before' | 'after'): void => {
        context.assertAllowed(Object.freeze({ ...identity }), phase)
        if (this.scope !== scope || scope.retired) return invalid()
      }
      check('before')
      check('after')
      return { action, nativeFence: { ...slot.fence }, budget }
    } finally { this.reserving = false }
  }

  /** Foreign/late revocation must not erase another owner's newer slot. */
  revoke(owner: ComputerUseOwner, scopeRevision: number): void {
    const identity = validateComputerUseOwner(owner)
    if (this.scope?.revision === scopeRevision && sameComputerUseOwner(this.scope.owner, identity)) this.clear()
  }

  /** Retain revision high-water mark; a new lease requires a newer revision. */
  clear(): void {
    this.slot = undefined
    if (this.scope) this.scope.retired = true
  }
}
