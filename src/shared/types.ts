/**
 * Pion IPC contract shared by main process, preload, and renderer.
 *
 * Deliberately free of pi SDK imports so the renderer bundle stays decoupled
 * from server-side types. The main process adapts pi's `JsonAgentSessionEvent`
 * wire format into the `WireEvent` subset defined here.
 */

import type {
  GitCommitResult,
  GitConflictContent,
  GitDiffScope,
  GitFileDiff,
  GitSelectionRequest,
  GitSnapshotUpdate,
  GitWorkspaceSnapshot,
  RunOperation,
  RunRecoveryCandidate,
  RunTelemetryQuery,
  RunTelemetryUpdate,
  StartVerificationOptions,
  VerificationLogUpdate,
  VerificationPlan,
  VerificationPolicy,
  VerificationRun,
  VerificationSnapshotUpdate
} from './operations'
import type { CreateWorkflowRequest, WorkflowSnapshot, WorkflowUpdate } from './workflows'
export type {
  DurableRunCheckpoint,
  GitCommitResult,
  GitConflictContent,
  GitDiffHunk,
  GitDiffLine,
  GitDiffLineKind,
  GitDiffScope,
  GitFileDiff,
  GitFileKind,
  GitFileStatus,
  GitOperation,
  GitSelectionRequest,
  GitSnapshotUpdate,
  GitWorkspaceSnapshot,
  RunCompactionMetric,
  RunOperation,
  RunOperationState,
  RunPromptImage,
  RunPromptPayload,
  RunRecoveryCandidate,
  RunTelemetryQuery,
  RunTelemetryUpdate,
  RunToolTiming,
  StartVerificationOptions,
  TokenUsage,
  VerificationCommand,
  VerificationKind,
  VerificationLogUpdate,
  VerificationPlan,
  VerificationPolicy,
  VerificationRun,
  VerificationRunState,
  VerificationSnapshotUpdate,
  VerificationStepResult
} from './operations'

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

/** ready means a workspace/session is selected but its backend is not running. */
export type AgentPhase = 'stopped' | 'ready' | 'starting' | 'running' | 'error'

export type AgentMode = 'build' | 'plan'

export interface AgentStatus {
  phase: AgentPhase
  /** Human-readable error when phase === 'error' */
  error?: string
  /** Working directory the agent subprocess runs in */
  cwd?: string
}

export type RunCheckpointState = 'ready' | 'rolled-back' | 'unavailable'

/** Snapshot created immediately before an idle session starts a new run. */
export interface RunCheckpointStatus {
  id: string
  cwd: string
  createdAt: number
  state: RunCheckpointState
  /** Whether non-ignored workspace content differs from the snapshot. */
  hasChanges: boolean
  changedFileCount: number
  error?: string
}

export interface SessionInfo {
  provider?: string
  model?: string
  modelId?: string
  thinkingLevel?: string
  isStreaming: boolean
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled?: boolean
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  messageCount: number
  pendingMessageCount?: number
}

// ---------------------------------------------------------------------------
// Wire events (subset of pi's JsonAgentSessionEvent consumed by the UI)
// ---------------------------------------------------------------------------

export interface WireTextPart {
  type: 'text'
  text?: string
}

export interface WireToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Loosely-typed content part (text / thinking / toolCall / …). */
export type WireContentPart = Record<string, unknown> & { type: string }

export interface ImageContent {
  type: 'image'
  /** Base64-encoded image bytes without the data URL prefix. */
  data: string
  mimeType: string
}

export interface WireMessage {
  role: 'user' | 'assistant' | 'toolResult' | (string & {})
  content?: string | WireContentPart[]
  errorMessage?: string
  [key: string]: unknown
}

export interface WireAssistantMessageEvent {
  type: string
  delta?: string
  content?: string
  error?: WireMessage
}

