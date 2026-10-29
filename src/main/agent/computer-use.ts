// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { AgentSession, ExtensionCommandContext, ExtensionToolContext, ModelRuntime, SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  COMPUTER_USE_ACT_TOOL, COMPUTER_USE_OBSERVE_TOOL, COMPUTER_USE_AGENT_SOURCE_FIELD,
  COMPUTER_USE_AGENT_TITLE_PREFIX, COMPUTER_USE_AGENT_LIMITS, parseComputerUseAgentRequest,
  validateComputerUseAgentResponse, type ComputerUseAgentOperation, type ComputerUseAgentResponse, type ComputerUseAgentRetainedEntry
} from '../../shared/computer-use-agent'
import { COMPUTER_USE_KEYS, validateComputerUseAction } from '../../shared/computer-use'
import { decodeImageBase64, inspectRasterImage } from '../../shared/tool-images'
import { assertGeneratedPngData } from './png-validation'
import { COMPUTER_USE_MODEL_MAX_BASE64, COMPUTER_USE_MODEL_MAX_EDGE, COMPUTER_USE_UNWATCH_TIMEOUT_MS, type ComputerUseModelGate } from './computer-use-model-gate'

type ChatModel = Model<Api>
export interface ComputerUseAgentChannelOptions {
  runtimeId: string
  nonce?: string
  createContext: () => ExtensionCommandContext | undefined
  isCurrent: () => boolean
}
function fail(code: string): never { throw new Error(`ComputerUse: ${code}`) }

/** Uses the real command context's RPC input dialog. Never a renderer dialog,
 * arbitrary notify/widget, invented SDK API, prompt or credential lookup. */
export function createComputerUseAgentChannel(options: ComputerUseAgentChannelOptions) {
  const observations = new WeakMap<ComputerUseAgentResponse, { provider: string; modelId: string; requestId: string; scopeRevision: number; toolCallId: string }>()
  type Fields = { toolCallId?: string; frameId?: string; action?: unknown; watchRequestId?: string; retained?: ComputerUseAgentRetainedEntry }
  const start = (operation: ComputerUseAgentOperation, model: ChatModel, fields: Fields = {}, signal?: AbortSignal) => {
    if (!options.isCurrent() || !options.nonce || signal?.aborted) fail('unavailable')
    const context = options.createContext()
    if (!context?.hasUI || context.mode !== 'rpc') fail('unavailable')
    const request = parseComputerUseAgentRequest({ version: 1, operation, runtimeId: options.runtimeId,
      runtimeNonce: options.nonce, requestId: randomUUID(), provider: model.provider, modelId: model.id, ...fields })
    let acknowledged = false
    const result = (async (): Promise<ComputerUseAgentResponse> => {
      const title = COMPUTER_USE_AGENT_TITLE_PREFIX + JSON.stringify(request)
      // SDK input abort only removes its LOCAL dialog. Unwatch is a separate
      // Main-private request, with a fresh bounded wait and no aborted signal.
      const timeout = operation === 'watch' ? COMPUTER_USE_AGENT_LIMITS.watchMs + 2_000
        : operation === 'unwatch' ? COMPUTER_USE_UNWATCH_TIMEOUT_MS : 120_000
      const raw = await context.ui.input(title, undefined, { signal, timeout })
      if (!options.isCurrent() || signal?.aborted || typeof raw !== 'string'
        || raw.length > Math.ceil(COMPUTER_USE_AGENT_LIMITS.maxImageBytes / 3) * 4 + 4096) fail('scope-revoked')
      let response: ComputerUseAgentResponse
      try { response = validateComputerUseAgentResponse(JSON.parse(raw)) } catch { return fail('protocol-error') }
      if (response.operation !== operation || response.requestId !== request.requestId) fail('protocol-error')
      acknowledged = true // a matching Main response, never local input abort
      if (!response.ok) fail(response.error ?? 'protocol-error')
      // The ACK is correlated to this unwatch's real requestId; its outgoing
      // payload already binds the exact watchRequestId. No scope/grant is made.
      if (operation !== 'unwatch' && response.scopeRevision === undefined) fail('protocol-error')
      if (operation === 'observe') observations.set(response, { provider: request.provider, modelId: request.modelId, requestId: request.requestId, scopeRevision: response.scopeRevision!, toolCallId: request.toolCallId! })
      if (response.image) Object.freeze(response.image)
      return Object.freeze(response)
    })()
    return { requestId: request.requestId, result, isAcknowledged: () => acknowledged }
  }
  return Object.assign(
    async (operation: ComputerUseAgentOperation, model: ChatModel, fields: Fields = {}, signal?: AbortSignal) => start(operation, model, fields, signal).result,
    {
      watch(model: ChatModel, signal: AbortSignal) {
        // Expose the ID of the actual outgoing private request, not a second
        // synthetic ID or a self-reported source/authentication receipt.
        const request = start('watch', model, {}, signal)
        return { watchRequestId: request.requestId, result: request.result, isAcknowledged: request.isAcknowledged }
      },
      assertObservation(model: ChatModel, response: ComputerUseAgentResponse, toolCallId?: string) {
        const actual = observations.get(response)
        if (!options.isCurrent() || !actual || actual.provider !== model.provider || actual.modelId !== model.id
          || actual.requestId !== response.requestId || actual.scopeRevision !== response.scopeRevision
          || (toolCallId !== undefined && actual.toolCallId !== toolCallId)) fail('source-unverified')
      }
    }
  )
}

