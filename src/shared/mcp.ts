/** Read-only MCP observations, separate from tool registration and chat history. */
export const MCP_STATUS_WIDGET_KEY = '__pion_mcp_status_v1'
export const MCP_STATUS_PROTOCOL_VERSION = 1
export const MCP_STATUS_SDK_VERSION = '1.0.4'
export const MCP_STATUS_INTERVAL_MS = 3_000
export const MCP_STATUS_QUERY_DEADLINE_MS = 2_000
export const MCP_STATUS_STALE_MS = 12_000
export const MCP_STATUS_MAX_BYTES = 64 * 1024
export const MCP_STATUS_MAX_SERVERS = 128

export type McpServerState = 'connecting' | 'connected' | 'disconnected' | 'needs-auth' | 'failed' | 'closed' | 'starting' | 'disabled'
export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden'
export type McpAvailability = 'native' | 'replaced' | 'inactive' | 'unavailable'
export type McpObservationPhase = 'ready' | 'waiting' | 'unavailable'
export type McpStatusReason = 'initializing' | 'query-busy' | 'query-timeout' | 'query-failed' | 'unsupported-format' | 'unsupported-sdk'
  | 'no-command-context' | 'no-backend' | 'backend-stopped' | 'scope-mismatch' | 'waiting-status' | 'stale-status' | 'invalid-notice'

export interface McpServerStatus {
  name: string
  state: McpServerState
  exposure: McpExposure
  /** Server-reported registered tools, NOT tools visible/permitted in this mode. */
  toolCount?: number
}
export interface McpObservedStatus {
  availability: McpAvailability
  phase: McpObservationPhase
  reason?: McpStatusReason
  servers: McpServerStatus[]
  diagnosticsOmitted: boolean
}
export interface McpStatusTarget {
  cwd?: string
  sessionPath?: string
  backendId?: string
}
export interface McpStatusNotice extends McpObservedStatus {
  version: typeof MCP_STATUS_PROTOCOL_VERSION
  runtimeId: string
  revision: number
  cwd: string
  sessionPath?: string
}
export interface McpStatusSnapshot extends McpObservedStatus {
  cwd?: string
  sessionPath?: string
  backendId?: string
  runtimeId?: string
  /** Main-owned, monotonic within the BackendRecord, even after SDK reload. */
  revision: number
  /** Receipt time, not a connection probe or a server-side clock. */
  receivedAt: number
}

const STATES: readonly string[] = ['connecting', 'connected', 'disconnected', 'needs-auth', 'failed', 'closed', 'starting', 'disabled']
const EXPOSURES: readonly string[] = ['codemode', 'deferred', 'direct', 'hidden']
const REASONS: readonly string[] = ['initializing', 'query-busy', 'query-timeout', 'query-failed', 'unsupported-format', 'unsupported-sdk',
  'no-command-context', 'no-backend', 'backend-stopped', 'scope-mismatch', 'waiting-status', 'stale-status', 'invalid-notice']
const namePattern = /^[A-Za-z0-9_-]{1,128}$/
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const mcpScopeString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value)

export function unavailableMcpStatus(reason: McpStatusReason, availability: McpAvailability = 'unavailable'): McpObservedStatus {
  return { availability, phase: 'unavailable', reason, servers: [], diagnosticsOmitted: false }
}

