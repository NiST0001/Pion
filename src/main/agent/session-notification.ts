import { notificationText } from '../system-notifications'
import type { BackendRecord } from './types'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Read only final ordinary assistant text, never stream deltas or tool/media payloads. */
function assistantSummary(value: unknown): string | undefined {
  const message = object(value)
  if (message.role !== 'assistant' || message.stopReason !== 'stop' || message.errorMessage) return undefined
  const content = message.content
  if (typeof content !== 'string' && (!Array.isArray(content) || content.length > 4096)) return undefined
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  let text = ''
  for (const value of parts) {
    const part = object(value)
    if (part.type !== 'text' && part.type !== 'thinking' && part.type !== 'image') return undefined
    // Even after the preview is full, inspect discriminants to reject trailing tool calls.
    if (part.type === 'text' && typeof part.text === 'string' && text.length < 4096) {
      text += part.text.slice(0, 4096 - text.length)
    }
  }
  return notificationText(text, 180) || undefined
}

/** One bounded preview per complete SDK root turn. No messages or history are retained. */
export class SessionNotificationTurn {
  private readonly client: BackendRecord['client']
  private readonly cwd: string
  private readonly sessionPath?: string
  private readonly runId?: string
  private readonly backendId?: string
  private readonly projection: BackendRecord['liveState']
  private readonly capability: BackendRecord['capability']
  private readonly epoch?: object
  private inputSeen = false
  private assistantSeen = false
  private steered = false
  private finalSeen = false
  private preview?: string
  settled = false

  constructor(backend: BackendRecord) {
    this.client = backend.client
    this.cwd = backend.cwd
    this.sessionPath = backend.sessionPath
    this.runId = backend.activeRunId
    this.backendId = backend.usageBackendId
    this.projection = backend.liveState
    this.capability = backend.capability
    this.epoch = backend.capability?.epoch
  }

  owned(backend: BackendRecord): boolean {
    return this.client === backend.client && this.cwd === backend.cwd && this.sessionPath === backend.sessionPath
      && this.runId === backend.activeRunId && this.backendId === backend.usageBackendId
      && this.projection === backend.liveState && this.capability === backend.capability
      && this.epoch === backend.capability?.epoch
  }

  record(event: unknown): void {
    const value = object(event)
    if (value.type === 'agent_settled') { this.settled = true; return }
    if (this.settled) return
    if (value.type === 'message_start' && object(value.message).role === 'user') {
      this.steered ||= this.inputSeen || this.assistantSeen
      this.inputSeen = true
      this.preview = undefined
      this.finalSeen = false
    }
    if (value.type === 'message_start' && object(value.message).role === 'assistant') {
      this.assistantSeen = true
      this.preview = undefined
      this.finalSeen = false
    }
    if (value.type === 'message_end' && object(value.message).role === 'assistant') {
      this.assistantSeen = true
      this.preview = assistantSummary(value.message)
      this.finalSeen = true // An empty/error final is authoritative too.
    }
    if (value.type === 'agent_end' && !value.willRetry) {
      const messages = value.messages
      if (!Array.isArray(messages)) return
      let tail: unknown
      for (let index = messages.length - 1; index >= 0; index--) {
        if (['user', 'assistant'].includes(String(object(messages[index]).role))) { tail = messages[index]; break }
      }
      if (object(tail).role !== 'assistant') { this.preview = undefined; return }
      // After steer, only a final observed after that input may supply a preview.
      // The agent_end array alone can contain the earlier assistant response.
      if (!this.finalSeen && !this.steered) this.preview = assistantSummary(tail)
    }
  }

  summary(backend: BackendRecord): string | undefined {
    return this.owned(backend) ? this.preview : undefined
  }
}
