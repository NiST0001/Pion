import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_ENTRIES = 100_000
const ENTRY_TYPES = new Set([
  'message', 'thinking_level_change', 'model_change', 'usage', 'compaction',
  'branch_summary', 'custom', 'label', 'session_info', 'custom_message', 'context_edit'
])
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const identity = (value: unknown): value is string => text(value) && value.length <= 256 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)
const timestamp = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value))
const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function usageTokens(value: unknown): number | undefined {
  if (!record(value)) return undefined
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (!tokens(value[key])) return undefined
  }
  for (const key of ['cacheWrite1h', 'reasoning']) {
    if (value[key] !== undefined && !tokens(value[key])) return undefined
  }
  if (!record(value.cost)) return undefined
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    const cost = value.cost[key]
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined
  }
  // Preserve the SDK's reported total; do not add reasoning/cacheWrite1h again
  // (pi-ai/types: these optional breakdowns are subsets, not extra tokens).
  return value.totalTokens as number
}

/**
 * Read-only total of reported usage in the ENTIRE persisted JSONL file, across
 * branches/compactions; not current context occupancy or remote billing truth.
 * Evidence: SDK core/session-manager appendMessage/appendUsage; cache-warmer
 * appends cache_warm usage; core/usage-totals includes assistant, usage,
 * toolResult, compaction and branch_summary. Pion subagents returns aggregate
 * tool-result usage (agent-loop persists it), NOT separate child usage entries.
 * Never recurse into child files, custom data, details, content or attachments.
 *
 * Only known v2/v3 tree identity is accepted. v1 needs fabricated migration IDs
 * and is deliberately unknown. Duplicate entry IDs must have identical records;
 * repeated provider responses/tool results require their explicit native IDs.
 * Independent usage has no original response ID in this SDK: distinct entry IDs
 * remain distinct, even with equal usage/timestamps; no heuristic deduplication.
 * Schema/identity checks are not authentication of a user-editable session file.
 * Caller must retain its SessionManager header cwd/selection checks and cache
 * scans (never invoke on every token). Any invalid/unstable/over-budget read is
 * unknown, not a partial total or a fabricated zero.
 */
