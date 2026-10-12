import type { TimelineItem } from './types'

export type ToolTimelineItem = Extract<TimelineItem, { kind: 'tool' }>

export interface ToolActivityGroup {
  firstIndex: number
  lastIndex: number
  items: ToolTimelineItem[]
}

/** Only direct tool neighbours share a disclosure; even empty messages are boundaries. */
export function groupToolActivity(timeline: readonly TimelineItem[]): ToolActivityGroup[] {
  const groups: ToolActivityGroup[] = []
  let current: ToolActivityGroup | undefined
  timeline.forEach((item, index) => {
    if (item.kind !== 'tool') {
      current = undefined
      return
    }
    if (!current) {
      current = { firstIndex: index, lastIndex: index, items: [] }
      groups.push(current)
    }
    current.lastIndex = index
    current.items.push(item)
  })
  return groups
}

/** Tool-call attempts in this group, not successful changes or Git workspace totals. */
export function summarizeToolActivity(items: readonly ToolTimelineItem[]): {
  label: string
  total: number
  running: number
  errors: number
} {
  // Keep only header metadata. Never inspect command, args, output, diff or images.
  const calls = new Map<string, { name: string; path?: string; running: boolean; error: boolean }>()
  for (const { tool } of items) {
    const existing = calls.get(tool.id)
    const running = tool.status === 'running'
    const error = tool.status === 'error' || tool.isError
    if (existing) {
      // Conflicting duplicate projections must not erase unfinished/failed evidence.
      existing.running ||= running
      existing.error ||= error
    } else {
      calls.set(tool.id, { name: tool.name, path: tool.path, running, error })
    }
  }

  const readPaths = new Set<string>()
  const editPaths = new Set<string>()
  let unknownReads = 0
  let unknownEdits = 0
  let searches = 0
  let terminals = 0
  let others = 0
  let running = 0
  let errors = 0
  for (const call of calls.values()) {
    if (call.running) running++
    if (call.error) errors++
    switch (call.name) {
      case 'read':
        if (call.path) readPaths.add(call.path)
        else unknownReads++
        break
      case 'edit':
      case 'write':
        if (call.path) editPaths.add(call.path)
        else unknownEdits++
        break
      case 'grep':
      case 'find':
      case 'tool_search':
      case 'web_search':
        searches++
        break
      case 'bash':
      case 'powershell':
        terminals++
        break
      default:
        others++
    }
  }

  const labels: string[] = []
  if (readPaths.size) labels.push(`读取${readPaths.size}个文件`)
  if (unknownReads) labels.push(`读取${unknownReads}次（路径未知）`)
  if (editPaths.size) labels.push(`编辑${editPaths.size}个文件`)
  if (unknownEdits) labels.push(`编辑${unknownEdits}次（路径未知）`)
  if (searches) labels.push(`搜索${searches}次`)
  if (others) labels.push(`其他工具${others}次`)
  if (terminals) labels.push(`终端${terminals}次`)
  return { label: labels.join(' · '), total: calls.size, running, errors }
}
