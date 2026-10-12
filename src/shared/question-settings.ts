export interface QuestionSettings { timeoutMinutes: number | null }
export const DEFAULT_QUESTION_SETTINGS: Readonly<QuestionSettings> = Object.freeze({ timeoutMinutes: 10 })
export const QUESTION_SETTINGS_MAX_BYTES = 4096
export const QUESTION_WAIT_WIDGET_KEY = 'pion:question-wait:v1'

export function validateQuestionSettings(value: unknown): QuestionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'timeoutMinutes')) throw new Error('AI 提问设置无效')
  const timeoutMinutes = (value as QuestionSettings).timeoutMinutes
  if (timeoutMinutes !== null && (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 300)) {
    throw new Error('AI 提问等待时间须为 1–300 分钟，或不自动超时')
  }
  return { timeoutMinutes }
}

/** Private host metadata; not a title-based permission or authentication boundary. */
export interface QuestionWaitMetadata {
  version: 1
  nonce: string
  toolCallId: string
  phase: 'begin' | 'end'
  timeoutMs: number | null
}

export function parseQuestionWaitMetadata(lines: unknown): QuestionWaitMetadata | undefined {
  if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string' || lines[0].length > 2048) return undefined
  try {
    const value = JSON.parse(lines[0]) as QuestionWaitMetadata
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['version', 'nonce', 'toolCallId', 'phase', 'timeoutMs'].includes(key))
      || value.version !== 1 || typeof value.nonce !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.nonce)
      || typeof value.toolCallId !== 'string' || !value.toolCallId || value.toolCallId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.toolCallId)
      || (value.phase !== 'begin' && value.phase !== 'end')
      || (value.timeoutMs !== null && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 300 * 60_000))) return undefined
    return { version: 1, nonce: value.nonce, toolCallId: value.toolCallId, phase: value.phase, timeoutMs: value.timeoutMs }
  } catch { return undefined }
}
