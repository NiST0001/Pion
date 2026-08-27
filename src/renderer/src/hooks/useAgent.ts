import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  AgentStatus,
  ModelOption,
  ProjectMeta,
  SessionInfo,
  SessionMeta,
  TreeNodeLite,
  ToolResultPayload,
  WireEntry,
  WireEvent,
  WireEventInput,
  WireMessage
} from '../../../shared/types'
import { messageText, messageThinking, messageToolCalls } from '../../../shared/types'

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

export interface ToolItem {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  isError: boolean
  /** Target file for fs tools */
  path?: string
  /** Bash / powershell command */
  command?: string
  /** Edit tool: display diff */
  diff?: string
  /** Write tool: file content from args */
  writeContent?: string
  /** Generic textual output */
  outputText?: string
}

export type TimelineItem =
  | { kind: 'user'; id: number; entryId?: string; text: string }
  | {
      kind: 'assistant'
      id: number
      entryId?: string
      text: string
      thinking: string
      streaming: boolean
      error?: string
    }
  | { kind: 'tool'; id: number; tool: ToolItem }
  | { kind: 'compaction'; id: number; summary: string }

export interface FileChange {
  path: string
  kind: 'edit' | 'write'
  diff?: string
  content?: string
  additions: number
  deletions: number
}

export interface AgentState {
  status: AgentStatus
  session: SessionInfo | null
  sessions: SessionMeta[]
  tree: { tree: TreeNodeLite[]; leafId: string | null } | null
  projects: ProjectMeta[]
  models: ModelOption[]
  thinkingLevels: string[]
  timeline: TimelineItem[]
  busy: boolean
  queued: { steering: number; followUp: number }
}

const initialState: AgentState = {
  status: { phase: 'stopped' },
  session: null,
  sessions: [],
  tree: null,
  projects: [],
  models: [],
  thinkingLevels: [],
  timeline: [],
  busy: false,
  queued: { steering: 0, followUp: 0 }
}

type Action =
  | { type: 'status'; status: AgentStatus }
  | { type: 'session'; session: SessionInfo | null }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'tree'; tree: { tree: TreeNodeLite[]; leafId: string | null } | null }
  | { type: 'projects'; projects: ProjectMeta[] }
  | { type: 'models'; models: ModelOption[] }
  | { type: 'thinkingLevels'; levels: string[] }
  | { type: 'event'; event: WireEventInput }
  | { type: 'loadEntries'; entries: WireEntry[] }
  | { type: 'clearTimeline' }

// ---------------------------------------------------------------------------
// Tool arg / result parsing (shared by live events and session replay)
// ---------------------------------------------------------------------------

function parseToolArgs(name: string, args: unknown): Partial<ToolItem> {
  const a = (args ?? {}) as Record<string, unknown>
  const out: Partial<ToolItem> = {}
  if (typeof a.path === 'string') out.path = a.path
  if (typeof a.command === 'string') out.command = a.command
  if (typeof a.pattern === 'string') out.command = a.pattern
  if (name === 'write' && typeof a.content === 'string') out.writeContent = a.content
  if (name === 'edit' && Array.isArray(a.edits)) {
    // aggregate preview of the edit texts
    const edits = a.edits as Array<Record<string, unknown>>
    out.command = edits
      .map((e) => `${String(e.oldText ?? '')} → ${String(e.newText ?? '')}`)
      .join('\n')
      .slice(0, 200)
  }
  return out
}

