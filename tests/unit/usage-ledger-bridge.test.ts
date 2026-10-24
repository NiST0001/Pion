import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import { QUESTION_WAIT_WIDGET_KEY } from '../../src/shared/question-settings'
import { SUBAGENT_SESSION_ADMISSION_TITLE, SUBAGENT_SESSION_WIDGET_KEY } from '../../src/shared/subagent-sessions'

const roots: string[] = []
const transcript = 'isolated ledger bridge fixture\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pion-usage-bridge-'))
  roots.push(root)
  const path = join(root, 'source.jsonl')
  await writeFile(path, transcript)
  const manager = {
    getLeafId: vi.fn(() => 'parent'),
    getSessionFile: vi.fn(() => path),
    getCwd: vi.fn(() => root),
    getEntry: vi.fn(() => ({
      type: 'message', id: 'user', parentId: 'parent',
      message: { role: 'user', content: [{ type: 'text', text: 'fork here' }] }
    })),
    createBranchedSession: vi.fn(() => join(root, 'child.jsonl'))
  }
  const fields = {
    activeKey: 'selected',
    activeCwd: root,
    activeSessionPath: join(root, 'selected.jsonl'),
    sessionSelectionGeneration: 1,
    stopping: false,
    status: { phase: 'ready', cwd: root },
    backendPool: new Map<string, BackendRecord>(),
    backendKeysBySessionPath: new Map(),
    sessionManagers: new Map(),
    sessionManagerSignatures: new Map(),
    unreadSessionPaths: new Set(),
    resolveListedSession: vi.fn(async (requested: string) => requested),
    stopBackend: vi.fn(async () => undefined),
    openSessionManager: vi.fn(() => manager),
    pushSessionInfo: vi.fn(async () => undefined),
    refreshSidebarSessions: vi.fn(async () => undefined)
  }
  // Bypass constructor services: no real SDK/client, user configuration or credentials.
  const bridge = Object.assign(Object.create(AgentBridge.prototype), fields) as AgentBridge
  const captureSession = vi.fn((_path: string): Promise<void> => Promise.resolve())
  const scheduleSession = vi.fn((_path: string) => undefined)
  bridge.configureUsageLedger({ captureSession, scheduleSession })
  return { bridge, fields: bridge as unknown as typeof fields, manager, root, path, captureSession, scheduleSession }
}

