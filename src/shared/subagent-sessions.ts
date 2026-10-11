/** Display-only, memory-only child sessions. These IDs are not SDK history IDs. */
export const SUBAGENT_SESSION_WIDGET_KEY = 'pion-private-subagent-session-v1'
/** Private RPC request/ACK for display capacity, never user authorization. */
export const SUBAGENT_SESSION_ADMISSION_TITLE = 'pion-private-subagent-admission-v1'
export interface SubagentSessionAdmission {
  version: 1
  nonce: string
  runtimeId: string
  parentToolCallId: string
  count: number
}
export const SUBAGENT_SESSION_RETENTION_MS = 30 * 60_000
export const SUBAGENT_SESSION_MAX_ROWS = 200
export const SUBAGENT_SESSION_MAX_CHARS = 64 * 1024
export const SUBAGENT_SESSION_MAX_PACKET_CHARS = 128 * 1024
export const SUBAGENT_SESSION_MAX_RECORDS = 256
export type SubagentSessionStatus = 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'aborted'
export interface SubagentSessionRow {
  id: string
  kind: 'assistant' | 'thinking' | 'tool'
  text: string
  toolName?: string
  state?: 'running' | 'completed' | 'failed'
}
export interface SubagentSessionSummary {
  id: string
  backendId: string
  runtimeId: string
  parentToolCallId: string
  cwd: string
  parentSessionId: string
  parentSessionPath?: string
  name: string
  status: SubagentSessionStatus
  revision: number
  truncated: boolean
  /** Computed by main from a monotonic deadline; repeated reads never renew it. */
  retentionRemainingMs?: number
}
export interface SubagentSessionSnapshot extends SubagentSessionSummary {
  rows: SubagentSessionRow[]
}
export interface SubagentSessionList {
  revision: number
  sessions: SubagentSessionSummary[]
}
/** Host-private full bounded display snapshot; never included in parent tool details. */
export interface SubagentSessionNotice {
  version: 1
  nonce: string
  source: 'sdk:pion_subagents'
  runtimeId: string
  id: string
  parentToolCallId: string
  parentSessionId: string
  parentSessionPath?: string
  cwd: string
  name: string
  revision: number
  status: SubagentSessionStatus
  truncated: boolean
  rows: SubagentSessionRow[]
}
