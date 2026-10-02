/**
 * Agent 状态模型：时间线条目、变更列表与全局 AgentState。
 *
 * 该文件只描述数据形状（以及 reducer 的初始状态与 Action 联合类型），
 * 状态迁移逻辑在 agent/reducer.ts，条目解析在 agent/timeline.ts。
 */
import type {
  AgentMode,
  AgentStatus,
  BranchInfo,
  ImageContent,
  ModelOption,
  ProjectMeta,
  RunCheckpointStatus,
  SessionHistoryIndex,
  SessionInfo,
  SessionMeta,
  SessionTask,
  SessionTaskRun,
  SlashCommandInfo,
  TreeNodeLite,
  WireEntry,
  WireEventInput
} from '../../../shared/types'
import type { ToolResultImage } from '../../../shared/tool-images'
import type { GeneratedImageModelInfo, GeneratedImageSettingsInfo } from '../../../shared/image-generation'

// ---------------------------------------------------------------------------
// Timeline items
// ---------------------------------------------------------------------------

export interface ToolItem {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  isError: boolean
  /** Target file for fs tools */
  path?: string
  /** Bash / powershell command */
  command?: string
  /** Edit tool: display diff */
  diff?: string
  /** Write tool: file content from args */
  writeContent?: string
  /** Generic textual output */
  outputText?: string
  /** Bounded, validated static previews; originals remain in the project. */
  images?: ToolResultImage[]
  imageNotice?: string
  /** Request alias only; neither saved metadata nor response echoes prove the engine. */
  imageModelInfo?: GeneratedImageModelInfo
  /** Validated request settings and saved-original metadata; never raw references. */
  imageSettingsInfo?: GeneratedImageSettingsInfo
  /** A final payload was projected, unlike a replayed call with no result yet. */
  resultReceived?: boolean
  /** Persisted/message results outrank lower-level execution notifications. */
  resultSource?: 'execution' | 'message' | 'history'
  /** Set by live tool events; absent on history replay and paged entries. */
  live?: boolean
  /** Pion 原生任务或旧 todo 工具结果中的完整任务快照 */
  todos?: AgentTodo[]
}

/** Renderer aliases for the shared transcript task-history shapes. */
export type AgentTodo = SessionTask
export type AgentTaskRun = SessionTaskRun

export type TimelineItem = (
  | {
      kind: 'user'
      id: number
      entryId?: string
      /** Stable timestamp carried by the SDK user message itself. */
      messageTimestamp?: number
      text: string
      images?: ImageContent[]
      timestamp?: string
      /** Set by message_start; absent on history replay and paged entries. */
      live?: boolean
      historical?: boolean
      /** Paged history navigation mounts this item statically (no waterfall). */
      noReveal?: boolean
    }
  | {
      kind: 'assistant'
      id: number
      entryId?: string
      /** Stable timestamp carried by the SDK assistant message itself. */
      messageTimestamp?: number
      text: string
      thinking: string
      streaming: boolean
      /** Set by message_start; absent on history replay and paged entries. */
      live?: boolean
      error?: string
      /** Identifies failures produced by automatic/manual context compaction. */
      errorContext?: 'compaction'
      historical?: boolean
      /** Paged history navigation mounts this item statically (no waterfall). */
      noReveal?: boolean
    }
  | { kind: 'tool'; id: number; tool: ToolItem; historical?: boolean; noReveal?: boolean }
  | {
      kind: 'compaction'
      id: number
      entryId?: string
      /** SDK result/entry signature; never use the generic display label as identity. */
      compactionFingerprint?: string
      summary: string
      live?: boolean
      historical?: boolean
      noReveal?: boolean
    }
) & {
  /** This realtime row has been placed in a loaded persisted history page. */
  historyReconciled?: boolean
}

// ---------------------------------------------------------------------------
// Changes (review panel)
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string
  kind: 'edit' | 'write'
  diff?: string
  content?: string
  additions: number
  deletions: number
}

// ---------------------------------------------------------------------------
// Global agent state
// ---------------------------------------------------------------------------

