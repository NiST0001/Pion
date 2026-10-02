export type ModelErrorCategory =
  | 'quota'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'context-too-long'
  | 'request-too-large'
  | 'model-unavailable'
  | 'service-failure'
  | 'network'
  | 'content-policy'
  | 'invalid-request'
  | 'unknown'

export interface ModelErrorPresentation {
  category: ModelErrorCategory
  title: string
  message: string
  raw: string
}

type PresentationCopy = Pick<ModelErrorPresentation, 'title' | 'message'>

const PRESENTATIONS: Record<ModelErrorCategory, PresentationCopy> = {
  quota: {
    title: '模型额度不足',
    message: '请等待额度重置，或补充余额、提高消费限额后重试。'
  },
  authentication: {
    title: '模型认证失败',
    message: '请在设置中重新登录，或检查 API Key 后重试。'
  },
  permission: {
    title: '无权使用此模型',
    message: '请检查当前账号或 API Key 的模型访问权限。'
  },
  'rate-limit': {
    title: '请求过于频繁',
    message: '请稍后重试，或切换模型/提供商。'
  },
  'context-too-long': {
    title: '对话内容过长',
    message: '请压缩会话、开启新会话，或切换到更大上下文的模型。'
  },
  'request-too-large': {
    title: '请求内容过大',
    message: '请缩短输入、移除较大附件，或压缩会话后重试。'
  },
  'model-unavailable': {
    title: '当前模型不可用',
    message: '请刷新模型列表、检查模型 ID，或切换模型。'
  },
  'service-failure': {
    title: '模型服务暂时不可用',
    message: '请稍后重试，或切换模型/提供商。'
  },
  network: {
    title: '无法连接模型服务',
    message: '请检查网络、代理和 API 地址后重试。'
  },
  'content-policy': {
    title: '请求被安全策略拦截',
    message: '请调整提示或附件后重试。'
  },
  'invalid-request': {
    title: '模型请求无效',
    message: '请检查模型配置、附件或请求参数后重试。'
  },
  unknown: {
    title: '模型请求失败',
    message: '请稍后重试；若持续出现，请检查模型设置或切换模型。'
  }
}

const QUOTA_PATTERNS: readonly RegExp[] = [
  /\binsufficient\s+quota\b/,
  /\bquota\s+(?:has\s+been\s+|is\s+)?(?:exceeded|exhausted|depleted)\b/,
  /\b(?:exceeded|exhausted|depleted)\s+(?:your\s+|the\s+)?(?:current\s+)?quota\b/,
  /\b(?:billing|spending|usage|budget|plan)\s+(?:hard\s+)?limit\s+(?:has\s+(?:been\s+)?|was\s+)?(?:reached|exceeded)\b/,
  /\bhit\s+(?:your|the)\s+(?:chatgpt\s+)?usage\s+limit\b/,
  /\busage\s+(?:is\s+)?not\s+included\b/,
  /\b(?:go|free)\s+usage\s+limit\s+error\b/,
  /\bbilling\s+error\b/,
  /\bout\s+of\s+budget\b/,
  /\b(?:insufficient|no|out\s+of|depleted)\s+(?:account\s+)?(?:credits?|balance)\b/,
  /\bcredit\s+balance\s+(?:is\s+)?(?:too\s+low|empty|depleted|insufficient)\b/,
  /\bpayment\s+required\b/,
  /(?:额度|配额|余额)(?:不足|已?用尽|耗尽|超限|已?超出)/
]

const MODEL_NOT_READY_PATTERNS: readonly RegExp[] = [
  /\bmodelnotready\b/,
  /\bmodel\s+(?:is\s+)?not\s+ready\b/
]

