export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
  costUsd: number
}

export type RunOperationState =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'ending'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'interrupted'
  | 'discarded'

export interface RunToolTiming {
  toolCallId: string
  name: string
  state: 'running' | 'completed' | 'failed' | 'interrupted'
  startedAt: number
  endedAt?: number
  durationMs?: number
  isError?: boolean
}

export interface RunCompactionMetric {
  id: string
  reason: string
  state: 'completed' | 'failed' | 'aborted'
  endedAt: number
  willRetry: boolean
  error?: string
}

export interface RunPromptImage {
  type: 'image'
  data: string
  mimeType: string
}

export interface RunPromptPayload {
  message: string
  images: RunPromptImage[]
}

export interface DurableRunCheckpoint {
  id: string
  cwd: string
  createdAt: number
  worktreeTree: string
  indexTree: string
  state: 'ready' | 'rolled-back' | 'unavailable'
  error?: string
}

/** Durable main-process record for one user-initiated Agent turn. */
export interface RunOperation {
  id: string
  cwd: string
  sessionPath?: string
  sessionId?: string
  kind: 'prompt' | 'follow-up' | 'recovery' | 'verification-repair'
  state: RunOperationState
  createdAt: number
  dispatchedAt?: number
  agentStartedAt?: number
  agentEndedAt?: number
  settledAt?: number
  interruptedAt?: number
  provider?: string
  modelId?: string
  contextWindow?: number
  prompt: RunPromptPayload
  promptPreview: string
  recoveredFromRunId?: string
  checkpoint?: DurableRunCheckpoint
  usage: TokenUsage
  /** Cumulative usage snapshot for the model call that is currently streaming. */
  liveUsage?: TokenUsage
  contextTokens?: number
  contextPressure?: number
  /** Compacted successfully; awaiting usage from a subsequent model response. */
  contextUsagePending?: boolean
  tools: RunToolTiming[]
  compactions: RunCompactionMetric[]
  stopReason?: string
  error?: string
  revision: number
}

export interface RunTelemetryQuery {
  sessionPath?: string
  cwd?: string
  limit?: number
}

export interface RunTelemetryUpdate {
  runs: RunOperation[]
}

export interface RunRecoveryCandidate {
  run: RunOperation
  reason: 'interrupted-run' | 'queued-prompt'
  canResume: boolean
  canRestoreCheckpoint: boolean
  note: string
}

export type VerificationKind = 'typecheck' | 'lint' | 'test' | 'build'
export type VerificationRunState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'infrastructure-error'

export interface VerificationCommand {
  id: string
  kind: VerificationKind
  label: string
  executable: string
  args: string[]
  cwd: string
  source: string
  timeoutMs: number
}

export interface VerificationPlan {
  cwd: string
  discoveredAt: number
  packageManager?: string
  steps: VerificationCommand[]
  warnings: string[]
}

export interface VerificationStepResult extends VerificationCommand {
  state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'infrastructure-error'
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  exitCode?: number
  signal?: string
  outputTail: string
  outputTruncated: boolean
  error?: string
}

export interface VerificationRun {
  id: string
  cwd: string
  sessionPath?: string
  sourceRunId?: string
  state: VerificationRunState
  createdAt: number
  startedAt?: number
  finishedAt?: number
  currentStepId?: string
  steps: VerificationStepResult[]
  selectedKinds: VerificationKind[]
  repairAttempt: number
  repairPrompt?: string
  error?: string
  revision: number
}

export interface VerificationLogUpdate {
  runId: string
  stepId: string
  sequence: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface VerificationSnapshotUpdate {
  runs: VerificationRun[]
}

export interface VerificationPolicy {
  cwd: string
  autoRun: boolean
  autoRepair: boolean
  maxRepairAttempts: number
  selectedKinds: VerificationKind[]
}

export interface StartVerificationOptions {
  kinds?: VerificationKind[]
  sessionPath?: string
  sourceRunId?: string
  repairAttempt?: number
}

export type GitFileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'type-changed'
export type GitDiffScope = 'unstaged' | 'staged'
export type GitOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface GitFileStatus {
  /** Sum of staged and unstaged Git diff counts; binary changes count as zero. */
  additions?: number
  deletions?: number
  path: string
  oldPath?: string
  kind: GitFileKind
  indexCode: string
  worktreeCode: string
  staged: boolean
  unstaged: boolean
  conflicted: boolean
  binary: boolean
}

export interface GitWorkspaceSnapshot {
  snapshotId: string
  root: string
  head: string | null
  branch: string | null
  ahead: number
  behind: number
  operation: GitOperation
  files: GitFileStatus[]
  stagedCount: number
  unstagedCount: number
  conflictCount: number
  capturedAt: number
}

export type GitDiffLineKind = 'context' | 'add' | 'delete' | 'meta'

export interface GitDiffLine {
  id: string
  kind: GitDiffLineKind
  oldLine?: number
  newLine?: number
  text: string
}

export interface GitDiffHunk {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: GitDiffLine[]
}

export interface GitFileDiff {
  snapshotId: string
  path: string
  oldPath?: string
  scope: GitDiffScope
  binary: boolean
  additions: number
  deletions: number
  hunks: GitDiffHunk[]
  selectable: boolean
  rawPatch: string
}

export interface GitSelectionRequest {
  cwd: string
  snapshotId: string
  path: string
  action: 'stage' | 'unstage' | 'discard'
  hunkId?: string
  lineIds?: string[]
}

export interface GitConflictContent {
  path: string
  base?: string
  ours?: string
  theirs?: string
  working?: string
  binary: boolean
}

export interface GitCommitResult {
  commit: string
  summary: string
  snapshot: GitWorkspaceSnapshot
}

export interface GitSnapshotUpdate {
  snapshot: GitWorkspaceSnapshot
}
