/**
 * 时间线解析与缓存。
 *
 * 负责：工具参数/结果解析（实时事件与会话回放共用）、wire entries ->
 * TimelineItem 转换、变更文件推导，以及分页历史的时间线缓存。
 */
import type {
  AgentMode,
  ToolResultPayload,
  WireEntry,
  WireMessage
} from '../../../shared/types'
import { messageText, messageThinking, messageToolCalls } from '../../../shared/types'
import type { FileChange, TimelineItem, ToolItem } from './types'

// ---------------------------------------------------------------------------
// Timeline id allocation (shared by live events and session replay)
// ---------------------------------------------------------------------------

let nextId = 1

export function nextTimelineId(): number {
  return nextId++
}

// ---------------------------------------------------------------------------
// Tool arg / result parsing (shared by live events and session replay)
// ---------------------------------------------------------------------------

export function parseToolArgs(name: string, args: unknown): Partial<ToolItem> {
  const a = (args ?? {}) as Record<string, unknown>
  const out: Partial<ToolItem> = {}
  if (typeof a.path === 'string') out.path = a.path
  if (typeof a.command === 'string') out.command = a.command
  if (typeof a.pattern === 'string') out.command = a.pattern
  if (name === 'write' && typeof a.content === 'string') out.writeContent = a.content
  if (name === 'edit' && Array.isArray(a.edits)) {
    // aggregate preview of the edit texts
    const edits = a.edits as Array<Record<string, unknown>>
    out.command = edits
      .map((e) => `${String(e.oldText ?? '')} → ${String(e.newText ?? '')}`)
      .join('\n')
      .slice(0, 200)
  }
  return out
}

export function resultText(payload: ToolResultPayload | undefined | null): string {
  const content = payload?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

export function applyToolResult(tool: ToolItem, result: unknown, isError: boolean): ToolItem {
  const payload = (result ?? {}) as ToolResultPayload
  const next: ToolItem = {
    ...tool,
    status: isError ? 'error' : 'done',
    isError,
    outputText: resultText(payload)
  }
  const details = payload.details
  if (typeof details?.diff === 'string') next.diff = details.diff
  // bash output lives in content text
  return next
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function errorText(event: WireMessage | undefined): string {
  if (!event) return '未知错误'
  return event.errorMessage || messageText(event) || '未知错误'
}

/** Count added/removed lines of a pi display diff. */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Derive the touched-file list from a timeline (for the changes panel). */
export function deriveChanges(timeline: TimelineItem[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const item of timeline) {
    if (item.kind !== 'tool') continue
    const { tool } = item
    if (tool.name === 'edit' && tool.path && tool.diff) {
      const stats = diffStats(tool.diff)
      const existing = byPath.get(tool.path)
      byPath.set(tool.path, {
        path: tool.path,
        kind: 'edit',
        diff: tool.diff,
        additions: (existing?.additions ?? 0) + stats.additions,
        deletions: (existing?.deletions ?? 0) + stats.deletions
      })
    } else if (tool.name === 'write' && tool.path) {
      const content = tool.writeContent ?? ''
      const lines = content.split('\n').length
      byPath.set(tool.path, {
        path: tool.path,
        kind: 'write',
        content,
        additions: lines,
        deletions: 0
      })
    }
  }
  return [...byPath.values()]
}

// ---------------------------------------------------------------------------
// Session replay: entries -> timeline
// ---------------------------------------------------------------------------

interface HistoricalToolResult {
  result: unknown
  isError: boolean
}

export function collectToolResults(entries: WireEntry[]): Map<string, HistoricalToolResult> {
  const results = new Map<string, HistoricalToolResult>()
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'toolResult') continue
    const record = entry.message as Record<string, unknown>
    if (typeof record.toolCallId !== 'string') continue
    results.set(record.toolCallId, {
      result: entry.message,
      isError: Boolean(record.isError)
    })
  }
  return results
}

function timelineItemCount(entry: WireEntry): number {
  if (entry.type === 'compaction') return typeof entry.summary === 'string' ? 1 : 0
  if (entry.type !== 'message' || !entry.message) return 0
  if (entry.message.role === 'user') return 1
  if (entry.message.role === 'assistant') return 1 + messageToolCalls(entry.message).length
  return 0
}

/** Find where the newest-window slice should start to render ~maxItems items. */
export function initialEntryStart(entries: WireEntry[], maxItems = INITIAL_HISTORY_ITEMS): number {
  let count = 0
  let start = entries.length
  while (start > 0 && count < maxItems) {
    start -= 1
    count += timelineItemCount(entries[start])
  }
  return start
}

export function entriesToTimeline(
  entries: WireEntry[],
  toolResults: Map<string, HistoricalToolResult> = collectToolResults(entries)
): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      if (typeof entry.summary === 'string') {
        items.push({ kind: 'compaction', id: nextTimelineId(), summary: '上下文已压缩', historical: true })
      }
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (!message) continue

    if (message.role === 'user') {
      items.push({ kind: 'user', id: nextTimelineId(), entryId: entry.id, text: messageText(message), historical: true })
      continue
    }

    if (message.role === 'assistant') {
      const text = messageText(message)
      const thinking = messageThinking(message)
      const calls = messageToolCalls(message)
      if (text !== '' || thinking !== '') {
        items.push({
          kind: 'assistant',
          id: nextTimelineId(),
          entryId: entry.id,
          text,
          thinking,
          streaming: false,
          historical: true
        })
      }
      for (const call of calls) {
        const tool: ToolItem = {
          id: call.id,
          name: call.name,
          status: 'done',
          isError: false,
          ...parseToolArgs(call.name, call.arguments)
        }
        const result = toolResults.get(call.id)
        items.push({
          kind: 'tool',
          id: nextTimelineId(),
          historical: true,
          tool: result ? applyToolResult(tool, result.result, result.isError) : tool
        })
      }
      continue
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Paged-history timeline cache
// ---------------------------------------------------------------------------

export const INITIAL_HISTORY_ITEMS = 30
export const HISTORY_ENTRY_CHUNK_SIZE = 80
export const INITIAL_HISTORY_PAGE_SIZE = 160
const MAX_TIMELINE_CACHE = 10

export interface TimelineCacheEntry {
  items: TimelineItem[]
  mode: AgentMode
  pendingEntries: WireEntry[]
  apiBefore: number
  toolResults: WireEntry[]
  complete: boolean
}

export interface HistoryCursor extends TimelineCacheEntry {
  path: string
  loading: boolean
  loadId: number
}

export function storeTimelineCache(
  cache: Map<string, TimelineCacheEntry>,
  path: string,
  entry: TimelineCacheEntry
): void {
  cache.delete(path)
  cache.set(path, entry)
  while (cache.size > MAX_TIMELINE_CACHE) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== 'string') break
    cache.delete(oldest)
  }
}