const CONTENT_POLICY_PATTERNS: readonly RegExp[] = [
  /\bcontent\s+(?:policy\s+)?violation\b/,
  /\bcontent\s+filter(?:ed|ing)?\b/,
  /\bresponsible\s+ai\s+policy\s+violation\b/,
  /\b(?:safety|moderation)\s+(?:policy|filter|system|violation|block)\b/,
  /\b(?:prohibited|forbidden|unsafe|harmful|disallowed|sensitive)\s+content\b/,
  /\b(?:prompt|request|response|content)\s+(?:was\s+)?blocked\s+(?:by|for|due\s+to)\s+(?:the\s+)?(?:safety|moderation|content\s+(?:policy|filter)|guardrail)\b/,
  /\bprovider\s+stopped\s+with:\s*(?:sensitive|safety|refusal)\b/,
  /\bthe\s+model\s+refused\s+to\s+complete\s+the\s+request\b/,
  /\bguardrail\s+(?:blocked|rejected|violation|intervened)\b/,
  /\bblocklist\b/,
  /(?:内容|提示词).{0,8}(?:安全策略|内容策略|审核)(?:拦截|拒绝|阻止|违规)/
]

const AUTHENTICATION_PATTERNS: readonly RegExp[] = [
  /\b(?:authentication|auth)\s+(?:failed|failure|error|required)\b/,
  /\b(?:unauthenticated|unauthorized)\b/,
  /\b(?:api\s+key|access\s+token|authentication\s+token|auth\s+token|bearer\s+token|credentials?)\b[\s\S]{0,40}\b(?:invalid|incorrect|not\s+valid|expired|missing|not\s+found|revoked|required)\b/,
  /\b(?:invalid|incorrect|expired|missing|revoked|no)\b[\s\S]{0,32}\b(?:api\s+key|access\s+token|authentication\s+token|auth\s+token|credentials?)\b/,
  /\b(?:invalid|expired|missing|revoked)\s+(?:api\s+)?(?:key|token|credential)\b/,
  /\bfailed\s+to\s+extract\s+account\s*id\s+from\s+token\b/,
  /(?:认证失败|身份验证失败|未认证|api\s*密钥(?:无效|错误|缺失|过期))/
]

const DEFINITE_MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\b(?:model|deployment)\b[\s\S]{0,80}\b(?:is\s+|was\s+)?not\s+found\b/,
  /\bno\s+such\s+(?:model|deployment)\b/,
  /\b(?:unknown|unsupported|invalid)\s+model\b/,
  /\bmodel\b[\s\S]{0,80}\bdoes\s+not\s+exist\b/,
  /\bcould\s+not\s+find\b[\s\S]{0,40}\bmodel\b/,
  /(?:模型|部署)(?:不存在|未找到)/
]

