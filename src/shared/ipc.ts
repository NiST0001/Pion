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
  AgentSendQueued: 'pion:agent-send-queued',
  AgentRemoveQueued: 'pion:agent-remove-queued',
  AgentMigrateProject: 'pion:agent-migrate-project',
  AgentAbort: 'pion:agent-abort',
  AgentRunCheckpoint: 'pion:agent-run-checkpoint',
  AgentRollbackCheckpoint: 'pion:agent-rollback-checkpoint',
  AgentRunTelemetry: 'pion:agent-run-telemetry',
  AgentRunRecovery: 'pion:agent-run-recovery',
  AgentResumeRun: 'pion:agent-resume-run',
  AgentDiscardRunRecovery: 'pion:agent-discard-run-recovery',
  AgentRestoreRecoveredCheckpoint: 'pion:agent-restore-recovered-checkpoint',
  AgentStderr: 'pion:agent-stderr',

  // verification
  VerificationDiscover: 'pion:verification-discover',
  VerificationRuns: 'pion:verification-runs',
  VerificationStart: 'pion:verification-start',
  VerificationRerun: 'pion:verification-rerun',
  VerificationCancel: 'pion:verification-cancel',
  VerificationPolicyGet: 'pion:verification-policy-get',
  VerificationPolicySet: 'pion:verification-policy-set',

  // bounded multi-agent workflows
  WorkflowList: 'pion:workflow-list',
  WorkflowCreate: 'pion:workflow-create',
  WorkflowStart: 'pion:workflow-start',
  WorkflowApprovePlan: 'pion:workflow-approve-plan',
  WorkflowRepair: 'pion:workflow-repair',
  WorkflowWaiveTests: 'pion:workflow-waive-tests',
  WorkflowResume: 'pion:workflow-resume',
  WorkflowCancel: 'pion:workflow-cancel',
  WorkflowMerge: 'pion:workflow-merge',
  WorkflowCleanup: 'pion:workflow-cleanup',

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
  AgentHistoryIndex: 'pion:agent-history-index',
  AgentTaskHistory: 'pion:agent-task-history',
  AgentRunningSessions: 'pion:agent-running-sessions',
  AgentUnreadSessions: 'pion:agent-unread-sessions',
  AgentEntriesPage: 'pion:agent-entries-page',
  AgentTree: 'pion:agent-tree',
  AgentSessions: 'pion:agent-sessions',

  // commands, modes, model & thinking
  AgentCommands: 'pion:agent-commands',
  AgentSetMode: 'pion:agent-set-mode',
  AgentSetYolo: 'pion:agent-set-yolo',
  AgentSetSubagents: 'pion:agent-set-subagents',
  AgentModels: 'pion:agent-models',
  AgentModelProviders: 'pion:agent-model-providers',
  AgentLoginModelProvider: 'pion:agent-login-model-provider',
  AgentLogoutModelProvider: 'pion:agent-logout-model-provider',
  AgentModelProviderAuthState: 'pion:agent-model-provider-auth-state',
  AgentCancelModelProviderAuth: 'pion:agent-cancel-model-provider-auth',
  AgentOpenModelProviderAuthUrl: 'pion:agent-open-model-provider-auth-url',
  AgentAddModelProvider: 'pion:agent-add-model-provider',
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
  GetWindowEffects: 'pion:get-window-effects',
  SetWindowEffects: 'pion:set-window-effects',
  GetCompletionNotifications: 'pion:get-completion-notifications',
  SetCompletionNotifications: 'pion:set-completion-notifications',
  ToolPermissionPolicyGet: 'pion:tool-permission-policy-get',
  ToolPermissionPolicySet: 'pion:tool-permission-policy-set',
  ToolPermissionPending: 'pion:tool-permission-pending',
  ToolPermissionResolve: 'pion:tool-permission-resolve',
  ExtensionUiPending: 'pion:extension-ui-pending',
  ExtensionUiResolve: 'pion:extension-ui-resolve',

  // plugin store
  PluginsCatalog: 'pion:plugins-catalog',
  PluginsInstalled: 'pion:plugins-installed',
  PluginsInstall: 'pion:plugins-install',
  PluginsUninstall: 'pion:plugins-uninstall',

  // window controls
  WindowControl: 'pion:window-control',
  WindowState: 'pion:window-state',

  // projects & git branches
  ProjectsList: 'pion:projects-list',
  ProjectTrustGet: 'pion:project-trust-get',
  ProjectTrustSet: 'pion:project-trust-set',
  ProjectsAdd: 'pion:projects-add',
  ProjectsRemove: 'pion:projects-remove',
  ProjectsPush: 'pion:projects',
  BranchesList: 'pion:branches-list',
  BranchCreate: 'pion:branch-create',
  BranchRename: 'pion:branch-rename',
  GitStatus: 'pion:git-status',
  GitDiff: 'pion:git-diff',
  GitStagePaths: 'pion:git-stage-paths',
  GitUnstagePaths: 'pion:git-unstage-paths',
  GitDiscardPaths: 'pion:git-discard-paths',
  GitApplySelection: 'pion:git-apply-selection',
  GitCommit: 'pion:git-commit',
  GitConflictRead: 'pion:git-conflict-read',
  GitConflictResolve: 'pion:git-conflict-resolve',
  GitOperationContinue: 'pion:git-operation-continue',
  GitOperationAbort: 'pion:git-operation-abort',

  // project terminals
  TerminalOpen: 'pion:terminal-open',
  TerminalWrite: 'pion:terminal-write',
  TerminalResize: 'pion:terminal-resize',
  TerminalClose: 'pion:terminal-close',

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
  AgentRunTelemetry: 'pion:agent-run-telemetry',
  AgentState: 'pion:agent-state',
  VerificationRuns: 'pion:verification-runs',
  VerificationLog: 'pion:verification-log',
  WorkflowUpdated: 'pion:workflow-updated',
  GitSnapshot: 'pion:git-snapshot',
  AgentSessions: 'pion:agent-sessions',
  AgentRunningSessions: 'pion:agent-running-sessions',
  AgentUnreadSessions: 'pion:agent-unread-sessions',
  AgentTree: 'pion:agent-tree',
  Projects: 'pion:projects',
  ToolPermissionRequests: 'pion:tool-permission-requests',
  ExtensionUiRequests: 'pion:extension-ui-requests',
  ModelProviderAuthState: 'pion:model-provider-auth-state',
  WindowState: 'pion:window-state',
  TerminalData: 'pion:terminal-data',
  WindowEffects: 'pion:window-effects'
} as const
