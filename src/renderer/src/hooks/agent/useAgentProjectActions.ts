import { useCallback } from 'react'
import type { Dispatch } from 'react'
import type { BranchDeleteResult } from '../../../../shared/branches'
import type { Action } from '../../agent/types'
import { beginBranchQuery, invalidateBranchQueries, isCurrentBranchQuery } from '../../agent/branchListRevision'
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
      invalidateBranchQueries(api, cwd)
      const branch = await api.createBranch(cwd, name)
      const token = beginBranchQuery(api, cwd)
      const branches = await api.listBranches(cwd)
      if (isCurrentBranchQuery(api, cwd, token)) dispatch({ type: 'branches', cwd, branches })
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
      invalidateBranchQueries(api, projectCwd)
      const branch = await api.renameBranch(cwd, oldName, newName)
      const token = beginBranchQuery(api, projectCwd)
      const branches = await api.listBranches(projectCwd)
      if (isCurrentBranchQuery(api, projectCwd, token)) dispatch({ type: 'branches', cwd: projectCwd, branches })
      return branch
    },
    [api, dispatch]
  )

  const deleteBranch = useCallback(
    async (projectCwd: string, branch: BranchInfo): Promise<BranchDeleteResult> => {
      if (!api) throw new Error('preload 桥未加载')
      if (branch.isMain || !branch.gitBranch) throw new Error('该工作树不可删除')
      invalidateBranchQueries(api, projectCwd)
      const result = await api.deleteBranch({ projectCwd, cwd: branch.cwd, name: branch.gitBranch })
      // Fence both reads started before deletion and reads started while the
      // backend mutation was pending, before publishing its committed result.
      const token = beginBranchQuery(api, projectCwd)
      if (result.worktreeRemoved) dispatch({ type: 'branchRemoved', projectCwd, cwd: branch.cwd })
      try {
        const branches = await api.listBranches(projectCwd)
        if (isCurrentBranchQuery(api, projectCwd, token)) dispatch({ type: 'branches', cwd: projectCwd, branches })
      } catch {
        return { ...result, warning: [result.warning, '删除操作已完成，但分支列表刷新失败，请重新打开项目。'].filter(Boolean).join(' ') }
      }
      return result
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
    deleteBranch,
    removeProject,
    setProjectTrust
  }
}
