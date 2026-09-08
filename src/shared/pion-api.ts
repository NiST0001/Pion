/**
 * Typed preload bridge exposed to the renderer. Keeping this surface separate
 * from the data contracts makes the IPC facade easy to audit without moving
 * the existing `shared/types` import path used by the application.
 */
import type {
  AddModelProviderInput,
  AgentCapabilities,
  AgentMode,
  AgentStatus,
  BranchInfo,
  DeleteSessionResult,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ForkMessageOption,
  ImageContent,
  ModelOption,
  ModelProviderAuthState,
  ModelProviderAuthType,
  ModelProviderInfo,
  ProjectMeta,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  SessionEntriesPage,
  SessionHistoryIndex,
  SessionInfo,
  SessionMeta,
  SessionTaskRun,
  SkillInfo,
  SlashCommandInfo,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRules,
  TreeNodeLite,
  WireEventInput,
  WireEntry,
  PluginCatalogItem,
  PluginInstallResult,
  PluginUninstallResult,
  RunCheckpointStatus
} from './types'
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
import type {
  CreateWorkflowRequest,
  WorkflowSnapshot,
  WorkflowUpdate
} from './workflows'

export interface PionApi {
  openTerminal(cwd: string, cols: number, rows: number): Promise<import('./terminal').TerminalSnapshot>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  closeTerminal(id: string): Promise<void>
  onTerminalData(listener: (update: import('./terminal').TerminalUpdate) => void): () => void

  // agent lifecycle ---------------------------------------------------------
  /** Select a working directory; session backends load when selected. */
  startAgent(cwd: string): Promise<void>
  /** Stop all retained agent subprocesses. */
  stopAgent(): Promise<void>
  /** Send directly: prompt when idle or steer when the selected backend is busy. */
  send(message: string, images?: ImageContent[]): Promise<void>
  /** Queue a follow-up message for after the current run. */
  queue(message: string, images?: ImageContent[]): Promise<void>
  /** Promote one visible queued message to immediate delivery. */
  sendQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<void>
  /** Remove a Pion-owned queued message; native Pi queue entries are rejected. */
  removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<void>
  /** Move the active session into another project's bucket; returns the new path. */
  migrateSessionToProject(cwd: string): Promise<string | null>
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
  /** Session paths with a completed/failed run not yet opened in this window. */
  getUnreadSessionPaths(): Promise<string[]>
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
  /** Complete provider directory and non-secret auth status from Pi ModelRuntime. */
  listModelProviders(): Promise<ModelProviderInfo[]>
  loginModelProvider(
    providerId: string,
    authType: ModelProviderAuthType
  ): Promise<ModelProviderInfo[]>
  logoutModelProvider(providerId: string): Promise<ModelProviderInfo[]>
  getModelProviderAuthState(): Promise<ModelProviderAuthState | null>
  cancelModelProviderAuth(): Promise<void>
  openModelProviderAuthUrl(url: string): Promise<void>
  addModelProvider(input: AddModelProviderInput): Promise<ModelOption[]>
  getSkills(): Promise<SkillInfo[]>
  getCapabilities(): Promise<AgentCapabilities>
  getCommands(): Promise<SlashCommandInfo[]>
  getPluginCatalog(): Promise<PluginCatalogItem[]>
  getInstalledPlugins(): Promise<string[]>
  installPlugin(source: string): Promise<PluginInstallResult>
  uninstallPlugin(source: string): Promise<PluginUninstallResult>
  setMode(mode: AgentMode): Promise<void>
  setYoloMode(enabled: boolean): Promise<void>
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
  renameSession(name: string, sessionPath?: string): Promise<void>
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
  renameBranch(cwd: string, oldName: string, newName: string): Promise<BranchInfo>
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
  getWindowEffects(): Promise<import('./window-effects').WindowEffectsState>
  setWindowEffects(enabled: boolean): Promise<import('./window-effects').WindowEffectsState>
  onWindowEffects(listener: (state: import('./window-effects').WindowEffectsState) => void): () => void
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
  /** Sessions whose latest completed run the user has not opened yet. */
  onUnreadSessions(listener: (sessionPaths: string[]) => void): () => void
  /** Subscribe to branch-tree pushes. */
  onTree(listener: (tree: { tree: TreeNodeLite[]; leafId: string | null } | null) => void): () => void
  /** Subscribe to project-list pushes. */
  onProjects(listener: (projects: ProjectMeta[]) => void): () => void
  /** Subscribe to the global queue of tool calls awaiting permission. */
  onToolPermissionRequests(listener: (requests: ToolPermissionRequest[]) => void): () => void
  /** Subscribe to interactive requests emitted by Pi extensions or provider auth. */
  onExtensionUiRequests(listener: (requests: ExtensionUiRequest[]) => void): () => void
  /** Subscribe to non-secret progress from Pi provider login flows. */
  onModelProviderAuthState(listener: (state: ModelProviderAuthState | null) => void): () => void
}
