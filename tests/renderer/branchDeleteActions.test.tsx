// @vitest-environment jsdom

import { useReducer, useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BranchDeleteResult } from '../../src/shared/branches'
import type { BranchInfo, PionApi, SessionMeta } from '../../src/shared/types'
import { useAgentProjectActions } from '../../src/renderer/src/hooks/agent/useAgentProjectActions'
import { initialState, type Action, type AgentState } from '../../src/renderer/src/agent/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { useAgentSubscriptions } from '../../src/renderer/src/hooks/agent/useAgentSubscriptions'
import { beginBranchQuery, invalidateBranchQueries, isCurrentBranchQuery } from '../../src/renderer/src/agent/branchListRevision'

afterEach(cleanup)

const projectCwd = '/project/main'
const branch: BranchInfo = { name: 'feature/delete', gitBranch: 'feature/delete', cwd: '/project/feature', isMain: false }
const mainBranch: BranchInfo = { name: 'main', gitBranch: 'main', cwd: projectCwd, isMain: true }
const complete: BranchDeleteResult = { worktreeRemoved: true, branchDeleted: true }

// This hook accesses only these two API methods in deleteBranch. Do not install
// a global window.pion mock or pretend this is a complete preload implementation.
function harness() {
  const api = {
    deleteBranch: vi.fn<PionApi['deleteBranch']>().mockResolvedValue(complete),
    listBranches: vi.fn<PionApi['listBranches']>().mockResolvedValue([mainBranch])
  } satisfies Pick<PionApi, 'deleteBranch' | 'listBranches'>
  const dispatch = vi.fn<(action: Action) => void>()
  const { result } = renderHook(() => useAgentProjectActions({
    api: api as unknown as PionApi,
    dispatch,
    refreshModels: vi.fn(async () => {})
  }))
  return { api, dispatch, result }
}

describe('branch deletion project actions', () => {
  it('forwards explicit target identity, removes its projection before refreshing and returns the backend result', async () => {
    const h = harness()
    h.api.listBranches.mockImplementation(async (cwd) => {
      expect(cwd).toBe(projectCwd)
      expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'branchRemoved', projectCwd, cwd: branch.cwd })
      return [mainBranch]
    })
    await expect(h.result.current.deleteBranch(projectCwd, branch)).resolves.toBe(complete)
    expect(h.api.deleteBranch).toHaveBeenCalledExactlyOnceWith({ projectCwd, cwd: branch.cwd, name: branch.gitBranch })
    expect(h.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'branchRemoved', projectCwd, cwd: branch.cwd },
      { type: 'branches', cwd: projectCwd, branches: [mainBranch] }
    ])
  })

  it.each([
    { ...branch, isMain: true },
    { ...branch, gitBranch: undefined }
  ])('rejects undeletable UI targets before invoking any API', async (target) => {
    const h = harness()
    await expect(h.result.current.deleteBranch(projectCwd, target)).rejects.toThrow('该工作树不可删除')
    expect(h.api.deleteBranch).not.toHaveBeenCalled()
    expect(h.api.listBranches).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a missing preload bridge', async () => {
    const dispatch = vi.fn()
    const { result } = renderHook(() => useAgentProjectActions({ api: undefined, dispatch, refreshModels: vi.fn(async () => {}) }))
    await expect(result.current.deleteBranch(projectCwd, branch)).rejects.toThrow('preload 桥未加载')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('preserves a backend rejection without removing or refreshing the branch', async () => {
    const h = harness()
    const error = new Error('worktree has untracked files')
    h.api.deleteBranch.mockRejectedValueOnce(error)
    await expect(h.result.current.deleteBranch(projectCwd, branch)).rejects.toBe(error)
    expect(h.api.listBranches).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('preserves partial deletion and warning while refreshing the remaining branch list', async () => {
    const h = harness()
    const partial: BranchDeleteResult = { worktreeRemoved: true, branchDeleted: false, warning: 'branch retained after safety recheck' }
    h.api.deleteBranch.mockResolvedValueOnce(partial)
    await expect(h.result.current.deleteBranch(projectCwd, branch)).resolves.toBe(partial)
    expect(h.api.listBranches).toHaveBeenCalledExactlyOnceWith(projectCwd)
    expect(h.dispatch.mock.calls.map(([action]) => action.type)).toEqual(['branchRemoved', 'branches'])
  })

  it('never projects worktree removal when the backend did not report one', async () => {
    const h = harness()
    const retained: BranchDeleteResult = { worktreeRemoved: false, branchDeleted: false, warning: 'retained' }
    h.api.deleteBranch.mockResolvedValueOnce(retained)
    h.api.listBranches.mockResolvedValueOnce([mainBranch, branch])
    await expect(h.result.current.deleteBranch(projectCwd, branch)).resolves.toBe(retained)
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'branches', cwd: projectCwd, branches: [mainBranch, branch] })
  })

  it.each([complete, { worktreeRemoved: true, branchDeleted: false, warning: 'branch retained' } satisfies BranchDeleteResult])(
    'returns authoritative deletion flags plus a warning if list refresh fails', async (deleted) => {
      const h = harness()
      h.api.deleteBranch.mockResolvedValueOnce(deleted)
      h.api.listBranches.mockRejectedValueOnce(new Error('list unavailable'))
      const returned = await h.result.current.deleteBranch(projectCwd, branch)
      expect(returned.worktreeRemoved).toBe(deleted.worktreeRemoved)
      expect(returned.branchDeleted).toBe(deleted.branchDeleted)
      expect(returned.warning).toContain('分支列表刷新失败')
      if (deleted.warning) expect(returned.warning).toContain(deleted.warning)
      expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'branchRemoved', projectCwd, cwd: branch.cwd })
    }
  )

  it('does not remove or refresh early while backend deletion is pending', async () => {
    const h = harness()
    let finish!: (value: BranchDeleteResult) => void
    h.api.deleteBranch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const pending = h.result.current.deleteBranch(projectCwd, branch)
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.api.listBranches).not.toHaveBeenCalled()
    finish(complete)
    await expect(pending).resolves.toBe(complete)
  })
})