const actionSchema = Type.Union([
  Type.Object({ type: Type.Literal('click'), x: Type.Integer({ minimum: 0, maximum: COMPUTER_USE_MODEL_MAX_EDGE - 1 }), y: Type.Integer({ minimum: 0, maximum: COMPUTER_USE_MODEL_MAX_EDGE - 1 }), button: Type.Literal('left') }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('key'), keys: Type.Union(COMPUTER_USE_KEYS.map(key => Type.Literal(key))) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('type'), text: Type.String({ minLength: 1, maxLength: 1024, pattern: '^[ -~]+$' }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('scroll'), x: Type.Integer({ minimum: 0, maximum: COMPUTER_USE_MODEL_MAX_EDGE - 1 }), y: Type.Integer({ minimum: 0, maximum: COMPUTER_USE_MODEL_MAX_EDGE - 1 }), deltaX: Type.Integer({ minimum: -1000, maximum: 1000 }), deltaY: Type.Integer({ minimum: -1000, maximum: 1000 }) }, { additionalProperties: false })
])

export interface ComputerUseToolsOptions {
  runtimeId: string
  nonce?: string
  enabled: boolean
  sessionManager: SessionManager
  getSession: () => AgentSession | undefined
  getModels: () => ModelRuntime
  channel: ReturnType<typeof createComputerUseAgentChannel>
  gate: ComputerUseModelGate
  isCurrent: () => boolean
}

/** Root SDK custom tools only. No extension factory/defaultTools mutation and
 * no additions to the subagent builtin whitelist or nested tool loadout. */