export interface AgentState {
  status: AgentStatus
  session: SessionInfo | null
  runCheckpoint: RunCheckpointStatus | null
  sessions: SessionMeta[]
  sessionsByProject: Record<string, SessionMeta[]>
  branchesByProject: Record<string, BranchInfo[]>
  tree: { tree: TreeNodeLite[]; leafId: string | null } | null
  historyIndex: SessionHistoryIndex | null
  historyJump: { entryId: string; nonce: number } | null
  /** Explicit destructive branch selection, independent of ordinary history replacement. */
  historyResetRevision: number
  projects: ProjectMeta[]
  models: ModelOption[]
  thinkingLevels: string[]
  commands: SlashCommandInfo[]
  mode: AgentMode
  /** Session-scoped: auto-approve every tool-permission prompt. */
  yolo: boolean
  /** Sessions whose latest completed run has not been opened yet. */
  unreadSessionPaths: string[]
  runningSessionPaths: string[]
  /** Session task projection; null means not hydrated, [] means explicitly empty. */
  tasks: AgentTodo[] | null
  taskRevision: number
  /** Bounded deduplication of execution/message/persistence result notifications. */
  taskResultIds: string[]
  taskRestore?: { id: number; revision: number }
  timeline: TimelineItem[]
  /** A clear selects a new transcript scope, even before the hook renders. */
  timelineScopeRevision: number
  /** Acknowledges a history replacement whose reducer projection may differ. */
  timelineLoadId: number
  timelineMutation: 'replace' | 'prepend' | 'history-append' | 'append' | null
  timelineLoading: boolean
  timelineError?: string
  busy: boolean
  compacting: boolean
  /** Ordered lifecycle events override asynchronous snapshots until session reset. */
  compactionEventState?: boolean
  /** Counts retained for status/telemetry compatibility. */
  queued: { steering: number; followUp: number }
  /** Text snapshots used by the composer-side queue card. */
  queuedMessages: { steering: string[]; followUp: string[]; nativeFollowUpCount: number }
}

export const initialState: AgentState = {
  status: { phase: 'stopped' },
  session: null,
  runCheckpoint: null,
  sessions: [],
  sessionsByProject: {},
  branchesByProject: {},
  tree: null,
  historyIndex: null,
  historyJump: null,
  historyResetRevision: 0,
  projects: [],
  models: [],
  thinkingLevels: [],
  commands: [],
  mode: 'build',
  yolo: false,
  unreadSessionPaths: [],
  runningSessionPaths: [],
  tasks: null,
  taskRevision: 0,
  taskResultIds: [],
  timeline: [],
  timelineScopeRevision: 0,
  timelineLoadId: 0,
  timelineMutation: null,
  timelineLoading: false,
  busy: false,
  compacting: false,
  queued: { steering: 0, followUp: 0 },
  queuedMessages: { steering: [], followUp: [], nativeFollowUpCount: 0 }
}

/** Captured only for replacement reads of the same selected transcript. */
export interface ToolStateScope {
  revision: number
  cwd?: string
  sessionId?: string
  sessionPath?: string
}

export type Action =
  | { type: 'status'; status: AgentStatus }
  | { type: 'session'; session: SessionInfo | null }
  | { type: 'runCheckpoint'; checkpoint: RunCheckpointStatus | null }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'unreadSessions'; paths: string[] }
  | { type: 'projectSessions'; sessionsByProject: Record<string, SessionMeta[]> }
  | { type: 'projectSessionsUpdate'; cwd: string; sessions: SessionMeta[] }
  | { type: 'optimisticSession'; session: SessionMeta }
  | { type: 'removeOptimisticSession'; cwd: string; id: string }
  | { type: 'branches'; cwd: string; branches: BranchInfo[] }
  | { type: 'tree'; tree: { tree: TreeNodeLite[]; leafId: string | null } | null }
  | { type: 'historyIndex'; index: SessionHistoryIndex | null }
  | { type: 'historyJump'; entryId: string; nonce: number }
  | { type: 'resetHistoryNavigation' }
  | { type: 'projects'; projects: ProjectMeta[] }
  | { type: 'reorderSessions'; cwd: string; paths: string[] }
  | { type: 'models'; models: ModelOption[] }
  | { type: 'thinkingLevels'; levels: string[] }
  | { type: 'commands'; commands: SlashCommandInfo[] }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'runningSessionPaths'; paths: string[] }
  | { type: 'event'; event: WireEventInput }
  | { type: 'beginTaskRestore'; id: number }
  | { type: 'restoreTasks'; id: number; tasks: AgentTodo[] }
  | { type: 'cachedTasks'; tasks: AgentTodo[] }
  | { type: 'loadEntries'; items: TimelineItem[]; mode?: AgentMode; preserveToolState?: ToolStateScope; loadId?: number }
  | { type: 'prependEntries'; items: TimelineItem[]; toolResults?: WireEntry[] }
  | { type: 'appendEntries'; items: TimelineItem[]; toolResults?: WireEntry[] }
  | { type: 'timelineLoading'; loading: boolean }
  | { type: 'timelineError'; error?: string }
  | { type: 'clearTimeline' }
