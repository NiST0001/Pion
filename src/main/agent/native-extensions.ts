import {
  createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  type ExtensionAPI, type ExtensionFactory, type ExtensionToolContext, type ToolDefinition,
  type ToolResultEvent, type ToolResultEventResult,
  type InlineExtension, type ResourceLoader, type SettingsManager
} from '@earendil-works/pi-coding-agent'
import { collectToolImages } from '../../shared/tool-images'
import type { createMcpStatusObserver } from './mcp-status-observer'

export const NATIVE_SCRIPT_MAX_MODEL_CALLS = 8
export const NATIVE_SCRIPT_DEADLINE_MS = 5 * 60 * 1000
const MAX_RESULT_TEXT = 64 * 1024
const MODEL_CALL_METHODS = new Set(['classify', 'generateImages', 'complete', 'stream', 'streamSimple'])
const MCP_RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])

/** Projection only: arbitrary base64 embedded in text/store/arguments is not detected. */
function safeNativeResult(event: Pick<ToolResultEvent, 'content' | 'details'>): ToolResultEventResult {
  try {
    return projectNativeResult(event)
  } catch {
    // An invalid extension payload must not throw from tool_result: the SDK would fail open.
    return { content: [{ type: 'text', text: '原生工具输出无法安全预览，已省略。' }], details: {} }
  }
}

function projectNativeResult(event: Pick<ToolResultEvent, 'content' | 'details'>): ToolResultEventResult {
  const { images, notice } = collectToolImages(event.content)
  const accepted = new Map(images.map((image) => [image.partIndex, image]))
  const content: NonNullable<ToolResultEventResult['content']> = []
  let remaining = MAX_RESULT_TEXT
  let shortened = event.content.length > 128
  for (let index = 0; index < Math.min(event.content.length, 128); index++) {
    const part = event.content[index]
    if (part.type === 'text') {
      const text = part.text.slice(0, remaining)
      shortened ||= text.length !== part.text.length
      remaining -= text.length
      if (text) content.push({ type: 'text', text })
    } else if (part.type === 'image') {
      const image = accepted.get(index)
      if (image) content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    }
  }
  if (notice || shortened) content.push({ type: 'text', text: '部分输出因安全预览或长度限制已省略；原生脚本图片的 OS 临时原图路径可能在输出文字中。' })
  const details: { summary?: string; calls?: Record<string, string | number>[] } = {}
  if (event.details && typeof event.details === 'object') {
    const source = event.details as Record<string, unknown>
    if (typeof source.summary === 'string') details.summary = source.summary.slice(0, 4096)
    if (Array.isArray(source.calls)) details.calls = source.calls.slice(0, 128).map((call: unknown) => {
      const projected: Record<string, string | number> = {}
      if (!call || typeof call !== 'object') return projected
      const row = call as Record<string, unknown>
      for (const key of ['id', 'name', 'status', 'error']) {
        if (typeof row[key] === 'string') projected[key] = row[key].slice(0, key === 'error' ? 2048 : 256)
      }
      for (const key of ['durationMs', 'cost']) {
        if (typeof row[key] === 'number' && Number.isFinite(row[key])) projected[key] = row[key]
      }
      return projected
    })
  }
  // Replacing content publicly drops structuredContent; never forward an unbounded second copy.
  // isError and usage remain authoritative SDK fields, not recomputed or reported a second time.
  return { content, details }
}

/** A fresh registry facade per invocation: preserve private-field method receivers. */
function scopedModelRegistry(registry: ExtensionToolContext['modelRegistry'], signal: AbortSignal) {
  let calls = 0
  return new Proxy(registry, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (!MODEL_CALL_METHODS.has(String(property))) return value.bind(target)
      return (model: unknown, context: unknown, options?: Record<string, unknown>) => {
        if (signal.aborted) throw new Error('Native script cancelled; no new model request started')
        if (calls >= NATIVE_SCRIPT_MAX_MODEL_CALLS) throw new Error('Native script model-call budget exhausted (8 calls)')
        const optionSignal = options?.signal
        const combined = optionSignal instanceof AbortSignal ? AbortSignal.any([signal, optionSignal]) : signal
        if (combined.aborted) throw new Error('Native script model request cancelled before dispatch')
        calls++
        // No retry/fallback, no runtime mutation, and no separate usage reporting.
        return value.call(target, model, context, { ...options, signal: combined })
      }
    }
  })
}

