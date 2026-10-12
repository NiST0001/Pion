import { describe, expect, it } from 'vitest'
import { plannedSubagentBatch, projectSubagentBatchResult, type SubagentBatchTask } from '../../src/shared/subagent-batches'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type AgentState } from '../../src/renderer/src/agent/types'
import type { WireEventInput } from '../../src/shared/types'

const args = { tasks: ['one', 'same', 'same', 'four'].map((name) => ({ name, task: 'PRIVATE INSTRUCTIONS' })) }
const planned = plannedSubagentBatch(args)!
const tasks: SubagentBatchTask[] = planned.tasks.map((task, i) => ({ ...task,
  status: (['completed', 'failed', 'aborted', 'running'] as const)[i], summary: `summary ${i}` }))
const payload = (rows = tasks) => ({ content: [{ type: 'text', text: 'same aggregate' }],
  details: { subagentBatch: { version: 1, tasks: rows } } })
function event(state: AgentState, input: WireEventInput) { return reducer(state, { type: 'event', event: input }) }
function row(state: AgentState) {
  const item = state.timeline.find((item) => item.kind === 'tool')
  if (item?.kind !== 'tool') throw new Error('missing batch')
  return item
}
const start = () => event(initialState, { type: 'tool_execution_start', toolCallId: 'batch', toolName: 'pion_subagents', args })

