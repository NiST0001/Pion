/**
 * Agent 状态迁移：reducer 与实时事件（WireEvent -> 状态）归约。
 */
import type {
  ToolResultPayload,
  WireEvent,
  WireEventInput,
  WireMessage
} from '../../../shared/types'
import { messageImages, messageText, messageThinking } from '../../../shared/types'
import { taskSnapshotFromEntry, taskSnapshotFromResult } from '../../../shared/task-history'
import { orderSessions, reorderSessionsByPaths } from './sessionOrder'
import {
  applyToolResult,
  assistantErrorText,
  collectToolResults,
  compactionFingerprint,
  nextTimelineId,
  parseToolArgs,
  preserveTimelineToolState,
  reconcileCompletedAssistantRows,
  reconcileNewerTimelineItems,
  reconcileOlderTimelineItems,
  resultText,
  toolResultMatches,
  truncate,
  wireMessageTimestamp
} from './timeline'
import type { Action, AgentState, TimelineItem, ToolItem } from './types'

/** Keep a just-sent empty session visible until Pi's JSONL index catches up. */
function reconcileSessionProjection(incoming: AgentState['sessions'], previous: AgentState['sessions']): AgentState['sessions'] {
  const persistedIds = new Set(incoming.map((session) => session.id))
  const pending = previous.filter((session) => session.optimistic && !persistedIds.has(session.id))
  return orderSessions([...incoming, ...pending], previous)
}