export async function readSessionTokenTotal(path: string, expected?: { id: string; cwd: string }): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let result: number | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size === 0n || before.size > BigInt(MAX_FILE_BYTES)) return undefined
    const entries = new Map<string, string>()
    const events = new Map<string, string>()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let hasHeader = false
    let total = 0
    let lines = 0
    const consume = (line: Buffer): void => {
      if (line.length > MAX_LINE_BYTES) throw new Error('line budget')
      const value: unknown = JSON.parse(decoder.decode(line))
      if (!record(value)) throw new Error('record')
      if (!hasHeader) {
        if (value.type !== 'session' || (value.version !== 2 && value.version !== 3)
          || !identity(value.id) || !timestamp(value.timestamp) || !text(value.cwd)) throw new Error('header')
        if (expected && (value.id !== expected.id || resolve(value.cwd as string) !== resolve(expected.cwd))) throw new Error('changed owner')
        hasHeader = true
        return
      }
      if (++lines > MAX_ENTRIES || !text(value.type) || !ENTRY_TYPES.has(value.type)
        || !identity(value.id) || !timestamp(value.timestamp)
        || (value.parentId !== null && (!identity(value.parentId) || !entries.has(value.parentId)))) throw new Error('entry identity')
      const hash = digest(value)
      const old = entries.get(value.id)
      if (old !== undefined) {
        if (old !== hash) throw new Error('conflicting entry')
        return
      }
      let count = 0
      let eventId: string | undefined
      let eventHash: string | undefined
      if (value.type === 'message') {
        if (!record(value.message) || !text(value.message.role)) throw new Error('message')
        const message = value.message
        if (!['assistant', 'toolResult', 'user', 'system', 'bashExecution', 'custom', 'hookMessage'].includes(message.role as string)) throw new Error('unknown message')
        if (message.role !== 'bashExecution' && (!tokens(message.timestamp)
          || (typeof message.content !== 'string' && !Array.isArray(message.content)))) throw new Error('message shape')
        if (message.role === 'assistant' || message.role === 'toolResult') {
          if (!Array.isArray(message.content) || !tokens(message.timestamp)) throw new Error('message shape')
          if (message.role === 'assistant') {
            if (!text(message.provider) || !text(message.model) || !text(message.api)
              || !['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(message.stopReason as string)) throw new Error('assistant')
            if (message.responseId !== undefined) {
              if (!text(message.responseId)) throw new Error('response identity')
              eventId = JSON.stringify(['assistant', message.provider, message.api, message.responseId])
              eventHash = digest(message)
            }
          } else {
            if (!text(message.toolCallId) || !text(message.toolName) || typeof message.isError !== 'boolean') throw new Error('tool result')
            eventId = JSON.stringify(['toolResult', message.toolCallId])
            eventHash = digest(message)
          }
          if (message.role === 'assistant' || message.usage !== undefined) {
            const parsed = usageTokens(message.usage)
            if (parsed === undefined) throw new Error('message usage')
            count = parsed
          }
        } else if (message.usage !== undefined) throw new Error('unrecognized message usage')
      } else if (value.type === 'usage' || value.type === 'compaction' || value.type === 'branch_summary') {
        if (value.type === 'usage' && (!text(value.kind) || !text(value.provider) || !text(value.model))) throw new Error('usage attribution')
        if (value.type === 'compaction' && (typeof value.summary !== 'string' || !identity(value.firstKeptEntryId) || !tokens(value.tokensBefore))) throw new Error('compaction shape')
        if (value.type === 'branch_summary' && (typeof value.summary !== 'string' || !identity(value.fromId))) throw new Error('summary shape')
        if (value.type === 'usage' || value.usage !== undefined) {
          const parsed = usageTokens(value.usage)
          if (parsed === undefined) throw new Error('entry usage')
          count = parsed
        }
      } else {
        if (value.usage !== undefined) throw new Error('unknown usage source')
        switch (value.type) {
          case 'thinking_level_change':
            if (!text(value.thinkingLevel)) throw new Error('thinking level')
            break
          case 'model_change':
            if (!text(value.provider) || !text(value.modelId)) throw new Error('model')
            break
          case 'custom':
          case 'custom_message':
            if (!text(value.customType)) throw new Error('custom type')
            if (value.type === 'custom_message' && (typeof value.display !== 'boolean'
              || (typeof value.content !== 'string' && !Array.isArray(value.content)))) throw new Error('custom message')
            break
          case 'label':
            if (!identity(value.targetId) || (value.label !== undefined && typeof value.label !== 'string')) throw new Error('label')
            break
          case 'session_info':
            if (value.name !== undefined && typeof value.name !== 'string') throw new Error('session info')
            break
          case 'context_edit':
            if (!identity(value.targetId) || (value.replacement !== null && (!record(value.replacement)
              || (typeof value.replacement.content !== 'string' && !Array.isArray(value.replacement.content))))) throw new Error('context edit')
            break
        }
      }
      if (eventId && eventHash) {
        const previous = events.get(eventId)
        if (previous !== undefined) {
          if (previous !== eventHash) throw new Error('conflicting original event')
          count = 0
        } else events.set(eventId, eventHash)
      }
      entries.set(value.id, hash)
      total += count
      if (!Number.isSafeInteger(total)) throw new Error('total overflow')
    }
    const chunk = Buffer.alloc(64 * 1024)
    let pending = Buffer.alloc(0)
    let bytes = 0
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > MAX_FILE_BYTES || BigInt(bytes) > before.size) throw new Error('file growth')
      const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      let start = 0
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        consume(data.subarray(start, end))
        start = end + 1
      }
      pending = Buffer.from(data.subarray(start))
      if (pending.length > MAX_LINE_BYTES) throw new Error('line budget')
    }
    // An incomplete final line may be an in-flight append, never a partial total.
    if (pending.length !== 0 || !hasHeader || BigInt(bytes) !== before.size) throw new Error('incomplete file')
    const after = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    for (const snapshot of [after, current]) {
      if (!snapshot.isFile() || snapshot.dev !== before.dev || snapshot.ino !== before.ino
        || snapshot.size !== before.size || snapshot.mtimeNs !== before.mtimeNs || snapshot.ctimeNs !== before.ctimeNs) throw new Error('changed file')
    }
    result = total
  } catch {
    result = undefined
  } finally {
    if (handle) {
      try { await handle.close() } catch { result = undefined }
    }
  }
  return result
}
