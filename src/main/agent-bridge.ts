import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { access, unlink } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import {
  DefaultResourceLoader,
  ProjectTrustStore,
  RpcClient,
  SessionManager,
  SettingsManager,
  getAgentDir,
  getPackageDir,
  hasTrustRequiringProjectResources
} from '@earendil-works/pi-coding-agent'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { IPC_EVENTS } from '../shared/ipc'
import type {
  AgentCapabilities,
  AgentMode,
  AgentStatus,
  BranchInfo,
  DeleteSessionResult,
  ForkMessageOption,
  ImageContent,
  ModelOption,
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
  ToolPermissionCategory,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRules,
  TreeNodeLite,
  WireEntry,
  WireMessage
} from '../shared/types'
import { messageText } from '../shared/types'
import {
  deriveSessionTaskRuns,
  isTaskToolName,
  normalizeSessionTasks
} from '../shared/task-history'
import type { SessionTaskHistoryEvent } from '../shared/task-history'
import { createWorktreeBranch, listBranchInfos } from './git'
import {
  createGitRunCheckpoint,
  inspectGitRunCheckpoint,
  rollbackGitRunCheckpoint
} from './checkpoints'
import type { GitRunCheckpoint } from './checkpoints'
import {
  TOOL_PERMISSION_MARKER,
  TOOL_PERMISSION_TIMEOUT_MS,
  ToolPermissionStore
} from './tool-permissions'
import { ensureNativeTaskExtension } from './task-planning'
import {
  filterToolResults,
  sessionMode,
  toTreeNodeLite,
  toWireEntry,
  toolCallIds
} from './wire'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const EVENT_CHANNEL = IPC_EVENTS.AgentEvent
const STATUS_CHANNEL = IPC_EVENTS.AgentStatus
const CHECKPOINT_CHANNEL = IPC_EVENTS.AgentRunCheckpoint
const TOOL_PERMISSION_CHANNEL = IPC_EVENTS.ToolPermissionRequests
const STATE_CHANNEL = IPC_EVENTS.AgentState
const SESSIONS_CHANNEL = IPC_EVENTS.AgentSessions
const RUNNING_SESSIONS_CHANNEL = IPC_EVENTS.AgentRunningSessions
const TREE_CHANNEL = IPC_EVENTS.AgentTree
const PLAN_EXTENSION_PATH = resolve(MODULE_DIR, '../../node_modules/@narumitw/pi-plan-mode/dist/index.ts')
/** Global pool size shared by every project and worktree. */
const MAX_RETAINED_BACKENDS = 10

/** Pi's RPC get_commands intentionally returns only extensions, prompts, and
    skills. Merge the built-ins that Pion can execute with equivalent native
    behavior so autocomplete does not silently omit core commands. */
const BUILTIN_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: 'compact', description: '手动压缩上下文，可附加摘要要求', source: 'builtin' },
  { name: 'new', description: '在当前项目中新建会话', source: 'builtin' },
  { name: 'name', description: '设置或清除当前会话名称', source: 'builtin' },
  { name: 'clone', description: '复制当前活动分支为新会话', source: 'builtin' }
]

/** Events after which derived state (model/session/tree) is re-pushed. */
const STATE_REFRESH_EVENTS = new Set([
  'agent_settled',
  'session_info_changed',
  'thinking_level_changed'
])

interface PushedTree {
  tree: TreeNodeLite[]
  leafId: string | null
}

type BackendPhase = 'starting' | 'running' | 'error'

interface PendingToolPermission {
  request: ToolPermissionRequest
  backendKey: string
  extensionRequestId: string
  timeout: ReturnType<typeof setTimeout>
}

interface BackendRecord {
  key: string
  cwd: string
  sessionPath?: string
  client: RpcClient
  phase: BackendPhase
  busy: boolean
  modePrimed?: AgentMode
  completionState?: 'completed' | 'aborted'
  checkpoint?: GitRunCheckpoint
  checkpointStatus?: RunCheckpointStatus
  startPromise: Promise<void>
}

