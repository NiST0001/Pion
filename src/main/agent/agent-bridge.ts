import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import { subagentSettingsFilePath } from '../subagent-settings'
import { questionSettingsFilePath } from '../question-settings'
import { QUESTION_WAIT_WIDGET_KEY, parseQuestionWaitMetadata, type QuestionWaitMetadata } from '../../shared/question-settings'
import { DEFAULT_SUBAGENTS_ENABLED, SUBAGENT_LIMITS } from '../../shared/subagents'
import { IPC_EVENTS } from '../../shared/ipc'
import type { McpStatusSnapshot, McpStatusTarget } from '../../shared/mcp'
import {
  ProjectTrustStore,
  RpcClient,
  SessionManager,
  SettingsManager,
  getAgentDir,
  hasTrustRequiringProjectResources
} from '@earendil-works/pi-coding-agent'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
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
  MessageRevertRequest,
  MessageRevertResult,
  ModelOption,
  ModelProviderAuthState,
  ModelProviderAuthType,
  ModelProviderInfo,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  RunCheckpointStatus,
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
  WireEntry,
  WireMessage
} from '../../shared/types'
import { messageText, messageThinking, messageToolCalls, messageTimestamp } from '../../shared/types'
import {
  deriveSessionTaskRuns,
  taskHistorySnapshotFromEntry,
  taskHistorySnapshotFromResult
} from '../../shared/task-history'
import type { SessionTaskHistoryEvent } from '../../shared/task-history'
import { createWorktreeBranch, listBranchInfos, renameGitBranch } from '../git'
import {
  createGitRunCheckpoint,
  inspectGitRunCheckpoint,
  rollbackGitRunCheckpoint
} from '../checkpoints'
import { pionRuntimePath } from '../pi-runtime'
import type {
  RunOperation,
  RunOperationState,
  RunRecoveryCandidate,
  RunTelemetryQuery,
  RunTelemetryUpdate
} from '../../shared/operations'
import { EMPTY_TOKEN_USAGE, RunStore } from '../run-store'
import {
  RUN_CHECKPOINT_MARKER,
  TOOL_PERMISSION_MARKER,
  TOOL_PERMISSION_TIMEOUT_MS,
  ToolPermissionStore
} from '../tool-permissions'
import { parseToolPermissionMetadata } from './tool-permission-request'
import { ensureNativeTaskExtension } from './task-planning'
import { ensureNativePlanModeExtension } from './plan-mode'
import { BackendPool } from './backend-pool'
import { SessionListCache } from './session-list-cache'
import { readSessionTokenTotal } from './session-token-total'
import { revertSessionMessage } from './message-revert'
import { stopForHistory } from './stop-for-history'
import { prepareWorktreeBranchDeletion } from '../git/branch-delete'
import type { BranchDeleteRequest, BranchDeleteResult } from '../../shared/branches'
import { applyBackendEvent } from './backend-events'
import { LiveSessionProjection } from './live-session-state'
import { SubagentSessionStore } from './subagent-session-store'
import { SUBAGENT_SESSION_WIDGET_KEY, SUBAGENT_SESSION_ADMISSION_TITLE } from '../../shared/subagent-sessions'
import type { SubagentSessionAdmission, SubagentSessionList, SubagentSessionSnapshot } from '../../shared/subagent-sessions'
import {
  cacheMcpStatusWidget,
  isMcpStatusWidget,
  mcpBackendScope,
  projectMcpStatusTarget,
  readCachedMcpStatus,
  unknownMcpStatus,
  waitingMcpStatus
} from './mcp-status-bridge'
import { PendingRequestStore } from './pending-requests'
import { projectQueueSnapshot } from './queue-projection'
import { ProviderAuthUi } from './provider-auth-ui'
import type { SessionModelPreferenceStore } from '../app-settings'
import { ProviderConfigStore } from '../provider-config'
import type { ProviderVisibilityStore } from '../provider-visibility'
import { ProviderAuthService } from '../provider-auth'
import { loadAgentCapabilities } from './capabilities'
import { restoreSessionModelPreference } from './session-preferences'
import {
  filterToolResults,
  sessionBranch,
  sessionMode,
  sessionTasks,
  toTreeNodeLite,
  toWireEntry,
  toolCallIds
} from './wire'

import {
  BUILTIN_SLASH_COMMANDS,
  CHECKPOINT_CHANNEL,
  EVENT_CHANNEL,
  EXTENSION_UI_CHANNEL,
  EXTENSION_UI_TIMEOUT_MS,
  MODEL_PROVIDER_AUTH_CHANNEL,
  RUNNING_SESSIONS_CHANNEL,
  RUN_TELEMETRY_CHANNEL,
  SESSIONS_CHANNEL,
  STATE_CHANNEL,
  STATE_REFRESH_EVENTS,
  STATUS_CHANNEL,
  TOOL_PERMISSION_CHANNEL,
  TREE_CHANNEL,
  UNREAD_SESSIONS_CHANNEL
} from './constants'
import type {
  BackendPhase,
  BackendRecord,
  PendingExtensionUi,
  PendingBackendScope,
  PendingProviderAuthUi,
  PendingToolPermission,
  ProviderAuthOperation,
  PushedTree,
  RunCompletedListener,
  SessionCompletedListener,
  ToolPermissionRequestedListener
} from './types'
import {
  addTokenUsage,
  normalizeTokenUsage,
  pathExists,
  promptPreview
} from './utils'

/**
 * Owns the per-session pi agent RPC subprocesses.
 *
 * pi runs headless (`node dist/cli.js --mode rpc`) and speaks JSON lines on
 * stdin/stdout; `RpcClient` handles the framing. A session backend is loaded
 * when its session is selected and remains alive while another session is
 * selected. A global pool retains at most ten backends across all projects and
 * worktrees; the oldest is evicted before loading an eleventh. Only the active
 * backend's events are forwarded.
 */
export class AgentBridge {
  private readonly backendPool = new BackendPool()
  private subagentSessionStore?: SubagentSessionStore
  private hiddenSubagentBackends?: Set<string>
  private deletedSubagentParentPaths?: Set<string>
  private subagentVisibilityRevision?: number

  private subagentSessions(): SubagentSessionStore {
    return this.subagentSessionStore ??= new SubagentSessionStore(() => this.pushSubagentSessions())
  }

  private visibleSubagentSessions(): SubagentSessionList {
    const list = this.subagentSessionStore?.list() ?? { revision: 0, sessions: [] }
    // Fences need survive only while their retained records do; no unbounded
    // accumulation across completed/expired branches or deleted parents.
    const backendIds = new Set(list.sessions.map((session) => session.backendId))
    const paths = new Set(list.sessions.map((session) => session.parentSessionPath))
    for (const id of this.hiddenSubagentBackends ?? []) if (!backendIds.has(id)) this.hiddenSubagentBackends?.delete(id)
    for (const path of this.deletedSubagentParentPaths ?? []) if (!paths.has(path)) this.deletedSubagentParentPaths?.delete(path)
    return { ...list, revision: list.revision + (this.subagentVisibilityRevision ?? 0),
      sessions: list.sessions.filter((session) => !this.hiddenSubagentBackends?.has(session.backendId)
        && !(session.parentSessionPath && this.deletedSubagentParentPaths?.has(session.parentSessionPath))) }
  }

  private pushSubagentSessions(): void {
    const win = this.win
    if (!win || win.isDestroyed?.() || win.webContents.isDestroyed?.()) return
    win.webContents.send(IPC_EVENTS.SubagentSessions, this.visibleSubagentSessions())
  }

  private assertSubagentOwner(ownerId: number): void {
    const win = this.win
    if (!win || win.webContents.id !== ownerId || win.isDestroyed?.() || win.webContents.isDestroyed?.()) {
      throw new Error('只允许所属主窗口读取子会话')
    }
  }

  getSubagentSessions(ownerId: number): SubagentSessionList {
    this.assertSubagentOwner(ownerId)
    return this.visibleSubagentSessions()
  }

  getSubagentSession(id: string, backendId: string, ownerId: number): SubagentSessionSnapshot | null {
    this.assertSubagentOwner(ownerId)
    const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0
      && value.length <= 256 && !value.includes('\0')
    if (!valid(id) || !valid(backendId)) throw new Error('子会话标识无效')
    // Share the list's expiry and visibility fence before reading details; a
    // retained record must not be readable when its parent branch is hidden.
    if (!this.visibleSubagentSessions().sessions.some((session) => session.id === id && session.backendId === backendId)) return null
    return this.subagentSessionStore?.get(id, backendId) ?? null
  }

  /** Application shutdown only; logical project/session stops retain completed views. */
  disposeSubagentSessions(): void {
    this.subagentSessionStore?.dispose()
    this.subagentSessionStore = undefined
    this.hiddenSubagentBackends?.clear()
    this.deletedSubagentParentPaths?.clear()
  }

  private markSubagentBackendGone(backend: BackendRecord, exitConfirmed: boolean): void {
    const id = backend.liveState?.backendId
    if (id) this.subagentSessionStore?.markBackendGone(id, exitConfirmed)
  }

  private observeSubagentProcessExit(backend: BackendRecord): void {
    // Private adapter reviewed against pinned SDK 1.0.4, like stop-for-history.
    // Missing/changed internals or a null handle do not establish actual exit.
    const client = backend.client
    if (!Object.prototype.hasOwnProperty.call(client, 'process')) return
    const child = (client as unknown as { process: unknown }).process
    if (!child || typeof child !== 'object') return
    const process = child as Partial<Pick<import('node:child_process').ChildProcess, 'exitCode' | 'signalCode' | 'once' | 'removeListener'>>
    if (typeof process.once !== 'function' || typeof process.removeListener !== 'function'
      || (process.exitCode !== null && !Number.isInteger(process.exitCode))
      || (process.signalCode !== null && (typeof process.signalCode !== 'string' || !process.signalCode))) return
    const id = backend.liveState?.backendId
    if (!id) return
    // Capture the incarnation, not pool key/current client: eviction/replacement
    // cannot transfer a late exit observation to a new backend.
    const exited = () => this.subagentSessionStore?.markBackendGone(id, true)
    process.once('exit', exited)
    if (process.exitCode != null || process.signalCode != null) {
      process.removeListener('exit', exited)
      exited()
    }
  }
  private stopping = false
  private readonly backendKeysBySessionPath = new Map<string, string>()
  /** Only failed paths, latched for this bridge's lifetime; pool eviction/stop is not exit proof. */
  private quarantinedSessionPaths?: Set<string>
  private readonly desiredModes = new Map<string, AgentMode>()
  /** Sessions whose latest completed run the user has not opened yet. */
  private readonly unreadSessionPaths = new Set<string>()
  /** Sessions whose tool-permission prompts are auto-approved (yolo mode). */
  private readonly yoloSessions = new Set<string>()
  private readonly sessionManagers = new Map<string, SessionManager>()
  private sessionListCache?: SessionListCache
  private readonly sessionManagerSignatures = new Map<string, string>()
  private readonly sessionCompletedListeners = new Set<SessionCompletedListener>()
  private readonly toolPermissionRequestedListeners = new Set<ToolPermissionRequestedListener>()
  private readonly runCompletedListeners = new Set<RunCompletedListener>()
  private readonly projectTrustStore = new ProjectTrustStore(getAgentDir())
  private readonly toolPermissionStore = new ToolPermissionStore()
  private readonly pendingRequests: PendingRequestStore
  private readonly providerAuthUi: ProviderAuthUi
  private providerMutationInFlight = false
  private providerReloading = false
  private providerAuthOperation: ProviderAuthOperation | null = null
  private newSessionInFlight: Promise<void> | null = null
  private sessionSelectionGeneration = 0
  /** Event generations are backend-local: RPC responses have no run/event correlation ID. */
  private dispatchLifecycles?: WeakMap<BackendRecord, { generation: number; token?: symbol }>
  private steeringMarkers?: WeakMap<BackendRecord, Array<{ token: symbol; message: string }>>
  private questionWaitStages?: WeakMap<BackendRecord, QuestionWaitMetadata & { scope: PendingBackendScope }>
  /** UI deadlines stop waiting, not the underlying RPC; retain its slot until settlement. */
  private sessionInfoQueries?: WeakMap<BackendRecord, Promise<SessionInfo | null>>
  private sessionInfoSnapshots?: WeakMap<BackendRecord, { revision: number; sessionPath?: string; info: SessionInfo }>

  private dispatchLifecycle(backend: BackendRecord): { generation: number; token?: symbol } {
    this.dispatchLifecycles ??= new WeakMap()
    let lifecycle = this.dispatchLifecycles.get(backend)
    if (!lifecycle) {
      lifecycle = { generation: 0 }
      this.dispatchLifecycles.set(backend, lifecycle)
    }
    return lifecycle
  }

  private backendStillOwned(backend: BackendRecord): boolean {
    return !this.stopping && !backend.historyMutation && !backend.historyStopFailed
      && this.backendPool.get(backend.key) === backend
  }

  private capturePendingScope(backend: BackendRecord): PendingBackendScope {
    const lifecycle = this.dispatchLifecycle(backend)
    return { backend, client: backend.client, runId: backend.activeRunId,
      token: lifecycle.token, generation: lifecycle.generation }
  }

  private pendingScopeOwned(scope: PendingBackendScope | undefined, backend: BackendRecord): boolean {
    if (!scope) return false
    const lifecycle = this.dispatchLifecycle(backend)
    return scope.backend === backend && this.backendStillOwned(backend)
      && backend.client === scope.client && backend.activeRunId === scope.runId
      && lifecycle.token === scope.token && lifecycle.generation === scope.generation
  }

  private pauseQueue(backend: BackendRecord, reason: string, runId: string | null | undefined = backend.activeRunId,
    interruptTurn = true): void {
    if (!this.backendStillOwned(backend) || (runId && backend.activeRunId && backend.activeRunId !== runId)) return
    if (interruptTurn) backend.turnInterrupted = true
    backend.queueAutoReady = false
    backend.localQueueBlocked = true
    const previous = backend.queuePause ?? this.runStore.getQueuePause?.(backend)
    backend.queuePause = { paused: true, revision: (previous?.revision ?? 0) + 1,
      reason: previous?.paused && previous.pausedRunId ? previous.reason : reason,
      pausedRunId: previous?.pausedRunId ?? runId ?? undefined }
    this.runStore.setQueuePause?.(backend, backend.queuePause)
    this.pushQueueSnapshot(backend)
  }

  private clearQueuePause(backend: BackendRecord): void {
    backend.queuePause = { paused: false, revision: (backend.queuePause?.revision ?? 0) + 1 }
    backend.localQueueBlocked = false
    this.runStore.setQueuePause?.(backend, backend.queuePause)
    this.pushQueueSnapshot(backend)
  }

  private reserveDispatch(backend: BackendRecord): { owns: () => boolean; ownsReservation: () => boolean } {
    const lifecycle = this.dispatchLifecycle(backend)
    const generation = lifecycle.generation
    const client = backend.client
    // Queuing/steering while a prompt is reserved must not steal that prompt's
    // event-free recovery lease. Competing idle state reads still invalidate it.
    const token = backend.busy && lifecycle.token ? lifecycle.token : Symbol('dispatch lease')
    lifecycle.token = token
    const ownsReservation = (): boolean => this.backendStillOwned(backend)
      && backend.client === client && lifecycle.token === token
    return { ownsReservation, owns: () => ownsReservation() && lifecycle.generation === generation }
  }

  private recoverPromptFailure(
    backend: BackendRecord, lease: { owns: () => boolean }, run: RunOperation | undefined, error: unknown
  ): void {
    if (!lease.owns() || (run && (backend.activeRunId !== run.id
      || this.runStore.get(run.id)?.state !== 'dispatching'))) return
    this.pauseQueue(backend, '消息派发失败，排队已暂停。', run?.id)
    const attempted = run && this.runStore.get(run.id)?.dispatchedAt !== undefined
    // An RPC rejection is not proof that the child stopped or never accepted
    // the input. Keep its reservation until the real lifecycle closes it.
    if (!attempted) {
      backend.activeRunId = undefined
      backend.busy = false
    }
    if (run) this.runStore.update(run.id, (current) => {
      if (current.state !== 'dispatching') return
      current.state = attempted ? 'interrupted' : 'failed'
      if (attempted) current.interruptedAt = Date.now()
      else current.settledAt = Date.now()
      current.error = error instanceof Error ? error.message : String(error)
    })
  }

  private assertDispatchLease(lease: { owns: () => boolean }): void {
    if (!lease.owns()) throw new Error('Agent 运行状态已改变，请重试')
  }

  /** Acceptance is not completion. Only an event-free handled dispatch owns the busy reservation. */
  private async dispatchPrompt(
    backend: BackendRecord, runId: string, message: string, images?: ImageContent[],
    lease = this.reserveDispatch(backend), onInvoke?: () => void
  ): Promise<void> {
    this.assertDispatchLease(lease)
    const lifecycle = this.dispatchLifecycle(backend)
    const generation = lifecycle.generation
    const token = lifecycle.token
    const client = backend.client
    // Never let agent_start adopt an unrelated, still-local queued message.
    backend.pendingRunIds = backend.pendingRunIds.filter((id) => id !== runId)
    backend.activeRunId = runId
    backend.turnInterrupted = false
    backend.queueAutoReady = false
    // Rejections are recovered only by the caller's original lease; an event
    // or replacement may already own the backend by the time this rejects.
    // This is a main-process dispatch-attempt clock, not an SDK receipt.
    // Record it only after the local lease check and immediately before RPC.
    this.runStore.update(runId, (run) => { run.dispatchedAt ??= Date.now() })
    onInvoke?.()
    const disposition = await client.prompt(message, images)
    if (!this.backendStillOwned(backend) || backend.client !== client) return
    this.runStore.update(runId, (run) => {
      run.dispatchedAt ??= Date.now()
      if (disposition === 'handled' && (run.state === 'dispatching' || run.state === 'running')) {
        run.state = 'discarded'
        run.settledAt = Date.now()
        run.stopReason = 'input-handled'
      }
    })
    if (disposition !== 'handled') return
    // A fast settled run is already terminal. An extension may have started
    // independent work before replying handled; detach this input's ledger,
    // but leave that event-owned phase, busy flag and queue gate untouched.
    if (backend.activeRunId !== runId) return
    backend.activeRunId = undefined
    if (lifecycle.token !== token || lifecycle.generation !== generation) return
    this.pauseQueue(backend, '输入被扩展接管，尚无本轮正常完成证据。', runId)
    lifecycle.token = undefined
    backend.busy = false
    backend.localQueueDispatching = false
    this.pushQueueSnapshot(backend)
    this.pushRunningSessionPaths()
    this.dispatchNextLocalFollowUp(backend)
  }

