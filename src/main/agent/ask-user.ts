import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { open } from 'node:fs/promises'
import { DEFAULT_QUESTION_SETTINGS, QUESTION_SETTINGS_MAX_BYTES, QUESTION_WAIT_WIDGET_KEY, parseQuestionWaitMetadata, validateQuestionSettings, type QuestionSettings, type QuestionWaitMetadata } from '../../shared/question-settings'

// Shared across SDK replacements; a timed-out disk operation retains its slot.
let settingsRead: Promise<QuestionSettings> | undefined
export async function readRuntimeQuestionSettings(): Promise<QuestionSettings> {
  const path = process.env.PION_QUESTION_SETTINGS_FILE
  if (!path) return { ...DEFAULT_QUESTION_SETTINGS }
  if (settingsRead) throw new Error('AI 提问设置仍在读取，请稍后再试；未提供答案或授权')
  const pending = (async () => {
    try {
      const file = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(QUESTION_SETTINGS_MAX_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > QUESTION_SETTINGS_MAX_BYTES) throw new Error('AI 提问设置文件过大')
        return validateQuestionSettings(JSON.parse(buffer.subarray(0, length).toString('utf8')))
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_QUESTION_SETTINGS }
      throw new Error('无法读取 AI 提问设置；未提供答案或授权')
    }
  })()
  settingsRead = pending
  const clear = () => { if (settingsRead === pending) settingsRead = undefined }
  void pending.then(clear, clear)
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('读取 AI 提问设置超时；未提供答案或授权')), 5000)
  })]).finally(() => clearTimeout(timer)).then((value) => ({ ...value }))
}

/** Compiled into Pion's SDK host; not an extension or an installed plugin. */
export function createAskUserTool(readSettings: () => Promise<QuestionSettings> = readRuntimeQuestionSettings) { return defineTool({
  name: 'pion_ask_user',
  label: '向用户提问',
  description: 'Ask the user one focused clarification question and wait for their answer. Optional choices always allow a custom answer. Answers are stored in the session; do not request passwords or API keys. Answers longer than 8000 characters are truncated with an explicit marker.',
  promptSnippet: 'Ask the user when missing information or a consequential choice blocks progress',
  promptGuidelines: [
    'Use pion_ask_user for consequential ambiguity that cannot be resolved from the request or available context; do not ask about trivial implementation details.',
    'Call pion_ask_user alone, before dependent actions, not in parallel with changes that assume an answer.',
    'A cancelled or unavailable pion_ask_user answer is not consent. Do not guess an answer or immediately repeat the question. The tool does not replace tool permission checks.'
  ],
  parameters: Type.Object({
    question: Type.String({ minLength: 1, maxLength: 2000, description: 'A specific question in the user’s language, with necessary context' }),
    options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 2, maxItems: 8, description: 'Optional concise choices; a custom-answer option is added automatically' }))
  }),
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    const question = params.question.trim()
    if (!question) throw new Error('问题不能为空')
    const stop = (status: 'cancelled' | 'aborted' | 'unavailable') => ({
      content: [{ type: 'text' as const, text: `Question ${status}. No answer or authorization was provided. Do not assume consent or immediately ask again.` }],
      details: { question, status, answer: undefined as string | undefined, truncated: false },
      terminate: true
    })
    if (signal?.aborted) return stop('aborted')
    if (!ctx.hasUI) return stop('unavailable')
    const options = params.options?.map((option) => option.trim()) ?? []
    if (options.some((option) => !option)) throw new Error('选项不能为空')
    // Capture once per question; changing settings never resets an active dialog.
    const settings = validateQuestionSettings(await readSettings())
    if (signal?.aborted) return stop('aborted')
    const deadline = settings.timeoutMinutes === null ? null : performance.now() + settings.timeoutMinutes * 60_000
    const nonce = process.env.PION_QUESTION_UI_NONCE
    const dialog = async <T>(request: (opts: { signal?: AbortSignal; timeout?: number }) => Promise<T>): Promise<T> => {
      const timeoutMs = deadline === null ? null : Math.max(1, Math.ceil(deadline - performance.now()))
      const publish = (phase: QuestionWaitMetadata['phase']) => {
        if (nonce && typeof ctx.ui.setWidget === 'function') {
          const metadata: QuestionWaitMetadata = { version: 1, nonce, toolCallId, phase, timeoutMs }
          const lines = [JSON.stringify(metadata)]
          if (parseQuestionWaitMetadata(lines)) ctx.ui.setWidget(QUESTION_WAIT_WIDGET_KEY, lines)
        }
      }
      publish('begin')
      try { return await request(timeoutMs === null ? { signal } : { signal, timeout: timeoutMs }) }
      finally { publish('end') }
    }
    const title = `AI 提问：${question}`
    let answer: string | undefined
    if (options.length) {
      const labels = options.map((option, index) => `${index + 1}. ${option}`)
      const other = '自定义回答…'
      const selected = await dialog((opts) => ctx.ui.select(title, [...labels, other], opts))
      if (signal?.aborted) return stop('aborted')
      if (selected === undefined) return stop('cancelled')
      if (selected !== other) {
        const index = labels.indexOf(selected)
        if (index < 0) throw new Error('无效的回答选项')
        answer = options[index]
      }
    }
    if (answer === undefined) {
      if (deadline !== null && performance.now() >= deadline) return stop('cancelled')
      answer = await dialog((opts) => ctx.ui.input(title, '输入回答（将发送给 AI 并保存在会话中，请勿输入密码或密钥）', opts))
    }
    if (signal?.aborted) return stop('aborted')
    if (!answer?.trim()) return stop('cancelled')
    const truncated = answer.length > 8000
    answer = answer.trim().slice(0, 8000)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ question, answer, truncated }) + (truncated ? '\n[Answer truncated to 8000 characters.]' : '') }],
      details: { question, status: 'answered', answer, truncated }
    }
  }
}) }

export const askUserTool = createAskUserTool()
