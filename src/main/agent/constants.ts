import { IPC_EVENTS } from '../../shared/ipc'
import type { SlashCommandInfo } from '../../shared/types'

export const EVENT_CHANNEL = IPC_EVENTS.AgentEvent
export const STATUS_CHANNEL = IPC_EVENTS.AgentStatus
export const CHECKPOINT_CHANNEL = IPC_EVENTS.AgentRunCheckpoint
export const TOOL_PERMISSION_CHANNEL = IPC_EVENTS.ToolPermissionRequests
export const EXTENSION_UI_CHANNEL = IPC_EVENTS.ExtensionUiRequests
export const MODEL_PROVIDER_AUTH_CHANNEL = IPC_EVENTS.ModelProviderAuthState
export const STATE_CHANNEL = IPC_EVENTS.AgentState
export const SESSIONS_CHANNEL = IPC_EVENTS.AgentSessions
export const RUNNING_SESSIONS_CHANNEL = IPC_EVENTS.AgentRunningSessions
export const RUN_TELEMETRY_CHANNEL = IPC_EVENTS.AgentRunTelemetry
export const TREE_CHANNEL = IPC_EVENTS.AgentTree

/** Global pool size shared by every project and worktree. */
export const MAX_RETAINED_BACKENDS = 10
export const EXTENSION_UI_TIMEOUT_MS = 10 * 60 * 1000

/** Pi's RPC get_commands intentionally returns only extensions, prompts, and
    skills. Merge the built-ins that Pion can execute with equivalent native
    behavior so autocomplete does not silently omit core commands. */
export const BUILTIN_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: 'compact', description: '手动压缩上下文，可附加摘要要求', source: 'builtin' },
  { name: 'new', description: '在当前项目中新建会话', source: 'builtin' },
  { name: 'name', description: '设置或清除当前会话名称', source: 'builtin' },
  { name: 'clone', description: '复制当前活动分支为新会话', source: 'builtin' },
  { name: 'plan', description: '切换 Pion 只读计划模式，不直接执行实现', source: 'pion' },
  { name: 'verify', description: '打开项目自动验证面板', source: 'pion' },
  { name: 'agents', description: '打开隔离多 Agent 工作流面板', source: 'pion' }
]

/** Events after which derived state (model/session/tree) is re-pushed. */
export const STATE_REFRESH_EVENTS = new Set([
  'agent_settled',
  'session_info_changed',
  'thinking_level_changed'
])