/** Copy only bounded public fields; never preserve raw errors, config or sources. */
export function projectMcpObservedStatus(value: unknown): McpObservedStatus | undefined {
  if (!record(value) || typeof value.availability !== 'string' || !['native', 'replaced', 'inactive', 'unavailable'].includes(value.availability)
    || typeof value.phase !== 'string' || !['ready', 'waiting', 'unavailable'].includes(value.phase)
    || (value.reason !== undefined && (typeof value.reason !== 'string' || !REASONS.includes(value.reason)))
    || typeof value.diagnosticsOmitted !== 'boolean' || !Array.isArray(value.servers) || value.servers.length > MCP_STATUS_MAX_SERVERS) return undefined
  if ((value.availability !== 'native' || value.phase !== 'ready') && value.servers.length !== 0) return undefined
  if (value.availability === 'unavailable' && value.phase === 'ready') return undefined
  const names = new Set<string>()
  const servers: McpServerStatus[] = []
  for (const source of value.servers) {
    if (!record(source) || typeof source.name !== 'string' || !namePattern.test(source.name)
      || typeof source.state !== 'string' || !STATES.includes(source.state)
      || typeof source.exposure !== 'string' || !EXPOSURES.includes(source.exposure)) return undefined
    const namespace = source.name.replace(/-/g, '_')
    if (names.has(namespace)) return undefined
    names.add(namespace)
    if (source.state === 'connected' ? !counter(source.toolCount) || source.toolCount > 1_000_000 : source.toolCount !== undefined) return undefined
    servers.push({ name: source.name, state: source.state as McpServerState, exposure: source.exposure as McpExposure,
      ...(source.state === 'connected' ? { toolCount: source.toolCount as number } : {}) })
  }
  return { availability: value.availability as McpAvailability, phase: value.phase as McpObservationPhase,
    ...(value.reason ? { reason: value.reason as McpStatusReason } : {}), servers, diagnosticsOmitted: value.diagnosticsOmitted }
}
/** SDK 1.0.4 format only. Bounds apply to our projection, NOT SDK string construction. */
export function parseNativeMcpStatus(text: unknown): McpObservedStatus {
  const bad = () => unavailableMcpStatus('unsupported-format', 'native')
  if (typeof text !== 'string' || text.length === 0 || text.length > MCP_STATUS_MAX_BYTES
    || new TextEncoder().encode(text).length > MCP_STATUS_MAX_BYTES) return bad()
  const lines = text.split('\n')
  if (lines.length > 512 || lines.some((line) => line.length > 4096 || /\r/.test(line))) return bad()
  if (lines.length === 1 && /^No MCP servers configured\. Add them to .+[\\/]mcp\.json or \.pi\/mcp\.json\.$/.test(text)) {
    return { availability: 'native', phase: 'ready', servers: [], diagnosticsOmitted: false }
  }
  const servers: McpServerStatus[] = []
  const names = new Set<string>()
  let diagnosticsOmitted = false
  let errorAllowed = false
  for (const line of lines) {
    // The SDK does not escape multiline diagnostics. Never scan the opaque
    // diagnostic tail for apparent server rows, nor trim error continuations.
    if (line.startsWith('config error: ') || line.startsWith('overridden: ')) { diagnosticsOmitted = true; break }
    if (line.startsWith('    ')) {
      if (!errorAllowed) return bad()
      diagnosticsOmitted = true
      continue
    }
    const match = /^([A-Za-z0-9_-]{1,128}): (connecting|connected, ([0-9]{1,7}) tools|disconnected, reconnects on next call|needs sign-in, run \/mcp login ([A-Za-z0-9_-]{1,128})|failed|closed|starting|disabled) \((codemode|deferred|direct|hidden)\)$/.exec(line)
    if (!match || servers.length >= MCP_STATUS_MAX_SERVERS) return bad()
    const [, name, formatted, count, loginName, exposure] = match
    const namespace = name.replace(/-/g, '_')
    if (names.has(namespace) || (loginName && loginName !== name)) return bad()
    names.add(namespace)
    const state: McpServerState = formatted.startsWith('connected, ') ? 'connected'
      : formatted.startsWith('disconnected, ') ? 'disconnected'
        : loginName ? 'needs-auth' : formatted as McpServerState
    const toolCount = count === undefined ? undefined : Number(count)
    if (toolCount !== undefined && (!counter(toolCount) || toolCount > 1_000_000 || String(toolCount) !== count)) return bad()
    servers.push({ name, state, exposure: exposure as McpExposure, ...(toolCount !== undefined ? { toolCount } : {}) })
    errorAllowed = state !== 'connected' && state !== 'needs-auth'
  }
  return { availability: 'native', phase: 'ready', servers, diagnosticsOmitted }
}

/** Private RPC widget, versioned and bounded before JSON parsing. No raw fallback. */
export function readMcpStatusNotice(lines: unknown): McpStatusNotice | undefined {
  if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string' || /[\r\n]/.test(lines[0])
    || lines[0].length > MCP_STATUS_MAX_BYTES || new TextEncoder().encode(lines[0]).length > MCP_STATUS_MAX_BYTES) return undefined
  try {
    const value: unknown = JSON.parse(lines[0])
    if (!record(value) || value.version !== MCP_STATUS_PROTOCOL_VERSION || !mcpScopeString(value.runtimeId)
      || value.runtimeId.length > 128 || !counter(value.revision) || value.revision === 0 || !mcpScopeString(value.cwd)
      || (value.sessionPath !== undefined && !mcpScopeString(value.sessionPath))) return undefined
    const status = projectMcpObservedStatus(value)
    return status ? { ...status, version: MCP_STATUS_PROTOCOL_VERSION, runtimeId: value.runtimeId,
      revision: value.revision, cwd: value.cwd, ...(value.sessionPath !== undefined ? { sessionPath: value.sessionPath } : {}) } : undefined
  } catch { return undefined }
}

export function projectMcpStatusSnapshot(value: unknown): McpStatusSnapshot | undefined {
  if (!record(value) || !counter(value.revision) || !counter(value.receivedAt)
    || (value.cwd !== undefined && !mcpScopeString(value.cwd)) || (value.sessionPath !== undefined && !mcpScopeString(value.sessionPath))
    || (value.backendId !== undefined && (!mcpScopeString(value.backendId) || value.backendId.length > 128))
    || (value.runtimeId !== undefined && (!mcpScopeString(value.runtimeId) || value.runtimeId.length > 128))) return undefined
  const status = projectMcpObservedStatus(value)
  return status ? { ...status, revision: value.revision, receivedAt: value.receivedAt,
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}), ...(value.sessionPath !== undefined ? { sessionPath: value.sessionPath } : {}),
    ...(value.backendId !== undefined ? { backendId: value.backendId } : {}), ...(value.runtimeId !== undefined ? { runtimeId: value.runtimeId } : {}) } : undefined
}
