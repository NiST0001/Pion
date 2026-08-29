/**
 * SDK 会话形状 -> 渲染进程 wire 类型的映射与判定。
 */
import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type { AgentMode, TreeNodeLite, WireEntry, WireMessage } from '../shared/types'
import { messageText, messageToolCalls } from '../shared/types'

/** Derive the current build/plan mode from plan-mode-state custom entries. */
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
