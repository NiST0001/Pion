import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/** Compiled into Pion's SDK host; not an extension or an installed plugin. */
export const askUserTool = defineTool({
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
  async execute(_id, params, signal, _onUpdate, ctx) {
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
    const title = `AI 提问：${question}`
    let answer: string | undefined
    if (options.length) {
      const labels = options.map((option, index) => `${index + 1}. ${option}`)
      const other = '自定义回答…'
      const selected = await ctx.ui.select(title, [...labels, other], { signal })
      if (signal?.aborted) return stop('aborted')
      if (selected === undefined) return stop('cancelled')
      if (selected !== other) {
        const index = labels.indexOf(selected)
        if (index < 0) throw new Error('无效的回答选项')
        answer = options[index]
      }
    }
    if (answer === undefined) {
      answer = await ctx.ui.input(title, '输入回答（将发送给 AI 并保存在会话中，请勿输入密码或密钥）', { signal })
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
})
