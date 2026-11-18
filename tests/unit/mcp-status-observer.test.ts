import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpExtension, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { createMcpStatusObserver, type McpStatusReadSlot } from '../../src/main/agent/mcp-status-observer'
import {
  MCP_STATUS_INTERVAL_MS, MCP_STATUS_MAX_BYTES, MCP_STATUS_QUERY_DEADLINE_MS, MCP_STATUS_WIDGET_KEY, readMcpStatusNotice
} from '../../src/shared/mcp'

type NativeHandler = Parameters<ExtensionAPI['registerCommand']>[1]['handler']
type CommandInfo = ReturnType<ExtensionAPI['getCommands']>[number]
type Hook = (event: unknown, ctx: ExtensionCommandContext) => unknown
const cwd = '/fixture/worktree'
const sessionPath = '/fixture/sessions/first.jsonl'
const statusText = 'alpha: connected, 7 tools (hidden)'
const ready = { availability: 'native', phase: 'ready', diagnosticsOmitted: false,
  servers: [{ name: 'alpha', state: 'connected', exposure: 'hidden', toolCount: 7 }] }
const cleanups: Array<() => void> = []

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await flush()
  try { expect(vi.getTimerCount()).toBe(0) }
  finally { vi.clearAllTimers(); vi.useRealTimers() }
})

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => { resolve = finish })
  return { promise, resolve }
}
function nativeCommand(): CommandInfo {
  return { name: 'mcp', description: 'MCP', source: 'extension', sourceInfo: {
    path: 'builtin:mcp', source: 'builtin', scope: 'temporary', origin: 'top-level'
  } } as CommandInfo
}
function replacementCommand(): CommandInfo {
  return { ...nativeCommand(), sourceInfo: { path: '/fixture/legacy-mcp.ts', source: 'local',
    scope: 'user', origin: 'top-level' } } as CommandInfo
}

// Only the dedicated real-handler test registers the SDK factory. No test runs
// its lifecycle, config loader, transport, credentials, model or session code.
function setup(options: {
  handler?: NativeHandler
  start?: () => void | Promise<void>
  close?: () => void | Promise<void>
  commands?: CommandInfo[]
  mode?: string
  cwd?: string
  sdkVersion?: string
  slot?: McpStatusReadSlot
} = {}) {
  const slot = options.slot ?? { busy: false }
  let currentSessionPath: string | undefined = sessionPath
  const nativeStart = vi.fn(options.start ?? (() => {}))
  const nativeClose = vi.fn(options.close ?? (() => {}))
  const nativeHandler = vi.fn<NativeHandler>(options.handler ?? (async (_args, ctx) => { ctx.ui.notify(statusText, 'info') }))
  const notify = vi.fn()
  const setWidget = vi.fn((_key: string, _lines: string[] | undefined) => {})
  const getSessionFile = vi.fn(() => currentSessionPath)
  const context = { cwd: options.cwd ?? cwd, mode: Object.hasOwn(options, 'mode') ? options.mode : 'rpc',
    ui: { notify, setWidget }, sessionManager: { getSessionFile } } as unknown as ExtensionCommandContext
  const createContext = vi.fn((): ExtensionCommandContext | undefined => context)
  const hooks = new Map<string, Hook[]>()
  const on = vi.fn((name: string, handler: Hook) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]) })
  const getCommands = vi.fn(() => options.commands ?? [nativeCommand()])
  const pi = { on, getCommands, registerCommand: vi.fn() }
  const api = pi as unknown as ExtensionAPI
  const observer = createMcpStatusObserver({ createContext, slot,
    ...(options.sdkVersion !== undefined ? { sdkVersion: options.sdkVersion } : {}) })
  observer.wrapNative((pi) => {
    pi.registerCommand('mcp', { description: 'MCP', handler: nativeHandler })
    pi.on('session_start', nativeStart)
    pi.on('session_shutdown', nativeClose)
  })(api)
  const nativeStartHook = hooks.get('session_start')![0]
  const nativeShutdownHook = hooks.get('session_shutdown')![0]
  observer.extension(api)
  const startObserver = () => { hooks.get('session_start')!.at(-1)!({}, context) }
  const cleanup = () => { hooks.get('session_shutdown')!.at(-1)!({}, context) }
  cleanups.push(cleanup)
  const startNative = () => Promise.resolve(nativeStartHook({}, context))
  const start = async () => { await startNative(); startObserver(); await flush() }
  const notices = () => setWidget.mock.calls.map(([key, lines]) => {
    expect(key).toBe(MCP_STATUS_WIDGET_KEY)
    const notice = readMcpStatusNotice(lines)
    expect(notice).toBeDefined()
    return notice!
  })
  const latest = () => notices().at(-1)!
  return { pi, context, createContext, nativeStart, nativeClose, nativeHandler, getCommands, getSessionFile,
    notify, setWidget, slot, start, startNative, startObserver, cleanup, notices, latest,
    shutdownNative: () => Promise.resolve(nativeShutdownHook({}, context)),
    setSessionPath: (path: string | undefined) => { currentSessionPath = path } }
}

