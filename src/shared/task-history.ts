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
  | { kind: 'snapshot'; tasks: SessionTask[] }

/** Validate native Pion snapshots and legacy rpiv-todo snapshots. */
export function normalizeSessionTasks(raw: unknown): SessionTask[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const tasks: SessionTask[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return undefined
    const record = entry as Record<string, unknown>
    if ((typeof record.id !== 'number' && typeof record.id !== 'string') || typeof record.subject !== 'string') {
      return undefined
    }
    if (record.status !== undefined && !['pending', 'in_progress', 'completed', 'deleted'].includes(record.status as string)) return undefined
    if (typeof record.id === 'number' && !Number.isFinite(record.id)) return undefined
    if (record.description !== undefined && typeof record.description !== 'string') return undefined
    if (record.activeForm !== undefined && typeof record.activeForm !== 'string') return undefined
    if (record.blockedBy !== undefined && (!Array.isArray(record.blockedBy) || !record.blockedBy.every(Number.isFinite))) return undefined
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
 * Convert complete task snapshots into per-user-message plans.
 *
 * Legacy sessions may keep a session-wide todo list, so each new snapshot is
 * compared with the preceding one and only new/changed tasks are attributed
 * to the current message. Plans may continue across messages; only an explicit
 * empty snapshot starts a fresh id generation after a reset.
 */
export function deriveSessionTaskRuns(events: SessionTaskHistoryEvent[]): SessionTaskRun[] {
  interface MutableRun {
    key: string
    entryId?: string
    ordinal: number
    prompt: string
    timestamp?: string
    generation: number
    tasks: Map<string, SessionTask>
  }

  const runs: SessionTaskRun[] = []
  let previousSnapshot = new Map<string, SessionTask>()
  let current: MutableRun | null = null
  let userOrdinal = 0

  const finishCurrent = (): void => {
    if (!current) return
    const tasks = [...current.tasks.values()].filter((task) => task.status !== 'deleted')
    if (tasks.length > 0) {
      runs.push({
        key: current.key,
        entryId: current.entryId,
        ordinal: current.ordinal,
        prompt: current.prompt,
        timestamp: current.timestamp,
        tasks
      })
    }
    current = null
  }

  for (const event of events) {
    if (event.kind === 'user') {
      finishCurrent()
      userOrdinal += 1
      current = {
        key: event.key,
        entryId: event.entryId,
        ordinal: userOrdinal,
        prompt: event.prompt,
        timestamp: event.timestamp,
        generation: 0,
        tasks: new Map()
      }
      continue
    }

    if (!current) {
      // A branch/window may begin halfway through a run. Establish a baseline
      // without inventing a task group that has no visible user message.
      previousSnapshot = snapshotMap(event.tasks)
      continue
    }

    if (event.tasks.length === 0) {
      previousSnapshot = new Map()
      current.generation += 1
      continue
    }

    const nextSnapshot = snapshotMap(event.tasks)
    for (const task of event.tasks) {
      const baseKey = taskKey(task)
      const before = previousSnapshot.get(baseKey)
      const runKey = `${current.generation}:${baseKey}`
      if (current.tasks.has(runKey) || !before || !sameTask(before, task)) {
        current.tasks.set(runKey, task)
      }
    }
    previousSnapshot = nextSnapshot
  }

  finishCurrent()
  return runs
}
