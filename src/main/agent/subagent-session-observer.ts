import { randomUUID } from 'node:crypto'
import {
  SUBAGENT_SESSION_MAX_CHARS, SUBAGENT_SESSION_MAX_PACKET_CHARS, SUBAGENT_SESSION_MAX_ROWS,
  SUBAGENT_SESSION_RETENTION_MS, SUBAGENT_SESSION_ADMISSION_TITLE, type SubagentSessionAdmission,
  SUBAGENT_SESSION_WIDGET_KEY, type SubagentSessionNotice, type SubagentSessionRow, type SubagentSessionStatus
} from '../../shared/subagent-sessions'

export interface SubagentSessionObserver {
  event(event: unknown): void
  running(): void
  cancelling(): void
  finish(status: 'completed' | 'failed' | 'aborted'): void
}
export interface SubagentSessionPublisher {
  reserve(parentToolCallId: string, count: number, signal?: AbortSignal): Promise<boolean>
  begin(task: { name: string }, parentToolCallId: string): SubagentSessionObserver | undefined
  halt(): void
}
interface DisplayContext {
  mode?: string
  cwd: string
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined }
  ui: {
    setWidget(key: string, lines: string[]): void
    input?(title: string, placeholder?: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>
  }
}
const FIELD_LIMIT = 8192
const MAX_RUNTIME_CHILDREN = 256
const identity = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined

/** A display-only side channel. RPC input reserves main's display capacity; it is
 * not user tool authorization and does not add tools, model calls or history.
 * Widget key/nonce are routing fences, not authentication against same-process plugins.
 * Local slots retain true terminal tracking for the same TTL as main. */
