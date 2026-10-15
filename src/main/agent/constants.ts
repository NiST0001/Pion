import { IPC_EVENTS } from '../../shared/ipc'
import { DESKTOP_SLASH_COMMANDS } from '../../shared/slash-commands'

export const EVENT_CHANNEL = IPC_EVENTS.AgentEvent
export const STATUS_CHANNEL = IPC_EVENTS.AgentStatus
export const CHECKPOINT_CHANNEL = IPC_EVENTS.AgentRunCheckpoint
export const TOOL_PERMISSION_CHANNEL = IPC_EVENTS.ToolPermissionRequests
export const EXTENSION_UI_CHANNEL = IPC_EVENTS.ExtensionUiRequests
export const MODEL_PROVIDER_AUTH_CHANNEL = IPC_EVENTS.ModelProviderAuthState
export const STATE_CHANNEL = IPC_EVENTS.AgentState
export const SESSIONS_CHANNEL = IPC_EVENTS.AgentSessions
export const RUNNING_SESSIONS_CHANNEL = IPC_EVENTS.AgentRunningSessions
export const UNREAD_SESSIONS_CHANNEL = IPC_EVENTS.AgentUnreadSessions
export const RUN_TELEMETRY_CHANNEL = IPC_EVENTS.AgentRunTelemetry
export const TREE_CHANNEL = IPC_EVENTS.AgentTree

/** Global pool size shared by every project and worktree. */
export const MAX_RETAINED_BACKENDS = 10
export const EXTENSION_UI_TIMEOUT_MS = 10 * 60 * 1000

/** Pi's RPC get_commands returns only resource commands. Share the desktop
    catalog with the renderer, including explicitly pending Pi integrations. */
export const BUILTIN_SLASH_COMMANDS = DESKTOP_SLASH_COMMANDS

/** Events after which derived state (model/session/tree) is re-pushed. */
export const STATE_REFRESH_EVENTS = new Set([
  'agent_settled',
  'session_info_changed',
  'thinking_level_changed'
])
