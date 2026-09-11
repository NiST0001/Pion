import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SessionManager, type RpcClient } from '@earendil-works/pi-coding-agent'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { BackendPool } from '../../src/main/agent/backend-pool'
import { PendingRequestStore } from '../../src/main/agent/pending-requests'
import { nativePlanModeExtensionSource } from '../../src/main/agent/plan-mode'
import type { BackendRecord } from '../../src/main/agent/types'
import { registerAgentIpc } from '../../src/main/ipc/agent'
import { EMPTY_TOKEN_USAGE, RunStore } from '../../src/main/run-store'
import { IPC, IPC_EVENTS } from '../../src/shared/ipc'
import type {
  AgentMode, AgentStatus, ImageContent, MessageRevertRequest, MessageRevertResult, RunOperation
} from '../../src/shared/types'

type RpcState = Awaited<ReturnType<RpcClient['getState']>>
type IpcListener = Parameters<IpcMain['handle']>[1]
const OWNER_ID = 17
const roots: string[] = []
const stores: RunStore[] = []
const requestStores: PendingRequestStore[] = []
const pools: BackendPool[] = []
const children: HistoryProcess[] = []
const releases: (() => void)[] = []
const observations: Promise<unknown>[] = []

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  releases.push(() => resolve(fallback))
  return { promise, resolve, reject }
}

// Observe rejection immediately: race tests must not leave an unhandled promise
// while they deliberately hold state, SDK stop(), or actual process exit open.
function observe<T>(promise: Promise<T>) {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  observations.push(settled)
  return settled
}

class HistoryProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  exit(): void {
    if (this.exitCode !== null) return
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

function appendAssistant(manager: SessionManager, text: string, calls: { id: string; name: string }[] = []) {
  return manager.appendMessage({
    role: 'assistant', timestamp: 2, api: 'anthropic-messages', provider: 'anthropic', model: 'fixture-model',
    stopReason: 'stop',
    content: [{ type: 'text', text }, ...calls.map((call) => ({
      type: 'toolCall' as const, ...call, arguments: {}
    }))],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  })
}

function appendResult(manager: SessionManager, toolCallId: string, toolName: string, text: string, tasks?: unknown[]) {
  return manager.appendMessage({
    role: 'toolResult', timestamp: 3, toolCallId, toolName, isError: false,
    content: [{ type: 'text', text }], details: tasks === undefined ? undefined : { tasks }
  })
}

function transcript(root: string, name = 'project') {
  const cwd = join(root, name)
  mkdirSync(cwd)
  const manager = SessionManager.create(cwd)
  manager.appendCustomEntry('plan-mode-state', { enabled: true })
  const first = manager.appendMessage({ role: 'user', content: 'kept prompt', timestamp: 1 })
  const call = appendAssistant(manager, 'kept reply', [
    { id: 'same-read-id', name: 'read' }, { id: 'kept-task-call', name: 'pion_task' }
  ])
  const keptResult = appendResult(manager, 'same-read-id', 'read', 'kept output')
  const keptTasks = appendResult(manager, 'kept-task-call', 'pion_task', 'kept plan', [
    { id: 1, subject: 'Kept task', status: 'completed' }
  ])
  const parentId = manager.appendThinkingLevelChange('high')
  const prefixIds = manager.getBranch().map((entry) => entry.id)
  const images: ImageContent[] = [
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    { type: 'image', data: 'c2Vjb25k', mimeType: 'image/webp' }
  ]
  const prefix = '  修改 @src/a.ts\r\n<file path="src/a.ts">\n原文\n</file>\n'
  const suffix = '\n尾部\t  '
  const selected = manager.appendMessage({ role: 'user', timestamp: 4,
    content: [{ type: 'text', text: prefix }, images[0], { type: 'text', text: suffix }, images[1]] })
  const oldMode = manager.appendCustomEntry('plan-mode-state', { enabled: false })
  const oldReply = appendAssistant(manager, 'abandoned reply', [{ id: 'same-read-id', name: 'read' }])
  // Reused call ids make an accidental whole-file tool-result lookup observable.
  const oldResult = appendResult(manager, 'same-read-id', 'read', 'abandoned output')
  const oldTasks = appendResult(manager, 'old-task-call', 'pion_task', 'abandoned plan', [
    { id: 2, subject: 'Abandoned task', status: 'in_progress' }
  ])
  const later = manager.appendMessage({ role: 'user', content: 'later abandoned prompt', timestamp: 5 })
  appendAssistant(manager, 'later abandoned reply')
  const request: MessageRevertRequest = {
    sessionPath: manager.getSessionFile()!, sessionId: manager.getSessionId(),
    entryId: selected, expectedLeafId: manager.getLeafId()
  }
  return { manager, cwd, request, first, call, keptResult, keptTasks, parentId, prefixIds,
    selected, oldMode, oldReply, oldResult, oldTasks, later, images, text: prefix + suffix }
}

function planLifecycle(manager: SessionManager) {
  const initialTools = ['read', 'bash', 'edit', 'write', 'pion_ask_user']
  let tools = [...initialTools]
  const ctx = { sessionManager: manager, ui: { notify: vi.fn() } }
  type Handler = (event: unknown, context: typeof ctx) => void | Promise<void>
  const handlers = new Map<string, Handler>()
  let command!: { handler(args: string, context: typeof ctx): Promise<void> }
  const pi = {
    getAllTools: () => initialTools.map((name) => ({ name,
      sourceInfo: { source: name === 'pion_ask_user' ? 'sdk' : 'builtin' } })),
    getActiveTools: () => [...tools],
    setActiveTools: (names: string[]) => { tools = [...names] },
    appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
    on: (name: string, handler: Handler) => { handlers.set(name, handler) },
    registerCommand: (_name: string, registered: typeof command) => { command = registered }
  }
  const install = new Function(nativePlanModeExtensionSource().replace(
    'export default function (pi)', 'return function (pi)'
  ))() as (api: typeof pi) => void
  install(pi)
  return { event: (name: string) => handlers.get(name)!({}, ctx),
    command: (args: string) => command.handler(args, ctx) }
}

function runtime(key: string, cwd: string, path: string) {
  const manager = SessionManager.open(path)
  const child = new HistoryProcess()
  children.push(child)
  const stopStarted = deferred<void>(undefined)
  const state: RpcState = {
    sessionId: manager.getSessionId(), sessionFile: path, thinkingLevel: 'high',
    isStreaming: false, isCompacting: false, pendingMessageCount: 0,
    messageCount: manager.buildSessionContext().messages.length,
    steeringMode: 'all', followUpMode: 'all', autoCompactionEnabled: true
  }
  const client = {
    process: child as HistoryProcess | null,
    getState: vi.fn(async (): Promise<RpcState> => ({ ...state })),
    getEntries: vi.fn(async () => ({ entries: manager.getEntries(), leafId: manager.getLeafId() })),
    getTree: vi.fn(async () => ({ tree: manager.getTree(), leafId: manager.getLeafId() })),
    stop: vi.fn(async (): Promise<void> => {
      stopStarted.resolve()
      child.exit()
      client.process = null
    }),
    prompt: vi.fn(async (_message: string, _images?: ImageContent[]) => undefined),
    steer: vi.fn(async (_message: string, _images?: ImageContent[]) => undefined),
    compact: vi.fn<RpcClient['compact']>().mockRejectedValue(new Error('Unexpected fixture compaction')),
    setSessionName: vi.fn(async (_name: string) => undefined),
    setAutoRetry: vi.fn(async (_enabled: boolean) => undefined),
    setAutoCompaction: vi.fn(async (_enabled: boolean) => undefined),
    setModel: vi.fn<RpcClient['setModel']>().mockRejectedValue(new Error('Unexpected fixture model change'))
  }
  const backend: BackendRecord = {
    key, cwd, sessionPath: path, sidebarPublishedSessionPath: path,
    client: client as unknown as RpcClient,
    phase: 'running', busy: false, compacting: false, modePrimed: 'build',
    pendingRunIds: [], localFollowUps: [], companionRunIds: [], directSteering: [],
    rawQueue: { steering: [], followUp: [] }, startPromise: Promise.resolve()
  }
  return { backend, client, child, state, stopStarted }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pion-bridge-revert-'))
  roots.push(root)
  // Real refresh calls SessionManager.list(), which creates its default session
  // directory. Keep that directory (not only the JSONL fixtures) out of user data.
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent-data'))
  const session = transcript(root)
  const original = runtime('selected-backend', session.cwd, session.request.sessionPath)
  const backendPool = new BackendPool()
  pools.push(backendPool)
  backendPool.add(original.backend)
  const runStore = new RunStore(join(root, 'runs.json'))
  stores.push(runStore)
  const send = vi.fn((_channel: string, ..._args: unknown[]) => undefined)
  const pendingRequests = new PendingRequestStore({
    pushToolPermissionRequests: () => send(IPC_EVENTS.ToolPermissionRequests),
    pushExtensionUiRequests: () => send(IPC_EVENTS.ExtensionUiRequests)
  })
  requestStores.push(pendingRequests)
  const backendKeysBySessionPath = new Map([[session.request.sessionPath, original.backend.key]])
  const recreated: ReturnType<typeof runtime>[] = []
  // Only cold process construction is replaced. Pool/ensureActiveBackend, stop
  // barrier, SDK validation/append, RunStore, refresh and history APIs are real.
  // No vi.mock/doMock (and no SDK/electron singleton replacement) can leak into
  // the coverage suite's single isolate; spies below are restored after each case.
  const createBackend = vi.fn(async (key: string, cwd: string, path?: string) => {
    if (!path) throw new Error('Fixture must not create an unpersisted session runtime')
    const next = runtime(key, cwd, path)
    recreated.push(next)
    backendPool.add(next.backend)
    backendKeysBySessionPath.set(path, key)
    return next.backend
  })
  const fields = {
    activeKey: original.backend.key as string | null,
    activeCwd: session.cwd as string | undefined,
    activeSessionPath: session.request.sessionPath as string | undefined,
    win: { webContents: { id: OWNER_ID, send } } as { webContents: { id: number; send: typeof send } } | null,
    status: { phase: 'running', cwd: session.cwd } as AgentStatus,
    stopping: false, providerMutationInFlight: false, providerReloading: false,
    providerAuthUi: { cancel: vi.fn() }, providerAuthOperation: null,
    quarantinedSessionPaths: undefined as Set<string> | undefined,
    newSessionInFlight: null as Promise<void> | null,
    messageRevertInFlight: false, sessionOperationsInFlight: 0,
    sessionSelectionGeneration: 1, historyRevision: 0,
    backendPool, backendKeysBySessionPath, pendingRequests, runStore, createBackend,
    desiredModes: new Map<string, AgentMode>([[original.backend.key, 'build']]),
    sessionManagers: new Map<string, SessionManager>(), sessionManagerSignatures: new Map<string, string>(),
    unreadSessionPaths: new Set<string>(), yoloSessions: new Set<string>()
  }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), fields) as AgentBridge
  const internals = bridge as unknown as typeof fields & {
    sessionDirFor(cwd: string): string
    ensureActiveBackend(): Promise<BackendRecord>
  }
  const handlers = new Map<string, IpcListener>()
  registerAgentIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener) } },
    bridge,
    projects: { touch: () => { throw new Error('Unexpected project mutation') } },
    pushProjects: () => { throw new Error('Unexpected project mutation') }
  })
  const frame = {}
  const event = { sender: { id: OWNER_ID, mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing fixture IPC handler: ${channel}`)
    return listener(event, ...args)
  }
  return { ...session, ...original, root, bridge, internals, send, runStore, backendPool,
    pendingRequests, createBackend, recreated, handlers, event, invoke }
}

type Fixture = ReturnType<typeof fixture>

function operation(h: Fixture, overrides: Partial<RunOperation> = {}): RunOperation {
  return {
    id: 'finished-run', cwd: h.cwd, sessionPath: h.request.sessionPath, sessionId: h.request.sessionId,
    kind: 'prompt', state: 'completed', createdAt: 10, agentStartedAt: 11, settledAt: 12,
    prompt: { message: 'historical prompt', images: [] }, promptPreview: 'historical prompt',
    usage: { ...EMPTY_TOKEN_USAGE, total: 23, costUsd: 0.25 }, tools: [], compactions: [], revision: 0,
    ...overrides
  }
}

function unchanged(h: Fixture, before: Buffer): void {
  expect(readFileSync(h.request.sessionPath)).toEqual(before)
  expect(h.client.prompt).not.toHaveBeenCalled()
  expect(h.client.steer).not.toHaveBeenCalled()
}

function addPending(h: Fixture, kind: 'permission' | 'extension', sessionPath = h.request.sessionPath): void {
  const shared = {
    id: 'pending', cwd: h.cwd, sessionPath, createdAt: 1, timeoutAt: 60_001
  }
  const pending = {
    backendKey: sessionPath === h.request.sessionPath ? h.backend.key : 'background-backend',
    extensionRequestId: 'extension-pending', timeout: setTimeout(() => undefined, 60_000)
  }
  if (kind === 'permission') {
    h.pendingRequests.addToolPermission(shared.id, { ...pending, request: {
      ...shared, toolName: 'write', category: 'write', policyCategories: ['write'],
      summary: 'Write a file', detail: 'fixture', risks: [], canRemember: true
    } })
  } else {
    h.pendingRequests.addExtensionUi(shared.id, { ...pending, request: {
      ...shared, method: 'confirm', title: 'Confirm fixture action'
    } })
  }
}

function holdStop(h: Fixture) {
  const stopped = deferred<void>(undefined)
  h.client.stop.mockImplementation(async () => {
    h.client.process = null // pinned SDK behavior: this alone does NOT prove exit
    h.stopStarted.resolve()
    await stopped.promise
  })
  return stopped
}

async function finishRestart(h: Fixture): Promise<void> {
  await Promise.all(h.backendPool.pendingStarts())
  // Also await a state read; the deferred ensureActiveBackend continuation uses
  // only this in-process client, never a real runtime or a model request.
  await h.bridge.getSessionInfo()
}

async function timeoutWriter(h: Fixture): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const stopped = holdStop(h)
  stopped.resolve()
  const result = observe(h.bridge.revertMessage(h.request, OWNER_ID))
  await h.stopStarted.promise
  await vi.advanceTimersByTimeAsync(5_001)
  expect(await result).toMatchObject({ ok: false, error: expect.objectContaining({
    message: expect.stringMatching(/Timed out.*shutdown/)
  }) })
}

describe('AgentBridge conversation-only message revert', () => {
  afterEach(async () => {
    // Release all deliberate race barriers, including on an assertion failure.
    releases.splice(0).forEach((release) => release())
    children.forEach((child) => child.exit())
    // A released undo can still append/read the JSONL and schedule a cold
    // restart. Settle it before snapshotting starts or deleting its fixtures.
    await Promise.all(observations.splice(0))
    await Promise.all(pools.splice(0).flatMap((pool) => pool.pendingStarts()).map((start) => start.catch(() => undefined)))
    children.splice(0).forEach((child) => child.exit())
    releases.splice(0).forEach((release) => release())
    requestStores.splice(0).forEach((store) => store.clearAll())
    await Promise.all(stores.splice(0).map((store) => store.flush()))
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  })

  it('requires the bound main-window owner and rejects subframes at the IPC boundary', async () => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID + 1)).rejects.toThrow('所属主窗口')
    const listener = h.handlers.get(IPC.AgentRevertMessage)!
    expect(() => listener({ ...h.event, senderFrame: {} } as IpcMainInvokeEvent, h.request)).toThrow('主窗口')
    h.internals.win = null
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('所属主窗口')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it.each([
    ['missing request', null], ['missing expected leaf', { expectedLeafId: undefined }],
    ['empty path', { sessionPath: '' }], ['oversize path', { sessionPath: 'x'.repeat(16_001) }],
    ['empty session id', { sessionId: '' }], ['oversize entry id', { entryId: 'x'.repeat(201) }],
    ['non-string leaf', { expectedLeafId: 7 }]
  ] satisfies [string, Record<string, unknown> | null][])('rejects malformed IPC data: %s', async (_name, patch) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    const request = patch === null ? null : { ...h.request, ...patch }
    await expect(h.bridge.revertMessage(request as MessageRevertRequest, OWNER_ID)).rejects.toThrow('参数')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it.each(['active path', 'backend path', 'no backend', 'starting', 'error'] as const)(
    'rejects a backend which is not the ready selected session: %s', async (kind) => {
      const h = fixture()
      const before = readFileSync(h.request.sessionPath)
      if (kind === 'active path') h.internals.activeSessionPath = join(h.root, 'other.jsonl')
      else if (kind === 'backend path') h.backend.sessionPath = join(h.root, 'other.jsonl')
      else if (kind === 'no backend') h.backendPool.delete(h.backend.key)
      else h.backend.phase = kind
      await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('所选会话就绪')
      expect(h.client.getState).not.toHaveBeenCalled()
      expect(h.client.stop).not.toHaveBeenCalled()
      unchanged(h, before)
    }
  )

  it.each([
    ['streaming', { isStreaming: true }], ['compacting', { isCompacting: true }],
    ['SDK pending queue', { pendingMessageCount: 1 }], ['session id', { sessionId: 'stale-id' }],
    ['session path', { sessionFile: '/different-session.jsonl' }], ['missing session file', { sessionFile: undefined }]
  ] satisfies [string, Partial<RpcState>][])('revalidates RPC %s before stopping the writer', async (_name, patch) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    Object.assign(h.state, patch)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('会话状态已变化')
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.backend.busy).toBe(false)
    expect(h.backend.historyMutation).toBe(false)
    expect(h.internals.messageRevertInFlight).toBe(false)
    unchanged(h, before)
  })

  it.each(['stale leaf', 'null leaf', 'missing entry', 'assistant entry'] as const)(
    'requires an exact expected leaf and a selected-branch user entry: %s', async (kind) => {
      const h = fixture()
      const before = readFileSync(h.request.sessionPath)
      const request = { ...h.request }
      if (kind === 'stale leaf') request.expectedLeafId = h.parentId
      else if (kind === 'null leaf') request.expectedLeafId = null
      else request.entryId = kind === 'missing entry' ? 'missing' : h.oldReply
      await expect(h.bridge.revertMessage(request, OWNER_ID)).rejects.toThrow('分支已变化')
      expect(h.client.stop).not.toHaveBeenCalled()
      unchanged(h, before)
    }
  )

  it.each([
    ['running', { busy: true }], ['compacting', { compacting: true }], ['retry', { awaitingRetry: true }],
    ['active run', { activeRunId: 'active' }], ['pending run', { pendingRunIds: ['pending'] }],
    ['local follow-up', { localFollowUps: [{ runId: 'queued', text: 'later', images: [] }] }],
    ['companion run', { companionRunIds: ['companion'] }], ['direct steering', { directSteering: ['direct'] }],
    ['native steering', { rawQueue: { steering: ['steer'], followUp: [] } }],
    ['native follow-up', { rawQueue: { steering: [], followUp: ['follow'] } }],
    ['dispatch flag', { localQueueDispatching: true }],
    ['dispatch promise', { localQueueDispatchPromise: Promise.resolve() }],
    ['completion promise', { runCompletionPromise: Promise.resolve() }],
    ['checkpoint creation', { checkpointCreatePromise: Promise.resolve() }],
    ['checkpoint refresh', { checkpointRefreshPromise: Promise.resolve(null) }],
    ['subagents transition', { subagentsModePending: true }]
  ] satisfies [string, Partial<BackendRecord>][])('holds the idle gate for %s', async (_name, patch) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    Object.assign(h.backend, patch)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(h.createBackend).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it.each(['stopping', 'provider mutation', 'new session', 'pending backend start'] as const)(
    'rejects a conflicting bridge operation: %s', async (kind) => {
      const h = fixture()
      const before = readFileSync(h.request.sessionPath)
      if (kind === 'stopping') h.internals.stopping = true
      else if (kind === 'provider mutation') h.internals.providerMutationInFlight = true
      else if (kind === 'new session') h.internals.newSessionInFlight = Promise.resolve()
      else {
        const start = deferred(h.backend)
        void h.backendPool.startWithLimit('pending-start', () => start.promise, () => false, async () => undefined)
      }
      await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
      expect(h.client.getState).not.toHaveBeenCalled()
      expect(h.client.stop).not.toHaveBeenCalled()
      unchanged(h, before)
    }
  )

  it.each(['permission', 'extension'] as const)('rejects a pending %s interaction for the selected session', async (kind) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    addPending(h, kind)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
    expect(h.client.stop).not.toHaveBeenCalled()
    expect(kind === 'permission' ? h.bridge.getPendingToolPermissionRequests() : h.bridge.getPendingExtensionUiRequests())
      .toHaveLength(1)
    unchanged(h, before)
  })

  it.each(['queued', 'dispatching', 'running', 'ending'] as const)('consults durable %s runs even when the local queue is empty', async (state) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    h.runStore.create(operation(h, { state }))
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
    expect(h.client.stop).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it('finds an older queued run beyond even the maximum RunStore display page', async () => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    h.runStore.create(operation(h, { id: 'hidden-queue', state: 'queued', createdAt: 1, agentStartedAt: undefined }))
    for (let n = 0; n < 101; n++) h.runStore.create(operation(h, { id: `finished-${n}`, createdAt: 100 + n }))
    expect(h.runStore.list({ sessionPath: h.request.sessionPath, limit: 100 })).toHaveLength(100)
    expect(h.runStore.list({ sessionPath: h.request.sessionPath, limit: 100 }).some((run) => run.id === 'hidden-queue')).toBe(false)
    expect(h.runStore.hasUnsettledSessionRuns(h.request.sessionPath)).toBe(true)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
    expect(h.client.stop).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it('commits one marker in the same file, preserves old entries/files/checkpoints/billing, and returns the exact draft', async () => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath, 'utf8')
    const oldEntries = h.manager.getEntries()
    const workspaceFile = join(h.cwd, 'edited-by-agent.txt')
    writeFileSync(workspaceFile, 'Keep project changes made after this prompt\n')
    const checkpoint = { id: 'checkpoint', cwd: h.cwd, createdAt: 1,
      worktreeTree: 'historical-worktree-tree', indexTree: 'historical-index-tree', state: 'ready' as const }
    h.backend.checkpoint = checkpoint
    h.backend.checkpointStatus = { id: checkpoint.id, cwd: h.cwd, createdAt: 1,
      state: 'ready', hasChanges: true, changedFileCount: 1 }
    h.runStore.create(operation(h, { checkpoint, contextTokens: 100, contextPressure: 0.5,
      liveUsage: { ...EMPTY_TOKEN_USAGE, total: 9 } }))
    const priorRun = h.runStore.get('finished-run')!
    // Unrelated projects' queues and prompts are not authority over this session.
    const backgroundPath = join(h.root, 'background.jsonl')
    h.runStore.create(operation(h, { id: 'background-queue', sessionPath: backgroundPath, state: 'queued' }))
    addPending(h, 'permission', backgroundPath)
    addPending(h, 'extension', backgroundPath)
    await h.bridge.getEntriesPage(undefined, 1, h.request.sessionPath) // seed the old manager/signature cache
    expect(h.internals.sessionManagers.has(h.request.sessionPath)).toBe(true)

    const result: MessageRevertResult = await h.bridge.revertMessage(h.request, OWNER_ID)
    await finishRestart(h)
    expect(result).toEqual({ sessionPath: h.request.sessionPath, sessionId: h.request.sessionId,
      entryId: h.selected, previousLeafId: h.request.expectedLeafId,
      leafId: result.leafId, text: h.text, images: h.images })
    const reopened = SessionManager.open(h.request.sessionPath)
    const after = readFileSync(h.request.sessionPath, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length).trim().split('\n')).toHaveLength(1)
    expect(reopened.getSessionId()).toBe(h.request.sessionId)
    expect(reopened.getLeafId()).toBe(result.leafId)
    expect(reopened.getEntries().slice(0, -1)).toEqual(oldEntries)
    expect(reopened.getBranch(h.request.expectedLeafId!)).toEqual(oldEntries)
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([...h.prefixIds, result.leafId])
    expect(reopened.getEntry(result.leafId)).toMatchObject({ type: 'custom', customType: 'pion-message-revert',
      parentId: h.parentId, data: { version: 1, entryId: h.selected, previousLeafId: h.request.expectedLeafId } })
    expect(h.internals.activeSessionPath).toBe(h.request.sessionPath)
    expect(h.internals.activeKey).toBe(h.backend.key)
    expect(h.internals.desiredModes.get(h.backend.key)).toBe('plan')
    expect(h.createBackend).toHaveBeenCalledTimes(1)
    expect(h.createBackend).toHaveBeenCalledWith(h.backend.key, h.cwd, h.request.sessionPath)
    expect(h.backendPool.get(h.backend.key)).toBe(h.recreated[0].backend)
    expect(h.recreated[0].client.prompt).not.toHaveBeenCalled()
    expect(h.client.stop).toHaveBeenCalledTimes(1)
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(readFileSync(workspaceFile, 'utf8')).toBe('Keep project changes made after this prompt\n')
    expect(existsSync(join(h.cwd, '.git'))).toBe(false) // no repository or Git subprocess is needed by undo
    expect(h.backend.checkpointStatus?.state).toBe('ready')
    expect(h.runStore.get('finished-run')).toEqual({ ...priorRun, contextTokens: undefined,
      contextPressure: undefined, contextUsagePending: true, liveUsage: undefined, revision: priorRun.revision + 1 })
    expect(h.runStore.get('background-queue')?.state).toBe('queued')
    expect(h.bridge.getPendingToolPermissionRequests()).toHaveLength(1)
    expect(h.bridge.getPendingExtensionUiRequests()).toHaveLength(1)
  })

  it.each(['SDK stop', 'process exit'] as const)('does not open or append with the SDK while %s is still pending', async (last) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    const stopped = holdStop(h)
    const open = vi.spyOn(SessionManager, 'open') // observe the real SDK, do not replace it
    const append = vi.spyOn(SessionManager.prototype, 'appendCustomEntry')
    const result = observe(h.bridge.revertMessage(h.request, OWNER_ID))
    await h.stopStarted.promise
    expect(h.client.process).toBeNull()
    if (last === 'SDK stop') h.child.exit()
    else stopped.resolve()
    await Promise.resolve()
    expect(open).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(h.createBackend).not.toHaveBeenCalled()
    expect(h.backend.historyMutation).toBe(true)
    expect(h.backend.busy).toBe(true)
    expect(h.internals.messageRevertInFlight).toBe(true)
    unchanged(h, before)
    stopped.resolve()
    h.child.exit()
    expect(await result).toMatchObject({ ok: true, value: { text: h.text, images: h.images } })
    expect(append).toHaveBeenCalledWith('pion-message-revert', expect.objectContaining({ entryId: h.selected }))
    await finishRestart(h)
  })

  it('quarantines a timed-out null-handle writer instead of retrying, deleting, or restarting it', async () => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    const open = vi.spyOn(SessionManager, 'open')
    await timeoutWriter(h)
    expect(open).not.toHaveBeenCalled()
    expect(h.backend).toMatchObject({ historyStopFailed: true, phase: 'error', historyMutation: false, busy: false })
    expect(h.bridge.getStatus()).toMatchObject({ phase: 'error', error: expect.stringContaining('重启 Pion') })
    expect(h.internals.messageRevertInFlight).toBe(false)
    expect(h.backendPool.get(h.backend.key)).toBe(h.backend)
    expect(h.internals.backendKeysBySessionPath.get(h.request.sessionPath)).toBe(h.backend.key)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('就绪')
    await expect(h.invoke(IPC.AgentSend, 'must not reuse writer')).rejects.toThrow('重启 Pion')
    await expect(h.invoke(IPC.AgentQueue, 'must not enqueue')).rejects.toThrow('重启 Pion')
    await expect(h.invoke(IPC.AgentDeleteSession, h.request.sessionPath)).rejects.toThrow('重启 Pion')
    await expect(h.invoke(IPC.AgentSwitchSession, h.request.sessionPath)).rejects.toThrow('重启 Pion')
    expect(h.client.stop).toHaveBeenCalledTimes(1)
    expect(h.createBackend).not.toHaveBeenCalled()
    expect(h.child.listenerCount('exit')).toBe(0)
    expect(h.child.listenerCount('error')).toBe(0)
    // A late exit cannot retrospectively authorize the failed undo or clear quarantine.
    h.child.exit()
    await Promise.resolve()
    expect(h.backend.historyStopFailed).toBe(true)
    unchanged(h, before)
  })

  it.each([
    [IPC.AgentRenameSession, ['renamed after uncertain exit']],
    [IPC.AgentCompact, ['must not compact a quarantined writer']]
  ] satisfies [string, string[]][])('does not reuse a quarantined writer through %s either', async (channel, args) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    await timeoutWriter(h)
    await expect(h.invoke(channel, ...args)).rejects.toThrow(/重启 Pion|退出状态/)
    expect(h.client.setSessionName).not.toHaveBeenCalled()
    expect(h.client.compact).not.toHaveBeenCalled()
    expect(h.createBackend).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it('keeps path tombstones across logical stop/start and refuses a cold switch or writer', async () => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    await timeoutWriter(h)
    await h.bridge.stop()
    expect(h.backendPool.size).toBe(0)
    expect(h.internals.backendKeysBySessionPath.size).toBe(0)
    expect(h.internals.quarantinedSessionPaths).toEqual(new Set([h.request.sessionPath]))
    expect(h.client.stop).toHaveBeenCalledTimes(1) // never retry using the SDK's null handle
    const open = vi.spyOn(SessionManager, 'open')
    await h.bridge.start(h.cwd)
    const alias = `${h.internals.sessionDirFor(h.cwd)}/./${basename(h.request.sessionPath)}`
    await expect(h.bridge.switchSession(alias)).rejects.toThrow('重启 Pion')
    await expect(h.bridge.startVerificationRepair(alias, h.cwd, 'must not reload writer')).rejects.toThrow('重启 Pion')
    await expect(h.bridge.renameSession('must not append a name', alias)).rejects.toThrow('重启 Pion')
    await expect(h.bridge.deleteSession(alias)).rejects.toThrow('重启 Pion')
    await expect(h.bridge.copySession(alias)).rejects.toThrow('重启 Pion')
    await expect(h.bridge.forkSession(alias, h.selected)).rejects.toThrow('重启 Pion')
    expect(open).not.toHaveBeenCalled() // SDK open itself can repair/rewrite JSONL
    expect(h.createBackend).not.toHaveBeenCalled()
    // Even a stale logical selection with no retained backend cannot authorize
    // ensureActiveBackend to create a new writer or the client getter to reuse it.
    h.internals.activeKey = alias
    h.internals.activeSessionPath = alias
    await expect(h.bridge.send('must not reload selected writer')).rejects.toThrow('重启 Pion')
    await expect(h.bridge.compactNow()).rejects.toThrow('重启 Pion')
    expect(h.createBackend).not.toHaveBeenCalled()
    h.child.exit()
    await h.bridge.stop()
    expect(h.internals.quarantinedSessionPaths).toEqual(new Set([h.request.sessionPath]))
    unchanged(h, before)
  })

  it('allows an unrelated session after stop without releasing the quarantined path', async () => {
    const h = fixture()
    const other = transcript(h.root, 'unrelated-project')
    const before = readFileSync(h.request.sessionPath)
    await timeoutWriter(h)
    await h.bridge.stop()
    await h.bridge.start(other.cwd)
    await expect(h.bridge.switchSession(other.request.sessionPath)).resolves.toEqual({ cancelled: false })
    await finishRestart(h)
    expect(h.createBackend).toHaveBeenCalledExactlyOnceWith(other.request.sessionPath, other.cwd, other.request.sessionPath)
    await expect(h.bridge.switchSession(h.request.sessionPath)).rejects.toThrow('重启 Pion')
    expect(h.internals.activeSessionPath).toBe(other.request.sessionPath)
    expect(h.internals.quarantinedSessionPaths).toEqual(new Set([h.request.sessionPath]))
    unchanged(h, before)
  })

  it.each(['retained backend', 'logical stop'] as const)('rejects migration of a quarantined source before filesystem changes after %s', async (phase) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    const targetCwd = join(h.root, 'migration-target')
    const targetDir = h.internals.sessionDirFor(targetCwd)
    await timeoutWriter(h)
    if (phase === 'logical stop') {
      await h.bridge.stop()
      await h.bridge.start(h.cwd)
      // Model a restored/cached logical selection without a backend record.
      h.internals.activeKey = h.request.sessionPath
      h.internals.activeSessionPath = h.request.sessionPath
      expect(h.backendPool.size).toBe(0)
    }
    h.client.getState.mockClear()
    const open = vi.spyOn(SessionManager, 'open')
    await expect(h.bridge.migrateSessionToProject(targetCwd)).rejects.toThrow('重启 Pion')
    expect(h.client.getState).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(existsSync(targetDir)).toBe(false)
    expect(h.createBackend).not.toHaveBeenCalled()
    unchanged(h, before)
  })

  it('rejects migration onto a quarantined destination after its backend record is cleared', async () => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    await timeoutWriter(h)
    await h.bridge.stop()
    const sourceCwd = join(h.root, 'migration-source')
    mkdirSync(sourceCwd)
    const source = join(sourceCwd, basename(h.request.sessionPath))
    const lines = before.toString('utf8').split('\n')
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: sourceCwd })
    writeFileSync(source, lines.join('\n'))
    const sourceBefore = readFileSync(source)
    await h.bridge.start(sourceCwd)
    h.internals.activeKey = source
    h.internals.activeSessionPath = source
    await expect(h.bridge.migrateSessionToProject(h.cwd)).rejects.toThrow('重启 Pion')
    expect(h.createBackend).not.toHaveBeenCalled()
    expect(readFileSync(source)).toEqual(sourceBefore)
    unchanged(h, before)
  })

  it.each(['state', 'stop'] as const)('does not mutate either session after selection changes during %s', async (phase) => {
    const h = fixture()
    const other = transcript(h.root, 'other-project')
    const before = readFileSync(h.request.sessionPath)
    const otherBefore = readFileSync(other.request.sessionPath)
    const state = deferred(h.state)
    const entered = deferred<void>(undefined)
    const stopped = holdStop(h)
    if (phase === 'state') h.client.getState.mockImplementationOnce(async () => { entered.resolve(); return state.promise })
    const result = observe(h.bridge.revertMessage(h.request, OWNER_ID))
    await (phase === 'state' ? entered.promise : h.stopStarted.promise)
    // Direct lifecycle selection simulates an already-entered asynchronous switch;
    // new IPC switches are separately rejected by the SessionOperation reservation.
    await expect(h.bridge.switchSession(other.request.sessionPath)).resolves.toEqual({ cancelled: false })
    state.resolve(h.state)
    stopped.resolve()
    h.child.exit()
    expect(await result).toMatchObject({ ok: false, error: expect.objectContaining({ message: '会话已切换，未撤销消息' }) })
    expect(h.internals.activeSessionPath).toBe(other.request.sessionPath)
    expect(h.backendPool.get(h.backend.key)).toBe(phase === 'state' ? h.backend : undefined)
    expect(h.client.stop).toHaveBeenCalledTimes(phase === 'state' ? 0 : 1)
    expect(h.createBackend).not.toHaveBeenCalled()
    expect(h.internals.messageRevertInFlight).toBe(false)
    expect(readFileSync(other.request.sessionPath)).toEqual(otherBefore)
    unchanged(h, before)
  })

  it('detects an away-and-back selection generation and a changed owner during state loading', async () => {
    for (const change of ['generation', 'owner'] as const) {
      const h = fixture()
      const before = readFileSync(h.request.sessionPath)
      const state = deferred(h.state)
      h.client.getState.mockReturnValueOnce(state.promise)
      const result = observe(h.bridge.revertMessage(h.request, OWNER_ID))
      if (change === 'generation') h.internals.sessionSelectionGeneration += 2
      else h.internals.win!.webContents.id += 1
      state.resolve(h.state)
      expect(await result).toMatchObject({ ok: false, error: expect.objectContaining({ message: '会话已切换，未撤销消息' }) })
      expect(h.client.stop).not.toHaveBeenCalled()
      unchanged(h, before)
    }
  })

  it('revalidates the leaf on disk after the old writer exits, not only its earlier RPC snapshot', async () => {
    const h = fixture()
    const stopped = holdStop(h)
    const result = observe(h.bridge.revertMessage(h.request, OWNER_ID))
    await h.stopStarted.promise
    // Simulate the old process's final persisted record before its exit signal.
    const finalRecord = SessionManager.open(h.request.sessionPath).appendSessionInfo('late persisted name')
    const before = readFileSync(h.request.sessionPath)
    stopped.resolve()
    h.child.exit()
    expect(await result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('分支已变化') }) })
    await finishRestart(h)
    expect(SessionManager.open(h.request.sessionPath).getLeafId()).toBe(finalRecord)
    expect(h.backend.historyStopFailed).not.toBe(true)
    unchanged(h, before)
  })

  it.each(['plan', 'build'] as const)('does not advance the expected leaf at real plan-only shutdown in %s mode', async (mode) => {
    const h = fixture()
    const writer = SessionManager.open(h.request.sessionPath)
    const plan = planLifecycle(writer)
    await plan.event('session_start')
    await plan.command('start')
    if (mode === 'build') await plan.command('exit')
    // The current leaf is a real extension state entry, not an artificial RPC
    // snapshot that omits the runtime's session_shutdown behavior.
    h.request.expectedLeafId = writer.getLeafId()
    const oldBranch = writer.getBranch()
    const before = readFileSync(h.request.sessionPath, 'utf8')
    let shutdownLeaf: string | null = null
    h.client.getEntries.mockImplementation(async () => ({ entries: writer.getEntries(), leafId: writer.getLeafId() }))
    h.client.stop.mockImplementation(async () => {
      h.stopStarted.resolve()
      await plan.event('session_shutdown')
      shutdownLeaf = writer.getLeafId()
      h.child.exit()
      h.client.process = null
    })
    const result = await h.bridge.revertMessage(h.request, OWNER_ID)
    await finishRestart(h)
    const reopened = SessionManager.open(h.request.sessionPath)
    expect(shutdownLeaf).toBe(h.request.expectedLeafId)
    expect(result).toMatchObject({ previousLeafId: h.request.expectedLeafId, text: h.text, images: h.images })
    expect(reopened.getLeafId()).toBe(result.leafId)
    expect(reopened.getBranch(h.request.expectedLeafId!)).toEqual(oldBranch)
    const after = readFileSync(h.request.sessionPath, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length).trim().split('\n')).toHaveLength(1) // only the undo marker
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('still rejects a stale leaf when plan shutdown legitimately persists newly captured tools', async () => {
    const h = fixture()
    const writer = SessionManager.open(h.request.sessionPath)
    writer.appendCustomEntry('plan-mode-state', { version: 1, enabled: true })
    h.request.expectedLeafId = writer.getLeafId()
    const before = readFileSync(h.request.sessionPath, 'utf8')
    const oldBranch = writer.getBranch()
    const plan = planLifecycle(writer)
    await plan.event('session_start') // legacy entry has no saved tools; restoration captures them
    h.client.getEntries.mockImplementation(async () => ({ entries: writer.getEntries(), leafId: writer.getLeafId() }))
    h.client.stop.mockImplementation(async () => {
      h.stopStarted.resolve()
      await plan.event('session_shutdown')
      h.child.exit()
      h.client.process = null
    })
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('分支已变化')
    await finishRestart(h)
    const reopened = SessionManager.open(h.request.sessionPath)
    expect(reopened.getLeafId()).not.toBe(h.request.expectedLeafId)
    expect(reopened.getBranch(h.request.expectedLeafId!)).toEqual(oldBranch)
    expect(reopened.getBranch().at(-1)).toMatchObject({ type: 'custom', customType: 'plan-mode-state',
      data: { enabled: true, toolsBeforePlanMode: ['read', 'bash', 'edit', 'write', 'pion_ask_user'] } })
    const after = readFileSync(h.request.sessionPath, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length).trim().split('\n')).toHaveLength(1)
    expect(h.backend.historyStopFailed).not.toBe(true)
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('returns a successful draft even when the post-commit renderer refresh fails', async () => {
    const h = fixture()
    const error = new Error('renderer refresh failed after durable commit')
    const warn = vi.spyOn(console, 'warn')
    h.send.mockImplementation((channel) => {
      if (channel === IPC_EVENTS.AgentState) throw error
      return undefined
    })
    const result = await h.bridge.revertMessage(h.request, OWNER_ID)
    await finishRestart(h)
    expect(result).toMatchObject({ text: h.text, images: h.images, sessionPath: h.request.sessionPath })
    expect(SessionManager.open(h.request.sessionPath).getLeafId()).toBe(result.leafId)
    expect(warn).toHaveBeenCalledWith('[pion] reverted history refresh failed:', error)
    expect(h.internals.messageRevertInFlight).toBe(false)
    expect(h.createBackend).toHaveBeenCalledTimes(1)
    expect(h.recreated[0].client.prompt).not.toHaveBeenCalled()
  })

  it.each(['mode metadata', 'restart notification', 'cold start', 'synchronous restart setup'] as const)(
    'keeps the durable undo result when post-commit %s fails', async (phase) => {
      const h = fixture()
      const error = new Error(`post-commit ${phase} failed`)
      const warn = vi.spyOn(console, 'warn')
      if (phase === 'mode metadata') vi.spyOn(h.internals.desiredModes, 'set').mockImplementationOnce(() => { throw error })
      else if (phase === 'restart notification') h.send.mockImplementation((channel) => {
        if (channel === IPC_EVENTS.AgentStatus) throw error
        return undefined
      })
      else if (phase === 'cold start') h.createBackend.mockRejectedValueOnce(error)
      else vi.spyOn(h.internals, 'ensureActiveBackend').mockImplementationOnce(() => { throw error })
      const result = await h.bridge.revertMessage(h.request, OWNER_ID)
      // Failed starts are expected here, not a reason to discard the draft.
      await Promise.all(h.backendPool.pendingStarts().map((start) => start.catch(() => undefined)))
      expect(result).toMatchObject({ text: h.text, images: h.images, sessionPath: h.request.sessionPath })
      expect(SessionManager.open(h.request.sessionPath).getLeafId()).toBe(result.leafId)
      expect(h.internals.messageRevertInFlight).toBe(false)
      expect(h.backend).toMatchObject({ historyMutation: false, busy: false })
      expect(h.backend.historyStopFailed).not.toBe(true)
      if (phase === 'mode metadata') expect(warn).toHaveBeenCalledWith('[pion] reverted history refresh failed:', error)
      expect(h.client.prompt).not.toHaveBeenCalled()
    }
  )

  it.each(['backend start', 'state read'] as const)('reserves IPC send before its pre-dispatch %s await', async (phase) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    const start = deferred<void>(undefined)
    const state = deferred(h.state)
    const entered = deferred<void>(undefined)
    const dispatchError = new Error('fixture dispatch rejected')
    if (phase === 'backend start') h.backend.startPromise = start.promise
    else h.client.getState.mockImplementationOnce(async () => { entered.resolve(); return state.promise })
    h.client.prompt.mockRejectedValueOnce(dispatchError)
    const sending = observe(h.invoke(IPC.AgentSend, 'pre-dispatch prompt'))
    if (phase === 'state read') await entered.promise
    expect(h.internals.sessionOperationsInFlight).toBe(1)
    expect(h.backend.busy).toBe(false)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
    expect(h.client.stop).not.toHaveBeenCalled()
    unchanged(h, before)
    start.resolve()
    state.resolve(h.state)
    expect(await sending).toMatchObject({ ok: false, error: dispatchError })
    expect(h.internals.sessionOperationsInFlight).toBe(0)
    expect(h.backend.busy).toBe(false)
    // A rejected operation releases its reservation; it is not a permanent lock.
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).resolves.toMatchObject({ text: h.text })
    await finishRestart(h)
  })

  it('counts overlapping reservations until the last resolves and releases synchronous throws', async () => {
    const h = fixture()
    const first = deferred('first')
    const last = deferred('last')
    const a = h.bridge.withSessionOperation(() => first.promise)
    const b = observe(h.bridge.withSessionOperation(() => last.promise))
    expect(h.internals.sessionOperationsInFlight).toBe(2)
    first.resolve('first')
    await expect(a).resolves.toBe('first')
    expect(h.internals.sessionOperationsInFlight).toBe(1)
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('清空排队消息')
    last.reject(new Error('last failed'))
    expect(await b).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'last failed' }) })
    await expect(h.bridge.withSessionOperation(() => { throw new Error('synchronous failure') })).rejects.toThrow('synchronous failure')
    expect(h.internals.sessionOperationsInFlight).toBe(0)
    expect(h.client.stop).not.toHaveBeenCalled()
  })

  it.each(['state', 'stop'] as const)('rejects new IPC mutations throughout the undo %s barrier', async (phase) => {
    const h = fixture()
    const before = readFileSync(h.request.sessionPath)
    const state = deferred(h.state)
    const entered = deferred<void>(undefined)
    const stopped = holdStop(h)
    if (phase === 'state') h.client.getState.mockImplementationOnce(async () => { entered.resolve(); return state.promise })
    const result = observe(h.bridge.revertMessage(h.request, OWNER_ID))
    await (phase === 'state' ? entered.promise : h.stopStarted.promise)
    const mutations: [string, unknown[]][] = [
      [IPC.AgentSend, ['new prompt']], [IPC.AgentQueue, ['new follow-up']],
      [IPC.AgentRenameSession, ['new name']], [IPC.AgentCompact, []], [IPC.AgentSetMode, ['build']],
      [IPC.AgentNewSession, []], [IPC.AgentSwitchSession, [h.request.sessionPath]],
      [IPC.AgentDeleteSession, [h.request.sessionPath]], [IPC.AgentCopySession, [h.request.sessionPath]],
      [IPC.AgentSetModel, ['anthropic', 'other-model']], [IPC.AgentStop, []]
    ]
    for (const [channel, args] of mutations) await expect(h.invoke(channel, ...args)).rejects.toThrow('正在撤销消息')
    await expect(h.bridge.revertMessage(h.request, OWNER_ID)).rejects.toThrow('正在撤销消息')
    expect(h.internals.sessionOperationsInFlight).toBe(0)
    expect(h.internals.stopping).toBe(false)
    expect(h.client.compact).not.toHaveBeenCalled()
    expect(h.client.setSessionName).not.toHaveBeenCalled()
    expect(h.client.setModel).not.toHaveBeenCalled()
    unchanged(h, before)
    state.resolve(h.state)
    stopped.resolve()
    h.child.exit()
    expect(await result).toMatchObject({ ok: true, value: { text: h.text } })
    await finishRestart(h)
    await expect(h.invoke(IPC.AgentSetAutoRetry, false)).resolves.toBeUndefined()
    expect(h.recreated[0].client.setAutoRetry).toHaveBeenCalledWith(false)
    expect(h.internals.sessionOperationsInFlight).toBe(0)
  })

  it('pages, indexes, and restores task history only from the selected branch, with coherent mode and tool results', async () => {
    const h = fixture()
    const stalePage = await h.bridge.getEntriesPage(undefined, 1, h.request.sessionPath)
    expect(stalePage).toMatchObject({ mode: 'build', taskSnapshot: [{ id: 2, title: 'Abandoned task' }] })
    expect((await h.bridge.getHistoryIndex(h.request.sessionPath))?.landmarks.map((item) => item.entryId))
      .toEqual([h.first, h.selected, h.later])
    const result = await h.bridge.revertMessage(h.request, OWNER_ID)
    await finishRestart(h)
    const ids = [...h.prefixIds, result.leafId]
    const lastPage = await h.bridge.getEntriesPage(undefined, 1, h.request.sessionPath)
    expect(lastPage).toMatchObject({ start: ids.length - 1, end: ids.length, total: ids.length,
      leafId: result.leafId, mode: 'plan', entries: [{ id: result.leafId }],
      taskSnapshot: [{ id: 1, title: 'Kept task', status: 'completed' }] })
    expect((await h.bridge.getEntriesPage())?.entries.map((entry) => entry.id)).toEqual(ids)
    const callEnd = h.prefixIds.indexOf(h.call) + 1
    const callPage = await h.bridge.getEntriesPage(callEnd, 1, h.request.sessionPath)
    expect(callPage?.entries.map((entry) => entry.id)).toEqual([h.call])
    expect(callPage?.toolResults.map((entry) => entry.id)).toEqual([h.keptResult, h.keptTasks])
    expect(callPage?.toolResults.some((entry) => entry.id === h.oldResult)).toBe(false)
    expect(callPage?.mode).toBe('plan')
    expect(callPage?.taskSnapshot).toEqual(lastPage?.taskSnapshot)
    const index = await h.bridge.getHistoryIndex(h.request.sessionPath)
    expect(index).toMatchObject({ sessionPath: h.request.sessionPath, leafId: result.leafId, totalEntries: ids.length,
      landmarks: [{ entryId: h.first, entryIndex: h.prefixIds.indexOf(h.first), ordinal: 1,
        snippet: 'kept prompt', responseSnippet: 'kept reply' }] })
    expect(index?.landmarks).toHaveLength(1)
    expect(await h.bridge.getSessionTaskHistory(h.request.sessionPath)).toEqual([{
      key: h.first, entryId: h.first, ordinal: 1, prompt: 'kept prompt',
      timestamp: h.manager.getEntry(h.first)!.timestamp,
      tasks: [{ id: 1, title: 'Kept task', status: 'completed', activeForm: undefined, description: undefined }]
    }])
    const reopened = SessionManager.open(h.request.sessionPath)
    expect(reopened.getEntry(h.oldTasks)).toBeDefined()
    expect(reopened.getEntry(h.oldMode)).toBeDefined()
    const before = readFileSync(h.request.sessionPath)
    // Full RPC getEntries still includes abandoned entries; ancestry, not mere
    // membership in that response, must reject a second undo of the old prompt.
    await expect(h.bridge.revertMessage({ ...h.request, expectedLeafId: result.leafId }, OWNER_ID)).rejects.toThrow('分支已变化')
    expect(h.recreated[0].client.stop).not.toHaveBeenCalled()
    expect(readFileSync(h.request.sessionPath)).toEqual(before)
  })
})
