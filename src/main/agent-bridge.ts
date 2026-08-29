import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { access, unlink } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import {
  RpcClient,
  SessionManager,
  getPackageDir
} from '@earendil-works/pi-coding-agent'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { IPC_EVENTS } from '../shared/ipc'
import type {
  AgentMode,
  AgentStatus,
  BranchInfo,
  DeleteSessionResult,
  ForkMessageOption,
  ModelOption,
  SessionEntriesPage,
  SessionInfo,
  SessionMeta,
  SkillInfo,
  SlashCommandInfo,
  TreeNodeLite,
  WireEntry,
  WireMessage
} from '../shared/types'
import { messageText } from '../shared/types'
import { createWorktreeBranch, listBranchInfos } from './git'
import {
  filterToolResults,
  sessionMode,
  toTreeNodeLite,
  toWireEntry,
  toolCallIds
} from './wire'

const EVENT_CHANNEL = IPC_EVENTS.AgentEvent
const STATUS_CHANNEL = IPC_EVENTS.AgentStatus
const STATE_CHANNEL = IPC_EVENTS.AgentState
const SESSIONS_CHANNEL = IPC_EVENTS.AgentSessions
const TREE_CHANNEL = IPC_EVENTS.AgentTree
const PLAN_EXTENSION_PATH = resolve(__dirname, '../../node_modules/@narumitw/pi-plan-mode/dist/index.ts')
/** Global pool size shared by every project and worktree. */
const MAX_RETAINED_BACKENDS = 10

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

