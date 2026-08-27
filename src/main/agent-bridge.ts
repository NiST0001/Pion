import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { RpcClient, getPackageDir } from '@earendil-works/pi-coding-agent'
import type { AgentStatus, SessionInfo } from '../shared/types'

const EVENT_CHANNEL = 'pion:agent-event'
const STATUS_CHANNEL = 'pion:agent-status'
const STATE_CHANNEL = 'pion:agent-state'

/** Events after which the session info is re-pushed to the renderer. */
const STATE_REFRESH_EVENTS = new Set([
  'agent_settled',
  'session_info_changed',
  'thinking_level_changed'
])

/**
 * Owns the pi agent RPC subprocess.
 *
 * pi runs headless (`node dist/cli.js --mode rpc`) and speaks JSON lines on
 * stdin/stdout; `RpcClient` handles the framing. This bridge forwards every
 * event to the renderer and keeps a small amount of derived state in sync.
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
        void this.pushState()
      }
    })

    this.client = client
    try {
      await client.start()
      console.log('[pion] agent subprocess running, cwd:', cwd)
      this.setStatus({ phase: 'running' })
      await this.pushState()
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

  async abort(): Promise<void> {
    await this.client?.abort()
  }

  async getSessionInfo(): Promise<SessionInfo | null> {
    if (!this.client) return null
    try {
      return await this.toSessionInfo()
    } catch {
      return null
    }
  }

  getStderr(): string {
    return this.client?.getStderr() ?? ''
  }

  private async toSessionInfo(): Promise<SessionInfo | null> {
    const client = this.client
    if (!client) return null
    const state = await client.getState()
    return {
      provider: state.model?.provider,
      model: state.model?.id,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      sessionName: state.sessionName,
      messageCount: state.messageCount,
      pendingMessageCount: state.pendingMessageCount
    }
  }

  private async pushState(): Promise<void> {
    const info = await this.getSessionInfo()
    this.win?.webContents.send(STATE_CHANNEL, info)
  }
}
