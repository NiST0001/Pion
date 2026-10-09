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
import { messageImages, messageText, messageThinking, messageToolCalls, messageTimestamp } from '../../../shared/types'
import { collectToolImages } from '../../../shared/tool-images'
import {
  CODEX_IMAGE_REQUEST_ALIAS,
  generatedImageModelInfo,
  generatedImageSettingsInfo,
  IMAGE_GENERATION_TOOL_NAME,
  validateImageReferencePaths
} from '../../../shared/image-generation'
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
  if (name === IMAGE_GENERATION_TOOL_NAME) {
    out.imageModelInfo = generatedImageModelInfo({
      version: 2, provider: 'openai-codex',
      requestedModel: a.model === undefined ? CODEX_IMAGE_REQUEST_ALIAS : a.model
    })
    let referenceCount: number | undefined
    if (a.referenced_image_paths !== undefined) {
      try {
        referenceCount = validateImageReferencePaths(a.referenced_image_paths).length
      } catch { /* Invalid paths establish neither a count nor an operation. */ }
    }
    // Preview only explicitly supplied settings. Never infer saved dimensions
    // from args or retain reference paths/bytes in the renderer projection.
    const settings = generatedImageSettingsInfo({
      version: 2, provider: 'openai-codex', requestedSize: a.size,
      requestedQuality: a.quality, referenceCount,
      operation: referenceCount === undefined ? undefined : referenceCount > 0 ? 'edit' : 'generate'
    })
    if (settings) out.imageSettingsInfo = settings
  }
  if (typeof a.path === 'string') out.path = a.path
  if (typeof a.command === 'string') out.command = a.command
  if (typeof a.pattern === 'string') out.command = a.pattern
  // Native schemas use code/query, not the shell command field. Do not
  // stringify arbitrary MCP args: they may contain image bytes or metadata.
  if (name === 'codemode' && typeof a.code === 'string') out.command = a.code.slice(0, 200)
  if (name === 'tool_search' && typeof a.query === 'string') out.command = a.query.slice(0, 200)
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

/** Preview identity is independent of final text, status, diff, model and settings.
 * Rejected/over-limit images conservatively re-project; retain no raw payload. */
function toolResultPreviewsMatch(tool: ToolItem, content: unknown): boolean {
  if (!tool.images || tool.imageNotice) return false
  const parts = Array.isArray(content) ? content : []
  if (parts.length > 128) return false
  let imageIndex = 0
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]
    if (!part || typeof part !== 'object' || part.type !== 'image') continue
    const image = tool.images[imageIndex++]
    if (!image || partIndex !== image.partIndex || part.data !== image.data
      || part.mimeType !== image.mimeType) return false
  }
  return imageIndex === tool.images.length
}

/** Compare final projections, including removed fields and settings-only changes. */
export function toolResultMatches(tool: ToolItem, result: unknown, isError: boolean): boolean {
  if (!tool.resultReceived || tool.status !== (isError ? 'error' : 'done')
    || tool.isError !== isError || isTaskToolName(tool.name)) return false
  const payload = (result ?? {}) as ToolResultPayload
  if (tool.outputText !== resultText(payload)) return false
  const diff = typeof payload.details?.diff === 'string' ? payload.details.diff : undefined
  if (diff !== tool.diff) return false
  const generated = payload.details?.imageGeneration
  if (tool.name === IMAGE_GENERATION_TOOL_NAME) {
    if (generated && typeof generated === 'object'
      && typeof (generated as { path?: unknown }).path === 'string'
      && (generated as { path: string }).path !== tool.path) return false
    const modelInfo = generatedImageModelInfo(generated)
    if (modelInfo?.requestedModel !== tool.imageModelInfo?.requestedModel
      || modelInfo?.requestLabel !== tool.imageModelInfo?.requestLabel
      || modelInfo?.experimental !== tool.imageModelInfo?.experimental
      || modelInfo?.resolvedModel !== tool.imageModelInfo?.resolvedModel) return false
    const settings = generatedImageSettingsInfo(generated)
    if (settings?.operation !== tool.imageSettingsInfo?.operation
      || settings?.requestedSize !== tool.imageSettingsInfo?.requestedSize
      || settings?.requestedQuality !== tool.imageSettingsInfo?.requestedQuality
      || settings?.referenceCount !== tool.imageSettingsInfo?.referenceCount
      || settings?.savedWidth !== tool.imageSettingsInfo?.savedWidth
      || settings?.savedHeight !== tool.imageSettingsInfo?.savedHeight
      || settings?.savedByteLength !== tool.imageSettingsInfo?.savedByteLength) return false
  }
  return toolResultPreviewsMatch(tool, payload.content)
}

