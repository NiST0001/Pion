import { useCallback } from 'react'
import type { Dispatch } from 'react'
import type { Action } from '../../agent/types'
import type {
  BranchInfo,
  PionApi,
  ProjectTrustInfo
} from '../../../../shared/types'

interface UseAgentProjectActionsOptions {
  api: PionApi | undefined
  dispatch: Dispatch<Action>
  refreshModels: () => Promise<void>
}

export function useAgentProjectActions({
  api,
  dispatch,
  refreshModels
}: UseAgentProjectActionsOptions) {
  const addProject = useCallback(
    async (cwd: string): Promise<void> => {
      if (!api) return
      const projects = await api.addProject(cwd)
      dispatch({ type: 'projects', projects })
    },
    [api, dispatch]
  )

  const createBranch = useCallback(
    async (cwd: string, name: string): Promise<BranchInfo> => {
      if (!api) throw new Error('preload 桥未加载')
      const branch = await api.createBranch(cwd, name)
      const branches = await api.listBranches(cwd)
      dispatch({ type: 'branches', cwd, branches })
      return branch
    },
    [api, dispatch]
  )

  const renameBranch = useCallback(
    async (
      cwd: string,
      oldName: string,
      newName: string,
      projectCwd = cwd
    ): Promise<BranchInfo> => {
      if (!api) throw new Error('preload 桥未加载')
      const branch = await api.renameBranch(cwd, oldName, newName)
      const branches = await api.listBranches(projectCwd)
      dispatch({ type: 'branches', cwd: projectCwd, branches })
      return branch
    },
    [api, dispatch]
  )

  const removeProject = useCallback(
    async (cwd: string): Promise<void> => {
      if (!api) return
      const projects = await api.removeProject(cwd)
      dispatch({ type: 'projects', projects })
    },
    [api, dispatch]
  )

  const setProjectTrust = useCallback(
    async (cwd: string, decision: boolean | null): Promise<ProjectTrustInfo> => {
      if (!api) throw new Error('preload 桥未加载')
      const trust = await api.setProjectTrust(cwd, decision)
      void refreshModels().catch((error: unknown) => {
        console.error('[pion] failed to refresh models after project trust change:', error)
      })
      return trust
    },
    [api, refreshModels]
  )

  return {
    addProject,
    createBranch,
    renameBranch,
    removeProject,
    setProjectTrust
  }
}
