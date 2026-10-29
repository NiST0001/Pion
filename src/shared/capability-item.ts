import type { CapabilityItem } from './capability-settings'

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Pure public-metadata whitelist. Callers still authenticate runtime/source
 * receipts and choose whether an invalid entry is skipped or rejects the batch.
 */
export function parseCapabilityItem(value: unknown): CapabilityItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (!text(item.id, 160) || !text(item.name, 128) || !text(item.label, 128)
    || !text(item.description, 1024) || typeof item.enabled !== 'boolean' || typeof item.available !== 'boolean'
    || typeof item.origin !== 'string' || !['pi', 'pion', 'user', 'project', 'extension', 'mcp'].includes(item.origin)
    || typeof item.kind !== 'string' || !['tool', 'subagent', 'mcp', 'skill', 'extension'].includes(item.kind)
    || (item.unavailableReason !== undefined && !text(item.unavailableReason, 256))) return undefined
  const kind = item.kind as CapabilityItem['kind']
  if ((kind === 'tool' || kind === 'subagent')
    ? !/^tool:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(item.id) || item.id !== `tool:${item.name}`
      || (kind === 'subagent') !== (item.id === 'tool:pion_subagents')
    : !new RegExp(`^${kind}:[a-f0-9]{64}$`).test(item.id)) return undefined
  return {
    id: item.id, kind, name: item.name, label: item.label, description: item.description,
    origin: item.origin as CapabilityItem['origin'], enabled: item.enabled, available: item.available,
    ...(item.unavailableReason !== undefined ? { unavailableReason: item.unavailableReason as string } : {})
  }
}