describe('AgentBridge usage ledger integration', () => {
  it.each([false, true])('waits for actual collection before unlink, preserving source on rejection (%s)', async (rejectCapture) => {
    const h = await fixture()
    const archive = deferred()
    const failure = new Error('ledger persistence failed')
    h.captureSession.mockImplementation(() => archive.promise)
    let settled = false
    const observed = h.bridge.deleteSession(h.path).then(
      (value) => { settled = true; return { value } },
      (error: unknown) => { settled = true; return { error } }
    )
    try {
      await vi.waitFor(() => expect(h.captureSession).toHaveBeenCalledExactlyOnceWith(h.path))
      await expect(readFile(h.path, 'utf8')).resolves.toBe(transcript)
      expect(settled).toBe(false)
      if (rejectCapture) {
        archive.reject(failure)
        expect(await observed).toEqual({ error: failure })
        await expect(readFile(h.path, 'utf8')).resolves.toBe(transcript)
        expect(h.fields.refreshSidebarSessions).not.toHaveBeenCalled()
      } else {
        archive.resolve()
        expect(await observed).toEqual({ value: { activeSessionChanged: false } })
        await expect(readFile(h.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(h.fields.activeSessionPath).toBe(join(h.root, 'selected.jsonl'))
    } finally {
      archive.resolve()
      await observed // Drain the real operation before removing its private temp directory.
    }
  })

  it('blocks starts and pending-start deletion while usage archival owns the path', async () => {
    const h = await fixture()
    const archive = deferred()
    h.captureSession.mockReturnValue(archive.promise)
    Object.defineProperty(h.fields.backendPool, 'pendingStartCount', { value: 1 })
    const deletion = h.bridge.deleteSession(h.path).catch((error: unknown) => error)
    await vi.waitFor(() => expect(h.captureSession).toHaveBeenCalledExactlyOnceWith(h.path))
    const guarded = h.bridge as unknown as {
      createBackend(key: string, cwd: string, path: string): Promise<BackendRecord>
      assertSessionLoadAllowed(path: string): void
    }
    await expect(guarded.createBackend(h.path, h.root, h.path)).rejects.toThrow('归档并删除')
    archive.resolve()
    expect(await deletion).toEqual(expect.objectContaining({ message: '会话已重新启用，未删除' }))
    await expect(readFile(h.path, 'utf8')).resolves.toBe(transcript)
    expect(() => guarded.assertSessionLoadAllowed(h.path)).not.toThrow()
  })

  it('rejects a waiting clone if its source becomes reserved for deletion', async () => {
    const h = await fixture()
    const archive = deferred()
    h.captureSession.mockReturnValue(archive.promise)
    const copying = h.bridge.copySession(h.path).catch((error: unknown) => error)
    await vi.waitFor(() => expect(h.captureSession).toHaveBeenCalledTimes(1))
    const deleting = h.bridge.deleteSession(h.path).catch((error: unknown) => error)
    await vi.waitFor(() => expect(h.captureSession).toHaveBeenCalledTimes(2))
    archive.resolve()
    const [copyResult, deleteResult] = await Promise.all([copying, deleting])
    expect(copyResult).toEqual(expect.objectContaining({ message: '正在归档并删除会话，请稍后重试' }))
    expect(deleteResult).toEqual({ activeSessionChanged: false })
    expect(h.manager.createBranchedSession).not.toHaveBeenCalled()
  })

  it('does not clear a newly selected session after a delayed delete capture', async () => {
    const h = await fixture()
    const archive = deferred()
    h.fields.activeSessionPath = h.path
    h.captureSession.mockReturnValue(archive.promise)
    const deletion = h.bridge.deleteSession(h.path)
    await vi.waitFor(() => expect(h.captureSession).toHaveBeenCalledExactlyOnceWith(h.path))
    const newlySelected = join(h.root, 'new-selection.jsonl')
    h.fields.activeSessionPath = newlySelected
    archive.resolve()
    await expect(deletion).resolves.toEqual({ activeSessionChanged: false })
    expect(h.fields.activeSessionPath).toBe(newlySelected)
  })

  it('retires a waiting clone on stop and shares the real stop receipt', async () => {
    const h = await fixture()
    const archive = deferred(), stopped = deferred()
    h.captureSession.mockReturnValue(archive.promise)
    const stopBackends = vi.fn(() => stopped.promise)
    Object.assign(h.bridge, { stopBackends })
    const copy = h.bridge.copySession(h.path).catch((error: unknown) => error)
    await vi.waitFor(() => expect(h.captureSession).toHaveBeenCalledExactlyOnceWith(h.path))
    const generation = h.fields.sessionSelectionGeneration
    const stopping = h.bridge.stop()
    expect(h.bridge.stop()).toBe(stopping)
    expect(stopBackends).toHaveBeenCalledTimes(1)
    expect(h.fields.sessionSelectionGeneration).toBe(generation + 1)
    archive.resolve()
    expect(await copy).toEqual(expect.objectContaining({ message: '会话已切换，未继续复制或分叉' }))
    expect(h.manager.createBranchedSession).not.toHaveBeenCalled()
    stopped.resolve()
    await stopping
  })

  it.each(['copy', 'fork', 'fork-selected'] as const)('does not create a %s when source archival rejects', async (operation) => {
    const h = await fixture()
    const failure = new Error('source not archived')
    h.captureSession.mockRejectedValue(failure)
    if (operation === 'fork-selected') h.fields.activeSessionPath = h.path
    const pending = operation === 'copy' ? h.bridge.copySession(h.path)
      : operation === 'fork' ? h.bridge.forkSession(h.path, 'user') : h.bridge.forkAt('user')
    await expect(pending).rejects.toBe(failure)
    expect(h.captureSession).toHaveBeenCalledExactlyOnceWith(h.path)
    expect(h.manager.createBranchedSession).not.toHaveBeenCalled()
    await expect(readFile(h.path, 'utf8')).resolves.toBe(transcript)
    expect(h.fields.pushSessionInfo).not.toHaveBeenCalled()
  })

  it('collects root background persistence notices, never nested or private packets', async () => {
    const h = await fixture()
    let emit: (event: unknown) => void = () => { throw new Error('listener not attached') }
    const backend = {
      key: 'background', cwd: h.root, sessionPath: h.path,
      phase: 'running', busy: false, compacting: false, pendingRunIds: [],
      client: { onEvent: (listener: (event: unknown) => void) => { emit = listener } },
      startPromise: Promise.resolve()
    } as unknown as BackendRecord
    h.fields.backendPool.set(backend.key, backend)
    const trackBackendEvent = vi.fn()
    Object.assign(h.bridge, {
      desiredModes: new Map(),
      sessionCompletedListeners: new Set(),
      trackBackendEvent,
      completeCompanionRuns: vi.fn(),
      dispatchNextLocalFollowUp: vi.fn(),
      pushRunningSessionPaths: vi.fn(),
      syncBackendSession: vi.fn(async () => undefined)
    })
    ;(h.bridge as unknown as { attachBackendEvents(value: BackendRecord): void }).attachBackendEvents(backend)
    const persistence = [
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } },
      { type: 'agent_settled' },
      ...['usage', 'compaction', 'branch_summary'].map((type) => ({ type: 'entry_appended', entry: { type } }))
    ]
    // A different session is selected throughout; collection must not depend on UI forwarding.
    for (const event of persistence) emit(event)
    expect(h.scheduleSession.mock.calls).toEqual(persistence.map(() => [h.path]))
    h.scheduleSession.mockClear()
    for (const event of persistence) emit({ ...event, parentToolCallId: 'nested-tool' })
    // Reserved malformed packets are consumed before even message/usage-shaped payloads.
    emit({ ...persistence[0], widgetKey: QUESTION_WAIT_WIDGET_KEY })
    emit({ ...persistence[0], widgetKey: SUBAGENT_SESSION_WIDGET_KEY })
    emit({ type: 'entry_appended', entry: { type: 'usage' }, title: SUBAGENT_SESSION_ADMISSION_TITLE })
    emit({ type: 'entry_appended', entry: { type: 'message' } })
    expect(h.scheduleSession).not.toHaveBeenCalled()
    expect(trackBackendEvent).toHaveBeenCalledWith(backend,
      expect.objectContaining({ parentToolCallId: 'nested-tool' }), expect.any(String))
    expect(h.captureSession).not.toHaveBeenCalled()
  })
})
