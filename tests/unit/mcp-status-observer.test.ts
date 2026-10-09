import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { McpStatusReadSlot } from '../../src/main/agent/mcp-status-observer'
import {
  MCP_STATUS_INTERVAL_MS, MCP_STATUS_MAX_BYTES, MCP_STATUS_MAX_SERVERS, MCP_STATUS_PROTOCOL_VERSION,
  MCP_STATUS_QUERY_DEADLINE_MS, MCP_STATUS_SDK_VERSION, MCP_STATUS_WIDGET_KEY, readMcpStatusNotice
} from '../../src/shared/mcp'
import type { McpStatusNotice } from '../../src/shared/mcp'

// Keep SDK module replacement and fake clocks local to this suite, including
// when registered in the single-isolate coverage aggregator.
describe('MCP observer isolated suites', () => {
// Import only this observer against a VERSION-only module. Never importOriginal:
// the real SDK entry can load provider modules, and no real MCP lifecycle,
// configuration, credentials, transport, model or session is part of this suite.
// A scoped doMock also avoids a hoisted SDK replacement affecting other suites.
let createObserver: typeof import('../../src/main/agent/mcp-status-observer')['createMcpStatusObserver']
beforeAll(async () => {
  vi.resetModules()
  vi.doMock('@earendil-works/pi-coding-agent', () => ({ VERSION: '1.0.4' }))
  try {
    const module = await import('../../src/main/agent/mcp-status-observer')
    createObserver = module.createMcpStatusObserver
  } finally {
    vi.doUnmock('@earendil-works/pi-coding-agent')
    vi.resetModules()
  }
})

type NativeHandler = Parameters<ExtensionAPI['registerCommand']>[1]['handler']
type CommandInfo = ReturnType<ExtensionAPI['getCommands']>[number]
type Hook = (event: unknown, ctx: ExtensionCommandContext) => unknown
const cwd = '/fixture/worktree'
const firstSessionPath = '/fixture/sessions/first.jsonl'
const statusText = 'alpha: connected, 7 tools (hidden)'
const ready = { availability: 'native', phase: 'ready', diagnosticsOmitted: false,
  servers: [{ name: 'alpha', state: 'connected', exposure: 'hidden', toolCount: 7 }] }
const cleanups: Array<() => void> = []

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await flush()
  try {
    // Shutdown must actually remove the Node interval and collector deadline;
    // clearAllTimers is a safety net, not a substitute for this assertion.
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}
function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function nativeCommand(overrides: Partial<CommandInfo> = {}): CommandInfo {
  return { name: 'mcp', description: 'Mock native MCP', source: 'extension', sourceInfo: {
    path: 'builtin:mcp', source: 'builtin', scope: 'temporary', origin: 'top-level'
  }, ...overrides } as CommandInfo
}
function replacementCommand(): CommandInfo {
  return nativeCommand({ sourceInfo: { path: '/fixture/legacy-mcp.ts', source: 'local',
    scope: 'user', origin: 'top-level' } as CommandInfo['sourceInfo'] })
}

/** Our own factory, not SDK createMcpExtension (including its real hooks). */
function mockExtensionFactory(handler: NativeHandler, start: () => void | Promise<void>, shutdown: () => void | Promise<void>): ExtensionFactory {
  return (pi) => {
    pi.registerCommand('mcp', { description: 'Mock MCP status only', handler })
    pi.on('session_start', start)
    pi.on('session_shutdown', shutdown)
  }
}

function setup(options: {
  handler?: NativeHandler
  nativeRegistered?: boolean
  start?: () => void | Promise<void>
  close?: () => void | Promise<void>
  commands?: CommandInfo[]
  mode?: string
  cwd?: string
  sessionPath?: string
  sdkVersion?: string
  slot?: McpStatusReadSlot
} = {}) {
  const slot = options.slot ?? { busy: false } // RPC-owner-local, never a suite singleton.
  let currentSessionPath = options.sessionPath ?? firstSessionPath
  const nativeStart = vi.fn(options.start ?? (() => {}))
  const nativeClose = vi.fn(options.close ?? (() => {}))
  const nativeHandler = vi.fn<NativeHandler>(options.handler ?? (async (_args, ctx) => { ctx.ui.notify(statusText, 'info') }))
  const unknownPlugin = vi.fn<NativeHandler>(async () => { throw new Error('Unknown plugin must not be queried') })
  const factory = vi.fn(mockExtensionFactory(nativeHandler, nativeStart, nativeClose))
  const notify = vi.fn((_message: string, _level?: string) => {})
  const setWidget = vi.fn((_key: string, _lines: string[] | undefined) => {})
  const select = vi.fn()
  const getSessionFile = vi.fn((): string | undefined => currentSessionPath)
  const newSession = vi.fn()
  const waitForIdle = vi.fn()

  // Side effects are counted at dispatch, not inferred from a fabricated usage
  // result. These SDK-owned actors are reached only through the genuine public
  // API/context property names; observer polling must never reach them.
  const sdkState = { liveRevision: 0, tools: ['read', 'bash'], usage: { totalTokens: 0, cost: 0 } }
  const appendEntry = vi.fn(() => { sdkState.liveRevision++ })
  const fees = { calls: 0, charged: 0 }
  const dispatchModel = () => { fees.calls++; fees.charged++; return {} }
  const modelActor = { complete: vi.fn(dispatchModel), classify: vi.fn(dispatchModel), generateImages: vi.fn(dispatchModel) }
  const readModelRegistry = vi.fn(() => modelActor)
  const sendMessage = vi.fn(() => { sdkState.liveRevision++ })
  const sendUserMessage = vi.fn(() => { sdkState.liveRevision++ })
  const exec = vi.fn()
  const setModel = vi.fn()
  const setActiveTools = vi.fn((tools: string[]) => { sdkState.tools = [...tools] })
  const registerTool = vi.fn()

  // Only exercised SDK command-context fields and real side-effect methods.
  // This is a partial fixture cast at the boundary, not an invented SDK interface.
  const originalMode = Object.hasOwn(options, 'mode') ? options.mode : 'rpc'
  const readMode = vi.fn(() => originalMode)
  const writeMode = vi.fn()
  const ui = Object.freeze({ notify, setWidget, select })
  const rawContext = { cwd: options.cwd ?? cwd, ui, sessionManager: { getSessionFile }, newSession, waitForIdle }
  Object.defineProperty(rawContext, 'mode', { enumerable: true, get: readMode, set: writeMode })
  Object.defineProperty(rawContext, 'modelRegistry', { get: readModelRegistry })
  const context = rawContext as unknown as ExtensionCommandContext
  const createContext = vi.fn((): ExtensionCommandContext | undefined => context)
  const hooks = new Map<string, Hook[]>()
  const commands = new Map<string, NativeHandler>()
  const on = vi.fn((name: string, handler: Hook) => {
    const registered = hooks.get(name) ?? []
    registered.push(handler)
    hooks.set(name, registered)
  })
  const registerCommand = vi.fn((name: string, definition: { handler: NativeHandler }) => { commands.set(name, definition.handler) })
  const getCommands = vi.fn(() => options.commands ?? [nativeCommand()])
  const pi = { on, registerCommand, getCommands, appendEntry, sendMessage, sendUserMessage, exec, setModel, setActiveTools, registerTool }
  const api = pi as unknown as ExtensionAPI
  const observer = createObserver({ createContext, slot, ...(options.sdkVersion !== undefined ? { sdkVersion: options.sdkVersion } : {}) })
  if (options.nativeRegistered !== false) observer.wrapNative(factory)(api)
  const nativeStartHook = hooks.get('session_start')?.[0]
  const nativeShutdownHook = hooks.get('session_shutdown')?.[0]
  observer.extension(api)
  const observerStart = hooks.get('session_start')!.at(-1)!
  const observerShutdown = hooks.get('session_shutdown')!.at(-1)!
  const cleanup = () => { observerShutdown({ type: 'session_shutdown' }, context) }
  cleanups.push(cleanup)

  const notices = (): McpStatusNotice[] => setWidget.mock.calls.map(([key, lines]) => {
    expect(key).toBe(MCP_STATUS_WIDGET_KEY)
    const notice = readMcpStatusNotice(lines)
    expect(notice).toBeDefined()
    return notice!
  })
  const latest = (): McpStatusNotice => {
    const notice = notices().at(-1)
    expect(notice).toBeDefined()
    return notice!
  }
  const startNative = () => Promise.resolve(nativeStartHook?.({ type: 'session_start', reason: 'startup' }, context))
  const startObserver = () => { observerStart({ type: 'session_start', reason: 'startup' }, context) }
  const start = async () => { await startNative(); startObserver(); await flush() }
  const shutdownNative = () => Promise.resolve(nativeShutdownHook?.({ type: 'session_shutdown' }, context))
  const expectNoSideEffects = () => {
    for (const spy of [notify, select, newSession, waitForIdle, appendEntry, readModelRegistry,
      sendMessage, sendUserMessage, exec, setModel, setActiveTools, registerTool, ...Object.values(modelActor)]) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(fees).toEqual({ calls: 0, charged: 0 })
    expect(sdkState).toEqual({ liveRevision: 0, tools: ['read', 'bash'], usage: { totalTokens: 0, cost: 0 } })
    expect(writeMode).not.toHaveBeenCalled()
    expect(context.ui.notify).toBe(notify)
    expect(context.ui.setWidget).toBe(setWidget)
  }
  return { observer, factory, pi, context, createContext, readMode, writeMode, nativeStart, nativeClose, nativeHandler,
    unknownPlugin, commands, getCommands, getSessionFile, notify, setWidget, select, newSession, waitForIdle,
    slot, fees, sdkState, modelActor, start, startNative, startObserver, shutdownNative, cleanup, notices, latest,
    expectNoSideEffects, setSessionPath: (path: string) => { currentSessionPath = path } }
}

describe('MCP observer factory registration and lifecycle eligibility', () => {
  it('registers/scans mock factories only, without reading context, querying handlers or starting Node timers', async () => {
    const h = setup()
    const scan = setup()
    expect(h.factory).toHaveBeenCalledTimes(1)
    expect(h.pi.registerCommand).toHaveBeenCalledWith('mcp', expect.objectContaining({ handler: h.nativeHandler }))
    expect(h.pi.on.mock.calls.map(([name]) => name)).toEqual(['session_start', 'session_shutdown', 'session_start', 'session_shutdown'])
    await vi.advanceTimersByTimeAsync(30_000)
    for (const fixture of [h, scan]) {
      expect(fixture.createContext).not.toHaveBeenCalled()
      expect(fixture.readMode).not.toHaveBeenCalled()
      expect(fixture.getSessionFile).not.toHaveBeenCalled()
      expect(fixture.getCommands).not.toHaveBeenCalled()
      expect(fixture.nativeHandler).not.toHaveBeenCalled()
      expect(fixture.nativeStart).not.toHaveBeenCalled()
      expect(fixture.nativeClose).not.toHaveBeenCalled()
      expect(fixture.setWidget).not.toHaveBeenCalled()
      fixture.expectNoSideEffects()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not claim native readiness until the captured native session_start has actually settled', async () => {
    const startup = deferred()
    const h = setup({ start: () => startup.promise })
    const starting = h.startNative()
    h.startObserver()
    await flush()
    expect(h.latest()).toMatchObject({ availability: 'unavailable', phase: 'waiting', reason: 'initializing', servers: [] })
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.nativeHandler).not.toHaveBeenCalled()
    startup.resolve()
    await starting
    expect(h.nativeHandler).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject(ready)
    h.expectNoSideEffects()
  })

  it('does not execute the handler when native lifecycle was never started', async () => {
    const h = setup()
    h.startObserver()
    await flush()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.latest()).toMatchObject({ availability: 'unavailable', phase: 'waiting', reason: 'initializing', servers: [] })
    expect(h.nativeStart).not.toHaveBeenCalled()
    expect(h.nativeHandler).not.toHaveBeenCalled()
    h.expectNoSideEffects()
  })

  it('remains initializing after the mock native lifecycle rejects, without logging its raw error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup({ start: () => Promise.reject(new Error('PRIVATE_NATIVE_START')) })
    await expect(h.startNative()).rejects.toThrow('PRIVATE_NATIVE_START')
    h.startObserver()
    await flush()
    expect(h.latest()).toMatchObject({ phase: 'waiting', reason: 'initializing', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'disabled builtin', nativeRegistered: false, rows: [], availability: 'inactive' },
    { label: 'missing command despite a captured handler', nativeRegistered: true, rows: [], availability: 'inactive' },
    { label: 'replaced command', nativeRegistered: true, rows: [replacementCommand()], availability: 'replaced' }
  ])('never queries native or unknown plugins for $label', async ({ nativeRegistered, rows, availability }) => {
    const h = setup({ nativeRegistered, commands: rows })
    h.pi.registerCommand('mcp', { handler: h.unknownPlugin })
    await h.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.latest()).toMatchObject({ availability, phase: 'ready', servers: [], diagnosticsOmitted: false })
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(h.unknownPlugin).not.toHaveBeenCalled()
    h.expectNoSideEffects()
  })

  it('fails closed when metadata looks native but no native factory captured a handler', async () => {
    const h = setup({ nativeRegistered: false })
    await h.start()
    expect(h.latest()).toMatchObject({ availability: 'unavailable', phase: 'waiting', reason: 'initializing', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(h.factory).not.toHaveBeenCalled()
  })

  it.each(['1.0.3', '1.0.5', '1.1.0', 'unknown'])('does not issue a native query for unsupported SDK %s', async (sdkVersion) => {
    const h = setup({ sdkVersion })
    await h.start()
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject({ availability: 'native', phase: 'unavailable', reason: 'unsupported-sdk', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
    // getCommands checks identity only; it is not a native status/transport query.
    expect(h.getCommands).toHaveBeenCalledTimes(2)
    h.expectNoSideEffects()
  })

  it.each(['interactive', 'print', 'future-sdk-mode', undefined])('does not force RPC into an actual %s context', async (mode) => {
    const h = setup({ mode })
    await h.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.context.mode).toBe(mode)
    expect(h.writeMode).not.toHaveBeenCalled()
    expect(h.getCommands).not.toHaveBeenCalled()
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(h.setWidget).not.toHaveBeenCalled()
    h.expectNoSideEffects()
  })

  it.each(['missing', 'throwing'])('does not invent a command context when the real factory is %s', async (condition) => {
    const h = setup()
    if (condition === 'missing') h.createContext.mockReturnValue(undefined)
    else h.createContext.mockImplementation(() => { throw new Error('PRIVATE_CONTEXT_ERROR') })
    await h.start()
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.getCommands).not.toHaveBeenCalled()
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(h.setWidget).not.toHaveBeenCalled()
    h.expectNoSideEffects()
  })
})

describe('MCP command identity preflight and postflight', () => {
  it.each([
    { label: 'path', fields: { path: '/fixture/legacy.ts' } },
    { label: 'source', fields: { source: 'local' } },
    { label: 'scope', fields: { scope: 'user' } },
    { label: 'origin', fields: { origin: 'package' } }
  ])('requires builtin:mcp/builtin/temporary/top-level identity: mismatched $label', async ({ fields }) => {
    const command = nativeCommand()
    const h = setup({ commands: [nativeCommand({ sourceInfo: { ...command.sourceInfo, ...fields } as CommandInfo['sourceInfo'] })] })
    await h.start()
    expect(h.latest()).toMatchObject({ availability: 'replaced', phase: 'ready', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
  })

  it('treats missing sourceInfo as replaced and non-extension MCP rows as inactive', async () => {
    const h = setup({ commands: [nativeCommand({ sourceInfo: undefined })] })
    await h.start()
    expect(h.latest()).toMatchObject({ availability: 'replaced', phase: 'ready', servers: [] })
    h.getCommands.mockReturnValue([nativeCommand({ source: 'prompt' as CommandInfo['source'] })])
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject({ availability: 'inactive', phase: 'ready', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'replaced', rows: [replacementCommand()] },
    { label: 'removed', rows: [] },
    { label: 'source metadata changed', rows: [nativeCommand({ sourceInfo: undefined })] }
  ])('rejects a native result if command identity is $label during its pending read', async ({ rows }) => {
    const pending = deferred()
    const h = setup({ handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') } })
    await h.start()
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    expect(h.getCommands).toHaveBeenCalledTimes(1)
    h.getCommands.mockReturnValue(rows)
    pending.resolve()
    await flush()
    expect(h.getCommands).toHaveBeenCalledTimes(2)
    expect(h.latest()).toMatchObject({ availability: 'unavailable', phase: 'unavailable', reason: 'query-failed', servers: [] })
    expect(h.notices().some((notice) => notice.availability === 'native' && notice.phase === 'ready')).toBe(false)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    expect(h.unknownPlugin).not.toHaveBeenCalled()
    h.expectNoSideEffects()
  })

  it('accepts a fresh getCommands clone with the same exact native identity before and after await', async () => {
    const h = setup()
    h.getCommands.mockImplementation(() => [nativeCommand()])
    await h.start()
    expect(h.getCommands).toHaveBeenCalledTimes(2)
    expect(h.latest()).toMatchObject(ready)
  })

  it.each(['before', 'after'])('handles a getCommands exception %s the native read without raw diagnostics', async (when) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup()
    if (when === 'after') h.getCommands.mockReturnValueOnce([nativeCommand()])
    h.getCommands.mockImplementation(() => { throw new Error('PRIVATE_COMMAND_ERROR') })
    await h.start()
    if (when === 'before') {
      expect(h.nativeHandler).not.toHaveBeenCalled()
      expect(h.setWidget).not.toHaveBeenCalled()
    } else {
      expect(h.nativeHandler).toHaveBeenCalledTimes(1)
      expect(h.latest()).toMatchObject({ phase: 'unavailable', reason: 'query-failed', servers: [] })
    }
    expect(error).not.toHaveBeenCalled()
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toContain('PRIVATE_COMMAND_ERROR')
  })
})

describe('isolated read-only native command context', () => {
  it('passes literal empty args and only actual RPC mode plus isolated notify, leaving captured UI methods untouched', async () => {
    let isolated: ExtensionCommandContext | undefined
    const h = setup({ handler: async (args, ctx) => {
      expect(args).toBe('')
      expect(ctx.mode).toBe('rpc')
      expect(Object.getPrototypeOf(ctx)).toBeNull()
      expect(Object.keys(ctx)).toEqual([])
      expect(Object.getPrototypeOf(ctx.ui)).toBeNull()
      isolated = ctx
      ctx.ui.notify(statusText, 'info')
    } })
    const originalNotify = h.context.ui.notify
    const originalSetWidget = h.context.ui.setWidget
    await h.start()
    // Match only the boolean: assertion libraries inspect arbitrary objects,
    // which must not probe a deliberately revoked read-only Proxy after await.
    expect(isolated === h.context).toBe(false)
    expect(h.nativeHandler.mock.calls[0][0]).toBe('')
    expect(h.context.ui.notify).toBe(originalNotify)
    expect(h.context.ui.setWidget).toBe(originalSetWidget)
    expect(h.latest()).toMatchObject(ready)
    h.expectNoSideEffects()
  })

  it.each([
    { label: 'no notification', handler: async () => {}, reason: 'unsupported-format' },
    { label: 'double notification', handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(statusText, 'info'); ctx.ui.notify(statusText, 'info')
    }, reason: 'query-failed' },
    { label: 'missing info level', handler: async (_args: string, ctx: ExtensionCommandContext) => { ctx.ui.notify(statusText) }, reason: 'query-failed' },
    { label: 'wrong level', handler: async (_args: string, ctx: ExtensionCommandContext) => { ctx.ui.notify(statusText, 'error') }, reason: 'query-failed' },
    { label: 'throw after notification', handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(statusText, 'info'); throw new Error('PRIVATE_HANDLER_ERROR')
    }, reason: 'query-failed' },
    { label: 'unknown UI call', handler: async (_args: string, ctx: ExtensionCommandContext) => { await ctx.ui.select('Forbidden', ['x']) }, reason: 'query-failed' },
    { label: 'UI setWidget call', handler: async (_args: string, ctx: ExtensionCommandContext) => { ctx.ui.setWidget('unknown-widget', ['PRIVATE_WIDGET']) }, reason: 'query-failed' },
    { label: 'newSession call', handler: async (_args: string, ctx: ExtensionCommandContext) => { await ctx.newSession() }, reason: 'query-failed' },
    { label: 'waitForIdle call', handler: async (_args: string, ctx: ExtensionCommandContext) => { await ctx.waitForIdle() }, reason: 'query-failed' },
    { label: 'sessionManager access', handler: async (_args: string, ctx: ExtensionCommandContext) => { ctx.sessionManager.getSessionFile() }, reason: 'query-failed' },
    { label: 'modelRegistry access', handler: async (_args: string, ctx: ExtensionCommandContext) => { void ctx.modelRegistry }, reason: 'query-failed' }
  ])('fails closed on $label with all underlying side-effect dispatch spies still zero', async ({ handler, reason }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup({ handler })
    expect(h.fees).toEqual({ calls: 0, charged: 0 })
    await h.start()
    expect(h.latest()).toMatchObject({ phase: 'unavailable', reason, servers: [] })
    expect(h.slot.busy).toBe(false)
    expect(h.setWidget).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toMatch(/PRIVATE_|unknown-widget/)
    h.expectNoSideEffects()
  })

  it.each([
    { label: 'set', mutate: (target: object) => Reflect.set(target, 'forbidden', true) },
    { label: 'defineProperty', mutate: (target: object) => Reflect.defineProperty(target, 'forbidden', { value: true }) },
    { label: 'deleteProperty', mutate: (target: object) => Reflect.deleteProperty(target, 'forbidden') },
    { label: 'setPrototypeOf', mutate: (target: object) => Reflect.setPrototypeOf(target, {}) }
  ].flatMap((operation) => [false, true].map((ui) => ({ ...operation, ui }))))(
    'locks a caught $label mutation violation (UI target: $ui)', async ({ mutate, ui }) => {
      const h = setup({ handler: async (_args, ctx) => {
        try { mutate(ui ? ctx.ui : ctx) } catch { /* Cannot erase a protocol violation. */ }
        ctx.ui.notify(statusText, 'info')
      } })
      await h.start()
      expect(h.latest()).toMatchObject({ phase: 'unavailable', servers: [] })
      expect(Object.getPrototypeOf(h.context.ui)).toBe(Object.prototype)
      expect(h.context).not.toHaveProperty('forbidden')
      expect(h.context.ui).not.toHaveProperty('forbidden')
      h.expectNoSideEffects()
    })

  it.each([
    { label: 'unknown UI', attempt: (ctx: ExtensionCommandContext) => ctx.ui.select('Forbidden', ['x']) },
    { label: 'newSession', attempt: (ctx: ExtensionCommandContext) => ctx.newSession() },
    { label: 'waitForIdle', attempt: (ctx: ExtensionCommandContext) => ctx.waitForIdle() }
  ])('does not turn a caught forbidden $label call into a falsely ready observation', async ({ attempt }) => {
    const h = setup({ handler: async (_args, ctx) => {
      try { await attempt(ctx) } catch { /* Native code may catch UI failures. */ }
      ctx.ui.notify(statusText, 'info')
    } })
    await h.start()
    h.expectNoSideEffects()
    expect(h.latest()).toMatchObject({ phase: 'unavailable', servers: [] })
  })
})

describe('bounded private status protocol, not raw native diagnostics', () => {
  it('publishes v1 whitelisted JSON with scope from the captured SDK context and drops opaque credentials/payloads', async () => {
    const text = [statusText, 'beta: failed (direct)',
      '    Authorization: PRIVATE_HEADER https://fixture.invalid/PRIVATE_URL --args PRIVATE_ARG',
      'config error: /fixture/PRIVATE_CONFIG/mcp.json PRIVATE_TOKEN',
      'PRIVATE_JSON {"images":["PRIVATE_IMAGE"],"usage":{"cost":99},"prompt":"PRIVATE_PROMPT"}',
      'injected: connected, 999 tools (direct)'].join('\n')
    const h = setup({ handler: async (_args, ctx) => { ctx.ui.notify(text, 'info') } })
    await h.start()
    const notice = h.latest()
    expect(MCP_STATUS_PROTOCOL_VERSION).toBe(1)
    expect(MCP_STATUS_SDK_VERSION).toBe('1.0.4')
    expect(MCP_STATUS_WIDGET_KEY).toBe('__pion_mcp_status_v1')
    expect(notice).toMatchObject({ version: 1, revision: 1, cwd, sessionPath: firstSessionPath,
      availability: 'native', phase: 'ready', diagnosticsOmitted: true, servers: [ready.servers[0], { name: 'beta', state: 'failed', exposure: 'direct' }] })
    const lines = h.setWidget.mock.calls[0][1]!
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/[\r\n]/)
    expect(new TextEncoder().encode(lines[0]).length).toBeLessThanOrEqual(MCP_STATUS_MAX_BYTES)
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(['availability', 'cwd', 'diagnosticsOmitted', 'phase', 'revision', 'runtimeId', 'servers', 'sessionPath', 'version'])
    expect(Object.keys(notice.servers[0]).sort()).toEqual(['exposure', 'name', 'state', 'toolCount'])
    expect(Object.keys(notice.servers[1]).sort()).toEqual(['exposure', 'name', 'state'])
    expect(readMcpStatusNotice(JSON.parse(JSON.stringify(lines)))).toEqual(notice)
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toMatch(/PRIVATE_|injected|Authorization|https:|images|usage|prompt|args|config error/)
    h.expectNoSideEffects()
  })

  it('does not return the config path from the native no-server message', async () => {
    const h = setup({ handler: async (_args, ctx) => {
      ctx.ui.notify('No MCP servers configured. Add them to /fixture/PRIVATE_HOME/.pi/agent/mcp.json or .pi/mcp.json.', 'info')
    } })
    await h.start()
    expect(h.latest()).toMatchObject({ availability: 'native', phase: 'ready', servers: [], diagnosticsOmitted: false })
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toContain('PRIVATE_HOME')
  })

  it('accepts the maximum public server/name/count fields and stays bounded after serialization', async () => {
    const names = Array.from({ length: MCP_STATUS_MAX_SERVERS }, (_, index) => `s_${index}_${'x'.repeat(125 - String(index).length)}`)
    expect(names.every((name) => name.length === 128)).toBe(true)
    const h = setup({ handler: async (_args, ctx) => { ctx.ui.notify(names.map((name) => `${name}: connected, 1000000 tools (hidden)`).join('\n'), 'info') } })
    await h.start()
    expect(h.latest().servers).toEqual(names.map((name) => ({ name, state: 'connected', exposure: 'hidden', toolCount: 1_000_000 })))
    const line = h.setWidget.mock.calls[0][1]![0]
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(MCP_STATUS_MAX_BYTES)
    h.expectNoSideEffects()
  })

  it.each([
    { label: '129 servers', text: Array.from({ length: 129 }, (_, index) => `s${index}: starting (codemode)`).join('\n') },
    { label: 'oversized line', text: `config error: ${'x'.repeat(4097)}` },
    { label: 'oversized total payload', text: 'x'.repeat(MCP_STATUS_MAX_BYTES + 1) },
    { label: 'oversized UTF-8 payload', text: ['config error: fixture', ...Array.from({ length: 16 }, () => '界'.repeat(1400))].join('\n') },
    { label: 'unsupported raw JSON', text: '{"token":"PRIVATE_TOKEN","images":["PRIVATE_IMAGE"]}' },
    { label: 'malformed public count', text: 'alpha: connected, 1000001 tools (direct)' }
  ])('drops $label instead of publishing raw payload or falsely ready-empty', async ({ text }) => {
    const h = setup({ handler: async (_args, ctx) => { ctx.ui.notify(text, 'info') } })
    await h.start()
    expect(h.latest()).toMatchObject({ phase: 'unavailable', reason: 'unsupported-format', servers: [] })
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toMatch(/PRIVATE_|images|token/)
    h.expectNoSideEffects()
  })

  it.each([
    { label: 'invalid cwd', cwd: '/fixture/\nproject' },
    { label: 'oversized cwd', cwd: 'c'.repeat(8193) },
    { label: 'invalid session path', sessionPath: '/fixture/\u0000session.jsonl' },
    { label: 'oversized session path', sessionPath: 's'.repeat(8193) }
  ])('does not emit a notice with $label', async (options) => {
    const h = setup(options)
    await h.start()
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    expect(h.setWidget).not.toHaveBeenCalled()
    expect(h.slot.busy).toBe(false)
    h.expectNoSideEffects()
  })

  it('rejects an oversized serialized notice even when each individual scope/server field is valid', async () => {
    const names = Array.from({ length: 128 }, (_, index) => `s_${index}_${'x'.repeat(125 - String(index).length)}`)
    const h = setup({ cwd: '界'.repeat(8192), sessionPath: '界'.repeat(8192),
      handler: async (_args, ctx) => { ctx.ui.notify(names.map((name) => `${name}: connected, 1000000 tools (direct)`).join('\n'), 'info') } })
    await h.start()
    expect(h.setWidget).not.toHaveBeenCalled()
    h.setSessionPath(firstSessionPath)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject({ phase: 'ready', revision: 1, sessionPath: firstSessionPath })
    h.expectNoSideEffects()
  })

  it('swallows session-scope/widget transport exceptions without raw error events', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup()
    h.getSessionFile.mockImplementationOnce(() => { throw new Error('PRIVATE_SESSION_SCOPE') })
    await h.start()
    expect(h.setWidget).not.toHaveBeenCalled()
    h.setWidget.mockImplementationOnce(() => { throw new Error('PRIVATE_WIDGET_TRANSPORT') })
    await expect(vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)).resolves.not.toThrow()
    expect(h.slot.busy).toBe(false)
    expect(error).not.toHaveBeenCalled()
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toMatch(/PRIVATE_/)
  })
})

describe('periodic observations, independent revision and real session scope', () => {
  it('publishes immediately then exactly every 3 seconds with monotonic revisions and one runtime nonce', async () => {
    const h = setup()
    const beforeFees = { ...h.fees }
    const beforeState = JSON.parse(JSON.stringify(h.sdkState))
    expect(MCP_STATUS_INTERVAL_MS).toBe(3_000)
    expect(MCP_STATUS_QUERY_DEADLINE_MS).toBe(2_000)
    await h.start()
    const first = h.latest()
    expect(first.runtimeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.revision).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(h.setWidget).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.notices().map((notice) => notice.revision)).toEqual([1, 2, 3, 4])
    expect(new Set(h.notices().map((notice) => notice.runtimeId))).toEqual(new Set([first.runtimeId]))
    expect(h.nativeHandler.mock.calls.map(([args]) => args)).toEqual(['', '', '', ''])
    expect(h.createContext).toHaveBeenCalledTimes(4)
    expect(h.sdkState).toEqual(beforeState)
    expect(h.fees).toEqual(beforeFees)
    h.expectNoSideEffects()
  })

  it('does not reset revision/runtime nonce on reopening the same observer', async () => {
    const h = setup()
    await h.start()
    const first = h.latest()
    h.cleanup()
    await h.start()
    expect(h.latest()).toMatchObject({ runtimeId: first.runtimeId, revision: 2, phase: 'ready' })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('reads getSessionFile at publication time and emits the true new path, never creating a new session', async () => {
    const pending = deferred()
    const h = setup({ handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') } })
    await h.start()
    expect(h.getSessionFile).not.toHaveBeenCalled()
    const newPath = '/fixture/sessions/new-branch.jsonl'
    h.setSessionPath(newPath)
    pending.resolve()
    await flush()
    expect(h.latest()).toMatchObject({ cwd, sessionPath: newPath, revision: 1 })
    h.setSessionPath('/fixture/sessions/third.jsonl')
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject({ sessionPath: '/fixture/sessions/third.jsonl', revision: 2 })
    expect(h.getSessionFile).toHaveBeenCalledTimes(2)
    h.expectNoSideEffects()
  })

  it('omits an undefined SDK session path without filling it from command arguments or another scope', async () => {
    const h = setup()
    h.getSessionFile.mockReturnValue(undefined)
    await h.start()
    expect(h.latest()).not.toHaveProperty('sessionPath')
    expect(h.latest()).toMatchObject({ cwd, phase: 'ready' })
    h.expectNoSideEffects()
  })
})

describe('pending read deadline, shared slot and late collection', () => {
  it.each(['resolve', 'reject'] as const)('closes only collection at 2 seconds, keeps the real slot until late %s and publishes no late result', async (settlement) => {
    const pending = deferred()
    let capturedNotify: ExtensionCommandContext['ui']['notify'] | undefined
    const h = setup({ handler: async (_args, ctx) => {
      const notify = ctx.ui.notify
      capturedNotify = notify
      await pending.promise
      notify(statusText, 'info')
    } })
    await h.start()
    expect(h.slot.busy).toBe(true)
    expect(h.setWidget).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(h.setWidget).not.toHaveBeenCalled()
    await expect(vi.advanceTimersByTimeAsync(1)).resolves.not.toThrow()
    expect(h.latest()).toMatchObject({ availability: 'native', phase: 'unavailable', reason: 'query-timeout', servers: [] })
    expect(h.slot.busy).toBe(true)
    expect(() => capturedNotify!(statusText, 'info')).toThrow('no longer active')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    expect(h.slot.busy).toBe(true)
    expect(h.notices().every((notice) => notice.reason === 'query-timeout')).toBe(true)
    const widgetCount = h.setWidget.mock.calls.length
    if (settlement === 'resolve') pending.resolve()
    else pending.reject(new Error('PRIVATE_LATE_REJECTION'))
    await flush()
    expect(h.slot.busy).toBe(false)
    expect(h.setWidget).toHaveBeenCalledTimes(widgetCount)
    h.nativeHandler.mockImplementation(async (_args, ctx) => { ctx.ui.notify(statusText, 'info') })
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.nativeHandler).toHaveBeenCalledTimes(2)
    expect(h.latest()).toMatchObject(ready)
    h.expectNoSideEffects()
  })

  it('keeps the single slot across shutdown/reopening until the old native await really settles', async () => {
    const pending = deferred()
    const h = setup({ handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') } })
    await h.start()
    await vi.advanceTimersByTimeAsync(MCP_STATUS_QUERY_DEADLINE_MS)
    const firstRuntime = h.latest().runtimeId
    h.cleanup()
    expect(h.slot.busy).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await h.start()
    expect(h.latest()).toMatchObject({ runtimeId: firstRuntime, availability: 'native', phase: 'waiting', reason: 'query-busy', servers: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    const widgetCount = h.setWidget.mock.calls.length
    pending.resolve()
    await flush()
    expect(h.setWidget).toHaveBeenCalledTimes(widgetCount)
    expect(h.slot.busy).toBe(false)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject(ready)
    h.expectNoSideEffects()
  })

  it('shares a pending slot across SDK-owner replacement without reviving the old nonce/context or queueing reads', async () => {
    const slot: McpStatusReadSlot = { busy: false }
    const pending = deferred()
    const old = setup({ slot, handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') } })
    await old.start()
    await vi.advanceTimersByTimeAsync(MCP_STATUS_QUERY_DEADLINE_MS)
    const oldRuntimeId = old.latest().runtimeId
    old.cleanup()
    const next = setup({ slot, sessionPath: '/fixture/sessions/replacement.jsonl' })
    await next.start()
    expect(next.latest()).toMatchObject({ availability: 'native', phase: 'waiting', reason: 'query-busy', revision: 1,
      sessionPath: '/fixture/sessions/replacement.jsonl' })
    expect(next.latest().runtimeId).not.toBe(oldRuntimeId)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(old.nativeHandler).toHaveBeenCalledTimes(1)
    expect(next.nativeHandler).not.toHaveBeenCalled()
    expect(slot.busy).toBe(true)
    const oldCount = old.setWidget.mock.calls.length
    const nextCount = next.setWidget.mock.calls.length
    pending.resolve()
    await flush()
    expect(slot.busy).toBe(false)
    expect(old.setWidget).toHaveBeenCalledTimes(oldCount)
    expect(next.setWidget).toHaveBeenCalledTimes(nextCount)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(next.nativeHandler).toHaveBeenCalledTimes(1)
    expect(next.latest()).toMatchObject({ ...ready, sessionPath: '/fixture/sessions/replacement.jsonl', revision: 4 })
    old.expectNoSideEffects()
    next.expectNoSideEffects()
  })

  it('does not turn a slot from a different RPC owner into a process-wide singleton', async () => {
    const pending = deferred()
    const first = setup({ handler: async () => pending.promise })
    const second = setup()
    await first.start()
    await second.start()
    expect(first.slot).not.toBe(second.slot)
    expect(first.slot.busy).toBe(true)
    expect(second.latest()).toMatchObject(ready)
    expect(second.nativeHandler).toHaveBeenCalledTimes(1)
    first.cleanup()
    pending.resolve()
    await flush()
    first.expectNoSideEffects()
    second.expectNoSideEffects()
  })
})

describe('shutdown invalidation before native close and idempotent cleanup', () => {
  it('halts synchronously before a pending native close, removes timers and closes the collector while awaiting actual close', async () => {
    const read = deferred()
    const close = deferred()
    let isolated: ExtensionCommandContext | undefined
    const h = setup({ handler: async (_args, ctx) => { isolated = ctx; await read.promise; ctx.ui.notify(statusText, 'info') },
      close: () => {
        // Assert at native close entry, not only after shutdown returns: halt
        // must precede even the synchronous portion of the native handler.
        expect(vi.getTimerCount()).toBe(0)
        expect(() => isolated!.ui).toThrow('no longer active')
        return close.promise
      } })
    await h.start()
    expect(vi.getTimerCount()).toBe(2)
    let closed = false
    const closing = h.shutdownNative().then(() => { closed = true })
    expect(h.nativeClose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.slot.busy).toBe(true)
    expect(() => isolated!.ui).toThrow('no longer active')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(closed).toBe(false)
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    expect(h.setWidget).not.toHaveBeenCalled()
    read.resolve()
    await flush()
    expect(h.slot.busy).toBe(false)
    expect(h.setWidget).not.toHaveBeenCalled()
    expect(closed).toBe(false)
    close.resolve()
    await closing
    expect(closed).toBe(true)
    h.expectNoSideEffects()
  })

  it('keeps the observer halted even when native close rejects, without late collector publications', async () => {
    const pending = deferred()
    const h = setup({ handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') },
      close: () => Promise.reject(new Error('PRIVATE_NATIVE_CLOSE')) })
    await h.start()
    await expect(h.shutdownNative()).rejects.toThrow('PRIVATE_NATIVE_CLOSE')
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.slot.busy).toBe(false)
    expect(h.setWidget).not.toHaveBeenCalled()
  })

  it('makes inactive observer cleanup idempotent without calling native close, context or any side-effect actor', () => {
    const h = setup({ nativeRegistered: false, commands: [] })
    h.cleanup()
    h.cleanup()
    expect(vi.getTimerCount()).toBe(0)
    expect(h.slot.busy).toBe(false)
    expect(h.nativeClose).not.toHaveBeenCalled()
    expect(h.createContext).not.toHaveBeenCalled()
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(h.setWidget).not.toHaveBeenCalled()
    h.expectNoSideEffects()
  })
})
})
