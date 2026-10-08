import { randomUUID } from 'node:crypto'
import type { LiveSessionState, WireEventInput, WireMessage } from '../../shared/types'
import { collectToolImages } from '../../shared/tool-images'
import { generatedImageModelInfo, generatedImageSettingsInfo } from '../../shared/image-generation'

export const LIVE_MAX_ROWS = 256
export const LIVE_MAX_BYTES = 4 * 1024 * 1024
const VALUE_BYTES = 32 * 1024
const RESULT_BYTES = 768 * 1024
const ROW_OVERHEAD = 1024
// Reserve wrappers, bounded identities/errors and snapshot scope metadata as well as text.
const MESSAGE_OVERHEAD = 16 * 1024
const STREAM_RESERVE = 32 * 1024

type TruncatedField = 'text' | 'thinking' | 'error' | 'diff' | 'outputText'
type Row = {
  truncatedFields?: Set<TruncatedField>
  role: string
  id?: string
  timestamp?: unknown
  events: WireEventInput[]
  text: string
  thinking: string
  textBytes: number
  bytes: number
  streaming?: boolean
  finalResult?: boolean
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '')

/** Current root turn only. Never retain SDK model/state objects or token-event queues. */
export class LiveSessionProjection {
  readonly backendId = randomUUID()
  revision = 0
  private rows: Row[] = []
  private bytes = 0
  private truncated = false
  private assistant?: Row

  metadata(cwd: string, sessionPath?: string): Omit<LiveSessionState, 'events' | 'truncated'> {
    return { backendId: this.backendId, revision: this.revision, cwd, ...(sessionPath ? { sessionPath } : {}) }
  }

  snapshot(cwd: string, sessionPath?: string): LiveSessionState {
    const events: WireEventInput[] = []
    for (const row of this.rows) {
      const start = row.events[0]
      events.push(row.streaming && row.truncatedFields?.size && start.type === 'message_start'
        ? { ...start, message: { ...object(start.message), _pionLiveTruncatedFields: [...row.truncatedFields] } } as WireEventInput : start)
      if (row.streaming) {
        if (row.text) events.push({ type: 'message_update', usage: undefined, assistantMessageEvent: { type: 'text_delta', delta: row.text } })
        if (row.thinking) events.push({ type: 'message_update', usage: undefined, assistantMessageEvent: { type: 'thinking_delta', delta: row.thinking } })
      }
      events.push(...row.events.slice(1))
    }
    // Clone only the bounded projection, so a pending STATE send cannot observe later mutation.
    return { ...this.metadata(cwd, sessionPath), events: JSON.parse(JSON.stringify(events)), ...(this.truncated ? { truncated: true } : {}) }
  }

