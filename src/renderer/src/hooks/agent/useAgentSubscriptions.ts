import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { PionApi } from '../../../../shared/types'
import type { Action, AgentState } from '../../agent/types'
import { beginBranchQuery, isCurrentBranchQuery } from '../../agent/branchListRevision'

interface SidebarReadPool {
  pending: number
  resume?: () => void
}

// Branch and session discovery each retain four real IPC slots across effects.
// The deadline only reports slow reads; settlement releases a slot and pumps
// the latest discovery, so one slow worktree leaves the other workers free.
function loadSidebarRows<T>(
  pool: SidebarReadPool,
  cwds: string[], read: (cwd: string) => Promise<T>, publish: (cwd: string, value: T) => void,
  cancelled: () => boolean
): void {
  let next = 0
  const resume = () => {
    while (!cancelled() && pool.pending < 4 && next < cwds.length) {
      const cwd = cwds[next++]
      pool.pending++
      const timer = window.setTimeout(() => {
        if (!cancelled()) console.warn('[pion] sidebar read is still pending:', cwd)
      }, 15_000)
      // Start immediately, including synchronous throws in the settlement path.
      void (async () => read(cwd))()
        .then((value) => { if (!cancelled()) publish(cwd, value) })
        .catch((error) => {
          if (!cancelled()) console.warn('[pion] sidebar read failed:', cwd, error)
        })
        .finally(() => {
          window.clearTimeout(timer)
          pool.pending--
          pool.resume?.()
        })
    }
  }
  pool.resume = resume
  resume()
}

function isVersionedSessionList(cwd: string, sessions: AgentState['sessions']): boolean {
  const revision = sessions[0]?.sidebarRevision
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    && sessions.every((session) => session.projectCwd === cwd && session.sidebarRevision === revision)
}

interface UseAgentSubscriptionsOptions {
  api: PionApi | undefined
  dispatch: Dispatch<Action>
  projects: AgentState['projects']
  branchesByProject: AgentState['branchesByProject']
  sessionsByProject: AgentState['sessionsByProject']
  optimisticSessionTimers: MutableRefObject<Map<string, number>>
}