export function reducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    case 'status': {
      const dead = action.status.phase === 'stopped' || action.status.phase === 'error'
      const ready = action.status.phase === 'ready'
      return {
        ...state,
        status: action.status,
        busy: dead || ready ? false : state.busy,
        compacting: dead || ready ? false : state.compacting,
        compactionEventState: dead || ready ? undefined : state.compactionEventState,
        timelineLoading: dead ? false : state.timelineLoading,
        timelineError: dead ? undefined : state.timelineError,
        session: dead || ready ? null : state.session,
        sessions: dead ? [] : state.sessions,
        tree: dead || ready ? null : state.tree,
        historyIndex: dead || ready ? null : state.historyIndex,
        historyJump: dead || ready ? null : state.historyJump,
        models: ready ? [] : state.models,
        thinkingLevels: ready ? [] : state.thinkingLevels,
        commands: dead || ready ? [] : state.commands,
        mode: dead || ready ? 'build' : state.mode,
        yolo: dead || ready ? false : state.yolo,
        queued: dead || ready ? { steering: 0, followUp: 0 } : state.queued,
        queuedMessages: dead || ready
          ? { steering: [], followUp: [], nativeFollowUpCount: 0 }
          : state.queuedMessages
      }
    }
    case 'session': {
      const incoming = action.session
      const sameSession = Boolean(incoming && (!state.session
        || (incoming.sessionFile && incoming.sessionFile === state.session.sessionFile)
        || (incoming.sessionId && incoming.sessionId === state.session.sessionId)))
      const compactionEventState = sameSession ? state.compactionEventState : undefined
      const compacting = compactionEventState ?? incoming?.isCompacting ?? false
      return {
        ...state,
        session: incoming,
        busy: Boolean(incoming?.isStreaming || compacting),
        compacting,
        compactionEventState,
        yolo: incoming?.yolo ?? false
      }
    }
    case 'runCheckpoint':
      return { ...state, runCheckpoint: action.checkpoint }
    case 'sessions': {
      const projectCwd = action.sessions[0]?.projectCwd ?? state.status.cwd
      const previous = projectCwd ? state.sessionsByProject[projectCwd] ?? [] : []
      const sessions = reconcileSessionProjection(action.sessions, previous)
      return {
        ...state,
        sessions: !projectCwd || projectCwd === state.status.cwd ? sessions : state.sessions,
        sessionsByProject: projectCwd
          ? { ...state.sessionsByProject, [projectCwd]: sessions }
          : state.sessionsByProject
      }
    }
    case 'projectSessions': {
      const sessionsByProject = Object.fromEntries(
        Object.entries(action.sessionsByProject).map(([cwd, sessions]) => [
          cwd,
          reconcileSessionProjection(sessions, state.sessionsByProject[cwd] ?? [])
        ])
      )
      return { ...state, sessionsByProject }
    }
    case 'projectSessionsUpdate': {
      const sessions = reconcileSessionProjection(
        action.sessions,
        state.sessionsByProject[action.cwd] ?? []
      )
      return {
        ...state,
        sessions: state.status.cwd === action.cwd ? sessions : state.sessions,
        sessionsByProject: { ...state.sessionsByProject, [action.cwd]: sessions }
      }
    }
    case 'optimisticSession': {
      const cwd = action.session.projectCwd
      if (!cwd) return state
      const previous = state.sessionsByProject[cwd] ?? []
      const withoutDuplicate = previous.filter((session) => session.id !== action.session.id)
      const sessions = orderSessions([...withoutDuplicate, action.session], previous)
      return {
        ...state,
        sessions: state.status.cwd === cwd ? sessions : state.sessions,
        sessionsByProject: { ...state.sessionsByProject, [cwd]: sessions }
      }
    }
    case 'removeOptimisticSession': {
      const previous = state.sessionsByProject[action.cwd] ?? []
      const sessions = previous.filter((session) => (
        session.id !== action.id || !session.optimistic
      ))
      if (sessions.length === previous.length) return state
      return {
        ...state,
        sessions: state.status.cwd === action.cwd ? sessions : state.sessions,
        sessionsByProject: { ...state.sessionsByProject, [action.cwd]: sessions }
      }
    }
    case 'branches':
      return { ...state, branchesByProject: { ...state.branchesByProject, [action.cwd]: action.branches } }
    case 'reorderSessions': {
      const current = state.sessionsByProject[action.cwd] ?? []
      const ordered = reorderSessionsByPaths(current, action.paths)
      return {
        ...state,
        sessions: state.status.cwd === action.cwd ? ordered : state.sessions,
        sessionsByProject: { ...state.sessionsByProject, [action.cwd]: ordered }
      }
    }
    case 'tree':
      return { ...state, tree: action.tree }
    case 'historyIndex':
      return { ...state, historyIndex: action.index }
    case 'historyJump':
      return { ...state, historyJump: { entryId: action.entryId, nonce: action.nonce } }
    case 'projects': {
      const projectCwds = new Set(action.projects.map((project) => project.cwd))
      const sessionsByProject = Object.fromEntries(
        Object.entries(state.sessionsByProject).filter(([cwd]) => projectCwds.has(cwd))
      )
      const branchesByProject = Object.fromEntries(
        Object.entries(state.branchesByProject).filter(([cwd]) => projectCwds.has(cwd))
      )
      return { ...state, projects: action.projects, sessionsByProject, branchesByProject }
    }
    case 'models':
      return { ...state, models: action.models }
    case 'thinkingLevels':
      return { ...state, thinkingLevels: action.levels }
    case 'commands':
      return { ...state, commands: action.commands }
    case 'mode':
      return { ...state, mode: action.mode }
    case 'runningSessionPaths':
      return { ...state, runningSessionPaths: action.paths }
    case 'unreadSessions':
      return { ...state, unreadSessionPaths: action.paths }
    case 'beginTaskRestore':
      return { ...state, taskRestore: { id: action.id, revision: state.taskRevision } }
    case 'restoreTasks': {
      const pending = state.taskRestore
      if (pending?.id !== action.id) return state
      return {
        ...state,
        // A reply started before a live update must not rewind it (including clear).
        tasks: pending.revision === state.taskRevision ? action.tasks : state.tasks,
        taskRestore: undefined
      }
    }
    case 'cachedTasks':
      // A live clear is authoritative too; only seed a still-unknown projection.
      return state.tasks === null ? { ...state, tasks: action.tasks } : state
    case 'loadEntries': {
      const scope = action.preserveToolState
      // The hook explicitly opts in for same-selection reads. Recheck at the
      // reducer's event boundary: a queued clear/session/project change must
      // not reuse another transcript's call IDs or mounted tool components.
      const preserve = scope && scope.revision === state.timelineScopeRevision
        && (scope.cwd === undefined || state.status.cwd === undefined || scope.cwd === state.status.cwd)
        && (scope.sessionId === undefined || !state.session?.sessionId || scope.sessionId === state.session.sessionId)
        && (scope.sessionPath === undefined || !state.session?.sessionFile || scope.sessionPath === state.session.sessionFile)
      return {
        ...state,
        timeline: preserve ? preserveTimelineToolState(state.timeline, action.items) : action.items,
        timelineLoadId: action.loadId ?? state.timelineLoadId,
        mode: action.mode ?? state.mode,
        timelineMutation: 'replace',
        timelineLoading: false,
        timelineError: undefined,
        // History replacement must not erase a running/compacting backend
        // selected while the page was being loaded.
        busy: state.busy,
        compacting: state.compacting
      }
    }
    case 'prependEntries': {
      const timeline = reconcileOlderTimelineItems(
        state.timeline, action.items, collectToolResults(action.toolResults ?? [])
      ).items
      if (timeline === state.timeline) return state
      return { ...state, timeline, timelineMutation: 'prepend' }
    }
    case 'appendEntries': {
      // Reconcile at reducer time so a message/tool event queued immediately
      // before this page cannot race a stale cursor snapshot in the hook.
      const timeline = reconcileNewerTimelineItems(
        state.timeline, action.items, collectToolResults(action.toolResults ?? [])
      ).items
      const unchanged = timeline.length === state.timeline.length
        && timeline.every((item, index) => item === state.timeline[index])
      if (unchanged) return state
      return {
        ...state,
        timeline,
        // Loading the next historical page must never act like live output.
        timelineMutation: 'history-append'
      }
    }
    case 'timelineLoading':
      return {
        ...state,
        timelineLoading: action.loading,
        timelineError: action.loading ? undefined : state.timelineError
      }
    case 'timelineError':
      return { ...state, timelineLoading: false, timelineError: action.error }
    case 'resetHistoryNavigation':
      return { ...state, historyResetRevision: state.historyResetRevision + 1, historyJump: null }
    case 'clearTimeline':
      return {
        ...state,
        historyJump: null,
        tasks: null,
        taskRevision: 0,
        taskResultIds: [],
        taskRestore: undefined,
        timeline: [],
        timelineScopeRevision: state.timelineScopeRevision + 1,
        mode: 'build',
        yolo: false,
        timelineMutation: 'replace',
        timelineLoading: false,
        timelineError: undefined,
        busy: false,
        compacting: false,
        compactionEventState: undefined,
        queued: { steering: 0, followUp: 0 },
        queuedMessages: { steering: [], followUp: [], nativeFollowUpCount: 0 }
      }
    case 'event': {
      const next = reduceEvent(state, action.event)
      return next.timeline === state.timeline ? next : { ...next, timelineMutation: 'append' }
    }
  }
}

