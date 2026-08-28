import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  AgentStatus,
  BranchInfo,
  ForkMessageOption,
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

const SESSION_ORDER_STORAGE_KEY = 'pion:session-order'

type SessionOrderMap = Record<string, string[]>

function readSessionOrderMap(): SessionOrderMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(SESSION_ORDER_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, paths]) => (
        Array.isArray(paths) && paths.every((path) => typeof path === 'string')
      ))
    ) as SessionOrderMap
  } catch {
    return {}
  }
}

function writeSessionOrderMap(map: SessionOrderMap): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // best effort - ordering should never block the agent UI
  }
}

function orderSessions(sessions: SessionMeta[], previous: SessionMeta[] = []): SessionMeta[] {
  if (sessions.length <= 1) return sessions
  const projectCwd = sessions[0]?.projectCwd
  if (!projectCwd) return sessions

  const currentPaths = new Set(sessions.map((session) => session.path))
  const saved = readSessionOrderMap()[projectCwd] ?? []
  const orderedPaths: string[] = []
  const seen = new Set<string>()
  for (const path of [...saved, ...previous.map((session) => session.path)]) {
    if (currentPaths.has(path) && !seen.has(path)) {
      seen.add(path)
      orderedPaths.push(path)
    }
  }
  for (const path of sessions.map((session) => session.path)) {
    if (!seen.has(path)) {
      seen.add(path)
      orderedPaths.push(path)
    }
  }

  const map = new Map(sessions.map((session) => [session.path, session]))
  const ordered = orderedPaths.flatMap((path) => {
    const session = map.get(path)
    return session ? [session] : []
  })

  if (saved.length !== orderedPaths.length || saved.some((path, index) => path !== orderedPaths[index])) {
    writeSessionOrderMap({ ...readSessionOrderMap(), [projectCwd]: orderedPaths })
  }
  return ordered
}

function reorderSessionsByPaths(sessions: SessionMeta[], paths: string[]): SessionMeta[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]))
  const ordered = paths.flatMap((path) => {
    const session = byPath.get(path)
    return session ? [session] : []
  })
  const included = new Set(ordered.map((session) => session.path))
  return [...ordered, ...sessions.filter((session) => !included.has(session.path))]
}

