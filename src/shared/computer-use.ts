// SPDX-License-Identifier: MIT
// Pure contracts only: identifiers correlate host records; none authenticate a peer.
export interface ComputerUseOwner {
  ownerWindowId: number
  backendId: string
  runtimeId: string
  runId: string
  generation: number
}

export interface ComputerUseConsent {
  capture: boolean
  upload: boolean
  retention: 'sdk-session'
  control: boolean
}

export type ComputerUseScope = 'unknown-window-or-display' | 'window' | 'display'
export interface ComputerUseCapability {
  platform: 'linux-wayland'
  method: 'portal-screencast' | 'portal-remote-desktop' | 'unavailable'
  capture: boolean
  control: boolean
  unsupportedReason?: 'not-probed' | 'portal-unavailable' | 'capture-unavailable' | 'control-unavailable' | 'stop-unverified' | 'scope-unverified'
  scope: ComputerUseScope
}

// Exact whole combinations, not arbitrary key names or raw down/up operations.
export const COMPUTER_USE_KEYS = Object.freeze([
  'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Delete',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
  'PageUp', 'PageDown', 'Control+a', 'Control+z'
] as const)
export type ComputerUseKey = typeof COMPUTER_USE_KEYS[number]
export type ComputerUseAction =
  | { type: 'click'; x: number; y: number; button: 'left' }
  | { type: 'key'; keys: ComputerUseKey }
  | { type: 'type'; text: string }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }

export interface ComputerUseFrame {
  id: string
  width: number
  height: number
  /** Host monotonic milliseconds, never SDK/wall-clock timestamps. */
  createdAt: number
  scopeRevision: number
  /** Actual local capture scope, not a cropped image's apparent scope. */
  captureScope: ComputerUseScope
  actualScope: ComputerUseScope
  /** Optional informational host handles, not process/window authentication. */
  windowId?: string
  displayId?: string
}

export type ComputerUseState = 'disabled' | 'preparing' | 'awaiting-consent' | 'observing' | 'ready' | 'acting' | 'stopping' | 'stopped' | 'paused' | 'quarantined'
export type ComputerUseReceiptStatus = 'rejected-before-execution' | 'executed' | 'failed' | 'interrupted' | 'outcome-unknown'
export interface ComputerUseReceipt {
  requestId: string
  actionId: string
  toolCallId: string
  frameId: string
  scopeRevision: number
  status: ComputerUseReceiptStatus
  /** True until capture/input/release really settles, including after timeout. */
  actualPending: boolean
}
export interface ComputerUseBudget {
  actions: number
  captures: number
  frameBytes: number
  framePixels: number
}
export interface ComputerUseStatus {
  state: ComputerUseState
  revision: number
  scopeRevision: number
  actualPending: boolean
  budget: ComputerUseBudget
  owner?: ComputerUseOwner
  consent?: ComputerUseConsent
  capability?: ComputerUseCapability
  frame?: ComputerUseFrame
  receipt?: ComputerUseReceipt
}

// Proposed conservative source defaults, NOT platform/SDK acceptance guarantees.
// Admission budgets never prove a physical transaction stopped at its deadline.
export const COMPUTER_USE_LIMITS = Object.freeze({
  maxActions: 40,
  maxDurationMs: 10 * 60_000,
  actionTimeoutMs: 5_000,
  consentTimeoutMs: 120_000,
  frameMaxAgeMs: 30_000,
  maxCaptures: 80,
  maxFrameBytes: 8 * 1024 * 1024,
  maxFramePixels: 8_000_000,
  maxFrameEdge: 4096,
  maxTotalFrameBytes: 64 * 1024 * 1024,
  maxTotalFramePixels: 80_000_000,
  maxTextBytes: 4096,
  maxActionBytes: 8192,
  maxScrollDelta: 1200,
  maxIdBytes: 256
})
export const DEFAULT_COMPUTER_USE_CONSENT: Readonly<ComputerUseConsent> = Object.freeze({ capture: false, upload: false, retention: 'sdk-session', control: false })
export const DEFAULT_COMPUTER_USE_CAPABILITY: Readonly<ComputerUseCapability> = Object.freeze({ platform: 'linux-wayland', method: 'unavailable', capture: false, control: false, unsupportedReason: 'not-probed', scope: 'unknown-window-or-display' })

