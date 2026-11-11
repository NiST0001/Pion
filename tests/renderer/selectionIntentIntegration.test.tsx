// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatus, PionApi, SessionEntriesPage, SessionInfo } from '../../src/shared/types'
import { useAgent } from '../../src/renderer/src/hooks/useAgent'

const cwd = '/project', A = '/sessions/a.jsonl', B = '/sessions/b.jsonl', F = '/sessions/fork.jsonl'
const originalText = '  original user text\n'
const warning = `会话副本已创建，用量归档未完成；副本路径：${F}`
type Kind = 'copy' | 'fork' | 'forkAt'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function session(path: string): SessionInfo {
  return { sessionId: path, sessionFile: path, isStreaming: false, messageCount: 1 }
}
function page(path: string): SessionEntriesPage {
  return { entries: [{ type: 'message', id: path, parentId: null, timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: path }] } }],
  toolResults: [], start: 0, end: 1, total: 1, leafId: path, mode: 'build' }
}
beforeEach(() => {
  // Exercise real switch phases without depending on JSDOM's paint clock.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0))
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function setup() {
  const mutation = deferred<{ text: string; cancelled: boolean; warning?: string }>()
  const exported = deferred<string>()
  const states = new Set<(value: SessionInfo | null) => void>()
  const statuses = new Set<(value: AgentStatus) => void>()
  let current = session(A)
  const publish = (path: string, backendId?: string) => {
    current = { ...session(path), ...(backendId ? {
      liveState: { backendId, revision: 1, cwd, sessionPath: path, events: [] }
    } : {}) }
    for (const listener of statuses) listener({ phase: 'running', cwd })
    for (const listener of states) listener(current)
  }
  const subscribe = () => () => {}
  const api = {
    onStatus: (listener) => { statuses.add(listener); return () => { statuses.delete(listener) } },
    onState: (listener) => { states.add(listener); return () => { states.delete(listener) } },
    onEvent: subscribe, onRunCheckpoint: subscribe, onSessions: subscribe,
    onUnreadSessions: subscribe, onRunningSessionPaths: subscribe, onTree: subscribe, onProjects: subscribe,
    getRunningSessionPaths: async () => [], getUnreadSessionPaths: async () => [],
    getAvailableModels: vi.fn(async () => []), getThinkingLevels: vi.fn(async () => []),
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => current),
    getEntriesPage: vi.fn<PionApi['getEntriesPage']>(async (_before, _limit, path) => page(path ?? current.sessionFile!)),
    getHistoryIndex: vi.fn<PionApi['getHistoryIndex']>(async (path) => ({
      sessionPath: path!, totalEntries: 1, leafId: path!, landmarks: []
    })),
    switchSession: vi.fn<PionApi['switchSession']>(async (path) => { publish(path); return { cancelled: false } }),
    copySession: vi.fn<PionApi['copySession']>(() => mutation.promise),
    forkSession: vi.fn<PionApi['forkSession']>(() => mutation.promise),
    forkAt: vi.fn<PionApi['forkAt']>(() => mutation.promise),
    exportSessionForCommand: vi.fn<PionApi['exportSessionForCommand']>(() => exported.promise)
  } satisfies Partial<PionApi>
  vi.stubGlobal('pion', api)
  const hook = renderHook(() => useAgent())
  await act(async () => { publish(A) })
  await act(async () => { await hook.result.current.actions.reloadTimeline(A) })
  expect(hook.result.current.state.timeline[0]).toMatchObject({ text: A })
  return {
    ...hook, api, publish, exported,
    run: (kind: Kind) => {
      const actions = hook.result.current.actions
      return kind === 'copy' ? actions.copySession(A)
        : kind === 'fork' ? actions.forkSession(A, 'entry-a') : actions.forkAt('entry-a')
    },
    resolve: () => mutation.resolve({ text: originalText, cancelled: false, warning }),
    select: async (path: string) => {
      await act(async () => { expect(await hook.result.current.actions.switchSession(path, cwd)).toEqual({ cancelled: false }) })
    },
    replaceApi: async (replacement: PionApi) => {
      vi.stubGlobal('pion', replacement)
      await act(async () => { hook.rerender() })
    }
  }
}

it('settings export captures the current cwd/session/backend at invocation, including an older callback', async () => {
  const h = await setup()
  const exportHtml = h.result.current.actions.exportHtml
  await h.select(B)
  await act(async () => { h.publish(B, 'backend-b') })
  let pending!: Promise<string>
  act(() => { pending = exportHtml() })
  expect(h.api.exportSessionForCommand).toHaveBeenCalledExactlyOnceWith({
    cwd, sessionId: B, sessionPath: B, backendId: 'backend-b'
  })
  await act(async () => {
    h.exported.resolve('/project/session-new.html')
    expect(await pending).toBe('/project/session-new.html')
  })
})

it.each(['selection', 'api', 'window', 'unmount'] as const)('retires settings export publication after %s changes while keeping the original request', async (retire) => {
  const h = await setup()
  let pending!: Promise<string>
  act(() => { pending = h.result.current.actions.exportHtml() })
  expect(h.api.exportSessionForCommand).toHaveBeenCalledExactlyOnceWith({ cwd, sessionId: A, sessionPath: A })
  if (retire === 'selection') { await h.select(B); await h.select(A) }
  else if (retire === 'api') {
    await h.replaceApi({ ...h.api } as unknown as PionApi)
    await h.replaceApi(h.api as unknown as PionApi)
  } else if (retire === 'window') vi.stubGlobal('pion', { ...h.api })
  else h.unmount()
  await act(async () => { h.exported.resolve('/project/old-session.html'); expect(await pending).toBe('') })
  expect(h.api.exportSessionForCommand).toHaveBeenCalledTimes(1)
})

it('retires settings export after backend replacement, including a late old-backend STATE for the same session', async () => {
  const h = await setup()
  await act(async () => { h.publish(A, 'backend-a') })
  const generation = h.result.current.selectionRef.current.generation
  let pending!: Promise<string>
  act(() => { pending = h.result.current.actions.exportHtml() })
  await act(async () => { h.publish(A, 'backend-b') })
  await act(async () => { h.publish(A, 'backend-a') })
  expect(h.result.current.state.liveSessionBackendId).toBe('backend-b')
  expect(h.result.current.selectionRef.current.generation).toBe(generation)
  await act(async () => { h.exported.resolve('/project/stale-backend.html'); expect(await pending).toBe('') })
  expect(h.api.exportSessionForCommand).toHaveBeenCalledExactlyOnceWith({
    cwd, sessionId: A, sessionPath: A, backendId: 'backend-a'
  })
})

it.each([false, true])('settings export reports an owned error and drops a stale error (stale=%s)', async (stale) => {
  const h = await setup()
  const error = new Error('existing destination')
  let pending!: Promise<string>
  act(() => { pending = h.result.current.actions.exportHtml() })
  const outcome = pending.then(value => ({ value }), reason => ({ reason }))
  if (stale) await h.select(B)
  await act(async () => {
    h.exported.reject(error)
    expect(await outcome).toEqual(stale ? { value: '' } : { reason: error })
  })
})

it('rejects settings export after synchronous selection intent before the next render', async () => {
  const h = await setup()
  let switched!: Promise<{ cancelled: boolean }>
  let outcome!: Promise<unknown>
  act(() => {
    switched = h.result.current.actions.switchSession(B, cwd)
    outcome = h.result.current.actions.exportHtml().catch(error => error)
  })
  expect(await outcome).toEqual(new Error('请等待所选会话后端就绪'))
  expect(h.api.exportSessionForCommand).not.toHaveBeenCalled()
  await act(async () => { await switched })
})

// No production hook is mocked: useAgent supplies the real intent receipt to
// session actions, and the reducer/history pipeline accepts the resulting page.
it.each(['copy', 'fork', 'forkAt'] as const)('retires an in-flight %s across explicit A → B → A selection', async (kind) => {
  const h = await setup()
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  await h.select(B)
  await h.select(A)
  const timeline = h.result.current.state.timeline
  const scope = h.result.current.state.timelineScopeRevision
  const reads = h.api.getEntriesPage.mock.calls.length
  const stateReads = h.api.getState.mock.calls.length
  let text!: string | void
  await act(async () => { h.resolve(); text = await pending })
  expect(text).toBe(kind === 'copy' ? undefined : '')
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.state.timelineScopeRevision).toBe(scope)
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(reads)
  expect(h.api.getState).toHaveBeenCalledTimes(stateReads)
  expect(h.result.current.state.status.error).toBeUndefined()
})