function boundedCodemode(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    async execute(id, params, parentSignal, onUpdate, ctx) {
      const controller = new AbortController()
      const abort = () => controller.abort(parentSignal?.reason ?? new Error('Native script cancelled'))
      parentSignal?.addEventListener('abort', abort, { once: true })
      if (parentSignal?.aborted) abort()
      const timer = setTimeout(() => controller.abort(new Error('Native script reached the five-minute host deadline')), NATIVE_SCRIPT_DEADLINE_MS)
      const signal = controller.signal
      let stopWaiting: (() => void) | undefined
      try {
        if (signal.aborted) throw signal.reason
        const scopedContext = new Proxy(ctx, {
          get(target, property) {
            if (property === 'modelRegistry') return registry
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
        const registry = scopedModelRegistry(ctx.modelRegistry, signal)
        const stopped = new Promise<never>((_resolve, reject) => {
          stopWaiting = () => reject(signal.reason)
          signal.addEventListener('abort', stopWaiting, { once: true })
        })
        const execution = definition.execute(id, params, signal, onUpdate ? (update) => {
          if (!signal.aborted) onUpdate({ ...update, ...safeNativeResult(update) })
        } : undefined, scopedContext)
        // This bounds waiting, not proof of provider cancellation or process exit. A request
        // already dispatched may still consume quota; the SDK owns its usage aggregation.
        const result = await Promise.race([execution, stopped])
        return { ...result, ...safeNativeResult(result), structuredContent: undefined }
      } finally {
        clearTimeout(timer)
        parentSignal?.removeEventListener('abort', abort)
        if (stopWaiting) signal.removeEventListener('abort', stopWaiting)
        controller.abort(new Error('Native script invocation finished'))
      }
    }
  }
}

function guardedNativeFactory(factory: ExtensionFactory, toolName: 'codemode' | 'mcp'): ExtensionFactory {
  return (pi) => {
    pi.on('tool_result', (event) => {
      if (toolName === 'codemode' ? event.toolName !== 'codemode'
        : !event.toolName.startsWith('mcp__') && !MCP_RESOURCE_TOOLS.has(event.toolName)) return
      return safeNativeResult(event)
    })
    const intercepted = new Proxy(pi, {
      get(target, property) {
        if (property === 'registerTool' && toolName === 'codemode') {
          return ((tool: ToolDefinition) => target.registerTool(tool.name === 'codemode' ? boundedCodemode(tool) : tool)) as ExtensionAPI['registerTool']
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    return factory(intercepted)
  }
}

/** Public SDK exports no tool-pattern matcher. Support exact, * and ? only; reject
 * other glob syntax rather than guessing its meaning in an execution boundary. */
function loadoutPattern(pattern: string): RegExp | undefined {
  if (!pattern || /[^a-zA-Z0-9_.*?\-]/.test(pattern)) return undefined
  return new RegExp(`^${pattern.split('').map((char) => char === '*' ? '.*' : char === '?' ? '.' : char === '.' ? '\\.' : char).join('')}$`)
}

/** Initialize before MCP's session_start, and filter declarations after it.
 * This is an execution ceiling, not a sandbox or replacement for permission/plan guards.
 * Pass the raw effective settings BEFORE supplying Pion's ephemeral native defaults.
 * SDK getDefaultTools() resolves modifiers away, including negative wildcard entries.
 */
export function createPionNativeLoadoutBoundary(entries: readonly string[] | undefined): {
  capture: ExtensionFactory; declarations: ExtensionFactory; initialize: (tools: readonly string[]) => void
} {
  const explicit = entries !== undefined
  const empty = entries?.length === 0
  // SDK resolves all plain entries first, then applies modifiers in list order.
  const ordered = entries ? [
    ...entries.filter((entry) => !entry.startsWith('+') && !entry.startsWith('-')),
    ...entries.filter((entry) => entry.startsWith('+') || entry.startsWith('-'))
  ] : []
  const expressions = ordered.map((entry) => {
    const remove = entry.startsWith('-')
    const pattern = entry.startsWith('+') || remove ? entry.slice(1) : entry
    return { remove, pattern, match: loadoutPattern(pattern) }
  })
  const unsupported = expressions.some(({ match }) => !match)
  let initial: Set<string> | undefined
  const allowed = (name: string): boolean => {
    if (!explicit) return true
    if (!initial || empty || unsupported) return false
    // +only is NOT a whitelist: retain the SDK's resolved initial coding/default set.
    // Only explicit mcp__ patterns may grant late MCP tools; SDK's special MCP
    // retention rule must not turn a user's subset into unlimited MCP execution.
    let permit = initial.has(name)
    for (const expression of expressions) {
      if (!expression.match?.test(name)) continue
      if (expression.remove) permit = false
      else if (initial.has(name) || (name.startsWith('mcp__') && expression.pattern.startsWith('mcp__'))) permit = true
    }
    return permit
  }
  const filter = (pi: ExtensionAPI) => {
    if (!explicit) return
    const active = pi.getActiveTools()
    const retained = active.filter(allowed)
    if (retained.length !== active.length) pi.setActiveTools(retained)
    // Never add tools: tree navigation, temporary hides and plan mode retain their
    // own active selection. Dynamic registration may add only tools within ceiling.
  }
  return {
    // runtime-host invokes this before RPC binds extensions. Inline extensions
    // are loaded after builtins by SDK regardless of extensionFactories order.
    initialize: (tools) => { initial ??= new Set(tools) },
    capture: (pi) => {
      // Never capture here: SDK runs builtin MCP handlers before inline ones.
      // An explicit boundary not initialized by the host must remain fail-closed.
      pi.on('session_start', () => filter(pi))
      pi.on('tool_call', (event) => {
        if (allowed(event.toolName)) return
        return { block: true, reason: unsupported
          ? 'Unsupported defaultTools pattern; native loadout fails closed (exact, * and ? only).'
          : `Tool ${event.toolName} is outside the initial Pion defaultTools loadout.` }
      })
    },
    declarations: (pi) => {
      pi.on('session_start', () => filter(pi))
      pi.on('session_tree', () => filter(pi))
      pi.on('before_agent_start', (event) => {
        filter(pi)
        if (explicit) {
          const active = new Set(pi.getActiveTools())
          event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter((name) => allowed(name) && active.has(name))
        }
      })
    }
  }
}

/** Match CLI builtin identity/replacement rules; never share session-scoped MCP state. */
export function createPionNativeExtensions(observer?: Pick<ReturnType<typeof createMcpStatusObserver>, 'wrapNative'>): InlineExtension[] {
  const mcp = createMcpExtension()
  return [
    { name: 'codemode', builtin: true, replaceable: true, factory: guardedNativeFactory(createCodemodeExtension({ models: true }), 'codemode') },
    { name: 'tool-search', builtin: true, replaceable: true, factory: createToolSearchExtension() },
    { name: 'mcp', builtin: true, replaceable: true, factory: guardedNativeFactory(observer ? observer.wrapNative(mcp) : mcp, 'mcp') }
  ]
}

/** Only supply host defaults when the user has not selected a tool loadout at all.
 * applyOverrides is ephemeral; never persist settings or revive disabled/replaced builtins.
 * Loading registers MCP lifecycle hooks only. RPC binds them and SDK replacement shuts them down.
 */
export function applyPionNativeToolDefaults(
  settingsManager: Pick<SettingsManager, 'getDefaultTools' | 'applyOverrides'>,
  resourceLoader: Pick<ResourceLoader, 'getExtensions'>
): void {
  if (settingsManager.getDefaultTools() !== undefined) return
  const available = new Set<string>()
  for (const extension of resourceLoader.getExtensions().extensions) {
    if (extension.path !== 'builtin:codemode' && extension.path !== 'builtin:tool-search') continue
    for (const { definition } of extension.tools.values()) available.add(definition.name)
  }
  const additions = ['codemode', 'tool_search'].filter((name) => available.has(name)).map((name) => `+${name}`)
  if (additions.length) settingsManager.applyOverrides({ defaultTools: additions })
}