interface BackendRecord {
  key: string
  cwd: string
  sessionPath?: string
  client: RpcClient
  phase: BackendPhase
  modePrimed?: AgentMode
  startPromise: Promise<void>
}

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
  }

  unbind(win: BrowserWindow): void {
    if (this.win === win) this.win = null
  }

  getStatus(): AgentStatus {
    return this.status
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch }
    this.win?.webContents.send(STATUS_CHANNEL, this.status)
  }

  // ---------------------------------------------------------------- lifecycle

  /** Select a workspace; an individual session backend loads when selected. */
  async start(cwd: string): Promise<void> {
    this.stopping = false
    const normalizedCwd = resolve(cwd)
    if (this.activeCwd === normalizedCwd && this.activeKey) return
    this.activeCwd = normalizedCwd
    this.activeSessionPath = undefined
    this.activeKey = this.newSessionKey(normalizedCwd)
    this.setStatus({ phase: 'ready', error: undefined, cwd: normalizedCwd })
    void this.pushSessionInfo()
  }

  private newSessionKey(cwd: string): string {
    return `new:${resolve(cwd)}:${randomUUID()}`
  }

  private backendArgs(sessionPath?: string): Promise<string[]> {
    return pathExists(PLAN_EXTENSION_PATH).then((hasPlanExtension) => {
      if (!hasPlanExtension) {
        console.warn('[pion] plan mode extension not found:', PLAN_EXTENSION_PATH)
      }
      return [
        ...(hasPlanExtension ? ['--extension', PLAN_EXTENSION_PATH] : []),
        ...(sessionPath ? ['--session', sessionPath] : [])
      ]
    })
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
      if (type === 'agent_start') backend.phase = 'running'
      if (this.activeKey !== backend.key) return
      if (type === 'agent_start') this.setActiveBackendStatus()
      this.win?.webContents.send(EVENT_CHANNEL, event)
      if (typeof type === 'string' && STATE_REFRESH_EVENTS.has(type)) {
        void this.pushSessionInfo()
        void this.refreshSidebarSessions()
      }
      if (type === 'agent_start' || type === 'message_start') {
        void this.syncBackendSession(backend)
      }
    })
  }

  private async createBackend(
    key: string,
    cwd: string,
    sessionPath?: string
  ): Promise<BackendRecord> {
    const cliPath = join(getPackageDir(), 'dist', 'cli.js')
    const args = await this.backendArgs(sessionPath)
    const client = new RpcClient({ cliPath, cwd, args })
    const backend = {
      key,
      cwd,
      sessionPath,
      client,
      phase: 'starting' as BackendPhase,
      startPromise: Promise.resolve()
    }
    this.backends.set(key, backend)
    this.backendOrder.push(key)
    if (sessionPath) this.backendKeysBySessionPath.set(resolve(sessionPath), key)
    this.attachBackendEvents(backend)
    if (this.activeKey === key) this.setActiveBackendStatus()

    const startPromise = client.start()
      .then(() => {
        backend.phase = 'running'
        console.log('[pion] agent subprocess running, session:', sessionPath ?? key)
        if (this.activeKey === key) this.setActiveBackendStatus()
        void this.pushSessionInfo()
        void this.refreshSidebarSessions()
      })
      .catch((error: unknown) => {
        backend.phase = 'error'
        this.backends.delete(key)
        this.removeBackendFromOrder(key)
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
  }

  async stop(): Promise<void> {
    this.stopping = true
    const pendingStarts = [...this.backendStarts.values()]
    await Promise.allSettled(pendingStarts)
    const backends = [...this.backends.values()]
    this.backends.clear()
    this.backendStarts.clear()
    this.backendOrder.length = 0
    this.backendKeysBySessionPath.clear()
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
  }

  /** Prompt when idle, steer when mid-run. Starts only this session's backend. */
  async send(message: string): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const state = await backend.client.getState().catch(() => null)
    if (state?.isStreaming) {
      await backend.client.steer(message)
    } else {
      await this.applyDesiredMode(backend)
      await backend.client.prompt(message)
    }
    await this.syncBackendSession(backend)
  }

  /** Queue a follow-up while running; starts this session's backend if needed. */
  async queue(message: string): Promise<void> {
    const backend = await this.ensureActiveBackend()
    const state = await backend.client.getState().catch(() => null)
    if (state?.isStreaming) {
      await backend.client.followUp(message)
    } else {
      await this.applyDesiredMode(backend)
      await backend.client.prompt(message)
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
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) throw new Error('没有活动工作目录')
    this.activeCwd = resolve(cwd)
    this.activeSessionPath = undefined
    this.activeKey = this.newSessionKey(this.activeCwd)
    this.setStatus({ phase: 'ready', error: undefined, cwd: this.activeCwd })
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
    const target = await this.resolveListedSession(sessionPath)
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
    this.backends.delete(key)
    this.removeBackendFromOrder(key)
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

  private async getActiveEntries(): Promise<{ entries: SessionEntry[]; leafId: string | null } | null> {
    const backend = this.getActiveBackend()
    try {
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

  async getEntriesPage(before?: number, limit = 160): Promise<SessionEntriesPage | null> {
    const result = await this.getActiveEntries()
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
      const result = backend
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
    const backend = await this.waitForActiveBackend()
    if (!backend) return []
    try {
      const commands = await backend.client.getCommands()
      return commands.map(({ name, description, source }) => ({ name, description, source }))
    } catch {
      return []
    }
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
    if (!this.client) throw new Error('agent 未启动')
    await this.client.setModel(provider, modelId)
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
          description: command.description
        }))
    } catch {
      return []
    }
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
    if (!this.client) throw new Error('agent 未启动')
    type ThinkingLevelParam = Parameters<RpcClient['setThinkingLevel']>[0]
    await this.client.setThinkingLevel(level as ThinkingLevelParam)
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

  async compactNow(): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    await this.client.compact()
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
      if (backend) return await this.toSessionInfo(backend.client)
      if (!this.activeSessionPath) return null
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
    const info = await this.getSessionInfo()
    this.win?.webContents.send(STATE_CHANNEL, info)
  }

  private async refreshSidebarSessions(): Promise<void> {
    const sessions = await this.listSessions()
    this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
  }

  /** Push state + session list + branch tree to the renderer. */
  private async refresh(): Promise<void> {
    const [info, sessions, tree] = await Promise.all([
      this.getSessionInfo(),
      this.listSessions(),
      this.getTree()
    ])
    this.win?.webContents.send(STATE_CHANNEL, info)
    this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
    this.win?.webContents.send(TREE_CHANNEL, tree)
  }
}
