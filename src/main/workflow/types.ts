import type { VerificationRunState } from '../../shared/operations'
import type { WorkflowRole } from '../../shared/workflows'

export interface WorkflowWorkerInput {
  id: string
  workflowId: string
  role: Exclude<WorkflowRole, 'tester'>
  cwd: string
  prompt: string
  permissionConfigPath: string
  signal?: AbortSignal
}

export interface WorkflowWorkerResult {
  output: string
  sessionPath?: string
}

export interface WorkflowWorkerRunner {
  run(input: WorkflowWorkerInput, onProgress: (message: string) => void): Promise<WorkflowWorkerResult>
  cancel(workerId: string): Promise<void>
  /** Throws while preparation, process shutdown or an unknown exit retains this cwd. */
  assertWorktreeDeletionIdle?(cwd: string): void
}

export interface WorkflowVerificationResult {
  runId?: string
  state: VerificationRunState | 'not-found'
  summary: string
}

export interface WorkflowVerificationRunner {
  run(cwd: string, onProgress: (message: string, runId?: string) => void, signal?: AbortSignal): Promise<WorkflowVerificationResult>
  cancel(runId: string): Promise<void>
  assertWorktreeDeletionIdle?(cwd: string): void
}