describe('MCP observer source and lifecycle gates', () => {
  it('registers without reading context or starting timers, and waits for native startup to settle', async () => {
    const startup = deferred()
    const h = setup({ start: () => startup.promise })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.createContext).not.toHaveBeenCalled()
    expect(h.nativeHandler).not.toHaveBeenCalled()
    expect(h.nativeStart).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const starting = h.startNative()
    h.startObserver()
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject({ phase: 'waiting', reason: 'initializing', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
    startup.resolve()
    await starting
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject(ready)
  })

  it('keeps late startup retired after shutdown and observation reopening', async () => {
    const startup = deferred()
    const h = setup({ start: () => startup.promise })
    const starting = h.startNative()
    h.startObserver()
    await h.shutdownNative()
    startup.resolve()
    await starting
    h.startObserver()
    await flush()
    expect(h.latest()).toMatchObject({ phase: 'waiting', reason: 'initializing', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
  })

  it.each([
    { commands: [], availability: 'inactive' },
    { commands: [replacementCommand()], availability: 'replaced' }
  ])('leaves $availability MCP commands unqueried', async ({ commands, availability }) => {
    const h = setup({ commands })
    await h.start()
    expect(h.latest()).toMatchObject({ availability, phase: 'ready', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
  })

  it.each(['path', 'source', 'scope', 'origin'] as const)('requires exact builtin %s metadata', async (field) => {
    const command = nativeCommand()
    const h = setup({ commands: [{ ...command, sourceInfo: { ...command.sourceInfo, [field]: 'foreign' } } as CommandInfo] })
    await h.start()
    expect(h.latest()).toMatchObject({ availability: 'replaced', servers: [] })
    expect(h.nativeHandler).not.toHaveBeenCalled()
  })

  it('skips an unsupported SDK and preserves the actual non-RPC mode', async () => {
    const unsupported = setup({ sdkVersion: '1.5.3' })
    await unsupported.start()
    expect(unsupported.latest()).toMatchObject({ reason: 'unsupported-sdk', servers: [] })
    expect(unsupported.nativeHandler).not.toHaveBeenCalled()
    const tui = setup({ mode: 'tui' })
    await tui.start()
    expect(tui.context.mode).toBe('tui')
    expect(tui.nativeHandler).not.toHaveBeenCalled()
    expect(tui.setWidget).not.toHaveBeenCalled()
  })

  it('rejects source replacement during the original pending handler', async () => {
    const pending = deferred()
    const h = setup({ handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') } })
    await h.start()
    h.getCommands.mockReturnValue([replacementCommand()])
    pending.resolve()
    await flush()
    expect(h.latest()).toMatchObject({ reason: 'query-failed', servers: [] })
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest().availability).toBe('replaced')
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
  })
})

describe('audited native status path and bounded publication', () => {
  it('runs the real SDK empty-argument handler with a narrow RPC context, without its lifecycle or config loader', async () => {
    let handler!: NativeHandler
    const loadConfig = vi.fn(() => { throw new Error('Unexpected config read') })
    const on = vi.fn()
    createMcpExtension({ loadConfig })({ on, registerToolRenderer: vi.fn(), registerCommand: (_name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) => {
      handler = command.handler
    } } as unknown as ExtensionAPI)
    const h = setup({ handler })
    await h.start()
    expect(h.nativeHandler.mock.calls[0][0]).toBe('')
    const ctx = h.nativeHandler.mock.calls[0][1]
    expect(ctx).not.toBe(h.context)
    expect(ctx.mode).toBe(h.context.mode)
    expect(Object.keys(ctx)).toEqual(['mode', 'ui'])
    expect(Object.keys(ctx.ui)).toEqual(['notify'])
    expect(h.latest()).toMatchObject({ availability: 'native', phase: 'ready', servers: [] })
    expect(on).toHaveBeenCalledWith('session_start', expect.any(Function))
    expect(loadConfig).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing notification', handler: async () => {} },
    { label: 'duplicate notification', handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(statusText, 'info'); ctx.ui.notify(statusText, 'info')
    } },
    { label: 'wrong notification level', handler: async (_args: string, ctx: ExtensionCommandContext) => { ctx.ui.notify(statusText, 'error') } }
  ])('rejects $label', async ({ handler }) => {
    const h = setup({ handler })
    await h.start()
    expect(h.latest()).toMatchObject({ phase: 'unavailable', reason: 'unsupported-format', servers: [] })
    expect(h.slot.busy).toBe(false)
  })

  it('publishes safe failure after a handler rejection and retries only on the next tick', async () => {
    const h = setup({ handler: async () => { throw new Error('PRIVATE_HANDLER_ERROR') } })
    await h.start()
    expect(h.latest()).toMatchObject({ reason: 'query-failed', servers: [] })
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toContain('PRIVATE_HANDLER_ERROR')
    h.nativeHandler.mockImplementation(async (_args, ctx) => { ctx.ui.notify(statusText, 'info') })
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject(ready)
  })

  it('omits opaque diagnostics and scopes each monotonic notice to the real current session', async () => {
    const h = setup({ handler: async (_args, ctx) => {
      ctx.ui.notify(`${statusText}\nconfig error: PRIVATE_TOKEN\ninjected: connected, 1 tools (direct)`, 'info')
    } })
    await h.start()
    const first = h.latest()
    expect(first).toMatchObject({ ...ready, diagnosticsOmitted: true, version: 1, revision: 1, cwd, sessionPath })
    expect(JSON.stringify(h.setWidget.mock.calls)).not.toMatch(/PRIVATE_|injected/)
    h.setSessionPath('/fixture/sessions/second.jsonl')
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS - 1)
    expect(h.setWidget).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.latest()).toMatchObject({ runtimeId: first.runtimeId, revision: 2, sessionPath: '/fixture/sessions/second.jsonl' })
    h.setSessionPath(undefined)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).not.toHaveProperty('sessionPath')
    expect(h.nativeHandler.mock.calls.map(([args]) => args)).toEqual(['', '', ''])
  })

  it('bounds incoming text and outgoing serialized scope bytes', async () => {
    const text = Array.from({ length: 128 }, (_, index) => `${`s${index}`.padEnd(128, 'x')}: connected, 7 tools (hidden)`).join('\n')
    const h = setup({ cwd: '界'.repeat(8192), handler: async (_args, ctx) => { ctx.ui.notify(text, 'info') } })
    h.setSessionPath('界'.repeat(8192))
    await h.start()
    expect(h.setWidget).not.toHaveBeenCalled()
    h.setSessionPath(sessionPath)
    h.nativeHandler.mockImplementation(async (_args, ctx) => { ctx.ui.notify('x'.repeat(MCP_STATUS_MAX_BYTES + 1), 'info') })
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject({ reason: 'unsupported-format', revision: 1, servers: [] })
  })
})

describe('pending handler ownership and retired notification windows', () => {
  it('times out collection while holding the original pending slot and ignores late notify', async () => {
    const pending = deferred()
    let notify!: ExtensionCommandContext['ui']['notify']
    const h = setup({ handler: async (_args, ctx) => { notify = ctx.ui.notify; await pending.promise; notify(statusText, 'info') } })
    await h.start()
    expect(h.slot.busy).toBe(true)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_QUERY_DEADLINE_MS)
    expect(h.latest()).toMatchObject({ reason: 'query-timeout', servers: [] })
    notify(statusText, 'info')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.nativeHandler).toHaveBeenCalledTimes(1)
    expect(h.slot.busy).toBe(true)
    const count = h.setWidget.mock.calls.length
    pending.resolve()
    await flush()
    expect(h.slot.busy).toBe(false)
    expect(h.setWidget).toHaveBeenCalledTimes(count)
    h.nativeHandler.mockImplementation(async (_args, ctx) => { ctx.ui.notify(statusText, 'info') })
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(h.latest()).toMatchObject(ready)
  })

  it('retains one actual slot across SDK replacement until the retired handler settles', async () => {
    const slot: McpStatusReadSlot = { busy: false }
    const pending = deferred()
    const old = setup({ slot, handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') } })
    await old.start()
    old.cleanup()
    const next = setup({ slot })
    await next.start()
    expect(next.latest()).toMatchObject({ reason: 'query-busy', servers: [] })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(old.nativeHandler).toHaveBeenCalledTimes(1)
    expect(next.nativeHandler).not.toHaveBeenCalled()
    pending.resolve()
    await flush()
    expect(old.setWidget).not.toHaveBeenCalled()
    expect(slot.busy).toBe(false)
    await vi.advanceTimersByTimeAsync(MCP_STATUS_INTERVAL_MS)
    expect(next.latest()).toMatchObject(ready)
  })

  it('halts before native close while keeping real handler and close promises independent', async () => {
    const pending = deferred()
    const close = deferred()
    const h = setup({ handler: async (_args, ctx) => { await pending.promise; ctx.ui.notify(statusText, 'info') },
      close: () => { expect(vi.getTimerCount()).toBe(0); return close.promise } })
    await h.start()
    let closed = false
    const closing = h.shutdownNative().then(() => { closed = true })
    expect(h.slot.busy).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(closed).toBe(false)
    pending.resolve()
    await flush()
    expect(h.slot.busy).toBe(false)
    expect(h.setWidget).not.toHaveBeenCalled()
    expect(closed).toBe(false)
    close.resolve()
    await closing
    h.cleanup()
    h.cleanup()
    expect(h.nativeClose).toHaveBeenCalledTimes(1)
  })
})
