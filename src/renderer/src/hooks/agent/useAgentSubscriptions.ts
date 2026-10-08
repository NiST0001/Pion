import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { PionApi } from '../../../../shared/types'
import type { Action, AgentState } from '../../agent/types'

// Progressive sidebar reads: a slow worktree must not hold every other row.
// The deadline bounds waiting, not the lifetime of the underlying IPC request.
async function loadSidebarRows<T>(
  cwds: string[], read: (cwd: string) => Promise<T>, publish: (cwd: string, value: T) => void,
  cancelled: () => boolean
): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, cwds.length) }, async () => {
    while (!cancelled() && next < cwds.length) {
      const cwd = cwds[next++]
      let timer: number | undefined
      try {
        const value = await Promise.race([
          read(cwd),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error('sidebar read timed out')), 15_000)
          })
        ])
        if (!cancelled()) publish(cwd, value)
      } catch (error) {
        if (!cancelled()) console.warn('[pion] sidebar read failed:', cwd, error)
      } finally {
        if (timer !== undefined) window.clearTimeout(timer)
      }
    }
  }))
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
  const sessionPushRevisions = useRef(new Map<string, number>())
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
    const offs = [
      api.onStatus((status) => dispatch({ type: 'status', status })),
      api.onRunCheckpoint((checkpoint) => dispatch({ type: 'runCheckpoint', checkpoint })),
      api.onState((session) => dispatch({ type: 'session', session })),
      api.onSessions((sessions) => {
        const cwd = sessions[0]?.projectCwd
        if (cwd) sessionPushRevisions.current.set(cwd, (sessionPushRevisions.current.get(cwd) ?? 0) + 1)
        else unknownSessionPushRevision.current++
        dispatch({ type: 'sessions', sessions })
      }),
      api.onUnreadSessions((paths) => {
        unreadPushed = true
        dispatch({ type: 'unreadSessions', paths })
      }),
      api.onRunningSessionPaths((paths) => {
        runningPushed = true
        dispatch({ type: 'runningSessionPaths', paths })
      }),
      api.onTree((tree) => dispatch({ type: 'tree', tree })),
      api.onProjects((nextProjects) => dispatch({ type: 'projects', projects: nextProjects })),
      api.onEvent((event) => dispatch({ type: 'event', event }))
    ]
    void api.getRunningSessionPaths()
      .then((paths) => { if (active && !runningPushed) dispatch({ type: 'runningSessionPaths', paths }) })
      .catch(() => undefined)
    void api.getUnreadSessionPaths()
      .then((paths) => { if (active && !unreadPushed) dispatch({ type: 'unreadSessions', paths }) })
      .catch(() => undefined)
    return () => {
      active = false
      offs.forEach((off) => off())
    }
  }, [api, dispatch])

  // Load each project's Git worktrees so the sidebar can render
  // Project -> Branch -> Session instead of a flat project list.
  useEffect(() => {
    if (!api || projects.length === 0) return
    let cancelled = false
    void loadSidebarRows(projects.map((project) => project.cwd),
      (cwd) => api.listBranches(cwd),
      (cwd, branches) => dispatch({ type: 'branches', cwd, branches }),
      () => cancelled)
    return () => {
      cancelled = true
    }
  }, [api, dispatch, projects])

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
    void loadSidebarRows(branchCwds, (cwd) => api.listSessions(cwd), (cwd, sessions) => {
      // A persisted/live push is newer than the bootstrap snapshot. Keep it,
      // and merge only this worktree rather than replacing the whole map.
      if (unknownRevision !== unknownSessionPushRevision.current
        || (revisions.get(cwd) ?? 0) !== (sessionPushRevisions.current.get(cwd) ?? 0)) return
      dispatch({ type: 'projectSessionsUpdate', cwd, sessions })
    }, () => cancelled)

    return () => {
      cancelled = true
    }
  }, [api, branchesByProject, dispatch, projects])
}
