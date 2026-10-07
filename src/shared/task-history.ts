import type { SessionTask, SessionTaskRun } from './types'

export const PION_TASK_TOOL_NAME = 'pion_task'
export const PION_TASK_STATE_TYPE = 'pion-task-state'
export const LEGACY_TASK_TOOL_NAME = 'todo'

export function isTaskToolName(name: unknown): name is string {
  return name === PION_TASK_TOOL_NAME || name === LEGACY_TASK_TOOL_NAME
}

export type SessionTaskHistoryEvent =
  | {
      kind: 'user'
      key: string
      entryId?: string
      prompt: string
      timestamp?: string
    }
  | ({ kind: 'snapshot' } & SessionTaskHistorySnapshot)

export interface SessionTaskHistorySnapshot {
  tasks: SessionTask[]
  planId?: string
  planStart?: boolean
}

/** Unknown statuses remain visible: they must never imply completion. */
export function hasIncompleteTasks(tasks: readonly { status?: unknown }[] | null | undefined): boolean {
  return tasks?.some((task) => task.status !== 'completed' && task.status !== 'deleted') ?? false
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TASKS = 4096
const MAX_TEXT_LENGTH = 65536

/** Validate native Pion snapshots and legacy rpiv-todo snapshots. */
export function normalizeSessionTasks(raw: unknown): SessionTask[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_TASKS) return undefined
  const tasks: SessionTask[] = []
  let textLength = 0
  let dependencyCount = 0
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return undefined
    const record = entry as Record<string, unknown>
    if ((typeof record.id !== 'number' && typeof record.id !== 'string') || typeof record.subject !== 'string') {
      return undefined
    }
    if (record.status !== undefined && !['pending', 'in_progress', 'completed', 'deleted'].includes(record.status as string)) return undefined
    if (typeof record.id === 'number' && !Number.isFinite(record.id)) return undefined
    if (typeof record.id === 'string' && record.id.length > 512) return undefined
    if (record.subject.length > MAX_TEXT_LENGTH) return undefined
    if (record.description !== undefined && (typeof record.description !== 'string' || record.description.length > MAX_TEXT_LENGTH)) return undefined
    if (record.activeForm !== undefined && (typeof record.activeForm !== 'string' || record.activeForm.length > MAX_TEXT_LENGTH)) return undefined
    if (record.blockedBy !== undefined && (!Array.isArray(record.blockedBy) || record.blockedBy.length > MAX_TASKS || !record.blockedBy.every(Number.isFinite))) return undefined
    textLength += record.subject.length
      + (typeof record.id === 'string' ? record.id.length : 0)
      + (typeof record.description === 'string' ? record.description.length : 0)
      + (typeof record.activeForm === 'string' ? record.activeForm.length : 0)
    dependencyCount += Array.isArray(record.blockedBy) ? record.blockedBy.length : 0
    if (textLength > 4 * 1024 * 1024 || dependencyCount > 65536) return undefined
    const status = record.status === 'in_progress' || record.status === 'completed' || record.status === 'deleted'
      ? record.status
      : 'pending'
    tasks.push({
      id: record.id,
      title: record.subject,
      status,
      activeForm: typeof record.activeForm === 'string' ? record.activeForm : undefined,
      description: typeof record.description === 'string' ? record.description : undefined
    })
  }
  return tasks
}

/** Missing/malformed/error results are not an empty task list. */
export function taskSnapshotFromResult(toolName: unknown, result: unknown): SessionTask[] | undefined {
  if (!isTaskToolName(toolName) || !result || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  if (record.isError) return undefined
  const details = record.details
  if (!details || typeof details !== 'object') return undefined
  const snapshot = details as Record<string, unknown>
  const tasks = normalizeSessionTasks(snapshot.tasks)
  if (tasks === undefined) return undefined
  const minimumId = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0) + 1
  if (snapshot.nextId !== undefined && (!Number.isSafeInteger(snapshot.nextId) || (snapshot.nextId as number) < minimumId)) return undefined
  return tasks
}

/** Custom entries are authoritative full snapshots, independent of tool messages. */
export function taskSnapshotFromEntry(entry: unknown): SessionTask[] | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  if (record.type !== 'custom' || record.customType !== PION_TASK_STATE_TYPE) return undefined
  const data = record.data
  if (!data || typeof data !== 'object' || (data as Record<string, unknown>).native !== 'pion') return undefined
  return taskSnapshotFromResult(PION_TASK_TOOL_NAME, { details: data })
}

