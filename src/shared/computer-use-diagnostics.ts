/** Fixed failure boundaries only: no native error strings, titles, URIs,
 * paths, identities or frame bytes. A code is not a resource-stop receipt. */
export const NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES = Object.freeze([
  'portal-connect-failed', 'window-selection-failed', 'selection-not-deliverable',
  'pipewire-start-failed', 'post-start-not-deliverable', 'capture-frame-failed',
  'pipewire-stop-failed', 'portal-close-failed', 'both-stop-failed',
  'request-state-invalid', 'display-selection-failed', 'input-open-failed',
  'input-action-failed', 'input-stop-failed'
] as const)
export type NativeComputerUseDiagnosticCode = typeof NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES[number]
export const COMPUTER_USE_DIAGNOSTIC_CODES = Object.freeze([
  ...NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES,
  'helper-protocol-invalid', 'helper-exit-unverified',
  'helper-transport-error', 'helper-preview-invalid'
] as const)
export type ComputerUseDiagnosticCode = typeof COMPUTER_USE_DIAGNOSTIC_CODES[number]
export type ComputerUseDiagnosticOperation = 'open' | 'capture' | 'act' | 'close'
/** First failure per operation, at most four fixed slots per lease. */
export type ComputerUseDiagnostics = Partial<Record<ComputerUseDiagnosticOperation, ComputerUseDiagnosticCode>>
/** Mirrors native run_requests: close precedes state dispatch; act has its own failure code. */
export const NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST = Object.freeze({
  hello: Object.freeze(['request-state-invalid'] as const),
  open: Object.freeze(['portal-connect-failed', 'window-selection-failed', 'selection-not-deliverable',
    'pipewire-start-failed', 'post-start-not-deliverable', 'request-state-invalid', 'display-selection-failed', 'input-open-failed'] as const),
  capture: Object.freeze(['capture-frame-failed', 'selection-not-deliverable', 'request-state-invalid'] as const),
  act: Object.freeze(['input-action-failed'] as const),
  close: Object.freeze(['pipewire-stop-failed', 'portal-close-failed', 'both-stop-failed', 'input-stop-failed'] as const)
})
export function copyComputerUseDiagnostics(value: unknown): ComputerUseDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > 4) return undefined
  const result: ComputerUseDiagnostics = {}
  for (const [key, code] of entries) {
    if (key !== 'open' && key !== 'capture' && key !== 'act' && key !== 'close') return undefined
    if (typeof code !== 'string' || !(COMPUTER_USE_DIAGNOSTIC_CODES as readonly string[]).includes(code)) return undefined
    result[key] = code as ComputerUseDiagnosticCode
  }
  return result
}