function invalid(): never { throw new Error('Invalid ComputerUse contract') }
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
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid()
  return value
}
function monotonic(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : invalid()
}
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid() }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : invalid()
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) return invalid()
  // Reject lone surrogates rather than silently encoding replacement characters.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid()
    } else if (code >= 0xdc00 && code <= 0xdfff) return invalid()
  }
  if (new TextEncoder().encode(value).byteLength > max || value.includes('\0')) return invalid()
  return value
}
function id(value: unknown): string {
  const result = text(value, COMPUTER_USE_LIMITS.maxIdBytes)
  // Opaque correlation tokens only: no URL/path/base64 diagnostics in status.
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) return invalid()
  return result
}
function scope(value: unknown): ComputerUseScope { return choice(value, ['unknown-window-or-display', 'window', 'display']) }

export function validateComputerUseOwner(value: unknown): ComputerUseOwner {
  const v = record(value, ['ownerWindowId', 'backendId', 'runtimeId', 'runId', 'generation'])
  return { ownerWindowId: integer(v.ownerWindowId, 1), backendId: id(v.backendId), runtimeId: id(v.runtimeId), runId: id(v.runId), generation: integer(v.generation) }
}
export function sameComputerUseOwner(a: ComputerUseOwner, b: ComputerUseOwner): boolean {
  return a.ownerWindowId === b.ownerWindowId && a.backendId === b.backendId && a.runtimeId === b.runtimeId && a.runId === b.runId && a.generation === b.generation
}
export function validateComputerUseConsent(value: unknown): ComputerUseConsent {
  const v = record(value, ['capture', 'upload', 'retention', 'control'])
  return { capture: boolean(v.capture), upload: boolean(v.upload), retention: choice(v.retention, ['sdk-session']), control: boolean(v.control) }
}
export function validateComputerUseCapability(value: unknown): ComputerUseCapability {
  const v = record(value, ['platform', 'method', 'capture', 'control', 'scope'], ['unsupportedReason'])
  const result: ComputerUseCapability = { platform: choice(v.platform, ['linux-wayland']), method: choice(v.method, ['portal-screencast', 'portal-remote-desktop', 'unavailable']), capture: boolean(v.capture), control: boolean(v.control), scope: scope(v.scope) }
  if (Object.hasOwn(v, 'unsupportedReason')) result.unsupportedReason = choice(v.unsupportedReason, ['not-probed', 'portal-unavailable', 'capture-unavailable', 'control-unavailable', 'stop-unverified', 'scope-unverified'] as const)
  if ((result.method === 'unavailable' && (result.capture || result.control)) || (result.method === 'portal-screencast' && result.control) || ((!result.capture || !result.control) && !result.unsupportedReason)) return invalid()
  return result
}
export function validateComputerUseFrame(value: unknown): ComputerUseFrame {
  const v = record(value, ['id', 'width', 'height', 'createdAt', 'scopeRevision', 'captureScope', 'actualScope'], ['windowId', 'displayId'])
  const result: ComputerUseFrame = { id: id(v.id), width: integer(v.width, 1, COMPUTER_USE_LIMITS.maxFrameEdge), height: integer(v.height, 1, COMPUTER_USE_LIMITS.maxFrameEdge), createdAt: monotonic(v.createdAt), scopeRevision: integer(v.scopeRevision), captureScope: scope(v.captureScope), actualScope: scope(v.actualScope) }
  if (result.width * result.height > COMPUTER_USE_LIMITS.maxFramePixels) return invalid()
  if (Object.hasOwn(v, 'windowId')) result.windowId = id(v.windowId)
  if (Object.hasOwn(v, 'displayId')) result.displayId = id(v.displayId)
  return result
}

