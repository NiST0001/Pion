import type { RpcClient } from '@earendil-works/pi-coding-agent'
import type {
  AgentMode,
  ExtensionUiRequest,
  ImageContent,
  ExtensionUiResponse,
  RunCheckpointStatus,
  ToolPermissionRequest,
  TreeNodeLite
} from '../../shared/types'
import type { GitRunCheckpoint } from '../checkpoints'
import type { RunOperation } from '../../shared/operations'
import type { LiveSessionProjection } from './live-session-state'
import type { McpStatusSnapshot } from '../../shared/mcp'

export interface PushedTree {
  tree: TreeNodeLite[]
  leafId: string | null
}

export type BackendPhase = 'starting' | 'running' | 'error'

export interface PendingToolPermission {
  request: ToolPermissionRequest
  backendKey: string
  extensionRequestId: string
  timeout: ReturnType<typeof setTimeout>
}

export interface PendingExtensionUi {
  request: ExtensionUiRequest
  backendKey: string
  extensionRequestId: string
  timeout: ReturnType<typeof setTimeout>
}

export interface PendingProviderAuthUi {
  request: ExtensionUiRequest
  operationId: string
  resolve(response: ExtensionUiResponse): void
  timeout: ReturnType<typeof setTimeout>
  removeAbortListener(): void
}

export interface ProviderAuthOperation {
  id: string
  controller: AbortController
}

export interface QueuedBackendMessage {
  runId: string
  text: string
  images: ImageContent[]
}

export interface BackendMcpStatusCache {
  /** A replaced transport must not expose its predecessor's cached rows. */
  client: RpcClient
  runtimeId?: string
  runtimeRevision?: number
  /** Bounded SDK owner replacement fence, independent of the main revision. */
  retiredRuntimeIds: string[]
  /** Private monotonic receipt time; wall-clock changes cannot renew cache TTL. */
  observedAt: number
  expired?: boolean
  snapshot: McpStatusSnapshot
}

export interface BackendRecord {
  /** Bounded current-root-turn projection, isolated to this backend instance. */
  liveState?: LiveSessionProjection
  /** Private observations only; never part of the chat/live projection or billing. */
  mcpStatus?: BackendMcpStatusCache
  key: string
  cwd: string
  sessionPath?: string
  /** Set only after the persisted session appears in its project's sidebar list. */
  sidebarPublishedSessionPath?: string
  client: RpcClient
  phase: BackendPhase
  busy: boolean
  compacting: boolean
  /** Reserved until the old writer has exited and the conversation branch is persisted. */
  historyMutation?: boolean
  /** Never reuse/evict a writer whose actual process exit could not be confirmed. */
  historyStopFailed?: boolean
  modePrimed?: AgentMode
  subagentsEnabled?: boolean
  subagentsModePending?: boolean
  completionState?: 'completed' | 'aborted' | 'failed'
  /** A low-level agent_end asked Pi to continue via retry/compaction. */
  awaitingRetry?: boolean
  checkpoint?: GitRunCheckpoint
  checkpointStatus?: RunCheckpointStatus
  checkpointRunId?: string
  checkpointRefreshPromise?: Promise<RunCheckpointStatus | null>
  /** Serializes lazy checkpoint creation gated by the first write-capable tool. */
  checkpointCreatePromise?: Promise<void>
  /** Persisted queued runs are restored into localFollowUps only once. */
  queueRestored?: boolean
  /** Completion listeners (for example auto-verification) finish before local queue dispatch. */
  runCompletionPromise?: Promise<void>
  /** Distinguishes late usage from a replaced backend of the same session. */
  usageBackendId?: string
  /** Backend-private start proofs; bounded, never evicted/reused or sent through IPC. */
  nativeToolReceipts?: Map<string, {
    runId: string
    backendId: string
    parentId?: string
    rootId: string
    name: string
    state: 'running' | 'ended'
    usageConsumed: boolean
  }>
  activeRunId?: string
  pendingRunIds: string[]
  /** Pion-owned follow-ups remain removable until explicitly dispatched. */
  localFollowUps?: QueuedBackendMessage[]
  /** Enter/priority steering is delivered immediately and hidden from the queue card. */
  directSteering?: string[]
  /** Follow-ups promoted to steering are completed with the active run. */
  companionRunIds?: string[]
  /** Last raw queue snapshot emitted by the Pi subprocess. */
  rawQueue?: { steering: string[]; followUp: string[] }
  localQueueDispatchPromise?: Promise<void>
  /** A local follow-up has been removed from the queue and is awaiting settle. */
  localQueueDispatching?: boolean
  /** A failed/aborted turn blocks automatic replay until the user explicitly promotes one item. */
  localQueueBlocked?: boolean
  startPromise: Promise<void>
}

export type SessionCompletedListener = (info: { cwd: string; sessionPath?: string }) => void
export type ToolPermissionRequestedListener = (request: ToolPermissionRequest) => void
export type RunCompletedListener = (run: RunOperation) => void | Promise<void>