it.each(['copy', 'fork', 'forkAt'] as const)('retires an in-flight %s across API A → B → A', async (kind) => {
  const h = await setup()
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  await h.replaceApi({ ...h.api } as unknown as PionApi)
  await h.replaceApi(h.api as unknown as PionApi)
  const timeline = h.result.current.state.timeline
  const scope = h.result.current.state.timelineScopeRevision
  const reads = h.api.getEntriesPage.mock.calls.length
  let text!: string | void
  await act(async () => { h.resolve(); text = await pending })
  expect(text).toBe(kind === 'copy' ? undefined : '')
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.state.timelineScopeRevision).toBe(scope)
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(reads)
  expect(h.result.current.state.status.error).toBeUndefined()
})

it.each(['copy', 'fork', 'forkAt'] as const)('publishes %s warning only after its owned STATE and reload, retaining fork prefill', async (kind) => {
  const h = await setup()
  const loaded = deferred<SessionEntriesPage>()
  h.api.getEntriesPage.mockReturnValueOnce(loaded.promise)
  const scope = h.result.current.state.timelineScopeRevision
  const generation = h.result.current.selectionRef.current.generation
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  await act(async () => { h.publish(F) })
  expect(h.result.current.selectionRef.current.generation).toBeGreaterThan(generation)
  await act(async () => { h.resolve() })
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(2)
  expect(h.result.current.state.status.error).toBeUndefined()
  let text!: string | void
  await act(async () => { loaded.resolve(page(F)); text = await pending })
  expect(text).toBe(kind === 'copy' ? undefined : originalText)
  expect(h.result.current.state.timelineScopeRevision).toBe(scope + 1)
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(2)
  expect(h.api.getEntriesPage).toHaveBeenLastCalledWith(undefined, expect.any(Number), F)
  expect(h.result.current.selectionRef.current.ownerPath).toBe(F)
  expect(h.result.current.state.timeline[0]).toMatchObject({ text: F })
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.status.error).toBe(warning)
})