function saveSessionOrder(projectCwd: string, paths: string[]): void {
  const map = readSessionOrderMap()
  map[projectCwd] = [...new Set(paths)]
  writeSessionOrderMap(map)
}

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
  sessionsByProject: Record<string, SessionMeta[]>
  branchesByProject: Record<string, BranchInfo[]>
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
  sessionsByProject: {},
  branchesByProject: {},
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
  | { type: 'projectSessions'; sessionsByProject: Record<string, SessionMeta[]> }
  | { type: 'branches'; cwd: string; branches: BranchInfo[] }
  | { type: 'tree'; tree: { tree: TreeNodeLite[]; leafId: string | null } | null }
  | { type: 'projects'; projects: ProjectMeta[] }
  | { type: 'reorderSessions'; cwd: string; paths: string[] }
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

  // Load each project's Git worktrees so the sidebar can render
  // Project -> Branch -> Session instead of a flat project list.
  useEffect(() => {
    if (!api || state.projects.length === 0) return
    let cancelled = false
    void Promise.all(
      state.projects.map(async (project) => [project.cwd, await api.listBranches(project.cwd)] as const)
    ).then((entries) => {
      if (cancelled) return
      for (const [cwd, branches] of entries) {
        dispatch({ type: 'branches', cwd, branches })
      }
    })
    return () => {
      cancelled = true
    }
  }, [api, state.projects])

  // Load every branch worktree's sessions so the sidebar can render a folder tree.
  useEffect(() => {
    if (!api) return
    let cancelled = false
    const projectList = state.projects
    if (projectList.length === 0) {
      dispatch({ type: 'projectSessions', sessionsByProject: {} })
      return () => {
        cancelled = true
      }
    }

    const branches = projectList.flatMap((project) => (
      state.branchesByProject[project.cwd] ?? [{ name: 'main', cwd: project.cwd, isMain: true }]
    ))
    const branchCwds = [...new Set(branches.map((branch) => branch.cwd))]
    void Promise.all(
      branchCwds.map(async (cwd) => [cwd, await api.listSessions(cwd)] as const)
    ).then((entries) => {
      if (cancelled) return
      dispatch({ type: 'projectSessions', sessionsByProject: Object.fromEntries(entries) })
    })

    return () => {
      cancelled = true
    }
  }, [api, state.projects, state.branchesByProject])

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

  const queue = useCallback(
    async (message: string) => {
      if (!api || message.trim() === '') return
      await api.queue(message.trim())
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

  const reorderSessions = useCallback((cwd: string, paths: string[]) => {
    saveSessionOrder(cwd, paths)
    dispatch({ type: 'reorderSessions', cwd, paths })
  }, [])

  const deleteSession = useCallback(
    async (sessionPath: string) => {
      if (!api) return
      const result = await api.deleteSession(sessionPath)
      if (result.activeSessionChanged) await reloadTimeline()
    },
    [api, reloadTimeline]
  )

  const copySession = useCallback(
    async (sessionPath: string) => {
      if (!api) return
      const result = await api.copySession(sessionPath)
      if (!result.cancelled) await reloadTimeline()
    },
    [api, reloadTimeline]
  )

  const getSessionForkMessages = useCallback(
    async (sessionPath: string): Promise<ForkMessageOption[]> => {
      if (!api) return []
      return api.getSessionForkMessages(sessionPath)
    },
    [api]
  )

  const forkSession = useCallback(
    async (sessionPath: string, entryId: string): Promise<string> => {
      if (!api) return ''
      const result = await api.forkSession(sessionPath, entryId)
      if (result.cancelled) return ''
      await reloadTimeline()
      return result.text
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

  const createBranch = useCallback(
    async (cwd: string, name: string): Promise<BranchInfo> => {
      if (!api) throw new Error('preload 桥未加载')
      const branch = await api.createBranch(cwd, name)
      const branches = await api.listBranches(cwd)
      dispatch({ type: 'branches', cwd, branches })
      return branch
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

  // --- agent settings -------------------------------------------------------
  const setAutoCompaction = useCallback(
    async (enabled: boolean) => {
      await api?.setAutoCompaction(enabled)
    },
    [api]
  )
  const setAutoRetry = useCallback(
    async (enabled: boolean) => {
      await api?.setAutoRetry(enabled)
    },
    [api]
  )
  const compactNow = useCallback(async () => {
    await api?.compactNow()
  }, [api])
  const exportHtml = useCallback(
    async (): Promise<string> => (await api?.exportSessionHtml()) ?? '',
    [api]
  )
  const renameSession = useCallback(
    async (name: string) => {
      await api?.renameSession(name)
    },
    [api]
  )
  const setSteeringMode = useCallback(
    async (mode: 'all' | 'one-at-a-time') => {
      await api?.setSteeringMode(mode)
    },
    [api]
  )
  const setFollowUpMode = useCallback(
    async (mode: 'all' | 'one-at-a-time') => {
      await api?.setFollowUpMode(mode)
    },
    [api]
  )

  const actions = useMemo(
    () => ({
      bootstrap,
      start,
      send,
      queue,
      abort,
      newSession,
      forkAt,
      switchSession,
      reorderSessions,
      deleteSession,
      copySession,
      getSessionForkMessages,
      forkSession,
      addProject,
      createBranch,
      removeProject,
      setModel,
      setThinkingLevel,
      setAutoCompaction,
      setAutoRetry,
      compactNow,
      exportHtml,
      renameSession,
      setSteeringMode,
      setFollowUpMode
    }),
    [
      bootstrap,
      start,
      send,
      queue,
      abort,
      newSession,
      forkAt,
      switchSession,
      reorderSessions,
      deleteSession,
      copySession,
      getSessionForkMessages,
      forkSession,
      addProject,
      createBranch,
      removeProject,
      setModel,
      setThinkingLevel,
      setAutoCompaction,
      setAutoRetry,
      compactNow,
      exportHtml,
      renameSession,
      setSteeringMode,
      setFollowUpMode
    ]
  )

  return { state, actions, hasBridge: Boolean(api) }
}
