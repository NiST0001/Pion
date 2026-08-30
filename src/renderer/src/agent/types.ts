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
  WireEventInput
} from '../../../shared/types'

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
  /** todo 工具结果中的完整任务快照 */
  todos?: AgentTodo[]
}

/** Renderer aliases for the shared transcript task-history shapes. */
export type AgentTodo = SessionTask
export type AgentTaskRun = SessionTaskRun

export type TimelineItem =
  | {
      kind: 'user'
      id: number
      entryId?: string
      text: string
      images?: ImageContent[]
      timestamp?: string
      historical?: boolean
    }
  | {
      kind: 'assistant'
      id: number
      entryId?: string
      text: string
      thinking: string
      streaming: boolean
      error?: string
      historical?: boolean
    }
  | { kind: 'tool'; id: number; tool: ToolItem; historical?: boolean }
  | { kind: 'compaction'; id: number; summary: string; historical?: boolean }

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
  projects: ProjectMeta[]
  models: ModelOption[]
  thinkingLevels: string[]
  commands: SlashCommandInfo[]
  mode: AgentMode
  timeline: TimelineItem[]
  timelineMutation: 'replace' | 'prepend' | 'append' | null
  timelineLoading: boolean
  timelineError?: string
  busy: boolean
  queued: { steering: number; followUp: number }
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
  projects: [],
  models: [],
  thinkingLevels: [],
  commands: [],
  mode: 'build',
  timeline: [],
  timelineMutation: null,
  timelineLoading: false,
  busy: false,
  queued: { steering: 0, followUp: 0 }
}

export type Action =
  | { type: 'status'; status: AgentStatus }
  | { type: 'session'; session: SessionInfo | null }
  | { type: 'runCheckpoint'; checkpoint: RunCheckpointStatus | null }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'projectSessions'; sessionsByProject: Record<string, SessionMeta[]> }
  | { type: 'branches'; cwd: string; branches: BranchInfo[] }
  | { type: 'tree'; tree: { tree: TreeNodeLite[]; leafId: string | null } | null }
  | { type: 'historyIndex'; index: SessionHistoryIndex | null }
  | { type: 'historyJump'; entryId: string; nonce: number }
  | { type: 'projects'; projects: ProjectMeta[] }
  | { type: 'reorderSessions'; cwd: string; paths: string[] }
  | { type: 'models'; models: ModelOption[] }
  | { type: 'thinkingLevels'; levels: string[] }
  | { type: 'commands'; commands: SlashCommandInfo[] }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'event'; event: WireEventInput }
  | { type: 'loadEntries'; items: TimelineItem[]; mode?: AgentMode }
  | { type: 'prependEntries'; items: TimelineItem[] }
  | { type: 'appendEntries'; items: TimelineItem[] }
  | { type: 'timelineLoading'; loading: boolean }
  | { type: 'timelineError'; error?: string }
  | { type: 'clearTimeline' }