export function createComputerUseTools(options: ComputerUseToolsOptions) {
  const roots = new Map<string, string>()
  let attached: AgentSession | undefined
  const tools: ToolDefinition[] = []
  const knownFrames = new Map<string, { width: number; height: number; scopeRevision: number }>()
  const pending = new Map<string, { model: ChatModel; rootEntryId: string; proof: Omit<ComputerUseAgentRetainedEntry, 'entryId'>; appendedEntryId?: string; appendFailed?: boolean }>()
  let appendMessage: SessionManager['appendMessage'] | undefined
  const assertSession = () => {
    if (!options.enabled || !options.isCurrent() || !attached || options.getSession() !== attached
      || attached.sessionManager !== options.sessionManager || options.sessionManager.appendMessage !== appendMessage) fail('source-unverified')
  }
  const modelFor = (id: string, ctx: ExtensionToolContext): ChatModel => {
    const session = options.getSession()
    if (!options.enabled || !options.isCurrent() || session !== attached || !session || !roots.has(id)
      || (ctx as ExtensionToolContext & { parentToolCallId?: unknown }).parentToolCallId !== undefined
      || ctx.sessionManager !== options.sessionManager || ctx.cwd !== options.sessionManager.getCwd()
      || ctx.mode !== 'rpc' || !ctx.hasUI || !ctx.model) fail('source-unverified')
    if (!session.getActiveToolNames().includes(roots.get(id)!)) fail('permission-denied')
    const plan = options.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'plan-mode-state')
    if (plan?.type === 'custom' && (plan.data as { enabled?: unknown } | undefined)?.enabled === true) fail('permission-denied')
    const command = session.extensionRunner?.createCommandContext()
    if (!command || command.modelRegistry !== ctx.modelRegistry) fail('source-unverified')
    // ctx.model is the selection, not necessarily the actual routed model. Use
    // the authoritative assistant that contains THIS real tool call, then look
    // up its physical model in the existing runtime metadata (no auth/refresh).
    const assistant = session.messages.findLast(message => message.role === 'assistant'
      && message.content.some(part => part.type === 'toolCall' && part.id === id && part.name === roots.get(id)))
    if (!assistant || assistant.role !== 'assistant') fail('source-unverified')
    const models = options.getModels()
    const model = models.getPhysicalModel(assistant.provider, assistant.model)
    if (!model || !model.input.includes('image') || !models.getAvailableSnapshot().some(value => value.provider === model.provider && value.id === model.id)
      // Virtual routing can run executable routers and switch vendors on the
      // follow-up. Its request exits are not audited for image retention yet.
      || ctx.model.provider !== model.provider || ctx.model.id !== model.id) fail('model-unavailable')
    options.gate.assertImageDelivery(model)
    return model
  }
  if (options.enabled) {
    tools.push(defineTool({
      name: COMPUTER_USE_OBSERVE_TOOL, label: 'Observe desktop', exposure: 'model-only', executionMode: 'sequential',
      description: 'Observe the current user-approved desktop lease. Requires separate capture, current-model upload and SDK-session retention approval. Returns one private image and frameId. Does not select a source or grant control. Never use this to bypass denied tools, plan mode or protected targets.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(id, params, signal, _onUpdate, ctx) {
        if (!params || typeof params !== 'object' || Object.keys(params).length) fail('invalid-request')
        if (roots.get(id) !== COMPUTER_USE_OBSERVE_TOOL || signal?.aborted) fail('source-unverified')
        const model = modelFor(id, ctx)
        assertSession()
        const manager = options.sessionManager
        const sessionFile = manager.getSessionFile()
        const sessionId = manager.getSessionId()
        const root = manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant'
          && entry.message.provider === model.provider && entry.message.model === model.id
          && entry.message.content.some(part => part.type === 'toolCall' && part.id === id && part.name === COMPUTER_USE_OBSERVE_TOOL))
        if (!manager.isPersisted() || !sessionFile || !sessionId || !root || pending.has(id) || pending.size >= COMPUTER_USE_AGENT_LIMITS.maxRequests) fail('source-unverified')
        const result = await options.channel('observe', model, { toolCallId: id }, signal)
        options.channel.assertObservation(model, result, id)
        const currentModel = modelFor(id, ctx)
        if (currentModel.provider !== model.provider || currentModel.id !== model.id || signal?.aborted) fail('scope-revoked')
        const { image, frameId, width, height, scopeRevision } = result
        if (!image || !frameId || !width || !height || scopeRevision === undefined
          || width > COMPUTER_USE_MODEL_MAX_EDGE || height > COMPUTER_USE_MODEL_MAX_EDGE
          || image.data.length >= COMPUTER_USE_MODEL_MAX_BASE64) fail('protocol-error')
        const bytes = decodeImageBase64(image.data, COMPUTER_USE_AGENT_LIMITS.maxImageBytes)
        const dimensions = bytes && inspectRasterImage(bytes, 'image/png', { maxDimension: COMPUTER_USE_MODEL_MAX_EDGE, maxPixels: COMPUTER_USE_MODEL_MAX_EDGE ** 2 })
        if (!bytes || !dimensions || dimensions.width !== width || dimensions.height !== height) fail('protocol-error')
        // The real decoder is Main-owned. This independently verifies bounded
        // PNG structure/CRC/IDAT; reject orientation metadata so SDK cannot apply
        // an unrecorded coordinate transform during its normalization.
        for (let offset = 8; offset < bytes.length;) {
          const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
          const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
          if (!['IHDR', 'IDAT', 'IEND'].includes(kind)) fail('protocol-error')
          offset += length + 12
        }
        assertGeneratedPngData(bytes, dimensions)
        // No image has been returned to SDK yet. A failed append/sync/close
        // poisons this runtime and never exposes the original in details/UI.
        if (manager.getSessionFile() !== sessionFile || manager.getSessionId() !== sessionId) fail('scope-revoked')
        options.gate.retain(model, result)
        assertSession()
        if (signal?.aborted) fail('scope-revoked')
        pending.set(id, { model, rootEntryId: root.id, proof: { observationRequestId: result.requestId, sessionFile, sessionId,
          frameId, scopeRevision, width, height, imageHash: createHash('sha256').update(bytes).digest('hex'), imageBytes: bytes.byteLength } })
        knownFrames.clear()
        knownFrames.set(frameId, { width, height, scopeRevision })
        return { content: [
          { type: 'text', text: `ComputerUse frame ${frameId}; ${width}x${height}. Coordinates are pixels in this exact image. One action consumes the frame. Screenshot retained in the approved SDK session; closing capture does not delete it.` },
          { type: 'image', mimeType: 'image/png', data: image.data }
        ], details: { version: 1, frameId, width, height, scopeRevision, retention: 'sdk-session' } }
      }
    }), defineTool({
      name: COMPUTER_USE_ACT_TOOL, label: 'Act on desktop', exposure: 'model-only', executionMode: 'sequential',
      description: 'Perform exactly one bounded action using a fresh observe frameId and image-pixel coordinates. Separate control approval plus verified protected-target and physical-takeover safeguards are required. Fails closed when target/focus cannot be verified. No arbitrary code, clipboard, raw key-down/up, Unicode typing or automatic retry.',
      parameters: Type.Object({ frameId: Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_.:-]+$' }), action: actionSchema }, { additionalProperties: false }),
      async execute(id, params, signal, _onUpdate, ctx) {
        if (!params || typeof params !== 'object' || Object.keys(params).some(key => key !== 'frameId' && key !== 'action')
          || typeof params.frameId !== 'string') fail('invalid-request')
        if (roots.get(id) !== COMPUTER_USE_ACT_TOOL || signal?.aborted) fail('source-unverified')
        const model = modelFor(id, ctx)
        const frame = knownFrames.get(params.frameId)
        if (!frame) fail('frame-stale')
        const action = validateComputerUseAction(params.action, { id: params.frameId, ...frame, createdAt: 0, captureScope: 'display', actualScope: 'display' })
        if (action.type === 'type' && (!/^[ -~]+$/.test(action.text) || action.text.length > 1024)) fail('invalid-request')
        knownFrames.delete(params.frameId) // A dispatched/failed/unknown action is never replayed.
        const result = await options.channel('act', model, { toolCallId: id, frameId: params.frameId, action }, signal)
        modelFor(id, ctx)
        if (signal?.aborted || result.scopeRevision !== frame.scopeRevision) fail('scope-revoked')
        return { content: [{ type: 'text', text: 'ComputerUse action protocol completed. This is not proof that the target application achieved the requested outcome; observe before another action.' }], details: { version: 1, frameId: params.frameId, scopeRevision: frame.scopeRevision } }
      }
    }))
  }
  return {
    tools,
    /** Pinned SDK emits message_end BEFORE appendMessage and does not emit an
     * entry_appended for ordinary tool results. Flush only actual completed
     * appends from this factory, before Main authorizes a physical request. */
    async authorizeEgress(model: ChatModel, signal: AbortSignal) {
      assertSession()
      const manager = options.sessionManager
      const sessionFile = manager.getSessionFile()
      const sessionId = manager.getSessionId()
      if (!manager.isPersisted() || !sessionFile || !sessionId) fail('egress-revoked')
      for (const [toolCallId, observation] of pending) {
        if (signal.aborted || observation.appendFailed || !observation.appendedEntryId
          || observation.model.provider !== model.provider || observation.model.id !== model.id
          || !manager.isPersisted() || manager.getSessionFile() !== observation.proof.sessionFile || manager.getSessionId() !== observation.proof.sessionId) fail('egress-revoked')
        const entries = manager.getEntries()
        const branch = manager.getBranch()
        const matches = entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === toolCallId)
        const entry = matches.length === 1 ? matches[0] : undefined
        const root = entries.find(value => value.id === observation.rootEntryId)
        const rootIndex = root ? branch.indexOf(root) : -1
        if (!entry || entry.type !== 'message' || entry.id !== observation.appendedEntryId || rootIndex < 0 || branch.indexOf(entry) <= rootIndex
          || root?.type !== 'message' || root.message.role !== 'assistant' || root.message.provider !== model.provider || root.message.model !== model.id
          || !root.message.content.some(part => part.type === 'toolCall' && part.id === toolCallId && part.name === COMPUTER_USE_OBSERVE_TOOL)) fail('egress-revoked')
        const message = entry.message
        if (message.role !== 'toolResult' || message.toolName !== COMPUTER_USE_OBSERVE_TOOL || message.isError !== false
          || !Array.isArray(message.content) || message.content.length > 8) fail('egress-revoked')
        const details = message.details as Record<string, unknown> | undefined
        const proof = observation.proof
        if (!details || details.version !== 1 || details.frameId !== proof.frameId || details.scopeRevision !== proof.scopeRevision
          || details.width !== proof.width || details.height !== proof.height || details.retention !== 'sdk-session') fail('egress-revoked')
        const images = message.content.filter(part => part.type === 'image')
        const image = images.length === 1 ? images[0] : undefined
        const bytes = image?.mimeType === 'image/png' && image.data.length < COMPUTER_USE_MODEL_MAX_BASE64
          ? decodeImageBase64(image.data, COMPUTER_USE_AGENT_LIMITS.maxModelImageBytes) : undefined
        if (!bytes || bytes.byteLength !== proof.imageBytes || createHash('sha256').update(bytes).digest('hex') !== proof.imageHash) fail('egress-revoked')
        const confirmed = await options.channel('retained', observation.model, { toolCallId, retained: { ...proof, entryId: entry.id } }, signal)
        assertSession()
        if (signal.aborted || pending.get(toolCallId) !== observation || manager.getSessionFile() !== proof.sessionFile
          || manager.getSessionId() !== proof.sessionId || !manager.getEntries().includes(entry) || !manager.getBranch().includes(entry)
          || confirmed.scopeRevision !== proof.scopeRevision) fail('egress-revoked')
        pending.delete(toolCallId)
      }
      const result = await options.channel('egress', model, {}, signal)
      assertSession()
      if (signal.aborted || manager.getSessionFile() !== sessionFile || manager.getSessionId() !== sessionId) fail('egress-revoked')
      return { scopeRevision: result.scopeRevision! }
    },
    attach(session: AgentSession) {
      attached = session
      const dispose = session.dispose?.bind(session)
      let unbind = () => {}
      const manager = options.sessionManager
      const originalAppend = manager.appendMessage
      if (dispose) session.dispose = () => {
        options.gate.retire(); roots.clear(); knownFrames.clear(); pending.clear(); unbind()
        if (manager.appendMessage === appendMessage) manager.appendMessage = originalAppend
        dispose()
      }
      if (!options.enabled) return
      // getEntries can contain an entry even when SDK _persist throws, since
      // SDK mutates its tree first. A successful real append return is also
      // required; never promote message_end or an in-memory failed append.
      appendMessage = manager.appendMessage = message => {
        const observation = message.role === 'toolResult' ? pending.get(message.toolCallId) : undefined
        try {
          const id = originalAppend.call(manager, message)
          if (observation) {
            if (observation.appendedEntryId) observation.appendFailed = true
            observation.appendedEntryId = id
          }
          return id
        } catch (error) {
          if (observation) observation.appendFailed = true
          throw error
        }
      }
      const original = session.subscribe.bind(session)
      const source = (name: string) => session.getAllTools().some(tool => tool.name === name
        && tool.sourceInfo.source === 'sdk' && tool.sourceInfo.path === `<sdk:${name}>`)
      // SDK customTools win the registry after extension tools in pinned 1.4.0.
      // The real factory owns these definitions; names/arguments alone are not
      // a source receipt. Observe the actual root execution lifecycle.
      unbind = original(event => {
        if (event.type === 'tool_execution_start' && !event.parentToolCallId
          && tools.some(tool => tool.name === event.toolName) && source(event.toolName) && options.isCurrent()) roots.set(event.toolCallId, event.toolName)
        if (event.type === 'tool_execution_end') roots.delete(event.toolCallId)
      })
      session.subscribe = listener => original(event => {
        if (event.type === 'tool_execution_start' && !event.parentToolCallId && roots.get(event.toolCallId) === event.toolName && source(event.toolName)) {
          listener({ ...event, [COMPUTER_USE_AGENT_SOURCE_FIELD]: { version: 1, runtimeId: options.runtimeId, runtimeNonce: options.nonce, toolCallId: event.toolCallId } } as typeof event)
        } else listener(event)
      })
    }
  }
}
