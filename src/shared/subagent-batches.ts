/** Pure, bounded parent-tool projection. Never retain child bodies, usage or raw args. */
export interface SubagentBatchTask {
  index: number
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown'
  summary?: string
  summaryTruncated?: boolean
}
export interface SubagentBatch { version: 1; tasks: SubagentBatchTask[] }

const statuses = new Set(['pending', 'running', 'completed', 'failed', 'aborted', 'unknown'])
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80
}

/** SDK argument order is the only planned identity; task instructions are discarded. */
export function plannedSubagentBatch(args: unknown): SubagentBatch | undefined {
  const tasks = record(args)?.tasks
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 8) return undefined
  const projected: SubagentBatchTask[] = []
  for (let index = 0; index < tasks.length; index++) {
    const name = record(tasks[index])?.name
    if (!validName(name)) return undefined
    projected.push({ index, name, status: 'pending' })
  }
  return { version: 1, tasks: projected }
}

export function subagentBatchesEqual(a: SubagentBatch | undefined, b: SubagentBatch | undefined): boolean {
  return a === b || Boolean(a && b && a.tasks.length === b.tasks.length && a.tasks.every((task, i) => {
    const other = b.tasks[i]
    return task.index === other.index && task.name === other.name && task.status === other.status
      && task.summary === other.summary && task.summaryTruncated === other.summaryTruncated
  }))
}

/** Clip at code-point boundaries to both 2048 UTF-16 chars/task and 16 KiB UTF-8/batch. */
function summary(text: string, budget: number): { text: string; bytes: number; truncated: boolean } {
  let output = '', bytes = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (output.length + char.length > 2048 || bytes + size > budget) break
    output += char
    bytes += size
  }
  return { text: output, bytes, truncated: output.length !== text.length }
}

/** Fresh complete metadata or ordered legacy FINAL results only. Partial legacy
 * completion-order arrays establish no identity/status. Invalid metadata fails
 * closed; absent final metadata marks planned children unknown, never failed. */
export function projectSubagentBatchResult(
  details: unknown, known: SubagentBatch | undefined, final: boolean
): SubagentBatch | undefined {
  const source = record(details)
  const explicit = source?.subagentBatch !== undefined
  const batch = record(source?.subagentBatch)
  const legacy = !explicit && final && Array.isArray(source?.results)
  const tasks = explicit ? batch?.tasks : legacy ? source?.results : undefined
  let next: SubagentBatch | undefined
  if ((!explicit || batch?.version === 1) && Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 8
    && (!known || tasks.length === known.tasks.length)) {
    const projected: SubagentBatchTask[] = []
    let budget = 16 * 1024
    for (let position = 0; position < tasks.length; position++) {
      const task = record(tasks[position])
      const index = legacy ? position : task?.index
      const name = task?.name, status = task?.status
      const text = legacy ? task?.text : task?.summary
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= tasks.length
        || projected.some((row) => row.index === index) || !validName(name)
        || typeof status !== 'string' || !statuses.has(status)
        || (legacy && !['completed', 'failed', 'aborted'].includes(status))
        || (text !== undefined && typeof text !== 'string')
        || (task?.summaryTruncated !== undefined && typeof task.summaryTruncated !== 'boolean')
        || (known && !known.tasks.some((row) => row.index === index && row.name === name))) {
        projected.length = 0
        break
      }
      const row: SubagentBatchTask = { index: index as number, name, status: status as SubagentBatchTask['status'] }
      if (typeof text === 'string') {
        // Reserve a fair share for remaining children instead of letting a
        // long early summary consume the entire batch display budget.
        const clipped = summary(text, Math.floor(budget / (tasks.length - position)))
        budget -= clipped.bytes
        row.summary = clipped.text
        if (clipped.truncated || task?.summaryTruncated === true) row.summaryTruncated = true
      } else if (task?.summaryTruncated === true) row.summaryTruncated = true
      projected.push(row)
    }
    if (projected.length === tasks.length) next = { version: 1, tasks: projected.sort((a, b) => a.index - b.index) }
  }
  if (!next) next = final && known
    ? { version: 1, tasks: known.tasks.map(({ index, name }) => ({ index, name, status: 'unknown' })) }
    : known
  return subagentBatchesEqual(known, next) ? known : next
}