/** Metadata is optional; malformed metadata never turns valid tasks into clear. */
export function taskHistorySnapshotFromResult(toolName: unknown, result: unknown): SessionTaskHistorySnapshot | undefined {
  const tasks = taskSnapshotFromResult(toolName, result)
  if (tasks === undefined) return undefined
  const details = (result as { details: Record<string, unknown> }).details
  const fallback = { tasks }
  // Legacy tools do not establish native plan identity, even if extra fields exist.
  if (toolName !== PION_TASK_TOOL_NAME) return fallback
  if (details.planId !== undefined && (typeof details.planId !== 'string' || !UUID_PATTERN.test(details.planId))) return fallback
  if (details.planStart !== undefined && typeof details.planStart !== 'boolean') return fallback
  if (details.completed !== undefined && typeof details.completed !== 'boolean') return fallback
  if (!details.planId || tasks.length === 0) return fallback
  return { tasks, planId: details.planId as string, ...(details.planStart === true ? { planStart: true } : {}) }
}

export function taskHistorySnapshotFromEntry(entry: unknown): SessionTaskHistorySnapshot | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  if (record.type !== 'custom' || record.customType !== PION_TASK_STATE_TYPE) return undefined
  const data = record.data
  if (!data || typeof data !== 'object' || (data as Record<string, unknown>).native !== 'pion') return undefined
  return taskHistorySnapshotFromResult(PION_TASK_TOOL_NAME, { details: data })
}

function taskKey(task: SessionTask): string {
  return `${typeof task.id}:${String(task.id)}`
}

function sameTask(left: SessionTask, right: SessionTask): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.status === right.status
    && left.activeForm === right.activeForm
    && left.description === right.description
}

function snapshotMap(tasks: SessionTask[]): Map<string, SessionTask> {
  return new Map(tasks.map((task) => [taskKey(task), task]))
}

/**
 * Explicit native identities aggregate across user turns, preserving the first
 * observed goal's anchor. No identity is inferred for legacy snapshots: those
 * retain the per-user changed-task projection. Clear resets only the baseline,
 * never the archive; reopening a known plan updates its existing archive row.
 */
export function deriveSessionTaskRuns(events: readonly SessionTaskHistoryEvent[]): SessionTaskRun[] {
  interface MutableRun {
    key: string
    entryId?: string
    ordinal: number
    prompt: string
    timestamp?: string
    tasks: Map<string, SessionTask>
  }

  const runs: MutableRun[] = []
  // null means the plan first appeared outside the visible user history.
  const plans = new Map<string, MutableRun | null>()
  let previousSnapshot = new Map<string, SessionTask>()
  let user: Extract<SessionTaskHistoryEvent, { kind: 'user' }> | undefined
  let legacyRun: MutableRun | undefined
  let generation = 0
  let userOrdinal = 0

  const newRun = (key: string): MutableRun => {
    const run = {
      key, entryId: user!.entryId, ordinal: userOrdinal,
      prompt: user!.prompt, timestamp: user!.timestamp,
      tasks: new Map<string, SessionTask>()
    }
    runs.push(run)
    return run
  }

  for (const event of events) {
    if (event.kind === 'user') {
      user = event
      userOrdinal += 1
      legacyRun = undefined
      generation = 0
      continue
    }

    if (event.tasks.length === 0) {
      previousSnapshot = new Map()
      generation += 1
      // Existing run contents deliberately survive explicit clear.
      continue
    }

    const nextSnapshot = snapshotMap(event.tasks)
    if (event.planId) {
      // A fresh identity (normally planStart) is a boundary even within one
      // user turn. Repeated planStart in custom/tool mirrors is not a reset.
      // First legacy mutations can acquire an identity without planStart;
      // never retroactively assign that identity to older legacy archive rows.
      if (!plans.has(event.planId)) {
        plans.set(event.planId, user ? newRun(`plan:${event.planId}`) : null)
        // Native plan boundaries must not contaminate a same-turn legacy row.
        legacyRun = undefined
        generation += 1
      }
      const run = plans.get(event.planId)
      // Full snapshots, including reopened/deleted tasks, are authoritative.
      if (run) run.tasks = nextSnapshot
      previousSnapshot = nextSnapshot
      continue
    }

    if (!user) {
      previousSnapshot = nextSnapshot
      continue
    }

    for (const task of event.tasks) {
      const baseKey = taskKey(task)
      const before = previousSnapshot.get(baseKey)
      const runKey = `${generation}:${baseKey}`
      if (legacyRun?.tasks.has(runKey) || !before || !sameTask(before, task)) {
        legacyRun ??= newRun(user.key)
        legacyRun.tasks.set(runKey, task)
      }
    }
    previousSnapshot = nextSnapshot
  }

  return runs.flatMap((run) => {
    const tasks = [...run.tasks.values()].filter((task) => task.status !== 'deleted')
    return tasks.length ? [{
      key: run.key, entryId: run.entryId, ordinal: run.ordinal,
      prompt: run.prompt, timestamp: run.timestamp, tasks
    }] : []
  })
}
