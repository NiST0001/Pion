/** Exact SDK identities; display labels and API types are not model IDs. */
export interface SubagentModelSelection {
  provider: string
  id: string
}

export function validateSubagentModelSelection(value: unknown): SubagentModelSelection | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('子代理模型格式无效')
  const input = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(input, 'provider') || !Object.prototype.hasOwnProperty.call(input, 'id')
    || Object.keys(input).some((key) => key !== 'provider' && key !== 'id')) throw new Error('子代理模型仅接受 provider 和 id')
  const valid = (text: unknown, max: number): text is string => typeof text === 'string'
    && text.length > 0 && text.length <= max && !/[\s\u0000-\u001f\u007f]/u.test(text)
  if (!valid(input.provider, 128) || !valid(input.id, 256)) throw new Error('子代理模型 provider/id 无效')
  return { provider: input.provider, id: input.id }
}

/** User-tunable limits/default model, snapshotted once per batch. */
export interface SubagentSettings {
  maxParallel: number
  timeoutMinutes: number
  maxTurns: number
  maxResultChars: number
  /** Missing in legacy files; null inherits the main session model. */
  defaultModel?: SubagentModelSelection | null
}

export const SUBAGENT_LIMITS = {
  maxParallel: { min: 1, max: 100 },
  timeoutMinutes: { min: 1, max: 300 },
  maxTurns: { min: 1, max: 64 },
  maxResultChars: { min: 1000, max: 32000 }
} as const

export const DEFAULT_SUBAGENTS_ENABLED = true

export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> = Object.freeze({
  maxParallel: 3, timeoutMinutes: 10, maxTurns: 24, maxResultChars: 16000, defaultModel: null
})

export function validateSubagentSettings(value: unknown): SubagentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('子代理设置格式无效')
  const input = value as Record<string, unknown>
  const result = { ...DEFAULT_SUBAGENT_SETTINGS }
  for (const key of Object.keys(SUBAGENT_LIMITS) as (keyof typeof SUBAGENT_LIMITS)[]) {
    const number = input[key]
    const { min, max } = SUBAGENT_LIMITS[key]
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
      throw new Error(`子代理参数 ${key} 必须是 ${min}–${max} 之间的整数`)
    }
    result[key] = number
  }
  result.defaultModel = input.defaultModel === undefined ? null : validateSubagentModelSelection(input.defaultModel)
  return result
}
