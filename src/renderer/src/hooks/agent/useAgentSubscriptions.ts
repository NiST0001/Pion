import { useEffect } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { PionApi } from '../../../../shared/types'
import type { Action, AgentState } from '../../agent/types'

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
    const offs = [
      api.onStatus((status) => dispatch({ type: 'status', status })),
      api.onRunCheckpoint((checkpoint) => dispatch({ type: 'runCheckpoint', checkpoint })),
      api.onState((session) => dispatch({ type: 'session', session })),
      api.onSessions((sessions) => dispatch({ type: 'sessions', sessions })),
      api.onRunningSessionPaths((paths) => dispatch({ type: 'runningSessionPaths', paths })),
      api.onTree((tree) => dispatch({ type: 'tree', tree })),
      api.onProjects((nextProjects) => dispatch({ type: 'projects', projects: nextProjects })),
      api.onEvent((event) => dispatch({ type: 'event', event }))
    ]
    void api.getRunningSessionPaths()
      .then((paths) => dispatch({ type: 'runningSessionPaths', paths }))
      .catch(() => undefined)
    return () => offs.forEach((off) => off())
  }, [api, dispatch])

  // Load each project's Git worktrees so the sidebar can render
  // Project -> Branch -> Session instead of a flat project list.
  useEffect(() => {
    if (!api || projects.length === 0) return
    let cancelled = false
    void Promise.all(
      projects.map(async (project) => [project.cwd, await api.listBranches(project.cwd)] as const)
    ).then((entries) => {
      if (cancelled) return
      for (const [cwd, branches] of entries) {
        dispatch({ type: 'branches', cwd, branches })
      }
    })
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
    void Promise.all(
      branchCwds.map(async (cwd) => [cwd, await api.listSessions(cwd)] as const)
    ).then((entries) => {
      if (cancelled) return
      dispatch({ type: 'projectSessions', sessionsByProject: Object.fromEntries(entries) })
    })

    return () => {
      cancelled = true
    }
  }, [api, branchesByProject, dispatch, projects])
}
