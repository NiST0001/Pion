/**
 * Agent 状态迁移：reducer 与实时事件（WireEvent -> 状态）归约。
 */
import type {
  ToolResultPayload,
  WireEvent,
  WireEventInput,
  WireMessage
} from '../../../shared/types'
import { messageText, messageThinking } from '../../../shared/types'
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

export function reducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    case 'status': {
      const dead = action.status.phase === 'stopped' || action.status.phase === 'error'
      const ready = action.status.phase === 'ready'
      return {
        ...state,
        status: action.status,
        busy: dead || ready ? false : state.busy,
        session: dead || ready ? null : state.session,
        sessions: dead ? [] : state.sessions,
        tree: dead || ready ? null : state.tree,
        models: ready ? [] : state.models,
        thinkingLevels: ready ? [] : state.thinkingLevels,
        commands: dead || ready ? [] : state.commands,
        mode: dead || ready ? 'build' : state.mode
      }
    }
    case 'session':
      return {
        ...state,
        session: action.session,
        busy: action.session?.isStreaming ?? false
      }
    case 'sessions': {
      const projectCwd = action.sessions[0]?.projectCwd ?? state.status.cwd
      const previous = projectCwd ? state.sessionsByProject[projectCwd] ?? [] : []
      const sessions = orderSessions(action.sessions, previous)
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
          orderSessions(sessions, state.sessionsByProject[cwd] ?? [])
        ])
      )
      return { ...state, sessionsByProject }
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
    case 'loadEntries':
      return {
        ...state,
        timeline: action.items,
        mode: action.mode ?? state.mode,
        timelineMutation: 'replace',
        busy: false
      }
    case 'prependEntries':
      if (action.items.length === 0) return state
      return {
        ...state,
        timeline: [...action.items, ...state.timeline],
        timelineMutation: 'prepend'
      }
    case 'clearTimeline':
      return {
        ...state,
        timeline: [],
        mode: 'build',
        timelineMutation: 'replace',
        busy: false,
        queued: { steering: 0, followUp: 0 }
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
      return { ...state, busy: true }

    case 'agent_settled':
      return finalizeStreaming({ ...state, busy: false, queued: { steering: 0, followUp: 0 } })

    case 'agent_end':
      return event.willRetry ? state : { ...state, busy: false }

    case 'message_start': {
      const { message } = event
      if (message?.role === 'user') {
        return {
          ...state,
          timeline: [
            ...state.timeline,
            { kind: 'user', id: nextTimelineId(), text: messageText(message) }
          ]
        }
      }
      if (message?.role === 'assistant') {
        return {
          ...state,
          timeline: [
            ...state.timeline,
            { kind: 'assistant', id: nextTimelineId(), text: '', thinking: '', streaming: true }
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

    case 'queue_update':
      return {
        ...state,
        queued: { steering: event.steering?.length ?? 0, followUp: event.followUp?.length ?? 0 }
      }

    case 'compaction_end': {
      if (event.aborted || event.errorMessage) return state
      return {
        ...state,
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
