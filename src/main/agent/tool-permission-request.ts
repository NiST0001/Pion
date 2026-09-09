import { resolve } from 'node:path'
import type { ToolPermissionCategory, ToolPermissionRequest } from '../../shared/types'
import { TOOL_PERMISSION_MARKER } from '../tool-permissions'

export interface ParsedToolPermission {
  cwd: string
  sessionPath?: string
  toolName: string
  category: ToolPermissionCategory
  policyCategories: ToolPermissionCategory[]
  summary: string
  detail: string
  risks: ToolPermissionRequest['risks']
  canRemember: boolean
  subagent?: boolean
}

const CATEGORIES = new Set(['read', 'write', 'shell', 'network', 'external'])

/**
 * Parse and validate the JSON metadata embedded in a tool-permission
 * extension UI request title. Returns null for anything malformed; callers
 * must answer `deny` so the Agent never waits forever.
 */
export function parseToolPermissionMetadata(title: string): ParsedToolPermission | null {
  if (!title.startsWith(TOOL_PERMISSION_MARKER)) return null
  try {
    const metadata = JSON.parse(title.slice(TOOL_PERMISSION_MARKER.length)) as {
      cwd?: unknown
      sessionPath?: unknown
      toolName?: unknown
      category?: unknown
      policyCategories?: unknown
      summary?: unknown
      detail?: unknown
      risks?: unknown
      canRemember?: unknown
      subagent?: unknown
    }
    const categories = Array.isArray(metadata.policyCategories)
      ? metadata.policyCategories.filter((value): value is ToolPermissionCategory => (
          typeof value === 'string' && CATEGORIES.has(value)
        ))
      : []
    const category = metadata.category
    if (
      typeof metadata.cwd !== 'string'
      || typeof metadata.toolName !== 'string'
      || typeof metadata.summary !== 'string'
      || typeof metadata.detail !== 'string'
      || categories.length === 0
      || typeof category !== 'string'
      || !CATEGORIES.has(category)
    ) return null

    return {
      cwd: resolve(metadata.cwd),
      sessionPath: typeof metadata.sessionPath === 'string' ? metadata.sessionPath : undefined,
      toolName: metadata.toolName,
      category: category as ToolPermissionCategory,
      policyCategories: [...new Set(categories)],
      summary: metadata.summary.slice(0, 500),
      detail: metadata.detail.slice(0, 4_000),
      risks: Array.isArray(metadata.risks)
        ? metadata.risks.filter((value): value is ToolPermissionRequest['risks'][number] => (
            value === 'outside-workspace' || value === 'sensitive-path'
            || value === 'destructive-command'
          ))
        : [],
      canRemember: metadata.canRemember === true,
      ...(metadata.subagent === true ? { subagent: true } : {})
    }
  } catch {
    return null
  }
}
