import {
  SUBAGENT_SESSION_MAX_CHARS,
  SUBAGENT_SESSION_MAX_ROWS,
  type SubagentSessionRow,
  type SubagentSessionSnapshot
} from '../../../shared/subagent-sessions'
import type { TimelineItem } from './types'

type AssistantItem = Extract<TimelineItem, { kind: 'assistant' }>
type ToolTimelineItem = Extract<TimelineItem, { kind: 'tool' }>
const statuses = new Set(['starting', 'running', 'cancelling', 'completed', 'failed', 'aborted'])
const identity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !value.includes('\0')

/** Only the observer's message-N-text/message-N-thinking and tool-N grammar
 * establishes identity. The shared sequence is a display key, NOT disk order
 * or an SDK entry ID. No body, timestamp or adjacency matching is performed. */
function rowIdentity(row: SubagentSessionRow): { key: string; number: number } | undefined {
  const match = /^(message|tool)-([1-9]\d{0,15})(?:-(text|thinking))?(?![\s\S])/.exec(row.id)
  if (!match) return
  const number = Number(match[2])
  if (!Number.isSafeInteger(number)) return
  if (match[1] === 'tool') {
    if (row.kind !== 'tool' || match[3] !== undefined) return
  } else if (match[3] !== (row.kind === 'assistant' ? 'text' : row.kind === 'thinking' ? 'thinking' : undefined)
    || match[3] === undefined) return
  return { key: `${match[1]}-${match[2]}`, number }
}

/** One instance per selected backend/child. Cache contains only the current
 * bounded display window; unchanged items retain references. Scope changes
 * clear all memoized content. Callers still own selection/revision/TTL fences. */
export class SubagentTimelineProjector {
  private scope = ''
  private cache = new Map<string, TimelineItem>()

  reset(): void {
    this.scope = ''
    this.cache.clear()
  }

  project(snapshot: SubagentSessionSnapshot | null | undefined): TimelineItem[] {
    if (!snapshot || !identity(snapshot.id) || !identity(snapshot.backendId) || !identity(snapshot.runtimeId)
      || !statuses.has(snapshot.status) || !Array.isArray(snapshot.rows)
      || snapshot.rows.length > SUBAGENT_SESSION_MAX_ROWS) {
      this.reset()
      return []
    }
    const scope = JSON.stringify([snapshot.backendId, snapshot.runtimeId, snapshot.id])
    if (scope !== this.scope) { this.reset(); this.scope = scope }
    const groups = new Map<string, { number: number; rows: SubagentSessionRow[] }>()
    const ids = new Set<string>()
    const numbers = new Map<number, string>()
    let chars = 0
    // Validate before projecting anything: duplicates/ambiguous IDs never
    // produce duplicate React keys or silently select one competing body.
    for (const row of snapshot.rows) {
      if (!row || !identity(row.id) || typeof row.text !== 'string' || row.text.length > 8192
        || (row.state !== undefined && !['running', 'completed', 'failed'].includes(row.state))
        || (row.toolName !== undefined && !identity(row.toolName))) return this.reject()
      const parsed = rowIdentity(row)
      if (!parsed || ids.has(row.id) || (numbers.has(parsed.number) && numbers.get(parsed.number) !== parsed.key)) return this.reject()
      ids.add(row.id)
      numbers.set(parsed.number, parsed.key)
      chars += row.id.length + row.text.length + (row.toolName?.length ?? 0)
      if (chars > SUBAGENT_SESSION_MAX_CHARS) return this.reject()
      const group = groups.get(parsed.key)
      if (group) group.rows.push(row)
      else groups.set(parsed.key, { number: parsed.number, rows: [row] })
    }
    const next = new Map<string, TimelineItem>()
    const lastKey = [...groups.keys()].at(-1)
    for (const [key, group] of groups) {
      const old = this.cache.get(key)
      const first = group.rows[0]
      let item: TimelineItem
      if (first.kind === 'tool') {
        if (!first.toolName || !first.state) return this.reject()
        const status = first.state === 'running' ? 'running' : first.state === 'failed' ? 'error' : 'done'
        const tool = { id: key, name: first.toolName, status, isError: status === 'error', outputText: first.text } satisfies ToolTimelineItem['tool']
        item = old?.kind === 'tool' && old.tool.name === tool.name && old.tool.status === tool.status
          && old.tool.outputText === tool.outputText ? old : { kind: 'tool', id: group.number, tool }
      } else {
        const text = group.rows.find((row) => row.kind === 'assistant')?.text ?? ''
        const thinking = group.rows.find((row) => row.kind === 'thinking')?.text ?? ''
        // Only an explicitly running message in a running child is live.
        // Legacy packets omit assistant state: fail closed rather than replay
        // their completed text as live animations.
        const streaming = snapshot.status === 'running' && key === lastKey
          && group.rows.every((row) => row.state === 'running')
        item = old?.kind === 'assistant' && old.text === text && old.thinking === thinking && old.streaming === streaming
          ? old : { kind: 'assistant', id: group.number, text, thinking, streaming,
            ...(streaming || (old?.kind === 'assistant' && old.live) ? { live: true } : {}) } satisfies AssistantItem
      }
      next.set(key, item)
    }
    this.cache = next
    return [...next.values()]
  }

  private reject(): TimelineItem[] {
    this.cache.clear()
    return []
  }
}

export function createSubagentTimelineProjector(): SubagentTimelineProjector {
  return new SubagentTimelineProjector()
}
