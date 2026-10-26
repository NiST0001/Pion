export const PION_TURN_TIMING_TYPE = 'pion-turn-timing'

export interface TurnTiming {
  startedAt: number
  finishedAt: number
  durationMs?: number
  outcome: 'completed' | 'failed' | 'aborted' | 'ended'
}

/** A source conflict is an explicit display tombstone; absent old data is not. */
export function mergeTurnTiming(current: TurnTiming | null | undefined, incoming: TurnTiming | null | undefined): TurnTiming | null | undefined {
  return current === null || incoming === null ? null : current ?? incoming
}

export interface TurnTimingRecord extends TurnTiming {
  version: 1
  userEntryId: string
  inputId: string
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const clock = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime())
const identity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && !value.includes('\0')

/** Display-only evidence. Preserve real clocks, including a wall-clock rollback. */
export function parseTurnTiming(raw: unknown): TurnTiming | undefined {
  const value = object(raw)
  if (!value || !clock(value.startedAt) || !clock(value.finishedAt)) return
  const { startedAt, finishedAt, durationMs, outcome } = value
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'aborted' && outcome !== 'ended') return
  if (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs)
    || durationMs < 0 || durationMs !== finishedAt - startedAt)) return
  return { startedAt, finishedAt, ...(durationMs === undefined ? {} : { durationMs }), outcome }
}

export function turnTimingFromEntry(entry: unknown): TurnTimingRecord | undefined {
  const value = object(entry)
  if (value?.type !== 'custom' || value.customType !== PION_TURN_TIMING_TYPE) return
  const data = object(value.data)
  if (!data || data.version !== 1 || !identity(data.userEntryId) || !identity(data.inputId)) return
  const timing = parseTurnTiming(data)
  if (!timing) return
  return { version: 1, userEntryId: data.userEntryId, inputId: data.inputId, ...timing }
}