describe('removed branch list projection', () => {
  it('preserves history, session caches and unrelated worktree projections', () => {
    const session: SessionMeta = {
      projectCwd: branch.cwd, path: '/sessions/retained.jsonl', id: 'retained',
      timestamp: '2026-01-01T00:00:00Z', mtime: 1, preview: 'history remains', messageCount: 1
    }
    const state: AgentState = {
      ...initialState,
      branchesByProject: { [projectCwd]: [mainBranch, branch], '/other/main': [mainBranch] },
      sessions: [session], sessionsByProject: { [branch.cwd]: [session] },
      tree: { tree: [], leafId: 'retained-leaf' },
      historyJump: { entryId: 'retained-entry', nonce: 1 },
      tasks: [], timelineReady: true
    }
    const next = reducer(state, { type: 'branchRemoved', projectCwd, cwd: branch.cwd })
    expect(next.branchesByProject[projectCwd]).toEqual([mainBranch])
    expect(next.branchesByProject['/other/main']).toBe(state.branchesByProject['/other/main'])
    expect(next.sessionsByProject).toBe(state.sessionsByProject)
    expect(next.sessions).toBe(state.sessions)
    expect(next.tree).toBe(state.tree)
    expect(next.historyIndex).toBe(state.historyIndex)
    expect(next.historyJump).toBe(state.historyJump)
    expect(next.timeline).toBe(state.timeline)
    expect(next.tasks).toBe(state.tasks)
    expect(next.timelineReady).toBe(true)
    expect(next.historyResetRevision).toBe(state.historyResetRevision)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

// Exercise the actual subscription effect and actions together with one local
// API object. Reducer state detects resurrection, not just a helper token match.
function subscriptionHarness(read: PionApi['listBranches'], cwds = [projectCwd]) {
  const subscribe = () => () => undefined
  const api = {
    onStatus: subscribe, onRunCheckpoint: subscribe, onState: subscribe,
    onSessions: subscribe, onUnreadSessions: subscribe, onRunningSessionPaths: subscribe,
    onTree: subscribe, onProjects: subscribe, onEvent: subscribe,
    getRunningSessionPaths: vi.fn().mockResolvedValue([]),
    getUnreadSessionPaths: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn<PionApi['listBranches']>(read),
    deleteBranch: vi.fn<PionApi['deleteBranch']>().mockResolvedValue(complete),
    createBranch: vi.fn<PionApi['createBranch']>().mockResolvedValue(branch),
    renameBranch: vi.fn<PionApi['renameBranch']>().mockResolvedValue(branch)
  }
  const projects = cwds.map((cwd) => ({ cwd, name: cwd, addedAt: 0, lastUsedAt: 0 }))
  const hook = renderHook(({ projects }) => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState, branchesByProject: { [projectCwd]: [mainBranch, branch] }
    })
    const optimisticSessionTimers = useRef(new Map<string, number>())
    useAgentSubscriptions({ api: api as unknown as PionApi, dispatch, projects,
      branchesByProject: state.branchesByProject, sessionsByProject: state.sessionsByProject,
      optimisticSessionTimers })
    const actions = useAgentProjectActions({ api: api as unknown as PionApi, dispatch, refreshModels: async () => {} })
    return { state, ...actions }
  }, { initialProps: { projects } })
  return { ...hook, api, projects }
}

describe('shared branch-list revision fence', () => {
  it('does not resurrect a deleted worktree when the original sidebar list arrives after deletion refresh', async () => {
    const old = deferred<BranchInfo[]>()
    const h = subscriptionHarness(() => old.promise)
    h.api.listBranches.mockResolvedValueOnce([mainBranch])
    await act(async () => { await h.result.current.deleteBranch(projectCwd, branch) })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
    await act(async () => { old.resolve([mainBranch, branch]) })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
  })

  it.each([complete, { worktreeRemoved: true, branchDeleted: false, warning: 'branch retained' } satisfies BranchDeleteResult])(
    'preserves successful removal when refresh fails and an old sidebar read arrives', async (deleted) => {
      const old = deferred<BranchInfo[]>()
      const h = subscriptionHarness(() => old.promise)
      h.api.deleteBranch.mockResolvedValueOnce(deleted)
      h.api.listBranches.mockRejectedValueOnce(new Error('refresh unavailable'))
      let returned!: BranchDeleteResult
      await act(async () => { returned = await h.result.current.deleteBranch(projectCwd, branch) })
      await act(async () => { old.resolve([mainBranch, branch]) })
      expect(returned.worktreeRemoved).toBe(true)
      expect(returned.branchDeleted).toBe(deleted.branchDeleted)
      expect(returned.warning).toContain('分支列表刷新失败')
      if (deleted.warning) expect(returned.warning).toContain(deleted.warning)
      expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
    }
  )

  it('invalidates existing sidebar reads immediately, even while backend deletion is pending', async () => {
    const old = deferred<BranchInfo[]>()
    const deleting = deferred<BranchDeleteResult>()
    const h = subscriptionHarness(() => old.promise)
    h.api.deleteBranch.mockReturnValueOnce(deleting.promise)
    let pending!: Promise<BranchDeleteResult>
    act(() => { pending = h.result.current.deleteBranch(projectCwd, branch) })
    const before = h.result.current.state.branchesByProject[projectCwd]
    await act(async () => { old.resolve([mainBranch]) })
    expect(h.result.current.state.branchesByProject[projectCwd]).toBe(before)
    h.api.listBranches.mockResolvedValueOnce([mainBranch])
    await act(async () => { deleting.resolve(complete); await pending })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
  })

  it('fences a sidebar read started during deletion before the post-commit refresh finishes', async () => {
    const bootstrap = deferred<BranchInfo[]>()
    const during = deferred<BranchInfo[]>()
    const refresh = deferred<BranchInfo[]>()
    const deleting = deferred<BranchDeleteResult>()
    const h = subscriptionHarness(() => bootstrap.promise)
    h.api.deleteBranch.mockReturnValueOnce(deleting.promise)
    let pending!: Promise<BranchDeleteResult>
    act(() => { pending = h.result.current.deleteBranch(projectCwd, branch) })
    h.api.listBranches.mockReturnValueOnce(during.promise).mockReturnValueOnce(refresh.promise)
    h.rerender({ projects: [...h.projects] })
    await act(async () => { deleting.resolve(complete) })
    expect(h.api.listBranches).toHaveBeenCalledTimes(3)
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
    await act(async () => { during.resolve([mainBranch, branch]); bootstrap.resolve([mainBranch, branch]) })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
    await act(async () => { refresh.resolve([mainBranch]); await pending })
  })

  it('leaves another project cwd query eligible to publish', async () => {
    const otherCwd = '/other/main'
    const otherBranch = { ...mainBranch, cwd: otherCwd }
    const old = deferred<BranchInfo[]>()
    const other = deferred<BranchInfo[]>()
    const h = subscriptionHarness((cwd) => cwd === projectCwd ? old.promise : other.promise,
      [projectCwd, otherCwd])
    h.api.listBranches.mockResolvedValueOnce([mainBranch])
    await act(async () => { await h.result.current.deleteBranch(projectCwd, branch) })
    await act(async () => { other.resolve([otherBranch]); old.resolve([mainBranch, branch]) })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
    expect(h.result.current.state.branchesByProject[otherCwd]).toEqual([otherBranch])
  })

  it.each(['create', 'rename'] as const)('uses the same project scope for %s refresh and sidebar reads', async (operation) => {
    const old = deferred<BranchInfo[]>()
    const h = subscriptionHarness(() => old.promise)
    const renamed = { ...branch, name: 'new-name', gitBranch: 'new-name' }
    h.api.listBranches.mockResolvedValueOnce([mainBranch, renamed])
    await act(async () => {
      if (operation === 'create') await h.result.current.createBranch(projectCwd, 'new-name')
      else await h.result.current.renameBranch(branch.cwd, branch.name, 'new-name', projectCwd)
    })
    await act(async () => { old.resolve([mainBranch, branch]) })
    expect(h.api.listBranches).toHaveBeenLastCalledWith(projectCwd)
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch, renamed])
  })

  it('invalidates an earlier action refresh as soon as deletion starts', async () => {
    const old = deferred<BranchInfo[]>()
    const renameRefresh = deferred<BranchInfo[]>()
    const deleting = deferred<BranchDeleteResult>()
    const h = subscriptionHarness(() => old.promise)
    h.api.listBranches.mockReturnValueOnce(renameRefresh.promise)
    let renamed!: Promise<BranchInfo>
    await act(async () => { renamed = h.result.current.renameBranch(branch.cwd, branch.name, 'new-name', projectCwd) })
    h.api.deleteBranch.mockReturnValueOnce(deleting.promise)
    let pending!: Promise<BranchDeleteResult>
    act(() => { pending = h.result.current.deleteBranch(projectCwd, branch) })
    const before = h.result.current.state.branchesByProject[projectCwd]
    await act(async () => { renameRefresh.resolve([mainBranch]); await renamed })
    expect(h.result.current.state.branchesByProject[projectCwd]).toBe(before)
    h.api.listBranches.mockResolvedValueOnce([mainBranch])
    await act(async () => { deleting.resolve(complete); await pending; old.resolve([mainBranch, branch]) })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([mainBranch])
  })

  it('keeps the latest query winner across subscription effects and mutation refreshes', async () => {
    const old = deferred<BranchInfo[]>()
    const refresh = deferred<BranchInfo[]>()
    const latest = deferred<BranchInfo[]>()
    const h = subscriptionHarness(() => old.promise)
    h.api.listBranches.mockReturnValueOnce(refresh.promise)
    let pending!: Promise<BranchDeleteResult>
    await act(async () => { pending = h.result.current.deleteBranch(projectCwd, branch) })
    h.api.listBranches.mockReturnValueOnce(latest.promise)
    h.rerender({ projects: [...h.projects] })
    const newest = { ...mainBranch, name: 'newest' }
    await act(async () => { latest.resolve([newest]) })
    await act(async () => { refresh.resolve([mainBranch]); old.resolve([mainBranch, branch]); await pending })
    expect(h.result.current.state.branchesByProject[projectCwd]).toEqual([newest])
  })

  it('isolates API instances and does not revive evicted project tokens', () => {
    const api = {}
    const otherApi = {}
    const old = beginBranchQuery(api, projectCwd)
    const independent = beginBranchQuery(otherApi, projectCwd)
    invalidateBranchQueries(api, projectCwd)
    expect(isCurrentBranchQuery(api, projectCwd, old)).toBe(false)
    expect(isCurrentBranchQuery(otherApi, projectCwd, independent)).toBe(true)
    const beforeEviction = beginBranchQuery(api, projectCwd)
    for (let i = 0; i < 512; i++) beginBranchQuery(api, `/project/${i}`)
    const afterEviction = beginBranchQuery(api, projectCwd)
    expect(isCurrentBranchQuery(api, projectCwd, beforeEviction)).toBe(false)
    expect(isCurrentBranchQuery(api, projectCwd, afterEviction)).toBe(true)
  })
})