function resultText(payload: ToolResultPayload | undefined | null): string {
  const content = payload?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

function applyToolResult(tool: ToolItem, result: unknown, isError: boolean): ToolItem {
  const payload = (result ?? {}) as ToolResultPayload
  const next: ToolItem = {
    ...tool,
    status: isError ? 'error' : 'done',
    isError,
    outputText: resultText(payload)
  }
  const details = payload.details
  if (typeof details?.diff === 'string') next.diff = details.diff
  // bash output lives in content text
  return next
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function errorText(event: WireMessage | undefined): string {
  if (!event) return '未知错误'
  return event.errorMessage || messageText(event) || '未知错误'
}

/** Count added/removed lines of a pi display diff. */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Derive the touched-file list from a timeline (for the changes panel). */
export function deriveChanges(timeline: TimelineItem[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const item of timeline) {
    if (item.kind !== 'tool') continue
    const { tool } = item
    if (tool.name === 'edit' && tool.path && tool.diff) {
      const stats = diffStats(tool.diff)
      const existing = byPath.get(tool.path)
      byPath.set(tool.path, {
        path: tool.path,
        kind: 'edit',
        diff: tool.diff,
        additions: (existing?.additions ?? 0) + stats.additions,
        deletions: (existing?.deletions ?? 0) + stats.deletions
      })
    } else if (tool.name === 'write' && tool.path) {
      const content = tool.writeContent ?? ''
      const lines = content.split('\n').length
      byPath.set(tool.path, {
        path: tool.path,
        kind: 'write',
        content,
        additions: lines,
        deletions: 0
      })
    }
  }
  return [...byPath.values()]
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

let nextId = 1

function reducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    case 'status': {
      const dead = action.status.phase === 'stopped' || action.status.phase === 'error'
      return {
        ...state,
        status: action.status,
        busy: dead ? false : state.busy,
        session: dead ? null : state.session,
        sessions: dead ? [] : state.sessions,
        tree: dead ? null : state.tree
      }
    }
    case 'session':
      return { ...state, session: action.session }
    case 'sessions':
      return { ...state, sessions: action.sessions }
    case 'tree':
      return { ...state, tree: action.tree }
    case 'projects':
      return { ...state, projects: action.projects }
    case 'models':
      return { ...state, models: action.models }
    case 'thinkingLevels':
      return { ...state, thinkingLevels: action.levels }
    case 'loadEntries':
      return { ...state, timeline: entriesToTimeline(action.entries), busy: false }
    case 'clearTimeline':
      return { ...state, timeline: [], busy: false, queued: { steering: 0, followUp: 0 } }
    case 'event':
      return reduceEvent(state, action.event)
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
            { kind: 'user', id: nextId++, text: messageText(message) }
          ]
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
      const thinking = messageThinking(message)
      const timeline = state.timeline.map((item) => {
        if (item.kind !== 'assistant' || !item.streaming) return item
        return {
          ...item,
          text: text || item.text,
          thinking: thinking || item.thinking,
          streaming: false
        }
      })
      return { ...state, timeline }
    }

    case 'entry_appended': {
      const entry = event.entry
      if (!entry || entry.type !== 'message') return state
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
      return { ...state, timeline: [...state.timeline, { kind: 'tool', id: nextId++, tool }] }
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
          { kind: 'compaction', id: nextId++, summary: '上下文已压缩' }
        ]
      }
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
// Session replay: entries -> timeline
// ---------------------------------------------------------------------------