export function createSubagentSessionPublisher(options: {
  nonce: string | undefined
  createContext(): DisplayContext | undefined
  now?: () => number
}): SubagentSessionPublisher {
  const runtimeId = randomUUID()
  const live = new Set<{ cancel(): void; halt(): void }>()
  const slots = new Map<object, number | undefined>()
  let clock = 0
  const time = () => {
    const value = (options.now ?? (() => performance.now()))()
    if (Number.isFinite(value)) clock = Math.max(clock, value)
    return clock
  }
  let halted = false
  type Reservation = { ui: DisplayContext['ui']; manager: DisplayContext['sessionManager']; cwd: string; sessionId: string; path?: string; parentToolCallId: string; remaining: number; signal?: AbortSignal }
  let reservation: Reservation | undefined
  let pending: AbortController | undefined
  const capture = (parentToolCallId: string, count: number): Reservation | undefined => {
    if (halted || !identity(options.nonce) || !identity(runtimeId) || !identity(parentToolCallId)) return
    const ctx = options.createContext()
    if (!ctx || ctx.mode !== 'rpc') return
    // Real command contexts expose live getters: capture the actual UI/manager,
    // not getters that could silently resolve a replacement client at begin.
    const ui = ctx.ui, manager = ctx.sessionManager, cwd = ctx.cwd
    if (typeof ui.input !== 'function') return
    const sessionId = manager.getSessionId(), path = manager.getSessionFile()
    if (!identity(cwd, 4096) || !identity(sessionId) || (path !== undefined && !identity(path, 4096))) return
    return { ui, manager, cwd, sessionId, path, parentToolCallId, remaining: count }
  }
  const sameContext = (a: Reservation, b: Reservation) => a.cwd === b.cwd && a.sessionId === b.sessionId && a.path === b.path
    && a.manager === b.manager && a.ui === b.ui
  const prune = () => {
    const now = time()
    for (const [slot, deadline] of slots) if (deadline !== undefined && now >= deadline) slots.delete(slot)
  }
  return {
    async reserve(parentToolCallId, count, signal) {
      if (pending) return false
      reservation = undefined
      let controller: AbortController | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => controller?.abort()
      try {
        if (signal?.aborted || !Number.isSafeInteger(count) || count < 1 || count > 8) return false
        prune()
        if (slots.size + count > MAX_RUNTIME_CHILDREN) return false
        const owner = capture(parentToolCallId, count)
        if (!owner) return false
        controller = new AbortController()
        pending = controller
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, 5000)
        const metadata: SubagentSessionAdmission = { version: 1, nonce: options.nonce!, runtimeId, parentToolCallId, count }
        // SDK supports signal/timeout; the local race also fences mocks or a late
        // response that ignores cancellation. Neither timeout nor undefined is consent.
        const cancelled = new Promise<undefined>((resolve) => controller!.signal.addEventListener('abort', () => resolve(undefined), { once: true }))
        const reply = await Promise.race([
          owner.ui.input!(SUBAGENT_SESSION_ADMISSION_TITLE, JSON.stringify(metadata), { signal: controller.signal, timeout: 5000 }), cancelled
        ])
        if (reply !== 'reserved' || controller.signal.aborted || signal?.aborted || halted) return false
        const current = capture(parentToolCallId, count)
        if (!current || !sameContext(owner, current)) return false
        prune()
        if (slots.size + count > MAX_RUNTIME_CHILDREN) return false
        reservation = { ...owner, signal }
        return true
      } catch { return false }
      finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        controller?.abort()
        if (pending === controller) pending = undefined
      }
    },
    begin(task, parentToolCallId) {
      try {
        if (halted || !identity(options.nonce) || !identity(runtimeId)) return undefined
        prune()
        const admitted = reservation
        if (!admitted || admitted.remaining < 1 || admitted.parentToolCallId !== parentToolCallId) return undefined
        if (admitted.signal?.aborted) { reservation = undefined; return undefined }
        const current = capture(parentToolCallId, admitted.remaining)
        if (!current || !sameContext(admitted, current)) { reservation = undefined; return undefined }
        // Consume exactly once, even when starting publication fails. Never reuse
        // a main reservation under another call/runtime/parent context.
        admitted.remaining--
        if (admitted.remaining === 0) reservation = undefined
        if (slots.size >= MAX_RUNTIME_CHILDREN) return undefined
        const parentSessionId = admitted.sessionId
        const parentSessionPath = admitted.path
        const notice: SubagentSessionNotice = {
          version: 1, nonce: options.nonce, source: 'sdk:pion_subagents', runtimeId, id: randomUUID(),
          parentToolCallId, parentSessionId, ...(parentSessionPath !== undefined ? { parentSessionPath } : {}),
          cwd: admitted.cwd, name: identity(task.name, 80) ? task.name : '子代理',
          revision: 0, status: 'starting', truncated: false, rows: []
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        let closed = false
        let sequence = 0
        let assistantId = ''
        // Bounded by retained rows; never retain arbitrary SDK messages/results.
        const toolIds = new Map<string, string>()
        const safe = (fn: () => void) => { try { fn() } catch { /* UI must never affect execution or usage. */ } }
        const clip = (text: string, limit = FIELD_LIMIT) => {
          if (text.length > limit) notice.truncated = true
          return text.slice(0, limit)
        }
        const bound = () => {
          while (notice.rows.length > SUBAGENT_SESSION_MAX_ROWS) { notice.rows.shift(); notice.truncated = true }
          const rowChars = (row: SubagentSessionRow) => row.id.length + row.kind.length + row.text.length + (row.toolName?.length ?? 0) + (row.state?.length ?? 0)
          let chars = notice.rows.reduce((sum, row) => sum + rowChars(row), 0)
          while (chars > SUBAGENT_SESSION_MAX_CHARS && notice.rows.length) {
            chars -= rowChars(notice.rows.shift()!)
            notice.truncated = true
          }
          for (const [key, id] of toolIds) if (!notice.rows.some((row) => row.id === id)) toolIds.delete(key)
        }
        const flush = (): boolean => {
          try {
            if (timer) clearTimeout(timer)
            timer = undefined
            if (closed || halted) return false
            bound()
            notice.revision++
            let packet = JSON.stringify(notice)
            // Escaped control characters can exceed the character budget even
            // when source strings are bounded. Evict rows before publication.
            while (packet.length > SUBAGENT_SESSION_MAX_PACKET_CHARS && notice.rows.length) {
              notice.rows.shift(); notice.truncated = true; packet = JSON.stringify(notice)
            }
            if (packet.length > SUBAGENT_SESSION_MAX_PACKET_CHARS) return false
            admitted.ui.setWidget(SUBAGENT_SESSION_WIDGET_KEY, [packet])
            return true
          } catch { return false }
        }
        const schedule = () => { if (!closed && !halted && !timer) timer = setTimeout(flush, 100) }
        const row = (id: string, kind: SubagentSessionRow['kind'], text: string, extra: Partial<SubagentSessionRow> = {}) => {
          const existing = notice.rows.find((item) => item.id === id)
          if (existing) { existing.text = clip(text); Object.assign(existing, extra) }
          else notice.rows.push({ id, kind, text: clip(text), ...extra })
          bound()
        }
        const textContent = (content: unknown, kind: 'text' | 'thinking') => {
          if (!Array.isArray(content)) return ''
          let text = ''
          const count = Math.min(content.length, SUBAGENT_SESSION_MAX_ROWS)
          if (content.length > count) notice.truncated = true
          for (let n = 0; n < count; n++) {
            const part = object(content[n])
            if (part?.type !== kind || typeof part[kind] !== 'string') continue
            const value = part[kind] as string
            const remaining = FIELD_LIMIT - text.length
            text += value.slice(0, remaining)
            if (value.length > remaining) notice.truncated = true
          }
          return text
        }
        const status = (value: SubagentSessionStatus, immediate = false) => {
          if (closed) return
          // Once cancellation starts, late stream activity cannot revive it.
          if (notice.status === 'cancelling' && (value === 'running' || value === 'starting')) return
          notice.status = value
          if (immediate) flush(); else schedule()
        }
        const owner = {
          cancel: () => safe(() => status('cancelling', true)),
          halt: () => { if (timer) clearTimeout(timer); timer = undefined; closed = true; notice.rows = []; toolIds.clear() }
        }
        // Fail before any model work when even the starting snapshot cannot be
        // published. Later observer failures remain display-only.
        if (!flush()) { owner.halt(); return undefined }
        live.add(owner)
        slots.set(owner, undefined)
        return {
          running: () => safe(() => status('running')),
          cancelling: owner.cancel,
          finish: (value) => safe(() => {
            if (closed) return
            status(value, true)
            slots.set(owner, time() + SUBAGENT_SESSION_RETENTION_MS)
            owner.halt(); live.delete(owner)
          }),
          event: (input) => safe(() => {
            if (closed || halted) return
            const event = object(input)
            if (!event) return
            if (event.type === 'message_start') {
              if (object(event.message)?.role === 'assistant') assistantId = `message-${++sequence}`
              return
            }
            if (event.type === 'message_update' || event.type === 'message_end') {
              const message = object(event.message)
              if (message?.role !== 'assistant') return
              if (!assistantId) assistantId = `message-${++sequence}`
              // SDK update.message is the complete current draft; no raw event,
              // signatures, images, system prompt or usage crosses this boundary.
              row(`${assistantId}-text`, 'assistant', textContent(message.content, 'text'))
              row(`${assistantId}-thinking`, 'thinking', textContent(message.content, 'thinking'))
              // Empty final fields are authoritative, not a request to keep drafts.
              if (event.type === 'message_end') assistantId = ''
              schedule()
              return
            }
            if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_update' && event.type !== 'tool_execution_end') return
            if (!identity(event.toolCallId) || !identity(event.toolName)) return
            let id = toolIds.get(event.toolCallId)
            if (!id) { id = `tool-${++sequence}`; toolIds.set(event.toolCallId, id) }
            const toolName = event.toolName
            const isEnd = event.type === 'tool_execution_end'
            // Args deliberately omitted: arbitrary object serialization would
            // expose structured payloads and defeat bounded reads.
            const result = object(isEnd ? event.result : event.partialResult)
            row(id, 'tool', textContent(result?.content, 'text'), { toolName, state: isEnd ? event.isError === true ? 'failed' : 'completed' : 'running' })
            schedule()
          })
        }
      } catch { return undefined }
    },
    halt() {
      if (halted) return
      // Publish uncertainty before fencing all late callbacks. Main may retain
      // these records after parent exit; shutdown is NOT child settlement.
      for (const child of live) child.cancel()
      halted = true
      reservation = undefined
      pending?.abort()
      for (const child of live) child.halt()
      live.clear()
      slots.clear()
    }
  }
}
