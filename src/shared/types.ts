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
  thinkingLevel?: string
  isStreaming: boolean
  sessionName?: string
  messageCount: number
  pendingMessageCount?: number
}

// ---------------------------------------------------------------------------
// Wire events (subset of pi's JsonAgentSessionEvent consumed by the UI)
// ---------------------------------------------------------------------------

export interface WireMessagePart {
  type: string
  text?: string
  [key: string]: unknown
}

export interface WireMessage {
  role: 'user' | 'assistant' | 'toolResult' | (string & {})
  content?: string | WireMessagePart[]
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
  | { type: 'session_info_changed'; name?: string }
  | { type: 'thinking_level_changed'; level: string }

/**
 * pi 实际发出的eventType多于本联合类型；未建模的事件在边界处破型后
 * 由 reducer 的 default 分支静默忽略。
 */
export type WireEventInput = WireEvent | ({ type: string } & Record<string, unknown>)

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
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
  }
  return ''
}

// ---------------------------------------------------------------------------
// Preload API surface (implemented in src/preload, consumed via window.pion)
// ---------------------------------------------------------------------------

export interface PionApi {
  /** Start the pi agent RPC subprocess in the given working directory. */
  startAgent(cwd: string): Promise<void>
  /** Stop the agent subprocess. */
  stopAgent(): Promise<void>
  /** Send a prompt (agent idle) or a steering message (agent busy). */
  send(message: string): Promise<void>
  /** Abort the current run. */
  abort(): Promise<void>
  /** Current session info, or null when the agent is not running. */
  getState(): Promise<SessionInfo | null>
  /** Collected stderr of the agent subprocess (debugging aid). */
  getStderr(): Promise<string>
  /** Open a native directory picker; returns null when cancelled. */
  pickWorkspace(): Promise<string | null>
  /** Default workspace suggestion (user home directory). */
  defaultWorkspace(): Promise<string>
  /** Subscribe to agent events; returns an unsubscribe function. */
  onEvent(listener: (event: WireEventInput) => void): () => void
  /** Subscribe to lifecycle status changes; returns an unsubscribe function. */
  onStatus(listener: (status: AgentStatus) => void): () => void
  /** Subscribe to session info pushes; returns an unsubscribe function. */
  onState(listener: (state: SessionInfo | null) => void): () => void
}