it.each(['copy', 'fork', 'forkAt'] as const)('drops %s warning, text and late page when selection changes during reload', async (kind) => {
  const h = await setup()
  const loaded = deferred<SessionEntriesPage>()
  h.api.getEntriesPage.mockReturnValueOnce(loaded.promise)
  let pending!: Promise<string | void>, settled = false
  act(() => { pending = h.run(kind).then((text) => { settled = true; return text }) })
  await act(async () => { h.publish(F) })
  await act(async () => { h.resolve() })
  expect(h.api.getEntriesPage).toHaveBeenLastCalledWith(undefined, expect.any(Number), F)
  expect(settled).toBe(false)
  await h.select(B)
  const timeline = h.result.current.state.timeline
  const scope = h.result.current.state.timelineScopeRevision
  let text!: string | void
  await act(async () => { loaded.resolve(page(F)); text = await pending })
  expect(text).toBe(kind === 'copy' ? undefined : '')
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.state.timelineScopeRevision).toBe(scope)
  expect(h.result.current.selectionRef.current.ownerPath).toBe(B)
  expect(h.result.current.state.timeline[0]).toMatchObject({ text: B })
  expect(h.result.current.state.status.error).toBeUndefined()
})

it('drops a forkAt warning and prefill after API replacement during reload', async () => {
  const h = await setup()
  const loaded = deferred<SessionEntriesPage>()
  h.api.getEntriesPage.mockReturnValueOnce(loaded.promise)
  let pending!: Promise<string | void>
  act(() => { pending = h.run('forkAt') })
  await act(async () => { h.publish(F); h.resolve() })
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(2)
  await h.replaceApi({ ...h.api } as unknown as PionApi)
  await h.replaceApi(h.api as unknown as PionApi)
  await act(async () => { loaded.resolve(page(F)); expect(await pending).toBe('') })
  expect(h.result.current.state.status.error).toBeUndefined()
})

it.each(['copy', 'fork', 'forkAt'] as const)('retires %s on unmount before its receipt', async (kind) => {
  const h = await setup()
  let pending!: Promise<string | void>
  act(() => { pending = h.run(kind) })
  h.unmount()
  let text!: string | void
  await act(async () => { h.resolve(); text = await pending })
  expect(text).toBe(kind === 'copy' ? undefined : '')
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
  expect(h.api.getState).not.toHaveBeenCalled()
})

it.each(['api', 'unmount'] as const)('retires the forkAt callback itself after %s retirement', async (retire) => {
  const h = await setup()
  const stale = h.result.current.actions.forkAt
  if (retire === 'unmount') h.unmount()
  else {
    await h.replaceApi({ ...h.api } as unknown as PionApi)
    await h.replaceApi(h.api as unknown as PionApi)
  }
  h.resolve()
  await act(async () => { expect(await stale('entry-a')).toBe('') })
  expect(h.api.forkAt).not.toHaveBeenCalled()
})