  private async dispatchSteering(
    backend: BackendRecord, message: string, images: ImageContent[], marker: symbol, runId?: string
  ): Promise<void> {
    const client = backend.client
    const disposition = await client.steer(message, images)
    if (disposition !== 'handled' || !this.backendStillOwned(backend) || backend.client !== client) return
    if (runId) {
      backend.companionRunIds = backend.companionRunIds?.filter((id) => id !== runId)
      this.runStore.update(runId, (run) => {
        if (run.state !== 'running' && run.state !== 'dispatching') return
        run.state = 'discarded'
        run.settledAt = Date.now()
        run.stopReason = 'input-handled'
      })
    }
    this.unmarkDirectSteering(backend, message, marker)
  }
  private branchDeletionInFlight = false
  private unconfirmedStoppedWorktreeCwds = new Set<string>()
  private messageRevertInFlight = false
  private sessionMigrationInFlight = false
  private sessionOperationsInFlight = 0
  private historyRevision = 0
  private activeKey: string | null = null
  private activeCwd: string | undefined
  private activeSessionPath: string | undefined
  private win: BrowserWindow | null = null
  private status: AgentStatus = { phase: 'stopped' }
  private readonly pendingTelemetryPushes = new Map<string, RunOperation>()
  private telemetryPushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly runStore: RunStore,
    private readonly sessionModelPreferences?: SessionModelPreferenceStore,
    private readonly providerConfigStore = new ProviderConfigStore(getAgentDir()),
    private readonly providerAuthService = new ProviderAuthService(),
    private readonly providerVisibility?: ProviderVisibilityStore
  ) {
    this.pendingRequests = new PendingRequestStore({
      pushToolPermissionRequests: () => this.pushToolPermissionRequests(),
      pushExtensionUiRequests: () => this.pushExtensionUiRequests()
    })
    this.providerAuthUi = new ProviderAuthUi({
      pendingRequests: this.pendingRequests,
      getCwd: () => this.activeCwd ?? this.status.cwd,
      getOperationId: () => this.providerAuthOperation?.id,
      pushState: () => this.pushModelProviderAuthState()
    })
    this.runStore.onChanged((run) => this.scheduleRunTelemetry(run))
  }

  private getActiveBackend(): BackendRecord | null {
    return this.activeKey ? this.backendPool.get(this.activeKey) ?? null : null
  }

  /** Synchronous service guard; reservations/actual pending slots cover awaited work. */
  assertWorktreeMutationAvailable(): void {
    this.assertHistoryAvailable()
  }

  private assertHistoryAvailable(): void {
    if (this.sessionMigrationInFlight) throw new Error('正在迁移会话，请稍后重试')
    if (this.branchDeletionInFlight) throw new Error('正在删除分支，请稍后重试')
    if (this.messageRevertInFlight) throw new Error('正在撤销消息，请稍后重试')
  }

  private assertSessionNotQuarantined(sessionPath?: string): void {
    if (sessionPath && this.quarantinedSessionPaths?.has(resolve(sessionPath))) {
      throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
    }
  }

  /** IPC reservation covers even the pre-dispatch awaits before backend.busy is set. */
  async withSessionOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertHistoryAvailable()
    this.sessionOperationsInFlight += 1
    try {
      return await operation()
    } finally {
      this.sessionOperationsInFlight -= 1
    }
  }

  /** Compatibility accessor for methods that operate on the selected session. */
  private get client(): RpcClient | null {
    const backend = this.getActiveBackend()
    this.assertSessionNotQuarantined(this.activeSessionPath ?? backend?.sessionPath)
    if (backend?.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
    return backend?.client ?? null
  }

  bind(win: BrowserWindow): void {
    this.win = win
    // bring a late-bound window up to date
    this.win.webContents.send(STATUS_CHANNEL, this.status)
    this.pushRunCheckpoint()
    this.pushToolPermissionRequests()
    this.pushExtensionUiRequests()
    this.pushModelProviderAuthState()
    this.pushRunningSessionPaths()
    this.pushUnreadSessions()
    const activeBackend = this.getActiveBackend()
    if (activeBackend) this.pushQueueSnapshot(activeBackend)
  }

  unbind(win: BrowserWindow): void {
    if (this.win === win) this.win = null
  }

  getStatus(): AgentStatus {
    return this.status
  }

  /** Main-owned cache only: never initialize a backend or ask the SDK for state. */
  getMcpStatus(target: McpStatusTarget = {}, ownerId: number): McpStatusSnapshot {
    const win = this.win
    if (!win || win.webContents.id !== ownerId) throw new Error('只允许所属主窗口读取 MCP 状态')
    const request = projectMcpStatusTarget(target)
    if (!request) return unknownMcpStatus('scope-mismatch')
    const key = this.activeKey
    const cwd = this.activeCwd
    const sessionPath = this.activeSessionPath
    // Capture only the selected record; target fields must not index the pool.
    const backend = key ? this.backendPool.get(key) : undefined
    const client = backend?.client
    const backendId = backend?.liveState?.backendId
    if ((request.cwd !== undefined && request.cwd !== cwd)
      || (request.sessionPath !== undefined && request.sessionPath !== sessionPath)
      || (request.backendId !== undefined && backend && request.backendId !== backendId)) {
      return unknownMcpStatus('scope-mismatch', request)
    }
    const selectedScope: McpStatusTarget = {
      ...(cwd !== undefined ? { cwd } : {}), ...(sessionPath !== undefined ? { sessionPath } : {})
    }
    if (!backend) return unknownMcpStatus(this.stopping || this.providerReloading ? 'backend-stopped' : 'no-backend', selectedScope)
    if (backend.key !== key || backend.cwd !== cwd || backend.sessionPath !== sessionPath
      || this.activeKey !== key || this.activeCwd !== cwd || this.activeSessionPath !== sessionPath
      || this.backendPool.get(backend.key) !== backend || backend.client !== client
      || backend.liveState?.backendId !== backendId || this.win !== win) {
      return unknownMcpStatus('scope-mismatch', request)
    }
    const scope = mcpBackendScope(backend)
    const cache = backend.mcpStatus?.snapshot
    if (this.stopping || this.providerReloading || backend.historyMutation || backend.historyStopFailed
      || (sessionPath && this.quarantinedSessionPaths?.has(sessionPath)) || backend.phase === 'error') {
      return unknownMcpStatus('backend-stopped', scope, cache?.revision, cache?.receivedAt)
    }
    if (backend.phase !== 'running') return waitingMcpStatus(scope, cache?.revision, cache?.receivedAt)
    return readCachedMcpStatus(backend)
  }

  private pushMcpStatus(backend: BackendRecord): void {
    const win = this.win
    if (!win || this.stopping || this.providerReloading || backend.historyMutation || backend.historyStopFailed
      || (backend.sessionPath && this.quarantinedSessionPaths?.has(backend.sessionPath))
      || backend.phase !== 'running' || this.activeKey !== backend.key
      || this.activeCwd !== backend.cwd || this.activeSessionPath !== backend.sessionPath
      || this.backendPool.get(backend.key) !== backend) return
    win.webContents.send(IPC_EVENTS.AgentMcpStatus, this.getMcpStatus(mcpBackendScope(backend), win.webContents.id))
  }

  getRunningSessionPaths(): string[] {
    return [...new Set(
      [...this.backendPool.values()]
        .filter((backend) => (backend.busy || backend.runCompletionPromise) && backend.sessionPath)
        .map((backend) => resolve(backend.sessionPath as string))
    )]
  }

  getUnreadSessionPaths(): string[] {
    return [...this.unreadSessionPaths]
  }

  getRunTelemetry(query: RunTelemetryQuery = {}): RunOperation[] {
    return this.runStore.list(query)
  }

  private scheduleRunTelemetry(run: RunOperation): void {
    this.pendingTelemetryPushes.set(run.id, run)
    if (this.telemetryPushTimer) return
    this.telemetryPushTimer = setTimeout(() => {
      this.telemetryPushTimer = null
      const update: RunTelemetryUpdate = { runs: [...this.pendingTelemetryPushes.values()] }
      this.pendingTelemetryPushes.clear()
      this.win?.webContents.send(RUN_TELEMETRY_CHANNEL, update)
    }, 160)
  }

  private pushRunningSessionPaths(): void {
    this.win?.webContents.send(RUNNING_SESSIONS_CHANNEL, this.getRunningSessionPaths())
  }

  onSessionCompleted(listener: SessionCompletedListener): () => void {
    this.sessionCompletedListeners.add(listener)
    return () => this.sessionCompletedListeners.delete(listener)
  }

  onToolPermissionRequested(listener: ToolPermissionRequestedListener): () => void {
    this.toolPermissionRequestedListeners.add(listener)
    return () => this.toolPermissionRequestedListeners.delete(listener)
  }

  private notifyToolPermissionRequested(request: ToolPermissionRequest): void {
    for (const listener of this.toolPermissionRequestedListeners) {
      try {
        listener(request)
      } catch (error) {
        console.error('[pion] tool permission notification listener failed:', error)
      }
    }
  }

  onRunCompleted(listener: RunCompletedListener): () => void {
    this.runCompletedListeners.add(listener)
    return () => this.runCompletedListeners.delete(listener)
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch }
    this.win?.webContents.send(STATUS_CHANNEL, this.status)
  }

  private pushRunCheckpoint(): void {
    const checkpoint = this.getActiveBackend()?.checkpointStatus ?? null
    this.win?.webContents.send(CHECKPOINT_CHANNEL, checkpoint)
  }

  private pushUnreadSessions(): void {
    this.win?.webContents.send(UNREAD_SESSIONS_CHANNEL, [...this.unreadSessionPaths])
  }

  private pushToolPermissionRequests(): void {
    this.win?.webContents.send(TOOL_PERMISSION_CHANNEL, this.getPendingToolPermissionRequests())
  }

  private pushExtensionUiRequests(): void {
    this.win?.webContents.send(EXTENSION_UI_CHANNEL, this.getPendingExtensionUiRequests())
  }

  private pushModelProviderAuthState(): void {
    this.win?.webContents.send(MODEL_PROVIDER_AUTH_CHANNEL, this.providerAuthUi.getState())
  }

  getModelProviderAuthState(): ModelProviderAuthState | null {
    return this.providerAuthUi.getState()
  }

  private setModelProviderAuthState(state: ModelProviderAuthState | null): void {
    this.providerAuthUi.setState(state)
  }

  async loadToolPermissions(): Promise<void> {
    await Promise.all([this.toolPermissionStore.load(), this.runStore.load()])
    await this.toolPermissionStore.ensureExtension()
  }

  getPendingToolPermissionRequests(): ToolPermissionRequest[] {
    return this.pendingRequests.getToolPermissionRequests()
  }

  getPendingExtensionUiRequests(): ExtensionUiRequest[] {
    return this.pendingRequests.getExtensionUiRequests()
  }

  getToolPermissionPolicy(cwd: string): Promise<ProjectToolPermissionPolicy> {
    return this.toolPermissionStore.getPolicy(cwd)
  }

  setToolPermissionPolicy(
    cwd: string,
    updates: Partial<ToolPermissionRules> | null
  ): Promise<ProjectToolPermissionPolicy> {
    return this.toolPermissionStore.setPolicy(cwd, updates)
  }

  private clearToolPermissionRequest(id: string): PendingToolPermission | null {
    return this.pendingRequests.clearToolPermissionRequest(id)
  }

  private clearBackendToolPermissionRequests(backendKey: string): void {
    this.pendingRequests.clearBackendToolPermissionRequests(backendKey)
  }

  private clearExtensionUiRequest(id: string): PendingExtensionUi | null {
    return this.pendingRequests.clearExtensionUiRequest(id)
  }

  private clearBackendExtensionUiRequests(backendKey: string): void {
    this.pendingRequests.clearBackendExtensionUiRequests(backendKey)
  }

  private clearProviderAuthUiRequest(id: string): PendingProviderAuthUi | null {
    return this.pendingRequests.clearProviderAuthUiRequest(id)
  }

  private clearProviderAuthUiRequests(operationId: string): void {
    this.pendingRequests.clearProviderAuthUiRequests(operationId)
  }

  private respondToExtensionUi(client: RpcClient, id: string, response: ExtensionUiResponse): void {
    // Pi 0.84 documents extension_ui_response but RpcClient does not expose a
    // public sender for it. Write the documented JSONL frame to its child stdin
    // until the SDK provides a first-class method.
    const process = (client as unknown as {
      process: {
        stdin?: {
          destroyed?: boolean
          writable?: boolean
          write(data: string): unknown
        }
      } | null
    }).process
    const stdin = process?.stdin
    if (!stdin || stdin.destroyed || stdin.writable === false) {
      throw new Error('Agent 交互请求已失效')
    }
    stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...response })}\n`)
  }

  async resolveToolPermission(
    requestId: string,
    resolution: ToolPermissionResolution
  ): Promise<ProjectToolPermissionPolicy | null> {
    if (!['allow-once', 'allow-session', 'allow-project', 'deny'].includes(resolution)) {
      throw new Error('无效的工具权限决定')
    }
    const pending = this.pendingRequests.getToolPermission(requestId)
    if (!pending) throw new Error('工具权限请求已结束')
    if (
      (resolution === 'allow-session' || resolution === 'allow-project')
      && !pending.request.canRemember
    ) {
      throw new Error('目录外、敏感路径和高风险操作只能单次允许')
    }

    const backend = this.backendPool.get(pending.backendKey)
    if (!backend || !this.pendingScopeOwned(pending.scope, backend)) {
      this.clearToolPermissionRequest(requestId)
      throw new Error('发起请求的 Agent 会话已关闭')
    }
    let policy: ProjectToolPermissionPolicy | null = null
    let effectiveResolution = resolution
    if (resolution === 'allow-project') {
      policy = await this.toolPermissionStore.allowProjectCategories(
        pending.request.cwd,
        pending.request.policyCategories
      )
      if (pending.request.policyCategories.some((category) => policy?.rules[category] === 'deny')) {
        effectiveResolution = 'deny'
      }
      if (this.pendingRequests.getToolPermission(requestId) !== pending) {
        throw new Error('工具权限请求已结束')
      }
      if (!this.pendingScopeOwned(pending.scope, backend)) {
        this.clearToolPermissionRequest(requestId)
        throw new Error('发起请求的 Agent 会话已关闭')
      }
    }
    // A denial still blocks execution; only a resulting tool error (or timeout)
    // latches the queue. It is not, by itself, an interrupted assistant turn.
    this.respondToExtensionUi(pending.scope!.client, pending.extensionRequestId, { value: effectiveResolution })
    this.clearToolPermissionRequest(requestId)
    return policy
  }

  async resolveExtensionUiRequest(requestId: string, response: ExtensionUiResponse): Promise<void> {
    const extensionPending = this.pendingRequests.getExtensionUi(requestId)
    const providerPending = this.pendingRequests.getProviderAuthUi(requestId)
    const request = extensionPending?.request ?? providerPending?.request
    if (!request) throw new Error('交互请求已结束')
    if (!response || typeof response !== 'object') throw new Error('无效的交互响应')
    const cancelled = 'cancelled' in response && response.cancelled === true
    const hasValue = 'value' in response
      && typeof response.value === 'string'
      && response.value.length <= 256_000
    const valid = cancelled || (request.method === 'confirm'
      ? 'confirmed' in response && typeof response.confirmed === 'boolean'
      : request.method === 'select'
        ? hasValue && Boolean(request.options?.includes(response.value))
        : hasValue)
    if (!valid) throw new Error('无效的交互响应')

    if (providerPending) {
      this.clearProviderAuthUiRequest(requestId)
      providerPending.resolve(response)
      return
    }

    const pending = extensionPending as PendingExtensionUi
    const backend = this.backendPool.get(pending.backendKey)
    if (!backend || !this.pendingScopeOwned(pending.scope, backend)) {
      this.clearExtensionUiRequest(requestId)
      throw new Error('发起请求的 Agent 会话已关闭')
    }
    // Ordinary cancellation/negative answers do not establish or clear a pause.
    // Timeout callbacks latch independently, before sending their cancellation.
    this.respondToExtensionUi(pending.scope!.client, pending.extensionRequestId, response)
    this.clearExtensionUiRequest(requestId)
  }

  private handleToolPermissionExtensionRequest(backend: BackendRecord, event: unknown): boolean {
    if (typeof event !== 'object' || event === null) return false
    const request = event as {
      type?: string
      id?: string
      method?: string
      title?: string
      timeout?: number
    }
    if (
      request.type !== 'extension_ui_request'
      || request.method !== 'select'
      || typeof request.id !== 'string'
      || typeof request.title !== 'string'
    ) return false

    const scope = this.capturePendingScope(backend)
    // Silent checkpoint gate: create the run checkpoint before the first
    // write-capable tool executes, then release the tool immediately.
    if (request.title === RUN_CHECKPOINT_MARKER) {
      void this.ensureRunCheckpoint(backend)
        .catch((error: unknown) => {
          console.error('[pion] lazy checkpoint failed:', error)
        })
        .finally(() => {
          if (this.pendingScopeOwned(scope, backend)) {
            this.respondToExtensionUi(scope.client, request.id as string, { value: 'ready' })
          }
        })
      return true
    }

    if (!request.title.startsWith(TOOL_PERMISSION_MARKER)) return false

    try {
      const parsed = parseToolPermissionMetadata(request.title)
      if (!parsed) throw new Error('权限请求元数据无效')
      const categories = parsed.policyCategories
      const category = parsed.category

      // Yolo mode auto-approves every permission prompt for this session
      // without persisting any project rule or showing UI.
      if (this.yoloSessions.has(backend.key)) {
        this.respondToExtensionUi(backend.client, request.id, { value: 'allow-once' })
        return true
      }
      const id = randomUUID()
      const createdAt = Date.now()
      const timeoutMs = Math.min(
        Math.max(typeof request.timeout === 'number' ? request.timeout : TOOL_PERMISSION_TIMEOUT_MS, 1_000),
        TOOL_PERMISSION_TIMEOUT_MS
      )
      const permissionRequest: ToolPermissionRequest = {
        id,
        cwd: parsed.cwd,
        sessionPath: parsed.sessionPath ?? backend.sessionPath,
        toolName: parsed.toolName,
        category,
        policyCategories: [...new Set(categories)],
        summary: parsed.subagent ? `子代理 · ${parsed.summary}` : parsed.summary,
        ...(parsed.subagent ? { subagent: true } : {}),
        detail: parsed.detail,
        risks: parsed.risks,
        canRemember: parsed.canRemember,
        createdAt,
        timeoutAt: createdAt + timeoutMs
      }
      const timeout = setTimeout(() => {
        if (this.pendingRequests.getToolPermission(id)?.scope === scope && this.pendingScopeOwned(scope, backend)) {
          this.pauseQueue(backend, '工具权限等待超时，本轮需显式继续。', scope.runId)
        }
        this.clearToolPermissionRequest(id)
      }, timeoutMs + 250)
      this.pendingRequests.addToolPermission(id, {
        request: permissionRequest,
        backendKey: backend.key,
        extensionRequestId: request.id,
        scope,
        timeout
      })
      this.notifyToolPermissionRequested(permissionRequest)
      this.pushToolPermissionRequests()
    } catch (error) {
      console.error('[pion] invalid tool permission request:', error)
      this.pauseQueue(backend, '工具权限请求无效，本轮需显式继续。', scope.runId)
      this.respondToExtensionUi(backend.client, request.id, { value: 'deny' })
    }
    return true
  }

  private handleExtensionUiRequest(backend: BackendRecord, event: unknown): boolean {
    if (this.handleToolPermissionExtensionRequest(backend, event)) return true
    if (typeof event !== 'object' || event === null) return false
    const source = event as {
      type?: string
      id?: string
      method?: string
      title?: string
      options?: unknown
      message?: unknown
      placeholder?: unknown
      prefill?: unknown
      timeout?: unknown
    }
    if (source.type !== 'extension_ui_request') return false
    if (!['select', 'confirm', 'input', 'editor'].includes(source.method ?? '')) return false
    if (typeof source.id !== 'string') return true

    const scope = this.capturePendingScope(backend)
    const cancelInvalidRequest = (message: string): true => {
      this.pauseQueue(backend, '提问无法显示，本轮需显式继续。', scope.runId)
      console.error(`[pion] invalid extension UI request: ${message}`)
      try {
        this.respondToExtensionUi(backend.client, source.id as string, { cancelled: true })
      } catch (error) {
        console.error('[pion] failed to cancel invalid extension UI request:', error)
      }
      return true
    }
    if (typeof source.title !== 'string' || !source.title.trim()) {
      return cancelInvalidRequest('missing title')
    }

    const method = source.method as ExtensionUiRequest['method']
    const options = method === 'select' && Array.isArray(source.options)
      ? source.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0).slice(0, 20)
      : undefined
    if (method === 'select' && (!options || options.length === 0)) {
      return cancelInvalidRequest('select request has no options')
    }
    if (method === 'confirm' && typeof source.message !== 'string') {
      return cancelInvalidRequest('confirm request has no message')
    }

    const id = randomUUID()
    const createdAt = Date.now()
    const requestedTimeout = typeof source.timeout === 'number' && Number.isFinite(source.timeout)
      ? source.timeout
      : EXTENSION_UI_TIMEOUT_MS
    const questionStage = this.questionWaitStages?.get(backend)
    const question = questionStage && (method === 'select' || method === 'input')
      && this.pendingScopeOwned(questionStage.scope, backend) ? questionStage : undefined
    if (questionStage) this.questionWaitStages?.delete(backend)
    const timeoutMs = question ? question.timeoutMs
      : Math.min(Math.max(requestedTimeout, 1_000), EXTENSION_UI_TIMEOUT_MS)
    const request: ExtensionUiRequest = {
      id,
      cwd: backend.cwd,
      sessionPath: backend.sessionPath,
      method,
      title: source.title.trim().slice(0, 4_000),
      options,
      message: typeof source.message === 'string' ? source.message.slice(0, 8_000) : undefined,
      placeholder: typeof source.placeholder === 'string' ? source.placeholder.slice(0, 500) : undefined,
      prefill: typeof source.prefill === 'string' ? source.prefill.slice(0, 8_000) : undefined,
      createdAt,
      timeoutAt: timeoutMs === null ? null : createdAt + timeoutMs,
      ...(question ? { question: true } : {})
    }
    const timeout = timeoutMs === null ? undefined : setTimeout(() => {
      const pending = this.pendingRequests.getExtensionUi(id)
      if (!pending) return
      if (!this.pendingScopeOwned(pending.scope, backend)) {
        this.clearExtensionUiRequest(id)
        return
      }
      this.pauseQueue(backend, '提问等待超时，本轮需显式继续。', pending.scope?.runId)
      try {
        this.respondToExtensionUi(pending.scope!.client, pending.extensionRequestId, { cancelled: true })
      } catch (error) {
        console.error('[pion] failed to time out extension UI request:', error)
      }
      this.clearExtensionUiRequest(id)
    }, timeoutMs)
    this.pendingRequests.addExtensionUi(id, {
      request,
      backendKey: backend.key,
      extensionRequestId: source.id,
      scope,
      timeout
    })
    this.pushExtensionUiRequests()
    return true
  }

  async openModelProviderAuthUrl(value: string): Promise<void> {
    await this.providerAuthUi.openUrl(value)
  }

  cancelModelProviderAuth(): void {
    this.providerAuthUi.cancel(this.providerAuthOperation)
  }

  /** Reset checkpoint state at dispatch; the real checkpoint is created lazily
      when the first write-capable tool call fires (gated by the extension). */
  private resetRunCheckpoint(backend: BackendRecord): void {
    backend.checkpoint = undefined
    backend.checkpointStatus = undefined
    backend.checkpointRunId = undefined
    if (this.activeKey === backend.key) this.pushRunCheckpoint()
  }

  /** Create the run checkpoint on first write, at most once per run. */
  private ensureRunCheckpoint(backend: BackendRecord): Promise<void> {
    const runId = backend.activeRunId ?? backend.pendingRunIds.at(-1)
    if (backend.checkpoint && backend.checkpointRunId === runId) return Promise.resolve()
    if (backend.checkpointCreatePromise) return backend.checkpointCreatePromise
    const promise = (async (): Promise<void> => {
      await this.prepareRunCheckpoint(backend)
      backend.checkpointRunId = runId
      if (runId && backend.checkpoint) {
        const checkpoint = { ...backend.checkpoint, state: 'ready' as const }
        this.runStore.update(runId, (run) => {
          run.checkpoint = checkpoint
        })
      }
    })()
    backend.checkpointCreatePromise = promise
    void promise.finally(() => {
      if (backend.checkpointCreatePromise === promise) backend.checkpointCreatePromise = undefined
    })
    return promise
  }

  private async prepareRunCheckpoint(backend: BackendRecord): Promise<void> {
    if (backend.checkpointRefreshPromise) await backend.checkpointRefreshPromise.catch(() => null)
    backend.checkpointRunId = undefined
    try {
      const checkpoint = await createGitRunCheckpoint(backend.cwd)
      backend.checkpoint = checkpoint
      backend.checkpointStatus = {
        id: checkpoint.id,
        cwd: checkpoint.cwd,
        createdAt: checkpoint.createdAt,
        state: 'ready',
        hasChanges: false,
        changedFileCount: 0
      }
    } catch (error) {
      backend.checkpoint = undefined
      backend.checkpointStatus = {
        id: randomUUID(),
        cwd: backend.cwd,
        createdAt: Date.now(),
        state: 'unavailable',
        hasChanges: false,
        changedFileCount: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (this.activeKey === backend.key) this.pushRunCheckpoint()
  }

  private refreshRunCheckpoint(backend: BackendRecord): Promise<RunCheckpointStatus | null> {
    if (backend.checkpointRefreshPromise) return backend.checkpointRefreshPromise
    const promise = (async (): Promise<RunCheckpointStatus | null> => {
      const checkpoint = backend.checkpoint
      const status = backend.checkpointStatus
      if (!checkpoint || !status || status.state !== 'ready') return status ?? null
      try {
        const inspection = await inspectGitRunCheckpoint(checkpoint)
        backend.checkpointStatus = { ...status, ...inspection, error: undefined }
      } catch (error) {
        backend.checkpointStatus = {
          ...status,
          state: 'unavailable',
          hasChanges: false,
          changedFileCount: 0,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      if (this.activeKey === backend.key) this.pushRunCheckpoint()
      return backend.checkpointStatus
    })()
    backend.checkpointRefreshPromise = promise
    void promise.then(
      () => {
        if (backend.checkpointRefreshPromise === promise) backend.checkpointRefreshPromise = undefined
      },
      () => {
        if (backend.checkpointRefreshPromise === promise) backend.checkpointRefreshPromise = undefined
      }
    )
    return promise
  }

  async getRunCheckpoint(): Promise<RunCheckpointStatus | null> {
    const backend = this.getActiveBackend()
    if (!backend) return null
    const state = await backend.client.getState().catch(() => null)
    if (backend.checkpoint && !state?.isStreaming) return this.refreshRunCheckpoint(backend)
    return backend.checkpointStatus ?? null
  }

  async rollbackRunCheckpoint(): Promise<RunCheckpointStatus> {
    const backend = this.getActiveBackend()
    const checkpoint = backend?.checkpoint
    const status = backend?.checkpointStatus
    if (!backend || !checkpoint || !status) throw new Error('当前会话没有可恢复的运行检查点')
    if (status.state !== 'ready') {
      throw new Error(status.error || '当前运行检查点不可用')
    }
    const state = await backend.client.getState()
    if (state.isStreaming) throw new Error('Agent 运行期间不能恢复检查点，请先等待完成或中止运行')

    await rollbackGitRunCheckpoint(checkpoint)
    backend.checkpointStatus = {
      ...status,
      state: 'rolled-back',
      hasChanges: false,
      changedFileCount: 0,
      error: undefined
    }
    if (backend.checkpointRunId) {
      this.runStore.update(backend.checkpointRunId, (run) => {
        if (run.checkpoint) run.checkpoint.state = 'rolled-back'
      })
    }
    this.pushRunCheckpoint()
    return backend.checkpointStatus
  }

  getProjectTrust(cwd: string): ProjectTrustInfo {
    const normalizedCwd = resolve(cwd)
    try {
      const requiresTrust = hasTrustRequiringProjectResources(normalizedCwd)
      if (!requiresTrust) {
        return {
          cwd: normalizedCwd,
          requiresTrust: false,
          decision: 'trusted',
          source: 'not-required'
        }
      }

      const entry = this.projectTrustStore.getEntry(normalizedCwd)
      if (entry) {
        return {
          cwd: normalizedCwd,
          requiresTrust: true,
          decision: entry.decision ? 'trusted' : 'untrusted',
          source: resolve(entry.path) === normalizedCwd ? 'saved' : 'inherited',
          decisionPath: entry.path
        }
      }

      const settings = SettingsManager.create(normalizedCwd, getAgentDir(), {
        projectTrusted: false
      })
      const fallback = settings.getDefaultProjectTrust()
      return {
        cwd: normalizedCwd,
        requiresTrust: true,
        decision: fallback === 'always'
          ? 'trusted'
          : fallback === 'never'
            ? 'untrusted'
            : 'ask',
        source: 'default'
      }
    } catch (error) {
      return {
        cwd: normalizedCwd,
        requiresTrust: true,
        decision: 'ask',
        source: 'default',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async setProjectTrust(cwd: string, decision: boolean | null): Promise<ProjectTrustInfo> {
    if (decision !== true && decision !== false && decision !== null) {
      throw new Error('无效的项目信任设置')
    }
    const normalizedCwd = resolve(cwd)
    const affected = [...this.backendPool.values()]
      .filter((backend) => resolve(backend.cwd) === normalizedCwd)
    for (const backend of affected) {
      const state = await backend.client.getState()
      if (state.isStreaming) throw new Error('项目中仍有 Agent 正在运行，请先等待完成或中止运行')
    }

    const active = this.activeCwd ? resolve(this.activeCwd) === normalizedCwd : false
    const activeSessionPath = active ? this.activeSessionPath : undefined
    const activeBackend = active ? this.getActiveBackend() : null
    const desiredMode = activeBackend ? this.desiredModes.get(activeBackend.key) : undefined

    this.projectTrustStore.set(normalizedCwd, decision)
    for (const backend of affected) await this.stopBackend(backend.key)

    const trust = this.getProjectTrust(normalizedCwd)
    if (active) {
      this.activeCwd = normalizedCwd
      this.activeSessionPath = activeSessionPath
      this.activeKey = activeSessionPath ?? this.newSessionKey(normalizedCwd)
      if (desiredMode) this.desiredModes.set(this.activeKey, desiredMode)
      this.setStatus({ phase: 'ready', error: undefined, cwd: normalizedCwd })
      this.pushRunCheckpoint()
      if (trust.decision !== 'ask') {
        void this.ensureActiveBackend()
          .then(() => this.pushSessionInfo())
          .catch(() => {
            // ensureActiveBackend already publishes the active startup error
          })
      } else {
        void this.pushSessionInfo()
      }
    }
    return trust
  }

  private createRun(
    backend: BackendRecord,
    state: {
      sessionId?: string
      model?: { provider?: string; id?: string; contextWindow?: number }
    } | null,
    message: string,
    images: ImageContent[],
    kind: RunOperation['kind'],
    initialState: Extract<RunOperationState, 'queued' | 'dispatching'>
  ): RunOperation {
    const run = this.runStore.create({
      id: randomUUID(),
      cwd: resolve(backend.cwd),
      sessionPath: backend.sessionPath ? resolve(backend.sessionPath) : undefined,
      sessionId: state?.sessionId,
      usageBackendId: backend.usageBackendId ??= randomUUID(),
      kind,
      state: initialState,
      createdAt: Date.now(),
      provider: state?.model?.provider,
      modelId: state?.model?.id,
      contextWindow: state?.model?.contextWindow,
      prompt: { message, images },
      promptPreview: promptPreview(message),
      // Checkpoints are created lazily at the first write-capable tool call
      // and bound to the run by ensureRunCheckpoint.
      checkpoint: undefined,
      usage: { ...EMPTY_TOKEN_USAGE },
      tools: [],
      compactions: [],
      revision: 0
    })
    if (initialState === 'dispatching') {
      // RpcClient.prompt resolves on acceptance, which may precede
      // agent_start. Reserve the backend during that dispatch gap so
      // a second Enter cannot start a concurrent prompt.
      backend.busy = true
    }
    if (initialState === 'queued') backend.pendingRunIds.push(run.id)
    else backend.activeRunId = run.id
    return run
  }

  /** Reset stale checkpoint state when a queued run is dispatched; the real
      checkpoint is created lazily at the first write-capable tool call. */
  private async prepareQueuedRunForDispatch(backend: BackendRecord, runId: string): Promise<void> {
    const queued = this.runStore.get(runId)
    if (!queued || queued.state !== 'queued' || this.hasRunDispatchEvidence(queued)) {
      throw new Error('该消息已开始派发，不能作为未发送消息重发')
    }
    this.resetRunCheckpoint(backend)
    this.runStore.update(runId, (run) => {
      run.state = 'dispatching'
      run.usageBackendId = backend.usageBackendId ??= randomUUID()
      run.dispatchedAt = undefined
      run.agentStartedAt = undefined
      run.agentEndedAt = undefined
      run.settledAt = undefined
      run.interruptedAt = undefined
      run.stopReason = undefined
      run.error = undefined
      run.checkpoint = undefined
    })
  }

  private updateRunSession(backend: BackendRecord, sessionPath: string, sessionId?: string): void {
    const ids = [
      backend.activeRunId,
      ...backend.pendingRunIds,
      ...(backend.companionRunIds ?? []),
      ...(backend.localFollowUps ?? []).map((item) => item.runId)
    ]
    for (const id of ids) {
      if (!id) continue
      this.runStore.update(id, (run) => {
        run.sessionPath = resolve(sessionPath)
        if (sessionId) run.sessionId = sessionId
      })
    }
  }

  private trackNestedToolUsage(backend: BackendRecord, event: unknown, type: string, parentId: string): void {
    if (this.backendPool.get(backend.key) !== backend) return
    const tool = event as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; result?: { usage?: unknown; isError?: unknown } }
    if (typeof tool.toolCallId !== 'string' || !tool.toolCallId
      || typeof tool.toolName !== 'string') return
    const receipts = backend.nativeToolReceipts
    if (!receipts) return
    if (type === 'tool_execution_start') {
      if (receipts.has(tool.toolCallId) || receipts.size >= 512) return
      const parent = receipts.get(parentId)
      const root = parent && receipts.get(parent.rootId)
      if (!parent || !root || parent.state !== 'running' || root.state !== 'running') return
      const source = this.runStore.get(parent.runId)
      if (!backend.usageBackendId || parent.backendId !== backend.usageBackendId
        || root.backendId !== backend.usageBackendId || source?.usageBackendId !== backend.usageBackendId) return
      receipts.set(tool.toolCallId, { runId: parent.runId, backendId: parent.backendId, parentId,
        rootId: parent.rootId, name: tool.toolName, state: 'running', usageConsumed: false })
      return
    }
    if (type !== 'tool_execution_end') return
    const receipt = receipts.get(tool.toolCallId)
    if (!receipt || receipt.parentId !== parentId || receipt.name !== tool.toolName
      || receipt.state === 'ended' || receipt.usageConsumed) return
    receipt.state = 'ended'
    receipt.usageConsumed = true
    const source = this.runStore.get(receipt.runId)
    if (!backend.usageBackendId || receipt.backendId !== backend.usageBackendId
      || source?.usageBackendId !== backend.usageBackendId) return
    if (backend.activeRunId === receipt.runId && (tool.isError === true || tool.result?.isError === true)) {
      this.pauseQueue(backend, '嵌套工具执行未成功，本轮需显式继续。', receipt.runId)
    }
    // SDK 1.0.4 codemode only aggregates models.* usage, not executeTool's
    // child sessions. Only known independent child/codemode usage is charged.
    // This finite run window is neither context occupancy nor a full bill.
    if (receipt.name !== 'pion_subagents' && receipt.name !== 'codemode') return
    const usage = normalizeTokenUsage(tool.result?.usage)
    if (usage) this.runStore.update(receipt.runId, (run) => {
      if (run.usageBackendId === backend.usageBackendId) run.usage = addTokenUsage(run.usage, usage)
    })
  }

  private trackBackendEvent(backend: BackendRecord, event: unknown, type: string | undefined): void {
    if (!type) return
    const parentToolCallId = (event as { parentToolCallId?: unknown }).parentToolCallId
    if (typeof parentToolCallId === 'string' && parentToolCallId.length > 0) {
      this.trackNestedToolUsage(backend, event, type, parentToolCallId)
      return
    }
    if (type === 'entry_appended') {
      this.runStore.recordUsageEntry({ cwd: backend.cwd, sessionPath: backend.sessionPath, backendId: backend.usageBackendId }, event)
      return
    }
    if (type === 'agent_start') {
      // Local queued messages are not dispatched by Pi. dispatchPrompt reserves
      // the precise ledger ID before writing the RPC command.
      if (!backend.activeRunId) return
      this.runStore.update(backend.activeRunId, (run) => {
        run.state = 'running'
        run.agentStartedAt ??= Date.now()
        run.interruptedAt = undefined
        run.error = undefined
      })
      return
    }

    // Manual compaction can happen after the run has settled. Invalidate the
    // displayed session's latest usage, never another project's latest run.
    // A root final belongs only to its captured start, even after settlement.
    // Timing rows are a prunable display window, not proof of once-only billing.
    const finalTool = type === 'tool_execution_end'
      ? event as { toolCallId?: unknown; toolName?: unknown }
      : undefined
    const finalReceipt = typeof finalTool?.toolCallId === 'string'
      ? backend.nativeToolReceipts?.get(finalTool.toolCallId)
      : undefined
    if (finalTool && (this.backendPool.get(backend.key) !== backend || !finalReceipt
      || finalReceipt.parentId || finalReceipt.name !== finalTool.toolName
      || finalReceipt.state !== 'running' || finalReceipt.usageConsumed
      || finalReceipt.backendId !== backend.usageBackendId)) return
    const runId = finalTool ? finalReceipt?.runId : backend.activeRunId ?? (type === 'compaction_end' && backend.sessionPath
      ? this.runStore.list({ sessionPath: backend.sessionPath, cwd: backend.cwd, limit: 1 })[0]?.id
      : undefined)
    if (!runId) return
    const now = Date.now()

    if (type === 'message_update') {
      const usage = normalizeTokenUsage((event as { usage?: unknown }).usage)
      if (!usage) return
      this.runStore.update(runId, (run) => {
        run.liveUsage = usage
        const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
        if (contextTokens <= 0) return
        run.contextUsagePending = false
        run.contextTokens = contextTokens
        run.contextPressure = run.contextWindow && run.contextWindow > 0
          ? contextTokens / run.contextWindow
          : undefined
      })
      return
    }

    if (type === 'message_end') {
      const message = (event as { message?: Record<string, unknown> }).message
      if (message?.role !== 'assistant') return
      const usage = normalizeTokenUsage(message.usage)
      if (!usage) return
      this.runStore.update(runId, (run) => {
        run.usage = addTokenUsage(run.usage, usage)
        run.liveUsage = undefined
        const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
        if (contextTokens <= 0) return
        run.contextUsagePending = false
        run.contextTokens = contextTokens
        run.contextPressure = run.contextWindow && run.contextWindow > 0
          ? contextTokens / run.contextWindow
          : undefined
      })
      return
    }

    if (type === 'tool_execution_start') {
      const tool = event as { toolCallId?: unknown; toolName?: unknown }
      if (typeof tool.toolCallId !== 'string' || !tool.toolCallId || typeof tool.toolName !== 'string'
        || this.backendPool.get(backend.key) !== backend) return
      // Retain completed receipts too: replay/late input cannot attach a known
      // call to a newer run. Saturation fails closed rather than evicting receipts.
      const receipts = backend.nativeToolReceipts ??= new Map()
      const previous = receipts.get(tool.toolCallId)
      if (previous && (previous.runId !== runId || previous.backendId !== backend.usageBackendId
        || previous.name !== tool.toolName || previous.parentId || previous.state === 'ended')) return
      this.runStore.update(runId, (run) => {
        if (tool.toolCallId && !receipts.has(tool.toolCallId as string) && receipts.size < 512
          && backend.usageBackendId && run.usageBackendId === backend.usageBackendId) {
          receipts.set(tool.toolCallId as string, { runId, backendId: backend.usageBackendId, rootId: tool.toolCallId as string,
            name: tool.toolName as string, state: 'running', usageConsumed: false })
        }
        const existing = run.tools.find((candidate) => candidate.toolCallId === tool.toolCallId)
        if (existing) {
          existing.name = tool.toolName as string
          existing.state = 'running'
          existing.startedAt = now
          existing.endedAt = undefined
          existing.durationMs = undefined
          return
        }
        run.tools.push({
          toolCallId: tool.toolCallId as string,
          name: tool.toolName as string,
          state: 'running',
          startedAt: now
        })
        if (run.tools.length > 80) run.tools.splice(0, run.tools.length - 80)
      })
      return
    }

    if (type === 'tool_execution_end') {
      const tool = event as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; result?: { usage?: unknown } }
      if (typeof tool.toolCallId !== 'string') return
      // Missing/pruned source runs must never be reconstructed or reassigned.
      if (!finalReceipt) return
      finalReceipt.state = 'ended'
      finalReceipt.usageConsumed = true
      if (backend.activeRunId === runId && this.runStore.get(runId)?.usageBackendId === finalReceipt.backendId
        && (tool.isError === true || (tool.result as { isError?: unknown } | undefined)?.isError === true)) {
        this.pauseQueue(backend, '工具执行未成功，本轮需显式继续。', runId)
      }
      if (!backend.usageBackendId
        || this.runStore.get(runId)?.usageBackendId !== finalReceipt.backendId) return
      this.runStore.update(runId, (run) => {
        if (run.usageBackendId !== finalReceipt.backendId) return
        let timing = run.tools.find((candidate) => candidate.toolCallId === tool.toolCallId)
        if (!timing) {
          timing = {
            toolCallId: tool.toolCallId as string,
            name: typeof tool.toolName === 'string' ? tool.toolName : 'unknown',
            state: 'running',
            startedAt: now
          }
          run.tools.push(timing)
          if (run.tools.length > 80) run.tools.splice(0, run.tools.length - 80)
        }
        // Codemode's SDK final usage aggregates its models.* calls; subagents
        // reports child usage. Charged failures count too, not progress/nested rows.
        // This finite run window is not the complete SDK session usage ledger.
        if (tool.toolName === 'pion_subagents' || tool.toolName === 'codemode') {
          const usage = normalizeTokenUsage(tool.result?.usage)
          if (usage) run.usage = addTokenUsage(run.usage, usage)
        }
        timing.state = tool.isError ? 'failed' : 'completed'
        timing.isError = Boolean(tool.isError)
        timing.endedAt = now
        timing.durationMs = Math.max(0, now - timing.startedAt)
      })
      return
    }

    if (type === 'compaction_end') {
      const compaction = event as {
        reason?: unknown
        aborted?: unknown
        willRetry?: unknown
        errorMessage?: unknown
      }
      this.runStore.update(runId, (run) => {
        const error = typeof compaction.errorMessage === 'string' ? compaction.errorMessage : undefined
        if (!compaction.aborted && !error) {
          // RPC supplies no post-compaction token count. Do not reuse the
          // pre-compaction request usage or present an invented 0% value.
          run.contextTokens = undefined
          run.contextPressure = undefined
          run.contextUsagePending = true
          run.liveUsage = undefined
        }
        run.compactions.push({
          id: randomUUID(),
          reason: typeof compaction.reason === 'string' ? compaction.reason : 'unknown',
          state: compaction.aborted ? 'aborted' : error ? 'failed' : 'completed',
          endedAt: now,
          willRetry: Boolean(compaction.willRetry),
          error
        })
        if (compaction.reason !== 'manual' && (compaction.aborted || error)) {
          run.error = error ?? '自动上下文压缩已中止，运行未继续。'
        }
      })
      return
    }

    if (type === 'agent_end') {
      const end = event as { messages?: Array<Record<string, unknown>>; willRetry?: boolean }
      if (end.willRetry) return
      const assistant = [...(end.messages ?? [])].reverse().find((message) => message.role === 'assistant')
      const stopReason = typeof assistant?.stopReason === 'string' ? assistant.stopReason : undefined
      this.runStore.update(runId, (run) => {
        run.state = 'ending'
        run.agentEndedAt = now
        run.stopReason = stopReason
        if (typeof assistant?.errorMessage === 'string') run.error = assistant.errorMessage
      })
      return
    }

    if (type === 'agent_settled') {
      const terminal = backend.completionState ?? 'interrupted'
      const completed = this.runStore.update(runId, (run) => {
        run.state = terminal
        if (terminal === 'interrupted') run.interruptedAt = now
        run.settledAt = now
        run.liveUsage = undefined
        run.tools = run.tools.map((tool) => tool.state === 'running'
          ? { ...tool, state: 'interrupted', endedAt: now, durationMs: Math.max(0, now - tool.startedAt) }
          : tool)
      })
      backend.activeRunId = undefined
      if (terminal === 'completed' && completed) {
        const refreshPromise = this.refreshRunCheckpoint(backend)
        const previousCompletion = backend.runCompletionPromise
        const ownCompletion = refreshPromise.then(
          () => undefined,
          (error) => {
            console.error('[pion] run checkpoint refresh failed:', error)
            this.pauseQueue(backend, '运行检查点收尾失败，排队已暂停。', completed.id)
          }
        ).then(async () => {
          for (const listener of this.runCompletedListeners) {
            try {
              await listener(completed)
            } catch (error) {
              console.error('[pion] run completion listener failed:', error)
              this.pauseQueue(backend, '运行完成处理失败，排队已暂停。', completed.id)
            }
          }
        })
        const completionPromise = previousCompletion
          ? Promise.allSettled([previousCompletion, ownCompletion]).then(() => undefined)
          : ownCompletion
        backend.runCompletionPromise = completionPromise
        this.pushRunningSessionPaths()
      }
    }
  }

  private queuedPromptWasPersisted(run: RunOperation): boolean {
    if (!run.sessionPath || run.prompt.message.trim() === '') return false
    try {
      const manager = this.openSessionManager(run.sessionPath)
      return manager.getEntries().some((entry) => {
        if (entry.type !== 'message' || entry.message.role !== 'user') return false
        const timestamp = Date.parse(entry.timestamp)
        return messageText(entry.message as unknown as WireMessage) === run.prompt.message
          && (!Number.isFinite(timestamp) || timestamp >= run.createdAt - 2_000)
      })
    } catch {
      return false
    }
  }

  async getRunRecoveryCandidates(query: RunTelemetryQuery = {}): Promise<RunRecoveryCandidate[]> {
    const runs = this.runStore.list({ ...query, limit: Math.max(query.limit ?? 50, 50) })
    const candidates: RunRecoveryCandidate[] = []
    for (let run of runs) {
      if (run.state === 'queued' && this.queuedPromptWasPersisted(run)) {
        run = this.runStore.update(run.id, (current) => {
          current.state = 'interrupted'
          current.interruptedAt = Date.now()
          current.error = '排队消息已出现在会话记录中；为避免重复执行，只能作为安全续接运行继续。'
        }) ?? run
      }
      // Queued runs restore into the live queue on session activation; they
      // are not recovery candidates.
      const paused = this.runStore.getQueuePause?.(run)
      if (run.state !== 'interrupted' && !(paused?.paused && paused.pausedRunId === run.id
        && (run.state === 'failed' || run.state === 'aborted'))) continue
      candidates.push({
        run,
        reason: 'interrupted-run',
        canResume: true,
        canRestoreCheckpoint: run.checkpoint?.state === 'ready',
        note: '上一轮可能已执行部分工具。续接会先要求 Agent 检查当前工作区，且不会重放旧工具调用。'
      })
    }
    return candidates
  }

  async discardRunRecovery(runId: string): Promise<RunOperation> {
    const run = this.runStore.get(runId)
    if (!run || (run.state !== 'interrupted' && !(run.state === 'queued' && run.interruptedAt !== undefined))) {
      throw new Error('这条运行记录已不再等待恢复')
    }
    const updated = this.runStore.update(runId, (current) => {
      current.state = 'discarded'
      current.settledAt ??= Date.now()
      current.stopReason = 'recovery-discarded'
    })
    if (!updated) throw new Error('运行记录不存在')
    for (const backend of this.backendPool.values()) {
      backend.pendingRunIds = backend.pendingRunIds.filter((id) => id !== runId)
      backend.localFollowUps = backend.localFollowUps?.filter((item) => item.runId !== runId)
      backend.companionRunIds = backend.companionRunIds?.filter((id) => id !== runId)
      if (backend.activeRunId === runId) backend.activeRunId = undefined
      this.pushQueueSnapshot(backend)
    }
    return updated
  }

  async resumeRun(runId: string): Promise<RunOperation> {
    let source = this.runStore.get(runId)
    const pausedSource = source ? this.runStore.getQueuePause?.(source) : undefined
    if (!source || (source.state !== 'interrupted' && !(source.state === 'queued' && source.interruptedAt !== undefined)
      && !(pausedSource?.paused && pausedSource.pausedRunId === source.id
        && (source.state === 'failed' || source.state === 'aborted')))) {
      throw new Error('这条运行记录已不再等待恢复')
    }
    if (source.state === 'queued' && this.queuedPromptWasPersisted(source)) {
      source = this.runStore.update(runId, (current) => {
        current.state = 'interrupted'
        current.interruptedAt = Date.now()
      }) ?? source
    }

    if (source.sessionPath) {
      const target = resolve(source.sessionPath)
      if (this.activeSessionPath !== target) {
        const result = await this.switchSession(target)
        if (result.cancelled) throw new Error('无法切换到待恢复的会话')
      }
    } else if (resolve(this.activeCwd ?? '') !== resolve(source.cwd)) {
      await this.start(source.cwd)
    }

    const backend = await this.ensureActiveBackend()
    if (resolve(backend.cwd) !== resolve(source.cwd)) throw new Error('待恢复运行不属于当前工作区')
    const lease = this.reserveDispatch(backend)
    const state = await backend.client.getState()
    this.assertDispatchLease(lease)
    this.assertHistoryAvailable()
    if (state.isStreaming || state.isCompacting || backend.busy || backend.compacting) {
      throw new Error('当前会话仍在运行，请完成或中止后再恢复')
    }

    backend.busy = true
    let run: RunOperation | undefined
    try {
      this.resetRunCheckpoint(backend)
      await this.applyDesiredMode(backend, lease)
      this.assertDispatchLease(lease)
      const interrupted = source.state !== 'queued'
      const message = interrupted
        ? [
            '请安全地续接一轮被中断的任务。',
            `原始任务：${source.prompt.message || '（仅包含图像附件）'}`,
            '上一轮可能已经修改文件或执行工具。请先检查会话记录、git status 和当前文件，不要重复不可逆或外部副作用操作；然后从尚未完成的部分继续，并在结束前验证结果。'
          ].join('\n\n')
        : source.prompt.message
      run = this.createRun(
        backend,
        state,
        message,
        source.prompt.images,
        'recovery',
        'dispatching'
      )
      this.runStore.update(run.id, (current) => {
        current.recoveredFromRunId = source.id
      })
      const client = backend.client
      if (backend.queuePause?.paused && (!backend.queuePause.pausedRunId || backend.queuePause.pausedRunId === source.id)) {
        // Transfer the actual continuation identity, never unlock on RPC acceptance.
        backend.queuePause = { ...backend.queuePause, revision: backend.queuePause.revision + 1, pausedRunId: run.id }
        this.runStore.setQueuePause?.(backend, backend.queuePause)
        this.pushQueueSnapshot(backend)
      }
      await this.dispatchPrompt(backend, run.id, message, source.prompt.images, lease)
      let accepted = this.runStore.get(run.id)
      if (accepted?.state === 'completed' && accepted.stopReason === 'input-handled'
        && backend.queuePause?.paused && backend.queuePause.pausedRunId === accepted.id) {
        accepted = this.runStore.update(accepted.id, (current) => {
          current.state = 'interrupted'
          current.interruptedAt = Date.now()
        })
      }
      if (!this.backendStillOwned(backend) || backend.client !== client || !accepted
        || accepted.state === 'discarded' || accepted.state === 'failed' || accepted.state === 'aborted'
        || accepted.state === 'interrupted') throw new Error('续接未被当前 Agent 接受，排队仍暂停')
      this.runStore.update(source.id, (current) => {
        current.state = 'discarded'
        current.settledAt ??= Date.now()
        current.stopReason = 'resumed-as-new-run'
      })
      await this.syncBackendSession(backend)
      return this.runStore.get(run.id) ?? run
    } catch (error) {
      this.recoverPromptFailure(backend, lease, run, error)
      throw error
    }
  }

  async restoreRecoveredCheckpoint(runId: string): Promise<RunCheckpointStatus> {
    const run = this.runStore.get(runId)
    const checkpoint = run?.checkpoint
    if (!run || !checkpoint || checkpoint.state !== 'ready') {
      throw new Error('这条运行没有可恢复的持久化检查点')
    }
    const busy = [...this.backendPool.values()].some((backend) => (
      resolve(backend.cwd) === resolve(checkpoint.cwd) && backend.busy
    ))
    if (busy) throw new Error('项目中仍有 Agent 正在运行，请先等待完成或中止运行')
    try {
      await rollbackGitRunCheckpoint(checkpoint)
      this.runStore.update(runId, (current) => {
        if (current.checkpoint) current.checkpoint.state = 'rolled-back'
      })
      return {
        id: checkpoint.id,
        cwd: checkpoint.cwd,
        createdAt: checkpoint.createdAt,
        state: 'rolled-back',
        hasChanges: false,
        changedFileCount: 0
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runStore.update(runId, (current) => {
        if (current.checkpoint) {
          current.checkpoint.state = 'unavailable'
          current.checkpoint.error = message
        }
      })
      throw error
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Select a workspace; an individual session backend loads when selected. */
  async start(cwd: string): Promise<void> {
    this.assertHistoryAvailable()
    this.stopping = false
    this.sessionSelectionGeneration += 1
    const normalizedCwd = resolve(cwd)
    if (this.activeCwd === normalizedCwd && this.activeKey) {
      this.setActiveBackendStatus()
      await this.pushSessionInfo()
      return
    }
    this.activeCwd = normalizedCwd
    this.activeSessionPath = undefined
    this.activeKey = this.newSessionKey(normalizedCwd)
    this.setStatus({ phase: 'ready', error: undefined, cwd: normalizedCwd })
    this.pushRunCheckpoint()
    void this.pushSessionInfo()
  }

  /** pi derives the session bucket from the cwd the same way; keep in sync. */
  private sessionDirFor(cwd: string): string {
    const safePath = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    return join(getAgentDir(), 'sessions', safePath)
  }

  /**
   * Migrate the active session to another project: move the session file into
   * the target project's bucket, rewrite its header cwd, then activate it.
   * Unsaved sessions have no file to move and just switch the project.
   */
  async migrateSessionToProject(targetCwd: string): Promise<string | null> {
    this.assertHistoryAvailable()
    if (this.backendPool.pendingStartCount > 0 || this.sessionOperationsInFlight > 1
      || this.providerMutationInFlight || this.newSessionInFlight) {
      throw new Error('会话仍在初始化或处理操作，请稍后迁移')
    }
    const target = resolve(targetCwd)
    const fromCwd = this.activeCwd
    const backend = this.getActiveBackend()
    this.assertSessionNotQuarantined(this.activeSessionPath ?? backend?.sessionPath)
    if (backend?.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
    if (!fromCwd || resolve(fromCwd) === target) return this.activeSessionPath ?? null
    const generation = this.sessionSelectionGeneration
    const key = this.activeKey
    const client = backend?.client
    const originalPath = this.activeSessionPath ?? backend?.sessionPath
    const assertOwner = () => {
      if (this.stopping || generation !== this.sessionSelectionGeneration || key !== this.activeKey
        || this.activeCwd !== fromCwd || (backend && backend.client !== client)) {
        throw new Error('会话已切换，未继续迁移')
      }
    }
    this.sessionMigrationInFlight = true
    let holdsGate = true
    let migrationSourcePath = originalPath
    let stopped = false
    let stopAttempted = false
    let published: string | undefined
    let staged: string | undefined
    let sourceRemoved = false
    try {
      const state = backend ? (await backend.startPromise, await backend.client.getState()) : null
      assertOwner()
      if (backend && (state?.isStreaming || state?.isCompacting || state?.pendingMessageCount
        || backend.busy || backend.compacting || backend.localQueueDispatching
        || (backend.localFollowUps?.length ?? 0) > 0 || backend.runCompletionPromise
        || this.dispatchLifecycle(backend).token || backend.historyMutation)) {
        throw new Error('当前会话正在运行，请等待完成或中止后再迁移项目')
      }
      const sessionPath = originalPath ?? state?.sessionFile
      migrationSourcePath = sessionPath
      let content: string | undefined
      if (sessionPath) {
        this.assertSessionNotQuarantined(sessionPath)
        try { content = await readFile(sessionPath, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !state || state.messageCount !== 0
            || state.pendingMessageCount !== 0) throw error
        }
        assertOwner()
      } else if (state && state.messageCount !== 0) {
        throw new Error('会话尚未保存，不能丢弃已有消息进行迁移')
      }
      if (content === undefined) {
        // SDK allocates sessionFile before an empty session has a disk file.
        // Explicit migration must prepare the target, unlike lazy workspace selection.
        this.sessionMigrationInFlight = false
        holdsGate = false
        await this.start(target)
        if (this.activeCwd !== target || this.sessionSelectionGeneration !== generation + 1) {
          throw new Error('会话已切换，未启动迁移目标')
        }
        const targetGeneration = this.sessionSelectionGeneration
        const targetKey = this.activeKey
        const targetBackend = await this.ensureActiveBackend()
        const assertTarget = () => {
          if (targetGeneration !== this.sessionSelectionGeneration || targetKey !== this.activeKey
            || this.activeCwd !== target || this.getActiveBackend() !== targetBackend) {
            throw new Error('会话已切换，未更新迁移目标')
          }
        }
        assertTarget()
        if (state?.model) {
          await targetBackend.client.setModel(state.model.provider, state.model.id)
          assertTarget()
        }
        await this.syncBackendSession(targetBackend)
        assertTarget()
        await this.pushSessionInfo()
        return null
      }
      const source = resolve(sessionPath!)
      const targetDir = this.sessionDirFor(target)
      const targetPath = join(targetDir, basename(source))
      if (targetPath === source) throw new Error('项目会话目录编码冲突，未迁移')
      this.assertSessionNotQuarantined(targetPath)
      if ([...this.backendPool.values()].some((other) => other !== backend
        && other.sessionPath && [source, targetPath].includes(resolve(other.sessionPath)))) {
        throw new Error('会话路径仍由其他后端占用，未迁移')
      }
      if (await pathExists(targetPath)) throw new Error('目标已存在同名会话，未覆盖')
      assertOwner()
      if (backend) {
        backend.historyMutation = true
        backend.busy = true
        stopAttempted = true
        this.markSubagentBackendGone(backend, false)
        await stopForHistory(backend.client)
        stopped = true
        assertOwner()
        this.clearBackendToolPermissionRequests(backend.key)
        this.clearBackendExtensionUiRequests(backend.key)
        this.backendPool.delete(backend.key)
        this.backendKeysBySessionPath.delete(source)
        // Read the final history only after the old writer's real exit.
        content = await readFile(source, 'utf8')
        assertOwner()
      }
      const lines = content.split('\n')
      const header = JSON.parse(lines[0]) as { type?: string; cwd?: string }
      if (header.type !== 'session' || !header.cwd || resolve(header.cwd) !== resolve(fromCwd)) {
        throw new Error('会话归属已变化，未迁移')
      }
      header.cwd = target
      lines[0] = JSON.stringify(header)
      await mkdir(targetDir, { recursive: true })
      assertOwner()
      staged = join(targetDir, `.${basename(source)}.${randomUUID()}.tmp`)
      await writeFile(staged, lines.join('\n'), { encoding: 'utf8', flag: 'wx' })
      assertOwner()
      await link(staged, targetPath) // Atomic no-replace publication; never overwrite a target.
      published = targetPath
      await unlink(staged)
      staged = undefined
      assertOwner()
      const preference = this.sessionModelPreferences?.getSessionModel(source)
      if (preference) await this.sessionModelPreferences!.setSessionModel(targetPath, preference)
      assertOwner()
      await unlink(source)
      sourceRemoved = true
      this.sessionListCache?.invalidate(fromCwd)
      this.sessionListCache?.invalidate(target)
      for (const path of [source, targetPath]) {
        this.sessionManagers.delete(path)
        this.sessionManagerSignatures.delete(path)
      }
      assertOwner()
      this.sessionMigrationInFlight = false
      holdsGate = false
      const activated = await this.switchSession(targetPath)
      if (activated.cancelled) throw new Error('迁移后选择已变化')
      await this.refreshSidebarSessions()
      return targetPath
    } catch (error) {
      if (backend && stopAttempted && !stopped) {
        backend.historyStopFailed = true
        backend.phase = 'error'
        this.quarantinedSessionPaths ??= new Set<string>()
        const path = migrationSourcePath ?? backend.sessionPath
        if (path) this.quarantinedSessionPaths.add(resolve(path))
        throw new Error('无法确认旧 Agent 已退出，未迁移；请重启 Pion 后再试。')
      }
      if (stopped && generation === this.sessionSelectionGeneration && key === this.activeKey) {
        this.setStatus({ phase: 'error', cwd: fromCwd, error: '迁移未完成，原 Agent 已退出；请重新选择可用会话。' })
      }
      if (published) throw new Error(`会话已保存到 ${published}；${sourceRemoved ? '源文件已移除' : '源文件仍保留'}${staged ? `，临时文件：${staged}` : ''}，迁移后续步骤未完成：${String(error)}`)
      if (staged) throw new Error(`迁移未发布目标，源文件仍保留；临时文件可能保留在 ${staged}：${String(error)}`)
      throw error
    } finally {
      if (holdsGate) this.sessionMigrationInFlight = false
      if (backend && stopAttempted) {
        backend.historyMutation = false
        backend.busy = false
      }
    }
  }

  private newSessionKey(cwd: string): string {
    return `new:${resolve(cwd)}:${randomUUID()}`
  }

  private async backendArgs(cwd: string, sessionPath?: string): Promise<string[]> {
    const [nativePlanModeExtensionPath, nativeTaskExtensionPath, permissionExtensionPath] = await Promise.all([
      ensureNativePlanModeExtension(),
      ensureNativeTaskExtension(),
      this.toolPermissionStore.ensureExtension()
    ])
    const trust = this.getProjectTrust(cwd)
    if (trust.decision === 'ask') {
      throw new Error('此项目包含本地 Pi 配置或扩展，请先选择是否信任项目')
    }
    return [
      trust.decision === 'trusted' ? '--approve' : '--no-approve',
      '--extension', nativePlanModeExtensionPath,
      '--extension', nativeTaskExtensionPath,
      '--extension', permissionExtensionPath,
      ...(sessionPath ? ['--session', sessionPath] : [])
    ]
  }

  private setActiveBackendStatus(): void {
    const backend = this.getActiveBackend()
    if (!backend) {
      this.setStatus({ phase: 'ready', error: undefined, cwd: this.activeCwd })
      return
    }
    this.setStatus({
      phase: backend.phase,
      error: backend.phase === 'error' ? this.status.error : undefined,
      cwd: backend.cwd
    })
  }

  private projectedQueueSnapshot(backend: BackendRecord): { steering: string[]; followUp: string[]; nativeFollowUpCount: number; queuePause?: import('../../shared/types').QueuePause } {
    const projection = projectQueueSnapshot(
      backend.rawQueue ?? { steering: [], followUp: [] },
      backend.directSteering ?? [],
      (backend.localFollowUps ?? []).map((item) => (
        item.text || (item.images.length > 0 ? '（图像消息）' : '')
      ))
    )
    backend.directSteering = projection.directSteering
    // Queue events can consume a marker before its RPC response arrives.
    // Preserve newest same-text markers, so a late handled response cannot
    // remove a newer insertion after the original was consumed.
    const counts = new Map<string, number>()
    for (const text of projection.directSteering) counts.set(text, (counts.get(text) ?? 0) + 1)
    const retained = [...(this.steeringMarkers?.get(backend) ?? [])].reverse().filter((marker) => {
      const count = counts.get(marker.message) ?? 0
      if (count === 0) return false
      counts.set(marker.message, count - 1)
      return true
    }).reverse()
    this.steeringMarkers?.set(backend, retained)
    return {
      ...projection.queue,
      nativeFollowUpCount: projection.queue.nativeFollowUpCount ?? 0,
      queuePause: backend.queuePause ? { ...backend.queuePause } : undefined
    }
  }

  private pushQueueSnapshot(backend: BackendRecord): void {
    if (this.activeKey !== backend.key || !this.backendStillOwned(backend)) return
    this.win?.webContents.send(EVENT_CHANNEL, {
      type: 'queue_update',
      ...this.projectedQueueSnapshot(backend)
    })
  }

  private markDirectSteering(backend: BackendRecord, message: string): symbol {
    const token = Symbol('steering insertion')
    this.steeringMarkers ??= new WeakMap()
    const markers = this.steeringMarkers.get(backend) ?? []
    markers.push({ token, message })
    this.steeringMarkers.set(backend, markers)
    backend.directSteering ??= []
    backend.directSteering.push(message)
    const raw = backend.rawQueue ?? { steering: [], followUp: [] }
    backend.rawQueue = {
      steering: [...raw.steering, message],
      followUp: [...raw.followUp]
    }
    this.pushQueueSnapshot(backend)
    return token
  }

  private unmarkDirectSteering(backend: BackendRecord, message: string, token: symbol): void {
    const markers = this.steeringMarkers?.get(backend)
    const markerIndex = markers?.findIndex((marker) => marker.token === token) ?? -1
    if (markerIndex < 0 || !this.backendStillOwned(backend)) return
    markers?.splice(markerIndex, 1)
    const directIndex = backend.directSteering?.lastIndexOf(message) ?? -1
    if (directIndex >= 0) backend.directSteering?.splice(directIndex, 1)
    const raw = backend.rawQueue
    if (raw) {
      const rawIndex = raw.steering.lastIndexOf(message)
      if (rawIndex >= 0) raw.steering.splice(rawIndex, 1)
    }
    this.pushQueueSnapshot(backend)
  }

  private completeCompanionRuns(backend: BackendRecord, terminal: 'completed' | 'aborted' | 'failed' | 'interrupted', settledAt: number): void {
    const ids = backend.companionRunIds?.splice(0) ?? []
    for (const id of ids) {
      this.runStore.update(id, (run) => {
        run.state = terminal
        run.settledAt = settledAt
        run.liveUsage = undefined
      })
    }
  }

  private dispatchNextLocalFollowUp(backend: BackendRecord): void {
    if (
      !this.backendStillOwned(backend)
      || this.messageRevertInFlight
      || backend.compacting
      || backend.busy
      || backend.localQueueDispatchPromise
      || backend.localQueueDispatching
      || backend.localQueueBlocked
      || backend.queuePause?.paused
      || backend.queueAutoReady !== true
      || backend.runCompletionPromise
      || (backend.localFollowUps?.length ?? 0) === 0
    ) return
    const lease = this.reserveDispatch(backend)
    let invoked = false
    backend.localQueueDispatching = true
    backend.busy = true
    const promise = (async (): Promise<void> => {
      const localFollowUps = backend.localFollowUps ?? []
      const item = localFollowUps.shift()
      if (!item) {
        backend.busy = false
        backend.localQueueDispatching = false
        return
      }
      this.pushQueueSnapshot(backend)
      const state = await backend.client.getState().catch(() => null)
      if (!lease.owns() || backend.compacting || backend.queuePause?.paused || backend.localQueueBlocked
        || backend.queueAutoReady !== true || !state || state.isStreaming || state.isCompacting) {
        if (!lease.ownsReservation()) return
        if (!localFollowUps.some((queued) => queued.runId === item.runId)) localFollowUps.unshift(item)
        if (lease.owns() && state && !state.isStreaming && !state.isCompacting && !backend.compacting) {
          backend.busy = false
        }
        if (!state && lease.owns()) {
          backend.busy = false
          // A failed state read must not spin the dispatcher indefinitely.
          this.pauseQueue(backend, '无法确认 Agent 状态，排队已暂停。', item.runId)
        }
        backend.localQueueDispatching = false
        this.pushQueueSnapshot(backend)
        return
      }
      this.pushQueueSnapshot(backend)
      try {
        await this.applyDesiredMode(backend, lease)
        this.assertDispatchLease(lease)
        await this.prepareQueuedRunForDispatch(backend, item.runId)
        this.assertDispatchLease(lease)
        if (backend.queuePause?.paused || backend.localQueueBlocked || backend.queueAutoReady !== true) {
          throw new Error('排队已暂停，消息未发送')
        }
        await this.dispatchPrompt(backend, item.runId, item.text, item.images, lease, () => { invoked = true })
      } catch (error) {
        if (invoked) {
          this.recoverPromptFailure(backend, lease, this.runStore.get(item.runId), error)
          return
        }
        if (!lease.ownsReservation()) return
        const current = this.runStore.get(item.runId)
        if (!current || (current.state !== 'queued' && current.state !== 'dispatching')
          || this.hasRunDispatchEvidence(current)) return
        if (!lease.owns()) {
          if (!localFollowUps.some((queued) => queued.runId === item.runId)) localFollowUps.unshift(item)
          this.runStore.update(item.runId, (run) => {
            // Preparation can yield before prompt is invoked. No event was
            // allowed to adopt this still-local item, so undo only its ledger.
            if (run.state === 'dispatching' && !this.hasRunDispatchEvidence(run)) run.state = 'queued'
          })
          this.pushQueueSnapshot(backend)
          return
        }
        backend.activeRunId = undefined
        backend.busy = false
        // Only a local preparation failure, before the RPC call, is unsent.
        backend.pendingRunIds = [item.runId, ...backend.pendingRunIds.filter((id) => id !== item.runId)]
        localFollowUps.unshift(item)
        backend.localQueueDispatching = false
        this.pauseQueue(backend, '排队消息派发失败，请手动重试该消息。', item.runId)
        this.runStore.update(item.runId, (run) => {
          if (run.state !== 'dispatching' || this.hasRunDispatchEvidence(run)) return
          run.state = 'queued'
          run.error = error instanceof Error ? error.message : String(error)
        })
        this.pushQueueSnapshot(backend)
        if (!backend.busy && !backend.localQueueBlocked && (backend.localFollowUps?.length ?? 0) > 0) {
          this.dispatchNextLocalFollowUp(backend)
        }
      }
    })().finally(() => {
      if (backend.localQueueDispatchPromise !== promise || !this.backendStillOwned(backend)) return
      backend.localQueueDispatchPromise = undefined
      backend.localQueueDispatching = false
      if (
        this.backendStillOwned(backend)
        && !backend.localQueueDispatching
        && !backend.localQueueBlocked
        && !backend.runCompletionPromise
        && !backend.busy
        && !backend.compacting
        && (backend.localFollowUps?.length ?? 0) > 0
      ) {
        this.dispatchNextLocalFollowUp(backend)
      }
    })
    backend.localQueueDispatchPromise = promise
  }

  private async promoteLocalFollowUp(backend: BackendRecord, index: number): Promise<void> {
    const localFollowUps = backend.localFollowUps ?? []
    const item = localFollowUps[index]
    if (!item) throw new Error('排队消息已被发送或移除')
    const queued = this.runStore.get(item.runId)
    if (!queued || queued.state !== 'queued' || this.hasRunDispatchEvidence(queued)) {
      throw new Error('该消息已开始派发，不能作为未发送消息重发')
    }
    const lease = this.reserveDispatch(backend)
    localFollowUps.splice(index, 1)
    this.pushQueueSnapshot(backend)

    const state = await backend.client.getState().catch(() => null)
    if (
      !lease.owns()
      || !state
      || state.isCompacting
      || backend.compacting
      || backend.runCompletionPromise
      || backend.localQueueDispatchPromise
      || (backend.busy && !state.isStreaming)
    ) {
      if (lease.ownsReservation()) {
        localFollowUps.splice(index, 0, item)
        this.pushQueueSnapshot(backend)
      }
      throw new Error('当前 Agent 正在切换运行状态，请稍后再次发送该消息')
    }
    // This action authorizes only the selected item, not the remaining queue.
    if (!backend.queuePause?.paused) this.pauseQueue(backend, '已手动发送一条消息，其余排队消息仍暂停。', null, false)
    if (state.isStreaming) {
      backend.busy = true
      backend.pendingRunIds = backend.pendingRunIds.filter((id) => id !== item.runId)
      backend.companionRunIds ??= []
      backend.companionRunIds.push(item.runId)
      this.runStore.update(item.runId, (run) => {
        run.state = 'running'
        run.dispatchedAt ??= Date.now()
        run.agentStartedAt ??= Date.now()
      })
      const marker = this.markDirectSteering(backend, item.text)
      const activeRunId = backend.activeRunId
      try {
        await this.dispatchSteering(backend, item.text, item.images, marker, item.runId)
      } catch (error) {
        if (!lease.ownsReservation() || backend.activeRunId !== activeRunId || !backend.companionRunIds?.includes(item.runId)
          || !this.steeringMarkers?.get(backend)?.some((entry) => entry.token === marker)) throw error
        // steer was invoked; a transport error cannot make this input local
        // again. Retain the companion ledger for actual lifecycle settlement.
        // Keep this direct-insertion marker: an uncertain RPC response does
        // not turn its native steering entry into a visible unsent message.
        this.runStore.update(item.runId, (run) => {
          if (run.state !== 'running' && run.state !== 'dispatching') return
          run.state = 'interrupted'
          run.interruptedAt = Date.now()
          run.error = error instanceof Error ? error.message : String(error)
        })
        this.pauseQueue(backend, '插入消息执行状态未知，排队已暂停。')
        throw error
      }
      return
    }

    // A race can make the run idle between the card click and this request.
    // Put the selected run first so this explicit action still wins over the
    // remaining local queue instead of silently sending another item.
    backend.pendingRunIds = [item.runId, ...backend.pendingRunIds.filter((id) => id !== item.runId)]
    backend.localQueueDispatching = true
    backend.busy = true
    let invoked = false
    try {
      await this.applyDesiredMode(backend, lease)
      this.assertDispatchLease(lease)
      await this.prepareQueuedRunForDispatch(backend, item.runId)
      this.assertDispatchLease(lease)
      await this.dispatchPrompt(backend, item.runId, item.text, item.images, lease, () => { invoked = true })
    } catch (error) {
      if (invoked) {
        this.recoverPromptFailure(backend, lease, this.runStore.get(item.runId), error)
        throw error
      }
      if (!lease.ownsReservation()) throw error
      const current = this.runStore.get(item.runId)
      if (!current || (current.state !== 'queued' && current.state !== 'dispatching')
        || this.hasRunDispatchEvidence(current)) throw error
      backend.localQueueDispatching = false
      if (lease.owns()) {
        backend.activeRunId = undefined
        backend.busy = false
        backend.localQueueDispatching = false
        this.pauseQueue(backend, '排队消息派发失败，请手动重试该消息。', item.runId)
      }
      if (!localFollowUps.some((queued) => queued.runId === item.runId)) localFollowUps.splice(index, 0, item)
      backend.pendingRunIds = [item.runId, ...backend.pendingRunIds.filter((id) => id !== item.runId)]
      this.runStore.update(item.runId, (run) => {
        if (run.state !== 'dispatching' && run.state !== 'queued') return
        if (this.hasRunDispatchEvidence(run)) return
        run.state = 'queued'
        run.error = error instanceof Error ? error.message : String(error)
      })
      this.pushQueueSnapshot(backend)
      throw error
    }
  }

  /** Remove a Pion-owned local follow-up from the queue; native Pi queue items
      cannot be removed over RPC and are rejected with a clear error. */
  async removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<void> {
    if (kind !== 'steering' && kind !== 'followUp') throw new Error('无效的排队消息类型')
    if (!Number.isInteger(index) || index < 0) throw new Error('无效的排队消息位置')
    const backend = await this.ensureActiveBackend()
    if (kind === 'steering') throw new Error('Pi 原生插入消息暂不支持移除')

    const nativeFollowUpCount = backend.rawQueue?.followUp.length ?? 0
    const localIndex = index - nativeFollowUpCount
    if (localIndex < 0) throw new Error('这条 Pi 原生排队消息暂不支持移除')
    const item = backend.localFollowUps?.[localIndex]
    if (!item) throw new Error('排队消息已被发送或移除')
    backend.localFollowUps?.splice(localIndex, 1)
    this.runStore.update(item.runId, (run) => {
      if (run.state === 'queued') {
        run.state = 'discarded'
        run.settledAt = Date.now()
      }
    })
    this.pushQueueSnapshot(backend)
  }

  /** Promote one Pion queue-card item without duplicating it in Pi's queue. */
  async sendQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<void> {
    if (kind !== 'steering' && kind !== 'followUp') throw new Error('无效的排队消息类型')
    if (!Number.isInteger(index) || index < 0) throw new Error('无效的排队消息位置')
    const backend = await this.ensureActiveBackend()

    if (kind === 'followUp') {
      const nativeFollowUpCount = backend.rawQueue?.followUp.length ?? 0
      const localIndex = index - nativeFollowUpCount
      if (localIndex < 0) {
        throw new Error('这条 Pi 原生排队消息无法在当前 RPC 中直接提升')
      }
      await this.promoteLocalFollowUp(backend, localIndex)
      await this.syncBackendSession(backend)
      return
    }

    const message = this.projectedQueueSnapshot(backend).steering[index]
    if (!message) throw new Error('排队消息已被发送或移除')
    // Steering is already the immediate-delivery path (used by Enter). Hide
    // the raw Pi item rather than sending a duplicate copy.
    backend.directSteering ??= []
    backend.directSteering.push(message)
    this.pushQueueSnapshot(backend)
  }

  private hasSubagentSourceReceipt(backend: BackendRecord, parentToolCallId: string, running = true): boolean {
    const receipt = backend.nativeToolReceipts?.get(parentToolCallId)
    const run = receipt && this.runStore.get(receipt.runId)
    return !!receipt && receipt.name === 'pion_subagents' && (!running || receipt.state === 'running')
      && !!backend.usageBackendId && receipt.backendId === backend.usageBackendId
      && run?.usageBackendId === backend.usageBackendId && run.cwd === backend.cwd
      && (run.state === 'dispatching' || run.state === 'running' || run.state === 'ending')
      && (!backend.sessionPath || run.sessionPath === backend.sessionPath)
  }

  /** Private capacity ACK only. Same-process plugins are not an OS trust boundary. */
  private handleSubagentAdmission(backend: BackendRecord, client: RpcClient, event: unknown): void {
    const request = event as { type?: unknown; method?: unknown; id?: unknown; placeholder?: unknown; parentToolCallId?: unknown }
    const bounded = (value: unknown, max: number): value is string => typeof value === 'string'
      && value.length > 0 && value.length <= max && !value.includes('\0')
    let admission: SubagentSessionAdmission | undefined
    if (backend.phase !== 'error' && request.type === 'extension_ui_request' && request.method === 'input'
      && request.parentToolCallId === undefined && bounded(request.id, 256)
      && typeof request.placeholder === 'string' && request.placeholder.length <= 4096) {
      try {
        const value: unknown = JSON.parse(request.placeholder)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const parsed = value as Record<string, unknown>
          if (Object.keys(parsed).every((key) => ['version', 'nonce', 'runtimeId', 'parentToolCallId', 'count'].includes(key))
            && parsed.version === 1 && bounded(parsed.nonce, 256) && parsed.nonce === backend.subagentViewNonce
            && bounded(parsed.runtimeId, 256) && bounded(parsed.parentToolCallId, 256)
            && Number.isSafeInteger(parsed.count) && (parsed.count as number) >= 1 && (parsed.count as number) <= SUBAGENT_LIMITS.maxParallel.max) {
            admission = { version: 1, nonce: parsed.nonce, runtimeId: parsed.runtimeId,
              parentToolCallId: parsed.parentToolCallId, count: parsed.count as number }
          }
        }
      } catch { /* Reserved malformed input must never become a generic UI prompt. */ }
    }
    const backendId = backend.liveState?.backendId
    // Check source before constructing the store or consuming any capacity.
    const ok = !!admission && !!backendId && this.hasSubagentSourceReceipt(backend, admission.parentToolCallId)
      && this.subagentSessions().reserveBatch({ backendId, nonce: admission.nonce, cwd: backend.cwd,
        parentSessionPath: backend.sessionPath }, admission, (id) => this.hasSubagentSourceReceipt(backend, id))
    if (bounded(request.id, 256)) this.respondToExtensionUi(client, request.id, { value: ok ? 'reserved' : 'denied' })
  }

  private attachBackendEvents(backend: BackendRecord): void {
    const client = backend.client
    client.onEvent((event) => {
      if (this.stopping || backend.historyMutation || backend.historyStopFailed
        || backend.client !== client || this.backendPool.get(backend.key) !== backend) return
      if ((event as { title?: unknown }).title === SUBAGENT_SESSION_ADMISSION_TITLE) {
        this.handleSubagentAdmission(backend, client, event)
        return // Always private, including malformed method/type and nested packets.
      }
      if ((event as { widgetKey?: unknown }).widgetKey === SUBAGENT_SESSION_WIDGET_KEY) {
        if (backend.phase === 'error') return
        const backendId = backend.liveState?.backendId
        if (backendId && backend.subagentViewNonce) this.subagentSessions().consume({
          backendId, nonce: backend.subagentViewNonce, cwd: backend.cwd, parentSessionPath: backend.sessionPath
        }, event, (parentToolCallId) => this.hasSubagentSourceReceipt(backend, parentToolCallId))
        return // Reserved malformed/private input is swallowed even without a scope.
      }
      if ((event as { widgetKey?: unknown }).widgetKey === QUESTION_WAIT_WIDGET_KEY) {
        if (backend.phase === 'error') return
        const widget = event as { type?: unknown; method?: unknown; widgetLines?: unknown; parentToolCallId?: unknown }
        const metadata = parseQuestionWaitMetadata(widget.widgetLines)
        if (widget.type !== 'extension_ui_request' || widget.method !== 'setWidget'
          || widget.parentToolCallId !== undefined || !metadata || metadata.nonce !== backend.questionUiNonce) return
        if (metadata.phase === 'end') {
          if (this.questionWaitStages?.get(backend)?.toolCallId === metadata.toolCallId) this.questionWaitStages?.delete(backend)
          return
        }
        const receipt = backend.nativeToolReceipts?.get(metadata.toolCallId)
        const run = receipt && this.runStore.get(receipt.runId)
        if (receipt?.name === 'pion_ask_user' && receipt.state === 'running' && !receipt.parentId
          && !!backend.usageBackendId && receipt.runId === backend.activeRunId && receipt.backendId === backend.usageBackendId
          && run?.usageBackendId === backend.usageBackendId && run.cwd === backend.cwd
          && (run.state === 'dispatching' || run.state === 'running' || run.state === 'ending')
          && (!backend.sessionPath || run.sessionPath === backend.sessionPath)) {
          ;(this.questionWaitStages ??= new WeakMap()).set(backend, { ...metadata, scope: this.capturePendingScope(backend) })
        }
        return // Consume even malformed private records before billing/history/UI.
      }
      // Private notices (including malformed/nested ones) never reach root
      // lifecycle, chat/live revision, billing, tasks or generic extension UI.
      if (isMcpStatusWidget(event)) {
        if (backend.phase === 'error') return
        backend.liveState ??= new LiveSessionProjection()
        if (cacheMcpStatusWidget(backend, event)) this.pushMcpStatus(backend)
        return
      }
      const type = (event as { type?: string }).type
      // Nested billing has private receipts, never independent renderer rows
      // or root lifecycle events. SDK codemode usage covers models.*, not children.
      const parentToolCallId = (event as { parentToolCallId?: unknown }).parentToolCallId
      const completedTool = event as { toolCallId?: unknown; toolName?: unknown }
      if (type === 'tool_execution_end' && completedTool.toolName === 'pion_subagents'
        && typeof completedTool.toolCallId === 'string'
        && this.hasSubagentSourceReceipt(backend, completedTool.toolCallId, false)
        && backend.nativeToolReceipts?.get(completedTool.toolCallId)?.parentId === parentToolCallId) {
        // Release only unused slots; the runner has already awaited child abort/finals.
        const backendId = backend.liveState?.backendId
        if (backendId) this.subagentSessionStore?.releaseBatch(backendId, completedTool.toolCallId)
      }
      if (typeof parentToolCallId === 'string' && parentToolCallId.length > 0) {
        this.trackBackendEvent(backend, event, type)
        return
      }
      const liveState = backend.liveState ??= new LiveSessionProjection()
      liveState.record(event)
      if (type === 'agent_start' || type === 'agent_settled'
        || type === 'compaction_start' || type === 'compaction_end') {
        this.dispatchLifecycle(backend).generation += 1
      }
      if (type === 'extension_ui_request' && this.handleExtensionUiRequest(backend, event)) return

      if (type === 'tool_execution_end' && (event as { toolName?: string }).toolName === 'pion_subagents') {
        this.clearSubagentPermissions(backend)
      }
      let forwardedEvent = event
      if (type === 'queue_update') {
        const queue = event as { steering?: unknown; followUp?: unknown }
        const steering = Array.isArray(queue.steering)
          ? queue.steering.filter((message): message is string => typeof message === 'string')
          : []
        const followUp = Array.isArray(queue.followUp)
          ? queue.followUp.filter((message): message is string => typeof message === 'string')
          : []
        backend.rawQueue = { steering, followUp }
        forwardedEvent = { ...event, ...this.projectedQueueSnapshot(backend) }
      }

      const backendEffect = applyBackendEvent(
        backend,
        event,
        this.desiredModes
      )
      let { runningStateChanged, sessionCompleted } = backendEffect
      // A local follow-up is about to start another turn, so completion
      // notifications should wait until that local queue is empty.
      if (sessionCompleted && (backend.localFollowUps?.length ?? 0) > 0) {
        sessionCompleted = false
      }
      if (sessionCompleted) {
        for (const listener of this.sessionCompletedListeners) {
          try {
            listener({ cwd: backend.cwd, sessionPath: backend.sessionPath })
          } catch (error) {
            console.error('[pion] session completion listener failed:', error)
          }
        }
      }
      const settledRunId = type === 'agent_settled' ? backend.activeRunId : undefined
      if (type === 'agent_settled' && backend.completionState !== 'completed') {
        this.pauseQueue(backend, '本轮未正常完成，排队已暂停。', settledRunId)
      }
      this.trackBackendEvent(backend, event, type)
      if (type === 'agent_settled') {
        const terminal = backend.completionState ?? 'interrupted'
        const settledSessionPath = backend.sessionPath ? resolve(backend.sessionPath) : undefined
        // Mark sessions finished elsewhere as unread until the user opens them.
        if (
          (terminal === 'completed' || terminal === 'failed')
          && settledSessionPath
          && settledSessionPath !== this.activeSessionPath
        ) {
          if (!this.unreadSessionPaths.has(settledSessionPath)) {
            this.unreadSessionPaths.add(settledSessionPath)
            this.pushUnreadSessions()
          }
        }
        this.completeCompanionRuns(backend, terminal, Date.now())
        backend.completionState = undefined
        backend.localQueueDispatching = false
        if (terminal === 'completed') {
          const completedRun = settledRunId ? this.runStore.get(settledRunId) : null
          const pausedRunId = backend.queuePause?.pausedRunId
          if (backend.queuePause?.paused && pausedRunId
            && pausedRunId === settledRunId && !!completedRun?.recoveredFromRunId) {
            this.clearQueuePause(backend)
          }
          backend.queueAutoReady = !backend.queuePause?.paused && !backend.localQueueBlocked
          const completionGeneration = this.dispatchLifecycle(backend).generation
          const completionPromise = backend.runCompletionPromise
          if (completionPromise) {
            void completionPromise.then(() => {
              if (!this.backendStillOwned(backend) || backend.client !== client
                || backend.runCompletionPromise !== completionPromise) return
              backend.runCompletionPromise = undefined
              this.pushRunningSessionPaths()
              if (
                this.dispatchLifecycle(backend).generation === completionGeneration
                && !backend.busy
                && !backend.compacting
                && !backend.localQueueDispatching
                && (backend.localFollowUps?.length ?? 0) > 0
              ) {
                this.dispatchNextLocalFollowUp(backend)
              }
            })
          } else {
            this.dispatchNextLocalFollowUp(backend)
          }
        } else {
          backend.localQueueBlocked = true
          this.pushQueueSnapshot(backend)
        }
      }
      if (runningStateChanged) this.pushRunningSessionPaths()
      // Completion means the JSONL is persisted; queue/token events do not.
      // Soft persistence dirtiness allows one reread of an earlier empty scan
      // without starving discovery during continuous background completions.
      if (type === 'message_end') this.sessionListCache?.invalidate(backend.cwd, { soft: true })
      // Name changes are hard mutations: an old scan must not restore old names.
      if (type === 'session_info_changed') this.sessionListCache?.invalidate(backend.cwd)
      if (type === 'agent_start' || type === 'message_start' || type === 'agent_settled'
        || (type === 'message_end' && (!backend.sidebarPublishedSessionPath || backend.sidebarPublishedSessionPath !== backend.sessionPath))) {
        // Keep persisted history fresh even when this backend finishes while a
        // different project or session is selected. A first prompt can also
        // create the session file needed by the sidebar running indicator.
        void this.syncBackendSession(backend).catch((error) => {
          console.warn('[pion] session publication failed:', error)
        })
      }
      if (this.activeKey !== backend.key) return
      if (type === 'agent_start') this.setActiveBackendStatus()
      this.win?.webContents.send(EVENT_CHANNEL, {
        ...liveState.annotateEvent(forwardedEvent),
        _pionLive: liveState.metadata(backend.cwd, backend.sessionPath)
      })
      if (type === 'entry_appended' && (event as { entry?: { customType?: string } }).entry?.customType === 'pion-subagents-state') {
        void this.pushSessionInfo()
      }
      if (typeof type === 'string' && STATE_REFRESH_EVENTS.has(type)) {
        void this.pushSessionInfo()
        void this.refreshSidebarSessions(false)
      }
    })
  }

  private async createBackend(
    key: string,
    cwd: string,
    sessionPath?: string
  ): Promise<BackendRecord> {
    this.assertSessionNotQuarantined(sessionPath)
    const cliPath = pionRuntimePath()
    const args = await this.backendArgs(cwd, sessionPath)
    this.assertHistoryAvailable()
    this.assertSessionNotQuarantined(sessionPath)
    const subagentViewNonce = randomUUID()
    const questionUiNonce = randomUUID()
    const client = new RpcClient({
      cliPath,
      cwd,
      args,
      env: { PION_TOOL_PERMISSION_CONFIG: this.toolPermissionStore.filePath,
        PION_SUBAGENT_SETTINGS_FILE: subagentSettingsFilePath(),
        PION_SUBAGENT_VIEW_NONCE: subagentViewNonce,
        PION_QUESTION_SETTINGS_FILE: questionSettingsFilePath(),
        PION_QUESTION_UI_NONCE: questionUiNonce }
    })
    const backend = {
      key,
      cwd,
      sessionPath,
      client,
      liveState: new LiveSessionProjection(),
      subagentViewNonce,
      questionUiNonce,
      phase: 'starting' as BackendPhase,
      busy: false,
      compacting: false,
      pendingRunIds: [],
      localFollowUps: [],
      directSteering: [],
      subagentsEnabled: DEFAULT_SUBAGENTS_ENABLED,
      companionRunIds: [],
      rawQueue: { steering: [], followUp: [] },
      startPromise: Promise.resolve()
    }
    this.backendPool.add(backend)
    if (sessionPath) this.backendKeysBySessionPath.set(resolve(sessionPath), key)
    this.attachBackendEvents(backend)
    if (this.activeKey === key) this.setActiveBackendStatus()

    const startPromise = client.start()
      .then(async () => {
        this.observeSubagentProcessExit(backend)
        // RpcClient.start() only waits 100 ms. The permission and plan
        // extensions can make cold startup longer, so require one successful
        // RPC round trip before exposing this backend as ready.
        const initialState = await client.getState()
        await restoreSessionModelPreference(client, initialState, sessionPath, this.sessionModelPreferences)
        backend.phase = 'running'
        console.log('[pion] agent subprocess running, session:', sessionPath ?? key)
        if (this.activeKey === key) this.setActiveBackendStatus()
        void this.pushSessionInfo()
        void this.refreshSidebarSessions(false)
      })
      .catch((error: unknown) => {
        // Startup failure can discard a live child handle without exit proof.
        this.unconfirmedStoppedWorktreeCwds ??= new Set<string>()
        this.unconfirmedStoppedWorktreeCwds.add(resolve(cwd))
        backend.phase = 'error'
        this.markSubagentBackendGone(backend, false)
        this.clearBackendToolPermissionRequests(key)
        this.clearBackendExtensionUiRequests(key)
        this.backendPool.delete(key)
        this.pushRunningSessionPaths()
        if (sessionPath && this.backendKeysBySessionPath.get(resolve(sessionPath)) === key) {
          this.backendKeysBySessionPath.delete(resolve(sessionPath))
        }
        if (this.activeKey === key) {
          const message = error instanceof Error ? error.message : String(error)
          this.setStatus({ phase: 'error', error: message, cwd })
        }
        throw error
      })
    backend.startPromise = startPromise
    await startPromise
    return backend
  }

  /** Serialize starts so concurrent session selections cannot exceed the pool limit. */
  private startBackendWithLimit(
    key: string,
    cwd: string,
    sessionPath?: string
  ): Promise<BackendRecord> {
    this.assertHistoryAvailable()
    this.assertSessionNotQuarantined(sessionPath)
    return this.backendPool.startWithLimit(
      key,
      () => {
        this.assertHistoryAvailable()
        this.assertSessionNotQuarantined(sessionPath)
        return this.createBackend(key, cwd, sessionPath)
      },
      () => this.stopping,
      (victim) => this.stopBackend(victim)
    )
  }

  private async waitForActiveBackend(): Promise<BackendRecord | null> {
    const key = this.activeKey
    if (!key) return null
    const backend = this.backendPool.get(key)
    try {
      if (backend) {
        await backend.startPromise
        return this.activeKey === key ? backend : null
      }
      const pending = this.backendPool.getStart(key)
      if (!pending) return null
      await pending
      return this.activeKey === key ? this.backendPool.get(key) ?? null : null
    } catch {
      return null
    }
  }

  private async ensureActiveBackend(): Promise<BackendRecord> {
    this.assertHistoryAvailable()
    this.assertSessionNotQuarantined(this.activeSessionPath)
    if (this.stopping) throw new Error('agent 正在停止')
    if (this.providerMutationInFlight && !this.providerReloading) {
      throw new Error('提供商配置或认证正在进行，请完成或取消后再启动 Agent')
    }
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) throw new Error('没有活动工作目录')
    if (!this.activeKey) {
      this.activeCwd = resolve(cwd)
      this.activeKey = this.newSessionKey(this.activeCwd)
    }
    const activeCwd = this.activeCwd ?? resolve(cwd)
    this.activeCwd = activeCwd
    let backend = this.backendPool.get(this.activeKey)
    if (!backend) {
      const key = this.activeKey
      const inFlight = this.backendPool.getStart(key)
      if (inFlight) {
        backend = await inFlight
      } else {
        this.setStatus({ phase: 'starting', error: undefined, cwd: activeCwd })
        const start = this.startBackendWithLimit(key, activeCwd, this.activeSessionPath)
        backend = await start
      }
    } else {
      await backend.startPromise
      if (this.activeKey === backend.key) this.setActiveBackendStatus()
    }
    this.assertHistoryAvailable()
    this.assertSessionNotQuarantined(backend.sessionPath)
    if (backend.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
    return backend
  }

  private async syncBackendSession(backend: BackendRecord): Promise<void> {
    if (backend.historyMutation || backend.historyStopFailed) return
    const revision = this.historyRevision
    const client = backend.client
    const state = await client.getState().catch(() => null)
    if (backend.client !== client || revision !== this.historyRevision || backend.historyMutation || backend.historyStopFailed
      || this.backendPool.get(backend.key) !== backend) return
    const sessionPath = state?.sessionFile
    if (!sessionPath) return
    const normalizedPath = resolve(sessionPath)
    const previousScope = { cwd: backend.cwd, sessionPath: backend.sessionPath }
    backend.sessionPath = normalizedPath
    if (backend.queuePause) this.runStore.moveQueuePause?.(previousScope, backend, backend.queuePause)
    if (backend.liveState) this.subagentSessionStore?.bindParent(backend.liveState.backendId, normalizedPath)
    this.updateRunSession(backend, normalizedPath, state.sessionId)
    // Parsed history is refreshed by its file signature or explicit history mutations,
    // not by every lifecycle get_state response for the same persisted path.
    this.backendKeysBySessionPath.set(normalizedPath, backend.key)
    if (this.activeKey === backend.key) this.activeSessionPath = normalizedPath
    this.pushRunningSessionPaths()
    this.restoreQueuedRuns(backend)
    if (backend.sidebarPublishedSessionPath !== normalizedPath) {
      const sessions = await this.listSessions(backend.cwd)
      // Pi can allocate a path before it writes the JSONL. Retry on subsequent
      // message events until listSessions actually sees the persisted session.
      if (revision === this.historyRevision && this.backendPool.get(backend.key) === backend
        && !backend.historyMutation && !backend.historyStopFailed
        && backend.sessionPath === normalizedPath && sessions.some((session) => resolve(session.path) === normalizedPath)) {
        backend.sidebarPublishedSessionPath = normalizedPath
        this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
      }
    }
  }

  private hasRunDispatchEvidence(run: RunOperation): boolean {
    return run.dispatchedAt !== undefined || run.agentStartedAt !== undefined || run.tools.length > 0
  }

  /** Only genuinely unsent queued runs return to the live queue on activation.
      Dispatch attempts remain recovery records, never automatic replays. */
  private restoreQueuedRuns(backend: BackendRecord): void {
    if (backend.queueRestored) return
    backend.queueRestored = true
    backend.queuePause = this.runStore.getQueuePause?.(backend)
    if (backend.queuePause?.paused) backend.localQueueBlocked = true
    const sessionPath = backend.sessionPath ? resolve(backend.sessionPath) : undefined
    const queued = this.runStore
      .list({ sessionPath, cwd: sessionPath ? undefined : backend.cwd, limit: 50 })
      .filter((run) => run.state === 'queued')
      .sort((left, right) => left.createdAt - right.createdAt)
    if (queued.length === 0) {
      this.pushQueueSnapshot(backend)
      return
    }
    this.pauseQueue(backend, '恢复的排队消息需手动发送或继续原任务。', null, false)
    backend.localFollowUps ??= []
    const existing = new Set(backend.localFollowUps.map((item) => item.runId))
    for (const run of queued) {
      if (this.hasRunDispatchEvidence(run)) {
        this.runStore.update(run.id, (current) => {
          if (current.state !== 'queued') return
          current.state = 'interrupted'
          current.interruptedAt ??= Date.now()
        })
        backend.localFollowUps = backend.localFollowUps.filter((item) => item.runId !== run.id)
        backend.pendingRunIds = backend.pendingRunIds.filter((id) => id !== run.id)
        continue
      }
      if (existing.has(run.id)) continue
      backend.localFollowUps.push({ runId: run.id, text: run.prompt.message, images: run.prompt.images })
    }
    this.pushQueueSnapshot(backend)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.cancelModelProviderAuth()
    const pendingStarts = this.backendPool.pendingStarts()
    await Promise.allSettled(pendingStarts)
    const backends = [...this.backendPool.values()]
    for (const backend of backends) this.markSubagentBackendGone(backend, false)
    await Promise.all(backends.map((backend) => this.interruptBackendRuns(
      backend,
      'Pion 已退出；本轮及未发送的排队消息都未自动重放。'
    )))
    this.pendingRequests.clearAll()
    // Do not clear quarantinedSessionPaths: SDK stop() may already have lost
    // its child handle. Dropping a record/mapping does not prove writer exit.
    this.backendPool.clear()
    this.backendKeysBySessionPath.clear()
    this.pushRunningSessionPaths()
    this.activeKey = null
    this.activeCwd = undefined
    this.activeSessionPath = undefined
    await Promise.all(backends.map(async ({ client, cwd, historyStopFailed }) => {
      this.unconfirmedStoppedWorktreeCwds ??= new Set<string>()
      this.unconfirmedStoppedWorktreeCwds.add(resolve(cwd))
      if (historyStopFailed) return // a null-handle retry cannot establish exit
      try {
        await client.stop()
      } catch {
        // the subprocess may already be gone; nothing to recover
      }
    }))
    this.setStatus({ phase: 'stopped', cwd: undefined })
    this.pushRunCheckpoint()
    await this.runStore.flush()
  }

  /** Prompt when idle, steer when mid-run. Starts only this session's backend. */
  async send(message: string, images: ImageContent[] = []): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const lease = this.reserveDispatch(backend)
    const state = await backend.client.getState().catch(() => null)
    this.assertDispatchLease(lease)
    this.assertHistoryAvailable()
    if (state?.isStreaming && !state.isCompacting && !backend.compacting) {
      // Enter uses Pi's steering path, but it is an immediate insertion rather
      // than a user follow-up. Keep it out of the visible queue card.
      const marker = this.markDirectSteering(backend, message)
      const client = backend.client
      const activeRunId = backend.activeRunId
      try {
        await this.dispatchSteering(backend, message, images, marker)
      } catch (error) {
        // A missing steering receipt does not prove it was never inserted.
        // Keep it hidden as a direct input; do not expose it as a queued retry.
        if (lease.ownsReservation() && backend.client === client && backend.activeRunId === activeRunId) {
          this.pauseQueue(backend, '插入消息执行状态未知，排队已暂停。', activeRunId)
        }
        throw error
      }
    } else if (
      state?.isCompacting
      || backend.busy
      || backend.compacting
      || backend.localQueueDispatching
      || backend.localQueueDispatchPromise
      || backend.runCompletionPromise
    ) {
      // Protect the dispatch/compaction transition instead of racing a prompt
      // or trying to steer during compaction. Existing local follow-ups do not
      // force Enter into this branch; an idle backend sends Enter immediately.
      this.enqueueCapturedBackend(backend, state, message, images)
    } else {
      // Reserve the backend before checkpoint/mode preparation. Both calls are
      // asynchronous, and RpcClient.prompt itself returns before agent_start.
      backend.busy = true
      let run: RunOperation | undefined
      try {
        this.resetRunCheckpoint(backend)
        await this.applyDesiredMode(backend, lease)
        this.assertDispatchLease(lease)
        run = this.createRun(backend, state, message, images, 'prompt', 'dispatching')
        await this.dispatchPrompt(backend, run.id, message, images, lease)
      } catch (error) {
        this.recoverPromptFailure(backend, lease, run, error)
        throw error
      }
    }
    await this.syncBackendSession(backend)
    if (this.activeKey === backend.key) {
      await Promise.all([this.pushSessionInfo(), this.refreshSidebarSessions()])
    }
  }

  private enqueueCapturedBackend(backend: BackendRecord, state: Awaited<ReturnType<BackendRecord['client']['getState']>> | null,
    message: string, images: ImageContent[]): void {
    if (!this.backendStillOwned(backend)) throw new Error('Agent 会话已关闭')
    const run = this.createRun(backend, state, message, images, 'follow-up', 'queued')
    backend.localFollowUps ??= []
    backend.localFollowUps.push({ runId: run.id, text: message, images })
    this.pushQueueSnapshot(backend)
    this.dispatchNextLocalFollowUp(backend)
  }

  /** Queue a follow-up while running; starts this session's backend if needed. */
  async queue(message: string, images: ImageContent[] = []): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const lease = this.reserveDispatch(backend)
    const state = await backend.client.getState().catch(() => null)
    this.assertDispatchLease(lease)
    this.assertHistoryAvailable()
    if (
      state?.isStreaming
      || state?.isCompacting
      || backend.busy
      || backend.compacting
      || backend.localQueueDispatching
      || backend.localQueueDispatchPromise
      || backend.runCompletionPromise
      || backend.queuePause?.paused
      || backend.localQueueBlocked
      || (backend.localFollowUps?.length ?? 0) > 0
    ) {
      this.enqueueCapturedBackend(backend, state, message, images)
    } else {
      // Reserve the backend across checkpoint/mode preparation and the RPC
      // dispatch gap; prompt resolves before Pi emits agent_start.
      backend.busy = true
      let run: RunOperation | undefined
      try {
        this.resetRunCheckpoint(backend)
        await this.applyDesiredMode(backend, lease)
        this.assertDispatchLease(lease)
        run = this.createRun(backend, state, message, images, 'follow-up', 'dispatching')
        await this.dispatchPrompt(backend, run.id, message, images, lease)
      } catch (error) {
        this.recoverPromptFailure(backend, lease, run, error)
        throw error
      }
    }
    await this.syncBackendSession(backend)
  }

  async startVerificationRepair(
    sessionPath: string | undefined,
    cwd: string,
    message: string
  ): Promise<RunOperation | null> {
    this.assertHistoryAvailable()
    if (this.providerMutationInFlight || this.messageRevertInFlight) return null
    if (!sessionPath) return null
    const target = resolve(sessionPath)
    this.assertSessionNotQuarantined(target)
    let key = this.backendKeysBySessionPath.get(target) ?? target
    let backend = this.backendPool.get(key)
    if (!backend) {
      const pending = this.backendPool.getStart(key)
      if (pending) {
        backend = await pending
      } else {
        const start = this.startBackendWithLimit(key, resolve(cwd), target)
        backend = await start
        key = backend.key
      }
    } else {
      await backend.startPromise
    }
    const lease = this.reserveDispatch(backend)
    const state = await backend.client.getState()
    if (!lease.owns() || this.branchDeletionInFlight || this.messageRevertInFlight || backend.historyStopFailed
      || state.isStreaming || state.isCompacting || backend.busy || backend.compacting) return null
    // Reserve the backend while preparing the checkpoint and sending the
    // repair prompt; verification callbacks may otherwise race each other.
    backend.busy = true
    let run: RunOperation | undefined
    try {
      this.resetRunCheckpoint(backend)
      await this.applyDesiredMode(backend, lease)
      this.assertDispatchLease(lease)
      run = this.createRun(backend, state, message, [], 'verification-repair', 'dispatching')
      await this.dispatchPrompt(backend, run.id, message, [], lease)
      await this.syncBackendSession(backend)
      return this.runStore.get(run.id) ?? run
    } catch (error) {
      this.recoverPromptFailure(backend, lease, run, error)
      throw error
    }
  }

  private async applyDesiredMode(backend: BackendRecord, lease = this.reserveDispatch(backend)): Promise<void> {
    this.assertDispatchLease(lease)
    const desired = this.desiredModes.get(backend.key) ?? 'build'
    if (backend.modePrimed === desired) return
    await backend.client.prompt(desired === 'plan' ? '/plan start' : '/plan exit')
    this.assertDispatchLease(lease)
    backend.modePrimed = desired
  }

  async abort(): Promise<void> {
    await this.client?.abort()
  }

  getStderr(): string {
    return this.client?.getStderr() ?? ''
  }

  // ---------------------------------------------------------------- sessions

  async newSession(): Promise<void> {
    this.assertHistoryAvailable()
    if (this.newSessionInFlight) return this.newSessionInFlight
    const operation = this.createNewSession()
    this.newSessionInFlight = operation
    try {
      await operation
    } finally {
      if (this.newSessionInFlight === operation) this.newSessionInFlight = null
    }
  }

  private async createNewSession(): Promise<void> {
    this.sessionSelectionGeneration += 1
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) throw new Error('没有活动工作目录')

    // A fresh session is already usable once its empty backend exists. Do not
    // create another backend/session when the user clicks "new session" again.
    const existing = this.getActiveBackend()
    if (existing) {
      await existing.startPromise
      const currentState = await existing.client.getState().catch(() => null)
      const isEmpty = currentState
        && currentState.messageCount === 0
        && !currentState.isStreaming
        && currentState.pendingMessageCount === 0
      if (isEmpty) {
        await this.pushSessionInfo()
        return
      }
      await this.syncBackendSession(existing)
    }

    this.activeCwd = resolve(cwd)
    this.activeSessionPath = undefined
    this.activeKey = this.newSessionKey(this.activeCwd)
    this.setStatus({ phase: 'ready', error: undefined, cwd: this.activeCwd })
    this.pushRunCheckpoint()
    // A fresh session has no backend until its first prompt. Start it here so
    // model/thinking pickers are usable before the first message is sent.
    await this.ensureActiveBackend()
    await this.pushSessionInfo()
  }

  private openSessionManager(sessionPath: string): SessionManager {
    const target = resolve(sessionPath)
    // Even SDK open() can migrate/repair a file; do not treat it as read-only.
    this.assertSessionNotQuarantined(target)
    const cached = this.sessionManagers.get(target)
    if (cached) return cached
    const manager = SessionManager.open(target)
    this.sessionManagers.set(target, manager)
    this.sessionManagerSignatures.delete(target)
    return manager
  }

  /**
   * Reuse one parsed JSONL manager while the file signature is unchanged.
   * Session switching previously reparsed the same large file for validation,
   * the newest page, and the history index in immediate succession.
   */
  private async openCurrentSessionManager(sessionPath: string): Promise<SessionManager> {
    const target = resolve(sessionPath)
    this.assertSessionNotQuarantined(target)
    const file = await stat(target)
    this.assertSessionNotQuarantined(target)
    const signature = `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`
    const cached = this.sessionManagers.get(target)
    if (cached && this.sessionManagerSignatures.get(target) === signature) return cached
    const manager = SessionManager.open(target)
    this.sessionManagers.set(target, manager)
    this.sessionManagerSignatures.set(target, signature)
    return manager
  }

  private activateLogicalSession(sessionPath: string, cwd?: string): void {
    const target = resolve(sessionPath)
    this.assertSessionNotQuarantined(target)
    this.activeSessionPath = target
    this.activeKey = this.backendKeysBySessionPath.get(target) ?? target
    this.activeCwd = resolve(cwd ?? this.activeCwd ?? this.status.cwd ?? dirname(target))
    try {
      const manager = this.openSessionManager(target)
      this.desiredModes.set(this.activeKey, sessionMode(manager.getBranch()))
    } catch {
      this.desiredModes.set(this.activeKey, 'build')
    }
    this.setActiveBackendStatus()
    this.pushRunCheckpoint()
    const activeBackend = this.getActiveBackend()
    if (activeBackend) this.pushQueueSnapshot(activeBackend)
  }

  private createEmptyChildSession(manager: SessionManager, parentSession: string): string {
    const child = SessionManager.create(manager.getCwd(), manager.getSessionDir())
    child.newSession({ parentSession })
    const path = child.getSessionFile()
    if (!path) throw new Error('无法创建新的会话文件')
    return resolve(path)
  }

  private createForkedSession(manager: SessionManager, entryId: string): { path: string; text: string } {
    const entry = manager.getEntry(entryId)
    if (!entry || entry.type !== 'message' || entry.message.role !== 'user') {
      throw new Error('无效的分叉消息')
    }
    const text = messageText(entry.message as unknown as WireMessage)
    const currentPath = manager.getSessionFile()
    if (!currentPath) throw new Error('当前会话尚未持久化')
    const path = entry.parentId
      ? manager.createBranchedSession(entry.parentId)
      : this.createEmptyChildSession(manager, currentPath)
    if (!path) throw new Error('无法创建分支会话')
    this.sessionListCache?.invalidate(manager.getCwd())
    return { path: resolve(path), text }
  }

  private async rememberTranscriptModel(sessionPath: string): Promise<void> {
    if (!this.sessionModelPreferences) return
    try {
      const target = resolve(sessionPath)
      this.assertSessionNotQuarantined(target)
      const context = SessionManager.open(target).buildSessionContext()
      if (!context.model) return
      await this.sessionModelPreferences.setSessionModel(target, {
        provider: context.model.provider,
        modelId: context.model.modelId
      })
    } catch (error) {
      // Fork/copy success must not depend on shell metadata persistence.
      console.warn('[pion] unable to remember forked session model:', error)
    }
  }

  /** Fork the selected session without starting or switching a backend. */
  async forkAt(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    if (!this.activeSessionPath) throw new Error('当前会话尚未持久化')
    const target = resolve(this.activeSessionPath)
    this.sessionManagers.delete(target)
    this.sessionManagerSignatures.delete(target)
    const manager = this.openSessionManager(target)
    const result = this.createForkedSession(manager, entryId)
    await this.rememberTranscriptModel(result.path)
    this.activateLogicalSession(result.path, manager.getCwd())
    await this.pushSessionInfo()
    void this.refreshSidebarSessions()
    return { text: result.text, cancelled: false }
  }

  /** Holds a global host-operation gate; not an OS sandbox for external writers. */
  async deleteBranch(
    request: BranchDeleteRequest, ownerId: number, assertExternalIdle: () => void | Promise<void>
  ): Promise<BranchDeleteResult> {
    this.assertHistoryAvailable()
    if (!request || typeof request.projectCwd !== 'string' || !request.projectCwd
      || typeof request.cwd !== 'string' || !request.cwd || typeof request.name !== 'string' || !request.name
      || request.projectCwd.length > 4096 || request.cwd.length > 4096 || request.name.length > 512
      || request.projectCwd.includes('\0') || request.cwd.includes('\0') || request.name.includes('\0')
      || typeof assertExternalIdle !== 'function') throw new Error('无效的分支删除参数')
    for (const cwd of [request.cwd, request.projectCwd]) {
      if (!isAbsolute(cwd) || resolve(cwd) !== cwd
        || cwd.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) {
        throw new Error('工作树路径无效')
      }
    }
    const target = request.cwd
    const project = request.projectCwd
    const generation = this.sessionSelectionGeneration
    const reserved = new Set<BackendRecord>()
    const assertOwner = (): void => {
      if (!this.win || this.win.webContents.id !== ownerId || this.stopping
        || (typeof this.win.isDestroyed === 'function' && this.win.isDestroyed())
        || (typeof this.win.webContents.isDestroyed === 'function' && this.win.webContents.isDestroyed())
        || generation !== this.sessionSelectionGeneration) throw new Error('窗口或会话已变化，未继续删除分支')
      if (target === project) throw new Error('不能删除主工作树')
      if (resolve(this.activeCwd ?? this.status.cwd ?? project) === target
        || (this.getActiveBackend() && resolve(this.getActiveBackend()!.cwd) === target)) {
        throw new Error('请先切换到主工作树再删除')
      }
    }
    const assertIdle = (): void => {
      assertOwner()
      if (this.unconfirmedStoppedWorktreeCwds?.has(target)) {
        throw new Error('旧Agent退出未确认，请重启Pion后再删除')
      }
      if (this.messageRevertInFlight || this.providerMutationInFlight || this.providerReloading
        || this.newSessionInFlight || this.sessionOperationsInFlight > 0 || this.backendPool.pendingStartCount > 0) {
        throw new Error('请等待会话操作完成后再删除分支')
      }
      // Reject other active backends too: this global gate must not invalidate a live dispatch lease.
      for (const backend of this.backendPool.values()) {
        if (backend.historyStopFailed && resolve(backend.cwd) === target) {
          throw new Error('旧Agent退出未确认，请重启Pion后再删除')
        }
        if (backend.phase === 'starting' || (backend.busy && !reserved.has(backend))
          || backend.compacting || backend.awaitingRetry || backend.activeRunId
          || backend.pendingRunIds.length > 0 || (backend.localFollowUps?.length ?? 0) > 0
          || (backend.companionRunIds?.length ?? 0) > 0 || (backend.directSteering?.length ?? 0) > 0
          || (backend.rawQueue?.steering.length ?? 0) > 0 || (backend.rawQueue?.followUp.length ?? 0) > 0
          || backend.localQueueDispatching || backend.localQueueDispatchPromise || backend.runCompletionPromise
          || backend.checkpointCreatePromise || backend.checkpointRefreshPromise || backend.subagentsModePending
          || (backend.sessionPath && this.runStore.hasUnsettledSessionRuns(backend.sessionPath))) {
          throw new Error('请等待所有运行、压缩及收尾完成，并清空排队消息后再删除分支')
        }
      }
      // Consult the full ledger, not the bounded UI/statistics list.
      if (this.runStore.hasUnsettledCwdRuns(target)
        || this.getPendingToolPermissionRequests().length > 0 || this.getPendingExtensionUiRequests().length > 0) {
        throw new Error('无法确认运行记录及待处理请求全部空闲，不能删除分支')
      }
    }
    const lifecycleCwds = (): string[] => [
      ...[...this.backendPool.values()].map((backend) => backend.cwd),
      ...(this.unconfirmedStoppedWorktreeCwds ?? []),
      ...[this.activeCwd, this.status.cwd].filter((cwd): cwd is string => typeof cwd === 'string'),
      process.cwd()
    ]
    const assertCanonicalIdle = async (): Promise<void> => {
      assertIdle()
      const paths = lifecycleCwds()
      for (const cwd of paths) {
        if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new Error('Agent 工作目录不是规范路径，不能删除分支')
        let canonical: string
        try { canonical = await realpath(cwd) } catch {
          throw new Error('无法确认 Agent 工作目录，请重启Pion后再删除')
        }
        if (canonical !== cwd) throw new Error('Agent 工作目录包含别名或符号链接，不能删除分支')
        assertIdle()
        const current = lifecycleCwds()
        if (current.length !== paths.length || current.some((path, index) => path !== paths[index])) {
          throw new Error('Agent 工作目录已变化，不能删除分支')
        }
      }
      assertIdle()
    }
    const assertDeletionIdle = async (): Promise<void> => {
      await assertCanonicalIdle()
      await assertExternalIdle()
      await assertCanonicalIdle()
    }
    assertIdle()
    this.branchDeletionInFlight = true
    this.historyRevision += 1
    try {
      await assertDeletionIdle()
      // Capture Git/filesystem identities before querying or stopping any backend.
      const commit = await prepareWorktreeBranchDeletion(project, target, request.name, assertDeletionIdle)
      await assertDeletionIdle()
      const targets = [...this.backendPool.values()].filter((backend) => backend.cwd === target)
      for (const backend of targets) {
        if (backend.phase !== 'running') throw new Error('目标 Agent 未就绪，不能删除分支')
        this.assertSessionNotQuarantined(backend.sessionPath)
        reserved.add(backend)
        backend.historyMutation = true
        backend.busy = true
      }
      for (const backend of targets) {
        await assertDeletionIdle()
        const state = await backend.client.getState()
        await assertDeletionIdle()
        if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
          throw new Error('目标 Agent 仍在运行或有排队消息，不能删除分支')
        }
      }
      for (const backend of targets) {
        await assertDeletionIdle()
        try {
          if ((backend.client as unknown as { process?: unknown }).process === null) {
            throw new Error('旧Agent退出未确认，请重启Pion后再删除')
          }
          this.markSubagentBackendGone(backend, false)
          await stopForHistory(backend.client)
          this.markSubagentBackendGone(backend, true) // guarded non-null real writer barrier above
        } catch (error) {
          backend.historyStopFailed = true
          backend.phase = 'error'
          this.unconfirmedStoppedWorktreeCwds ??= new Set<string>()
          this.unconfirmedStoppedWorktreeCwds.add(target)
          if (backend.sessionPath) {
            this.quarantinedSessionPaths ??= new Set<string>()
            this.quarantinedSessionPaths.add(resolve(backend.sessionPath))
          }
          throw error
        }
        // Remove records only after real process exit, even if owner changed while waiting.
        this.clearBackendToolPermissionRequests(backend.key)
        this.clearBackendExtensionUiRequests(backend.key)
        if (this.backendPool.get(backend.key) === backend) this.backendPool.delete(backend.key)
        if (backend.sessionPath) {
          const path = resolve(backend.sessionPath)
          if (this.backendKeysBySessionPath.get(path) === backend.key) this.backendKeysBySessionPath.delete(path)
          this.sessionManagers.delete(path)
          this.sessionManagerSignatures.delete(path)
        }
        await assertDeletionIdle()
      }
      const result = await commit()
      // A partial Git result is authoritative; do not disguise a completed removal as a failed operation.
      return result
    } finally {
      for (const backend of reserved) {
        backend.historyMutation = false
        backend.busy = false
      }
      this.branchDeletionInFlight = false
      this.historyRevision += 1
    }
  }

  /** Rewind conversation only, with exactly one writer and a durable SDK branch marker. */
  async revertMessage(request: MessageRevertRequest, ownerId: number): Promise<MessageRevertResult> {
    if (!this.win || this.win.webContents.id !== ownerId) throw new Error('只允许所属主窗口撤销消息')
    this.assertHistoryAvailable()
    if (!request || typeof request.sessionPath !== 'string' || !request.sessionPath || request.sessionPath.length > 16_000
      || typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 200
      || typeof request.entryId !== 'string' || !request.entryId || request.entryId.length > 200
      || (request.expectedLeafId !== null && (typeof request.expectedLeafId !== 'string'
        || !request.expectedLeafId || request.expectedLeafId.length > 200))) throw new Error('无效的消息撤销参数')
    const target = resolve(request.sessionPath)
    const backend = this.getActiveBackend()
    if (!backend || backend.phase !== 'running' || backend.historyStopFailed
      || this.activeSessionPath !== target || backend.sessionPath !== target) throw new Error('请等待所选会话就绪后再撤销')
    if (this.stopping || this.providerMutationInFlight || this.newSessionInFlight || this.sessionOperationsInFlight > 0
      || this.backendPool.pendingStartCount > 0
      || backend.busy || backend.compacting || backend.awaitingRetry || backend.activeRunId
      || backend.pendingRunIds.length > 0 || (backend.localFollowUps?.length ?? 0) > 0
      || (backend.companionRunIds?.length ?? 0) > 0 || (backend.directSteering?.length ?? 0) > 0
      || (backend.rawQueue?.steering.length ?? 0) > 0 || (backend.rawQueue?.followUp.length ?? 0) > 0
      || backend.localQueueDispatching || backend.localQueueDispatchPromise || backend.runCompletionPromise
      || backend.checkpointCreatePromise || backend.checkpointRefreshPromise || backend.subagentsModePending
      || this.runStore.hasUnsettledSessionRuns(target)
      || this.getPendingToolPermissionRequests().some((item) => item.sessionPath === target)
      || this.getPendingExtensionUiRequests().some((item) => item.sessionPath === target)) {
      throw new Error('请等待运行、压缩及收尾完成，并清空排队消息后再撤销')
    }
    const generation = this.sessionSelectionGeneration
    const assertOwner = (): void => {
      if (this.stopping || this.win?.webContents.id !== ownerId || this.activeKey !== backend.key
        || this.activeSessionPath !== target || generation !== this.sessionSelectionGeneration) {
        throw new Error('会话已切换，未撤销消息')
      }
    }
    this.messageRevertInFlight = true
    this.historyRevision += 1
    backend.historyMutation = true
    backend.busy = true // reserve against pool eviction; never mark this as an Agent run
    let writerStopped = false
    let stoppingWriter = false
    try {
      const [state, history] = await Promise.all([backend.client.getState(), backend.client.getEntries()])
      assertOwner()
      if (state.sessionId !== request.sessionId || !state.sessionFile || resolve(state.sessionFile) !== target
        || state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) throw new Error('会话状态已变化，请刷新后重试')
      const branch = sessionBranch(history.entries, history.leafId)
      const position = branch.findIndex((entry) => entry.id === request.entryId
        && entry.type === 'message' && entry.message.role === 'user')
      if (history.leafId !== request.expectedLeafId || position < 0) throw new Error('会话分支已变化，请刷新后重试')
      const mode = sessionMode(branch.slice(0, position))

      // RpcClient.stop() alone can resolve before SIGKILL has actually exited.
      // Do not use a second SessionManager writer until this stronger barrier.
      stoppingWriter = true
      this.markSubagentBackendGone(backend, false)
      await stopForHistory(backend.client)
      writerStopped = true
      this.clearBackendToolPermissionRequests(backend.key)
      this.clearBackendExtensionUiRequests(backend.key)
      if (this.backendPool.get(backend.key) === backend) this.backendPool.delete(backend.key)
      if (this.backendKeysBySessionPath.get(target) === backend.key) this.backendKeysBySessionPath.delete(target)
      this.sessionManagers.delete(target)
      this.sessionManagerSignatures.delete(target)
      assertOwner()
      // Synchronous revalidation + append: no selection/other host mutation can
      // interleave between the final identity check and the durable commit.
      const result = revertSessionMessage(request)
      // The same persisted parent can have retained children from several
      // process incarnations. Hide every existing incarnation only after the
      // durable commit, not the parent path: a new backend's children belong
      // to the new branch and must remain visible.
      const retained = this.subagentSessionStore?.list().sessions ?? []
      this.hiddenSubagentBackends ??= new Set()
      for (const session of retained) {
        if (session.parentSessionPath === target) this.hiddenSubagentBackends.add(session.backendId)
      }
      if (backend.liveState) this.hiddenSubagentBackends.add(backend.liveState.backendId)
      this.subagentVisibilityRevision = (this.subagentVisibilityRevision ?? 0) + 1
      this.pushSubagentSessions()
      // The commit is already durable; metadata or display refresh failure
      // must not turn it into failed undo and discard the restored draft.
      try {
        this.historyRevision += 1
        this.desiredModes.set(backend.key, mode)
        const latest = this.runStore.list({ sessionPath: target, metricsOnly: true, limit: 1 })[0]
        if (latest) this.runStore.update(latest.id, (run) => {
          run.contextTokens = undefined
          run.contextPressure = undefined
          run.contextUsagePending = true
          run.liveUsage = undefined
        }) // Historical billing and project-file checkpoints remain untouched.
        this.pushRunCheckpoint()
        this.pushRunningSessionPaths()
        await this.refresh()
      } catch (error) {
        console.warn('[pion] reverted history refresh failed:', error)
      }
      return result
    } catch (error) {
      if (stoppingWriter && !writerStopped) {
        // The SDK may have cleared its process pointer before actual exit. Do
        // not retry from a null pointer or start another writer for this path.
        backend.historyStopFailed = true
        this.quarantinedSessionPaths ??= new Set<string>()
        this.quarantinedSessionPaths.add(target)
        backend.phase = 'error'
        if (this.activeKey === backend.key) this.setStatus({ phase: 'error', cwd: backend.cwd,
          error: '无法确认 Agent 已退出；未修改会话。请重启 Pion 后再试。' })
      }
      throw error
    } finally {
      backend.historyMutation = false
      backend.busy = false
      this.messageRevertInFlight = false
      this.historyRevision += 1
      // Recreate only the idle session runtime (never a window or terminal).
      // Restores SDK context/tools/tasks from the selected persisted branch.
      if (writerStopped && !this.stopping && this.activeSessionPath === target && this.activeKey === backend.key) {
        void Promise.resolve().then(() => this.ensureActiveBackend())
          .then(() => this.pushSessionInfo()).catch(() => undefined)
      }
    }
  }

  /** Select a session and load its backend once, reusing it on later visits. */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    // Ordinary IPC switches are reserved by withSessionOperation. Keep the
    // existing selection fence for a lifecycle switch already admitted before
    // undo, while the destructive Git transaction rejects every direct switch.
    if (this.branchDeletionInFlight) throw new Error('正在删除分支，请稍后重试')
    if (this.sessionMigrationInFlight) throw new Error('正在迁移会话，请稍后重试')
    const generation = ++this.sessionSelectionGeneration
    const target = await this.resolveListedSession(sessionPath)
    if (generation !== this.sessionSelectionGeneration) return { cancelled: true }
    const manager = this.openSessionManager(target)
    if (this.unreadSessionPaths.delete(target)) this.pushUnreadSessions()
    this.activateLogicalSession(target, manager.getCwd() || this.activeCwd)
    // Activate the logical session synchronously, then warm its backend in the
    // background. The renderer can read the cached SessionManager immediately
    // instead of waiting for a fresh pi subprocess to boot.
    void this.ensureActiveBackend()
      .then(async () => {
        if (generation !== this.sessionSelectionGeneration || this.activeSessionPath !== target) return
        // Selection does not mutate the session index. Avoid rescanning every
        // project while the renderer is mounting a large conversation.
        await this.pushSessionInfo()
      })
      .catch(() => {
        // The status event contains the startup error for the active session.
      })
    return { cancelled: false }
  }

  /**
   * Resolve a session path without restricting it to the currently selected
   * project. The backend pool is global, so a session from another project or
   * worktree can be selected and reused as well.
   */
  private async resolveListedSession(sessionPath: string): Promise<string> {
    const requested = resolve(sessionPath)
    this.assertSessionNotQuarantined(requested)
    if (!(await pathExists(requested))) throw new Error('会话不存在')
    try {
      const manager = await this.openCurrentSessionManager(requested)
      if (!manager.getSessionFile()) throw new Error('会话文件无效')
    } catch {
      throw new Error('会话不存在')
    }
    return requested
  }

  private async interruptBackendRuns(backend: BackendRecord, message: string): Promise<void> {
    const runIds = new Set([
      backend.activeRunId,
      ...backend.pendingRunIds,
      ...(backend.companionRunIds ?? []),
      ...(backend.localFollowUps ?? []).map((item) => item.runId)
    ].filter((id): id is string => Boolean(id)))
    await Promise.all([...runIds].map(async (id) => {
      const run = this.runStore.get(id)
      if (!run) return
      if (run.state === 'queued') {
        if (run.interruptedAt !== undefined) return
        this.runStore.update(id, (current) => {
          current.interruptedAt = Date.now()
          current.error = current.error ?? message
        })
        return
      }
      await this.runStore.markInterrupted(id, message)
    }))
    await this.runStore.flush()
  }

  private async stopBackend(key: string): Promise<void> {
    this.assertHistoryAvailable()
    const backend = this.backendPool.get(key)
    if (!backend) return
    this.assertSessionNotQuarantined(backend.sessionPath)
    if (backend.historyStopFailed) throw new Error('旧 Agent 退出状态未知，请重启 Pion 后再操作此会话')
    await this.interruptBackendRuns(
      backend,
      'Agent 后端已停止；本轮及未发送的排队消息未自动重放。'
    )
    this.markSubagentBackendGone(backend, false)
    this.clearBackendToolPermissionRequests(key)
    this.clearBackendExtensionUiRequests(key)
    this.backendPool.delete(key)
    this.pushRunningSessionPaths()
    if (backend.sessionPath && this.backendKeysBySessionPath.get(resolve(backend.sessionPath)) === key) {
      this.backendKeysBySessionPath.delete(resolve(backend.sessionPath))
    }
    this.unconfirmedStoppedWorktreeCwds ??= new Set<string>()
    this.unconfirmedStoppedWorktreeCwds.add(resolve(backend.cwd))
    try {
      await backend.client.stop()
    } catch {
      // the subprocess may already be gone; nothing to recover
    }
  }

  async deleteSession(sessionPath: string): Promise<DeleteSessionResult> {
    const target = await this.resolveListedSession(sessionPath)
    const backendKey = this.backendKeysBySessionPath.get(target) ?? target
    await this.stopBackend(backendKey)
    const active = this.activeSessionPath === target

    this.assertSessionNotQuarantined(target)
    await unlink(target)
    this.deletedSubagentParentPaths ??= new Set()
    this.deletedSubagentParentPaths.add(target)
    this.subagentVisibilityRevision = (this.subagentVisibilityRevision ?? 0) + 1
    this.pushSubagentSessions()
    const ownerCwd = this.sessionManagers.get(target)?.getCwd()
    if (ownerCwd) this.sessionListCache?.invalidate(ownerCwd)
    const wasUnread = this.unreadSessionPaths.delete(target)
    if (wasUnread) this.pushUnreadSessions()
    await this.sessionModelPreferences?.deleteSessionModel(target)
    this.sessionManagers.delete(target)
    this.sessionManagerSignatures.delete(target)
    if (active) {
      this.activeSessionPath = undefined
      this.activeKey = this.newSessionKey(this.activeCwd ?? this.status.cwd ?? dirname(target))
      this.setStatus({ phase: 'ready', error: undefined, cwd: this.activeCwd })
      this.pushRunCheckpoint()
    }
    await this.pushSessionInfo()
    void this.refreshSidebarSessions()
    return { activeSessionChanged: active }
  }

  async copySession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const target = await this.resolveListedSession(sessionPath)
    this.sessionManagers.delete(target)
    this.sessionManagerSignatures.delete(target)
    const manager = this.openSessionManager(target)
    const leafId = manager.getLeafId()
    if (!leafId) return { cancelled: true }
    const path = manager.createBranchedSession(leafId)
    if (!path) return { cancelled: true }
    this.sessionListCache?.invalidate(manager.getCwd())
    await this.rememberTranscriptModel(path)
    this.activateLogicalSession(path, manager.getCwd())
    await this.pushSessionInfo()
    void this.refreshSidebarSessions()
    return { cancelled: false }
  }

  async getSessionForkMessages(sessionPath: string): Promise<ForkMessageOption[]> {
    const target = await this.resolveListedSession(sessionPath)
    const manager = this.openSessionManager(target)
    return manager.getEntries().flatMap((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'user') return []
      const text = messageText(entry.message as unknown as WireMessage)
      return text ? [{ entryId: entry.id, text }] : []
    })
  }

  async forkSession(
    sessionPath: string,
    entryId: string
  ): Promise<{ text: string; cancelled: boolean }> {
    const target = await this.resolveListedSession(sessionPath)
    this.sessionManagers.delete(target)
    this.sessionManagerSignatures.delete(target)
    const manager = this.openSessionManager(target)
    const result = this.createForkedSession(manager, entryId)
    await this.rememberTranscriptModel(result.path)
    this.activateLogicalSession(result.path, manager.getCwd())
    await this.pushSessionInfo()
    void this.refreshSidebarSessions()
    return { text: result.text, cancelled: false }
  }

  private async getActiveEntries(
    requestedSessionPath?: string
  ): Promise<{ entries: SessionEntry[]; leafId: string | null } | null> {
    const backend = this.getActiveBackend()
    try {
      if (requestedSessionPath) {
        const target = await this.resolveListedSession(requestedSessionPath)
        const manager = await this.openCurrentSessionManager(target)
        return { entries: manager.getEntries(), leafId: manager.getLeafId() }
      }
      const sessionPath = this.activeSessionPath ?? backend?.sessionPath
      if (sessionPath) {
        const manager = this.openSessionManager(sessionPath)
        return { entries: manager.getEntries(), leafId: manager.getLeafId() }
      }
      if (backend) {
        const { entries, leafId } = await backend.client.getEntries()
        return { entries, leafId }
      }
      return { entries: [], leafId: null }
    } catch {
      return null
    }
  }

  async getEntries(): Promise<{ entries: WireEntry[]; leafId: string | null } | null> {
    const result = await this.getActiveEntries()
    return result
      ? { entries: result.entries.map(toWireEntry), leafId: result.leafId }
      : null
  }

  async getHistoryIndex(sessionPath?: string): Promise<SessionHistoryIndex | null> {
    try {
      const backend = this.getActiveBackend()
      const target = sessionPath
        ? await this.resolveListedSession(sessionPath)
        : this.activeSessionPath ?? backend?.sessionPath
      if (!target) return null
      const manager = await this.openCurrentSessionManager(target)
      const entries = manager.getBranch()
      let ordinal = 0
      let pendingResponse = -1
      const landmarks: SessionHistoryIndex['landmarks'] = []
      entries.forEach((entry, entryIndex) => {
        if (entry.type !== 'message') return
        if (entry.message.role === 'user') {
          ordinal += 1
          const snippet = messageText(entry.message as unknown as WireMessage)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180)
          landmarks.push({
            entryId: entry.id,
            entryIndex,
            ordinal,
            snippet: snippet || '(空消息)',
            messageTimestamp: messageTimestamp(entry.message as unknown as WireMessage),
            timestamp: String(entry.timestamp)
          })
          pendingResponse = landmarks.length - 1
          return
        }
        if (entry.message.role !== 'assistant' || pendingResponse < 0) return
        const responseSnippet = messageText(entry.message as unknown as WireMessage)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220)
        if (!responseSnippet) return
        landmarks[pendingResponse] = { ...landmarks[pendingResponse], responseSnippet }
        pendingResponse = -1
      })
      return {
        sessionPath: resolve(target),
        leafId: manager.getLeafId(),
        totalEntries: entries.length,
        landmarks
      }
    } catch {
      return null
    }
  }

  async getSessionTaskHistory(sessionPath: string): Promise<SessionTaskRun[]> {
    const target = await this.resolveListedSession(sessionPath)
    const manager = await this.openCurrentSessionManager(target)
    const events: SessionTaskHistoryEvent[] = []

    for (const entry of manager.getBranch()) {
      const customSnapshot = taskHistorySnapshotFromEntry(entry)
      if (customSnapshot !== undefined) {
        events.push({ kind: 'snapshot', ...customSnapshot })
        continue
      }
      if (entry.type !== 'message') continue
      if (entry.message.role === 'user') {
        events.push({
          kind: 'user',
          key: entry.id,
          entryId: entry.id,
          prompt: messageText(entry.message as unknown as WireMessage),
          timestamp: String(entry.timestamp)
        })
        continue
      }
      if (entry.message.role !== 'toolResult') continue
      const message = entry.message as unknown as { toolName?: unknown }
      const snapshot = taskHistorySnapshotFromResult(message.toolName, message)
      if (snapshot !== undefined) events.push({ kind: 'snapshot', ...snapshot })
    }

    return deriveSessionTaskRuns(events)
  }

  async getEntriesPage(
    before?: number,
    limit = 160,
    sessionPath?: string
  ): Promise<SessionEntriesPage | null> {
    const result = await this.getActiveEntries(sessionPath)
    if (!result) return null
    result.entries = sessionBranch(result.entries, result.leafId)

    const total = result.entries.length
    const end = typeof before === 'number' && Number.isFinite(before)
      ? Math.min(Math.max(Math.trunc(before), 0), total)
      : total
    const pageSize = Math.min(Math.max(Math.trunc(limit) || 160, 1), 240)
    let sliceEnd = end
    if (before === undefined) {
      // Only the implicit latest window omits a non-displayable tail. Cursor
      // positions remain physical branch-entry offsets: end still covers that
      // tail, so omitted metadata does not look like another forward page.
      while (sliceEnd > 0) {
        const entry = result.entries[sliceEnd - 1]
        if (entry.type === 'compaction' && typeof entry.summary === 'string') break
        if (entry.type === 'message') {
          const message = entry.message as unknown as WireMessage
          if (message.role === 'user') break
          if (message.role === 'assistant') {
            const error = message.stopReason === 'error'
              || (message.stopReason === undefined && typeof message.errorMessage === 'string'
                && message.errorMessage.trim() !== ''
                && !/^request (?:was )?aborted[.!]?$/i.test(message.errorMessage.trim()))
            const rootCall = messageToolCalls(message).some((call) =>
              typeof call.id === 'string' && typeof call.name === 'string'
              && typeof (call as unknown as Record<string, unknown>).parentToolCallId !== 'string')
            if (messageText(message) !== '' || messageThinking(message) !== '' || error || rootCall) break
          }
        }
        sliceEnd--
      }
    }
    const start = Math.max(0, sliceEnd - pageSize)
    const entries = result.entries.slice(start, sliceEnd)
    const toolResults = filterToolResults(result.entries, toolCallIds(entries))

    return {
      entries: entries.map(toWireEntry),
      toolResults: toolResults.map(toWireEntry),
      start,
      end,
      total,
      leafId: result.leafId,
      mode: sessionMode(result.entries),
      taskSnapshot: sessionTasks(result.entries, result.leafId)
    }
  }

  async getTree(): Promise<PushedTree | null> {
    const backend = this.getActiveBackend()
    try {
      const result = backend?.phase === 'running'
        ? await backend.client.getTree()
        : this.activeSessionPath
          ? (() => {
              const manager = this.openSessionManager(this.activeSessionPath as string)
              return { tree: manager.getTree(), leafId: manager.getLeafId() }
            })()
          : { tree: [], leafId: null }
      return { tree: result.tree.map(toTreeNodeLite), leafId: result.leafId }
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- commands & modes

  async getCommands(): Promise<SlashCommandInfo[]> {
    const merged = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]))
    const backend = await this.waitForActiveBackend()
    if (!backend) return [...merged.values()]
    try {
      const commands = await backend.client.getCommands()
      for (const { name, description, source } of commands) {
        if (!merged.has(name)) merged.set(name, { name, description, source })
      }
    } catch {
      // Built-ins remain available even while extension command discovery fails.
    }
    return [...merged.values()]
  }

  async setYoloMode(enabled: boolean): Promise<void> {
    const key = this.activeKey
    if (!key) throw new Error('没有活动会话')
    if (enabled) this.yoloSessions.add(key)
    else this.yoloSessions.delete(key)
    void this.pushSessionInfo()
  }

  private clearSubagentPermissions(backend: BackendRecord): void {
    for (const request of this.getPendingToolPermissionRequests()) {
      const pending = this.pendingRequests.getToolPermission(request.id)
      if (!request.subagent || pending?.backendKey !== backend.key) continue
      this.respondToExtensionUi(backend.client, pending.extensionRequestId, { value: 'deny' })
      this.clearToolPermissionRequest(request.id)
    }
  }

  async setSubagentsMode(enabled: boolean, sessionId: string, ownerId: number): Promise<void> {
    this.assertHistoryAvailable()
    if (this.win?.webContents.id !== ownerId) throw new Error('只允许所属主窗口切换子代理')
    if (typeof enabled !== 'boolean' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('子代理开关参数无效')
    const backend = this.getActiveBackend()
    if (!backend) throw new Error('会话尚未就绪')
    if (backend.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
    if (backend.subagentsModePending) throw new Error('子代理开关正在切换')
    backend.subagentsModePending = true
    try {
      await backend.startPromise
      const client = backend.client
      const generation = this.dispatchLifecycle(backend).generation
      const [state, commands] = await Promise.all([client.getState(), client.getCommands()])
      if (!this.backendStillOwned(backend) || backend.client !== client
        || this.dispatchLifecycle(backend).generation !== generation) throw new Error('会话运行状态已改变，请重试')
      if (this.activeKey !== backend.key || state.sessionId !== sessionId) throw new Error('会话已切换，请重试')
      if (enabled && (backend.busy || backend.compacting || state.isStreaming || state.isCompacting)) throw new Error('请等待当前执行完成后开启子代理')
      if (enabled && this.desiredModes.get(backend.key) === 'plan') throw new Error('计划模式不启用编码子代理')
      if (!commands.some((command) => command.name === 'pion-subagents')) throw new Error('当前运行时不支持内置子代理')
      await client.prompt(enabled ? '/pion-subagents on' : '/pion-subagents off')
      if (!this.backendStillOwned(backend) || backend.client !== client) return
      backend.subagentsEnabled = enabled
      if (!enabled) this.clearSubagentPermissions(backend)
      if (this.activeKey === backend.key) await this.pushSessionInfo()
    } finally {
      backend.subagentsModePending = false
    }
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.assertHistoryAvailable()
    const key = this.activeKey
    if (!key) throw new Error('没有活动会话')
    const backend = this.getActiveBackend()
    if (!backend) {
      this.desiredModes.set(key, mode)
      return
    }
    if (backend.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
    await backend.startPromise
    const lease = this.reserveDispatch(backend)
    const currentState = await backend.client.getState().catch(() => null)
    this.assertDispatchLease(lease)
    this.assertHistoryAvailable()
    if (
      backend.busy
      || backend.compacting
      || backend.localQueueDispatching
      || backend.runCompletionPromise
      || (backend.localFollowUps?.length ?? 0) > 0
      || currentState?.isStreaming
      || currentState?.isCompacting
    ) {
      throw new Error('当前会话正在运行，请等待完成或中止后再切换工作模式')
    }
    backend.busy = true
    try {
      const commands = await backend.client.getCommands()
      this.assertDispatchLease(lease)
      if (!commands.some((command) => command.name === 'plan')) {
        throw new Error('Pion 计划模式未加载')
      }
      await backend.client.prompt(mode === 'plan' ? '/plan start' : '/plan exit')
      this.assertDispatchLease(lease)
      this.desiredModes.set(key, mode)
      backend.modePrimed = mode
    } finally {
      // A command can launch independent extension work. Its events own busy,
      // even if the command's own disposition is handled.
      if (lease.owns()) {
        backend.busy = false
      }
      if (this.backendStillOwned(backend) && !backend.busy && !backend.compacting && !backend.localQueueDispatching && !backend.localQueueBlocked && !backend.runCompletionPromise && (backend.localFollowUps?.length ?? 0) > 0) {
        this.dispatchNextLocalFollowUp(backend)
      }
    }
  }

  // ---------------------------------------------------------------- models

  private async readBackendModels(backend: BackendRecord): Promise<ModelOption[]> {
    const models = await backend.client.getAvailableModels()
    const options = models.map((model) => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning
    }))
    return options
  }

  async getModels(): Promise<ModelOption[]> {
    const generation = this.sessionSelectionGeneration
    const key = this.activeKey
    const backend = await this.waitForActiveBackend()
    if (!backend) return []
    const client = backend.client
    const owned = () => generation === this.sessionSelectionGeneration && key === this.activeKey
      && this.getActiveBackend() === backend && backend.client === client
    let models: ModelOption[]
    try {
      models = await this.readBackendModels(backend)
    } catch {
      return []
    }
    // A malformed shell preference is not evidence that the SDK has no models.
    // Surface the read error without replacing configuration or active models.
    if (!owned()) return []
    return this.providerVisibility ? this.providerVisibility.filterModels(models) : models
  }

  // Page deadlines stop waiting, not SDK initialization. Keep the actual read
  // shared until it settles, including across window/renderer replacements.
  private subagentModelsRead: Promise<ModelOption[]> | null = null

  async getSubagentModels(ownerId: number): Promise<ModelOption[]> {
    const capturedWindow = this.win
    const assertOwner = (): void => {
      if (!capturedWindow || this.win !== capturedWindow || capturedWindow.webContents.id !== ownerId
        || capturedWindow.isDestroyed?.() || capturedWindow.webContents.isDestroyed?.()) {
        throw new Error('只允许所属主窗口读取子代理模型目录')
      }
    }
    assertOwner()
    if (!this.subagentModelsRead) {
      if (!this.providerMutationInFlight) this.providerAuthService.invalidate()
      const pending = this.providerAuthService.listAvailableModels()
      this.subagentModelsRead = pending
      const clear = () => { if (this.subagentModelsRead === pending) this.subagentModelsRead = null }
      void pending.then(clear, clear)
    }
    const models = await this.subagentModelsRead
    assertOwner()
    return models
  }

  async getModelProviders(): Promise<ModelProviderInfo[]> {
    if (!this.providerMutationInFlight) this.providerAuthService.invalidate()
    const providers = await this.providerAuthService.listProviders()
    return this.providerVisibility ? this.providerVisibility.projectProviders(providers) : providers
  }

  async setModelProviderEnabled(providerId: string, enabled: boolean, ownerId: number): Promise<ModelProviderInfo[]> {
    const assertOwner = (): void => {
      if (!this.win || this.win.webContents.id !== ownerId || this.win.isDestroyed?.() || this.win.webContents.isDestroyed?.()) {
        throw new Error('只允许所属主窗口设置提供商显示')
      }
    }
    assertOwner()
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}(?![\s\S])/.test(providerId)
      || typeof enabled !== 'boolean') throw new Error('提供商显示设置无效')
    if (!this.providerVisibility) throw new Error('提供商显示设置未接入')
    const providers = await this.getModelProviders()
    assertOwner()
    if (!providers.some((provider) => provider.id === providerId)) throw new Error('提供商不存在')
    // No provider mutation/reload, SDK enablement, credential change or model fallback.
    await this.providerVisibility.setEnabled(providerId, enabled)
    assertOwner()
    return this.getModelProviders()
  }

  private beginProviderMutation(): void {
    this.assertHistoryAvailable()
    if (this.providerMutationInFlight) {
      throw new Error('已有提供商配置或认证操作正在进行')
    }
    const reloadBlocked = this.backendPool.pendingStartCount > 0 || [...this.backendPool.values()].some((backend) => (
      backend.phase === 'starting'
      || backend.busy
      || backend.compacting
      || backend.pendingRunIds.length > 0
    ))
    if (reloadBlocked) {
      throw new Error('仍有会话正在运行，请等待所有后台会话完成后再修改提供商')
    }
    this.providerMutationInFlight = true
  }

  private async reloadBackendsAfterProviderMutation(): Promise<ModelOption[]> {
    await Promise.all([...this.backendPool.keys()].map((key) => this.stopBackend(key)))
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) return []
    if (!this.activeKey) this.activeKey = this.newSessionKey(cwd)
    this.setStatus({ phase: 'starting', error: undefined, cwd })
    this.providerReloading = true
    try {
      const backend = await this.ensureActiveBackend()
      const models = await this.readBackendModels(backend)
      await this.pushSessionInfo()
      return this.providerVisibility ? await this.providerVisibility.filterModels(models) : models
    } finally {
      this.providerReloading = false
    }
  }

  async loginModelProvider(
    providerId: string,
    authType: ModelProviderAuthType
  ): Promise<ModelProviderInfo[]> {
    this.beginProviderMutation()
    const operation: ProviderAuthOperation = {
      id: randomUUID(),
      controller: new AbortController()
    }
    this.providerAuthOperation = operation
    let authenticated = false
    try {
      const provider = (await this.providerAuthService.listProviders())
        .find((candidate) => candidate.id === providerId.trim())
      if (!provider) throw new Error(`未知提供商：${providerId}`)
      this.setModelProviderAuthState({
        operationId: operation.id,
        providerId: provider.id,
        providerName: provider.name,
        authType,
        phase: 'starting',
        message: '正在启动 Pi 提供商认证...',
        startedAt: Date.now()
      })

      await this.providerAuthService.login(provider.id, authType, {
        signal: operation.controller.signal,
        prompt: (prompt) => this.providerAuthUi.prompt(operation, provider.name, prompt),
        notify: (event) => this.providerAuthUi.handleEvent(
          operation,
          provider.id,
          provider.name,
          authType,
          event
        )
      })
      if (operation.controller.signal.aborted) throw new Error('提供商认证已取消')
      authenticated = true
      await this.reloadBackendsAfterProviderMutation()
      this.setModelProviderAuthState({
        operationId: operation.id,
        providerId: provider.id,
        providerName: provider.name,
        authType,
        phase: 'success',
        message: '认证成功，Pi 模型列表已重新加载。',
        startedAt: this.providerAuthUi.getState()?.startedAt ?? Date.now()
      })
      return await this.providerAuthService.listProviders()
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error)
      const cancelled = operation.controller.signal.aborted || originalMessage.includes('取消')
      const message = cancelled
        ? '提供商认证已取消。'
        : authenticated
          ? `认证已保存，但重新加载 Agent 失败：${originalMessage}`
          : originalMessage
      const current = this.providerAuthUi.getState()
      this.setModelProviderAuthState({
        operationId: operation.id,
        providerId: current?.operationId === operation.id ? current.providerId : providerId.trim(),
        providerName: current?.operationId === operation.id ? current.providerName : providerId.trim(),
        authType,
        phase: cancelled ? 'cancelled' : 'error',
        message,
        startedAt: current?.operationId === operation.id ? current.startedAt : Date.now()
      })
      throw new Error(message)
    } finally {
      this.clearProviderAuthUiRequests(operation.id)
      if (this.providerAuthOperation?.id === operation.id) this.providerAuthOperation = null
      this.providerMutationInFlight = false
    }
  }

  async logoutModelProvider(providerId: string): Promise<ModelProviderInfo[]> {
    this.beginProviderMutation()
    try {
      await this.providerAuthService.logout(providerId)
      await this.reloadBackendsAfterProviderMutation()
      this.setModelProviderAuthState(null)
      return await this.providerAuthService.listProviders()
    } finally {
      this.providerMutationInFlight = false
    }
  }

  /** Persist a custom Pi provider and restart idle retained backends to load it. */
  async addModelProvider(input: AddModelProviderInput): Promise<ModelOption[]> {
    this.beginProviderMutation()
    try {
      await this.providerConfigStore.addProvider(input)
      this.providerAuthService.invalidate()
      return await this.reloadBackendsAfterProviderMutation()
    } finally {
      this.providerMutationInFlight = false
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.assertHistoryAvailable()
    const generation = this.sessionSelectionGeneration
    const cwd = this.activeCwd
    const key = this.activeKey
    const backend = await this.ensureActiveBackend()
    const client = backend.client
    const assertOwner = () => {
      this.assertHistoryAvailable()
      if (generation !== this.sessionSelectionGeneration || cwd !== this.activeCwd
        || (key && key !== this.activeKey) || this.getActiveBackend() !== backend || backend.client !== client) {
        throw new Error('会话已切换，未更新当前会话模型')
      }
    }
    assertOwner()
    await client.setModel(provider, modelId)
    assertOwner()
    if (this.sessionModelPreferences) {
      const state = await client.getState()
      assertOwner()
      const sessionPath = state.sessionFile ?? backend.sessionPath
      if (sessionPath) {
        await this.sessionModelPreferences.setSessionModel(sessionPath, { provider, modelId })
        assertOwner()
      }
    }
    await this.refresh()
  }

  async getSkills(): Promise<SkillInfo[]> {
    const backend = await this.waitForActiveBackend()
    if (!backend) return []
    try {
      const commands = await backend.client.getCommands()
      return commands
        .filter((command) => command.source === 'skill')
        .map((command) => ({
          name: command.name.replace(/^skill:/, ''),
          description: command.description,
          source: command.sourceInfo?.source
        }))
    } catch {
      return []
    }
  }

  /** Discover skills and extension tools from the same package loader Pi uses. */
  async getCapabilities(): Promise<AgentCapabilities> {
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) return { skills: [], tools: [] }
    const trust = this.getProjectTrust(cwd)
    return loadAgentCapabilities(cwd, trust.decision === 'trusted')
  }

  async getThinkingLevels(): Promise<string[]> {
    const backend = await this.waitForActiveBackend()
    if (!backend) return []
    try {
      return await backend.client.getAvailableThinkingLevels()
    } catch {
      return []
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
    const backend = await this.ensureActiveBackend()
    type ThinkingLevelParam = Parameters<RpcClient['setThinkingLevel']>[0]
    await backend.client.setThinkingLevel(level as ThinkingLevelParam)
    await this.refresh()
  }

  // ---------------------------------------------------------------- agent settings

  async setAutoCompaction(enabled: boolean): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    await this.client.setAutoCompaction(enabled)
    await this.refresh()
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    await this.client.setAutoRetry(enabled)
  }

  async compactNow(customInstructions?: string): Promise<void> {
    this.assertHistoryAvailable()
    const client = this.client
    if (!client) throw new Error('agent 未启动')
    await client.compact(customInstructions?.trim() || undefined)
    const backend = this.getActiveBackend()
    if (
      backend
      && !backend.busy
      && !backend.compacting
      && !backend.localQueueBlocked
      && !backend.runCompletionPromise
      && (backend.localFollowUps?.length ?? 0) > 0
    ) {
      this.dispatchNextLocalFollowUp(backend)
    }
    await this.refresh()
  }

  async exportSessionHtml(): Promise<string> {
    if (!this.client) throw new Error('agent 未启动')
    const result = await this.client.exportHtml()
    return result.path
  }

  async renameSession(name: string, sessionPath?: string): Promise<void> {
    this.assertHistoryAvailable()
    if (typeof name !== 'string') throw new Error('会话名称无效')
    const normalizedName = name.replace(/[\r\n]+/g, ' ').trim()
    if (!normalizedName) throw new Error('会话名称不能为空')
    if (normalizedName.length > 120) throw new Error('会话名称不能超过 120 个字符')

    if (!sessionPath) {
      const backend = this.getActiveBackend()
      if (!backend) throw new Error('agent 未启动')
      if (backend.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
      await backend.startPromise
      this.assertHistoryAvailable()
      await backend.client.setSessionName(normalizedName)
      await this.syncBackendSession(backend)
      await this.pushSessionInfo()
      void this.refreshSidebarSessions()
      return
    }

    const target = await this.resolveListedSession(sessionPath)
    const backendKey = this.backendKeysBySessionPath.get(target) ?? target
    const backend = this.backendPool.get(backendKey)
    const ownerCwd = this.sessionManagers.get(target)?.getCwd() ?? backend?.cwd
    this.assertHistoryAvailable()
    if (backend) {
      if (backend.historyStopFailed) throw new Error('无法确认旧 Agent 已退出，请重启 Pion 后再使用此会话')
      await backend.startPromise
      this.assertHistoryAvailable()
      await backend.client.setSessionName(normalizedName)
      this.sessionManagers.delete(target)
      this.sessionManagerSignatures.delete(target)
    } else {
      const manager = this.openSessionManager(target)
      manager.appendSessionInfo(normalizedName)
      this.sessionManagers.set(target, manager)
      this.sessionManagerSignatures.delete(target)
    }

    if (ownerCwd) this.sessionListCache?.invalidate(ownerCwd)
    if (this.activeSessionPath === target) await this.pushSessionInfo()
    void this.refreshSidebarSessions()
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    await this.client.setSteeringMode(mode)
    await this.refresh()
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    await this.client.setFollowUpMode(mode)
    await this.refresh()
  }

  // ---------------------------------------------------------------- git branches / worktrees

  async listBranches(cwd: string): Promise<BranchInfo[]> {
    return listBranchInfos(cwd)
  }

  async createBranch(cwd: string, branchName: string): Promise<BranchInfo> {
    return createWorktreeBranch(cwd, branchName)
  }

  async renameBranch(cwd: string, oldBranchName: string, newBranchName: string): Promise<BranchInfo> {
    return renameGitBranch(cwd, oldBranchName, newBranchName)
  }

  // ---------------------------------------------------------------- sessions list

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const dir = cwd ?? this.status.cwd
    if (!dir) return []
    this.sessionListCache ??= new SessionListCache(async (directory) => {
      const infos = await SessionManager.list(directory)
      const dir = directory
      // SDK session-directory encoding can collide (for example a-b vs a/b).
      // The persisted header, not the queried bucket or project group, owns a
      // session. Never relabel another worktree's history as this directory.
      const sessions: SessionMeta[] = infos.filter((info) => typeof info.cwd === 'string' && info.cwd.length > 0 && resolve(info.cwd) === resolve(dir)).map((info) => ({
        projectCwd: resolve(dir),
        path: info.path,
        id: info.id,
        name: info.name,
        timestamp: info.created instanceof Date ? info.created.toISOString() : String(info.created),
        mtime: info.modified instanceof Date ? info.modified.getTime() : Date.parse(String(info.modified)) || 0,
        preview: (info.firstMessage ?? '').slice(0, 120),
        messageCount: info.messageCount
      }))
      // Within the existing exact-cwd scan cache, never on the token hot path.
      // Bound per-directory disk readers; malformed/large/growing files are unknown.
      let next = 0
      await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
        while (next < sessions.length) {
          const session = sessions[next++]!
          const total = await readSessionTokenTotal(session.path, { id: session.id, cwd: dir })
          if (total !== undefined) session.totalTokens = total
        }
      }))
      return sessions
    })
    return this.sessionListCache.list(dir)
  }

  // ---------------------------------------------------------------- state

  async getSessionInfo(): Promise<SessionInfo | null> {
    const backend = this.getActiveBackend()
    const revision = this.historyRevision
    const generation = this.sessionSelectionGeneration
    const info = await this.getSessionInfoSnapshot()
    if (backend !== this.getActiveBackend()
      || (backend && this.backendPool.get(backend.key) !== backend)
      || revision !== this.historyRevision || generation !== this.sessionSelectionGeneration) return null
    if (info && backend && (info.liveState?.revision !== backend.liveState?.revision
      || info.liveState?.cwd !== backend.cwd || info.liveState?.sessionPath !== backend.sessionPath)) {
      info.liveState = backend.liveState?.snapshot(backend.cwd, backend.sessionPath)
      // The refreshed replay fence also fences lifecycle flags: never pair new
      // agent_start/settled events with the earlier RPC's busy/compacting state.
      info.isStreaming = backend.busy
      info.isCompacting = backend.compacting
    }
    if (info) info.subagentsEnabled = backend?.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED
    if (info) info.yolo = this.activeKey ? this.yoloSessions.has(this.activeKey) : false
    return info
  }

  private async getSessionInfoSnapshot(): Promise<SessionInfo | null> {
    const backend = this.getActiveBackend()
    try {
      if (backend?.phase === 'running') return await this.toSessionInfo(backend)
      // Do not wait for extension/model initialization to describe persisted history.
      // A fresh session without a real SDK id has no snapshot yet.
      if (!this.activeSessionPath) return null
      const info = await this.readPersistedSessionInfo(this.activeSessionPath)
      return backend ? this.overlayBackendSessionInfo(backend, info) : info
    } catch {
      return null
    }
  }

  private async readPersistedSessionInfo(sessionPath: string): Promise<SessionInfo> {
    const manager = await this.openCurrentSessionManager(sessionPath)
    const context = manager.buildSessionContext()
    const preference = this.sessionModelPreferences?.getSessionModel(sessionPath)
    const model = context.messages.length === 0
      ? preference ?? context.model
      : context.model ?? preference
    return {
      provider: model?.provider,
      model: model?.modelId,
      modelId: model?.modelId,
      thinkingLevel: context.thinkingLevel,
      isStreaming: false,
      isCompacting: false,
      sessionFile: manager.getSessionFile(),
      sessionId: manager.getSessionId(),
      sessionName: manager.getSessionName(),
      messageCount: context.messages.length,
      pendingMessageCount: 0
    }
  }

  private overlayBackendSessionInfo(backend: BackendRecord, info: SessionInfo): SessionInfo {
    return {
      ...info,
      queuePause: backend.queuePause ? { ...backend.queuePause } : undefined,
      isStreaming: backend.busy,
      isCompacting: backend.compacting,
      liveState: backend.liveState?.snapshot(backend.cwd, backend.sessionPath)
    }
  }

  private async toSessionInfo(backend: BackendRecord): Promise<SessionInfo | null> {
    this.sessionInfoQueries ??= new WeakMap()
    this.sessionInfoSnapshots ??= new WeakMap()
    let query = this.sessionInfoQueries.get(backend)
    if (!query) {
      query = this.querySessionInfo(backend)
      this.sessionInfoQueries.set(backend, query)
      const release = () => {
        if (this.sessionInfoQueries?.get(backend) === query) this.sessionInfoQueries?.delete(backend)
      }
      // No timer can release this slot: getState still has its own SDK deadline.
      void query.then(release, release)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000) })
    let info: SessionInfo | null
    try {
      info = await Promise.race([query, timeout])
    } catch {
      info = null
    } finally {
      clearTimeout(timer)
    }
    if (info) return { ...info }
    if (this.backendPool.get(backend.key) !== backend) return null
    const cached = this.sessionInfoSnapshots.get(backend)
    if (cached && cached.revision === this.historyRevision && cached.sessionPath === backend.sessionPath) {
      return this.overlayBackendSessionInfo(backend, cached.info)
    }
    if (!backend.sessionPath) return null
    return this.overlayBackendSessionInfo(backend, await this.readPersistedSessionInfo(backend.sessionPath))
  }

  private async querySessionInfo(backend: BackendRecord): Promise<SessionInfo | null> {
    const revision = this.historyRevision
    const sessionPath = backend.sessionPath
    const lifecycle = this.dispatchLifecycle(backend).generation
    const busy = backend.busy
    const compacting = backend.compacting
    const state = await backend.client.getState()
    // Late results may warm this backend's cache, but never publish STATE.
    // The caller separately fences active selection and history revisions.
    if (this.backendPool.get(backend.key) !== backend
      || revision !== this.historyRevision || sessionPath !== backend.sessionPath) return null
    const model = state.model
    const lifecycleChanged = lifecycle !== this.dispatchLifecycle(backend).generation
      || busy !== backend.busy || compacting !== backend.compacting
    const info: SessionInfo = {
      provider: model?.provider,
      model: model?.name ?? model?.id,
      modelId: model?.id,
      thinkingLevel: state.thinkingLevel,
      isStreaming: lifecycleChanged ? backend.busy : state.isStreaming || backend.busy,
      isCompacting: lifecycleChanged ? backend.compacting : state.isCompacting || backend.compacting,
      sessionFile: state.sessionFile,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      autoCompactionEnabled: state.autoCompactionEnabled,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      messageCount: state.messageCount,
      pendingMessageCount: state.pendingMessageCount,
      queuePause: backend.queuePause ? { ...backend.queuePause } : undefined,
      liveState: backend.liveState?.snapshot(backend.cwd, backend.sessionPath)
    }
    this.sessionInfoSnapshots?.set(backend, { revision, sessionPath, info })
    return info
  }

  private async pushSessionInfo(): Promise<void> {
    const generation = this.sessionSelectionGeneration
    const backend = this.getActiveBackend()
    const revision = this.historyRevision
    const activeKey = this.activeKey
    const activeSessionPath = this.activeSessionPath
    const info = await this.getSessionInfo()
    if (revision !== this.historyRevision || generation !== this.sessionSelectionGeneration
      || this.getActiveBackend() !== backend || (backend && this.backendPool.get(backend.key) !== backend)
      || this.activeKey !== activeKey || this.activeSessionPath !== activeSessionPath) return
    this.win?.webContents.send(STATE_CHANNEL, info)
  }

  private async refreshSidebarSessions(invalidate = true): Promise<void> {
    const cwd = this.status.cwd
    if (invalidate && cwd) this.sessionListCache?.invalidate(cwd)
    try {
      const sessions = await this.listSessions(cwd)
      if (this.status.cwd !== cwd) return
      this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
    } catch (error) {
      // Retain the renderer's last known rows; a failed scan is not zero sessions.
      console.warn('[pion] sidebar session refresh failed:', error)
    }
  }

  /** Push state + session list + branch tree to the renderer. */
  private async refresh(): Promise<void> {
    const generation = this.sessionSelectionGeneration
    const backend = this.getActiveBackend()
    const revision = this.historyRevision
    const activeKey = this.activeKey
    const activeSessionPath = this.activeSessionPath
    const activeCwd = this.activeCwd
    const [info, sessions, tree] = await Promise.all([
      this.getSessionInfo(),
      this.listSessions(),
      this.getTree()
    ])
    // A slow response from the previous backend must never overwrite the
    // state of a session selected while the refresh was in flight.
    if (
      revision !== this.historyRevision ||
      generation !== this.sessionSelectionGeneration ||
      this.getActiveBackend() !== backend ||
      (backend && this.backendPool.get(backend.key) !== backend) ||
      this.activeKey !== activeKey ||
      this.activeSessionPath !== activeSessionPath ||
      this.activeCwd !== activeCwd
    ) return
    this.win?.webContents.send(STATE_CHANNEL, info)
    this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
    this.win?.webContents.send(TREE_CHANNEL, tree)
  }
}
