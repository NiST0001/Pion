import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkflowSnapshot } from '../../../shared/workflows'

interface UseWorkflowsOptions {
  hasBridge: boolean
  cwd?: string
}

function order(values: WorkflowSnapshot[]): WorkflowSnapshot[] {
  return [...values].sort((left, right) => right.updatedAt - left.updatedAt)
}

export function useWorkflows({ hasBridge, cwd }: UseWorkflowsOptions) {
  const [workflows, setWorkflows] = useState<WorkflowSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasBridge || !cwd) {
      setWorkflows([])
      return
    }
    setLoading(true)
    try {
      const next = order(await window.pion.listWorkflows(cwd))
      setWorkflows(next)
      setSelectedId((current) => current && next.some((workflow) => workflow.id === current)
        ? current
        : next[0]?.id)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [cwd, hasBridge])

  useEffect(() => {
    void refresh()
    if (!hasBridge || !cwd) return
    return window.pion.onWorkflowUpdate(({ workflow }) => {
      const projectPath = cwd.replaceAll('\\', '/')
      const workflowPath = workflow.cwd.replaceAll('\\', '/')
      if (workflowPath !== projectPath && !projectPath.startsWith(`${workflowPath}/`)) return
      setWorkflows((current) => order([
        workflow,
        ...current.filter((item) => item.id !== workflow.id)
      ]))
      setSelectedId((current) => current ?? workflow.id)
    })
  }, [cwd, hasBridge, refresh])

  const invoke = useCallback(async (
    operation: () => Promise<WorkflowSnapshot>
  ): Promise<WorkflowSnapshot | null> => {
    if (busy) return null
    setBusy(true)
    setError('')
    try {
      const workflow = await operation()
      setWorkflows((current) => order([workflow, ...current.filter((item) => item.id !== workflow.id)]))
      setSelectedId(workflow.id)
      return workflow
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally {
      setBusy(false)
    }
  }, [busy])

  const create = useCallback((goal: string) => {
    if (!cwd) return Promise.resolve(null)
    return invoke(() => window.pion.createWorkflow({ cwd, goal }))
  }, [cwd, invoke])

  const action = useCallback((
    id: string,
    operation: (workflowId: string) => Promise<WorkflowSnapshot>
  ) => invoke(() => operation(id)), [invoke])

  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0] ?? null,
    [selectedId, workflows]
  )

  return {
    workflows,
    selected,
    selectedId,
    loading,
    busy,
    error,
    select: setSelectedId,
    refresh,
    create,
    start: (id: string) => action(id, window.pion.startWorkflow),
    approvePlan: (id: string) => action(id, window.pion.approveWorkflowPlan),
    repair: (id: string) => action(id, window.pion.repairWorkflow),
    waiveTests: (id: string) => action(id, window.pion.waiveWorkflowTests),
    resume: (id: string) => action(id, window.pion.resumeWorkflow),
    cancel: (id: string) => action(id, window.pion.cancelWorkflow),
    merge: (id: string) => action(id, window.pion.mergeWorkflow),
    cleanup: (id: string) => action(id, window.pion.cleanupWorkflow)
  }
}
