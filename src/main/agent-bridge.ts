import { resolve, join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import {
  RpcClient,
  SessionManager,
  getPackageDir
} from '@earendil-works/pi-coding-agent'
import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type {
  AgentStatus,
  DeleteSessionResult,
  ForkMessageOption,
  ModelOption,
  SessionInfo,
  SessionMeta,
  TreeNodeLite,
  WireEntry,
  WireMessage
} from '../shared/types'
import { messageText } from '../shared/types'

const EVENT_CHANNEL = 'pion:agent-event'
const STATUS_CHANNEL = 'pion:agent-status'
const STATE_CHANNEL = 'pion:agent-state'
const SESSIONS_CHANNEL = 'pion:agent-sessions'
const TREE_CHANNEL = 'pion:agent-tree'

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

/**
 * Owns the pi agent RPC subprocess.
 *
 * pi runs headless (`node dist/cli.js --mode rpc`) and speaks JSON lines on
 * stdin/stdout; `RpcClient` handles the framing. This bridge forwards every
 * event to the renderer and keeps derived state (session list, branch tree)
 * in sync.
 */
export class AgentBridge {
  private client: RpcClient | null = null
  private win: BrowserWindow | null = null
  private status: AgentStatus = { phase: 'stopped' }

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

  async start(cwd: string): Promise<void> {
    if (this.client) {
      if (this.status.cwd === cwd) return
      await this.stop()
    }

    this.setStatus({ phase: 'starting', error: undefined, cwd })

    // RpcClient spawns `node <cliPath> --mode rpc`; the path must be absolute.
    const cliPath = join(getPackageDir(), 'dist', 'cli.js')
    const client = new RpcClient({ cliPath, cwd })

    client.onEvent((event) => {
      this.win?.webContents.send(EVENT_CHANNEL, event)
      const type = (event as { type?: string }).type
      if (typeof type === 'string' && STATE_REFRESH_EVENTS.has(type)) {
        void this.refresh()
      }
    })

    this.client = client
    try {
      await client.start()
      console.log('[pion] agent subprocess running, cwd:', cwd)
      this.setStatus({ phase: 'running' })
      await this.refresh()
    } catch (err) {
      this.client = null
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({ phase: 'error', error: message })
    }
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    if (client) {
      try {
        await client.stop()
      } catch {
        // the subprocess may already be gone; nothing to recover
      }
    }
    this.setStatus({ phase: 'stopped' })
  }

  /** Prompt when idle, steer when mid-run. */
  async send(message: string): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    const state = await this.client.getState().catch(() => null)
    if (state?.isStreaming) {
      await this.client.steer(message)
    } else {
      await this.client.prompt(message)
    }
  }

  /** Queue a follow-up while running; fall back to a prompt when idle. */
  async queue(message: string): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    const state = await this.client.getState().catch(() => null)
    if (state?.isStreaming) {
      await this.client.followUp(message)
    } else {
      await this.client.prompt(message)
    }
  }

  async abort(): Promise<void> {
    await this.client?.abort()
  }

  getStderr(): string {
    return this.client?.getStderr() ?? ''
  }

  // ---------------------------------------------------------------- sessions

  async newSession(): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    const result = await this.client.newSession()
    if (!result.cancelled) await this.refresh()
  }

  /**
   * Fork the session right before a user message entry.
   * Resolves with that message's text (to prefill the composer).
   */
  async forkAt(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    if (!this.client) throw new Error('agent 未启动')
    const result = await this.client.fork(entryId)
    if (!result.cancelled) await this.refresh()
    return { text: result.text, cancelled: result.cancelled }
  }

  async switchSession(sessionPath: string): Promise<void> {
    if (!this.client) throw new Error('agent 未启动')
    const result = await this.client.switchSession(sessionPath)
    if (!result.cancelled) await this.refresh()
  }

  /** Resolve a session path against the sessions visible for the active cwd. */
  private async resolveListedSession(sessionPath: string): Promise<string> {
    const cwd = this.status.cwd
    if (!cwd) throw new Error('没有活动工作目录')
    const requested = resolve(sessionPath)
    const sessions = await SessionManager.list(cwd)
    const match = sessions.find((session) => resolve(session.path) === requested)
    if (!match) throw new Error('会话不存在，或不属于当前项目')
    return resolve(match.path)
  }

  /** Switch to a listed session without refreshing the renderer mid-operation. */
  private async activateSession(sessionPath: string): Promise<boolean> {
    if (!this.client) throw new Error('agent 未启动')
    const target = await this.resolveListedSession(sessionPath)
    const state = await this.client.getState()
    if (state.sessionFile && resolve(state.sessionFile) === target) return true
    const result = await this.client.switchSession(target)
    return !result.cancelled
  }

  async deleteSession(sessionPath: string): Promise<DeleteSessionResult> {
    if (!this.client) throw new Error('agent 未启动')
    const target = await this.resolveListedSession(sessionPath)
    const state = await this.client.getState()
    const active = Boolean(state.sessionFile && resolve(state.sessionFile) === target)

    // The RPC process may still append to its active file. Move it to a fresh
    // session first, then remove the old file.
    if (active) {
      const result = await this.client.newSession()
      if (result.cancelled) return { activeSessionChanged: false, cancelled: true }
    }

    await unlink(target)
    await this.refresh()
    return { activeSessionChanged: active }
  }

  async copySession(sessionPath: string): Promise<{ cancelled: boolean }> {
    if (!this.client) throw new Error('agent 未启动')
    if (!(await this.activateSession(sessionPath))) return { cancelled: true }
    const result = await this.client.clone()
    await this.refresh()
    return result
  }

  async getSessionForkMessages(sessionPath: string): Promise<ForkMessageOption[]> {
    const target = await this.resolveListedSession(sessionPath)
    const manager = SessionManager.open(target)
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
    if (!this.client) throw new Error('agent 未启动')
    if (!(await this.activateSession(sessionPath))) return { text: '', cancelled: true }
    const result = await this.client.fork(entryId)
    if (!result.cancelled) await this.refresh()
    return result
  }

  async getEntries(): Promise<{ entries: WireEntry[]; leafId: string | null } | null> {
    if (!this.client) return null
    try {
      const { entries, leafId } = await this.client.getEntries()
      return { entries: entries.map(toWireEntry), leafId }
    } catch {
      return null
    }
  }

  async getTree(): Promise<PushedTree | null> {
    if (!this.client) return null
    try {
      const { tree, leafId } = await this.client.getTree()
      return { tree: tree.map(toTreeNodeLite), leafId }
    } catch {
      return null
    }
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
    if (!this.client) return null
    try {
      return await this.toSessionInfo()
    } catch {
      return null
    }
  }

  private async toSessionInfo(): Promise<SessionInfo | null> {
    const client = this.client
    if (!client) return null
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

  /** Push state + session list + branch tree to the renderer. */
  private async refresh(): Promise<void> {
    const info = await this.getSessionInfo()
    this.win?.webContents.send(STATE_CHANNEL, info)
    const sessions = await this.listSessions()
    this.win?.webContents.send(SESSIONS_CHANNEL, sessions)
    const tree = await this.getTree()
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