/** Only checks pixels in the delivered frame. Does NOT map to OS coordinates. */
export function validateComputerUseAction(value: unknown, frame: ComputerUseFrame): ComputerUseAction {
  const f = validateComputerUseFrame(frame)
  const v = record(value, ['type'], ['x', 'y', 'button', 'keys', 'text', 'deltaX', 'deltaY'])
  let result: ComputerUseAction
  switch (v.type) {
    case 'click': {
      record(value, ['type', 'x', 'y', 'button'])
      result = { type: 'click', x: integer(v.x, 0, f.width - 1), y: integer(v.y, 0, f.height - 1), button: choice(v.button, ['left']) }; break
    }
    case 'key': {
      record(value, ['type', 'keys'])
      result = { type: 'key', keys: choice(v.keys, COMPUTER_USE_KEYS) }; break
    }
    case 'type': {
      record(value, ['type', 'text'])
      result = { type: 'type', text: text(v.text, COMPUTER_USE_LIMITS.maxTextBytes) }; break
    }
    case 'scroll': {
      record(value, ['type', 'x', 'y', 'deltaX', 'deltaY'])
      result = { type: 'scroll', x: integer(v.x, 0, f.width - 1), y: integer(v.y, 0, f.height - 1), deltaX: integer(v.deltaX, -COMPUTER_USE_LIMITS.maxScrollDelta, COMPUTER_USE_LIMITS.maxScrollDelta), deltaY: integer(v.deltaY, -COMPUTER_USE_LIMITS.maxScrollDelta, COMPUTER_USE_LIMITS.maxScrollDelta) }; break
    }
    default: return invalid()
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > COMPUTER_USE_LIMITS.maxActionBytes) return invalid()
  return result
}
export function validateComputerUseReceipt(value: unknown): ComputerUseReceipt {
  const v = record(value, ['requestId', 'actionId', 'toolCallId', 'frameId', 'scopeRevision', 'status', 'actualPending'])
  const result: ComputerUseReceipt = { requestId: id(v.requestId), actionId: id(v.actionId), toolCallId: id(v.toolCallId), frameId: id(v.frameId), scopeRevision: integer(v.scopeRevision), status: choice(v.status, ['rejected-before-execution', 'executed', 'failed', 'interrupted', 'outcome-unknown']), actualPending: boolean(v.actualPending) }
  if (result.actualPending && (result.status === 'executed' || result.status === 'rejected-before-execution')) return invalid()
  return result
}
export function validateComputerUseBudget(value: unknown): ComputerUseBudget {
  const v = record(value, ['actions', 'captures', 'frameBytes', 'framePixels'])
  return { actions: integer(v.actions, 0, COMPUTER_USE_LIMITS.maxActions), captures: integer(v.captures, 0, COMPUTER_USE_LIMITS.maxCaptures), frameBytes: integer(v.frameBytes, 0, COMPUTER_USE_LIMITS.maxTotalFrameBytes), framePixels: integer(v.framePixels, 0, COMPUTER_USE_LIMITS.maxTotalFramePixels) }
}
export function validateComputerUseStatus(value: unknown): ComputerUseStatus {
  const v = record(value, ['state', 'revision', 'scopeRevision', 'actualPending', 'budget'], ['owner', 'consent', 'capability', 'frame', 'receipt'])
  const result: ComputerUseStatus = { state: choice(v.state, ['disabled', 'preparing', 'awaiting-consent', 'observing', 'ready', 'acting', 'stopping', 'stopped', 'paused', 'quarantined']), revision: integer(v.revision), scopeRevision: integer(v.scopeRevision), actualPending: boolean(v.actualPending), budget: validateComputerUseBudget(v.budget) }
  if (Object.hasOwn(v, 'owner')) result.owner = validateComputerUseOwner(v.owner)
  if (Object.hasOwn(v, 'consent')) result.consent = validateComputerUseConsent(v.consent)
  if (Object.hasOwn(v, 'capability')) result.capability = validateComputerUseCapability(v.capability)
  if (Object.hasOwn(v, 'frame')) result.frame = validateComputerUseFrame(v.frame)
  if (Object.hasOwn(v, 'receipt')) result.receipt = validateComputerUseReceipt(v.receipt)
  if ((result.actualPending && ['disabled', 'ready', 'stopped'].includes(result.state)) || (result.receipt?.actualPending && !result.actualPending) || (result.frame && result.frame.scopeRevision !== result.scopeRevision) || (result.receipt && result.receipt.scopeRevision !== result.scopeRevision)) return invalid()
  return result
}
export interface ComputerUseActRequest { frameId: string; action: ComputerUseAction }
export function validateComputerUseActRequest(value: unknown, frame: ComputerUseFrame): ComputerUseActRequest {
  const v = record(value, ['frameId', 'action'])
  const f = validateComputerUseFrame(frame)
  const frameId = id(v.frameId)
  if (frameId !== f.id) return invalid()
  return { frameId, action: validateComputerUseAction(v.action, f) }
}
/** Caller must atomically reserve before dispatch; failed/expired captures still count.
 * No rollback, deadline, lifecycle, authorization or OS mapping is implemented here.
 */