function entriesToTimeline(entries: WireEntry[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      if (typeof entry.summary === 'string') {
        items.push({ kind: 'compaction', id: nextId++, summary: '上下文已压缩' })
      }
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (!message) continue

    if (message.role === 'user') {
      items.push({ kind: 'user', id: nextId++, entryId: entry.id, text: messageText(message) })
      continue
    }

    if (message.role === 'assistant') {
      items.push({
        kind: 'assistant',
        id: nextId++,
        entryId: entry.id,
        text: messageText(message),
        thinking: messageThinking(message),
        streaming: false
      })
      for (const call of messageToolCalls(message)) {
        items.push({
          kind: 'tool',
          id: nextId++,
          tool: {
            id: call.id,
            name: call.name,
            status: 'done',
            isError: false,
            ...parseToolArgs(call.name, call.arguments)
          }
        })
      }
      continue
    }

    if (message.role === 'toolResult') {
      const record = message as unknown as Record<string, unknown>
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : null
      if (!toolCallId) continue
      // fill the most recent pending tool item with this id
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind === 'tool' && item.tool.id === toolCallId) {
          items[i] = {
            ...item,
            tool: applyToolResult(item.tool, message, Boolean(record.isError))
          }
          break
        }
      }
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgent() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const api = typeof window !== 'undefined' ? window.pion : undefined
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (!api) return
    const offs = [
      api.onStatus((status) => dispatch({ type: 'status', status })),
      api.onState((session) => dispatch({ type: 'session', session })),
      api.onSessions((sessions) => dispatch({ type: 'sessions', sessions })),
      api.onTree((tree) => dispatch({ type: 'tree', tree })),
      api.onProjects((projects) => dispatch({ type: 'projects', projects })),
      api.onEvent((event) => dispatch({ type: 'event', event }))
    ]
    return () => offs.forEach((off) => off())
  }, [api])

  /** Rebuild the timeline from the active session's entries. */
  const reloadTimeline = useCallback(async () => {
    if (!api) return
    const result = await api.getEntries()
    if (result) dispatch({ type: 'loadEntries', entries: result.entries })
  }, [api])

  const refreshModels = useCallback(async () => {
    if (!api) return
    const [models, levels] = await Promise.all([api.getAvailableModels(), api.getThinkingLevels()])
    dispatch({ type: 'models', models })
    dispatch({ type: 'thinkingLevels', levels })
  }, [api])

  const start = useCallback(
    async (cwd: string) => {
      if (!api) return
      dispatch({ type: 'status', status: { phase: 'starting', cwd } })
      dispatch({ type: 'clearTimeline' })
      await api.startAgent(cwd)
      await reloadTimeline()
      await refreshModels()
    },
    [api, reloadTimeline, refreshModels]
  )

  const bootstrap = useCallback(async () => {
    if (!api || bootstrapped.current) return
    bootstrapped.current = true
    let projects = await api.listProjects()
    let cwd = projects[0]?.cwd
    if (!cwd) {
      cwd = await api.defaultWorkspace()
      projects = await api.addProject(cwd)
    }
    dispatch({ type: 'projects', projects })
    await start(cwd)
  }, [api, start])

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

  const newSession = useCallback(async () => {
    if (!api) return
    await api.newSession()
    dispatch({ type: 'clearTimeline' })
  }, [api])

  /** Fork before a user message; resolves with the message text for prefill. */
  const forkAt = useCallback(
    async (entryId: string): Promise<string> => {
      if (!api) return ''
      const result = await api.forkAt(entryId)
      if (!result.cancelled) {
        await reloadTimeline()
        return result.text
      }
      return ''
    },
    [api, reloadTimeline]
  )

  const switchSession = useCallback(
    async (sessionPath: string) => {
      if (!api) return
      await api.switchSession(sessionPath)
      await reloadTimeline()
    },
    [api, reloadTimeline]
  )

  const addProject = useCallback(
    async (cwd: string) => {
      if (!api) return
      const projects = await api.addProject(cwd)
      dispatch({ type: 'projects', projects })
    },
    [api]
  )

  const removeProject = useCallback(
    async (cwd: string) => {
      if (!api) return
      const projects = await api.removeProject(cwd)
      dispatch({ type: 'projects', projects })
    },
    [api]
  )

  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      if (!api) return
      await api.setModel(provider, modelId)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const setThinkingLevel = useCallback(
    async (level: string) => {
      if (!api) return
      await api.setThinkingLevel(level)
    },
    [api]
  )

  const actions = useMemo(
    () => ({
      bootstrap,
      start,
      send,
      abort,
      newSession,
      forkAt,
      switchSession,
      addProject,
      removeProject,
      setModel,
      setThinkingLevel
    }),
    [
      bootstrap,
      start,
      send,
      abort,
      newSession,
      forkAt,
      switchSession,
      addProject,
      removeProject,
      setModel,
      setThinkingLevel
    ]
  )

  return { state, actions, hasBridge: Boolean(api) }
}