export function useAgentSubscriptions({
  api,
  dispatch,
  projects,
  branchesByProject,
  sessionsByProject,
  optimisticSessionTimers
}: UseAgentSubscriptionsOptions): void {
  const windowApi = typeof window === 'undefined' ? undefined : window.pion
  const apiOwner = useRef({ api, windowApi })
  if (apiOwner.current.api !== api || apiOwner.current.windowApi !== windowApi) apiOwner.current = { api, windowApi }
  const owner = apiOwner.current
  const branchReadPool = useRef<SidebarReadPool>({ pending: 0 })
  const sessionReadPool = useRef<SidebarReadPool>({ pending: 0 })
  const sessionPushRevisions = useRef(new Map<string, { counter: number; versioned: boolean }>())
  const unknownSessionPushRevision = useRef(0)
  useEffect(() => () => {
    for (const timer of optimisticSessionTimers.current.values()) window.clearTimeout(timer)
    optimisticSessionTimers.current.clear()
  }, [optimisticSessionTimers])

  useEffect(() => {
    const persisted = new Set<string>()
    for (const [cwd, sessions] of Object.entries(sessionsByProject)) {
      for (const session of sessions) {
        if (!session.optimistic) persisted.add(`${cwd}\u0000${session.id}`)
      }
    }
    for (const [key, timer] of optimisticSessionTimers.current) {
      if (!persisted.has(key)) continue
      window.clearTimeout(timer)
      optimisticSessionTimers.current.delete(key)
    }
  }, [optimisticSessionTimers, sessionsByProject])

  useEffect(() => {
    if (!api) return
    let active = true
    let runningPushed = false
    let unreadPushed = false
    const current = () => active && apiOwner.current === owner && window.pion === owner.windowApi
    const publish = (action: Action) => { if (current()) dispatch(action) }
    const offs = [
      api.onStatus((status) => publish({ type: 'status', status })),
      api.onRunCheckpoint((checkpoint) => publish({ type: 'runCheckpoint', checkpoint })),
      api.onState((session) => publish({ type: 'session', session })),
      api.onSessions((sessions) => {
        if (!current()) return
        const cwd = sessions[0]?.projectCwd
        if (cwd) sessionPushRevisions.current.set(cwd, {
          counter: (sessionPushRevisions.current.get(cwd)?.counter ?? 0) + 1,
          versioned: isVersionedSessionList(cwd, sessions)
        })
        else unknownSessionPushRevision.current++
        dispatch({ type: 'sessions', sessions })
      }),
      api.onUnreadSessions((paths) => {
        unreadPushed = true
        publish({ type: 'unreadSessions', paths })
      }),
      api.onRunningSessionPaths((paths) => {
        runningPushed = true
        publish({ type: 'runningSessionPaths', paths })
      }),
      api.onTree((tree) => publish({ type: 'tree', tree })),
      api.onProjects((nextProjects) => publish({ type: 'projects', projects: nextProjects })),
      api.onEvent((event) => publish({ type: 'event', event }))
    ]
    void api.getRunningSessionPaths()
      .then((paths) => { if (!runningPushed) publish({ type: 'runningSessionPaths', paths }) })
      .catch(() => undefined)
    void api.getUnreadSessionPaths()
      .then((paths) => { if (!unreadPushed) publish({ type: 'unreadSessions', paths }) })
      .catch(() => undefined)
    return () => {
      active = false
      offs.forEach((off) => off())
    }
  }, [api, dispatch, owner])

  // Load each project's Git worktrees so the sidebar can render
  // Project -> Branch -> Session instead of a flat project list.
  useEffect(() => {
    if (!api || projects.length === 0) return
    let cancelled = false
    loadSidebarRows(branchReadPool.current, projects.map((project) => project.cwd),
      async (cwd) => {
        const token = beginBranchQuery(api, cwd)
        return { token, branches: await api.listBranches(cwd) }
      },
      (cwd, { token, branches }) => {
        if (isCurrentBranchQuery(api, cwd, token)) dispatch({ type: 'branches', cwd, branches })
      },
      () => cancelled || apiOwner.current !== owner || window.pion !== owner.windowApi)
    return () => {
      cancelled = true
    }
  }, [api, dispatch, owner, projects])

  // Load every branch worktree's sessions so the sidebar can render a folder tree.
  useEffect(() => {
    if (!api) return
    let cancelled = false
    if (projects.length === 0) {
      dispatch({ type: 'projectSessions', sessionsByProject: {} })
      return () => {
        cancelled = true
      }
    }

    const branches = projects.flatMap((project) => (
      branchesByProject[project.cwd] ?? [{ name: 'main', cwd: project.cwd, isMain: true }]
    ))
    const branchCwds = [...new Set(branches.map((branch) => branch.cwd))]
    const revisions = new Map(sessionPushRevisions.current)
    const unknownRevision = unknownSessionPushRevision.current
    loadSidebarRows(sessionReadPool.current, branchCwds, (cwd) => api.listSessions(cwd), (cwd, sessions) => {
      const latestPush = sessionPushRevisions.current.get(cwd)
      // Versioned snapshots are ordered by the reducer, not push arrival: a
      // queued worktree's new scan may start after an older token-total push.
      // Unknown/empty pushes and either unversioned side keep the old fence.
      if (unknownRevision !== unknownSessionPushRevision.current
        || ((revisions.get(cwd)?.counter ?? 0) !== (latestPush?.counter ?? 0)
          && !(latestPush?.versioned && isVersionedSessionList(cwd, sessions)))) return
      dispatch({ type: 'projectSessionsUpdate', cwd, sessions })
    }, () => cancelled || apiOwner.current !== owner || window.pion !== owner.windowApi)

    return () => {
      cancelled = true
    }
  }, [api, branchesByProject, dispatch, owner, projects])
}