export type WireEvent =
  | { type: 'agent_start' }
  | { type: 'agent_settled' }
  | { type: 'agent_end'; messages: WireMessage[]; willRetry: boolean }
  | { type: 'message_start'; message: WireMessage }
  | { type: 'message_end'; message: WireMessage }
  | { type: 'message_update'; usage: unknown; assistantMessageEvent: WireAssistantMessageEvent }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_end'; reason: string; result: unknown; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: 'session_info_changed'; name?: string }
  | { type: 'thinking_level_changed'; level: string }
  | { type: 'entry_appended'; entry: WireEntry }

/** pi emits more event types than modelled here; unmodelled ones flow through
 *  this widened type and are ignored by the reducer's default branch. */
export type WireEventInput = WireEvent | ({ type: string } & Record<string, unknown>)

// ---------------------------------------------------------------------------
// Session entries (wire format of pi's SessionEntry, used for replay)
// ---------------------------------------------------------------------------

export interface WireEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  /** Present when type === 'message' */
  message?: WireMessage
  /** Present when type === 'compaction' */
  summary?: string
  /** Present when type === 'custom' */
  customType?: string
  data?: unknown
  [key: string]: unknown
}

/** A bounded history window. Older windows are requested only when needed. */
export interface SessionEntriesPage {
  /** Entries in [start, end), ordered from oldest to newest. */
  entries: WireEntry[]
  /** Tool results for calls in the page, including results outside its bounds. */
  toolResults: WireEntry[]
  start: number
  end: number
  total: number
  leafId: string | null
  mode: AgentMode
}

/** One normalized native/legacy task persisted in a session transcript. */
export interface SessionTask {
  id: number | string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  activeForm?: string
  description?: string
}

/** A task plan attributed to one user-message run. */
export interface SessionTaskRun {
  key: string
  entryId?: string
  ordinal: number
  prompt: string
  timestamp?: string
  tasks: SessionTask[]
}

/** One user-message marker in the full persisted session history. */
export interface HistoryLandmark {
  entryId: string
  /** Zero-based position in SessionManager.getEntries(). */
  entryIndex: number
  ordinal: number
  snippet: string
  responseSnippet?: string
  timestamp: string
}

export interface SessionHistoryIndex {
  sessionPath: string
  totalEntries: number
  landmarks: HistoryLandmark[]
}

/** Flattened tree node for the branch view. */
export interface TreeNodeLite {
  id: string
  parentId: string | null
  kind: 'user' | 'assistant' | 'compaction' | 'other'
  snippet: string
  label?: string
  children: TreeNodeLite[]
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

/** Shape of AgentToolResult on the wire. */
export interface ToolResultPayload {
  content?: Array<{ type: string; text?: string }>
  details?: ToolDetails
  [key: string]: unknown
}

export interface ToolDetails {
  /** edit tool: display-oriented diff + unified patch */
  diff?: string
  patch?: string
  firstChangedLine?: number
  /** bash tool */
  truncation?: unknown
  fullOutputPath?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Projects & sessions
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  cwd: string
  name: string
  addedAt: number
  lastUsedAt: number
}

export type ProjectTrustDecision = 'trusted' | 'untrusted' | 'ask'
export type ProjectTrustSource = 'not-required' | 'saved' | 'inherited' | 'default'

/** Effective Pi project-resource trust for one working directory. */
export interface ProjectTrustInfo {
  cwd: string
  requiresTrust: boolean
  decision: ProjectTrustDecision
  source: ProjectTrustSource
  decisionPath?: string
  error?: string
}

export type ToolPermissionCategory = 'read' | 'write' | 'shell' | 'network' | 'external'
export type ToolPermissionDecision = 'allow' | 'ask' | 'deny'
export type ToolPermissionRisk = 'outside-workspace' | 'sensitive-path' | 'destructive-command'
export type ToolPermissionResolution = 'allow-once' | 'allow-session' | 'allow-project' | 'deny'

export interface ToolPermissionRules {
  read: ToolPermissionDecision
  write: ToolPermissionDecision
  shell: ToolPermissionDecision
  network: ToolPermissionDecision
  external: ToolPermissionDecision
}

/** Effective project-scoped tool policy applied by Pion's global Pi extension. */
export interface ProjectToolPermissionPolicy {
  cwd: string
  source: 'default' | 'saved'
  rules: ToolPermissionRules
}

/** One Pi tool call waiting for an explicit user decision. */
export interface ToolPermissionRequest {
  id: string
  cwd: string
  sessionPath?: string
  toolName: string
  category: ToolPermissionCategory
  policyCategories: ToolPermissionCategory[]
  summary: string
  detail: string
  risks: ToolPermissionRisk[]
  canRemember: boolean
  createdAt: number
  timeoutAt: number
}

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor'

/** Interactive Pi extension UI request projected into a native Pion dialog. */
export interface ExtensionUiRequest {
  id: string
  cwd: string
  sessionPath?: string
  method: ExtensionUiMethod
  title: string
  options?: string[]
  message?: string
  placeholder?: string
  prefill?: string
  createdAt: number
  timeoutAt: number
}

export type ExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }

export interface BranchInfo {
  /** Display name of the Git branch. */
  name: string
  /** Worktree directory used by this branch. */
  cwd: string
  /** Underlying Git branch name, when available. */
  gitBranch?: string
  /** Whether this is the project's primary worktree. */
  isMain: boolean
}

export interface SessionMeta {
  /** Project working directory that owns this session. */
  projectCwd?: string
  /** Absolute path of the .jsonl file */
  path: string
  id: string
  name?: string
  timestamp: string
  mtime: number
  /** First user message snippet */
  preview: string
  messageCount: number
  /** Renderer-only projection shown while Pi persists a new first message. */
  optimistic?: boolean
}

export interface ForkMessageOption {
  entryId: string
  text: string
}

export interface DeleteSessionResult {
  /** Whether the deleted session was active and a fresh session was created. */
  activeSessionChanged: boolean
  cancelled?: boolean
}

export interface ModelOption {
  provider: string
  id: string
  name?: string
  contextWindow?: number
  reasoning?: boolean
}

export interface SkillInfo {
  name: string
  description?: string
  /** Owning package/source, e.g. npm:pi-subagents or auto. */
  source?: string
}

export interface ToolInfo {
  name: string
  label?: string
  description?: string
  /** Owning package/source; built-in tools use a renderer-provided label. */
  source?: string
}

export interface AgentCapabilities {
  skills: SkillInfo[]
  /** Extension/custom tools; built-in tools remain listed by the renderer. */
  tools: ToolInfo[]
}

export interface PluginCatalogItem {
  name: string
  description: string
  type: string
  source: string
  packageUrl: string
  npmUrl?: string
  downloads?: number
}

export interface PluginInstallResult {
  source: string
  output: string
}

export interface PluginUninstallResult {
  source: string
  output: string
}

export type SlashCommandSource = 'builtin' | 'pion' | 'extension' | 'prompt' | 'skill'

export interface SlashCommandInfo {
  /** Command name without the leading slash. */
  name: string
  description?: string
  source: SlashCommandSource
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a wire message's content (string or parts array). */
export function messageText(message: WireMessage | undefined | null): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
  }
  return ''
}

/** Extract image parts from a user message for chat replay and rendering. */
export function messageImages(message: WireMessage | undefined | null): ImageContent[] {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.flatMap((part) => {
    if (
      part.type !== 'image'
      || typeof part.data !== 'string'
      || typeof part.mimeType !== 'string'
    ) return []
    return [{ type: 'image' as const, data: part.data, mimeType: part.mimeType }]
  })
}

