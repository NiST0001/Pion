/**
 * IPC 频道名单一事实来源。
 *
 * 主进程注册 handler（main/index.ts）、AgentBridge 推送事件、preload 桥
 * （preload/index.ts）统一引用此处常量，避免三处字符串各自漂移。
 */

/** renderer -> main 的 invoke/send 频道。 */
export const IPC = {
  // agent lifecycle
  AgentStart: 'pion:agent-start',
  AgentStop: 'pion:agent-stop',
  AgentSend: 'pion:agent-send',
  AgentQueue: 'pion:agent-queue',
  AgentAbort: 'pion:agent-abort',
  AgentRunCheckpoint: 'pion:agent-run-checkpoint',
  AgentRollbackCheckpoint: 'pion:agent-rollback-checkpoint',
  AgentStderr: 'pion:agent-stderr',

  // session management
  AgentState: 'pion:agent-state',
  AgentNewSession: 'pion:agent-new-session',
  AgentFork: 'pion:agent-fork',
  AgentSwitchSession: 'pion:agent-switch-session',
  AgentDeleteSession: 'pion:agent-delete-session',
  AgentCopySession: 'pion:agent-copy-session',
  AgentSessionForkMessages: 'pion:agent-session-fork-messages',
  AgentForkSession: 'pion:agent-fork-session',
  AgentEntries: 'pion:agent-entries',
  AgentEntriesPage: 'pion:agent-entries-page',
  AgentTree: 'pion:agent-tree',
  AgentSessions: 'pion:agent-sessions',

  // commands, modes, model & thinking
  AgentCommands: 'pion:agent-commands',
  AgentSetMode: 'pion:agent-set-mode',
  AgentModels: 'pion:agent-models',
  AgentSkills: 'pion:agent-skills',
  AgentCapabilities: 'pion:agent-capabilities',
  AgentSetModel: 'pion:agent-set-model',
  AgentThinkingLevels: 'pion:agent-thinking-levels',
  AgentSetThinking: 'pion:agent-set-thinking',

  // agent settings
  AgentSetAutoCompaction: 'pion:agent-set-auto-compaction',
  AgentSetAutoRetry: 'pion:agent-set-auto-retry',
  AgentCompact: 'pion:agent-compact',
  AgentExportHtml: 'pion:agent-export-html',
  AgentRenameSession: 'pion:agent-rename-session',
  AgentSetSteeringMode: 'pion:agent-set-steering-mode',
  AgentSetFollowUpMode: 'pion:agent-set-follow-up-mode',

  // app settings
  GetCompletionNotifications: 'pion:get-completion-notifications',
  SetCompletionNotifications: 'pion:set-completion-notifications',

  // plugin store
  PluginsCatalog: 'pion:plugins-catalog',
  PluginsInstalled: 'pion:plugins-installed',
  PluginsInstall: 'pion:plugins-install',

  // window controls
  WindowControl: 'pion:window-control',
  WindowState: 'pion:window-state',

  // projects & git branches
  ProjectsList: 'pion:projects-list',
  ProjectsAdd: 'pion:projects-add',
  ProjectsRemove: 'pion:projects-remove',
  ProjectsPush: 'pion:projects',
  BranchesList: 'pion:branches-list',
  BranchCreate: 'pion:branch-create',

  // misc
  ClipboardImage: 'pion:clipboard-image',
  PickWorkspace: 'pion:pick-workspace',
  DefaultWorkspace: 'pion:default-workspace'
} as const

/** main -> renderer 的事件推送频道。 */
export const IPC_EVENTS = {
  AgentEvent: 'pion:agent-event',
  AgentStatus: 'pion:agent-status',
  AgentRunCheckpoint: 'pion:agent-run-checkpoint',
  AgentState: 'pion:agent-state',
  AgentSessions: 'pion:agent-sessions',
  AgentTree: 'pion:agent-tree',
  Projects: 'pion:projects',
  WindowState: 'pion:window-state'
} as const