export function applyToolResult(
  tool: ToolItem, result: unknown, isError: boolean,
  resultSource: NonNullable<ToolItem['resultSource']> = 'execution',
  previewsFrom: ToolItem = tool
): ToolItem {
  const payload = (result ?? {}) as ToolResultPayload
  const { images, notice } = toolResultPreviewsMatch(previewsFrom, payload.content)
    ? { images: previewsFrom.images ?? [], notice: previewsFrom.imageNotice }
    : collectToolImages(payload.content)
  const next: ToolItem = {
    ...tool,
    status: isError ? 'error' : 'done',
    isError,
    outputText: resultText(payload),
    // Result-owned fields are replacements, not patches over execution output.
    diff: typeof payload.details?.diff === 'string' ? payload.details.diff : undefined,
    images,
    imageNotice: notice,
    resultReceived: true,
    resultSource
  }
  const details = payload.details
  const generated = details?.imageGeneration
  if (tool.name === IMAGE_GENERATION_TOOL_NAME) {
    // Result-owned metadata replaces any argument preview. Path-only/invalid
    // records remain displayable, but cannot establish a requested model.
    next.imageModelInfo = generatedImageModelInfo(generated)
    next.imageSettingsInfo = generatedImageSettingsInfo(generated)
  }
  if (tool.name === IMAGE_GENERATION_TOOL_NAME && generated && typeof generated === 'object'
    && typeof (generated as { path?: unknown }).path === 'string') {
    // Display only the non-secret project-relative path; never read it here.
    next.path = (generated as { path: string }).path
  }
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
 * Legacy timeline-only projection; the live panel must use AgentState.tasks
 * because a history window can omit its user or task records.
 * Keep every state from the current planned turn so
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

const MISSING_ASSISTANT_ERROR_DETAIL = '模型请求失败，但提供商未返回技术详情。'

export function assistantErrorText(message: WireMessage | undefined | null): string | undefined {
  const stopReason = message?.stopReason
  if (stopReason === 'aborted') return undefined
  // A successful or length/tool boundary is not an error even if a provider
  // leaves stale diagnostic text on the message object.
  if (stopReason !== undefined && stopReason !== 'error') return undefined

  const error = message?.errorMessage
  if (typeof error !== 'string' || error.trim() === '') {
    return stopReason === 'error' ? MISSING_ASSISTANT_ERROR_DETAIL : undefined
  }
  const normalized = error.trim()
  // Older SDK events can omit stopReason for the built-in abort text. When a
  // provider explicitly reports stopReason=error, preserve the same words as a
  // real diagnostic instead of assuming user cancellation.
  if (stopReason === undefined && /^request (?:was )?aborted[.!]?$/i.test(normalized)) {
    return undefined
  }
  return error
}

export function wireMessageTimestamp(message: WireMessage | undefined | null): number | undefined {
  return messageTimestamp(message)
}

export function compactionFingerprint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, summary, firstKeptEntryId, tokensBefore } = value as Record<string, unknown>
  if (typeof summary !== 'string' || typeof tokensBefore !== 'number' || !Number.isFinite(tokensBefore)
    || (firstKeptEntryId !== undefined && firstKeptEntryId !== null && typeof firstKeptEntryId !== 'string')) {
    return undefined
  }
  // SDK retain-none results omit the kept boundary; the saved entry replaces
  // that omission with its own entry ID. Both describe the same compaction.
  const keptBoundary = firstKeptEntryId === id ? null : firstKeptEntryId ?? null
  return JSON.stringify([summary, keptBoundary, tokensBefore])
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
  options: { reveal?: boolean; existingTimeline?: TimelineItem[] } = {}
): TimelineItem[] {
  const items: TimelineItem[] = []
  const existingTools = new Map<string, ToolItem>()
  for (const item of options.existingTimeline ?? []) {
    if (item.kind === 'tool') existingTools.set(item.tool.id, item.tool)
  }
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      if (typeof entry.summary === 'string') {
        items.push({
          kind: 'compaction',
          id: stableTimelineId(`compaction:${entry.id}`),
          entryId: entry.id,
          compactionFingerprint: compactionFingerprint(entry),
          summary: '上下文已压缩'
        })
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
        messageTimestamp: wireMessageTimestamp(message),
        text: messageText(message),
        images: messageImages(message),
        timestamp: entry.timestamp
      })
      continue
    }

    if (message.role === 'assistant') {
      const text = messageText(message)
      const thinking = messageThinking(message)
      const error = assistantErrorText(message)
      const calls = messageToolCalls(message)
      if (text !== '' || thinking !== '' || error) {
        items.push({
          kind: 'assistant',
          id: stableTimelineId(`entry:${entry.id}`),
          entryId: entry.id,
          messageTimestamp: wireMessageTimestamp(message),
          text,
          thinking,
          streaming: false,
          ...(error ? { error } : {})
        })
      }
      for (const call of calls) {
        // Nested executions are not independent transcript tool calls. A
        // defensive projection must not turn an event-like persisted part
        // into an orphan root or replay it beside its codemode parent.
        if (typeof (call as unknown as Record<string, unknown>).parentToolCallId === 'string') continue
        const tool: ToolItem = {
          id: call.id,
          name: call.name,
          status: 'done',
          isError: false,
          ...parseToolArgs(call.name, call.arguments)
        }
        const result = toolResults.get(call.id)
        const existing = existingTools.get(call.id)
        // Exact same-scope finals can reuse validated previews. Rejected parts
        // still conservatively re-project; no raw image payload is retained.
        const final = result ? applyToolResult(tool, result.result, result.isError, 'history', existing) : tool
        items.push({ kind: 'tool', id: stableTimelineId(`tool:${call.id}`), tool: final })
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

/** Stable persisted identities reconcile overlapping paged JSONL windows. */
function timelineItemIdentity(item: TimelineItem): string | undefined {
  if (item.kind === 'tool') return `tool:${item.tool.id}`
  if (item.entryId) return `entry:${item.entryId}`
  return undefined
}

function timelineMessageIdentity(item: TimelineItem): string | undefined {
  if (item.kind === 'user' && item.messageTimestamp !== undefined) {
    return JSON.stringify(['user', item.messageTimestamp, item.text, item.images ?? []])
  }
  if (item.kind === 'assistant' && item.messageTimestamp !== undefined) {
    return JSON.stringify(['assistant', item.messageTimestamp, item.text, item.thinking, item.error ?? ''])
  }
  if (item.kind === 'compaction' && item.compactionFingerprint !== undefined) {
    return `compaction:${item.compactionFingerprint}`
  }
  return undefined
}

function isUnreconciledLiveItem(item: TimelineItem): boolean {
  if (item.historyReconciled) return false
  return item.kind === 'tool' ? item.tool.live === true : item.live === true
}

function reconcileLiveRow(live: TimelineItem, persisted: TimelineItem): TimelineItem {
  // Keep the React key, local disclosure state, and authoritative live output.
  // Persistence may arrive before the final live event; only fill a still-
  // running tool from a real final payload, never rewind a completed live row.
  if (live.kind === 'tool' && persisted.kind === 'tool') {
    const tool = (live.tool.status === 'running' || !live.tool.resultReceived) && persisted.tool.resultReceived
      ? { ...live.tool, ...persisted.tool, id: live.tool.id, live: live.tool.live, resultSource: 'history' as const }
      : live.tool
    return { ...live, tool, historyReconciled: true }
  }
  if (live.kind === 'user' && persisted.kind === 'user') {
    return { ...live, entryId: persisted.entryId ?? live.entryId, timestamp: persisted.timestamp,
      ...(persisted.liveMessageId && !live.liveMessageId ? { liveMessageId: persisted.liveMessageId } : {}),
      ...(persisted.images?.length && !live.images?.length ? { images: persisted.images } : {}),
      historyReconciled: true }
  }
  if (live.kind === 'assistant' && persisted.kind === 'assistant') {
    const next = { ...live, entryId: persisted.entryId, historyReconciled: true }
    if (!persisted.streaming) {
      // Persistence can be observed just before the corresponding message_end
      // IPC event; the stored assistant is already a complete final snapshot.
      next.text = persisted.text
      next.thinking = persisted.thinking
      next.streaming = false
      if (persisted.error) next.error = persisted.error
      else delete next.error
    }
    return next
  }
  if (live.kind === 'compaction' && persisted.kind === 'compaction') {
    return { ...live, entryId: persisted.entryId, historyReconciled: true }
  }
  return { ...live, historyReconciled: true }
}

/** Replace persisted history without replacing the backend's unpersisted tail.
 * Off-window persisted rows are dropped. Matching tools retain their mounted
 * identity/finals; live rows absent from JSONL remain until an authoritative
 * final event or a persisted copy reconciles them. */
export function preserveTimelineToolState(
  existing: TimelineItem[], incoming: TimelineItem[], preserveLive = true
): TimelineItem[] {
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>()
  for (const item of existing) if (item.kind === 'tool') tools.set(item.tool.id, item)
  // Reconciled messages still own mounted keys on later same-scope reads.
  // Only project rows present in this window; never append off-window history.
  const mountedMessages = existing.filter((item) => (item.kind === 'user' || item.kind === 'assistant') && item.entryId)
  const projected = incoming.map((item) => {
    const current = item.kind === 'tool' ? tools.get(item.tool.id) : undefined
    if (current) return reconcileLiveRow(current, item)
    if ((item.kind !== 'user' && item.kind !== 'assistant') || !item.entryId) return item
    const matches = mountedMessages.filter((row) => (row.kind === 'user' || row.kind === 'assistant')
      && row.kind === item.kind && row.entryId === item.entryId
      && !(row.liveMessageId && item.liveMessageId && row.liveMessageId !== item.liveMessageId))
    if (matches.length !== 1 || incoming.filter((row) => row.kind === item.kind && row.entryId === item.entryId).length !== 1) return item
    const mounted = matches[0]
    if (mounted.kind !== 'user' && mounted.kind !== 'assistant') return item
    return { ...item, id: mounted.id, live: mounted.live,
      historical: mounted.historical, noReveal: mounted.noReveal,
      historyReconciled: mounted.historyReconciled,
      ...(mounted.liveMessageId ? { liveMessageId: mounted.liveMessageId } : {}) }
  })
  if (!preserveLive) return projected
  // A jumped window can already pin a streaming row. Do not append its older
  // hook snapshot beside the reducer's event-ordered version of the same row.
  const live = existing.filter((item) => isUnreconciledLiveItem(item)
    || (item.kind === 'assistant' && item.streaming)
    // A call-only history page locates a tool, but does not finish execution.
    // Keep that live call even when a later page no longer includes its row.
    || (item.kind === 'tool' && item.tool.live && item.tool.status === 'running'))
  const liveById = new Map(live.map((item) => [item.id, item]))
  const pinnedIds = new Set(projected.filter((item) => item.kind === 'assistant'
    && item.streaming && item.live && liveById.has(item.id)).map((item) => item.id))
  const items = projected.map((item) => pinnedIds.has(item.id) ? liveById.get(item.id)! : item)
  return reconcileNewerTimelineItems(live.filter((item) => !pinnedIds.has(item.id)), items).items
}

/** Final-only pages update mounted calls, never create isolated result rows. */
export function completeTimelineToolResults(
  items: TimelineItem[], toolResults: Map<string, HistoricalToolResult>
): TimelineItem[] {
  if (toolResults.size === 0) return items
  let changed = false
  const completed = items.map((item) => {
    if (item.kind !== 'tool' || (item.tool.status !== 'running' && item.tool.resultReceived)) return item
    const result = toolResults.get(item.tool.id)
    if (!result) return item
    changed = true
    // A result alone does not identify this call's persisted page position.
    // Leave historyReconciled untouched so a later call page can place it.
    return { ...item, tool: applyToolResult(item.tool, result.result, result.isError, 'history') }
  })
  return changed ? completed : items
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

/** Prepend unique rows while finishing overlapping tools in the retained prefix. */
export function reconcileOlderTimelineItems(
  existing: TimelineItem[], incoming: TimelineItem[],
  toolResults: Map<string, HistoricalToolResult> = new Map()
): { items: TimelineItem[]; prepended: TimelineItem[] } {
  const incomingTools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>()
  for (const item of incoming) if (item.kind === 'tool') incomingTools.set(item.tool.id, item)
  let changed = false
  const retained = existing.map((item) => {
    const persisted = item.kind === 'tool' ? incomingTools.get(item.tool.id) : undefined
    if (item.kind !== 'tool' || !persisted?.tool.resultReceived
      || (item.tool.status !== 'running' && item.tool.resultReceived)) return item
    changed = true
    return reconcileLiveRow(item, persisted)
  })
  const completed = completeTimelineToolResults(changed ? retained : existing, toolResults)
  const prepended = uniqueTimelineItems(completed, incoming)
  return { items: prepended.length > 0 ? [...prepended, ...completed] : completed, prepended }
}

export interface ReconciledNewerTimeline {
  items: TimelineItem[]
  /** New/matched rows in the persisted page's order; excludes overlap copies. */
  appended: TimelineItem[]
}

/**
 * Place realtime rows at their persisted page positions without remounting
 * them. Unmatched realtime rows remain after the page in their original order.
 * A row already covered by an earlier page stays in the loaded prefix.
 */
export function reconcileNewerTimelineItems(
  existing: TimelineItem[],
  incoming: TimelineItem[],
  toolResults: Map<string, HistoricalToolResult> = new Map()
): ReconciledNewerTimeline {
  if (incoming.length === 0) {
    return { items: completeTimelineToolResults(existing, toolResults), appended: [] }
  }
  const known = new Set<string>()
  const pinnedLiveIds = new Set<number>()
  const liveByIdentity = new Map<string, TimelineItem>()
  const existingTools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>()
  const completedTools = new Map<number, TimelineItem>()
  const liveByMessage = new Map<string, TimelineItem[]>()
  const liveByStableId = new Map<string, TimelineItem[]>()
  const streamingByTimestamp = new Map<number, TimelineItem[]>()
  const incomingTimestampCounts = new Map<number, number>()
  for (const item of incoming) {
    if (item.kind === 'assistant' && item.messageTimestamp !== undefined) {
      incomingTimestampCounts.set(item.messageTimestamp, (incomingTimestampCounts.get(item.messageTimestamp) ?? 0) + 1)
    }
  }
  for (const item of existing) {
    const identity = timelineItemIdentity(item)
    if (item.kind === 'tool' && identity) existingTools.set(identity, item)
    if (!isUnreconciledLiveItem(item)) {
      if (identity) known.add(identity)
      continue
    }
    pinnedLiveIds.add(item.id)
    if ((item.kind === 'user' || item.kind === 'assistant') && item.liveMessageId) {
      const rows = liveByStableId.get(item.liveMessageId) ?? []
      rows.push(item)
      liveByStableId.set(item.liveMessageId, rows)
    }
    if (identity) liveByIdentity.set(identity, item)
    if (item.kind === 'assistant' && item.streaming) {
      if (!identity && item.messageTimestamp !== undefined) {
        const rows = streamingByTimestamp.get(item.messageTimestamp) ?? []
        rows.push(item)
        streamingByTimestamp.set(item.messageTimestamp, rows)
      }
      continue
    }
    // Known persisted identities must not collide with a distinct entry that
    // happens to contain the same timestamp/text (e.g. imported history).
    if (identity) continue
    const messageIdentity = timelineMessageIdentity(item)
    if (!messageIdentity) continue
    const rows = liveByMessage.get(messageIdentity) ?? []
    rows.push(item)
    liveByMessage.set(messageIdentity, rows)
  }

  const matchedIds = new Set<number>()
  const appended: TimelineItem[] = []
  for (const item of incoming) {
    const identity = timelineItemIdentity(item)
    if (identity && known.has(identity)) {
      // A call-only page can have placed the row before its result was saved.
      // A later overlapping page may finish that row, but cannot replace its
      // mounted key or move the already-reconciled prefix to the page tail.
      const existingTool = existingTools.get(identity)
      if (item.kind === 'tool' && item.tool.resultReceived
        && existingTool && (existingTool.tool.status === 'running' || !existingTool.tool.resultReceived)
        && !completedTools.has(existingTool.id)) {
        completedTools.set(existingTool.id, reconcileLiveRow(existingTool, item))
      }
      continue
    }
    const messageIdentity = timelineMessageIdentity(item)
    const matchingRows = item.kind === 'user' && item.messageTimestamp !== undefined
      ? existing.filter((row) => row.kind === 'user' && isUnreconciledLiveItem(row) && !row.entryId
        && row.messageTimestamp === item.messageTimestamp && row.text === item.text
        && ((row.liveMessageId && !row.images?.length)
          || JSON.stringify(row.images ?? []) === JSON.stringify(item.images ?? [])))
      : messageIdentity ? liveByMessage.get(messageIdentity) : undefined
    const streamingRows = item.kind === 'assistant' && item.messageTimestamp !== undefined
      && incomingTimestampCounts.get(item.messageTimestamp) === 1
      ? streamingByTimestamp.get(item.messageTimestamp)
      : undefined
    // Timestamp-only matching is limited to an unambiguous in-flight row; final
    // messages still require their exact identity or timestamp/content tuple.
    const compatible = (row: TimelineItem): boolean => {
      if (matchedIds.has(row.id) || row.kind !== item.kind) return false
      if ('entryId' in row && 'entryId' in item && row.entryId && item.entryId && row.entryId !== item.entryId) return false
      if ((row.kind === 'user' || row.kind === 'assistant') && (item.kind === 'user' || item.kind === 'assistant')
        && row.liveMessageId && item.liveMessageId && row.liveMessageId !== item.liveMessageId) return false
      return true
    }
    const stableRows = (item.kind === 'user' || item.kind === 'assistant') && item.liveMessageId
      ? liveByStableId.get(item.liveMessageId)?.filter(compatible) : undefined
    const stableMatch = stableRows?.length === 1 ? stableRows[0] : undefined
    const streamingMatch = streamingRows?.length === 1 && compatible(streamingRows[0]) ? streamingRows[0] : undefined
    const compatibleRows = matchingRows?.filter(compatible)
    const messageMatch = item.kind === 'user'
      ? (compatibleRows?.length === 1
        && incoming.filter((row) => row.kind === 'user' && row.messageTimestamp === item.messageTimestamp
          && row.text === item.text).length === 1
        ? compatibleRows[0] : undefined)
      : compatibleRows?.[0]
    const identityMatch = identity ? liveByIdentity.get(identity) : undefined
    const live = (identityMatch && compatible(identityMatch) ? identityMatch : undefined)
      ?? stableMatch ?? messageMatch ?? streamingMatch
    if (live && !matchedIds.has(live.id)) {
      matchedIds.add(live.id)
      appended.push(reconcileLiveRow(live, item))
    } else {
      appended.push(item)
    }
    if (identity) known.add(identity)
  }

  const retained = existing.filter((item) => !pinnedLiveIds.has(item.id))
    .map((item) => completedTools.get(item.id) ?? item)
  const tailItems = existing.filter((item) => pinnedLiveIds.has(item.id) && !matchedIds.has(item.id))
  return { items: completeTimelineToolResults([...retained, ...appended, ...tailItems], toolResults), appended }
}

/**
 * A page with colliding timestamps cannot identify a still-streaming message.
 * Once message_end provides its final content, reconcile its exact history
 * copy at the persisted position, keeping the live row's mounted component.
 */
export function reconcileCompletedAssistantRows(items: TimelineItem[]): TimelineItem[] {
  const liveByMessage = new Map<string, Array<Extract<TimelineItem, { kind: 'assistant' }>>>()
  for (const item of items) {
    if (item.kind !== 'assistant' || !item.live || item.streaming || item.historyReconciled) continue
    const identity = timelineMessageIdentity(item)
    if (!identity) continue
    const rows = liveByMessage.get(identity) ?? []
    rows.push(item)
    liveByMessage.set(identity, rows)
  }

  const matchedIds = new Set<number>()
  const placements = new Map<number, TimelineItem>()
  for (const persisted of items) {
    if (persisted.kind !== 'assistant' || persisted.live || !persisted.entryId) continue
    const identity = timelineMessageIdentity(persisted)
    const rows = identity ? liveByMessage.get(identity) : undefined
    const live = rows?.find((row) => !matchedIds.has(row.id)
      && (row.entryId === undefined || row.entryId === persisted.entryId))
    if (!live) continue
    matchedIds.add(live.id)
    placements.set(persisted.id, reconcileLiveRow(live, persisted))
  }
  if (matchedIds.size === 0) return items
  return items.filter((item) => !matchedIds.has(item.id)).map((item) => placements.get(item.id) ?? item)
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
  liveSessionBackendId?: string
  /** Project/worktree owning this snapshot; never revive live rows across cwd. */
  cwd?: string
  /** Full session task projection, not derived from these cached rows. */
  tasks?: AgentTodo[] | null
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
  const previous = cache.get(path)
  const tasks = entry.tasks === undefined ? previous?.tasks : entry.tasks
  cache.delete(path)
  cache.set(path, { ...entry, cwd: entry.cwd ?? previous?.cwd,
    liveSessionBackendId: entry.liveSessionBackendId ?? previous?.liveSessionBackendId, tasks })
  while (cache.size > MAX_TIMELINE_CACHE) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== 'string') break
    cache.delete(oldest)
  }
}
