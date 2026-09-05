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
import { messageImages, messageText, messageThinking, messageToolCalls } from '../../../shared/types'
import {
  deriveSessionTaskRuns,
  isTaskToolName,
  normalizeSessionTasks
} from '../../../shared/task-history'
import type { SessionTaskHistoryEvent } from '../../../shared/task-history'
import type { AgentTaskRun, AgentTodo, FileChange, TimelineItem, ToolItem } from './types'

// ---------------------------------------------------------------------------
// Timeline id allocation (shared by live events and session replay)
// ---------------------------------------------------------------------------

let nextId = 1

export function nextTimelineId(): number {
  return nextId++
}

/**
 * Stable id for items derived from persisted session entries. Rebuilding a
 * history window (cache restore, revalidation, paging) must produce the same
 * ids so React keeps the mounted components instead of remounting them — a
 * remount would replay reveal animations and requeue waterfall slots.
 */
export function stableTimelineId(seed: string): number {
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i)
    h1 = ((h1 << 5) + h1) ^ c
    h2 = ((h2 << 5) + h2) ^ c
  }
  return (h1 >>> 0) * 2 ** 21 + (h2 >>> 0) % 2 ** 21
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
  if (isTaskToolName(tool.name)) {
    const todos = normalizeSessionTasks(details?.tasks)
    if (todos) next.todos = todos
  }
  // bash output lives in content text
  return next
}

/** Group todo snapshots by the user message that caused them. */
export function deriveAgentTaskRuns(timeline: TimelineItem[]): AgentTaskRun[] {
  const events: SessionTaskHistoryEvent[] = []
  for (const item of timeline) {
    if (item.kind === 'user') {
      events.push({
        kind: 'user',
        key: item.entryId ?? `timeline-${item.id}`,
        entryId: item.entryId,
        prompt: item.text,
        timestamp: item.timestamp
      })
    } else if (item.kind === 'tool' && item.tool.todos !== undefined) {
      events.push({ kind: 'snapshot', tasks: item.tool.todos })
    }
  }
  return deriveSessionTaskRuns(events)
}

/**
 * Tasks for the live panel. Keep every state from the current planned turn so
 * completed rows remain visible. A later user message does not erase that
 * finished plan by itself; the prior plan disappears only when the next turn
 * actually invokes the task tool (normally its required empty `clear` snapshot).
 */
export function deriveAgentTodos(timeline: TimelineItem[]): AgentTodo[] | null {
  let latestUserKey: string | null = null
  let latestUserIndex = -1
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]
    if (item.kind !== 'user') continue
    latestUserKey = item.entryId ?? `timeline-${item.id}`
    latestUserIndex = index
    break
  }
  if (!latestUserKey) return null

  const runs = deriveAgentTaskRuns(timeline)
  const currentRun = runs.find((candidate) => candidate.key === latestUserKey)
  if (currentRun) {
    const visible = currentRun.tasks.filter((todo) => todo.status !== 'deleted')
    return visible.length > 0 ? visible : null
  }

  const nextPlanStarted = timeline.slice(latestUserIndex + 1).some((item) => (
    item.kind === 'tool' && item.tool.todos !== undefined
  ))
  if (nextPlanStarted) return null

  const previousRun = runs.at(-1)
  if (!previousRun) return null
  const visible = previousRun.tasks.filter((todo) => todo.status !== 'deleted')
  return visible.length > 0 ? visible : null
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
        diff: existing?.kind === 'edit' && existing.diff
          ? `${existing.diff}\n  ...\n${tool.diff}`
          : tool.diff,
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

/** File changes made after the most recent user message in the loaded timeline. */
export function deriveLatestRunChanges(timeline: TimelineItem[]): FileChange[] {
  let start = 0
  for (let index = timeline.length - 1; index >= 0; index--) {
    if (timeline[index].kind !== 'user') continue
    start = index
    break
  }
  return deriveChanges(timeline.slice(start))
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

export function entriesToTimeline(
  entries: WireEntry[],
  toolResults: Map<string, HistoricalToolResult> = collectToolResults(entries),
  options: { reveal?: boolean } = {}
): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      if (typeof entry.summary === 'string') {
        items.push({ kind: 'compaction', id: stableTimelineId(`compaction:${entry.id}`), entryId: entry.id, summary: '上下文已压缩' })
      }
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (!message) continue

    if (message.role === 'user') {
      items.push({
        kind: 'user',
        id: stableTimelineId(`entry:${entry.id}`),
        entryId: entry.id,
        text: messageText(message),
        images: messageImages(message),
        timestamp: entry.timestamp
      })
      continue
    }

    if (message.role === 'assistant') {
      const text = messageText(message)
      const thinking = messageThinking(message)
      const calls = messageToolCalls(message)
      if (text !== '' || thinking !== '') {
        items.push({
          kind: 'assistant',
          id: stableTimelineId(`entry:${entry.id}`),
          entryId: entry.id,
          text,
          thinking,
          streaming: false
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
          id: stableTimelineId(`tool:${call.id}`),
          tool: result ? applyToolResult(tool, result.result, result.isError) : tool
        })
      }
      continue
    }
  }
  // Every history window is marked for character-level screen reveal. The
  // reveal utility arms only characters currently inside the viewport.
  if (options.reveal !== false) {
    for (const item of items) item.historical = true
  }
  return items
}

/** Stable identities let a live append be reconciled with a paged JSONL window. */
function timelineItemIdentity(item: TimelineItem): string | undefined {
  if (item.kind === 'tool') return `tool:${item.tool.id}`
  if (item.entryId) return `entry:${item.entryId}`
  return undefined
}

/** Filter incoming items that are already represented in a loaded timeline. */
export function uniqueTimelineItems(
  existing: TimelineItem[],
  incoming: TimelineItem[]
): TimelineItem[] {
  const known = new Set<string>()
  for (const item of existing) {
    const identity = timelineItemIdentity(item)
    if (identity) known.add(identity)
  }
  return incoming.filter((item) => {
    const identity = timelineItemIdentity(item)
    if (!identity) return true
    if (known.has(identity)) return false
    known.add(identity)
    return true
  })
}

// ---------------------------------------------------------------------------
// Paged-history timeline cache
// ---------------------------------------------------------------------------

/** Fallback page size used when the renderer has no viewport (SSR/tests). */
export const HISTORY_ENTRY_CHUNK_SIZE = 12
/** Fallback newest page size used for the first paint of a selected session. */
export const INITIAL_HISTORY_PAGE_SIZE = 12

/**
 * Keep the first history request close to one screen of transcript rows. A
 * small two-row cushion prevents an immediate blank edge while avoiding the
 * old fixed 56-entry transfer for long sessions.
 */
export function getViewportHistoryPageSize(): number {
  if (typeof window === 'undefined') return INITIAL_HISTORY_PAGE_SIZE
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 768
  return Math.min(24, Math.max(8, Math.ceil(viewportHeight / 96) + 2))
}
const MAX_TIMELINE_CACHE = 10

export interface TimelineCacheEntry {
  items: TimelineItem[]
  mode: AgentMode
  apiBefore: number
  apiAfter: number
  toolResults: WireEntry[]
  /** Whether all older entries have been loaded. */
  complete: boolean
  /** Whether all newer entries have been loaded (false after a landmark jump). */
  newerComplete: boolean
  leafId: string | null
  total: number
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
