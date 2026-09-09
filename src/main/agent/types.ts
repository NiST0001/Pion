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

export interface BackendRecord {
  key: string
  cwd: string
  sessionPath?: string
  /** Set only after the persisted session appears in its project's sidebar list. */
  sidebarPublishedSessionPath?: string
  client: RpcClient
  phase: BackendPhase
  busy: boolean
  compacting: boolean
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

