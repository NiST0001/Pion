/**
 * Pion IPC contract shared by main process, preload, and renderer.
 *
 * Deliberately free of pi SDK imports so the renderer bundle stays decoupled
 * from server-side types. The main process adapts pi's `JsonAgentSessionEvent`
 * wire format into the `WireEvent` subset defined here.
 */

export type { PionApi } from './pion-api'
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
  isCompacting?: boolean
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled?: boolean
  /** True when this session auto-approves every tool-permission prompt. */
  yolo?: boolean
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
  | { type: 'compaction_start'; reason: string }
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
  /** Provider auth prompts use the same native interaction channel above settings. */
  source?: 'extension' | 'provider-auth'
  scope?: 'workspace' | 'global'
  secret?: boolean
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

export type ModelProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

/** User-authored provider configuration persisted to Pi models.json/auth.json. */
export interface AddModelProviderInput {
  providerId: string
  baseUrl: string
  api: ModelProviderApi
  /** Literal key, $ENV reference, !command, or blank for a keyless local endpoint. */
  apiKey?: string
  modelIds: string[]
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  imageInput: boolean
  authHeader: boolean
}

export type ModelProviderAuthType = 'api_key' | 'oauth'

/** One authentication method exposed by Pi's canonical provider registry. */
export interface ModelProviderAuthMethod {
  type: ModelProviderAuthType
  name: string
  loginLabel?: string
  interactive: boolean
  subscription?: boolean
}

/** Non-secret provider/auth metadata read from Pi's ModelRuntime. */
export interface ModelProviderInfo {
  id: string
  name: string
  modelCount: number
  configured: boolean
  configuredSource?: string
  configuredLabel?: string
  storedCredentialType?: ModelProviderAuthType
  authMethods: ModelProviderAuthMethod[]
}

export interface ModelProviderAuthLink {
  url: string
  label?: string
}

export type ModelProviderAuthPhase = 'starting' | 'waiting' | 'success' | 'error' | 'cancelled'

/** Live, non-secret projection of a Pi provider login flow. */
export interface ModelProviderAuthState {
  operationId: string
  providerId: string
  providerName: string
  authType: ModelProviderAuthType
  phase: ModelProviderAuthPhase
  message: string
  url?: string
  links?: ModelProviderAuthLink[]
  userCode?: string
  startedAt: number
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
