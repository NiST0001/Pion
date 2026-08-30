// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowPanel } from '../../src/renderer/src/components/WorkflowPanel'
import type { WorkflowSnapshot } from '../../src/shared/workflows'

function workflow(state: WorkflowSnapshot['state']): WorkflowSnapshot {
  return {
    version: 1,
    id: 'workflow-1',
    cwd: '/repo',
    goal: 'implement bounded workflow',
    state,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    workers: [],
    worktrees: {},
    repairAttempts: 0,
    maxRepairAttempts: 2,
    baseOid: 'base',
    candidateOid: 'candidate',
    candidateBranch: 'pion/workflow/candidate',
    targetBranch: 'main',
    plan: 'safe plan',
    review: { verdict: 'pass', summary: 'looks good', reviewedAt: 1 },
    verification: { state: 'passed', summary: 'tests pass' }
  }
}

function props(selected: WorkflowSnapshot | null = null) {
  return {
    cwd: '/repo',
    workflows: selected ? [selected] : [],
    selected,
    loading: false,
    busy: false,
    error: '',
    onSelect: vi.fn(),
    onCreate: vi.fn(async () => workflow('awaiting_start')),
    onStart: vi.fn(async () => undefined),
    onApprovePlan: vi.fn(async () => undefined),
    onRepair: vi.fn(async () => undefined),
    onWaiveTests: vi.fn(async () => undefined),
    onResume: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    onMerge: vi.fn(async () => undefined),
    onCleanup: vi.fn(async () => undefined)
  }
}

describe('WorkflowPanel', () => {
  it('requires a themed permission confirmation before creating and starting', async () => {
    const value = props()
    render(<WorkflowPanel {...value} />)
    fireEvent.click(screen.getByRole('button', { name: /多 Agent/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /新工作流/ })[0])
    fireEvent.change(screen.getByPlaceholderText(/Planner、Implementer/), {
      target: { value: 'build safely' }
    })
    fireEvent.click(screen.getByRole('button', { name: /审查权限并启动/ }))

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Shell、网络、外部工具')
    fireEvent.click(screen.getByRole('button', { name: '创建并启动' }))
    await waitFor(() => expect(value.onCreate).toHaveBeenCalledWith('build safely'))
    expect(value.onStart).toHaveBeenCalledWith('workflow-1')
  })

  it('requires explicit confirmation for fast-forward merge', async () => {
    const selected = workflow('awaiting_merge')
    const value = props(selected)
    render(<WorkflowPanel {...value} />)
    fireEvent.click(screen.getByRole('button', { name: /多 Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: /审查后合并/ }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('git merge --ff-only')
    fireEvent.click(screen.getByRole('button', { name: '确认快进合并' }))
    await waitFor(() => expect(value.onMerge).toHaveBeenCalledWith('workflow-1'))
  })
})
