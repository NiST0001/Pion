import { randomUUID } from 'node:crypto'
import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  MCP_STATUS_INTERVAL_MS, MCP_STATUS_MAX_BYTES, MCP_STATUS_QUERY_DEADLINE_MS, MCP_STATUS_PROTOCOL_VERSION,
  MCP_STATUS_SDK_VERSION, MCP_STATUS_WIDGET_KEY, mcpScopeString, parseNativeMcpStatus, unavailableMcpStatus
} from '../../shared/mcp'
import type { McpObservedStatus, McpStatusNotice } from '../../shared/mcp'

type NativeHandler = Parameters<ExtensionAPI['registerCommand']>[1]['handler']
/** Shared by this RPC owner across SDK session replacements. No queue. */
export interface McpStatusReadSlot { busy: boolean }
export interface McpStatusObserverOptions {
  createContext: () => ExtensionCommandContext | undefined
  slot: McpStatusReadSlot
  /** Dependency injection for mock compatibility tests, never user configuration. */
  sdkVersion?: string
}

/** No manager, config loader, transport, prompt or tools are created by this observer. */
export function createMcpStatusObserver({ createContext, slot, sdkVersion = VERSION }: McpStatusObserverOptions): {
  wrapNative: (factory: ExtensionFactory) => ExtensionFactory
  extension: ExtensionFactory
} {
  const runtimeId = randomUUID()
  let revision = 0
  let generation = 0
  let nativeGeneration = 0
  let running = false
  let nativeActive = false
  let nativeHandler: NativeHandler | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  const halt = (): void => {
    running = false
    ++generation
    if (timer) clearInterval(timer)
    if (deadline) clearTimeout(deadline)
    timer = undefined
    deadline = undefined
    // Do not clear slot.busy: an unresolved SDK pending still owns the slot.
  }
  const commandSource = (pi: ExtensionAPI): 'native' | 'replaced' | 'inactive' => {
    const command = pi.getCommands().find((item) => item.name === 'mcp' && item.source === 'extension')
    if (!command) return 'inactive'
    return command.sourceInfo?.path === 'builtin:mcp' && command.sourceInfo.source === 'builtin'
      && command.sourceInfo.scope === 'temporary' && command.sourceInfo.origin === 'top-level' ? 'native' : 'replaced'
  }
  const publish = (ctx: ExtensionCommandContext, status: McpObservedStatus, captured: number): void => {
    if (!running || generation !== captured) return
    try {
      const cwd = ctx.cwd
      const sessionPath = ctx.sessionManager.getSessionFile()
      const nextRevision = revision + 1
      if (!Number.isSafeInteger(nextRevision) || !mcpScopeString(cwd)
        || (sessionPath !== undefined && !mcpScopeString(sessionPath))) return
      const value: McpStatusNotice = { ...status, version: MCP_STATUS_PROTOCOL_VERSION, runtimeId, revision: nextRevision,
        cwd, ...(sessionPath !== undefined ? { sessionPath } : {}) }
      const line = JSON.stringify(value)
      if (line.length > MCP_STATUS_MAX_BYTES || new TextEncoder().encode(line).length > MCP_STATUS_MAX_BYTES) return
      revision = nextRevision
      ctx.ui.setWidget(MCP_STATUS_WIDGET_KEY, [line])
    } catch { /* No raw errors or stale context callbacks are sent or logged. */ }
  }
  const tick = async (pi: ExtensionAPI): Promise<void> => {
    const captured = generation
    if (!running) return
    let ctx: ExtensionCommandContext | undefined
    try {
      ctx = createContext()
      // Never force rpc mode into a TUI/unknown context.
      if (!ctx || ctx.mode !== 'rpc') return
      const source = commandSource(pi)
      if (source !== 'native') {
        publish(ctx, { availability: source, phase: 'ready', servers: [], diagnosticsOmitted: false }, captured)
        return
      }
      if (sdkVersion !== MCP_STATUS_SDK_VERSION) {
        publish(ctx, unavailableMcpStatus('unsupported-sdk', 'native'), captured)
        return
      }
      if (!nativeActive || !nativeHandler) {
        publish(ctx, { availability: 'unavailable', phase: 'waiting', reason: 'initializing', servers: [], diagnosticsOmitted: false }, captured)
        return
      }
    } catch { return }
    const context = ctx
    if (slot.busy) {
      publish(context, timedOut ? unavailableMcpStatus('query-timeout', 'native')
        : { availability: 'native', phase: 'waiting', reason: 'query-busy', servers: [], diagnosticsOmitted: false }, captured)
      return
    }
    slot.busy = true
    timedOut = false
    let collecting = true
    let notifications = 0
    let result: McpObservedStatus | undefined
    const valid = (): boolean => collecting && running && captured === generation && nativeActive
    deadline = setTimeout(() => {
      if (!valid()) return
      timedOut = true
      collecting = false
      publish(context, unavailableMcpStatus('query-timeout', 'native'), captured)
    }, MCP_STATUS_QUERY_DEADLINE_MS)
    try {
      // Audited builtin:mcp only reads mode, awaits pending, then notifies once.
      await nativeHandler!('', { mode: context.mode, ui: { notify: (text, level) => {
        if (valid() && ++notifications === 1 && level === 'info') result = parseNativeMcpStatus(text)
      } } } as ExtensionCommandContext)
      if (!valid()) return
      if (commandSource(pi) !== 'native') {
        publish(context, unavailableMcpStatus('query-failed'), captured)
        return
      }
      publish(context, notifications === 1 && result ? result : unavailableMcpStatus('unsupported-format', 'native'), captured)
    } catch {
      if (valid()) publish(context, unavailableMcpStatus('query-failed', 'native'), captured)
    } finally {
      collecting = false
      // A new generation may already have a different timer; clear this read's
      // deadline only while it still belongs to the captured generation.
      if (generation === captured && deadline) { clearTimeout(deadline); deadline = undefined }
      slot.busy = false
    }
  }
  return {
    wrapNative: (factory) => (pi) => {
      const on = ((event: string, handler: (...args: unknown[]) => unknown) => {
        if (event === 'session_start') return pi.on('session_start', async (event, ctx) => {
          const captured = ++nativeGeneration
          halt()
          nativeActive = false
          await handler(event, ctx)
          if (captured === nativeGeneration) nativeActive = true
        })
        if (event === 'session_shutdown') return pi.on('session_shutdown', async (event, ctx) => {
          // Invalidate before native close(), which can itself remain pending.
          ++nativeGeneration
          nativeActive = false
          halt()
          await handler(event, ctx)
        })
        return Reflect.apply(pi.on, pi, [event, handler]) as () => void
      }) as ExtensionAPI['on']
      const facade = new Proxy(Object.create(null) as ExtensionAPI, {
        get: (_target, property) => {
          if (property === 'on') return on
          if (property === 'registerCommand') return ((name, options) => {
            if (name === 'mcp') nativeHandler = options.handler
            pi.registerCommand(name, options)
          }) as ExtensionAPI['registerCommand']
          const value: unknown = Reflect.get(pi, property, pi)
          return typeof value === 'function' ? value.bind(pi) : value
        }
      })
      return factory(facade)
    },
    extension: (pi) => {
      pi.on('session_start', () => {
        halt()
        running = true
        timedOut = false
        // Host startup is not held by existing MCP handshake/auth waits.
        void tick(pi)
        timer = setInterval(() => { void tick(pi) }, MCP_STATUS_INTERVAL_MS)
        timer.unref?.()
      })
      pi.on('session_shutdown', () => { ++nativeGeneration; nativeActive = false; halt() })
    }
  }
}