  record(input: unknown): void {
    const event = object(input)
    if (typeof event.parentToolCallId === 'string' && event.parentToolCallId) return
    // Even ignored root lifecycle events advance: an awaited state must not rewind newer events.
    this.revision++
    if (event.type === 'agent_start') {
      this.rows = []; this.bytes = 0; this.assistant = undefined; this.truncated = false
      return
    }
    if (event.type === 'message_start') {
      const message = object(event.message)
      if (message.role !== 'assistant' && message.role !== 'user') return
      // Each start has its own stable identity; don't concatenate sequential assistants.
      const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp : typeof message.timestamp === 'string' && message.timestamp.length <= 128
          ? message.timestamp : Date.now()
      const safe = message.role === 'assistant'
        ? { role: 'assistant', timestamp, content: [] } as WireMessage
        : this.message(message, VALUE_BYTES)
      safe.timestamp = timestamp
      const row: Row = { role: String(message.role), timestamp, events: [{ type: 'message_start', message: safe }], text: '', thinking: '', textBytes: 0, bytes: ROW_OVERHEAD + encodedBytes([{ type: 'message_start', message: safe }]), streaming: message.role === 'assistant' }
      if (row.streaming) this.assistant = row
      this.add(row)
      return
    }
    if (event.type === 'message_update') {
      const sub = object(event.assistantMessageEvent)
      const row = this.assistant
      if (!row?.streaming) return
      if (sub.type === 'error') {
        const raw = object(sub.error)
        const error = this.message({ role: 'assistant', errorMessage: raw.errorMessage, stopReason: raw.stopReason }, VALUE_BYTES)
        this.replace(row, [row.events[0], ...row.events.slice(1).filter((e) => e.type !== 'message_update'),
          { type: 'message_update', usage: undefined, assistantMessageEvent: { type: 'error', error } }])
        return
      }
      if ((sub.type !== 'text_delta' && sub.type !== 'thinking_delta') || typeof sub.delta !== 'string') return
      const field = sub.type === 'text_delta' ? 'text' : 'thinking'
      if (row.truncatedFields?.has(field)) return
      if (sub.delta.length > LIVE_MAX_BYTES - ROW_OVERHEAD) { this.markRow(row, field); return }
      const size = encodedBytes(sub.delta)
      // Serialize only the incoming delta, never the accumulated turn on the token hot path.
      if (row.bytes + size > LIVE_MAX_BYTES - STREAM_RESERVE) { this.markRow(row, field); return }
      if (sub.type === 'text_delta') row.text += sub.delta
      else row.thinking += sub.delta
      row.textBytes += size; row.bytes += size; this.bytes += size
      this.trim(row)
      return
    }
    if (event.type === 'message_end') {
      const message = object(event.message)
      if (message.role === 'assistant' && this.assistant?.streaming) {
        const row = this.assistant
        const safe = this.message(message, LIVE_MAX_BYTES - STREAM_RESERVE)
        safe.timestamp ??= row.timestamp
        // The final message (including empty text/thinking) replaces all provisional deltas.
        this.bytes -= row.bytes
        row.text = ''; row.thinking = ''; row.textBytes = 0; row.streaming = false
        row.events = [row.events[0], { type: 'message_end', message: safe }, ...row.events.filter((e) => e.type === 'entry_appended')]
        row.bytes = ROW_OVERHEAD + encodedBytes(row.events)
        this.bytes += row.bytes; this.trim(row)
      } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
        const row = this.rows.find((r) => r.role === 'tool' && r.id === message.toolCallId)
        if (!row) return
        const safe = this.message(message, RESULT_BYTES, true)
        this.replace(row, [row.events[0], { type: 'message_end', message: safe }, ...row.events.filter((e) => e.type === 'entry_appended')])
        row.finalResult = true
      }
      return
    }
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      if (event.toolCallId.length > 512) { this.truncated = true; return }
      if (this.rows.some((r) => r.role === 'tool' && r.id === event.toolCallId)) return
      const safe = { type: 'tool_execution_start', toolCallId: event.toolCallId.slice(0, 512), toolName: String(event.toolName ?? '').slice(0, 512), args: this.boundedValue(event.args, VALUE_BYTES) } as WireEventInput
      this.add({ role: 'tool', id: event.toolCallId, events: [safe], text: '', thinking: '', textBytes: 0, bytes: ROW_OVERHEAD + encodedBytes(safe) })
      return
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const row = this.rows.find((r) => r.role === 'tool' && r.id === event.toolCallId)
      if (!row || row.finalResult) return
      const end = event.type === 'tool_execution_end'
      const payload = this.message({ role: 'toolResult', ...object(end ? event.result : event.partialResult) }, end ? RESULT_BYTES : VALUE_BYTES, end)
      this.replace(row, [row.events[0], { type: event.type, toolCallId: row.id!, toolName: String(event.toolName ?? '').slice(0, 512), ...(end ? { result: payload, isError: Boolean(event.isError) } : { partialResult: payload }) } as WireEventInput])
      return
    }
    if (event.type === 'entry_appended') {
      const entry = object(event.entry); const message = object(entry.message)
      if (entry.type !== 'message' || typeof entry.id !== 'string') return
      const row = [...this.rows].reverse().find((r) => message.role === 'toolResult'
        ? r.role === 'tool' && r.id === message.toolCallId
        : r.role === message.role && (message.timestamp === undefined || r.timestamp === message.timestamp))
      if (!row || row.events.some((e) => e.type === 'entry_appended')) return
      // Identity only: the final message already carries the authoritative bounded contents.
      const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp : typeof message.timestamp === 'string' && message.timestamp.length <= 128
          ? message.timestamp : row.timestamp
      const identity = { role: String(message.role), timestamp,
        ...(row.role === 'tool' ? { toolCallId: row.id } : {}) } as WireMessage
      const attached = { type: 'entry_appended', entry: { type: 'message', id: entry.id.slice(0, 512), parentId: null, timestamp: typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 128) : '', message: identity } } as WireEventInput
      this.replace(row, [...row.events, attached])
    }
  }

  private add(row: Row): void { this.rows.push(row); this.bytes += row.bytes; this.trim(row) }
  private replace(row: Row, events: WireEventInput[]): void {
    this.bytes -= row.bytes; row.events = events; row.bytes = ROW_OVERHEAD + encodedBytes(events) + row.textBytes; this.bytes += row.bytes; this.trim(row)
  }
  private trim(protectedRow: Row): void {
    while (this.rows.length > LIVE_MAX_ROWS || this.bytes > LIVE_MAX_BYTES) {
      let index = this.rows.findIndex((r) => r !== protectedRow && r !== this.assistant)
      if (index < 0) index = this.rows.findIndex((r) => r !== this.assistant)
      if (index < 0) {
        // Never pop the start/final event: it is the row's replay identity.
        const row = this.assistant ?? protectedRow
        const attachment = row.events.findIndex((e) => e.type === 'entry_appended')
        if (attachment >= 0) {
          const [event] = row.events.splice(attachment, 1)
          const size = encodedBytes(event) + 1
          row.bytes -= size; this.bytes -= size
        } else if (row.streaming) {
          // A bounded provisional error may arrive after a nearly full stream.
          const excess = this.bytes - (LIVE_MAX_BYTES - STREAM_RESERVE)
          const oldSize = row.textBytes
          const keep = (value: string): string => value.slice(0, Math.max(0, value.length - Math.max(1, excess))).replace(/[\uD800-\uDBFF]$/, '')
          if (row.thinking) { row.thinking = keep(row.thinking); this.markRow(row, 'thinking') }
          else { row.text = keep(row.text); this.markRow(row, 'text') }
          row.textBytes = encodedBytes(row.text) + encodedBytes(row.thinking)
          const reclaimed = oldSize - row.textBytes
          row.bytes -= reclaimed; this.bytes -= reclaimed
        } else {
          // Admission reserves enough space for every non-streaming row.
          break
        }
        this.truncated = true
        continue
      }
      const [removed] = this.rows.splice(index, 1); this.bytes -= removed.bytes; this.truncated = true
    }
  }

  private markRow(row: Row, field: TruncatedField): void {
    this.truncated = true
    ;(row.truncatedFields ??= new Set()).add(field)
    // Annotation bytes are covered by ROW_OVERHEAD, never by the delta budget.
  }

  private message(raw: Record<string, unknown>, budget: number, images = false): WireMessage {
    const result: WireMessage = { role: String(raw.role ?? '').slice(0, 128), ...(typeof raw.timestamp === 'number' || (typeof raw.timestamp === 'string' && raw.timestamp.length <= 128) ? { timestamp: raw.timestamp } : {}), ...(typeof raw.toolCallId === 'string' ? { toolCallId: raw.toolCallId.slice(0, 512) } : {}), ...(typeof raw.isError === 'boolean' ? { isError: raw.isError } : {}) }
    let remaining = budget - MESSAGE_OVERHEAD
    const fields = new Set<TruncatedField>()
    const contentField = raw.role === 'toolResult' ? 'outputText' : 'text'
    const text = (value: unknown, field: TruncatedField = contentField): string => {
      if (typeof value !== 'string' || value === '') return ''
      const size = value.length <= remaining ? encodedBytes(value) : remaining + 1
      if (size <= remaining) { remaining -= size; return value }
      this.truncated = true
      fields.add(field)
      // UTF-16 escape worst case is six bytes/code unit; never split a surrogate pair.
      const shortened = value.slice(0, Math.max(0, Math.floor(remaining / 6))).replace(/[\uD800-\uDBFF]$/, '')
      remaining -= encodedBytes(shortened); return shortened
    }
    if (typeof raw.content === 'string') result.content = text(raw.content)
    else if (Array.isArray(raw.content)) {
      result.content = []
      if (raw.content.length > 128) {
        this.truncated = true
        for (let index = 128; index < raw.content.length; index++) {
          const p = object(raw.content[index])
          if (p.type === 'text' && typeof p.text === 'string' && p.text) fields.add(contentField)
          if (p.type === 'thinking' && typeof p.thinking === 'string' && p.thinking) fields.add('thinking')
          if (fields.has(contentField) && fields.has('thinking')) break
        }
      }
      // Keep validated preview positions stable, so renderer can reuse an
      // already projected image when only final output/settings changed.
      const previews = images ? collectToolImages(raw.content).images : []
      for (let index = 0; index < Math.min(raw.content.length, 128); index++) {
        const p = object(raw.content[index])
        if (p.type === 'text') result.content.push({ type: 'text', text: text(p.text) })
        else if (p.type === 'thinking') result.content.push({ type: 'thinking', thinking: text(p.thinking, 'thinking') })
        else if (images) {
          const image = previews.find((preview) => preview.partIndex === index)
          const size = image ? encodedBytes(image) : 0
          if (image && size <= remaining) {
            remaining -= size
            result.content.push(image as unknown as Record<string, unknown> & { type: string })
          } else {
            if (image) this.truncated = true
            // No raw rejected payload; retain only its slot, not its type/data.
            result.content.push({ type: '_pion_omitted' })
          }
        }
        // User originals are deliberately not retained; renderer preserves cached attachments.
      }
    }
    if (typeof raw.errorMessage === 'string') result.errorMessage = text(raw.errorMessage, 'error')
    if (typeof raw.stopReason === 'string') result.stopReason = raw.stopReason.slice(0, 128)
    if (typeof raw.toolName === 'string') result.toolName = raw.toolName.slice(0, 512)
    if (images) {
      const generated = object(object(raw.details).imageGeneration)
      const model = generatedImageModelInfo(generated)
      const settings = generatedImageSettingsInfo(generated)
      const metadata: Record<string, unknown> = {}
      if (model) {
        metadata.provider = 'openai-codex'; metadata.version = generated.version
        // v1.model is only the request alias, just like v2.requestedModel.
        metadata[generated.version === 1 ? 'model' : 'requestedModel'] = model.requestedModel
        metadata.resolvedModel = null
      }
      if (settings) {
        for (const key of ['operation', 'requestedSize', 'requestedQuality', 'referenceCount'] as const) {
          if (settings[key] !== undefined) metadata[key] = settings[key]
        }
        if (settings.savedWidth !== undefined) metadata.width = settings.savedWidth
        if (settings.savedHeight !== undefined) metadata.height = settings.savedHeight
        if (settings.savedByteLength !== undefined) metadata.byteLength = settings.savedByteLength
      }
      // Existing tool-result output path only; never references or input metadata.
      if (typeof generated.path === 'string' && generated.path.length <= 512) metadata.path = generated.path
      const details: Record<string, unknown> = {}
      if (typeof object(raw.details).diff === 'string') details.diff = text(object(raw.details).diff, 'diff')
      if (Object.keys(metadata).length) details.imageGeneration = metadata
      if (Object.keys(details).length) result.details = details
    }
    if (fields.size) result._pionLiveTruncatedFields = [...fields]
    return result
  }

  private boundedValue(value: unknown, budget: number): unknown {
    let nodes = 0; let remaining = budget
    const visit = (input: unknown, depth: number): unknown => {
      if (++nodes > 256 || depth > 5 || remaining < 64) { this.truncated = true; return undefined }
      if (typeof input === 'string') {
        if (input.length > remaining / 6) { this.truncated = true; return undefined }
        remaining -= encodedBytes(input); return input
      }
      if (input === null || typeof input === 'boolean' || typeof input === 'number') { remaining -= 32; return input }
      if (Array.isArray(input)) { if (input.length > 32) this.truncated = true; return input.slice(0, 32).map((v) => visit(v, depth + 1)) }
      if (input && typeof input === 'object') {
        const output: Record<string, unknown> = {}; let count = 0
        for (const key in input) {
          if (!Object.prototype.hasOwnProperty.call(input, key)) continue
          if (++count > 32 || key.length > 128) { this.truncated = true; break }
          if (/^(?:data|base64|image|images|image_url|referenced_image_paths|mask|apiKey|api_key|authorization|access_token|refresh_token)$/i.test(key)) {
            // Expected redaction, not loss from the live byte budget.
            continue
          }
          remaining -= encodedBytes(key) + 4
          const next = visit(object(input)[key], depth + 1)
          if (next !== undefined) Object.defineProperty(output, key, { value: next, enumerable: true })
        }
        return output
      }
      return undefined
    }
    return visit(value, 0)
  }
}
