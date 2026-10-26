import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { formatSessionCompletionNotification } from '../../src/main/system-notifications'
import type { BackendRecord, BackendSessionInfoSnapshot } from '../../src/main/agent/types'
import type { PendingRequestStore } from '../../src/main/agent/pending-requests'
import { RunStore } from '../../src/main/run-store'
import { TOOL_PERMISSION_MARKER } from '../../src/main/tool-permissions'
import { QUESTION_WAIT_WIDGET_KEY } from '../../src/shared/question-settings'
import { SUBAGENT_SESSION_WIDGET_KEY } from '../../src/shared/subagent-sessions'
import type { RunOperation } from '../../src/shared/operations'

const retainedBackends: BackendRecord[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(async () => {
  await Promise.allSettled(retainedBackends.splice(0).map(backend => backend.runCompletionPromise))
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
})

function fixture() {
  const store = new RunStore(join(tmpdir(), `pion-notification-${randomUUID()}.json`))
  const bridge = new AgentBridge(store)
  const internal = bridge as unknown as {
    backendPool: { add(backend: BackendRecord): void }
    activeKey: string
    activeCwd: string
    activeSessionPath: string
    historyRevision: number
    sessionInfoSnapshots?: WeakMap<BackendRecord, BackendSessionInfoSnapshot>
    attachBackendEvents(backend: BackendRecord): void
    createRun(backend: BackendRecord, state: { sessionId: string }, text: string, images: [], kind: 'prompt', initial: 'dispatching'): RunOperation
    pendingRequests: PendingRequestStore
    notifyToolPermissionRequested(request: unknown): void
    invalidateNotificationName(backend: BackendRecord, pending?: boolean): void
    querySessionInfo(backend: BackendRecord): Promise<unknown>
    syncBackendSession(): Promise<unknown>
    refreshRunCheckpoint(): Promise<unknown>
    pushSessionInfo(): Promise<unknown>
    refreshSidebarSessions(): Promise<unknown>
    dispatchNextLocalFollowUp(): void
  }
  // Isolate notification observation from existing sidebar/checkpoint/queue IO.
  for (const method of ['syncBackendSession', 'refreshRunCheckpoint', 'pushSessionInfo', 'refreshSidebarSessions'] as const) {
    vi.spyOn(internal, method).mockResolvedValue(undefined)
  }
  vi.spyOn(internal, 'dispatchNextLocalFollowUp').mockImplementation(() => undefined)

  function backend(name: string) {
    let listener: (event: unknown) => void = () => undefined
    const getState = vi.fn(async () => ({}))
    const write = vi.fn()
    const record = {
      key: name, cwd: join(tmpdir(), name), sessionPath: join(tmpdir(), `${name}.jsonl`),
      phase: 'running', busy: false, compacting: false, pendingRunIds: [], startPromise: Promise.resolve(),
      client: { onEvent: (callback: (event: unknown) => void) => { listener = callback }, getState,
        process: { stdin: { destroyed: false, writable: true, write } } }
    } as unknown as BackendRecord
    retainedBackends.push(record)
    internal.backendPool.add(record)
    internal.attachBackendEvents(record)
    const cache = () => {
      internal.sessionInfoSnapshots ??= new WeakMap()
      internal.sessionInfoSnapshots.set(record, { client: record.client, cwd: record.cwd,
        capability: record.capability, capabilityEpoch: record.capability?.epoch,
        revision: internal.historyRevision, sessionPath: record.sessionPath,
        info: { sessionId: `${name}-id`, sessionName: `${name} name`, sessionFile: record.sessionPath,
          isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 } })
    }
    const run = () => internal.createRun(record, { sessionId: `${name}-id` }, 'input', [], 'prompt', 'dispatching')
    const emit = (event: unknown) => listener(event)
    const start = () => { const result = run(); emit({ type: 'agent_start' });
      emit({ type: 'message_start', message: { role: 'user', content: 'input' } }); return result }
    cache()
    return { record, emit, start, run, cache, getState, write }
  }
  const background = backend('background')
  const active = backend('active')
  internal.activeKey = active.record.key
  internal.activeCwd = active.record.cwd
  internal.activeSessionPath = active.record.sessionPath!
  const completed = vi.fn()
  const permission = vi.fn()
  bridge.onSessionCompleted(completed)
  bridge.onToolPermissionRequested(permission)
  return { bridge, store, internal, background, active, completed, permission }
}

const assistant = (content: unknown = [{ type: 'text', text: 'Completed safely' }]) =>
  ({ role: 'assistant', stopReason: 'stop', content })
function end(h: ReturnType<typeof fixture>, message = assistant()) {
  h.background.emit({ type: 'agent_end', messages: [message] })
  h.background.emit({ type: 'agent_settled' })
}

describe('AgentBridge notification payloads', () => {
  it('uses the background backend cache and the current root run, without querying SDK state', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'tool_execution_start', toolCallId: 'root-tool', toolName: 'read' })
    h.background.emit({ type: 'tool_execution_end', toolCallId: 'root-tool', toolName: 'read', result: { content: [{ type: 'text', text: 'private tool output' }] } })
    h.background.emit({ type: 'message_end', message: assistant([
      { type: 'thinking', thinking: 'private reasoning' }, { type: 'image', data: 'private-image-data' },
      { type: 'text', text: 'Completed safely' }
    ]) })
    vi.setSystemTime(12_345)
    end(h)
    expect(h.completed).toHaveBeenCalledTimes(1)
    expect(h.completed).toHaveBeenCalledWith({ cwd: h.background.record.cwd, sessionPath: h.background.record.sessionPath,
      sessionId: 'background-id', sessionName: 'background name', summary: 'Completed safely', durationMs: 2345, toolCount: 1 })
    expect(h.background.getState).not.toHaveBeenCalled()
    expect(h.active.getState).not.toHaveBeenCalled()
    expect(JSON.stringify(h.completed.mock.calls)).not.toMatch(/active name|private/)
  })

  it('cleans root final text before the notification formatter without leaving escape or media fragments', () => {
    const h = fixture()
    h.background.start()
    const message = assistant([
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'image', data: 'PRIVATE_IMAGE' },
      { type: 'text', text: '\x1b[31m### **完成**\x1b[0m \x1b]0;PRIVATE_TITLE\x07'
        + '\x1b]2;OTHER_TITLE\x1b\\![预览](data:image/png;base64,MARKDOWN_IMAGE) '
        + 'data:text/plain,PRIVATE_DATA `后续步骤` 😀' }
    ])
    h.background.emit({ type: 'message_end', message })
    end(h, message)
    expect(h.completed).toHaveBeenCalledTimes(1)
    const payload = h.completed.mock.calls[0][0]
    expect(payload.summary).toBe('完成 后续步骤 😀')
    const notice = formatSessionCompletionNotification(payload)
    expect(notice.body).toContain('回复摘要：完成 后续步骤 😀')
    expect(JSON.stringify({ payload, notice })).not.toMatch(/PRIVATE_|OTHER_TITLE|MARKDOWN_IMAGE|data:|\[31m|\[0m|\*\*|###|`|!\[/)
    expect(notice.body).not.toMatch(/[\u001b\u0007\ud800-\udfff]/u)
  })

  it('keeps retries in one complete turn and emits only at the existing successful settle', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'message_end', message: assistant() })
    h.background.emit({ type: 'agent_end', willRetry: true, messages: [assistant()] })
    expect(h.completed).not.toHaveBeenCalled()
    vi.setSystemTime(11_000)
    h.background.emit({ type: 'agent_start' })
    end(h)
    expect(h.completed).toHaveBeenCalledTimes(1)
    expect(h.completed.mock.calls[0][0]).toMatchObject({ summary: 'Completed safely', durationMs: 1000 })
    h.background.emit({ type: 'agent_settled' })
    expect(h.completed).toHaveBeenCalledTimes(1)
    h.background.start()
    end(h, assistant([]))
    expect(h.completed.mock.calls[1][0].summary).toBeUndefined()
  })

  it.each([false, true])('resets the preview for a new steer, then accepts only its own observed final (%s)', (hasFinal) => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'Earlier answer' }]) })
    h.background.emit({ type: 'message_start', message: { role: 'user', content: 'steer' } })
    if (hasFinal) h.background.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'New answer' }]) })
    end(h) // A bare end array must not restore the old input's assistant.
    expect(h.completed.mock.calls[0][0].summary).toBe(hasFinal ? 'New answer' : undefined)
  })

  it('keeps nested and private packets out of root completion and summaries', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'agent_end', parentToolCallId: 'parent', messages: [assistant([{ type: 'text', text: 'nested text' }])] })
    h.background.emit({ type: 'agent_settled', parentToolCallId: 'parent' })
    h.background.emit({ type: 'message_end', parentToolCallId: 'parent', message: assistant([{ type: 'text', text: 'nested text' }]) })
    for (const widgetKey of [QUESTION_WAIT_WIDGET_KEY, SUBAGENT_SESSION_WIDGET_KEY]) {
      h.background.emit({ type: 'message_end', widgetKey, message: assistant([{ type: 'text', text: 'private widget text' }]) })
    }
    expect(h.completed).not.toHaveBeenCalled()
    end(h, assistant([]))
    expect(h.completed).toHaveBeenCalledTimes(1)
    expect(h.completed.mock.calls[0][0].summary).toBeUndefined()
  })

  it.each(['error', 'aborted', 'queue'])('preserves notification suppression for %s', (mode) => {
    const h = fixture()
    h.background.start()
    if (mode === 'queue') h.background.record.localFollowUps = [{ runId: 'queued', text: 'next', images: [] }]
    end(h, { ...assistant(), stopReason: mode === 'queue' ? 'stop' : mode })
    expect(h.completed).not.toHaveBeenCalled()
  })

  it('uses final text only, bounds the preview, and treats an empty final as authoritative', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'stale stream' } })
    end(h, assistant([{ type: 'text', text: 'x'.repeat(1000) }]))
    expect(h.completed.mock.calls[0][0].summary).toBe('x'.repeat(179) + '…')
    h.background.start()
    h.background.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'stale final' }]) })
    h.background.emit({ type: 'message_start', message: assistant([]) })
    h.background.emit({ type: 'message_end', message: assistant([]) })
    end(h)
    expect(h.completed.mock.calls[1][0].summary).toBeUndefined()
  })

  it('retires an earlier preview when the root live cache is replaced', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'Old cache answer' }]) })
    h.background.record.liveState = undefined
    end(h)
    expect(h.completed.mock.calls[0][0].summary).toBeUndefined()
  })

  it('excludes thinking, media and raw error text even from a nominal stop message', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'message_end', message: { ...assistant([
      { type: 'text', text: 'raw provider diagnostic' },
      { type: 'thinking', thinking: 'secret reasoning' }, { type: 'image', data: 'secret image' }
    ]), errorMessage: 'raw provider error' } })
    end(h)
    expect(h.completed.mock.calls[0][0].summary).toBeUndefined()
    expect(JSON.stringify(h.completed.mock.calls)).not.toMatch(/raw provider|secret/)
  })

  it.each(['backend', 'cwd', 'path', 'session', 'missing-start', 'clock-back', 'full-tools'])('omits unknown or mismatched run details (%s)', (mode) => {
    const h = fixture()
    const run = h.background.start()
    h.store.update(run.id, current => {
      if (mode === 'backend') current.usageBackendId = 'other'
      if (mode === 'cwd') current.cwd = '/other'
      if (mode === 'path') current.sessionPath = '/other.jsonl'
      if (mode === 'session') current.sessionId = 'other'
      if (mode === 'missing-start') current.agentStartedAt = undefined
      if (mode === 'full-tools') current.tools = Array.from({ length: 80 }, (_, index) =>
        ({ toolCallId: String(index), name: 'read', state: 'completed', startedAt: 10_000 }))
    })
    if (mode === 'clock-back') vi.setSystemTime(9_000)
    end(h)
    const notice = h.completed.mock.calls[0][0]
    if (mode === 'full-tools') expect(notice.durationMs).toBe(0)
    else expect(notice.durationMs).toBeUndefined()
    if (mode === 'clock-back') expect(notice.toolCount).toBe(0)
    else expect(notice.toolCount).toBeUndefined()
    if (['backend', 'cwd', 'path', 'session'].includes(mode)) expect(notice.summary).toBeUndefined()
  })

  it.each(['epoch', 'client', 'path', 'name'])('rejects stale cached session names (%s)', (mode) => {
    const h = fixture()
    if (mode === 'epoch') h.background.record.capability = { epoch: {} } as BackendRecord['capability']
    if (mode === 'client') h.internal.sessionInfoSnapshots!.get(h.background.record)!.client = h.active.record.client
    if (mode === 'path') h.internal.sessionInfoSnapshots!.get(h.background.record)!.sessionPath = '/old.jsonl'
    h.background.start()
    if (mode === 'name') h.background.emit({ type: 'session_info_changed' })
    end(h)
    expect(h.completed.mock.calls[0][0].sessionName).toBeUndefined()
  })

  it.each(['before', 'during'])('keeps a cached name read begun %s rename unconfirmed after its late result', async (mode) => {
    const h = fixture()
    let resolveState!: (state: object) => void
    h.background.getState.mockReturnValueOnce(new Promise<object>(resolve => { resolveState = resolve }))
    if (mode === 'during') h.internal.invalidateNotificationName(h.background.record, true)
    const read = h.internal.querySessionInfo(h.background.record)
    if (mode === 'before') h.internal.invalidateNotificationName(h.background.record, true)
    h.internal.invalidateNotificationName(h.background.record) // The real rename RPC has now closed.
    resolveState({ sessionFile: h.background.record.sessionPath, sessionId: 'background-id', sessionName: 'old name',
      isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 })
    await read
    h.background.start()
    end(h)
    expect(h.completed.mock.calls[0][0].sessionName).toBeUndefined()
  })

  it('routes permission context through the exact pending scope even with a policy path alias, without approving', () => {
    const h = fixture()
    h.background.start()
    h.background.emit({ type: 'extension_ui_request', id: 'permission-source', method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify({ cwd: h.active.record.cwd,
        sessionPath: '/policy-alias.jsonl', toolName: 'write', category: 'write', policyCategories: ['write'],
        summary: 'Write a file', detail: 'permission details', risks: [], canRemember: true })}` })
    expect(h.permission).toHaveBeenCalledTimes(1)
    expect(h.permission).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'write' }),
      { sessionId: 'background-id', sessionName: 'background name' })
    expect(h.background.write).not.toHaveBeenCalled()
    expect(h.bridge.getPendingToolPermissionRequests()).toHaveLength(1)
    const pendingRequest = h.permission.mock.calls[0][0]
    h.internal.notifyToolPermissionRequested({ ...pendingRequest })
    expect(h.permission.mock.calls[1][1]).toBeUndefined() // Same ID without the main-owned object supplies no context.
    expect(h.background.getState).not.toHaveBeenCalled()
    expect(h.active.getState).not.toHaveBeenCalled()
  })
})
