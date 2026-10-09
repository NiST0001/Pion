import { randomUUID } from 'node:crypto'
import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  MCP_STATUS_INTERVAL_MS, MCP_STATUS_QUERY_DEADLINE_MS, MCP_STATUS_PROTOCOL_VERSION,
  MCP_STATUS_SDK_VERSION, MCP_STATUS_WIDGET_KEY, parseNativeMcpStatus, readMcpStatusNotice, unavailableMcpStatus
} from '../../shared/mcp'
import type { McpObservedStatus } from '../../shared/mcp'

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
  let running = false
  let nativeActive = false
  let nativeHandler: NativeHandler | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let closeCollector: (() => void) | undefined
  let timedOut = false

  const halt = (): void => {
    running = false
    ++generation
    if (timer) clearInterval(timer)
    if (deadline) clearTimeout(deadline)
    timer = undefined
    deadline = undefined
    closeCollector?.()
    closeCollector = undefined
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
      const sessionPath = ctx.sessionManager.getSessionFile()
      const value = { ...status, version: MCP_STATUS_PROTOCOL_VERSION, runtimeId, revision: revision + 1,
        cwd: ctx.cwd, ...(sessionPath !== undefined ? { sessionPath } : {}) }
      const lines = [JSON.stringify(value)]
      // Fail closed before sending, including unusual/oversized scope strings.
      if (!readMcpStatusNotice(lines)) return
      revision++
      ctx.ui.setWidget(MCP_STATUS_WIDGET_KEY, lines)
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
    let protocolViolated = false
    const refuse = (message: string): never => { protocolViolated = true; throw new Error(message) }
    let result: McpObservedStatus | undefined
    const close = (): void => { collecting = false }
    closeCollector = close
    const valid = (): boolean => collecting && running && captured === generation && nativeActive
    const assertCollector = (): void => { if (!valid()) throw new Error('MCP status observation is no longer active') }
    const immutable = {
      set: (): never => refuse('MCP status context is read-only'),
      defineProperty: (): never => refuse('MCP status context is read-only'),
      deleteProperty: (): never => refuse('MCP status context is read-only'),
      setPrototypeOf: (): never => refuse('MCP status context is read-only')
    }
    // A read-only facade backed by the genuine SDK command context. Unknown
    // methods fail closed; no waitForIdle/newSession/etc. interfaces are invented.
    const ui = new Proxy(Object.create(null) as ExtensionCommandContext['ui'], {
      ...immutable,
      get: (_target, property) => {
        assertCollector()
        if (property !== 'notify') refuse('MCP status UI is read-only')
        return (text: string, level?: string): void => {
          assertCollector()
          notifications++
          if (notifications !== 1 || level !== 'info') refuse('Unexpected MCP status notification')
          result = parseNativeMcpStatus(text)
        }
      }
    })
    const isolated = new Proxy(Object.create(null) as ExtensionCommandContext, {
      ...immutable,
      get: (_target, property) => {
        assertCollector()
        if (property === 'mode') return context.mode
        if (property === 'ui') return ui
        return refuse('MCP status context is read-only')
      }
    })
    deadline = setTimeout(() => {
      if (!valid()) return
      timedOut = true
      close()
      publish(context, unavailableMcpStatus('query-timeout', 'native'), captured)
    }, MCP_STATUS_QUERY_DEADLINE_MS)
    try {
      // Empty arguments ONLY; never a user command or unknown plugin handler.
      await nativeHandler!('', isolated)
      if (!valid()) return
      if (commandSource(pi) !== 'native') {
        publish(context, unavailableMcpStatus('query-failed'), captured)
        return
      }
      publish(context, !protocolViolated && notifications === 1 && result ? result : unavailableMcpStatus('unsupported-format', 'native'), captured)
    } catch {
      if (valid()) publish(context, unavailableMcpStatus('query-failed', 'native'), captured)
    } finally {
      close()
      if (closeCollector === close) closeCollector = undefined
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
          halt()
          nativeActive = false
          await handler(event, ctx)
          nativeActive = true
        })
        if (event === 'session_shutdown') return pi.on('session_shutdown', async (event, ctx) => {
          // Invalidate before native close(), which can itself remain pending.
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
      pi.on('session_shutdown', () => { nativeActive = false; halt() })
    }
  }
}
