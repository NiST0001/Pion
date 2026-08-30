import type { VerificationRunState } from './operations'

export type WorkflowRole = 'planner' | 'implementer' | 'reviewer' | 'tester'

export type WorkflowState =
  | 'draft'
  | 'awaiting_start'
  | 'preparing'
  | 'planning'
  | 'awaiting_plan'
  | 'implementing'
  | 'integrating'
  | 'reviewing'
  | 'testing'
  | 'awaiting_merge'
  | 'merging'
  | 'completed'
  | 'waiting_permission'
  | 'blocked'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted'
  | 'stale'

export type WorkflowWorkerStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface WorkflowPermissionEnvelope {
  read: boolean
  write: boolean
  shell: boolean
  network: false
  external: false
  note: string
}

export interface WorkflowWorker {
  id: string
  role: WorkflowRole
  status: WorkflowWorkerStatus
  kind: 'agent' | 'command'
  worktreePath?: string
  branch?: string
  startedAt?: number
  finishedAt?: number
  outputTail: string
  outputTruncated: boolean
  error?: string
  permission: WorkflowPermissionEnvelope
}

export interface WorkflowReview {
  verdict: 'pass' | 'fail' | 'unknown'
  summary: string
  reviewedAt: number
}

export interface WorkflowVerification {
  runId?: string
  state: VerificationRunState | 'not-found' | 'waived'
  summary: string
  finishedAt?: number
}

export interface WorkflowWorktrees {
  planner?: string
  implementer?: string
  reviewer?: string
  tester?: string
}

export interface WorkflowSnapshot {
  version: 1
  id: string
  cwd: string
  goal: string
  state: WorkflowState
  createdAt: number
  updatedAt: number
  revision: number
  baseOid?: string
  targetBranch?: string
  candidateBranch?: string
  candidateOid?: string
  mergeOid?: string
  plan?: string
  review?: WorkflowReview
  verification?: WorkflowVerification
  workers: WorkflowWorker[]
  worktrees: WorkflowWorktrees
  repairAttempts: number
  maxRepairAttempts: number
  blockedReason?: 'review' | 'verification' | 'no-verification' | 'no-changes' | 'worker'
  interruptedFrom?: WorkflowState
  error?: string
  testsWaivedAt?: number
  cleanupCompletedAt?: number
}

export interface CreateWorkflowRequest {
  cwd: string
  goal: string
}

export interface WorkflowUpdate {
  workflow: WorkflowSnapshot
}

const RUNNING_STATES = new Set<WorkflowState>([
  'preparing',
  'planning',
  'implementing',
  'integrating',
  'reviewing',
  'testing',
  'merging',
  'cancelling'
])

const TERMINAL_STATES = new Set<WorkflowState>(['completed', 'cancelled', 'failed', 'stale'])

export function isWorkflowRunning(state: WorkflowState): boolean {
  return RUNNING_STATES.has(state)
}

export function isWorkflowTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state)
}

export function workflowStateLabel(state: WorkflowState): string {
  const labels: Record<WorkflowState, string> = {
    draft: '草稿',
    awaiting_start: '等待启动',
    preparing: '准备隔离工作树',
    planning: '规划中',
    awaiting_plan: '等待批准计划',
    implementing: '实现中',
    integrating: '整理候选提交',
    reviewing: '审查中',
    testing: '验证中',
    awaiting_merge: '等待合并',
    merging: '合并中',
    completed: '已完成',
    waiting_permission: '等待权限',
    blocked: '已阻塞',
    failed: '失败',
    cancelling: '取消中',
    cancelled: '已取消',
    interrupted: '已中断',
    stale: '目标已变化'
  }
  return labels[state]
}