export function reserveComputerUseCapture(value: ComputerUseBudget, frameBytes: number, framePixels: number): ComputerUseBudget {
  const budget = validateComputerUseBudget(value)
  const bytes = integer(frameBytes, 1, COMPUTER_USE_LIMITS.maxFrameBytes)
  const pixels = integer(framePixels, 1, COMPUTER_USE_LIMITS.maxFramePixels)
  return validateComputerUseBudget({ ...budget, captures: budget.captures + 1, frameBytes: budget.frameBytes + bytes, framePixels: budget.framePixels + pixels })
}
export function reserveComputerUseAction(value: ComputerUseBudget): ComputerUseBudget {
  const budget = validateComputerUseBudget(value)
  return validateComputerUseBudget({ ...budget, actions: budget.actions + 1 })
}
export function normalizeComputerUseFrame(value: unknown): ComputerUseFrame | undefined {
  try { return validateComputerUseFrame(value) } catch { return undefined }
}
/** Fail closed; never salvage an untrusted raw diagnostic/base64 payload. */
export function normalizeComputerUseStatus(value: unknown): ComputerUseStatus | undefined {
  try { return validateComputerUseStatus(value) } catch { return undefined }
}
export function createDisabledComputerUseStatus(): ComputerUseStatus {
  return { state: 'disabled', revision: 0, scopeRevision: 0, actualPending: false, budget: { actions: 0, captures: 0, frameBytes: 0, framePixels: 0 }, consent: { ...DEFAULT_COMPUTER_USE_CONSENT }, capability: { ...DEFAULT_COMPUTER_USE_CAPABILITY } }
}

/** Model-only transport. Never embed in status, UI projection, or a receipt.
 * Byte/dimension admission is NOT PNG/JPEG decoding or content validation.
 * Broker must validate encoded dimensions/content, consent and exact SDK image support.
 */
export interface ComputerUseModelImage {
  frameId: string
  mimeType: 'image/png' | 'image/jpeg'
  bytes: Uint8Array
}
export function validateComputerUseModelImage(value: unknown, frame: ComputerUseFrame): ComputerUseModelImage {
  const f = validateComputerUseFrame(frame)
  const v = record(value, ['frameId', 'mimeType', 'bytes'])
  const frameId = id(v.frameId)
  if (frameId !== f.id || !(v.bytes instanceof Uint8Array) || !v.bytes.byteLength || v.bytes.byteLength > COMPUTER_USE_LIMITS.maxFrameBytes) return invalid()
  return { frameId, mimeType: choice(v.mimeType, ['image/png', 'image/jpeg']), bytes: new Uint8Array(v.bytes) }
}
