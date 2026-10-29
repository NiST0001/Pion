// SPDX-License-Identifier: MIT
import { closeSync, constants, fsyncSync, openSync } from 'node:fs'
import { lazyStream, type Api, type AssistantMessageEvent, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai'
import type { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { COMPUTER_USE_OBSERVE_TOOL, type ComputerUseAgentResponse } from '../../shared/computer-use-agent'

export const COMPUTER_USE_TAINT_ENTRY = 'pion.computer-use.retained.v1'
// Pinned SDK 1.4.0 image-resize-core defaults: 2000/edge and strictly <4.5 MiB base64.
export const COMPUTER_USE_MODEL_MAX_EDGE = 2000
export const COMPUTER_USE_MODEL_MAX_BASE64 = 4.5 * 1024 * 1024
export const COMPUTER_USE_UNWATCH_TIMEOUT_MS = 5_000
const STREAM_METHODS = new Set(['stream', 'streamSimple', 'streamDeferred'])
const OTHER_REQUESTS = new Set(['fetchDeferred', 'cancelDeferred', 'generateImages', 'classify'])
const PROVIDER_REQUESTS = new Set(['stream', 'streamSimple', 'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify'])

type ChatModel = Model<Api>
interface Permit { scopeRevision: number }
export interface ComputerUseModelGateOptions {
  runtimeId: string
  sessionManager: SessionManager
  settingsManager: Pick<SettingsManager, 'getBlockImages' | 'getTransport'>
  authorize: (model: ChatModel, signal: AbortSignal) => Promise<Permit>
  /** Local identity check of this channel's actual successful Main response;
   * correlation fields alone are not source authentication. */
  assertObservation: (model: ChatModel, response: ComputerUseAgentResponse) => void
  /** A bounded Main-private long poll. Exposes the actual sent request ID so
   * local input cancellation can be followed by a real correlated unwatch. */
  watch: (model: ChatModel, signal: AbortSignal) => { watchRequestId: string; result: Promise<Permit>; isAcknowledged?: () => boolean }
  /** Must resolve only after a matching Main ACK. Never use the request's
   * already-aborted signal to cancel this independent cleanup operation. */
  unwatch: (model: ChatModel, watchRequestId: string) => Promise<void>
  isCurrent: () => boolean
}

function denied(): Error { return new Error('ComputerUse model egress denied; screenshot history remains retained. No model fallback was started.') }
function unprovenHistory(): Error { return new Error('ComputerUse model egress denied: screenshot provenance is not proven by this live runtime. Restore/fork/import reapproval is not supported yet; no approval was restored.') }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Scan the entire SDK tree, not only the selected/compacted branch. Taint is
 * sticky, including text summaries derived from screenshots. Unknown provenance
 * (resume/fork/import or an image result without its marker) never grants egress. */
export function computerUseHistoryState(manager: Pick<SessionManager, 'getEntries' | 'getHeader'>, runtimeId: string): 'clean' | 'current' | 'unknown' {
  try {
    let marked = false
    let evidence = false
    let branchSummary = false
    for (const entry of manager.getEntries()) {
      if (entry.type === 'branch_summary') branchSummary = true
      if (entry.type === 'custom' && entry.customType === COMPUTER_USE_TAINT_ENTRY) {
        const data = record(entry.data)
        if (!data || (data.version !== 1 && data.version !== 2) || data.retention !== 'sdk-session' || data.runtimeId !== runtimeId
          || !Number.isSafeInteger(data.scopeRevision) || (data.scopeRevision as number) < 0) return 'unknown'
        const keys = ['version', 'retention', 'runtimeId', 'scopeRevision']
        if (data.version === 2) {
          if (typeof data.provider !== 'string' || !data.provider || typeof data.modelId !== 'string' || !data.modelId
            || typeof data.observationRequestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(data.observationRequestId)) return 'unknown'
          keys.push('provider', 'modelId', 'observationRequestId')
        }
        if (Object.keys(data).some(key => !keys.includes(key))) return 'unknown'
        marked = true
      }
      if (entry.type !== 'message') continue
      const message = entry.message
      if (message.role === 'toolResult' && message.toolName === COMPUTER_USE_OBSERVE_TOOL && message.content.some(part => part.type === 'image')) evidence = true
    }
    // SDK clones copy the complete ancestor path, including our marker, NOT
    // only the compacted context. A cross-branch summary may derive from an
    // abandoned path whose marker was not an ancestor; its cloned provenance
    // is unknown. Ordinary untainted clones must keep working. Do not follow
    // arbitrary parent paths supplied in imported headers.
    if (manager.getHeader()?.parentSession && branchSummary && !marked) return 'unknown'
    return marked ? 'current' : evidence ? 'unknown' : 'clean'
  } catch { return 'unknown' }
}

/** A facade of the actual runtime, installed BEFORE creating AgentSession and
 * its ModelRegistry/cache warmer. No credentials/catalog refresh occurs here.
 * Only audited built-in Codex SSE can carry tainted history in this increment.
 * Its injected fetch is checked on EVERY underlying retry, after payload hooks.
 * WebSocket continuation/retry and unaudited APIs are rejected, never changed
 * into a different transport/provider/model. Trusted in-process extensions are
 * not an OS/network sandbox and can independently perform network I/O. */
export function createComputerUseModelGate(runtime: ModelRuntime, options: ComputerUseModelGateOptions) {
  let retainedScope: number | undefined
  const retainedObservations = new Set<string>()
  let retentionGeneration = 0
  let poisoned = false
  let retired = false
  const controllers = new Set<AbortController>()
  const providerFacades = new WeakMap<object, object>()
  const state = () => {
    const history = computerUseHistoryState(options.sessionManager, options.runtimeId)
    return retainedScope === undefined ? history : history === 'current' ? 'current' : 'unknown'
  }
  const sensitive = () => state() !== 'clean' || retainedScope !== undefined || poisoned
  const assertCurrent = () => { if (poisoned || retired || !options.isCurrent()) throw denied() }
  const assertSupported = (model: ChatModel, requestOptions?: Record<string, unknown>) => {
    assertCurrent()
    if (options.settingsManager.getBlockImages() || model?.provider !== 'openai-codex' || model.api !== 'openai-codex-responses'
      || !model.input?.includes('image') || !runtime.getPhysicalModel(model.provider, model.id)?.input.includes('image')
      || runtime.getRegisteredProviderConfig(model.provider) || runtime.getRegisteredNativeProvider(model.provider)
      || requestOptions?.fetch !== undefined
      || (requestOptions?.transport ?? options.settingsManager.getTransport()) !== 'sse') throw denied()
  }
  const assertRetained = (model: ChatModel, requestOptions?: Record<string, unknown>) => {
    assertSupported(model, requestOptions)
    if (state() !== 'current' || retainedScope === undefined) throw unprovenHistory()
  }
  const authorize = async (model: ChatModel, signal: AbortSignal, requestOptions?: Record<string, unknown>) => {
    assertRetained(model, requestOptions)
    if (signal.aborted) throw denied()
    const permit = await options.authorize(model, signal)
    assertRetained(model, requestOptions)
    // This is retained-history provenance, NOT a desktop/control lease. Main
    // may independently reapprove it for a new root run, without any capture.
    if (signal.aborted || permit.scopeRevision !== retainedScope) throw denied()
    return permit
  }
  const revoke = (controller: AbortController) => controller.abort(denied())

  // A watch owns exactly one SDK operation (auth OR stream), never a permit
  // for a future request. Its cleanup follows that operation's real promise.
  function requestWatch(model: ChatModel, controller: AbortController, signal: AbortSignal, assertPermit: (permit: Permit) => void) {
    controllers.add(controller)
    const stopWatch = new AbortController()
    const unclosedWatches = new Set<string>()
    let watching: Promise<void> | undefined
    const watch = () => {
      watching = (async () => {
        try {
          while (!stopWatch.signal.aborted && !signal.aborted) {
            const request = options.watch(model, AbortSignal.any([signal, stopWatch.signal]))
            unclosedWatches.add(request.watchRequestId)
            try {
              const permit = await request.result
              unclosedWatches.delete(request.watchRequestId)
              if (stopWatch.signal.aborted) return
              assertPermit(permit)
            } catch (error) {
              // A correlated negative Main response (e.g. busy before watcher
              // registration) also ends that poll. Local abort/timeout/error
              // does not; only those unknown IDs need explicit unwatch ACKs.
              if (request.isAcknowledged?.()) unclosedWatches.delete(request.watchRequestId)
              throw error
            }
          }
        } catch { if (!stopWatch.signal.aborted) revoke(controller) }
      })()
    }
    const finish = async () => {
      stopWatch.abort()
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = Promise.all([
        watching,
        ...[...unclosedWatches].map(async watchRequestId => {
          await options.unwatch(model, watchRequestId)
          unclosedWatches.delete(watchRequestId)
        })
      ])
      // A deadline bounds only OUR wait, never proves Main/transport cleanup.
      // Keep the controller and poison further egress on an unknown result;
      // the real cleanup promise remains observed even after this deadline.
      const closed = await Promise.race([
        cleanup.then(() => true, () => false),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), COMPUTER_USE_UNWATCH_TIMEOUT_MS) })
      ])
      clearTimeout(timer)
      if (closed && !unclosedWatches.size) controllers.delete(controller)
      else {
        poisoned = true
        for (const active of controllers) revoke(active)
      }
    }
    return { watch, finish }
  }

  function chatStream(target: object, method: string, args: unknown[]): AssistantMessageEventStream {
    const [model, context, rawOptions] = args as [ChatModel, unknown, Record<string, unknown> | undefined]
    const sourceGeneration = retentionGeneration
    const provider = model.provider
    const modelId = model.id
    const controller = new AbortController()
    const callerSignal = rawOptions?.signal
    const signal = callerSignal instanceof AbortSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
    let streamScope: number | undefined
    const approve = async (actual = model) => {
      if (sourceGeneration !== retentionGeneration || actual.provider !== provider || actual.id !== modelId) throw denied()
      const permit = await authorize(actual, signal, rawOptions)
      if (sourceGeneration !== retentionGeneration || actual.provider !== provider || actual.id !== modelId
        || (streamScope !== undefined && permit.scopeRevision !== streamScope)) throw denied()
      streamScope = permit.scopeRevision
    }
    const { watch, finish } = requestWatch(model, controller, signal, permit => {
      assertRetained(model, rawOptions)
      if (sourceGeneration !== retentionGeneration || permit.scopeRevision !== streamScope || permit.scopeRevision !== retainedScope) throw denied()
    })
    return lazyStream(model, async () => {
      let inner: AssistantMessageEventStream
      try {
        if (!sensitive()) inner = Reflect.apply(Reflect.get(target, method, target), target, args) as AssistantMessageEventStream
        else {
          if (method !== 'stream' && method !== 'streamSimple') throw denied()
          await approve()
          watch()
          const originalFetch = globalThis.fetch
          if (typeof originalFetch !== 'function') throw denied()
          const originalPayload = rawOptions?.onPayload
          const requestOptions = {
            ...rawOptions, signal,
            // Explicit SSE was required, not silently selected as a fallback.
            transport: 'sse',
            onPayload: async (payload: unknown, actual: ChatModel) => {
              const transformed = typeof originalPayload === 'function' ? await originalPayload(payload, actual) : undefined
              await approve(actual) // after SDK/extension payload transformations
              return transformed
            },
            fetch: async (...fetchArgs: Parameters<typeof globalThis.fetch>) => {
              // Codex retries fetch, NOT onPayload. Check every real retry.
              await approve()
              if (signal.aborted) throw denied()
              const init = fetchArgs[1]
              const dispatchSignal = init?.signal instanceof AbortSignal ? AbortSignal.any([signal, init.signal]) : signal
              return Reflect.apply(originalFetch, globalThis, [fetchArgs[0], { ...init, signal: dispatchSignal, redirect: 'error' }]) as Promise<Response>
            }
          }
          inner = Reflect.apply(Reflect.get(target, method, target), target, [model, context, requestOptions]) as AssistantMessageEventStream
        }
      } catch (error) { await finish(); throw error }
      return {
        async *[Symbol.asyncIterator]() {
          let terminal: AssistantMessageEvent | undefined
          try {
            for await (const event of inner) {
              if (event.type === 'done' || event.type === 'error') terminal = event
              else yield event
            }
          } finally {
            // A terminal event, iterator failure or logical abort is not result
            // settlement. Keep the real request owned before watch cleanup.
            try { await inner.result() } finally { await finish() }
          }
          if (terminal) yield terminal
        },
        result: () => inner.result()
      }
    })
  }
  async function modelAuth(target: object, args: unknown[]) {
    // Pinned SDK 1.4.0 summaries (AgentSession._getSummarizationRequestAuth)
    // and streams (ModelRuntime.prepareRequest) pass the complete model, not
    // its provider. Provider-only extension/image compatibility calls cannot
    // prove a request model: do not guess one or redirect a denied operation.
    if (!record(args[0])) throw denied()
    const [model, rawOptions] = args as [ChatModel, Record<string, unknown> | undefined]
    const sourceGeneration = retentionGeneration
    const provider = model.provider
    const modelId = model.id
    const controller = new AbortController()
    const callerSignal = rawOptions?.signal
    const signal = callerSignal instanceof AbortSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
    let authScope: number | undefined
    const assertAuth = () => {
      assertRetained(model, rawOptions)
      if (signal.aborted || sourceGeneration !== retentionGeneration || model.provider !== provider || model.id !== modelId) throw denied()
    }
    const { watch, finish } = requestWatch(model, controller, signal, permit => {
      assertAuth()
      if (permit.scopeRevision !== authScope || permit.scopeRevision !== retainedScope) throw denied()
    })
    try {
      // SDK summaries/compaction can call getAuth before streamSimple. The
      // existing bounded Main egress approval must precede OAuth refresh/FS.
      authScope = (await authorize(model, signal, rawOptions)).scopeRevision
      assertAuth()
      watch()
      assertAuth()
      // SDK getAuth races its signal, but a started OAuth refresh + credential
      // persistence deliberately ignore caller cancellation. Do not pass an
      // abortable signal and mistake that early race for actual settlement.
      // Revocation blocks delivery; this promise/watch stays owned meanwhile.
      const authArgs = [...args]
      authArgs[1] = { ...rawOptions, signal: new AbortController().signal }
      const result = await Reflect.apply(Reflect.get(target, 'getAuth', target), target, authArgs)
      assertAuth()
      return result
    } finally { await finish() }
  }

  function providerFacade(provider: unknown): unknown {
    if (!provider || typeof provider !== 'object') return provider
    const cached = providerFacades.get(provider)
    if (cached) return cached
    const facade = new Proxy(provider, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (!PROVIDER_REQUESTS.has(String(property))) return value.bind(target)
        // Do not leave getProvider()/getProviders() as derived raw-request exits.
        if (property === 'stream' || property === 'streamSimple' || property === 'fetchDeferred') {
          return (...args: unknown[]) => sensitive()
            ? lazyStream(args[0] as ChatModel, async () => { throw denied() })
            : Reflect.apply(value, target, args)
        }
        return (...args: unknown[]) => sensitive() ? Promise.reject(denied()) : Reflect.apply(value, target, args)
      }
    })
    providerFacades.set(provider, facade)
    return facade
  }
  const models = new Proxy(runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'getAuth') return (...args: unknown[]) => sensitive() ? modelAuth(target, args) : Reflect.apply(value, target, args)
      if (STREAM_METHODS.has(String(property))) return (...args: unknown[]) => chatStream(target, String(property), args)
      if (property === 'complete' || property === 'completeSimple') return (...args: unknown[]) => chatStream(target, property === 'complete' ? 'stream' : 'streamSimple', args).result()
      if (OTHER_REQUESTS.has(String(property))) return (...args: unknown[]) => sensitive() ? Promise.reject(denied()) : Reflect.apply(value, target, args)
      if (property === 'getProvider' || property === 'getRegisteredNativeProvider') return (...args: unknown[]) => providerFacade(Reflect.apply(value, target, args))
      if (property === 'getProviders') return (...args: unknown[]) => (Reflect.apply(value, target, args) as unknown[]).map(providerFacade)
      if (property === 'resolveModel') return (...args: unknown[]) => {
        // Virtual routers are executable extensions, may call other models, and
        // cannot be assumed to use only the approved physical image model.
        if (sensitive()) return Promise.reject(denied())
        return Reflect.apply(value, target, args)
      }
      return value.bind(target)
    }
  })
  const assertImageDelivery = (model: ChatModel) => {
    assertSupported(model)
    const history = state()
    if (history === 'unknown' || (retainedScope === undefined && history !== 'clean')) throw unprovenHistory()
  }
  return {
    models,
    assertImageDelivery,
    retain(model: ChatModel, observation: ComputerUseAgentResponse) {
      assertImageDelivery(model)
      options.assertObservation(model, observation)
      const { scopeRevision, requestId } = observation
      if (!observation.ok || observation.operation !== 'observe' || !observation.image
        || !Number.isSafeInteger(scopeRevision) || scopeRevision! < 0 || retainedObservations.has(requestId)) throw denied()
      const manager = options.sessionManager
      if (!manager.isPersisted() || !manager.getSessionFile()
        || !manager.getEntries().some(entry => entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'))) throw denied()
      try {
        // Every actual successful observe appends its own provenance, including
        // A-B-A scopes/models. This records taint, NEVER an upload/control grant.
        manager.appendCustomEntry(COMPUTER_USE_TAINT_ENTRY, { version: 2, retention: 'sdk-session', runtimeId: options.runtimeId,
          scopeRevision, provider: model.provider, modelId: model.id, observationRequestId: requestId })
        const fd = openSync(manager.getSessionFile()!, constants.O_RDONLY | constants.O_NOFOLLOW)
        try { fsyncSync(fd) } finally { closeSync(fd) }
        retainedObservations.add(requestId)
        retainedScope = scopeRevision
        retentionGeneration++
        // Numeric scope/model A-B-A does not revive an older in-flight source.
        for (const controller of controllers) revoke(controller)
      } catch {
        poisoned = true
        for (const controller of controllers) revoke(controller)
        throw denied()
      }
    },
    retire() {
      retired = true
      for (const controller of controllers) revoke(controller)
      // Actual stream promises remain owned by SDK until their real terminal
      // outcome. This does not prove provider-side work/billing has stopped.
    }
  }
}
export type ComputerUseModelGate = ReturnType<typeof createComputerUseModelGate>
