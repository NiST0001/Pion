import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
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
import { messageText } from '../../shared/types'
import {
  deriveSessionTaskRuns,
  isTaskToolName,
  normalizeSessionTasks
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
import { applyBackendEvent } from './backend-events'
import { PendingRequestStore } from './pending-requests'
import { projectQueueSnapshot } from './queue-projection'
import { ProviderAuthUi } from './provider-auth-ui'
import type { SessionModelPreferenceStore } from '../app-settings'
import { ProviderConfigStore } from '../provider-config'
import { ProviderAuthService } from '../provider-auth'
import { loadAgentCapabilities } from './capabilities'
import { restoreSessionModelPreference } from './session-preferences'
import {
  filterToolResults,
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
  private stopping = false
  private readonly backendKeysBySessionPath = new Map<string, string>()
  private readonly desiredModes = new Map<string, AgentMode>()
  /** Sessions whose latest completed run the user has not opened yet. */
  private readonly unreadSessionPaths = new Set<string>()
  /** Sessions whose tool-permission prompts are auto-approved (yolo mode). */
  private readonly yoloSessions = new Set<string>()
  private readonly sessionManagers = new Map<string, SessionManager>()
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
    private readonly providerAuthService = new ProviderAuthService()
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

  /** Compatibility accessor for methods that operate on the selected session. */
  private get client(): RpcClient | null {
    return this.getActiveBackend()?.client ?? null
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

    let policy: ProjectToolPermissionPolicy | null = null
    if (resolution === 'allow-project') {
      policy = await this.toolPermissionStore.allowProjectCategories(
        pending.request.cwd,
        pending.request.policyCategories
      )
    }

    const backend = this.backendPool.get(pending.backendKey)
    if (!backend) {
      this.clearToolPermissionRequest(requestId)
      throw new Error('发起请求的 Agent 会话已关闭')
    }
    this.respondToExtensionUi(backend.client, pending.extensionRequestId, { value: resolution })
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
    if (!backend) {
      this.clearExtensionUiRequest(requestId)
      throw new Error('发起请求的 Agent 会话已关闭')
    }
    this.respondToExtensionUi(backend.client, pending.extensionRequestId, response)
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

    // Silent checkpoint gate: create the run checkpoint before the first
    // write-capable tool executes, then release the tool immediately.
    if (request.title === RUN_CHECKPOINT_MARKER) {
      void this.ensureRunCheckpoint(backend)
        .catch((error: unknown) => {
          console.error('[pion] lazy checkpoint failed:', error)
        })
        .finally(() => {
          this.respondToExtensionUi(backend.client, request.id as string, { value: 'ready' })
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
        summary: parsed.subagent ? `子 Agent · ${parsed.summary}` : parsed.summary,
        ...(parsed.subagent ? { subagent: true } : {}),
        detail: parsed.detail,
        risks: parsed.risks,
        canRemember: parsed.canRemember,
        createdAt,
        timeoutAt: createdAt + timeoutMs
      }
      const timeout = setTimeout(() => {
        this.clearToolPermissionRequest(id)
      }, timeoutMs + 250)
      this.pendingRequests.addToolPermission(id, {
        request: permissionRequest,
        backendKey: backend.key,
        extensionRequestId: request.id,
        timeout
      })
      this.notifyToolPermissionRequested(permissionRequest)
      this.pushToolPermissionRequests()
    } catch (error) {
      console.error('[pion] invalid tool permission request:', error)
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

    const cancelInvalidRequest = (message: string): true => {
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
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1_000), EXTENSION_UI_TIMEOUT_MS)
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
      timeoutAt: createdAt + timeoutMs
    }
    const timeout = setTimeout(() => {
      const pending = this.pendingRequests.getExtensionUi(id)
      if (!pending) return
      try {
        this.respondToExtensionUi(backend.client, pending.extensionRequestId, { cancelled: true })
      } catch (error) {
        console.error('[pion] failed to time out extension UI request:', error)
      }
      this.clearExtensionUiRequest(id)
    }, timeoutMs)
    this.pendingRequests.addExtensionUi(id, {
      request,
      backendKey: backend.key,
      extensionRequestId: source.id,
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
      backend.runCompletionPromise = undefined
      // RpcClient.prompt resolves once the request is written, before
      // agent_start arrives. Reserve the backend during that dispatch gap so
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
    this.resetRunCheckpoint(backend)
    this.runStore.update(runId, (run) => {
      run.state = 'dispatching'
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

  private trackBackendEvent(backend: BackendRecord, event: unknown, type: string | undefined): void {
    if (!type) return
    if (type === 'agent_start') {
      if (!backend.activeRunId) backend.activeRunId = backend.pendingRunIds.shift()
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
    const runId = backend.activeRunId ?? (type === 'compaction_end' && backend.sessionPath
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
      if (typeof tool.toolCallId !== 'string' || typeof tool.toolName !== 'string') return
      this.runStore.update(runId, (run) => {
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
      this.runStore.update(runId, (run) => {
        let timing = run.tools.find((candidate) => candidate.toolCallId === tool.toolCallId)
        if (!timing) {
          timing = {
            toolCallId: tool.toolCallId as string,
            name: typeof tool.toolName === 'string' ? tool.toolName : 'unknown',
            state: 'running',
            startedAt: now
          }
          run.tools.push(timing)
        }
        // Child usage is cumulative billing, never the parent's context size.
        if (tool.toolName === 'pion_subagents' && timing.endedAt === undefined) {
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
      const terminal = backend.completionState ?? 'completed'
      const completed = this.runStore.update(runId, (run) => {
        run.state = terminal
        run.settledAt = now
        run.liveUsage = undefined
        run.tools = run.tools.map((tool) => tool.state === 'running'
          ? { ...tool, state: 'interrupted', endedAt: now, durationMs: Math.max(0, now - tool.startedAt) }
          : tool)
      })
      backend.activeRunId = undefined
      if (terminal === 'completed' && completed) {
        const refreshPromise = this.refreshRunCheckpoint(backend)
        const completionPromise = refreshPromise.then(
          () => undefined,
          (error) => {
            console.error('[pion] run checkpoint refresh failed:', error)
          }
        ).then(async () => {
          for (const listener of this.runCompletedListeners) {
            try {
              await listener(completed)
            } catch (error) {
              console.error('[pion] run completion listener failed:', error)
            }
          }
        })
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
      if (run.state !== 'interrupted') continue
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
      if ((backend.localFollowUps?.length ?? 0) === 0) backend.localQueueBlocked = false
      if (backend.activeRunId === runId) backend.activeRunId = undefined
      this.pushQueueSnapshot(backend)
    }
    return updated
  }

  async resumeRun(runId: string): Promise<RunOperation> {
    let source = this.runStore.get(runId)
    if (!source || (source.state !== 'interrupted' && !(source.state === 'queued' && source.interruptedAt !== undefined))) {
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
    const state = await backend.client.getState()
    if (state.isStreaming || backend.busy || backend.compacting) {
      throw new Error('当前会话仍在运行，请完成或中止后再恢复')
    }

    backend.busy = true
    let run: RunOperation | undefined
    try {
      this.resetRunCheckpoint(backend)
      await this.applyDesiredMode(backend)
      const interrupted = source.state === 'interrupted'
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
      await backend.client.prompt(message, source.prompt.images)
      this.runStore.update(run.id, (current) => {
        current.dispatchedAt ??= Date.now()
      })
      this.runStore.update(source.id, (current) => {
        current.state = 'discarded'
        current.settledAt ??= Date.now()
        current.stopReason = 'resumed-as-new-run'
      })
      await this.syncBackendSession(backend)
      return this.runStore.get(run.id) ?? run
    } catch (error) {
      if (run && backend.activeRunId === run.id) backend.activeRunId = undefined
      backend.busy = false
      backend.compacting = false
      if (run) {
        this.runStore.update(run.id, (current) => {
          current.state = 'failed'
          current.settledAt = Date.now()
          current.error = error instanceof Error ? error.message : String(error)
        })
      }
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
    this.stopping = false
    this.sessionSelectionGeneration += 1
    const normalizedCwd = resolve(cwd)
    if (this.activeCwd === normalizedCwd && this.activeKey) return
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
    const target = resolve(targetCwd)
    const fromCwd = this.activeCwd
    if (!fromCwd || resolve(fromCwd) === target) return this.activeSessionPath ?? null
    const backend = this.getActiveBackend()
    if (backend) {
      await backend.startPromise
      const state = await backend.client.getState().catch(() => null)
      if (
        state?.isStreaming
        || state?.isCompacting
        || backend.busy
        || backend.compacting
        || backend.localQueueDispatching
        || (backend.localFollowUps?.length ?? 0) > 0
        || backend.runCompletionPromise
      ) {
        throw new Error('当前会话正在运行，请等待完成或中止后再迁移项目')
      }
    }

    const sessionPath = this.activeSessionPath ?? backend?.sessionPath
    if (!sessionPath) {
      await this.start(target)
      return null
    }

    const source = resolve(sessionPath)
    const targetDir = this.sessionDirFor(target)
    await mkdir(targetDir, { recursive: true })
    const targetPath = join(targetDir, basename(source))
    const content = await readFile(source, 'utf8')
    const lines = content.split('\n')
    try {
      const header = JSON.parse(lines[0]) as { type?: string; cwd?: unknown }
      if (header && header.type === 'session') {
        header.cwd = target
        lines[0] = JSON.stringify(header)
      }
    } catch {
      // Keep the original first line if it is not a JSON header.
    }
    await writeFile(targetPath, lines.join('\n'), 'utf8')
    if (targetPath !== source) await unlink(source).catch(() => undefined)
    this.sessionManagers.delete(source)
    this.sessionManagers.delete(targetPath)
    this.sessionManagerSignatures.delete(source)
    this.sessionManagerSignatures.delete(targetPath)

    await this.switchSession(targetPath)
    await this.refreshSidebarSessions()
    return targetPath
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

  private projectedQueueSnapshot(backend: BackendRecord): { steering: string[]; followUp: string[]; nativeFollowUpCount: number } {
    const projection = projectQueueSnapshot(
      backend.rawQueue ?? { steering: [], followUp: [] },
      backend.directSteering ?? [],
      (backend.localFollowUps ?? []).map((item) => (
        item.text || (item.images.length > 0 ? '（图像消息）' : '')
      ))
    )
    backend.directSteering = projection.directSteering
    return {
      ...projection.queue,
      nativeFollowUpCount: projection.queue.nativeFollowUpCount ?? 0
    }
  }

  private pushQueueSnapshot(backend: BackendRecord): void {
    if (this.activeKey !== backend.key) return
    this.win?.webContents.send(EVENT_CHANNEL, {
      type: 'queue_update',
      ...this.projectedQueueSnapshot(backend)
    })
  }

  private markDirectSteering(backend: BackendRecord, message: string): void {
    backend.directSteering ??= []
    backend.directSteering.push(message)
    const raw = backend.rawQueue ?? { steering: [], followUp: [] }
    backend.rawQueue = {
      steering: [...raw.steering, message],
      followUp: [...raw.followUp]
    }
    this.pushQueueSnapshot(backend)
  }

  private unmarkDirectSteering(backend: BackendRecord, message: string): void {
    const directIndex = backend.directSteering?.lastIndexOf(message) ?? -1
    if (directIndex >= 0) backend.directSteering?.splice(directIndex, 1)
    const raw = backend.rawQueue
    if (raw) {
      const rawIndex = raw.steering.lastIndexOf(message)
      if (rawIndex >= 0) raw.steering.splice(rawIndex, 1)
    }
    this.pushQueueSnapshot(backend)
  }

  private completeCompanionRuns(backend: BackendRecord, terminal: 'completed' | 'aborted' | 'failed', settledAt: number): void {
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
      this.stopping
      || backend.localQueueDispatchPromise
      || backend.localQueueDispatching
      || backend.localQueueBlocked
      || backend.runCompletionPromise
      || (backend.localFollowUps?.length ?? 0) === 0
    ) return
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
      if (!state || state.isStreaming || state.isCompacting) {
        localFollowUps.unshift(item)
        if (!state) {
          backend.busy = false
          // A failed state read must not spin the dispatcher indefinitely.
          backend.localQueueBlocked = true
        }
        backend.localQueueDispatching = false
        this.pushQueueSnapshot(backend)
        return
      }
      this.pushQueueSnapshot(backend)
      try {
        await this.prepareQueuedRunForDispatch(backend, item.runId)
        await this.applyDesiredMode(backend)
        await backend.client.prompt(item.text, item.images)
        this.runStore.update(item.runId, (run) => {
          run.dispatchedAt ??= Date.now()
        })
      } catch (error) {
        backend.busy = false
        // prompt() rejected before agent_start, so this item was not
        // delivered and can be retried safely. Keep it visible instead of
        // losing a queued message on a transient RPC failure.
        backend.pendingRunIds = [item.runId, ...backend.pendingRunIds.filter((id) => id !== item.runId)]
        localFollowUps.unshift(item)
        backend.localQueueDispatching = false
        backend.localQueueBlocked = true
        this.runStore.update(item.runId, (run) => {
          run.state = 'queued'
          run.dispatchedAt = undefined
          run.agentStartedAt = undefined
          run.settledAt = undefined
          run.error = error instanceof Error ? error.message : String(error)
        })
        this.pushQueueSnapshot(backend)
        if (!backend.busy && !backend.localQueueBlocked && (backend.localFollowUps?.length ?? 0) > 0) {
          this.dispatchNextLocalFollowUp(backend)
        }
      }
    })().finally(() => {
      backend.localQueueDispatchPromise = undefined
      if (
        !backend.localQueueDispatching
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
    localFollowUps.splice(index, 1)
    this.pushQueueSnapshot(backend)

    const state = await backend.client.getState().catch(() => null)
    if (
      !state
      || state.isCompacting
      || backend.compacting
      || backend.runCompletionPromise
      || (backend.busy && !state.isStreaming)
    ) {
      localFollowUps.splice(index, 0, item)
      this.pushQueueSnapshot(backend)
      throw new Error('当前 Agent 正在切换运行状态，请稍后再次发送该消息')
    }
    backend.localQueueBlocked = false
    if (state.isStreaming) {
      backend.pendingRunIds = backend.pendingRunIds.filter((id) => id !== item.runId)
      backend.companionRunIds ??= []
      backend.companionRunIds.push(item.runId)
      this.runStore.update(item.runId, (run) => {
        run.state = 'running'
        run.dispatchedAt ??= Date.now()
        run.agentStartedAt ??= Date.now()
      })
      this.markDirectSteering(backend, item.text)
      try {
        await backend.client.steer(item.text, item.images)
      } catch (error) {
        backend.companionRunIds = backend.companionRunIds.filter((id) => id !== item.runId)
        localFollowUps.splice(index, 0, item)
        const nextQueuedRunId = localFollowUps[index + 1]?.runId
        const insertionIndex = nextQueuedRunId
          ? backend.pendingRunIds.indexOf(nextQueuedRunId)
          : backend.pendingRunIds.length
        backend.pendingRunIds.splice(
          insertionIndex < 0 ? backend.pendingRunIds.length : insertionIndex,
          0,
          item.runId
        )
        this.unmarkDirectSteering(backend, item.text)
        this.runStore.update(item.runId, (run) => {
          run.state = 'queued'
          run.error = undefined
        })
        this.pushQueueSnapshot(backend)
        if (!backend.busy && !backend.localQueueBlocked) this.dispatchNextLocalFollowUp(backend)
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
    try {
      await this.prepareQueuedRunForDispatch(backend, item.runId)
      await this.applyDesiredMode(backend)
      await backend.client.prompt(item.text, item.images)
      this.runStore.update(item.runId, (run) => {
        run.dispatchedAt ??= Date.now()
      })
    } catch (error) {
      backend.busy = false
      backend.localQueueDispatching = false
      backend.pendingRunIds = backend.pendingRunIds.filter((id) => id !== item.runId)
      localFollowUps.splice(index, 0, item)
      backend.localQueueBlocked = localFollowUps.length > 0
      this.runStore.update(item.runId, (run) => {
        run.state = 'failed'
        run.settledAt = Date.now()
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

  private attachBackendEvents(backend: BackendRecord): void {
    backend.client.onEvent((event) => {
      if (this.stopping) return
      const type = (event as { type?: string }).type
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
      this.trackBackendEvent(backend, event, type)
      if (type === 'agent_settled') {
        const terminal = backend.completionState ?? 'completed'
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
          backend.localQueueBlocked = false
          const completionPromise = backend.runCompletionPromise
          if (completionPromise) {
            void completionPromise.then(() => {
              if (backend.runCompletionPromise !== completionPromise) return
              backend.runCompletionPromise = undefined
              this.pushRunningSessionPaths()
              if (
                !backend.busy
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
          backend.localQueueBlocked = (backend.localFollowUps?.length ?? 0) > 0
          if (backend.localQueueBlocked) this.pushQueueSnapshot(backend)
        }
      }
      if (runningStateChanged) this.pushRunningSessionPaths()
      if (type === 'agent_start' || type === 'message_start' || type === 'agent_settled'
        || (type === 'message_end' && (!backend.sidebarPublishedSessionPath || backend.sidebarPublishedSessionPath !== backend.sessionPath))) {
        // Keep persisted history fresh even when this backend finishes while a
        // different project or session is selected. A first prompt can also
        // create the session file needed by the sidebar running indicator.
        void this.syncBackendSession(backend)
      }
      if (this.activeKey !== backend.key) return
      if (type === 'agent_start') this.setActiveBackendStatus()
      this.win?.webContents.send(EVENT_CHANNEL, forwardedEvent)
      if (type === 'entry_appended' && (event as { entry?: { customType?: string } }).entry?.customType === 'pion-subagents-state') {
        void this.pushSessionInfo()
      }
      if (typeof type === 'string' && STATE_REFRESH_EVENTS.has(type)) {
        void this.pushSessionInfo()
        void this.refreshSidebarSessions()
      }
    })
  }

  private async createBackend(
    key: string,
    cwd: string,
    sessionPath?: string
  ): Promise<BackendRecord> {
    const cliPath = pionRuntimePath()
    const args = await this.backendArgs(cwd, sessionPath)
    const client = new RpcClient({
      cliPath,
      cwd,
      args,
      env: { PION_TOOL_PERMISSION_CONFIG: this.toolPermissionStore.filePath }
    })
    const backend = {
      key,
      cwd,
      sessionPath,
      client,
      phase: 'starting' as BackendPhase,
      busy: false,
      compacting: false,
      pendingRunIds: [],
      localFollowUps: [],
      directSteering: [],
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
        // RpcClient.start() only waits 100 ms. The permission and plan
        // extensions can make cold startup longer, so require one successful
        // RPC round trip before exposing this backend as ready.
        const initialState = await client.getState()
        await restoreSessionModelPreference(client, initialState, sessionPath, this.sessionModelPreferences)
        backend.phase = 'running'
        console.log('[pion] agent subprocess running, session:', sessionPath ?? key)
        if (this.activeKey === key) this.setActiveBackendStatus()
        void this.pushSessionInfo()
        void this.refreshSidebarSessions()
      })
      .catch((error: unknown) => {
        backend.phase = 'error'
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
    return this.backendPool.startWithLimit(
      key,
      () => this.createBackend(key, cwd, sessionPath),
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
    return backend
  }

  private async syncBackendSession(backend: BackendRecord): Promise<void> {
    const state = await backend.client.getState().catch(() => null)
    const sessionPath = state?.sessionFile
    if (!sessionPath) return
    const normalizedPath = resolve(sessionPath)
    backend.sessionPath = normalizedPath
    this.updateRunSession(backend, normalizedPath, state.sessionId)
    this.sessionManagers.delete(normalizedPath)
    this.sessionManagerSignatures.delete(normalizedPath)
    this.backendKeysBySessionPath.set(normalizedPath, backend.key)
    if (this.activeKey === backend.key) this.activeSessionPath = normalizedPath
    this.pushRunningSessionPaths()
    this.restoreQueuedRuns(backend)
    if (backend.sidebarPublishedSessionPath !== normalizedPath) {
      const sessions = await this.listSessions(backend.cwd)
      // Pi can allocate a path before it writes the JSONL. Retry on subsequent
      // message events until listSessions actually sees the persisted session.
      if (backend.sessionPath === normalizedPath && sessions.some((session) => resolve(session.path) === normalizedPath)) {
        backend.sidebarPublishedSessionPath = normalizedPath
        this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
      }
    }
  }

  /** Queued runs are persisted in the run store; put them back into the live
      queue when their session activates so an app restart never drops them.
      They wait for the user's next action instead of auto-dispatching. */
  private restoreQueuedRuns(backend: BackendRecord): void {
    if (backend.queueRestored) return
    backend.queueRestored = true
    const sessionPath = backend.sessionPath ? resolve(backend.sessionPath) : undefined
    const queued = this.runStore
      .list({ sessionPath, cwd: sessionPath ? undefined : backend.cwd, limit: 50 })
      .filter((run) => run.state === 'queued')
      .sort((left, right) => left.createdAt - right.createdAt)
    if (queued.length === 0) return
    backend.localFollowUps ??= []
    const existing = new Set(backend.localFollowUps.map((item) => item.runId))
    for (const run of queued) {
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
    await Promise.all(backends.map((backend) => this.interruptBackendRuns(
      backend,
      'Pion 已退出；本轮及未发送的排队消息都未自动重放。'
    )))
    this.pendingRequests.clearAll()
    this.backendPool.clear()
    this.backendKeysBySessionPath.clear()
    this.pushRunningSessionPaths()
    this.activeKey = null
    this.activeCwd = undefined
    this.activeSessionPath = undefined
    await Promise.all(backends.map(async ({ client }) => {
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
    const state = await backend.client.getState().catch(() => null)
    if (state?.isStreaming && !state.isCompacting && !backend.compacting) {
      // Enter uses Pi's steering path, but it is an immediate insertion rather
      // than a user follow-up. Keep it out of the visible queue card.
      this.markDirectSteering(backend, message)
      try {
        await backend.client.steer(message, images)
      } catch (error) {
        this.unmarkDirectSteering(backend, message)
        throw error
      }
    } else if (
      state?.isCompacting
      || backend.busy
      || backend.compacting
      || backend.localQueueDispatching
      || (backend.localFollowUps?.length ?? 0) > 0
    ) {
      // There is a short idle-looking gap between Pi's settled event and the
      // next locally dispatched follow-up. Queue here instead of racing that
      // prompt (or trying to steer during compaction).
      await this.queue(message, images)
    } else {
      // Reserve the backend before checkpoint/mode preparation. Both calls are
      // asynchronous, and RpcClient.prompt itself returns before agent_start.
      backend.busy = true
      let run: RunOperation | undefined
      try {
        this.resetRunCheckpoint(backend)
        await this.applyDesiredMode(backend)
        run = this.createRun(backend, state, message, images, 'prompt', 'dispatching')
        await backend.client.prompt(message, images)
        this.runStore.update(run.id, (current) => {
          current.dispatchedAt ??= Date.now()
        })
      } catch (error) {
        if (run && backend.activeRunId === run.id) backend.activeRunId = undefined
        backend.busy = false
        backend.compacting = false
        if (run) {
          this.runStore.update(run.id, (current) => {
            current.state = 'failed'
            current.settledAt = Date.now()
            current.error = error instanceof Error ? error.message : String(error)
          })
        }
        throw error
      }
    }
    await this.syncBackendSession(backend)
    if (this.activeKey === backend.key) {
      await Promise.all([this.pushSessionInfo(), this.refreshSidebarSessions()])
    }
  }

  /** Queue a follow-up while running; starts this session's backend if needed. */
  async queue(message: string, images: ImageContent[] = []): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const state = await backend.client.getState().catch(() => null)
    if (
      state?.isStreaming
      || state?.isCompacting
      || backend.busy
      || backend.compacting
      || backend.localQueueDispatching
      || (backend.localFollowUps?.length ?? 0) > 0
    ) {
      const run = this.createRun(backend, state, message, images, 'follow-up', 'queued')
      backend.localFollowUps ??= []
      backend.localFollowUps.push({ runId: run.id, text: message, images })
      this.pushQueueSnapshot(backend)
      if (!backend.busy && !backend.compacting && !backend.localQueueBlocked && !backend.runCompletionPromise) {
        this.dispatchNextLocalFollowUp(backend)
      }
    } else {
      // Reserve the backend across checkpoint/mode preparation and the RPC
      // dispatch gap; prompt resolves before Pi emits agent_start.
      backend.busy = true
      let run: RunOperation | undefined
      try {
        this.resetRunCheckpoint(backend)
        await this.applyDesiredMode(backend)
        run = this.createRun(backend, state, message, images, 'follow-up', 'dispatching')
        await backend.client.prompt(message, images)
        this.runStore.update(run.id, (current) => {
          current.dispatchedAt ??= Date.now()
        })
      } catch (error) {
        if (run && backend.activeRunId === run.id) backend.activeRunId = undefined
        backend.busy = false
        backend.compacting = false
        if (run) {
          this.runStore.update(run.id, (current) => {
            current.state = 'failed'
            current.settledAt = Date.now()
            current.error = error instanceof Error ? error.message : String(error)
          })
        }
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
    if (this.providerMutationInFlight) return null
    if (!sessionPath) return null
    const target = resolve(sessionPath)
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
    const state = await backend.client.getState()
    if (state.isStreaming || state.isCompacting || backend.busy || backend.compacting) return null
    // Reserve the backend while preparing the checkpoint and sending the
    // repair prompt; verification callbacks may otherwise race each other.
    backend.busy = true
    let run: RunOperation | undefined
    try {
      this.resetRunCheckpoint(backend)
      await this.applyDesiredMode(backend)
      run = this.createRun(backend, state, message, [], 'verification-repair', 'dispatching')
      await backend.client.prompt(message)
      this.runStore.update(run.id, (current) => {
        current.dispatchedAt ??= Date.now()
      })
      await this.syncBackendSession(backend)
      return this.runStore.get(run.id) ?? run
    } catch (error) {
      if (run && backend.activeRunId === run.id) backend.activeRunId = undefined
      backend.busy = false
      backend.compacting = false
      if (run) {
        this.runStore.update(run.id, (current) => {
          current.state = 'failed'
          current.settledAt = Date.now()
          current.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
  }

  private async applyDesiredMode(backend: BackendRecord): Promise<void> {
    const desired = this.desiredModes.get(backend.key) ?? 'build'
    if (backend.modePrimed === desired) return
    await backend.client.prompt(desired === 'plan' ? '/plan start' : '/plan exit')
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
    const file = await stat(target)
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
    this.activeSessionPath = target
    this.activeKey = this.backendKeysBySessionPath.get(target) ?? target
    this.activeCwd = resolve(cwd ?? this.activeCwd ?? this.status.cwd ?? dirname(target))
    try {
      const manager = this.openSessionManager(target)
      this.desiredModes.set(this.activeKey, sessionMode(manager.getEntries()))
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
    return { path: resolve(path), text }
  }

  private async rememberTranscriptModel(sessionPath: string): Promise<void> {
    if (!this.sessionModelPreferences) return
    try {
      const target = resolve(sessionPath)
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

  /** Select a session and load its backend once, reusing it on later visits. */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
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
        if (this.activeSessionPath !== target) return
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
    const backend = this.backendPool.get(key)
    if (!backend) return
    await this.interruptBackendRuns(
      backend,
      'Agent 后端已停止；本轮及未发送的排队消息未自动重放。'
    )
    this.clearBackendToolPermissionRequests(key)
    this.clearBackendExtensionUiRequests(key)
    this.backendPool.delete(key)
    this.pushRunningSessionPaths()
    if (backend.sessionPath && this.backendKeysBySessionPath.get(resolve(backend.sessionPath)) === key) {
      this.backendKeysBySessionPath.delete(resolve(backend.sessionPath))
    }
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

    await unlink(target)
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
      const entries = manager.getEntries()
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

    for (const entry of manager.getEntries()) {
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
      const message = entry.message as unknown as {
        toolName?: unknown
        details?: { tasks?: unknown }
      }
      if (!isTaskToolName(message.toolName)) continue
      const tasks = normalizeSessionTasks(message.details?.tasks)
      if (tasks) events.push({ kind: 'snapshot', tasks })
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

    const total = result.entries.length
    const end = typeof before === 'number' && Number.isFinite(before)
      ? Math.min(Math.max(Math.trunc(before), 0), total)
      : total
    const pageSize = Math.min(Math.max(Math.trunc(limit) || 160, 1), 240)
    const start = Math.max(0, end - pageSize)
    const entries = result.entries.slice(start, end)
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
    if (this.win?.webContents.id !== ownerId) throw new Error('只允许所属主窗口切换子 Agent')
    if (typeof enabled !== 'boolean' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('子 Agent 开关参数无效')
    const backend = this.getActiveBackend()
    if (!backend) throw new Error('会话尚未就绪')
    if (backend.subagentsModePending) throw new Error('子 Agent 开关正在切换')
    backend.subagentsModePending = true
    try {
      await backend.startPromise
      const [state, commands] = await Promise.all([backend.client.getState(), backend.client.getCommands()])
      if (this.activeKey !== backend.key || state.sessionId !== sessionId) throw new Error('会话已切换，请重试')
      if (enabled && (backend.busy || backend.compacting || state.isStreaming || state.isCompacting)) throw new Error('请等待当前执行完成后开启子 Agent')
      if (enabled && this.desiredModes.get(backend.key) === 'plan') throw new Error('计划模式不启用编码子 Agent')
      if (!commands.some((command) => command.name === 'pion-subagents')) throw new Error('当前运行时不支持内置子 Agent')
      await backend.client.prompt(enabled ? '/pion-subagents on' : '/pion-subagents off')
      backend.subagentsEnabled = enabled
      if (!enabled) this.clearSubagentPermissions(backend)
      if (this.activeKey === backend.key) await this.pushSessionInfo()
    } finally {
      backend.subagentsModePending = false
    }
  }

  async setMode(mode: AgentMode): Promise<void> {
    const key = this.activeKey
    if (!key) throw new Error('没有活动会话')
    const backend = this.getActiveBackend()
    if (!backend) {
      this.desiredModes.set(key, mode)
      return
    }
    await backend.startPromise
    const currentState = await backend.client.getState().catch(() => null)
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
      if (!commands.some((command) => command.name === 'plan')) {
        throw new Error('Pion 计划模式未加载')
      }
      await backend.client.prompt(mode === 'plan' ? '/plan start' : '/plan exit')
      this.desiredModes.set(key, mode)
      backend.modePrimed = mode
    } finally {
      backend.busy = false
      if (!backend.compacting && !backend.localQueueDispatching && !backend.localQueueBlocked && !backend.runCompletionPromise && (backend.localFollowUps?.length ?? 0) > 0) {
        this.dispatchNextLocalFollowUp(backend)
      }
    }
  }

  // ---------------------------------------------------------------- models

  private async readBackendModels(backend: BackendRecord): Promise<ModelOption[]> {
    const models = await backend.client.getAvailableModels()
    return models.map((model) => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning
    }))
  }

  async getModels(): Promise<ModelOption[]> {
    const backend = await this.waitForActiveBackend()
    if (!backend) return []
    try {
      return await this.readBackendModels(backend)
    } catch {
      return []
    }
  }

  getModelProviders(): Promise<ModelProviderInfo[]> {
    if (!this.providerMutationInFlight) this.providerAuthService.invalidate()
    return this.providerAuthService.listProviders()
  }

  private beginProviderMutation(): void {
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
      return models
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
    const backend = await this.ensureActiveBackend()
    await backend.client.setModel(provider, modelId)
    if (this.sessionModelPreferences) {
      const state = await backend.client.getState()
      const sessionPath = state.sessionFile ?? backend.sessionPath
      if (sessionPath) {
        await this.sessionModelPreferences.setSessionModel(sessionPath, { provider, modelId })
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
    if (typeof name !== 'string') throw new Error('会话名称无效')
    const normalizedName = name.replace(/[\r\n]+/g, ' ').trim()
    if (!normalizedName) throw new Error('会话名称不能为空')
    if (normalizedName.length > 120) throw new Error('会话名称不能超过 120 个字符')

    if (!sessionPath) {
      const backend = this.getActiveBackend()
      if (!backend) throw new Error('agent 未启动')
      await backend.startPromise
      await backend.client.setSessionName(normalizedName)
      await this.syncBackendSession(backend)
      await this.pushSessionInfo()
      void this.refreshSidebarSessions()
      return
    }

    const target = await this.resolveListedSession(sessionPath)
    const backendKey = this.backendKeysBySessionPath.get(target) ?? target
    const backend = this.backendPool.get(backendKey)
    if (backend) {
      await backend.startPromise
      await backend.client.setSessionName(normalizedName)
      this.sessionManagers.delete(target)
      this.sessionManagerSignatures.delete(target)
    } else {
      const manager = this.openSessionManager(target)
      manager.appendSessionInfo(normalizedName)
      this.sessionManagers.set(target, manager)
      this.sessionManagerSignatures.delete(target)
    }

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
    try {
      const infos = await SessionManager.list(dir)
      return infos.map((info) => ({
        projectCwd: resolve(dir),
        path: info.path,
        id: info.id,
        name: info.name,
        timestamp: info.created instanceof Date ? info.created.toISOString() : String(info.created),
        mtime: info.modified instanceof Date ? info.modified.getTime() : Date.parse(String(info.modified)) || 0,
        preview: (info.firstMessage ?? '').slice(0, 120),
        messageCount: info.messageCount
      }))
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- state

  async getSessionInfo(): Promise<SessionInfo | null> {
    const backend = this.getActiveBackend()
    const info = await this.getSessionInfoSnapshot()
    if (info) info.subagentsEnabled = backend?.subagentsEnabled ?? false
    if (info) info.yolo = this.activeKey ? this.yoloSessions.has(this.activeKey) : false
    return info
  }

  private async getSessionInfoSnapshot(): Promise<SessionInfo | null> {
    const backend = this.getActiveBackend()
    try {
      if (backend?.phase === 'running') return await this.toSessionInfo(backend.client)
      // A persisted session can be described directly from JSONL while its
      // colder RPC backend is still loading extensions and models.
      if (!this.activeSessionPath) {
        if (!backend) return null
        await backend.startPromise
        return this.toSessionInfo(backend.client)
      }
      const manager = this.openSessionManager(this.activeSessionPath)
      const context = manager.buildSessionContext()
      const preference = this.sessionModelPreferences?.getSessionModel(this.activeSessionPath)
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
    } catch {
      return null
    }
  }

  private async toSessionInfo(client: RpcClient): Promise<SessionInfo | null> {
    const state = await client.getState()
    const model = state.model as { provider?: string; id?: string; name?: string } | undefined
    return {
      provider: model?.provider,
      model: model?.name ?? model?.id,
      modelId: model?.id,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      sessionFile: state.sessionFile,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      autoCompactionEnabled: state.autoCompactionEnabled,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      messageCount: state.messageCount,
      pendingMessageCount: state.pendingMessageCount
    }
  }

  private async pushSessionInfo(): Promise<void> {
    const activeKey = this.activeKey
    const activeSessionPath = this.activeSessionPath
    const info = await this.getSessionInfo()
    if (this.activeKey !== activeKey || this.activeSessionPath !== activeSessionPath) return
    this.win?.webContents.send(STATE_CHANNEL, info)
  }

  private async refreshSidebarSessions(): Promise<void> {
    const cwd = this.status.cwd
    const sessions = await this.listSessions(cwd)
    if (this.status.cwd !== cwd) return
    this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
  }

  /** Push state + session list + branch tree to the renderer. */
  private async refresh(): Promise<void> {
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
      this.activeKey !== activeKey ||
      this.activeSessionPath !== activeSessionPath ||
      this.activeCwd !== activeCwd
    ) return
    this.win?.webContents.send(STATE_CHANNEL, info)
    this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
    this.win?.webContents.send(TREE_CHANNEL, tree)
  }
}
