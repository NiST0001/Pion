import { describe, expect, it } from 'vitest'
import {
  describeModelError,
  type ModelErrorCategory
} from '../../src/renderer/src/agent/modelError'

const EXPECTED_COPY: Record<ModelErrorCategory, { title: string; message: string }> = {
  quota: { title: '模型额度不足', message: '请等待额度重置，或补充余额、提高消费限额后重试。' },
  authentication: { title: '模型认证失败', message: '请在设置中重新登录，或检查 API Key 后重试。' },
  permission: { title: '无权使用此模型', message: '请检查当前账号或 API Key 的模型访问权限。' },
  'rate-limit': { title: '请求过于频繁', message: '请稍后重试，或切换模型/提供商。' },
  'context-too-long': { title: '对话内容过长', message: '请压缩会话、开启新会话，或切换到更大上下文的模型。' },
  'request-too-large': { title: '请求内容过大', message: '请缩短输入、移除较大附件，或压缩会话后重试。' },
  'model-unavailable': { title: '当前模型不可用', message: '请刷新模型列表、检查模型 ID，或切换模型。' },
  'service-failure': { title: '模型服务暂时不可用', message: '请稍后重试，或切换模型/提供商。' },
  network: { title: '无法连接模型服务', message: '请检查网络、代理和 API 地址后重试。' },
  'content-policy': { title: '请求被安全策略拦截', message: '请调整提示或附件后重试。' },
  'invalid-request': { title: '模型请求无效', message: '请检查模型配置、附件或请求参数后重试。' },
  unknown: { title: '模型请求失败', message: '请稍后重试；若持续出现，请检查模型设置或切换模型。' }
}

function expectCategory(raw: string, category: ModelErrorCategory): void {
  expect(describeModelError(raw)).toEqual({
    category,
    ...EXPECTED_COPY[category],
    raw
  })
}

