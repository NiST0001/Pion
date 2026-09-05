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
import { orderSessions, reorderSessionsByPaths } from './sessionOrder'
import {
  applyToolResult,
  errorText,
  nextTimelineId,
  parseToolArgs,
  resultText,
  truncate
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
    case 'session':
      return {
        ...state,
        session: action.session,
        busy: Boolean(action.session?.isStreaming || action.session?.isCompacting),
        compacting: action.session?.isCompacting ?? false,
        yolo: action.session?.yolo ?? false
      }
    case 'runCheckpoint':
      return { ...state, runCheckpoint: action.checkpoint }
    case 'sessions': {
      const projectCwd = action.sessions[0]?.projectCwd ?? state.status.cwd
      const previous = projectCwd ? state.sessionsByProject[projectCwd] ?? [] : []
      const sessions = reconcileSessionProjection(action.sessions, previous)
      return {
        ...state,
        sessions,
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
    case 'loadEntries':
      return {
        ...state,
        timeline: action.items,
        mode: action.mode ?? state.mode,
        timelineMutation: 'replace',
        timelineLoading: false,
        timelineError: undefined,
        // History replacement must not erase a running/compacting backend
        // selected while the page was being loaded.
        busy: state.busy,
        compacting: state.compacting
      }
    case 'prependEntries':
      if (action.items.length === 0) return state
      return {
        ...state,
        timeline: [...action.items, ...state.timeline],
        timelineMutation: 'prepend'
      }
    case 'appendEntries':
      if (action.items.length === 0) return state
      return {
        ...state,
        timeline: [...state.timeline, ...action.items],
        timelineMutation: 'append'
      }
    case 'timelineLoading':
      return {
        ...state,
        timelineLoading: action.loading,
        timelineError: action.loading ? undefined : state.timelineError
      }
    case 'timelineError':
      return { ...state, timelineLoading: false, timelineError: action.error }
    case 'clearTimeline':
      return {
        ...state,
        timeline: [],
        mode: 'build',
        yolo: false,
        timelineMutation: 'replace',
        timelineLoading: false,
        timelineError: undefined,
        busy: false,
        compacting: false,
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
  switch (event.type) {
    case 'agent_start':
      return { ...state, busy: true, compacting: false }

    case 'agent_settled':
      // Keep any queue snapshot until Pi emits its final queue_update. This is
      // important when an abort or failed compaction leaves a user message
      // waiting for an explicit retry.
      return finalizeStreaming({
        ...state,
        busy: false,
        compacting: false
      })

    case 'agent_end':
      // Pi may compact or retry after agent_end; agent_settled is the true idle boundary.
      return state

    case 'compaction_start':
      return { ...state, busy: true, compacting: true }

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
              text: messageText(message),
              images: messageImages(message)
            }
          ]
        }
      }
      if (message?.role === 'assistant') {
        return {
          ...state,
          timeline: [
            ...state.timeline,
            { kind: 'assistant', id: nextTimelineId(), text: '', thinking: '', streaming: true, live: true }
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
          return { ...item, streaming: false, error: errorText(sub.error) }
        }
        return item
      })
      return { ...state, timeline }
    }

    case 'message_end': {
      const { message } = event
      const text = messageText(message)
      const thinking = messageThinking(message)
      const timeline = state.timeline.flatMap((item) => {
        if (item.kind !== 'assistant' || !item.streaming) return [item]
        const nextText = text || item.text
        const nextThinking = thinking || item.thinking
        if (nextText === '' && nextThinking === '' && !item.error) return []
        return [{
          ...item,
          text: nextText,
          thinking: nextThinking,
          streaming: false
        }]
      })
      return { ...state, timeline }
    }

    case 'entry_appended': {
      const entry = event.entry
      if (!entry) return state
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
      const role = (entry.message as WireMessage | undefined)?.role
      const timeline = [...state.timeline]
      // attach the entry id to the most recent matching item that lacks one
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i]
        const isMatch =
          (item.kind === 'user' && role === 'user' && !item.entryId) ||
          (item.kind === 'assistant' && role === 'assistant' && !item.entryId)
        if (isMatch) {
          timeline[i] = { ...item, entryId: entry.id } as TimelineItem
          break
        }
      }
      return { ...state, timeline }
    }

    case 'tool_execution_start': {
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
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'tool' || item.tool.id !== event.toolCallId) return item
        return { ...item, tool: { ...item.tool, outputText: truncate(resultText(event.partialResult as ToolResultPayload), 2000) } }
      })
      return { ...state, timeline }
    }

    case 'tool_execution_end': {
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'tool' || item.tool.id !== event.toolCallId) return item
        return { ...item, tool: applyToolResult(item.tool, event.result, event.isError) }
      })
      return { ...state, timeline }
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
        compacting: false
      }
      if (event.aborted || event.errorMessage) return nextState
      return {
        ...nextState,
        timeline: [
          ...state.timeline,
          { kind: 'compaction', id: nextTimelineId(), summary: '上下文已压缩' }
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
