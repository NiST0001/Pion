// SPDX-License-Identifier: MIT
// Private SDK/main transport. Correlation fields are NOT peer authentication.
import { validateComputerUseAction, type ComputerUseAction } from './computer-use'

export const COMPUTER_USE_AGENT_TITLE_PREFIX = '__pion_computer_use_v1__:'
export const COMPUTER_USE_OBSERVE_TOOL = 'pion_computer_observe'
export const COMPUTER_USE_ACT_TOOL = 'pion_computer_act'
/** Added only by the real SDK factory's event adapter after checking its actual
 * tool definition/execute incarnation. Never infer it from a tool name or input.
 * Pinned SDK tool_execution_start has no sourceInfo; absent proof fails closed. */
export const COMPUTER_USE_AGENT_SOURCE_FIELD = '__pionComputerUseSource'
export const COMPUTER_USE_AGENT_LIMITS = Object.freeze({ maxRequestBytes: 12 * 1024, maxImageBytes: 8 * 1024 * 1024, maxModelEdge: 2000, maxModelBase64: 4.5 * 1024 * 1024, maxModelImageBytes: (4.5 * 1024 * 1024 / 4 - 1) * 3, maxRequests: 512, watchMs: 20_000 })
export const COMPUTER_USE_AGENT_ERRORS = Object.freeze([
  'invalid-request', 'unavailable', 'source-unverified', 'scope-revoked',
  'permission-denied', 'model-unavailable', 'capture-failed', 'input-unavailable',
  'target-unverified', 'busy', 'frame-stale', 'egress-revoked', 'protocol-error'
] as const)
export type ComputerUseAgentError = typeof COMPUTER_USE_AGENT_ERRORS[number]
export type ComputerUseAgentOperation = 'observe' | 'act' | 'retained' | 'egress' | 'watch' | 'unwatch'
/** Factory-scanned actual SDK entry, not an upload grant or restored marker. */
export interface ComputerUseAgentRetainedEntry {
  observationRequestId: string
  entryId: string
  sessionFile: string
  sessionId: string
  frameId: string
  scopeRevision: number
  width: number
  height: number
  imageHash: string
  imageBytes: number
}
export interface ComputerUseAgentRequest {
  version: 1
  operation: ComputerUseAgentOperation
  runtimeNonce: string
  runtimeId: string
  requestId: string
  toolCallId?: string
  provider: string
  modelId: string
  frameId?: string
  action?: ComputerUseAction
  /** Correlation only: Main additionally checks the captured actual source. */
  watchRequestId?: string
  retained?: ComputerUseAgentRetainedEntry
}
export interface ComputerUseAgentResponse {
  version: 1
  ok: boolean
  operation: ComputerUseAgentOperation
  requestId: string
  scopeRevision?: number
  frameId?: string
  width?: number
  height?: number
  image?: { mimeType: 'image/png'; data: string }
  error?: ComputerUseAgentError
}
export interface ComputerUseAgentSource {
  version: 1
  runtimeId: string
  runtimeNonce: string
  toolCallId?: string
}

function invalid(): never { throw new Error('Invalid ComputerUse Agent protocol') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length > required.length + optional.length || required.some(key => !Object.hasOwn(value, key))) return invalid()
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)) || !d?.enumerable || !('value' in d)) return invalid()
  }
  return value as Record<string, unknown>
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) return invalid()
  return value
}
/** Pinned OpenAI Responses SDK composes actual tool IDs as call_id|item_id;
 * item IDs may also contain + / =. These are bounded opaque IDs, not tokens or
 * authentication, and must be preserved exactly when matching real receipts. */