describe('describeModelError', () => {
  it.each<[string, ModelErrorCategory]>([
    ['insufficient_quota: You exceeded your current quota', 'quota'],
    ['Credit balance is too low to access the API', 'quota'],
    ['usage_not_included: You have hit your ChatGPT usage limit', 'quota'],
    ['GoUsageLimitError: free plan exhausted', 'quota'],
    ['billing_error: out of budget', 'quota'],
    ['authentication_error: invalid_api_key', 'authentication'],
    ['No API key was provided with the request', 'authentication'],
    ['PERMISSION_DENIED: this account is not allowed to invoke the model', 'permission'],
    ['Access denied for the current credentials', 'permission'],
    ['{"type":"error","error":{"type":"permission_error","message":"Request not allowed"}}', 'permission'],
    ['rate_limit_exceeded: too many requests', 'rate-limit'],
    ['RESOURCE_EXHAUSTED: request rate is too high', 'rate-limit'],
    ['context_length_exceeded: maximum context length is 128000 tokens', 'context-too-long'],
    ['Input is too long; reduce the length of the messages', 'context-too-long'],
    ['Your input exceeds the context window of this model', 'context-too-long'],
    ["This model's maximum prompt length is 131072 but the request contains 537812 tokens", 'context-too-long'],
    ["The input (210000 tokens) is longer than the model's context length (200000 tokens)", 'context-too-long'],
    ['Range of input length should be [1, 131072]', 'context-too-long'],
    ['Please reduce the length of the messages or completion', 'context-too-long'],
    ['Prompt has 32769 tokens, but the configured context size is 32768 tokens', 'context-too-long'],
    ['Payload too large for this endpoint', 'request-too-large'],
    ['The uploaded attachment is too large', 'request-too-large'],
    ['model_not_found: no such model gpt-example', 'model-unavailable'],
    ['The model "retired-model" does not exist or you do not have access to it', 'model-unavailable'],
    ['overloaded_error: provider is temporarily unavailable', 'service-failure'],
    ['Internal server error from the upstream provider', 'service-failure'],
    ['Provider returned error', 'service-failure'],
    ['ModelStreamErrorException: provider is at capacity', 'service-failure'],
    ['TypeError: Failed to fetch', 'network'],
    ['OpenAI Responses stream ended before a terminal response event', 'network'],
    ['Anthropic stream ended before message_stop', 'network'],
    ['Connection error.', 'network'],
    ['connect ECONNRESET while calling the provider', 'network'],
    ['WebSocket connect timeout', 'network'],
    ['WebSocket idle timeout', 'network'],
    ['WebSocket closed unexpectedly', 'network'],
    ['SSE response headers timed out', 'network'],
    ['upstream provider returned error: ECONNRESET', 'network'],
    ['Request timed out.', 'network'],
    ['HTTP2 request did not get a response', 'network'],
    ['openai stream ended without a terminal event', 'network'],
    ['Provider returned error: upstream connect error', 'network'],
    ['Provider returned error: reset before headers', 'network'],
    ['content_policy_violation: prompt was blocked by the safety filter', 'content-policy'],
    ['Responsible_AI_Policy_Violation', 'content-policy'],
    ['Request blocked: forbidden content', 'content-policy'],
    ['invalid_request_error: unsupported parameter "thinking"', 'invalid-request'],
    ['Malformed JSON payload', 'invalid-request'],
    ['AuthenticationError: credentials expired', 'authentication'],
    ['PermissionDenied: access denied', 'permission'],
    ['RateLimitExceeded', 'rate-limit'],
    ['ContextLengthExceeded', 'context-too-long'],
    ['DeploymentNotFound', 'model-unavailable'],
    ['ContentPolicyViolation', 'content-policy'],
    ['InvalidRequestError', 'invalid-request'],
    ['unrecognized provider response', 'unknown'],
    ['', 'unknown']
  ])('classifies %j as %s', (raw, category) => {
    expectCategory(raw, category)
  })

  it('gives quota semantics priority over HTTP 429', () => {
    const raw = 'HTTP 429 Too Many Requests: {"code":"insufficient_quota"}'
    expectCategory(raw, 'quota')
  })

  it('gives throttling priority over generic too-many-token wording', () => {
    const raw = 'ThrottlingException: too many tokens were submitted in this interval'
    expectCategory(raw, 'rate-limit')
  })

  it('treats ModelNotReady as a transient service failure', () => {
    expectCategory('ModelNotReady: endpoint initialization is still in progress', 'service-failure')
    expectCategory('MODEL_NOT_READY', 'service-failure')
  })

  it.each<[string, ModelErrorCategory]>([
    ['HTTP/1.1 401 Unauthorized', 'authentication'],
    ['401 status code (no body)', 'authentication'],
    ['Request failed with status code: 403', 'permission'],
    ['403 status code (no body)', 'permission'],
    ['{"statusCode":429,"message":"slow down"}', 'rate-limit'],
    ['429 status code (no body)', 'rate-limit'],
    ['HTTP 413 Payload Too Large', 'request-too-large'],
    ['Response status was 422', 'invalid-request'],
    ['{"error":{"code":500,"message":"unexpected failure"}}', 'service-failure'],
    ['response.status = 429', 'rate-limit'],
    ['HTTP/2 503 Service Unavailable', 'service-failure'],
    ['500 status code (no body)', 'service-failure'],
    ['HTTP 409 Conflict', 'service-failure'],
    ['HTTPError: 500 Server Error', 'service-failure'],
    ['Error Code 401: credentials rejected', 'authentication'],
    ['HTTP 408 Request Timeout', 'network'],
    ['OpenAI API error (403): request rejected', 'permission'],
    ['401 {"type":"error","error":{"message":"Account rejected"}}', 'authentication'],
    ['403 {"type":"error","error":{"message":"Request not allowed"}}', 'permission'],
    ['500 {"type":"error","error":{"message":"Unexpected failure"}}', 'service-failure'],
    ['429', 'rate-limit']
  ])('recognizes an explicit HTTP status in %j', (raw, category) => {
    expectCategory(raw, category)
  })

  it.each([
    '404',
    'HTTP 404 Not Found',
    'Error 404: Not Found',
    '{"status":404,"message":"Not Found"}',
    '404 {"type":"error","error":{"message":"Not Found"}}'
  ])('does not guess a model cause from a bare 404 shape: %j', (raw) => {
    expectCategory(raw, 'unknown')
  })

  it.each([
    'Usage: 401 input tokens, 403 cached tokens, and 429 output tokens.',
    'The response contains 500 tokens.',
    'Token counters: 408 prompt / 503 completion.',
    '401 input tokens and 429 output tokens.'
  ])('does not mistake token counts for HTTP statuses: %j', (raw) => {
    expectCategory(raw, 'unknown')
  })

  it.each([
    'request exceeds maximum length',
    'input exceeds maximum input length',
    'maximum prompt length is 131072',
    'Range of input length should be [1, 131072]',
    'input length exceeds the limit',
    'prompt length is over the maximum'
  ])('uses generic length wording as context evidence only without HTTP 413: %j', (raw) => {
    expectCategory(raw, 'context-too-long')
    expectCategory(`HTTP 413 Payload Too Large: ${raw}`, 'request-too-large')
  })

  it.each([
    'HTTP 413 Payload Too Large: request is too long',
    '413 status code (no body)',
    '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    'HTTP 413 Payload Too Large: prompt is too long',
    'HTTP 413 Payload Too Large: shorten the input and retry',
    'HTTP 413 Payload Too Large: Please reduce the length of the messages',
    'HTTP 413 Payload Too Large: request exceeds maximum length of 10 MB',
    'HTTP 413 Payload Too Large: 输入过长，request exceeds maximum length of 10 MB，请缩短输入后重试',
    'HTTP 413: 提示词过长，input length exceeds the maximum size of 10 MB'
  ])('keeps HTTP 413 in the request-size category without context evidence: %j', (raw) => {
    expectCategory(raw, 'request-too-large')
  })

  it.each([
    'HTTP 413 Payload Too Large: maximum context length is 4096 tokens',
    'HTTP 413 Payload Too Large: prompt is too long: 213462 tokens > 200000 maximum',
    'HTTP 413 Payload Too Large: request exceeds maximum tokens allowed',
    'HTTP 413 Payload Too Large: input exceeds max input tokens',
    'HTTP 413 Payload Too Large: input token count exceeds the limit of 4096',
    'HTTP 413 Payload Too Large: 输入过长，token 数超限（5000 > 4096）',
    'HTTP 413 Payload Too Large: 输入过长，request exceeds maximum context length of 4096 tokens'
  ])('prefers explicit context evidence over HTTP 413: %j', (raw) => {
    expectCategory(raw, 'context-too-long')
  })

  it('still detects a context error when the message contains several token counts', () => {
    const raw = 'Maximum context length is 4096 tokens, but the request contains 5000 tokens.'
    expectCategory(raw, 'context-too-long')
  })

  it('preserves the raw error byte-for-byte instead of trimming or rewriting it', () => {
    const raw = '  HTTP 401 Unauthorized\ninvalid API key  '
    const result = describeModelError(raw)

    expect(result.raw).toBe(raw)
    expect(result).toEqual({
      category: 'authentication',
      ...EXPECTED_COPY.authentication,
      raw
    })
  })
})