describe('bounded parent subagent batches', () => {
  it('projects 100 real indices with fair bounded summaries and rejects 101', () => {
    const tasks = Array.from({ length: 100 }, (_, index) => ({ name: `task-${index}`, task: 'private instruction' }))
    const planned = plannedSubagentBatch({ tasks })!
    expect(planned.tasks).toHaveLength(100)
    expect(plannedSubagentBatch({ tasks: [...tasks, tasks[0]] })).toBeUndefined()
    const rows = planned.tasks.map((task) => ({ ...task, status: 'completed', summary: '界'.repeat(2048) }))
    const projected = projectSubagentBatchResult({ subagentBatch: { version: 1, tasks: rows } }, planned, true)!
    expect(projected.tasks.map((task) => task.index)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(projected.tasks.every((task) => task.summary!.length > 0 && task.summaryTruncated)).toBe(true)
    expect(Buffer.byteLength(projected.tasks.map((task) => task.summary).join(''))).toBeLessThanOrEqual(16 * 1024)
    expect(projectSubagentBatchResult({ subagentBatch: { version: 1, tasks: [...rows, rows[0]] } }, undefined, true)).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain('private instruction')
  })
  it('projects all four planned identities without instructions, even duplicate names', () => {
    expect(planned.tasks.map((task) => task.index)).toEqual([0, 1, 2, 3])
    expect(planned.tasks.every((task) => task.status === 'pending')).toBe(true)
    expect(JSON.stringify(planned)).not.toContain('PRIVATE')
    const result = projectSubagentBatchResult(payload([...tasks].reverse()).details, planned, false)!
    expect(result.tasks).toEqual(tasks)
    expect(result.tasks[1].status).toBe('failed')
    expect(result.tasks[2].status).toBe('aborted')
    expect(projectSubagentBatchResult(payload().details, result, false)).toBe(result)
  })

  it.each([
    { version: 2, tasks },
    { version: 1, tasks: [...tasks, ...tasks, tasks[0]] },
    { version: 1, tasks: tasks.slice(1) },
    { version: 1, tasks: tasks.map((task) => ({ ...task, index: 0 })) },
    { version: 1, tasks: tasks.map((task) => ({ ...task, name: 'x'.repeat(81) })) },
    { version: 1, tasks: tasks.map((task) => ({ ...task, name: 'wrong identity' })) },
    { version: 1, tasks: tasks.map((task) => ({ ...task, status: 'imaginary' })) },
    { version: 1, tasks: tasks.map((task) => ({ ...task, summary: { body: 'PRIVATE' } })) }
  ])('fails closed for malformed/mismatched metadata: %j', (subagentBatch) => {
    expect(projectSubagentBatchResult({ subagentBatch }, planned, false)).toBe(planned)
    const final = projectSubagentBatchResult({ subagentBatch }, planned, true)!
    expect(final.tasks.map((task) => task.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(final.tasks.every((task) => task.summary === undefined)).toBe(true)
  })

  it('keeps SDK-valid whitespace names and rejects overlong names without changing task identity', () => {
    const batch = plannedSubagentBatch({ tasks: [{ name: ' ' }, { name: 'same' }] })!
    expect(batch.tasks).toEqual([{ index: 0, name: ' ', status: 'pending' }, { index: 1, name: 'same', status: 'pending' }])
    expect(plannedSubagentBatch({ tasks: [{ name: '' }] })).toBeUndefined()
    expect(plannedSubagentBatch({ tasks: [{ name: ' '.repeat(100000) }] })).toBeUndefined()
  })

  it('reserves a nonempty Unicode summary for every one of eight children', () => {
    const names = plannedSubagentBatch({ tasks: Array.from({ length: 8 }, (_, index) => ({ name: `task-${index}` })) })!
    const result = projectSubagentBatchResult({ subagentBatch: { version: 1,
      tasks: names.tasks.map((task) => ({ ...task, status: 'completed', summary: '界😀'.repeat(5000) })) } }, names, true)!
    expect(result.tasks).toHaveLength(8)
    for (const task of result.tasks) {
      expect(task.summary!.length).toBeGreaterThan(0)
      expect(task.summaryTruncated).toBe(true)
      expect(task.summary).toMatch(/^(?:界😀)+界?$/)
    }
    expect(Buffer.byteLength(result.tasks.map((task) => task.summary).join(''), 'utf8')).toBeLessThanOrEqual(16 * 1024)
  })

  it('bounds Unicode summaries by per-child chars and total UTF-8 bytes, marking truncation', () => {
    const result = projectSubagentBatchResult({ subagentBatch: { version: 1,
      tasks: tasks.map((task) => ({ ...task, summary: '界'.repeat(5000), usage: { secret: true }, body: 'PRIVATE' })) } }, planned, true)!
    expect(result.tasks.every((task) => task.summary!.length <= 2048 && task.summaryTruncated)).toBe(true)
    expect(Buffer.byteLength(result.tasks.map((task) => task.summary).join(''), 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|usage|secret/)
  })

  it('uses ordered complete legacy finals, never completion-order partials', () => {
    const results = tasks.map((task) => ({ name: task.name,
      status: task.status === 'running' ? 'completed' : task.status, text: task.summary }))
    expect(projectSubagentBatchResult({ results: [...results].reverse() }, planned, false)).toBe(planned)
    const final = projectSubagentBatchResult({ results }, planned, true)!
    expect(final.tasks.map((task) => [task.index, task.status, task.summary])).toEqual([
      [0, 'completed', 'summary 0'], [1, 'failed', 'summary 1'], [2, 'aborted', 'summary 2'], [3, 'completed', 'summary 3']
    ])
    expect(projectSubagentBatchResult({ results: results.slice(1) }, planned, true)!.tasks.every((task) => task.status === 'unknown')).toBe(true)
    expect(projectSubagentBatchResult(undefined, planned, true)!.tasks.every((task) => task.status === 'unknown')).toBe(true)
  })

  it('live pending→mixed→final keeps mounted IDs, exact no-change references and final priority', () => {
    let state = start()
    const mounted = row(state).id
    expect(row(state).tool.subagentBatch!.tasks).toHaveLength(4)
    const partial: WireEventInput = { type: 'tool_execution_update', toolCallId: 'batch', toolName: 'pion_subagents', partialResult: payload() }
    state = event(state, partial)
    expect(row(state).tool.subagentBatch!.tasks).toEqual(tasks)
    expect(event(state, partial)).toBe(state)
    const final = payload(tasks.map((task) => ({ ...task, status: 'completed' })))
    const finalEvent: WireEventInput = { type: 'message_end', message: { role: 'toolResult', toolCallId: 'batch', toolName: 'pion_subagents', ...final } }
    state = event(state, finalEvent)
    expect(row(state).id).toBe(mounted)
    expect(row(state).tool.resultSource).toBe('message')
    expect(event(state, finalEvent)).toBe(state)
    expect(event(state, partial)).toBe(state)
    expect(event(state, { type: 'tool_execution_end', toolCallId: 'batch', toolName: 'pion_subagents', result: payload(), isError: true })).toBe(state)
    const previous = row(state).tool
    state = event(state, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'batch', ...payload(tasks.map((task) => ({ ...task, status: 'completed', summary: 'new per-child summary' }))) } })
    expect(row(state).tool).not.toBe(previous)
    expect(row(state).tool.subagentBatch!.tasks[0].summary).toBe('new per-child summary')
  })

  it.each([false, true])('full replay preserves metadata and unchanged objects (missed start=%s)', (missedStart) => {
    const first: WireEventInput = missedStart
      ? { type: 'message_end', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'batch', name: 'pion_subagents', arguments: args }
      ] } }
      : { type: 'tool_execution_start', toolCallId: 'batch', toolName: 'pion_subagents', args }
    const events: WireEventInput[] = [
      first,
      { type: 'tool_execution_update', toolCallId: 'batch', toolName: 'pion_subagents', partialResult: payload() },
      { type: 'message_end', message: { role: 'toolResult', toolCallId: 'batch', ...payload() } }
    ]
    const session = { sessionId: 'parent', sessionFile: '/parent.jsonl', isStreaming: true, messageCount: 1,
      liveState: { backendId: 'backend', revision: 1, cwd: '/project', sessionPath: '/parent.jsonl', events } }
    let state = reducer({ ...initialState, status: { phase: 'running', cwd: '/project' },
      liveSessionOwnerPath: '/parent.jsonl' }, { type: 'session', session })
    const original = row(state)
    expect(original.tool.subagentBatch!.tasks).toEqual(tasks)
    state = reducer(state, { type: 'session', session: { ...session, liveState: { ...session.liveState, revision: 2 } } })
    expect(row(state)).toBe(original)
    const cache = state.timeline.map((item) => item.kind === 'tool'
      ? { ...item, tool: { ...item.tool, subagentBatch: planned, resultReceived: false } } : item)
    state = reducer(state, { type: 'loadEntries', items: cache, replayHistory: true,
      preserveToolState: { revision: state.timelineScopeRevision, cwd: '/project', sessionPath: '/parent.jsonl' },
      cachedBackendId: 'backend' })
    expect(row(state).id).toBe(original.id)
    expect(row(state).tool.subagentBatch).toBe(original.tool.subagentBatch)
  })

  const terminalTasks = tasks.map((task) => ({ ...task, status: 'completed' as const }))
  function snapshot(state: AgentState, rows: SubagentBatchTask[] | undefined, marked = false, revision = 1, backendId = 'backend') {
    return reducer(state, { type: 'session', session: {
      sessionId: 'parent', sessionFile: '/parent.jsonl', isStreaming: false, messageCount: 1,
      liveState: { backendId, revision, cwd: '/project', sessionPath: '/parent.jsonl', events: [
        { type: 'tool_execution_start', toolCallId: 'batch', toolName: 'pion_subagents', args },
        { type: 'message_end', message: { role: 'toolResult', toolCallId: 'batch',
          content: [{ type: 'text', text: 'same aggregate' }],
          ...(rows ? { details: { subagentBatch: { version: 1, tasks: rows } } } : {}),
          ...(marked ? { _pionLiveTruncatedFields: ['subagentBatch'] } : {}) } }
      ] }
    } })
  }
  const owned = () => ({ ...initialState, status: { phase: 'running' as const, cwd: '/project' },
    liveSessionOwnerPath: '/parent.jsonl' })

  it('keeps all four accepted summaries on marked STATE loss while applying fresh terminal statuses', () => {
    let state = snapshot(owned(), tasks)
    const mounted = row(state).id
    const cropped = terminalTasks.map(({ summary: _summary, ...task }) => ({ ...task, summaryTruncated: true }))
    state = snapshot(state, cropped, true, 2)
    expect(row(state).id).toBe(mounted)
    expect(row(state).tool.subagentBatch!.tasks).toEqual(terminalTasks)
    expect(row(state).tool.resultSource).toBe('message')
    const original = row(state)
    state = snapshot(state, cropped, true, 3)
    expect(row(state)).toBe(original)
    expect(row(snapshot(state, tasks, true, 1))).toBe(original)
    expect(event(state, { type: 'tool_execution_update', toolCallId: 'batch', partialResult: payload() })).toBe(state)
  })

  it('marked fully omitted batch preserves only previously accepted terminal children', () => {
    const state = snapshot(snapshot(owned(), tasks), undefined, true, 2)
    expect(row(state).tool.subagentBatch!.tasks).toEqual(tasks.map((task) => task.status === 'running'
      ? { index: task.index, name: task.name, status: 'unknown' } : task))
    const running = snapshot(snapshot(owned(), planned.tasks), undefined, true, 2)
    expect(row(running).tool.subagentBatch!.tasks.every((task) => task.status === 'unknown' && task.summary === undefined)).toBe(true)
  })

  it.each(['missing', 'absent-summary', 'empty-summary'] as const)('unmarked final clears old summaries (%s)', (mode) => {
    const missing = mode === 'missing'
    const state = snapshot(snapshot(owned(), terminalTasks), missing ? undefined
      : terminalTasks.map(({ summary: _summary, ...task }) => ({ ...task, ...(mode === 'empty-summary' ? { summary: '' } : {}) })), false, 2)
    expect(row(state).tool.subagentBatch!.tasks.every((task) => task.summary === (mode === 'empty-summary' ? '' : undefined))).toBe(true)
    expect(row(state).tool.subagentBatch!.tasks.map((task) => task.status)).toEqual(
      Array(4).fill(missing ? 'unknown' : 'completed'))
  })

  it.each(['name', 'index', 'backend'] as const)('never supplements a changed %s identity', (changed) => {
    const cropped = terminalTasks.map(({ summary: _summary, ...task }, index) => ({ ...task,
      name: changed === 'name' ? `new-${index}` : task.name,
      index: changed === 'index' ? 0 : task.index, summaryTruncated: true }))
    const state = snapshot(snapshot(owned(), terminalTasks), changed === 'backend' ? undefined : cropped,
      true, 2, changed === 'backend' ? 'new-backend' : 'backend')
    expect(row(state).tool.subagentBatch!.tasks.every((task) => task.status === 'unknown' && task.summary === undefined)).toBe(true)
  })

  it('same accepted cropped STATE may fill summaries from a later cache without replacing fresh status', () => {
    const complete = snapshot(owned(), terminalTasks)
    const cached = complete.timeline
    const cropped = tasks.map(({ summary: _summary, ...task }) => ({ ...task, summaryTruncated: true }))
    let state = snapshot(owned(), cropped, true)
    const mounted = row(state).id
    state = reducer(state, { type: 'loadEntries', items: cached, replayHistory: true,
      preserveToolState: { revision: state.timelineScopeRevision, cwd: '/project', sessionPath: '/parent.jsonl' },
      cachedBackendId: 'backend' })
    expect(row(state).tool.subagentBatch!.tasks).toEqual(tasks)
    expect(row(state).id).toBe(mounted)
    const cleared = snapshot(state, undefined, false, 2)
    const restored = reducer(cleared, { type: 'loadEntries', items: cached, replayHistory: true,
      preserveToolState: { revision: cleared.timelineScopeRevision, cwd: '/project', sessionPath: '/parent.jsonl' },
      cachedBackendId: 'backend' })
    expect(row(restored).tool.subagentBatch!.tasks.every((task) => task.status === 'unknown' && task.summary === undefined)).toBe(true)
  })

  it('late marked progress in STATE cannot revive a real unknown final or lend it cache supplementation', () => {
    const complete = snapshot(owned(), terminalTasks)
    const cleared = snapshot(complete, undefined, false, 2)
    const session = cleared.session!
    const live = session.liveState!
    let state = reducer(cleared, { type: 'session', session: { ...session, liveState: { ...live,
      revision: 3, events: [...live.events, { type: 'tool_execution_update', toolCallId: 'batch',
        partialResult: { ...payload(), _pionLiveTruncatedFields: ['subagentBatch'] } }] } } })
    state = reducer(state, { type: 'loadEntries', items: complete.timeline, replayHistory: true,
      preserveToolState: { revision: state.timelineScopeRevision, cwd: '/project', sessionPath: '/parent.jsonl' },
      cachedBackendId: 'backend' })
    expect(row(state).tool.subagentBatch!.tasks.every((task) => task.status === 'unknown' && task.summary === undefined)).toBe(true)
    expect(row(state).tool.resultSource).toBe('message')
  })

  it('recovers a missed execution start from assistant calls and marks pre-run error unknown', () => {
    let state = event(initialState, { type: 'message_end', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'batch', name: 'pion_subagents', arguments: args }
    ] } })
    expect(row(state).tool.subagentBatch!.tasks).toHaveLength(4)
    state = event(state, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'batch', isError: true,
      content: [{ type: 'text', text: 'FinalCallError: not executed' }] } })
    expect(row(state).tool.subagentBatch!.tasks.every((task) => task.status === 'unknown')).toBe(true)
  })
})
