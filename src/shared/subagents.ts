/** User-tunable limits, snapshotted once per batch; hard bounds remain enforced. */
export interface SubagentSettings {
  maxParallel: number
  timeoutMinutes: number
  maxTurns: number
  maxResultChars: number
}

export const SUBAGENT_LIMITS = {
  maxParallel: { min: 1, max: 8 },
  timeoutMinutes: { min: 1, max: 30 },
  maxTurns: { min: 1, max: 64 },
  maxResultChars: { min: 1000, max: 32000 }
} as const

export const DEFAULT_SUBAGENTS_ENABLED = true

export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> = Object.freeze({
  maxParallel: 3, timeoutMinutes: 10, maxTurns: 24, maxResultChars: 16000
})

export function validateSubagentSettings(value: unknown): SubagentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('子代理设置格式无效')
  const input = value as Record<string, unknown>
  const result = { ...DEFAULT_SUBAGENT_SETTINGS }
  for (const key of Object.keys(SUBAGENT_LIMITS) as (keyof SubagentSettings)[]) {
    const number = input[key]
    const { min, max } = SUBAGENT_LIMITS[key]
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
      throw new Error(`子代理参数 ${key} 必须是 ${min}–${max} 之间的整数`)
    }
    result[key] = number
  }
  return result
}