type SessionCompletedListener = (info: { cwd: string; sessionPath?: string }) => void

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

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
  private readonly backends = new Map<string, BackendRecord>()
  private readonly backendOrder: string[] = []
  private readonly backendStarts = new Map<string, Promise<BackendRecord>>()
  private backendPoolQueue: Promise<void> = Promise.resolve()
  private stopping = false
  private readonly backendKeysBySessionPath = new Map<string, string>()
  private readonly desiredModes = new Map<string, AgentMode>()
  private readonly sessionManagers = new Map<string, SessionManager>()
  private readonly sessionCompletedListeners = new Set<SessionCompletedListener>()
  private readonly projectTrustStore = new ProjectTrustStore(getAgentDir())
  private readonly toolPermissionStore = new ToolPermissionStore()
  private readonly pendingToolPermissions = new Map<string, PendingToolPermission>()
  private newSessionInFlight: Promise<void> | null = null
  private sessionSelectionGeneration = 0
  private activeKey: string | null = null
  private activeCwd: string | undefined
  private activeSessionPath: string | undefined
  private win: BrowserWindow | null = null
  private status: AgentStatus = { phase: 'stopped' }

  private getActiveBackend(): BackendRecord | null {
    return this.activeKey ? this.backends.get(this.activeKey) ?? null : null
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
    this.pushRunningSessionPaths()
  }

  unbind(win: BrowserWindow): void {
    if (this.win === win) this.win = null
  }

  getStatus(): AgentStatus {
    return this.status
  }

  getRunningSessionPaths(): string[] {
    return [...new Set(
      [...this.backends.values()]
        .filter((backend) => backend.busy && backend.sessionPath)
        .map((backend) => resolve(backend.sessionPath as string))
    )]
  }

  private pushRunningSessionPaths(): void {
    this.win?.webContents.send(RUNNING_SESSIONS_CHANNEL, this.getRunningSessionPaths())
  }

  onSessionCompleted(listener: SessionCompletedListener): () => void {
    this.sessionCompletedListeners.add(listener)
    return () => this.sessionCompletedListeners.delete(listener)
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch }
    this.win?.webContents.send(STATUS_CHANNEL, this.status)
  }

  private pushRunCheckpoint(): void {
    const checkpoint = this.getActiveBackend()?.checkpointStatus ?? null
    this.win?.webContents.send(CHECKPOINT_CHANNEL, checkpoint)
  }

  private pushToolPermissionRequests(): void {
    this.win?.webContents.send(TOOL_PERMISSION_CHANNEL, this.getPendingToolPermissionRequests())
  }

  async loadToolPermissions(): Promise<void> {
    await this.toolPermissionStore.load()
    await this.toolPermissionStore.ensureExtension()
  }

  getPendingToolPermissionRequests(): ToolPermissionRequest[] {
    return [...this.pendingToolPermissions.values()]
      .map(({ request }) => ({ ...request }))
      .sort((a, b) => a.createdAt - b.createdAt)
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
    const pending = this.pendingToolPermissions.get(id)
    if (!pending) return null
    clearTimeout(pending.timeout)
    this.pendingToolPermissions.delete(id)
    this.pushToolPermissionRequests()
    return pending
  }

  private clearBackendToolPermissionRequests(backendKey: string): void {
    let changed = false
    for (const [id, pending] of this.pendingToolPermissions) {
      if (pending.backendKey !== backendKey) continue
      clearTimeout(pending.timeout)
      this.pendingToolPermissions.delete(id)
      changed = true
    }
    if (changed) this.pushToolPermissionRequests()
  }

  private respondToExtensionUi(client: RpcClient, id: string, value: string): void {
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
      throw new Error('Agent 权限请求已失效')
    }
    stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, value })}\n`)
  }

  async resolveToolPermission(
    requestId: string,
    resolution: ToolPermissionResolution
  ): Promise<ProjectToolPermissionPolicy | null> {
    if (!['allow-once', 'allow-session', 'allow-project', 'deny'].includes(resolution)) {
      throw new Error('无效的工具权限决定')
    }
    const pending = this.pendingToolPermissions.get(requestId)
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

    const backend = this.backends.get(pending.backendKey)
    if (!backend) {
      this.clearToolPermissionRequest(requestId)
      throw new Error('发起请求的 Agent 会话已关闭')
    }
    this.respondToExtensionUi(backend.client, pending.extensionRequestId, resolution)
    this.clearToolPermissionRequest(requestId)
    return policy
  }

  private handleExtensionUiRequest(backend: BackendRecord, event: unknown): boolean {
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
      || !request.title.startsWith(TOOL_PERMISSION_MARKER)
    ) return false

    try {
      const metadata = JSON.parse(request.title.slice(TOOL_PERMISSION_MARKER.length)) as {
        cwd?: unknown
        sessionPath?: unknown
        toolName?: unknown
        category?: unknown
        policyCategories?: unknown
        summary?: unknown
        detail?: unknown
        risks?: unknown
        canRemember?: unknown
      }
      const categories = Array.isArray(metadata.policyCategories)
        ? metadata.policyCategories.filter((value): value is ToolPermissionCategory => (
            value === 'read' || value === 'write' || value === 'shell'
            || value === 'network' || value === 'external'
          ))
        : []
      const category = metadata.category
      if (
        typeof metadata.cwd !== 'string'
        || typeof metadata.toolName !== 'string'
        || typeof metadata.summary !== 'string'
        || typeof metadata.detail !== 'string'
        || categories.length === 0
        || (category !== 'read' && category !== 'write' && category !== 'shell'
          && category !== 'network' && category !== 'external')
      ) throw new Error('权限请求元数据无效')

      const id = randomUUID()
      const createdAt = Date.now()
      const timeoutMs = Math.min(
        Math.max(typeof request.timeout === 'number' ? request.timeout : TOOL_PERMISSION_TIMEOUT_MS, 1_000),
        TOOL_PERMISSION_TIMEOUT_MS
      )
      const permissionRequest: ToolPermissionRequest = {
        id,
        cwd: resolve(metadata.cwd),
        sessionPath: typeof metadata.sessionPath === 'string'
          ? metadata.sessionPath
          : backend.sessionPath,
        toolName: metadata.toolName,
        category,
        policyCategories: [...new Set(categories)],
        summary: metadata.summary.slice(0, 500),
        detail: metadata.detail.slice(0, 4_000),
        risks: Array.isArray(metadata.risks)
          ? metadata.risks.filter((value): value is ToolPermissionRequest['risks'][number] => (
              value === 'outside-workspace' || value === 'sensitive-path'
              || value === 'destructive-command'
            ))
          : [],
        canRemember: metadata.canRemember === true,
        createdAt,
        timeoutAt: createdAt + timeoutMs
      }
      const timeout = setTimeout(() => {
        if (this.pendingToolPermissions.delete(id)) this.pushToolPermissionRequests()
      }, timeoutMs + 250)
      this.pendingToolPermissions.set(id, {
        request: permissionRequest,
        backendKey: backend.key,
        extensionRequestId: request.id,
        timeout
      })
      this.pushToolPermissionRequests()
    } catch (error) {
      console.error('[pion] invalid tool permission request:', error)
      this.respondToExtensionUi(backend.client, request.id, 'deny')
    }
    return true
  }

  private async prepareRunCheckpoint(backend: BackendRecord): Promise<void> {
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

  private async refreshRunCheckpoint(backend: BackendRecord): Promise<RunCheckpointStatus | null> {
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
    const affected = [...this.backends.values()]
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

  private newSessionKey(cwd: string): string {
    return `new:${resolve(cwd)}:${randomUUID()}`
  }

  private async backendArgs(cwd: string, sessionPath?: string): Promise<string[]> {
    const [hasPlanExtension, permissionExtensionPath, nativeTaskExtensionPath] = await Promise.all([
      pathExists(PLAN_EXTENSION_PATH),
      this.toolPermissionStore.ensureExtension(),
      ensureNativeTaskExtension()
    ])
    if (!hasPlanExtension) {
      console.warn('[pion] plan mode extension not found:', PLAN_EXTENSION_PATH)
    }
    const trust = this.getProjectTrust(cwd)
    if (trust.decision === 'ask') {
      throw new Error('此项目包含本地 Pi 配置或扩展，请先选择是否信任项目')
    }
    return [
      trust.decision === 'trusted' ? '--approve' : '--no-approve',
      '--extension', permissionExtensionPath,
      '--extension', nativeTaskExtensionPath,
      ...(hasPlanExtension ? ['--extension', PLAN_EXTENSION_PATH] : []),
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

  private attachBackendEvents(backend: BackendRecord): void {
    backend.client.onEvent((event) => {
      const type = (event as { type?: string }).type
      if (type === 'extension_ui_request' && this.handleExtensionUiRequest(backend, event)) return
      let runningStateChanged = false
      if (type === 'agent_start') {
        backend.phase = 'running'
        backend.busy = true
        backend.completionState = undefined
        runningStateChanged = true
      }
      if (type === 'agent_end') {
        const endEvent = event as {
          messages?: Array<{ role?: string; stopReason?: string }>
          willRetry?: boolean
        }
        if (!endEvent.willRetry) {
          const assistant = [...(endEvent.messages ?? [])]
            .reverse()
            .find((message) => message.role === 'assistant')
          backend.completionState = assistant?.stopReason === 'aborted' ? 'aborted' : 'completed'
          if (backend.busy) runningStateChanged = true
          backend.busy = false
        }
      }
      if (type === 'agent_settled') {
        if (backend.busy) runningStateChanged = true
        backend.busy = false
        if (backend.completionState === 'completed') {
          for (const listener of this.sessionCompletedListeners) {
            try {
              listener({ cwd: backend.cwd, sessionPath: backend.sessionPath })
            } catch (error) {
              console.error('[pion] session completion listener failed:', error)
            }
          }
        }
        backend.completionState = undefined
        void this.refreshRunCheckpoint(backend)
      }
      if (runningStateChanged) this.pushRunningSessionPaths()
      if (type === 'agent_start' || type === 'message_start' || type === 'agent_settled') {
        // Keep persisted history fresh even when this backend finishes while a
        // different project or session is selected. A first prompt can also
        // create the session file needed by the sidebar running indicator.
        void this.syncBackendSession(backend)
      }
      if (this.activeKey !== backend.key) return
      if (type === 'agent_start') this.setActiveBackendStatus()
      this.win?.webContents.send(EVENT_CHANNEL, event)
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
    const cliPath = join(getPackageDir(), 'dist', 'cli.js')
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
      startPromise: Promise.resolve()
    }
    this.backends.set(key, backend)
    this.backendOrder.push(key)
    if (sessionPath) this.backendKeysBySessionPath.set(resolve(sessionPath), key)
    this.attachBackendEvents(backend)
    if (this.activeKey === key) this.setActiveBackendStatus()

    const startPromise = client.start()
      .then(async () => {
        // RpcClient.start() only waits 100 ms. The permission and plan
        // extensions can make cold startup longer, so require one successful
        // RPC round trip before exposing this backend as ready.
        await client.getState()
        backend.phase = 'running'
        console.log('[pion] agent subprocess running, session:', sessionPath ?? key)
        if (this.activeKey === key) this.setActiveBackendStatus()
        void this.pushSessionInfo()
        void this.refreshSidebarSessions()
      })
      .catch((error: unknown) => {
        backend.phase = 'error'
        this.clearBackendToolPermissionRequests(key)
        this.backends.delete(key)
        this.removeBackendFromOrder(key)
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

  private removeBackendFromOrder(key: string): void {
    const index = this.backendOrder.indexOf(key)
    if (index >= 0) this.backendOrder.splice(index, 1)
  }

  /** Stop the oldest retained backend before opening another one. */
  private async evictOldestBackend(excludeKey?: string): Promise<void> {
    while (this.backends.size >= MAX_RETAINED_BACKENDS) {
      const victim = this.backendOrder.find((key) => key !== excludeKey && this.backends.has(key))
      if (!victim) throw new Error('无法为新的会话后端腾出空间')
      console.log('[pion] evicting oldest session backend:', victim)
      await this.stopBackend(victim)
    }
  }

  /** Serialize starts so concurrent session selections cannot exceed the pool limit. */
  private startBackendWithLimit(
    key: string,
    cwd: string,
    sessionPath?: string
  ): Promise<BackendRecord> {
    const start = this.backendPoolQueue.then(() => {
      if (this.stopping) throw new Error('agent 正在停止')
      return this.evictOldestBackend(key).then(() => this.createBackend(key, cwd, sessionPath))
    })
    this.backendPoolQueue = start.then(() => undefined, () => undefined)
    return start
  }

  private async waitForActiveBackend(): Promise<BackendRecord | null> {
    const key = this.activeKey
    if (!key) return null
    const backend = this.backends.get(key)
    try {
      if (backend) {
        await backend.startPromise
        return this.activeKey === key ? backend : null
      }
      const pending = this.backendStarts.get(key)
      if (!pending) return null
      await pending
      return this.activeKey === key ? this.backends.get(key) ?? null : null
    } catch {
      return null
    }
  }

  private async ensureActiveBackend(): Promise<BackendRecord> {
    if (this.stopping) throw new Error('agent 正在停止')
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) throw new Error('没有活动工作目录')
    if (!this.activeKey) {
      this.activeCwd = resolve(cwd)
      this.activeKey = this.newSessionKey(this.activeCwd)
    }
    const activeCwd = this.activeCwd ?? resolve(cwd)
    this.activeCwd = activeCwd
    let backend = this.backends.get(this.activeKey)
    if (!backend) {
      const key = this.activeKey
      const inFlight = this.backendStarts.get(key)
      if (inFlight) {
        backend = await inFlight
      } else {
        this.setStatus({ phase: 'starting', error: undefined, cwd: activeCwd })
        const start = this.startBackendWithLimit(key, activeCwd, this.activeSessionPath)
        this.backendStarts.set(key, start)
        try {
          backend = await start
        } finally {
          if (this.backendStarts.get(key) === start) this.backendStarts.delete(key)
        }
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
    this.sessionManagers.delete(normalizedPath)
    this.backendKeysBySessionPath.set(normalizedPath, backend.key)
    if (this.activeKey === backend.key) this.activeSessionPath = normalizedPath
    this.pushRunningSessionPaths()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const pendingStarts = [...this.backendStarts.values()]
    await Promise.allSettled(pendingStarts)
    const backends = [...this.backends.values()]
    for (const pending of this.pendingToolPermissions.values()) clearTimeout(pending.timeout)
    this.pendingToolPermissions.clear()
    this.pushToolPermissionRequests()
    this.backends.clear()
    this.backendStarts.clear()
    this.backendOrder.length = 0
    this.backendKeysBySessionPath.clear()
    this.pushRunningSessionPaths()
    this.backendPoolQueue = Promise.resolve()
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
  }

  /** Prompt when idle, steer when mid-run. Starts only this session's backend. */
  async send(message: string, images: ImageContent[] = []): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const state = await backend.client.getState().catch(() => null)
    if (state?.isStreaming) {
      await backend.client.steer(message, images)
    } else {
      await this.prepareRunCheckpoint(backend)
      await this.applyDesiredMode(backend)
      await backend.client.prompt(message, images)
    }
    await this.syncBackendSession(backend)
  }

  /** Queue a follow-up while running; starts this session's backend if needed. */
  async queue(message: string, images: ImageContent[] = []): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const state = await backend.client.getState().catch(() => null)
    if (state?.isStreaming) {
      await backend.client.followUp(message, images)
    } else {
      await this.prepareRunCheckpoint(backend)
      await this.applyDesiredMode(backend)
      await backend.client.prompt(message, images)
    }
    await this.syncBackendSession(backend)
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
    return manager
  }

  private activateLogicalSession(sessionPath: string, cwd?: string): void {
    const target = resolve(sessionPath)
    this.activeSessionPath = target
    this.activeKey = this.backendKeysBySessionPath.get(target) ?? target
    this.activeCwd = resolve(cwd ?? this.activeCwd ?? this.status.cwd ?? dirname(target))
    this.setActiveBackendStatus()
    this.pushRunCheckpoint()
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

  /** Fork the selected session without starting or switching a backend. */
  async forkAt(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    if (!this.activeSessionPath) throw new Error('当前会话尚未持久化')
    const target = resolve(this.activeSessionPath)
    this.sessionManagers.delete(target)
    const manager = this.openSessionManager(target)
    const result = this.createForkedSession(manager, entryId)
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
    this.activateLogicalSession(target, manager.getCwd() || this.activeCwd)
    // Activate the logical session synchronously, then warm its backend in the
    // background. The renderer can read the cached SessionManager immediately
    // instead of waiting for a fresh pi subprocess to boot.
    void this.ensureActiveBackend()
      .then(async () => {
        if (this.activeSessionPath !== target) return
        await this.pushSessionInfo()
        void this.refreshSidebarSessions()
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
      const manager = this.openSessionManager(requested)
      if (!manager.getSessionFile()) throw new Error('会话文件无效')
    } catch {
      throw new Error('会话不存在')
    }
    return requested
  }

  private async stopBackend(key: string): Promise<void> {
    const backend = this.backends.get(key)
    if (!backend) return
    this.clearBackendToolPermissionRequests(key)
    this.backends.delete(key)
    this.removeBackendFromOrder(key)
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
    this.sessionManagers.delete(target)
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
    const manager = this.openSessionManager(target)
    const leafId = manager.getLeafId()
    if (!leafId) return { cancelled: true }
    const path = manager.createBranchedSession(leafId)
    if (!path) return { cancelled: true }
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
    const manager = this.openSessionManager(target)
    const result = this.createForkedSession(manager, entryId)
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
        // Explicit history reads re-open JSONL so a retained background
        // backend cannot leave the SessionManager cache missing newer entries.
        const manager = SessionManager.open(target)
        this.sessionManagers.set(target, manager)
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
      const manager = SessionManager.open(target)
      this.sessionManagers.set(resolve(target), manager)
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
    const manager = SessionManager.open(target)
    this.sessionManagers.set(resolve(target), manager)
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
      mode: sessionMode(result.entries)
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

  async setMode(mode: AgentMode): Promise<void> {
    const key = this.activeKey
    if (!key) throw new Error('没有活动会话')
    this.desiredModes.set(key, mode)
    const backend = this.getActiveBackend()
    if (!backend) return
    await backend.startPromise
    const commands = await backend.client.getCommands()
    if (!commands.some((command) => command.name === 'plan')) {
      throw new Error('计划模式扩展未加载')
    }
    await backend.client.prompt(mode === 'plan' ? '/plan start' : '/plan exit')
    backend.modePrimed = mode
  }

  // ---------------------------------------------------------------- models

  async getModels(): Promise<ModelOption[]> {
    const backend = await this.waitForActiveBackend()
    if (!backend) return []
    try {
      const models = await backend.client.getAvailableModels()
      return models.map((m) => ({
        provider: m.provider,
        id: m.id,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning
      }))
    } catch {
      return []
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const backend = await this.ensureActiveBackend()
    await backend.client.setModel(provider, modelId)
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

    const agentDir = getAgentDir()
    const trust = this.getProjectTrust(cwd)
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: trust.decision === 'trusted'
    })
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager })
    await resourceLoader.reload()

    const skills = new Map<string, SkillInfo>()
    for (const skill of resourceLoader.getSkills().skills) {
      if (!skills.has(skill.name)) {
        skills.set(skill.name, {
          name: skill.name,
          description: skill.description,
          source: skill.sourceInfo.source
        })
      }
    }

    const tools = new Map<string, AgentCapabilities['tools'][number]>()
    for (const extension of resourceLoader.getExtensions().extensions) {
      for (const { definition, sourceInfo } of extension.tools.values()) {
        if (!tools.has(definition.name)) {
          tools.set(definition.name, {
            name: definition.name,
            label: definition.label,
            description: definition.description,
            source: sourceInfo.source
          })
        }
      }
    }

    return { skills: [...skills.values()], tools: [...tools.values()] }
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
    if (!this.client) throw new Error('agent 未启动')
    await this.client.compact(customInstructions?.trim() || undefined)
    await this.refresh()
  }

  async exportSessionHtml(): Promise<string> {
    if (!this.client) throw new Error('agent 未启动')
    const result = await this.client.exportHtml()
    return result.path
  }

  async renameSession(name: string): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    await this.client.setSessionName(name)
    await this.refresh()
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
      return {
        provider: context.model?.provider,
        model: context.model?.modelId,
        modelId: context.model?.modelId,
        thinkingLevel: context.thinkingLevel,
        isStreaming: false,
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