/** Extract thinking text from an assistant wire message. */
export function messageThinking(message: WireMessage | undefined | null): string {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part.type === 'thinking' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

/** Extract tool calls from an assistant wire message. */
export function messageToolCalls(message: WireMessage | undefined | null): WireToolCall[] {
  if (!message || !Array.isArray(message.content)) return []
  return contentToolCalls(message.content)
}

export function contentToolCalls(content: WireContentPart[]): WireToolCall[] {
  return content
    .filter((part) => part.type === 'toolCall')
    .map((part) => part as unknown as WireToolCall)
}

// ---------------------------------------------------------------------------
// Preload API surface (implemented in src/preload, consumed via window.pion)
// ---------------------------------------------------------------------------

export interface PionApi {
  // agent lifecycle ---------------------------------------------------------
  /** Select a working directory; session backends load when selected. */
  startAgent(cwd: string): Promise<void>
  /** Stop all retained agent subprocesses. */
  stopAgent(): Promise<void>
  /** Send directly: prompt when idle or steer when the selected backend is busy. */
  send(message: string, images?: ImageContent[]): Promise<void>
  /** Queue a follow-up message for after the current run. */
  queue(message: string, images?: ImageContent[]): Promise<void>
  /** Abort the current run. */
  abort(): Promise<void>
  /** Current run checkpoint for the selected session. */
  getRunCheckpoint(): Promise<RunCheckpointStatus | null>
  /** Restore the selected workspace to the current run checkpoint. */
  rollbackRunCheckpoint(): Promise<RunCheckpointStatus>
  /** Durable token/cost/timing snapshots for recent runs. */
  getRunTelemetry(query?: RunTelemetryQuery): Promise<RunOperation[]>
  /** Interrupted runs and durable queued prompts that require a user decision. */
  getRunRecoveryCandidates(query?: RunTelemetryQuery): Promise<RunRecoveryCandidate[]>
  /** Continue an interrupted run as a linked, safety-prefaced new run. */
  resumeRun(runId: string): Promise<RunOperation>
  /** Resolve a recovery candidate without executing it. */
  discardRunRecovery(runId: string): Promise<RunOperation>
  /** Restore the durable pre-run Git checkpoint of a recovery candidate. */
  restoreRecoveredCheckpoint(runId: string): Promise<RunCheckpointStatus>

  // verification -----------------------------------------------------------
  discoverVerification(cwd: string, force?: boolean): Promise<VerificationPlan>
  listVerificationRuns(cwd?: string, sessionPath?: string): Promise<VerificationRun[]>
  startVerification(cwd: string, options?: StartVerificationOptions): Promise<VerificationRun>
  rerunVerification(runId: string): Promise<VerificationRun>
  cancelVerification(runId: string): Promise<VerificationRun>
  getVerificationPolicy(cwd: string): Promise<VerificationPolicy>
  setVerificationPolicy(
    cwd: string,
    updates: Partial<Omit<VerificationPolicy, 'cwd'>>
  ): Promise<VerificationPolicy>

  // bounded multi-agent workflows -------------------------------------------
  listWorkflows(cwd?: string): Promise<WorkflowSnapshot[]>
  createWorkflow(request: CreateWorkflowRequest): Promise<WorkflowSnapshot>
  startWorkflow(id: string): Promise<WorkflowSnapshot>
  approveWorkflowPlan(id: string): Promise<WorkflowSnapshot>
  repairWorkflow(id: string): Promise<WorkflowSnapshot>
  waiveWorkflowTests(id: string): Promise<WorkflowSnapshot>
  resumeWorkflow(id: string): Promise<WorkflowSnapshot>
  cancelWorkflow(id: string): Promise<WorkflowSnapshot>
  mergeWorkflow(id: string): Promise<WorkflowSnapshot>
  cleanupWorkflow(id: string): Promise<WorkflowSnapshot>

  // Git workspace -----------------------------------------------------------
  getGitStatus(cwd: string): Promise<GitWorkspaceSnapshot>
  getGitDiff(cwd: string, path: string, scope: GitDiffScope): Promise<GitFileDiff>
  stageGitPaths(cwd: string, snapshotId: string, paths: string[]): Promise<GitWorkspaceSnapshot>
  unstageGitPaths(cwd: string, snapshotId: string, paths: string[]): Promise<GitWorkspaceSnapshot>
  discardGitPaths(cwd: string, snapshotId: string, paths: string[]): Promise<GitWorkspaceSnapshot>
  applyGitSelection(request: GitSelectionRequest): Promise<GitWorkspaceSnapshot>
  commitGit(cwd: string, snapshotId: string, message: string): Promise<GitCommitResult>
  readGitConflict(cwd: string, path: string): Promise<GitConflictContent>
  resolveGitConflict(
    cwd: string,
    snapshotId: string,
    path: string,
    strategy: 'ours' | 'theirs' | 'content',
    content?: string
  ): Promise<GitWorkspaceSnapshot>
  continueGitOperation(cwd: string, snapshotId: string): Promise<GitWorkspaceSnapshot>
  abortGitOperation(cwd: string, snapshotId: string): Promise<GitWorkspaceSnapshot>

  // session management ------------------------------------------------------
  /** Current session info, or null when no session is selected. */
  getState(): Promise<SessionInfo | null>
  /** Start a fresh session in the same cwd and initialize its backend. */
  newSession(): Promise<void>
  /** Fork the session at an entry; resolves with the message text at the fork point. */
  forkAt(entryId: string): Promise<{ text: string; cancelled: boolean }>
  /** Switch to another session file and load/reuse its backend. */
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>
  /** Delete a persisted session file. */
  deleteSession(sessionPath: string): Promise<DeleteSessionResult>
  /** Copy the selected session's active branch into a new session. */
  copySession(sessionPath: string): Promise<{ cancelled: boolean }>
  /** List user messages that can be used as fork points. */
  getSessionForkMessages(sessionPath: string): Promise<ForkMessageOption[]>
  /** Create a new session by forking before a selected user message. */
  forkSession(sessionPath: string, entryId: string): Promise<{ text: string; cancelled: boolean }>
  /** Full entry list of the active session (kept for diagnostics/compatibility). */
  getEntries(): Promise<{ entries: WireEntry[]; leafId: string | null } | null>
  /** User-message landmarks spanning the full persisted session. */
  getHistoryIndex(sessionPath?: string): Promise<SessionHistoryIndex | null>
  /** Compact per-user-message todo history, parsed without transferring full entries. */
  getSessionTaskHistory(sessionPath: string): Promise<SessionTaskRun[]>
  /** Persisted session paths whose retained backends are actively processing a run. */
  getRunningSessionPaths(): Promise<string[]>
  /** Load a bounded history window; omit before for the newest window. */
  getEntriesPage(
    before?: number,
    limit?: number,
    sessionPath?: string
  ): Promise<SessionEntriesPage | null>
  /** Flattened branch tree of the active session. */
  getTree(): Promise<{ tree: TreeNodeLite[]; leafId: string | null } | null>

  // model & thinking --------------------------------------------------------
  getAvailableModels(): Promise<ModelOption[]>
  getSkills(): Promise<SkillInfo[]>
  getCapabilities(): Promise<AgentCapabilities>
  getCommands(): Promise<SlashCommandInfo[]>
  getPluginCatalog(): Promise<PluginCatalogItem[]>
  getInstalledPlugins(): Promise<string[]>
  installPlugin(source: string): Promise<PluginInstallResult>
  uninstallPlugin(source: string): Promise<PluginUninstallResult>
  setMode(mode: AgentMode): Promise<void>
  setModel(provider: string, modelId: string): Promise<void>
  getThinkingLevels(): Promise<string[]>
  setThinkingLevel(level: string): Promise<void>

  // agent settings ------------------------------------------------------------
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  /** Compact the session context now (LLM summarization). */
  compactNow(customInstructions?: string): Promise<void>
  /** Export the session to HTML; resolves with the output path. */
  exportSessionHtml(): Promise<string>
  renameSession(name: string): Promise<void>
  setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void>
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void>

  // app settings -------------------------------------------------------------
  getCompletionNotificationsEnabled(): Promise<boolean>
  setCompletionNotificationsEnabled(enabled: boolean): Promise<void>
  getToolPermissionPolicy(cwd: string): Promise<ProjectToolPermissionPolicy>
  setToolPermissionPolicy(
    cwd: string,
    updates: Partial<ToolPermissionRules> | null
  ): Promise<ProjectToolPermissionPolicy>
  getPendingToolPermissionRequests(): Promise<ToolPermissionRequest[]>
  resolveToolPermission(
    requestId: string,
    resolution: ToolPermissionResolution
  ): Promise<ProjectToolPermissionPolicy | null>
  getPendingExtensionUiRequests(): Promise<ExtensionUiRequest[]>
  resolveExtensionUiRequest(requestId: string, response: ExtensionUiResponse): Promise<void>

  // projects ----------------------------------------------------------------
  listProjects(): Promise<ProjectMeta[]>
  /** Resolve native Pi project-resource trust for a workspace. */
  getProjectTrust(cwd: string): Promise<ProjectTrustInfo>
  /** Save or clear native Pi project-resource trust and reload matching backends. */
  setProjectTrust(cwd: string, decision: boolean | null): Promise<ProjectTrustInfo>
  listBranches(cwd: string): Promise<BranchInfo[]>
  createBranch(cwd: string, name: string): Promise<BranchInfo>
  addProject(cwd: string): Promise<ProjectMeta[]>
  removeProject(cwd: string): Promise<ProjectMeta[]>
  /** List sessions recorded for a working directory. */
  listSessions(cwd: string): Promise<SessionMeta[]>

  // misc --------------------------------------------------------------------
  /** Collected stderr of the agent subprocess (debugging aid). */
  getStderr(): Promise<string>
  /** Read an image from the system clipboard as base64. */
  readClipboardImage(): Promise<ImageContent | null>
  /** Open a native directory picker; returns null when cancelled. */
  pickWorkspace(): Promise<string | null>
  /** Default workspace suggestion (user home directory). */
  defaultWorkspace(): Promise<string>

  // window -------------------------------------------------------------------
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
  getWindowState(): Promise<boolean>
  onWindowState(listener: (maximized: boolean) => void): () => void

  // events ------------------------------------------------------------------
  /** Subscribe to agent events; returns an unsubscribe function. */
  onEvent(listener: (event: WireEventInput) => void): () => void
  /** Subscribe to lifecycle status changes; returns an unsubscribe function. */
  onStatus(listener: (status: AgentStatus) => void): () => void
  /** Subscribe to run-checkpoint changes for the selected session. */
  onRunCheckpoint(listener: (checkpoint: RunCheckpointStatus | null) => void): () => void
  /** Subscribe to throttled main-process run telemetry updates. */
  onRunTelemetry(listener: (update: RunTelemetryUpdate) => void): () => void
  onVerificationRuns(listener: (update: VerificationSnapshotUpdate) => void): () => void
  onVerificationLog(listener: (update: VerificationLogUpdate) => void): () => void
  onWorkflowUpdate(listener: (update: WorkflowUpdate) => void): () => void
  onGitSnapshot(listener: (update: GitSnapshotUpdate) => void): () => void
  /** Subscribe to session info pushes; returns an unsubscribe function. */
  onState(listener: (state: SessionInfo | null) => void): () => void
  /** Subscribe to session-list pushes for the active cwd. */
  onSessions(listener: (sessions: SessionMeta[]) => void): () => void
  /** Subscribe whenever any retained session starts or finishes a run. */
  onRunningSessionPaths(listener: (sessionPaths: string[]) => void): () => void
  /** Subscribe to branch-tree pushes. */
  onTree(listener: (tree: { tree: TreeNodeLite[]; leafId: string | null } | null) => void): () => void
  /** Subscribe to project-list pushes. */
  onProjects(listener: (projects: ProjectMeta[]) => void): () => void
  /** Subscribe to the global queue of tool calls awaiting permission. */
  onToolPermissionRequests(listener: (requests: ToolPermissionRequest[]) => void): () => void
  /** Subscribe to interactive requests emitted by Pi extensions in RPC mode. */
  onExtensionUiRequests(listener: (requests: ExtensionUiRequest[]) => void): () => void
}