const PERMISSION_PATTERNS: readonly RegExp[] = [
  /\bpermission\s+(?:denied|error)\b/,
  /\b(?:insufficient|missing)\s+permissions?\b/,
  /\black(?:s|ing)?\s+(?:the\s+required\s+)?permissions?\b/,
  /\bforbidden\b/,
  /\baccess\s+denied\b/,
  /\b(?:(?:do|does)\s+not|don['’]t|doesn['’]t|cannot|can['’]t)\s+have\s+access\b/,
  /\b(?:not|never)\s+(?:permitted|allowed|authorized)\s+to\s+(?:access|use|invoke)\b/,
  /\bauthorization\s+(?:failed|failure|error)\b/,
  /(?:没有|无|缺少).{0,6}(?:访问)?权限|访问被拒绝/
]

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\brate\s+limit(?:ed|ing)?\b/,
  /\btoo\s+many\s+requests\b/,
  /\bserver\s+requested\s+\d+\s*s\s+retry\s+delay\b/,
  /\bthrottl(?:e|ed|ing|ingexception)\b/,
  /\bresource\s+exhausted\b/,
  /\b(?:requests?|tokens?)\s+per\s+(?:second|minute|hour|day)\b/,
  /\b(?:request|token)\s+rate\b/,
  /\bconcurren(?:cy|t\s+request)\s+limit\b/,
  /(?:请求过于频繁|请求频率过高|触发限流|速率限制)/
]

const CONTEXT_TOO_LONG_PATTERNS: readonly RegExp[] = [
  /\bcontext\s+(?:length|window)\s+(?:has\s+been\s+|is\s+)?(?:exceeded|too\s+long)\b/,
  /\bcontext\s+window\s+exceeds?\s+(?:the\s+)?limit\b/,
  /\b(?:maximum|max)\s+context\s+length\b/,
  /\bcontext\s+(?:is\s+)?too\s+long\b/,
  /\b(?:prompt|input)\s+(?:is\s+)?too\s+long:\s*[\d,]+\s+tokens?\s*>\s*[\d,]+\s+maximum\b/,
  /\b(?:input|request)\s+exceeds?\s+(?:the\s+)?context\s+window\b/,
  /\b(?:input|prompt)\s*\([\d,]+(?:\s+tokens?)?\)\s+is\s+longer\s+than\s+(?:the\s+)?model['’]s\s+context\s+length\b/,
  /\b(?:request\s+)?exceeded\s+(?:the\s+)?model\s+token\s+limit\b/,
  /\bexceeds?\s+(?:the\s+)?available\s+context\s+size\b/,
  /\bgreater\s+than\s+(?:the\s+)?context\s+length\b/,
  /\btoo\s+large\s+for\s+(?:the\s+)?model\b[\s\S]{0,48}\bmaximum\s+context\s+length\b/,
  /\btoo\s+many\s+tokens\b/,
  /\btoken\s+limit\s+(?:has\s+been\s+|is\s+)?exceeded\b/,
  /\b(?:input|prompt)\s+token\s+count\b[\s\S]{0,48}\b(?:exceeds?|over)\b[\s\S]{0,32}\b(?:limit|maximum|context)\b/,
  /\bexceeds?\s+(?:the\s+)?(?:model['’]s\s+)?(?:maximum|max)\s+(?:context\s+length|(?:(?:context|input)\s+)?tokens?)\b/,
  /\bprompt\s+has\s+[\d,]+\s+tokens?,\s*but\s+the\s+configured\s+context\s+size\s+is\s+[\d,]+\s+tokens?\b/,
  /上下文(?:过长|太长|超出.{0,6}(?:限制|窗口))|token\s*数.{0,6}(?:过多|超限)/
]

// These provider phrases can also describe byte-size failures. HTTP 413 needs
// token/context evidence above rather than just a suggestion to shorten input.
const PROMPT_TOO_LONG_PATTERNS: readonly RegExp[] = [
  /\bmaximum\s+prompt\s+length\s+is\s+[\d,]+\b/,
  /\brange\s+of\s+input\s+length\s+should\s+be\b/,
  /\b(?:input|prompt)\s+length\b[\s\S]{0,48}\b(?:exceeds?|over)\b[\s\S]{0,32}\b(?:limit|maximum|context)\b/,
  /\bexceeds?\s+(?:the\s+)?(?:model['’]s\s+)?(?:maximum|max)\s+(?:input\s+)?length\b/,
  /\b(?:prompt|input)\s+(?:is\s+)?too\s+long\b/,
  /\breduce\s+the\s+length\s+of\s+the\s+messages\b/,
  /\b(?:reduce|shorten)\s+(?:the\s+)?(?:prompt|input|messages?|context)\b/,
  /(?:输入|提示词)(?:过长|太长|超出.{0,6}(?:限制|窗口))/
]

const REQUEST_TOO_LARGE_PATTERNS: readonly RegExp[] = [
  /\b(?:request|payload|message|body|attachment|upload|file)\s+(?:is\s+)?too\s+large\b/,
  /\brequest\s+entity\s+too\s+large\b/,
  /\bpayload\s+too\s+large\b/,
  /\b(?:request|payload|body)\s+size\b[\s\S]{0,40}\b(?:exceeds?|over|larger\s+than)\b[\s\S]{0,32}\b(?:limit|maximum|max)\b/,
  /(?:请求|附件|上传内容)(?:过大|太大|超出.{0,6}(?:大小|限制))/
]

const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  ...DEFINITE_MODEL_UNAVAILABLE_PATTERNS,
  /\bmodel\s+(?:is\s+)?(?:currently\s+)?(?:unavailable|not\s+available|unsupported|not\s+supported|retired|deprecated)\b/,
  /\bno\s+(?:available|compatible)\s+(?:model|deployment)\b/,
  /(?:模型|部署)(?:不可用|不受支持|已停用|已下线)/
]

const SERVICE_FAILURE_PATTERNS: readonly RegExp[] = [
  /\binternal\s+(?:server\s+)?(?:error|exception)\b/,
  /\bserver\s+error\b/,
  /\bserver\s+(?:encountered|returned)\s+(?:an?\s+)?error\b/,
  /\b(?:bad\s+gateway|gateway\s+timeout|service\s+unavailable(?:\s+exception)?)\b/,
  /\b(?:server|service|provider|model)\s+(?:is\s+)?(?:overloaded|temporarily\s+unavailable)\b/,
  /\b(?:model\s+stream|overloaded)\s+error(?:\s+exception)?\b/,
  /\b(?:high\s+demand|at\s+capacity)\b/,
  /\b(?:upstream\s+)?provider\s+(?:returned\s+)?error\b/,
  /(?:服务|服务器)(?:异常|故障|暂时不可用|过载)/
]

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(?:network\s+error|networkerror|connection\s+error|failed\s+to\s+fetch|fetch\s+failed)\b/,
  /\b(?:econnreset|econnrefused|econnaborted|etimedout|enotfound|eai again)\b/,
  /\bconnection\s+(?:was\s+)?(?:reset|refused|closed|aborted|lost|timed\s+out)\b/,
  /\bsocket\s+hang\s+up\b/,
  /\b(?:request|network)\s+timed\s+out\b/,
  /\b(?:web\s*socket|sse)\s+(?:(?:connect(?:ion)?|idle|response)\s+)?(?:timeout|timed\s+out)\b/,
  /\b(?:sse\s+)?response\s+headers?\s+(?:timeout|timed\s+out)\b/,
  /\bheaders?\s+timeout\b/,
  /\b(?:dns|hostname)\s+(?:lookup|resolution|resolve)\b/,
  /\b(?:tls|ssl|certificate)\s+(?:error|failure|failed|invalid)\b/,
  /\bcors\s+(?:error|blocked|failure)\b/,
  /\b(?:proxy|tunnel)\s+(?:error|connection\s+failed)\b/,
  /\bupstream\s+connect\s+error\b/,
  /\breset\s+before\s+headers\b/,
  /\b(?:web\s*socket|http\/?2)\b[\s\S]{0,48}\b(?:closed?|reset|failure|failed|error|did\s+not\s+get\s+a\s+response)\b/,
  /\bstream\s+ended\s+(?:before\s+(?:a\s+)?(?:terminal\s+(?:response\s+)?event|message\s+stop)|without\s+(?:a\s+)?(?:(?:stop|finish)\s+reason|terminal\s+event))\b/,
  /(?:网络|连接)(?:错误|失败|中断|超时|被重置)/
]

const INVALID_REQUEST_PATTERNS: readonly RegExp[] = [
  /\binvalid\s+request\b/,
  /\bbad\s+request\b/,
  /\bmalformed\s+(?:request|json|payload)\b/,
  /\bvalidation\s+(?:error|exception|failed|failure)\b/,
  /\b(?:missing|required|unknown|unrecognized|unsupported|invalid)\s+(?:request\s+)?(?:parameter|argument|field|property|value)\b/,
  /\bunprocessable\s+entity\b/,
  /(?:请求无效|请求格式错误|参数(?:无效|错误|缺失)|缺少必填字段)/
]

function normalize(raw: string): string {
  return raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function extractHttpStatuses(raw: string): ReadonlySet<number> {
  const statuses = new Set<number>()
  const value = raw.replace(/\\(["'])/g, '$1')
  const patterns = [
    /\bhttp(?:\/[12](?:\.\d)?)?\s*(?:status\s*)?[:=]?\s*["']?([1-5]\d{2})\b/gi,
    /\b(?:response[_\s-]+)?status(?:[_\s-]+code)?\s*(?:(?:is|was)\s*)?(?:[:=]\s*)?["']?([1-5]\d{2})\b/gi,
    /["'](?:status|statuscode|status_code|httpstatus|http_status|code)["']\s*:\s*["']?([1-5]\d{2})\b/gi,
    /\b(?:statuscode|status_code|httpstatus|http_status|response\s+code|http\s+code|error\s+code|code)\s*[:=]\s*["']?([1-5]\d{2})\b/gi,
    /\b(?:response|error)\s*\.\s*(?:status|statuscode|status_code|code)\s*[:=]\s*["']?([1-5]\d{2})\b/gi,
    /\berror\s+code\s*[:=]?\s*([1-5]\d{2})\b/gi,
    /\b([1-5]\d{2})\s+status\s+code\b/gi,
    /\b([1-5]\d{2})\s+(?:bad\s+request|unauthorized|payment\s+required|forbidden|not\s+found|request\s+timeout|payload\s+too\s+large|unprocessable\s+entity|too\s+many\s+requests|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+timeout)\b/gi,
    /\b(?:(?:api|http)\s*)?error\s*[:#(]?\s*([1-5]\d{2})(?=\s*(?:[:#)\]-]|client\b|server\b|$))/gi,
    /^\s*([1-5]\d{2})(?=\s*(?:[:#-]|$))/gim,
    // OpenAI/Anthropic SDK APIError.makeMessage can prefix a JSON error body
    // with the status and a space rather than a colon.
    /^\s*([1-5]\d{2})\s+(?=\{)/gm
  ]

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      statuses.add(Number(match[1]))
    }
  }

  return statuses
}

function presentation(category: ModelErrorCategory, raw: string): ModelErrorPresentation {
  return { category, ...PRESENTATIONS[category], raw }
}

export function describeModelError(raw: string): ModelErrorPresentation {
  const normalized = normalize(raw)
  const statuses = extractHttpStatuses(raw)

  // Provider errors often pair HTTP 429 with a billing code. The billing cause wins.
  if (matchesAny(normalized, QUOTA_PATTERNS) || statuses.has(402)) {
    return presentation('quota', raw)
  }

  // ModelNotReady is a transient serving failure, not an invalid model selection.
  if (matchesAny(normalized, MODEL_NOT_READY_PATTERNS)) {
    return presentation('service-failure', raw)
  }

  if (matchesAny(normalized, CONTENT_POLICY_PATTERNS)) {
    return presentation('content-policy', raw)
  }

  if (matchesAny(normalized, AUTHENTICATION_PATTERNS) || statuses.has(401)) {
    return presentation('authentication', raw)
  }

  // A definite missing model remains actionable even when providers append an
  // ambiguous "or you do not have access" suffix.
  if (matchesAny(normalized, DEFINITE_MODEL_UNAVAILABLE_PATTERNS)) {
    return presentation('model-unavailable', raw)
  }

  if (matchesAny(normalized, PERMISSION_PATTERNS) || statuses.has(403)) {
    return presentation('permission', raw)
  }

  // Throttling must win over generic token-count wording in the same error.
  if (matchesAny(normalized, RATE_LIMIT_PATTERNS) || statuses.has(429)) {
    return presentation('rate-limit', raw)
  }

  if (matchesAny(normalized, CONTEXT_TOO_LONG_PATTERNS)
    || (!statuses.has(413) && matchesAny(normalized, PROMPT_TOO_LONG_PATTERNS))) {
    return presentation('context-too-long', raw)
  }

  if (matchesAny(normalized, REQUEST_TOO_LARGE_PATTERNS) || statuses.has(413)) {
    return presentation('request-too-large', raw)
  }

  if (matchesAny(normalized, MODEL_UNAVAILABLE_PATTERNS)) {
    return presentation('model-unavailable', raw)
  }

  // Prefer a concrete transport failure over a provider's generic wrapper.
  if (matchesAny(normalized, NETWORK_PATTERNS) || statuses.has(408)) {
    return presentation('network', raw)
  }

  if (matchesAny(normalized, SERVICE_FAILURE_PATTERNS)
    || statuses.has(409)
    || [...statuses].some((status) => status >= 500)) {
    return presentation('service-failure', raw)
  }

  if (matchesAny(normalized, INVALID_REQUEST_PATTERNS)
    || [400, 405, 415, 422].some((status) => statuses.has(status))) {
    return presentation('invalid-request', raw)
  }

  // In particular, an otherwise bare 404 has no reliable model-level meaning.
  return presentation('unknown', raw)
}
