// @vitest-environment jsdom
import { useCallback, useReducer } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState } from '../../src/renderer/src/agent/types'
import type { Action, AgentState } from '../../src/renderer/src/agent/types'
import type {
  MessageRevertResult, PionApi, SessionEntriesPage, SessionHistoryIndex, SessionTask
} from '../../src/shared/types'

const path = '/project/a.jsonl'
const otherPath = '/project/b.jsonl'
const oldTasks: SessionTask[] = [{ id: 1, title: 'removed turn', status: 'in_progress' }]
const restoredTasks: SessionTask[] = [{ id: 2, title: 'previous turn', status: 'completed' }]
const draft: MessageRevertResult = {
  sessionPath: path, sessionId: 'a', entryId: 'undo-user', previousLeafId: 'old-leaf',
  leafId: 'restored-leaf', text: 'restore this prompt',
  images: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]
}
const index = (sessionPath = path, leafId = 'restored-leaf'): SessionHistoryIndex => ({
  sessionPath, leafId, totalEntries: 2,
  landmarks: [{ entryId: `${leafId}-user`, entryIndex: 0, ordinal: 1, snippet: leafId, timestamp: '' }]
})
const page = (leafId = 'restored-leaf', tasks = restoredTasks): SessionEntriesPage => ({
  entries: [
    { type: 'message', id: `${leafId}-user`, parentId: null, timestamp: '',
      message: { role: 'user', content: leafId } },
    { type: 'message', id: leafId, parentId: `${leafId}-user`, timestamp: '',
      message: { role: 'assistant', content: 'answer' } }
  ],
  toolResults: [], taskSnapshot: tasks, start: 0, end: 2, total: 2, leafId, mode: 'build'
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function setup(patch: Partial<AgentState> = {}) {
  const revert = vi.fn().mockResolvedValue(draft)
  const getEntriesPage = vi.fn().mockImplementation((_before, _limit, owner) => (
    Promise.resolve(owner === otherPath ? page('b-leaf', []) : page())
  ))
  const getHistoryIndex = vi.fn().mockImplementation((owner) => (
    Promise.resolve(index(owner, owner === otherPath ? 'b-leaf' : 'restored-leaf'))
  ))
  const switchSession = vi.fn()
  const api = {
    revertMessage: revert, getEntriesPage, getHistoryIndex, switchSession,
    onEvent: vi.fn(() => () => undefined)
  } as unknown as PionApi
  const seed: AgentState = {
    ...initialState,
    status: { phase: 'running', cwd: '/project' },
    session: { sessionId: 'a', sessionFile: path, isStreaming: false, messageCount: 4 },
    timeline: [
      { kind: 'user', id: 1, entryId: 'undo-user', text: 'restore this prompt' },
      { kind: 'assistant', id: 2, entryId: 'old-leaf', text: 'removed answer', thinking: '', streaming: false }
    ],
    tasks: oldTasks, taskRevision: 5, taskResultIds: ['old-result'],
    historyIndex: index(path, 'old-leaf'),
    tree: { tree: [], leafId: 'old-leaf' },
    runCheckpoint: { id: 'old-checkpoint', cwd: '/project', createdAt: 1,
      state: 'ready', hasChanges: true, changedFileCount: 1 },
    ...patch
  }
  // Initial ownership/indexing comes from the real session snapshot, never
  // from manually assigning the hook's owner ref.
  if (seed.session?.sessionFile && !seed.timelineLoading) {
    getHistoryIndex.mockResolvedValueOnce(seed.historyIndex ?? index(path, 'old-leaf'))
  }
  const actions: Action[] = []
  const hook = renderHook(() => {
    const [state, reduce] = useReducer(reducer, seed)
    const dispatch = useCallback((action: Action): void => { actions.push(action); reduce(action) }, [])
    const history = useAgentHistory({ api, state, dispatch })
    return { state, dispatch, history }
  })
  await act(async () => { await hook.result.current.history.historyIndexInFlight.current?.promise })
  getHistoryIndex.mockClear()
  actions.length = 0
  const history = hook.result.current.history
  const cached = {
    items: seed.timeline, tasks: oldTasks, mode: seed.mode, apiBefore: 1, apiAfter: 3,
    toolResults: [], complete: false, newerComplete: false, leafId: 'cached-leaf', total: 4
  }
  if (seed.session?.sessionFile) {
    history.timelineCache.current.set(path, cached)
    history.historyCursor.current = { ...cached, path, loadId: history.timelineLoadId.current, loading: false }
  }
  switchSession.mockImplementation(async (sessionPath: string) => {
    hook.result.current.dispatch({ type: 'session', session: {
      sessionId: sessionPath === path ? 'a' : 'b', sessionFile: sessionPath,
      isStreaming: false, messageCount: 2
    } })
    return { cancelled: false }
  })
  return { ...hook, revert, getEntriesPage, getHistoryIndex, switchSession, actions }
}
async function select(h: Awaited<ReturnType<typeof setup>>, sessionPath: string) {
  let pending!: Promise<{ cancelled: boolean }>
  act(() => { pending = h.result.current.history.switchSession(sessionPath) })
  await act(async () => { await vi.advanceTimersByTimeAsync(250); await pending })
}

// Keep fake timers local when the coverage aggregate imports this file.
describe('message revert history', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('loads an unpersisted session without mistaking an absent revert for a matching mutation', async () => {
    const getState = vi.fn<PionApi['getState']>().mockResolvedValue(null)
    const getEntriesPage = vi.fn<PionApi['getEntriesPage']>().mockResolvedValue(page())
    const api = { getState, getEntriesPage } as unknown as PionApi
    const hook = renderHook(() => {
      const [state, dispatch] = useReducer(reducer, initialState)
      const history = useAgentHistory({ api, state, dispatch })
      return { state, history }
    })
    await act(async () => { await hook.result.current.history.reloadTimeline() })
    expect(getState).toHaveBeenCalledOnce()
    expect(getEntriesPage).toHaveBeenCalledWith(undefined, expect.any(Number), undefined)
    expect(hook.result.current.state.timeline).toHaveLength(2)
    expect(hook.result.current.state.timelineError).toBeUndefined()
  })

  it('restores the same session branch, tasks, index and cache while returning text and images', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    const old = h.result.current.state
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    expect(h.revert).toHaveBeenCalledWith({ sessionPath: path, sessionId: 'a', entryId: 'undo-user', expectedLeafId: 'old-leaf' })
    expect(h.result.current.state.timeline).toBe(old.timeline)
    expect(h.result.current.state.tasks).toBe(old.tasks)
    expect(h.result.current.state.runCheckpoint).toBe(old.runCheckpoint)
    expect(h.result.current.state.tree).toBe(old.tree)
    expect(h.result.current.state.historyIndex).toBe(old.historyIndex)
    expect(h.result.current.state.timelineLoading).toBe(false)
    expect(h.actions).not.toContainEqual({ type: 'resetHistoryNavigation' })

    let result: MessageRevertResult | null = null
    await act(async () => { pending.resolve(draft); result = await undo })
    expect(result).toEqual(draft)
    expect(h.result.current.state.session).toBe(old.session)
    expect(h.result.current.state.timeline.map((item) => 'entryId' in item ? item.entryId : undefined))
      .toEqual(['restored-leaf-user', 'restored-leaf'])
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.state.taskResultIds).toEqual([])
    expect(h.result.current.state.runCheckpoint).toBeNull()
    expect(h.result.current.state.tree).toBeNull()
    expect(h.result.current.state.historyIndex).toEqual(index())
    const resetNavigation = h.actions.findIndex((action) => action.type === 'resetHistoryNavigation')
    const clearTimeline = h.actions.findIndex((action) => action.type === 'clearTimeline')
    expect(resetNavigation).toBeGreaterThanOrEqual(0)
    expect(resetNavigation).toBeLessThan(clearTimeline)
    expect(h.result.current.history.timelineCache.current.get(path)).toMatchObject({
      leafId: 'restored-leaf', total: 2, tasks: restoredTasks
    })
    expect(h.result.current.history.historyCursor.current).toBeNull()
    await select(h, otherPath)
    await select(h, path)
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.state.timeline.some((item) => 'entryId' in item && item.entryId === 'old-leaf')).toBe(false)
  })

  it.each(['older', 'newer', 'reload'] as const)('ignores old in-flight %s history and index results after undo', async (direction) => {
    const h = await setup()
    const stalePage = deferred<SessionEntriesPage>()
    const staleIndex = deferred<SessionHistoryIndex>()
    h.getEntriesPage.mockReturnValueOnce(stalePage.promise)
    h.getHistoryIndex.mockReturnValueOnce(staleIndex.promise)
    let oldRead!: Promise<void>, oldIndex!: Promise<void>
    act(() => {
      oldRead = direction === 'older' ? h.result.current.history.loadOlder()
        : direction === 'newer' ? h.result.current.history.loadNewer()
          : h.result.current.history.reloadTimeline(path)
      oldIndex = h.result.current.history.refreshHistoryIndex(path)
    })
    const oldRestoreId = h.result.current.state.taskRestore?.id
    await act(async () => { await h.result.current.history.revertMessage('undo-user') })
    const restoredTimeline = h.result.current.state.timeline
    await act(async () => {
      stalePage.resolve(page('stale-leaf', oldTasks))
      staleIndex.resolve(index(path, 'stale-leaf'))
      await Promise.all([oldRead, oldIndex])
      if (oldRestoreId !== undefined) h.result.current.dispatch({ type: 'restoreTasks', id: oldRestoreId, tasks: oldTasks })
    })
    expect(h.result.current.state.timeline).toBe(restoredTimeline)
    expect(h.result.current.state.historyIndex).toEqual(index())
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.history.timelineCache.current.get(path)?.leafId).toBe('restored-leaf')
  })

  it('suppresses a switched-away result, evicts its cache, and leaves the new selection untouched', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    await select(h, otherPath)
    const before = h.result.current.state
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(true)
    await act(async () => { pending.resolve(draft); expect(await undo).toBeNull() })
    expect(h.result.current.state).toBe(before)
    expect(h.result.current.history.timelineOwnerPath.current).toBe(otherPath)
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
    await select(h, path)
    expect(h.result.current.state.historyIndex).toEqual(index())
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.history.timelineCache.current.get(path)?.leafId).toBe('restored-leaf')
  })

  it('does not treat A -> B -> A as the original selection or revive a pre-undo cache', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    await select(h, otherPath)
    let revisit!: Promise<{ cancelled: boolean }>
    act(() => { revisit = h.result.current.history.switchSession(path) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    // The revisit waits for the mutation rather than rendering A's old branch.
    expect(h.switchSession).toHaveBeenCalledTimes(1)
    expect(h.result.current.state.timeline).toEqual([])
    await act(async () => {
      pending.resolve(draft)
      expect(await undo).toBeNull()
      await vi.advanceTimersByTimeAsync(250)
      await revisit
    })
    expect(h.result.current.state.session?.sessionId).toBe('a')
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.state.historyIndex).toEqual(index())
    expect(h.result.current.history.timelineCache.current.get(path)?.leafId).toBe('restored-leaf')
  })

  it('does not restore an invalidated cache captured by a switch that later cancels', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    const switchReply = deferred<{ cancelled: boolean }>()
    h.revert.mockReturnValueOnce(pending.promise)
    h.switchSession.mockReturnValueOnce(switchReply.promise)
    let undo!: Promise<MessageRevertResult | null>, switching!: Promise<{ cancelled: boolean }>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    act(() => { switching = h.result.current.history.switchSession(otherPath) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await act(async () => { pending.resolve(draft); expect(await undo).toBeNull() })
    await act(async () => { switchReply.resolve({ cancelled: true }); await switching })
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
    expect(h.result.current.state.timeline.some((item) => 'entryId' in item && item.entryId === 'old-leaf')).toBe(false)
    expect(h.result.current.state.tasks).not.toEqual(oldTasks)
    await select(h, path)
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
  })

  it('also suppresses a successful draft when selection changes during replacement history loading', async () => {
    const h = await setup()
    const replacement = deferred<SessionEntriesPage>()
    h.getEntriesPage.mockReturnValueOnce(replacement.promise)
    let undo!: Promise<MessageRevertResult | null>
    await act(async () => { undo = h.result.current.history.revertMessage('undo-user') })
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
    await select(h, otherPath)
    const before = h.result.current.state
    await act(async () => { replacement.resolve(page()); expect(await undo).toBeNull() })
    expect(h.result.current.state).toBe(before)
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
  })

  it('locks duplicate requests and preserves the existing view on rejection, then permits retry', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    const before = h.result.current.state
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    const failure = undo.catch((error: unknown) => error)
    await act(async () => { expect(await h.result.current.history.revertMessage('undo-user')).toBeNull() })
    expect(h.revert).toHaveBeenCalledTimes(1)
    const error = new Error('branch changed')
    await act(async () => { pending.reject(error); expect(await failure).toBe(error) })
    expect(h.result.current.state.timeline).toBe(before.timeline)
    expect(h.result.current.state.tasks).toBe(before.tasks)
    expect(h.result.current.state.historyIndex).toBe(before.historyIndex)
    expect(h.result.current.state.runCheckpoint).toBe(before.runCheckpoint)
    expect(h.result.current.state.tree).toBe(before.tree)
    expect(h.getEntriesPage).not.toHaveBeenCalled()
    expect(h.getHistoryIndex).not.toHaveBeenCalled()
    await act(async () => { expect(await h.result.current.history.revertMessage('undo-user')).toEqual(draft) })
    expect(h.revert).toHaveBeenCalledTimes(2)
  })

  it('returns the successfully restored draft even when the replacement history cannot load', async () => {
    const h = await setup()
    h.getEntriesPage.mockRejectedValue(new Error('offline'))
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      expect(await undo).toEqual(draft)
    })
    expect(h.result.current.state.timelineError).toContain('会话历史加载失败')
    expect(h.result.current.state.timelineLoading).toBe(false)
    expect(h.result.current.state.tasks).toBeNull()
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
    expect(h.revert).toHaveBeenCalledTimes(1)
  })

  it('keeps mutation success distinct from an index-only read failure', async () => {
    const h = await setup()
    h.getHistoryIndex.mockRejectedValue(new Error('index unavailable'))
    await act(async () => { expect(await h.result.current.history.revertMessage('undo-user')).toEqual(draft) })
    expect(h.result.current.state.timelineError).toContain('索引加载失败')
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.state.historyIndex).toBeNull()
  })

  it('uses the latest state instead of a captured callback and fails closed without an owned leaf', async () => {
    const h = await setup()
    const revert = h.result.current.history.revertMessage
    act(() => h.result.current.dispatch({ type: 'event', event: { type: 'queue_update', steering: ['waiting'], followUp: [] } }))
    await expect(revert('undo-user')).rejects.toThrow('排队')
    act(() => {
      h.result.current.dispatch({ type: 'event', event: { type: 'queue_update', steering: [], followUp: [] } })
      h.result.current.dispatch({ type: 'historyIndex', index: index(otherPath) })
    })
    h.result.current.history.timelineCache.current.delete(path)
    await expect(revert('undo-user')).rejects.toThrow('分支')
    expect(h.revert).not.toHaveBeenCalled()
  })

  it('rejects a stale owner/session pairing without touching the displayed history', async () => {
    const h = await setup()
    h.result.current.history.timelineOwnerPath.current = otherPath
    const before = h.result.current.state
    await expect(h.result.current.history.revertMessage('undo-user')).rejects.toThrow('就绪')
    expect(h.revert).not.toHaveBeenCalled()
    expect(h.result.current.state).toBe(before)
  })

  it.each([undefined, null] as const)('falls back to the cached leaf only when the owned index leaf is unavailable (%s)', async (leafId) => {
    const owned = index()
    owned.leafId = leafId
    const h = await setup({ historyIndex: owned })
    await act(async () => { await h.result.current.history.revertMessage('undo-user') })
    expect(h.revert).toHaveBeenCalledWith(expect.objectContaining({ expectedLeafId: leafId === undefined ? 'cached-leaf' : null }))
  })

  it.each([
    { busy: true },
    { compacting: true },
    { queuedMessages: { steering: [], followUp: [], nativeFollowUpCount: 1 } }
  ] satisfies Partial<AgentState>[])('does not mutate an active/compacting/queued session: %j', async (patch) => {
    const h = await setup(patch)
    await expect(h.result.current.history.revertMessage('undo-user')).rejects.toThrow('空闲')
    expect(h.revert).not.toHaveBeenCalled()
  })

  it('does not return a draft or publish history after unmount', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    const cache = h.result.current.history.timelineCache.current
    h.unmount()
    pending.resolve(draft)
    expect(await undo).toBeNull()
    expect(cache.has(path)).toBe(false)
    expect(h.getEntriesPage).not.toHaveBeenCalled()
  })

  it('ignores a success after explicit selection intent even before the next React snapshot', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    act(() => { h.result.current.history.invalidateSelection() })
    const before = h.result.current.state
    await act(async () => { pending.resolve(draft); expect(await undo).toBeNull() })
    expect(h.result.current.state).toBe(before)
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
    await act(async () => {
      await h.result.current.history.loadOlder()
      await h.result.current.history.loadNewer()
    })
    expect(h.getEntriesPage).not.toHaveBeenCalled()
  })

  it('owns a newly persisted live session before undo without reloading its rows', async () => {
    const h = await setup({
      session: { sessionId: 'a', isStreaming: false, messageCount: 0 },
      historyIndex: null
    })
    const timeline = h.result.current.state.timeline
    expect(h.result.current.history.timelineOwnerPath.current).toBeUndefined()
    expect(h.result.current.history.timelineCache.current.has(path)).toBe(false)
    h.getHistoryIndex.mockResolvedValueOnce(index(path, 'old-leaf'))
    await act(async () => h.result.current.dispatch({ type: 'session', session: {
      sessionId: 'a', sessionFile: path, isStreaming: false, messageCount: 4
    } }))
    expect(h.result.current.history.timelineOwnerPath.current).toBe(path)
    expect(h.result.current.history.selectionRef.current).toMatchObject({ ownerPath: path, sessionId: 'a' })
    expect(h.result.current.state.timeline).toBe(timeline)
    expect(h.getEntriesPage).not.toHaveBeenCalled()
    expect(h.getHistoryIndex).toHaveBeenCalledWith(path)
    const selection = h.result.current.history.selectionRef.current
    await act(async () => { expect(await h.result.current.history.revertMessage('undo-user')).toEqual(draft) })
    expect(h.revert).toHaveBeenCalledWith(expect.objectContaining({ expectedLeafId: 'old-leaf' }))
    expect(h.result.current.history.selectionRef.current).toBe(selection)
  })

  it('does not re-adopt the old snapshot after a fresh-session intent clears the owner', async () => {
    const h = await setup()
    act(() => {
      h.result.current.history.invalidateSelection()
      h.result.current.history.timelineOwnerPath.current = undefined
      h.result.current.dispatch({ type: 'clearTimeline' })
    })
    expect(h.result.current.history.timelineOwnerPath.current).toBeUndefined()
    await act(async () => h.result.current.dispatch({ type: 'session', session: {
      sessionId: 'b', sessionFile: otherPath, isStreaming: false, messageCount: 0
    } }))
    expect(h.result.current.history.timelineOwnerPath.current).toBe(otherPath)
    expect(h.result.current.history.selectionRef.current).toMatchObject({ ownerPath: otherPath, sessionId: 'b' })
    expect(h.getEntriesPage).not.toHaveBeenCalled()
  })

  it.each([
    { thinkingLevel: 'high' }, { sessionName: 'renamed' },
    { provider: 'other', modelId: 'new-model', model: 'New model' }, { subagentsEnabled: false }
  ])('uses the refreshed metadata leaf for undo without replacing live rows: %j', async (metadata) => {
    const h = await setup()
    const timeline = h.result.current.state.timeline
    h.getHistoryIndex.mockResolvedValueOnce(index(path, 'metadata-leaf'))
    await act(async () => h.result.current.dispatch({ type: 'session', session: {
      ...h.result.current.state.session!, ...metadata
    } }))
    expect(h.result.current.state.timeline).toBe(timeline)
    expect(h.getEntriesPage).not.toHaveBeenCalled()
    await act(async () => { expect(await h.result.current.history.revertMessage('undo-user')).toEqual(draft) })
    expect(h.revert).toHaveBeenCalledWith(expect.objectContaining({ expectedLeafId: 'metadata-leaf' }))
  })

  it.each(['mutation', 'history'] as const)('preserves the logical selection and successful draft through a backend error during %s', async (stage) => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    const replacement = deferred<SessionEntriesPage>()
    h.revert.mockReturnValueOnce(pending.promise)
    h.getEntriesPage.mockReturnValueOnce(replacement.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    const selection = h.result.current.history.selectionRef.current
    if (stage === 'history') {
      await act(async () => { pending.resolve(draft) })
      expect(h.getEntriesPage).toHaveBeenCalledTimes(1)
    }
    act(() => h.result.current.dispatch({ type: 'status', status: {
      phase: 'error', error: 'backend restart failed'
    } }))
    expect(h.result.current.state.session).toBeNull()
    expect(h.result.current.history.selectionRef.current).toBe(selection)
    expect(h.result.current.history.timelineOwnerPath.current).toBe(path)
    await act(async () => {
      pending.resolve(draft)
      replacement.resolve(page())
      expect(await undo).toEqual(draft)
    })
    expect(h.result.current.state.status.phase).toBe('error')
    expect(h.result.current.state.session).toBeNull()
    expect(h.result.current.state.tasks).toEqual(restoredTasks)
    expect(h.result.current.history.selectionRef.current).toBe(selection)
  })

  it('retains selection identity through missing snapshots and their same-session recovery', async () => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    const selection = h.result.current.history.selectionRef.current
    const session = h.result.current.state.session
    act(() => h.result.current.dispatch({ type: 'session', session: null }))
    expect(h.result.current.history.selectionRef.current).toBe(selection)
    act(() => h.result.current.dispatch({ type: 'session', session }))
    expect(h.result.current.history.selectionRef.current).toBe(selection)
    await act(async () => { pending.resolve(draft); expect(await undo).toEqual(draft) })
  })

  it.each(['cwd', 'path', 'id'] as const)('still suppresses undo after a genuine %s change even without a switch callback', async (change) => {
    const h = await setup()
    const pending = deferred<MessageRevertResult>()
    h.revert.mockReturnValueOnce(pending.promise)
    let undo!: Promise<MessageRevertResult | null>
    act(() => { undo = h.result.current.history.revertMessage('undo-user') })
    const selection = h.result.current.history.selectionRef.current
    act(() => {
      if (change === 'cwd') h.result.current.dispatch({ type: 'status', status: { phase: 'running', cwd: '/elsewhere' } })
      else h.result.current.dispatch({ type: 'session', session: {
        ...h.result.current.state.session!,
        ...(change === 'path' ? { sessionFile: otherPath } : { sessionId: 'different' })
      } })
    })
    const before = h.result.current.state
    expect(h.result.current.history.selectionRef.current.generation).toBeGreaterThan(selection.generation)
    await act(async () => { pending.resolve(draft); expect(await undo).toBeNull() })
    expect(h.result.current.state.timeline).toBe(before.timeline)
    expect(h.result.current.state.tasks).toBe(before.tasks)
    expect(h.actions).not.toContainEqual({ type: 'resetHistoryNavigation' })
    expect(h.getEntriesPage).not.toHaveBeenCalled()
  })
})
