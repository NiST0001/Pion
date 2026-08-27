import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AgentStatus, SessionInfo, WireEvent, WireEventInput, WireMessage } from '../../../shared/types'
import { messageText } from '../../../shared/types'

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

export interface ToolItem {
  id: string
  name: string
  argsText: string
  status: 'running' | 'done' | 'error'
  resultText: string
}

export type TimelineItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; thinking: string; streaming: boolean; error?: string }
  | { kind: 'tool'; id: number; tool: ToolItem }

export interface AgentState {
  status: AgentStatus
  session: SessionInfo | null
  timeline: TimelineItem[]
  busy: boolean
  queued: { steering: number; followUp: number }
}

const initialState: AgentState = {
  status: { phase: 'stopped' },
  session: null,
  timeline: [],
  busy: false,
  queued: { steering: 0, followUp: 0 }
}

type Action =
  | { type: 'status'; status: AgentStatus }
  | { type: 'session'; session: SessionInfo | null }
  | { type: 'event'; event: WireEventInput }

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… (+${text.length - max} 字符)`
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  try {
    return truncate(JSON.stringify(args), 240)
  } catch {
    return String(args)
  }
}

function formatResult(toolName: string, result: unknown): string {
  if (result === undefined || result === null) return ''
  const r = result as Record<string, unknown>
  if (toolName === 'bash' || toolName === 'powershell') {
    const stdout = typeof r.stdout === 'string' ? r.stdout : ''
    const stderr = typeof r.stderr === 'string' ? r.stderr : ''
    const exit = r.exitCode
    const body = (stdout || stderr || '').trim()
    return `[exit ${String(exit)}] ${truncate(body, 1200)}`
  }
  try {
    return truncate(JSON.stringify(result, null, 2), 1200)
  } catch {
    return String(result)
  }
}

function errorText(event: WireMessage | undefined): string {
  if (!event) return '未知错误'
  return event.errorMessage || messageText(event) || '未知错误'
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

let nextId = 1

function reducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    case 'status': {
      const stopped = action.status.phase === 'stopped' || action.status.phase === 'error'
      return {
        ...state,
        status: action.status,
        busy: stopped ? false : state.busy,
        session: stopped ? null : state.session
      }
    }
    case 'session':
      return { ...state, session: action.session }
    case 'event':
      return reduceEvent(state, action.event)
  }
}

function reduceEvent(state: AgentState, input: WireEventInput): AgentState {
  // 可信边界：未建模的事件类型在 default 分支静默忽略
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
          timeline: [...state.timeline, { kind: 'user', id: nextId++, text: messageText(message) }]
        }
      }
      if (message?.role === 'assistant') {
        return {
          ...state,
          timeline: [
            ...state.timeline,
            { kind: 'assistant', id: nextId++, text: '', thinking: '', streaming: true }
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
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'assistant' || !item.streaming) return item
        return { ...item, text: text || item.text, streaming: false }
      })
      return { ...state, timeline }
    }

    case 'tool_execution_start': {
      const tool: ToolItem = {
        id: event.toolCallId,
        name: event.toolName,
        argsText: formatArgs(event.args),
        status: 'running',
        resultText: ''
      }
      return { ...state, timeline: [...state.timeline, { kind: 'tool', id: nextId++, tool }] }
    }

    case 'tool_execution_update': {
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'tool' || item.tool.id !== event.toolCallId) return item
        return { ...item, tool: { ...item.tool, resultText: formatResult(item.tool.name, event.partialResult) } }
      })
      return { ...state, timeline }
    }

    case 'tool_execution_end': {
      const timeline = state.timeline.map((item): TimelineItem => {
        if (item.kind !== 'tool' || item.tool.id !== event.toolCallId) return item
        return {
          ...item,
          tool: {
            ...item.tool,
            status: event.isError ? 'error' : 'done',
            resultText: formatResult(item.tool.name, event.result)
          }
        }
      })
      return { ...state, timeline }
    }

    case 'queue_update':
      return {
        ...state,
        queued: { steering: event.steering?.length ?? 0, followUp: event.followUp?.length ?? 0 }
      }

    default:
      return state
  }
}

/** Close out any assistant bubble still marked as streaming. */
function finalizeStreaming(state: AgentState): AgentState {
  const timeline = state.timeline.map((item) =>
    item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item
  )
  return { ...state, timeline }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgent() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const api = typeof window !== 'undefined' ? window.pion : undefined
  const startedRef = useRef(false)

  useEffect(() => {
    if (!api) return
    const offStatus = api.onStatus((status) => dispatch({ type: 'status', status }))
    const offState = api.onState((session) => dispatch({ type: 'session', session }))
    const offEvent = api.onEvent((event) => dispatch({ type: 'event', event }))
    return () => {
      offStatus()
      offState()
      offEvent()
    }
  }, [api])

  const start = useCallback(
    async (cwd: string) => {
      if (!api) return
      startedRef.current = true
      dispatch({ type: 'status', status: { phase: 'starting', cwd } })
      await api.startAgent(cwd)
    },
    [api]
  )

  const stop = useCallback(async () => {
    if (!api) return
    await api.stopAgent()
  }, [api])

  const send = useCallback(
    async (message: string) => {
      if (!api || message.trim() === '') return
      await api.send(message.trim())
    },
    [api]
  )

  const abort = useCallback(async () => {
    if (!api) return
    await api.abort()
  }, [api])

  const pickWorkspace = useCallback(async (): Promise<string | null> => {
    if (!api) return null
    return api.pickWorkspace()
  }, [api])

  const actions = useMemo(
    () => ({ start, stop, send, abort, pickWorkspace }),
    [start, stop, send, abort, pickWorkspace]
  )

  return { state, actions, hasBridge: Boolean(api), startedRef }
}
