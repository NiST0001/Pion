/**
 * SDK 会话形状 -> 渲染进程 wire 类型的映射与判定。
 */
import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type { AgentMode, SessionTask, TreeNodeLite, WireEntry, WireMessage } from '../../shared/types'
import { taskSnapshotFromResult } from '../../shared/task-history'
import { messageText, messageToolCalls } from '../../shared/types'

/** Derive the current build/plan mode from Pion plan-mode-state custom entries. */
export function sessionMode(entries: SessionEntry[]): AgentMode {
  let mode: AgentMode = 'build'
  for (const entry of entries) {
    if (entry.type !== 'custom') continue
    const record = entry as unknown as Record<string, unknown>
    if (record.customType !== 'plan-mode-state') continue
    const data = record.data
    const enabled = data && typeof data === 'object'
      ? (data as Record<string, unknown>).enabled
      : undefined
    if (typeof enabled === 'boolean') mode = enabled ? 'plan' : 'build'
  }
  return mode
}

/** Physical JSONL order contains abandoned branches; UI paging follows only ancestry. */
export function sessionBranch(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: SessionEntry[] = []
  const visited = new Set<string>()
  let id = leafId
  while (id !== null) {
    const entry = byId.get(id)
    if (!entry || visited.has(id)) throw new Error('会话分支不完整，无法读取历史')
    visited.add(id)
    branch.push(entry)
    id = entry.parentId
  }
  return branch.reverse()
}

/** Latest valid full task snapshot on the selected branch, not the visible page.
 * Follow parent ids so an abandoned branch cannot resurrect its task list.
 */
export function sessionTasks(entries: SessionEntry[], leafId: string | null): SessionTask[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const visited = new Set<string>()
  let id = leafId
  while (id && !visited.has(id)) {
    visited.add(id)
    const entry = byId.get(id)
    if (!entry) break
    if (entry.type === 'message') {
      const message = entry.message as unknown as WireMessage
      if (message.role === 'toolResult') {
        const tasks = taskSnapshotFromResult(message.toolName, message)
        if (tasks !== undefined) return tasks // [] is an explicit clear, not missing data.
      }
    }
    id = entry.parentId
  }
  return []
}

function isToolResult(entry: SessionEntry): boolean {
  const record = entry as unknown as { type?: string; message?: WireMessage }
  return record.type === 'message' && record.message?.role === 'toolResult'
}

function toolResultId(entry: SessionEntry): string | undefined {
  if (!isToolResult(entry)) return undefined
  const record = entry as unknown as { message?: Record<string, unknown> }
  return typeof record.message?.toolCallId === 'string' ? record.message.toolCallId : undefined
}

/** Collect tool-call ids issued by the assistant entries in a window. */
export function toolCallIds(entries: SessionEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    for (const call of messageToolCalls(entry.message as unknown as WireMessage)) {
      if (typeof call.id === 'string') ids.add(call.id)
    }
  }
  return ids
}

/** Tool-result entries (possibly outside the window) whose call id is in ids. */
export function filterToolResults(entries: SessionEntry[], ids: Set<string>): SessionEntry[] {
  return entries.filter((entry) => {
    const id = toolResultId(entry)
    return id !== undefined && ids.has(id)
  })
}

export function toWireEntry(entry: SessionEntry): WireEntry {
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
  } else if (entry.type === 'custom') {
    if (typeof record.customType === 'string') wire.customType = record.customType
    wire.data = record.data
  }
  return wire
}

export function toTreeNodeLite(node: SessionTreeNode): TreeNodeLite {
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
