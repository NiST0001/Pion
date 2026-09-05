import { access } from 'node:fs/promises'
import type { TokenUsage } from '../../shared/operations'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4_096) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function finiteMetric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Pi usage objects are cumulative snapshots for one assistant model call. */
export function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const cost = usage.cost && typeof usage.cost === 'object'
    ? usage.cost as Record<string, unknown>
    : {}
  const input = finiteMetric(usage.input)
  const output = finiteMetric(usage.output)
  const cacheRead = finiteMetric(usage.cacheRead)
  const cacheWrite = finiteMetric(usage.cacheWrite)
  const reasoning = finiteMetric(usage.reasoning)
  const total = finiteMetric(usage.totalTokens) || input + output + cacheRead + cacheWrite
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total,
    costUsd: finiteMetric(cost.total)
  }
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
    total: left.total + right.total,
    costUsd: left.costUsd + right.costUsd
  }
}

export function promptPreview(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized
}
