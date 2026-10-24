import type { ExtensionUiRequest } from './types'

export const QUESTION_CUSTOM_ANSWER_OPTION = '自定义回答…'
const QUESTION_CUSTOM_ANSWER_PREFIX = '\u001epion:question-custom-answer:v1:'

export function supportsCustomQuestionAnswer(request: Pick<ExtensionUiRequest, 'question' | 'method' | 'scope' | 'options'>): boolean {
  return request.question === true && request.method === 'select' && request.scope !== 'global'
    && request.options?.includes(QUESTION_CUSTOM_ANSWER_OPTION) === true
}

// Transport marker only; the host still requires its native question receipt.
export function encodeQuestionCustomAnswer(answer: string): string {
  return QUESTION_CUSTOM_ANSWER_PREFIX + answer
}

export function decodeQuestionCustomAnswer(value: string): string | undefined {
  return value.startsWith(QUESTION_CUSTOM_ANSWER_PREFIX) ? value.slice(QUESTION_CUSTOM_ANSWER_PREFIX.length) : undefined
}
