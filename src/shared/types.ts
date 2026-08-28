/**
 * Pion IPC contract shared by main process, preload, and renderer.
 *
 * Deliberately free of pi SDK imports so the renderer bundle stays decoupled
 * from server-side types. The main process adapts pi's `JsonAgentSessionEvent`
 * wire format into the `WireEvent` subset defined here.
 */

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

export type AgentPhase = 'stopped' | 'starting' | 'running' | 'error'

export interface AgentStatus {
  phase: AgentPhase
  /** Human-readable error when phase === 'error' */
  error?: string
  /** Working directory the agent subprocess runs in */
  cwd?: string
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
  [key: string]: unknown
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

export interface SessionMeta {
  /** Absolute path of the .jsonl file */
  path: string
  id: string
  name?: string
  timestamp: string
  mtime: number
  /** First user message snippet */
  preview: string
  messageCount: number
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
  /** Start the pi agent RPC subprocess in the given working directory. */
  startAgent(cwd: string): Promise<void>
  /** Stop the agent subprocess. */
  stopAgent(): Promise<void>
  /** Send directly: prompt when idle or steer when the agent is busy. */
  send(message: string): Promise<void>
  /** Queue a follow-up message for after the current run. */
  queue(message: string): Promise<void>
  /** Abort the current run. */
  abort(): Promise<void>

  // session management ------------------------------------------------------
  /** Current session info, or null when the agent is not running. */
  getState(): Promise<SessionInfo | null>
  /** Start a fresh session in the same cwd. */
  newSession(): Promise<void>
  /** Fork the session at an entry; resolves with the message text at the fork point. */
  forkAt(entryId: string): Promise<{ text: string; cancelled: boolean }>
  /** Switch to another session file. */
  switchSession(sessionPath: string): Promise<void>
  /** Delete a persisted session file. */
  deleteSession(sessionPath: string): Promise<DeleteSessionResult>
  /** Copy the selected session's active branch into a new session. */
  copySession(sessionPath: string): Promise<{ cancelled: boolean }>
  /** List user messages that can be used as fork points. */
  getSessionForkMessages(sessionPath: string): Promise<ForkMessageOption[]>
  /** Create a new session by forking before a selected user message. */
  forkSession(sessionPath: string, entryId: string): Promise<{ text: string; cancelled: boolean }>
  /** Full entry list of the active session (for timeline rebuild). */
  getEntries(): Promise<{ entries: WireEntry[]; leafId: string | null } | null>
  /** Flattened branch tree of the active session. */
  getTree(): Promise<{ tree: TreeNodeLite[]; leafId: string | null } | null>

  // model & thinking --------------------------------------------------------
  getAvailableModels(): Promise<ModelOption[]>
  setModel(provider: string, modelId: string): Promise<void>
  getThinkingLevels(): Promise<string[]>
  setThinkingLevel(level: string): Promise<void>

  // agent settings ------------------------------------------------------------
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  /** Compact the session context now (LLM summarization). */
  compactNow(): Promise<void>
  /** Export the session to HTML; resolves with the output path. */
  exportSessionHtml(): Promise<string>
  renameSession(name: string): Promise<void>
  setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void>
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void>

  // projects ----------------------------------------------------------------
  listProjects(): Promise<ProjectMeta[]>
  addProject(cwd: string): Promise<ProjectMeta[]>
  removeProject(cwd: string): Promise<ProjectMeta[]>
  /** List sessions recorded for a working directory. */
  listSessions(cwd: string): Promise<SessionMeta[]>

  // misc --------------------------------------------------------------------
  /** Collected stderr of the agent subprocess (debugging aid). */
  getStderr(): Promise<string>
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
  /** Subscribe to session info pushes; returns an unsubscribe function. */
  onState(listener: (state: SessionInfo | null) => void): () => void
  /** Subscribe to session-list pushes for the active cwd. */
  onSessions(listener: (sessions: SessionMeta[]) => void): () => void
  /** Subscribe to branch-tree pushes. */
  onTree(listener: (tree: { tree: TreeNodeLite[]; leafId: string | null } | null) => void): () => void
  /** Subscribe to project-list pushes. */
  onProjects(listener: (projects: ProjectMeta[]) => void): () => void
}