function reduceEvent(state: AgentState, input: WireEventInput): AgentState {
  // trusted boundary: unmodelled event types fall through to the default branch
  const event = input as WireEvent
  // Native script child calls belong to the parent's result, not standalone
  // transcript rows. Defensive filtering also covers cached/direct wire replay.
  if ((event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end')
    && typeof event.parentToolCallId === 'string' && event.parentToolCallId.length > 0) return state
  // Task state belongs to the session, not to whichever tool rows are mounted.
  // Persisted/message results also recover a missed tool_execution_start/end.
  const taskMessage = event.type === 'message_end' ? event.message
    : event.type === 'entry_appended' && event.entry?.type === 'message' ? event.entry.message : undefined
  const customTasks = event.type === 'entry_appended' ? taskSnapshotFromEntry(event.entry) : undefined
  const tasks = customTasks !== undefined ? customTasks : event.type === 'tool_execution_end' && !event.isError
    ? taskSnapshotFromResult(event.toolName, event.result)
    : taskMessage?.role === 'toolResult'
      ? taskSnapshotFromResult(taskMessage.toolName, taskMessage)
      : undefined
  const resultId = customTasks !== undefined && event.type === 'entry_appended'
    ? `entry:${event.entry?.id}`
    : event.type === 'tool_execution_end' ? event.toolCallId : taskMessage?.toolCallId
  if (tasks !== undefined && (typeof resultId !== 'string' || !state.taskResultIds.includes(resultId))) {
    state = {
      ...state,
      tasks,
      taskRevision: state.taskRevision + 1,
      taskResultIds: typeof resultId === 'string'
        ? [...state.taskResultIds.slice(-255), resultId] : state.taskResultIds
    }
  }
  switch (event.type) {
    case 'agent_start':
      return { ...state, busy: true, compacting: false, compactionEventState: false }

    case 'agent_settled':
      // Keep any queue snapshot until Pi emits its final queue_update. This is
      // important when an abort or failed compaction leaves a user message
      // waiting for an explicit retry.
      return finalizeStreaming({
        ...state,
        busy: false,
        compacting: false,
        compactionEventState: false
      })

    case 'agent_end':
      // Pi may compact or retry after agent_end; agent_settled is the true idle boundary.
      return state

    case 'compaction_start':
      return { ...state, busy: true, compacting: true, compactionEventState: true }

    case 'message_start': {
      const { message } = event
      if (message?.role === 'user') {
        return {
          ...state,
          timeline: [
            ...state.timeline,
            {
              kind: 'user',
              id: nextTimelineId(),
              messageTimestamp: wireMessageTimestamp(message),
              text: messageText(message),
              images: messageImages(message),
              live: true
            }
          ]
        }
      }
      if (message?.role === 'assistant') {
        return {
          ...state,
          timeline: [
            ...state.timeline,
            {
              kind: 'assistant',
              id: nextTimelineId(),
              messageTimestamp: wireMessageTimestamp(message),
              text: '',
              thinking: '',
              streaming: true,
              live: true
            }
          ]
        }
      }
      return state
    }

    case 'message_update': {
      const sub = event.assistantMessageEvent
      if (!sub) return state
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'assistant' || !item.streaming) return item
        if (sub.type === 'text_delta' && typeof sub.delta === 'string') {
          return { ...item, text: item.text + sub.delta }
        }
        if (sub.type === 'thinking_delta' && typeof sub.delta === 'string') {
          return { ...item, thinking: item.thinking + sub.delta }
        }
        if (sub.type === 'error') {
          const error = assistantErrorText(sub.error)
          return error ? { ...item, error } : item
        }
        return item
      })
      return { ...state, timeline }
    }

    case 'message_end': {
      const { message } = event
      if (message?.role === 'toolResult') {
        if (typeof message.toolCallId !== 'string') return state
        let changed = false
        const timeline = state.timeline.map((item) => {
          if (item.kind !== 'tool' || item.tool.id !== message.toolCallId) return item
          const identical = toolResultMatches(item.tool, message, Boolean(message.isError))
          if (identical && item.tool.resultSource !== 'execution') return item
          changed = true
          return {
            ...item,
            tool: identical
              ? { ...item.tool, resultSource: 'message' as const }
              : applyToolResult(item.tool, message, Boolean(message.isError), 'message')
          }
        })
        // Final message replacements are authoritative; identical notifications
        // keep previews intact, while late execution_end cannot rewind them.
        return changed ? { ...state, timeline } : state
      }
      if (message?.role !== 'assistant') return state
      const text = messageText(message)
      const thinking = messageThinking(message)
      const error = assistantErrorText(message)
      const timeline = state.timeline.flatMap((item) => {
        if (item.kind !== 'assistant' || !item.streaming) return [item]
        // Extensions may replace a nonempty draft with an empty final message.
        // Empty text/thinking is authoritative too, not a missing update.
        const nextText = text
        const nextThinking = thinking
        // message_end is the authoritative assistant result. Do not retain a
        // provisional update error when the final message succeeds or aborts.
        const nextError = error
        if (nextText === '' && nextThinking === '' && !nextError) return []
        const nextItem: Extract<TimelineItem, { kind: 'assistant' }> = {
          ...item,
          messageTimestamp: wireMessageTimestamp(message) ?? item.messageTimestamp,
          text: nextText,
          thinking: nextThinking,
          streaming: false
        }
        if (nextError) nextItem.error = nextError
        else delete nextItem.error
        return [nextItem]
      })
      return { ...state, timeline: reconcileCompletedAssistantRows(timeline) }
    }

    case 'entry_appended': {
      // Task-only commits must not mutate the timeline or resume scroll following.
      if (customTasks !== undefined) return state
      const entry = event.entry
      if (!entry) return state
      if (state.timeline.some((item) => 'entryId' in item && item.entryId === entry.id)) return state
      if (entry.type === 'custom' && entry.customType === 'plan-mode-state') {
        const data = entry.data
        const enabled = data && typeof data === 'object'
          ? (data as Record<string, unknown>).enabled
          : undefined
        return typeof enabled === 'boolean'
          ? { ...state, mode: enabled ? 'plan' : 'build' }
          : state
      }
      if (entry.type === 'compaction') {
        const timeline = [...state.timeline]
        for (let i = timeline.length - 1; i >= 0; i--) {
          const item = timeline[i]
          if (item.kind === 'compaction' && !item.entryId) {
            timeline[i] = { ...item, entryId: entry.id }
            return { ...state, timeline }
          }
        }
        return state
      }
      if (entry.type !== 'message') return state
      const persistedMessage = entry.message as WireMessage | undefined
      const role = persistedMessage?.role
      const timestamp = wireMessageTimestamp(persistedMessage)
      const timeline = [...state.timeline]
      // Attach only the matching SDK message, not a later compaction failure
      // row or another assistant that happens to lack an entry ID.
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i]
        const isMatch =
          (item.kind === 'user' && role === 'user' && !item.entryId) ||
          (item.kind === 'assistant' && role === 'assistant' && !item.entryId && !item.errorContext)
        const timestampMatches = (item.kind !== 'user' && item.kind !== 'assistant')
          || timestamp === undefined || item.messageTimestamp === undefined
          || item.messageTimestamp === timestamp
        if (isMatch && timestampMatches) {
          timeline[i] = { ...item, entryId: entry.id } as TimelineItem
          break
        }
      }
      return { ...state, timeline }
    }

    case 'tool_execution_start': {
      const existing = state.timeline.find((item) => item.kind === 'tool' && item.tool.id === event.toolCallId)
      if (existing?.kind === 'tool') {
        if (existing.tool.live || existing.tool.resultReceived) return state
        const timeline = state.timeline.map((item) => item === existing ? {
          ...existing,
          historyReconciled: true,
          tool: {
            ...existing.tool,
            ...parseToolArgs(event.toolName, event.args),
            status: 'running' as const,
            isError: false,
            live: true
          }
        } : item)
        return { ...state, timeline }
      }
      const tool: ToolItem = {
        id: event.toolCallId,
        name: event.toolName,
        status: 'running',
        isError: false,
        live: true,
        ...parseToolArgs(event.toolName, event.args)
      }
      return { ...state, timeline: [...state.timeline, { kind: 'tool', id: nextTimelineId(), tool }] }
    }

    case 'tool_execution_update': {
      let changed = false
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'tool' || item.tool.id !== event.toolCallId || item.tool.status !== 'running') return item
        changed = true
        // Partial updates are text-only. Image validation/decoding belongs to
        // the shared final-result projection, not the streaming hot path.
        return { ...item, tool: { ...item.tool, outputText: truncate(resultText(event.partialResult as ToolResultPayload), 2000) } }
      })
      return changed ? { ...state, timeline } : state
    }

    case 'tool_execution_end': {
      let changed = false
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'tool' || item.tool.id !== event.toolCallId
          || item.tool.resultSource === 'message' || item.tool.resultSource === 'history'
          || toolResultMatches(item.tool, event.result, event.isError)) return item
        changed = true
        return { ...item, tool: applyToolResult(item.tool, event.result, event.isError) }
      })
      return changed ? { ...state, timeline } : state
    }

    case 'queue_update': {
      const steering = Array.isArray(event.steering)
        ? event.steering.filter((message): message is string => typeof message === 'string')
        : []
      const followUp = Array.isArray(event.followUp)
        ? event.followUp.filter((message): message is string => typeof message === 'string')
        : []
      const nativeFollowUpCount = typeof event.nativeFollowUpCount === 'number'
        ? event.nativeFollowUpCount
        : 0
      return {
        ...state,
        queued: { steering: steering.length, followUp: followUp.length },
        queuedMessages: { steering, followUp, nativeFollowUpCount }
      }
    }

    case 'compaction_end': {
      const nextState = {
        ...state,
        busy: event.reason === 'manual' ? false : state.busy,
        compacting: false,
        compactionEventState: false
      }
      if (event.aborted) return nextState
      if (event.errorMessage) {
        return {
          ...nextState,
          timeline: [
            ...state.timeline,
            {
              kind: 'assistant',
              id: nextTimelineId(),
              text: '',
              thinking: '',
              streaming: false,
              live: true,
              error: event.errorMessage,
              errorContext: 'compaction'
            }
          ]
        }
      }
      return {
        ...nextState,
        timeline: [
          ...state.timeline,
          {
            kind: 'compaction',
            id: nextTimelineId(),
            compactionFingerprint: compactionFingerprint(event.result),
            summary: '上下文已压缩',
            live: true
          }
        ]
      }
    }

    default:
      return state
  }
}

/** Close out any assistant bubble still marked as streaming. */
function finalizeStreaming(state: AgentState): AgentState {
  const timeline = state.timeline.flatMap((item) => {
    if (item.kind !== 'assistant' || !item.streaming) return [item]
    if (item.text === '' && item.thinking === '' && !item.error) return []
    return [{ ...item, streaming: false }]
  })
  return { ...state, timeline }
}