function toolId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value)) return invalid()
  return value
}
function target(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x20\x7f]/.test(value) || new TextEncoder().encode(value).byteLength > 256) return invalid()
  return value
}
function operation(value: unknown): ComputerUseAgentOperation {
  return value === 'observe' || value === 'act' || value === 'retained' || value === 'egress' || value === 'watch' || value === 'unwatch' ? value : invalid()
}
function integer(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid()
}
export function isComputerUseAgentTitle(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(COMPUTER_USE_AGENT_TITLE_PREFIX)
}
export function parseComputerUseAgentRequest(value: unknown): ComputerUseAgentRequest {
  const v = object(value, ['version', 'operation', 'runtimeNonce', 'runtimeId', 'requestId', 'provider', 'modelId'], ['toolCallId', 'frameId', 'action', 'watchRequestId', 'retained'])
  if (v.version !== 1) return invalid()
  const result: ComputerUseAgentRequest = { version: 1, operation: operation(v.operation), runtimeNonce: token(v.runtimeNonce), runtimeId: token(v.runtimeId), requestId: token(v.requestId), provider: target(v.provider), modelId: target(v.modelId) }
  if (Object.hasOwn(v, 'toolCallId')) result.toolCallId = toolId(v.toolCallId)
  if (result.operation === 'observe' || result.operation === 'act' || result.operation === 'retained') {
    if (!result.toolCallId) return invalid()
  } else if (result.toolCallId !== undefined) return invalid()
  if (result.operation === 'retained') {
    const r = object(v.retained, ['observationRequestId', 'entryId', 'sessionFile', 'sessionId', 'frameId', 'scopeRevision', 'width', 'height', 'imageHash', 'imageBytes'])
    if (typeof r.sessionFile !== 'string' || !r.sessionFile || r.sessionFile.length > 4096 || /[\x00-\x1f\x7f]/.test(r.sessionFile)
      || typeof r.imageHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.imageHash)) return invalid()
    result.retained = { observationRequestId: token(r.observationRequestId), entryId: token(r.entryId), sessionFile: r.sessionFile, sessionId: token(r.sessionId),
      frameId: token(r.frameId), scopeRevision: integer(r.scopeRevision, 0, Number.MAX_SAFE_INTEGER),
      width: integer(r.width, 1, COMPUTER_USE_AGENT_LIMITS.maxModelEdge), height: integer(r.height, 1, COMPUTER_USE_AGENT_LIMITS.maxModelEdge),
      imageHash: r.imageHash, imageBytes: integer(r.imageBytes, 1, COMPUTER_USE_AGENT_LIMITS.maxModelImageBytes) }
  } else if (Object.hasOwn(v, 'retained')) return invalid()
  if (result.operation === 'act') {
    result.frameId = token(v.frameId)
    // Real projection bounds and native-frame lookup remain main-private.
    result.action = validateComputerUseAction(v.action, { id: result.frameId, width: COMPUTER_USE_AGENT_LIMITS.maxModelEdge, height: COMPUTER_USE_AGENT_LIMITS.maxModelEdge, createdAt: 0, scopeRevision: 0, captureScope: 'display', actualScope: 'display' })
  } else if (Object.hasOwn(v, 'frameId') || Object.hasOwn(v, 'action')) return invalid()
  if (result.operation === 'unwatch') result.watchRequestId = token(v.watchRequestId)
  else if (Object.hasOwn(v, 'watchRequestId')) return invalid()
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > COMPUTER_USE_AGENT_LIMITS.maxRequestBytes) return invalid()
  return result
}
export function parseComputerUseAgentTitle(title: string): ComputerUseAgentRequest {
  if (!isComputerUseAgentTitle(title) || new TextEncoder().encode(title).byteLength > COMPUTER_USE_AGENT_LIMITS.maxRequestBytes) return invalid()
  return parseComputerUseAgentRequest(JSON.parse(title.slice(COMPUTER_USE_AGENT_TITLE_PREFIX.length)))
}
export function parseComputerUseAgentSource(value: unknown): ComputerUseAgentSource {
  const v = object(value, ['version', 'runtimeId', 'runtimeNonce'], ['toolCallId'])
  if (v.version !== 1) return invalid()
  return { version: 1, runtimeId: token(v.runtimeId), runtimeNonce: token(v.runtimeNonce), ...(Object.hasOwn(v, 'toolCallId') ? { toolCallId: toolId(v.toolCallId) } : {}) }
}
export function validateComputerUseAgentResponse(value: unknown): ComputerUseAgentResponse {
  const v = object(value, ['version', 'ok', 'operation', 'requestId'], ['scopeRevision', 'frameId', 'width', 'height', 'image', 'error'])
  if (v.version !== 1 || typeof v.ok !== 'boolean') return invalid()
  const result: ComputerUseAgentResponse = { version: 1, ok: v.ok, operation: operation(v.operation), requestId: token(v.requestId) }
  if (Object.hasOwn(v, 'scopeRevision')) result.scopeRevision = integer(v.scopeRevision, 0, Number.MAX_SAFE_INTEGER)
  if (Object.hasOwn(v, 'frameId')) result.frameId = token(v.frameId)
  if (Object.hasOwn(v, 'width')) result.width = integer(v.width, 1, COMPUTER_USE_AGENT_LIMITS.maxModelEdge)
  if (Object.hasOwn(v, 'height')) result.height = integer(v.height, 1, COMPUTER_USE_AGENT_LIMITS.maxModelEdge)
  if (Object.hasOwn(v, 'error')) {
    if (typeof v.error !== 'string' || !COMPUTER_USE_AGENT_ERRORS.includes(v.error as ComputerUseAgentError)) return invalid()
    result.error = v.error as ComputerUseAgentError
  }
  if (Object.hasOwn(v, 'image')) {
    const image = object(v.image, ['mimeType', 'data'])
    if (image.mimeType !== 'image/png' || typeof image.data !== 'string' || !image.data.length
      || image.data.length >= COMPUTER_USE_AGENT_LIMITS.maxModelBase64
      || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return invalid()
    result.image = { mimeType: 'image/png', data: image.data }
  }
  if ((!result.ok && (!result.error || result.image || result.frameId || result.width || result.height))
    || (result.ok && result.error) || (result.image && (result.operation !== 'observe' || !result.frameId || !result.width || !result.height || result.scopeRevision === undefined))
    || (result.ok && result.operation === 'observe' && !result.image)) return invalid()
  return result
}

/** Specific ComputerUse projections only. No full screenshot, unknown details,
 * raw diagnostics or source nonce can enter generic live/wire UI state. */
export function stripComputerUseAgentImages<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  const event = value as Record<string, unknown>
  const isTool = (name: unknown): boolean => name === COMPUTER_USE_OBSERVE_TOOL || name === COMPUTER_USE_ACT_TOOL
  const safeResult = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') return raw
    const r = raw as Record<string, unknown>
    return { ...(typeof r.role === 'string' ? { role: r.role } : {}), ...(typeof r.toolCallId === 'string' ? { toolCallId: r.toolCallId } : {}), ...(typeof r.toolName === 'string' ? { toolName: r.toolName } : {}), ...(typeof r.timestamp === 'number' ? { timestamp: r.timestamp } : {}), ...(typeof r.isError === 'boolean' ? { isError: r.isError } : {}), content: [{ type: 'text', text: 'ComputerUse screenshot is private to the approved model session; image omitted from UI.' }] }
  }
  let result = event
  if (isTool(event.toolName)) {
    result = { ...result }
    if (Object.hasOwn(event, 'result')) result.result = safeResult(event.result)
    if (Object.hasOwn(event, 'partialResult')) result.partialResult = safeResult(event.partialResult)
    if (event.role === 'toolResult') result = safeResult(result) as Record<string, unknown>
  }
  const message = event.message as Record<string, unknown> | undefined
  if (message?.role === 'toolResult' && isTool(message.toolName)) result = { ...result, message: safeResult(message) }
  const entry = event.entry as Record<string, unknown> | undefined
  if (entry?.message && typeof entry.message === 'object') {
    const m = entry.message as Record<string, unknown>
    if (m.role === 'toolResult' && isTool(m.toolName)) result = { ...result, entry: { ...entry, message: safeResult(m) } }
  }
  // SDK agent_end and turn_end may repeat finalized tool messages wholesale.
  // Do not let their aggregate shape bypass the per-tool projection above.
  for (const key of ['messages', 'toolResults'] as const) {
    if (Array.isArray(event[key])) result = { ...result, [key]: event[key].map(item => stripComputerUseAgentImages(item)) }
  }
  if (Object.hasOwn(result, COMPUTER_USE_AGENT_SOURCE_FIELD)) {
    result = { ...result }
    delete result[COMPUTER_USE_AGENT_SOURCE_FIELD]
  }
  return result as T
}
