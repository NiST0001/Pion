import {
  MCP_STATUS_STALE_MS,
  MCP_STATUS_WIDGET_KEY,
  mcpScopeString,
  projectMcpStatusSnapshot,
  readMcpStatusNotice,
  unavailableMcpStatus
} from '../../shared/mcp'
import type { McpStatusReason, McpStatusSnapshot, McpStatusTarget } from '../../shared/mcp'
import type { BackendRecord } from './types'

const MAX_RETIRED_RUNTIME_IDS = 8

interface McpStatusWidget {
  type: 'extension_ui_request'
  widgetKey: typeof MCP_STATUS_WIDGET_KEY
  method?: unknown
  widgetLines?: unknown
  parentToolCallId?: unknown
}

/** Match the private key even for a malformed method/payload; no raw fallback. */
export function isMcpStatusWidget(event: unknown): event is McpStatusWidget {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false
  const value = event as Record<string, unknown>
  return value.type === 'extension_ui_request' && value.widgetKey === MCP_STATUS_WIDGET_KEY
}

/** A target is a selection fence, never a way to look up another pooled backend. */
export function projectMcpStatusTarget(value: unknown): McpStatusTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if ((source.cwd !== undefined && !mcpScopeString(source.cwd))
    || (source.sessionPath !== undefined && !mcpScopeString(source.sessionPath))
    || (source.backendId !== undefined && (!mcpScopeString(source.backendId) || source.backendId.length > 128))) return undefined
  return {
    ...(source.cwd !== undefined ? { cwd: source.cwd as string } : {}),
    ...(source.sessionPath !== undefined ? { sessionPath: source.sessionPath as string } : {}),
    ...(source.backendId !== undefined ? { backendId: source.backendId as string } : {})
  }
}

export function mcpBackendScope(backend: BackendRecord): McpStatusTarget {
  return { cwd: backend.cwd, ...(backend.sessionPath !== undefined ? { sessionPath: backend.sessionPath } : {}),
    ...(backend.liveState ? { backendId: backend.liveState.backendId } : {}) }
}

export function unknownMcpStatus(reason: McpStatusReason, scope: McpStatusTarget = {},
  revision = 0, receivedAt = 0): McpStatusSnapshot {
  return { ...unavailableMcpStatus(reason), ...scope, revision, receivedAt }
}

export function waitingMcpStatus(scope: McpStatusTarget, revision = 0, receivedAt = 0): McpStatusSnapshot {
  return { ...unknownMcpStatus('waiting-status', scope, revision, receivedAt), phase: 'waiting' }
}

/** Called only after the listener's backend/pool/captured-client ownership check. */
export function cacheMcpStatusWidget(backend: BackendRecord, event: McpStatusWidget, now = Date.now()): boolean {
  const previous = backend.mcpStatus
  const notice = event.method === 'setWidget'
    && (event.parentToolCallId === undefined || event.parentToolCallId === '')
    ? readMcpStatusNotice(event.widgetLines) : undefined
  // SDK replacement can change its session path before the bridge's get_state
  // publication. Ignore this notice; its next periodic notice can match later.
  if (notice && (notice.cwd !== backend.cwd || notice.sessionPath !== backend.sessionPath)) return false
  if (notice && (previous?.retiredRuntimeIds.includes(notice.runtimeId)
    || (notice.runtimeId === previous?.runtimeId && notice.revision <= (previous?.runtimeRevision ?? 0)))) return false
  const revision = (previous?.snapshot.revision ?? 0) + 1
  if (!Number.isSafeInteger(revision)) return false
  const retiredRuntimeIds = [...(previous?.retiredRuntimeIds ?? [])]
  if (notice && previous?.runtimeId && notice.runtimeId !== previous.runtimeId) {
    retiredRuntimeIds.push(previous.runtimeId)
  }
  const scope = mcpBackendScope(backend)
  const snapshot = notice
    ? projectMcpStatusSnapshot({ ...notice, ...scope, revision, receivedAt: now })!
    : unknownMcpStatus('invalid-notice', scope, revision, now)
  backend.mcpStatus = {
    client: backend.client,
    runtimeId: notice?.runtimeId ?? previous?.runtimeId,
    runtimeRevision: notice?.revision ?? previous?.runtimeRevision,
    retiredRuntimeIds: retiredRuntimeIds.slice(-MAX_RETIRED_RUNTIME_IDS),
    observedAt: performance.now(),
    snapshot
  }
  return true
}

/** Read and copy only observations from this exact backend/transport/scope. */
export function readCachedMcpStatus(backend: BackendRecord, elapsedNow = performance.now()): McpStatusSnapshot {
  const cache = backend.mcpStatus
  const scope = mcpBackendScope(backend)
  if (!cache || cache.client !== backend.client || cache.snapshot.cwd !== scope.cwd
    || cache.snapshot.sessionPath !== scope.sessionPath || cache.snapshot.backendId !== scope.backendId) {
    return waitingMcpStatus(scope, cache?.snapshot.revision, cache?.snapshot.receivedAt)
  }
  const age = elapsedNow - cache.observedAt
  if (cache.expired || !Number.isFinite(age) || age < 0 || age > MCP_STATUS_STALE_MS) {
    // Only a genuinely newer private notice replaces this latch.
    cache.expired = true
    return unknownMcpStatus('stale-status', scope, cache.snapshot.revision, cache.snapshot.receivedAt)
  }
  // The shared projection allocates server rows and strips any unknown fields.
  return projectMcpStatusSnapshot(cache.snapshot)
    ?? unknownMcpStatus('invalid-notice', scope, cache.snapshot.revision, cache.snapshot.receivedAt)
}
