import { basename, dirname, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { access, mkdir, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import {
  RpcClient,
  SessionManager,
  getPackageDir
} from '@earendil-works/pi-coding-agent'
import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type {
  AgentMode,
  AgentStatus,
  BranchInfo,
  DeleteSessionResult,
  ForkMessageOption,
  ModelOption,
  SessionInfo,
  SessionMeta,
  SkillInfo,
  SlashCommandInfo,
  TreeNodeLite,
  WireEntry,
  WireMessage
} from '../shared/types'
import { messageText } from '../shared/types'

const execFileAsync = promisify(execFile)

const EVENT_CHANNEL = 'pion:agent-event'
const STATUS_CHANNEL = 'pion:agent-status'
const STATE_CHANNEL = 'pion:agent-state'
const SESSIONS_CHANNEL = 'pion:agent-sessions'
const TREE_CHANNEL = 'pion:agent-tree'
const PLAN_EXTENSION_PATH = resolve(__dirname, '../../node_modules/@narumitw/pi-plan-mode/dist/index.ts')

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

interface GitWorktreeRecord {
  path: string
  branch?: string
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

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  })
  return String(stdout).trim()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function parseGitWorktrees(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = []
  let current: GitWorktreeRecord | null = null
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  if (current) records.push(current)
  return records
}

/**
 * Owns the per-session pi agent RPC subprocesses.
 *
 * pi runs headless (`node dist/cli.js --mode rpc`) and speaks JSON lines on
 * stdin/stdout; `RpcClient` handles the framing. Backends are created lazily
 * on the first prompt for a session and remain alive while another session is
 * selected. Only the active backend's events are forwarded to the renderer.
 */
export class AgentBridge {
  private readonly backends = new Map<string, BackendRecord>()
  private readonly backendStarts = new Map<string, Promise<BackendRecord>>()
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

  /** Select a workspace only. Its agent process is started lazily on first send. */
  async start(cwd: string): Promise<void> {
    const normalizedCwd = resolve(cwd)
    if (this.activeCwd === normalizedCwd && this.activeKey) return
    this.activeCwd = normalizedCwd
    this.activeSessionPath = undefined
    this.activeKey = this.newSessionKey(normalizedCwd)
    this.setStatus({ phase: 'ready', error: undefined, cwd: normalizedCwd })
    void this.refresh()
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
        void this.refresh()
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
    if (sessionPath) this.backendKeysBySessionPath.set(resolve(sessionPath), key)
    this.attachBackendEvents(backend)
    if (this.activeKey === key) this.setActiveBackendStatus()

    const startPromise = client.start()
      .then(() => {
        backend.phase = 'running'
        console.log('[pion] agent subprocess running, session:', sessionPath ?? key)
        if (this.activeKey === key) this.setActiveBackendStatus()
        void this.refresh()
      })
      .catch((error: unknown) => {
        backend.phase = 'error'
        this.backends.delete(key)
        if (sessionPath) this.backendKeysBySessionPath.delete(resolve(sessionPath))
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

  private async ensureActiveBackend(): Promise<BackendRecord> {
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
        const start = this.createBackend(key, activeCwd, this.activeSessionPath)
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
    const backends = [...this.backends.values()]
    this.backends.clear()
    this.backendKeysBySessionPath.clear()
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
    await this.refresh()
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
    await this.refresh()
    return { text: result.text, cancelled: false }
  }

  /** Selecting a session only changes the active session pointer. */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const target = await this.resolveListedSession(sessionPath)
    const manager = this.openSessionManager(target)
    this.activateLogicalSession(target, manager.getCwd() || this.activeCwd)
    void this.refreshSessionInfo()
    return { cancelled: false }
  }

  /** Resolve a session path against the sessions visible for the active cwd. */
  private async resolveListedSession(sessionPath: string): Promise<string> {
    const cwd = this.activeCwd ?? this.status.cwd
    if (!cwd) throw new Error('没有活动工作目录')
    const requested = resolve(sessionPath)
    const sessions = await SessionManager.list(cwd)
    const match = sessions.find((session) => resolve(session.path) === requested)
    if (!match) throw new Error('会话不存在，或不属于当前项目')
    return resolve(match.path)
  }

  private async stopBackend(key: string): Promise<void> {
    const backend = this.backends.get(key)
    if (!backend) return
    this.backends.delete(key)
    if (backend.sessionPath) this.backendKeysBySessionPath.delete(resolve(backend.sessionPath))
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
    await this.refresh()
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
    await this.refresh()
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
    await this.refresh()
    return { text: result.text, cancelled: false }
  }

  async getEntries(): Promise<{ entries: WireEntry[]; leafId: string | null } | null> {
    const backend = this.getActiveBackend()
    try {
      if (backend) {
        const { entries, leafId } = await backend.client.getEntries()
        return { entries: entries.map(toWireEntry), leafId }
      }
      if (this.activeSessionPath) {
        const manager = this.openSessionManager(this.activeSessionPath)
        return { entries: manager.getEntries().map(toWireEntry), leafId: manager.getLeafId() }
      }
      return { entries: [], leafId: null }
    } catch {
      return null
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
    if (!this.client) return []
    try {
      const commands = await this.client.getCommands()
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
    if (!this.client) return []
    try {
      const models = await this.client.getAvailableModels()
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
    if (!this.client) return []
    try {
      const commands = await this.client.getCommands()
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
    if (!this.client) return []
    try {
      return await this.client.getAvailableThinkingLevels()
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
    const requestedCwd = resolve(cwd)
    try {
      const root = resolve(await runGit(requestedCwd, ['rev-parse', '--show-toplevel']))
      const records = parseGitWorktrees(await runGit(root, ['worktree', 'list', '--porcelain']))
      const mainRecord = records.find((record) => resolve(record.path) === root)
      const currentBranch = mainRecord?.branch ?? await runGit(root, ['branch', '--show-current']).catch(() => '')
      const branches = records.map((record) => {
        const worktreeCwd = resolve(record.path)
        const isMain = worktreeCwd === root
        const gitBranch = record.branch ?? (isMain ? currentBranch : undefined)
        return {
          name: isMain ? (gitBranch || 'main') : (gitBranch || basename(worktreeCwd)),
          cwd: worktreeCwd,
          gitBranch: gitBranch || undefined,
          isMain
        }
      })
      if (branches.some((branch) => branch.isMain)) return branches
      return [{ name: currentBranch || 'main', cwd: root, gitBranch: currentBranch || undefined, isMain: true }]
    } catch {
      return [{ name: 'main', cwd: requestedCwd, isMain: true }]
    }
  }

  async createBranch(cwd: string, branchName: string): Promise<BranchInfo> {
    const name = branchName.trim()
    if (!name) throw new Error('分支名称不能为空')
    const root = resolve(await runGit(resolve(cwd), ['rev-parse', '--show-toplevel']))
    await runGit(root, ['check-ref-format', '--branch', name])

    const worktreeRoot = join(dirname(root), '.pion-worktrees')
    await mkdir(worktreeRoot, { recursive: true })
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
    const stem = `${basename(root)}-${safeName}`
    let worktreeCwd = join(worktreeRoot, stem)
    let suffix = 2
    while (await pathExists(worktreeCwd)) {
      worktreeCwd = join(worktreeRoot, `${stem}-${suffix}`)
      suffix += 1
    }

    await runGit(root, ['worktree', 'add', '-b', name, worktreeCwd])
    const branch = (await this.listBranches(root)).find((item) => item.cwd === resolve(worktreeCwd))
    return branch ?? { name, cwd: resolve(worktreeCwd), gitBranch: name, isMain: false }
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

  /** Push only the active session state after a session switch. */
  private async refreshSessionInfo(): Promise<void> {
    this.win?.webContents.send(STATE_CHANNEL, await this.getSessionInfo())
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

// ---------------------------------------------------------------------------
// Mapping helpers (SDK shapes -> wire shapes)
// ---------------------------------------------------------------------------

function toWireEntry(entry: SessionEntry): WireEntry {
  const wire: WireEntry = {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp
  }
  const record = entry as unknown as Record<string, unknown>
  if (entry.type === 'message') {
    wire.message = record.message as WireMessage
  } else if (entry.type === 'compaction') {
    wire.summary = record.summary as string
  } else if (entry.type === 'custom') {
    if (typeof record.customType === 'string') wire.customType = record.customType
    wire.data = record.data
  }
  return wire
}

function toTreeNodeLite(node: SessionTreeNode): TreeNodeLite {
  const entry = node.entry as unknown as Record<string, unknown>
  const message = entry.message as WireMessage | undefined
  let kind: TreeNodeLite['kind'] = 'other'
  let snippet = ''
  if (message?.role === 'user') {
    kind = 'user'
    snippet = messageText(message).replace(/\s+/g, ' ').slice(0, 90)
  } else if (message?.role === 'assistant') {
    kind = 'assistant'
    snippet = messageText(message).replace(/\s+/g, ' ').slice(0, 70)
  } else if (node.entry.type === 'compaction') {
    kind = 'compaction'
    snippet = '上下文压缩点'
  } else if (node.entry.type === 'branch_summary') {
    kind = 'other'
    snippet = '分支摘要'
  } else {
    snippet = node.entry.type
  }
  return {
    id: node.entry.id,
    parentId: node.entry.parentId,
    kind,
    snippet: snippet || '(空)',
    label: node.label,
    children: node.children.map(toTreeNodeLite)
  }
}
