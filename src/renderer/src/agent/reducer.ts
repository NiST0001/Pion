/**
 * Agent 状态迁移：reducer 与实时事件（WireEvent -> 状态）归约。
 */
import type {
  LiveSessionState,
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
  orderTimelineAroundAnchors,
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
      // Re-selecting a retained backend publishes its descriptor again; that
      // ready notification is not a backend reset after live hydration.
      const ready = action.status.phase === 'ready' && !(state.liveSessionBackendId
        && state.status.phase === 'running' && action.status.cwd === state.status.cwd)
      return {
        ...state,
        status: action.status.phase === 'ready' && !ready ? state.status : action.status,
        busy: dead || ready ? false : state.busy,
        compacting: dead || ready ? false : state.compacting,
        compactionEventState: dead || ready ? undefined : state.compactionEventState,
        timeline: dead || ready ? dropStreamingTails(state.timeline) : state.timeline,
        liveSessionTurnIds: dead || ready ? undefined : state.liveSessionTurnIds,
        timelineLoading: dead ? false : state.timelineLoading,
        timelineError: dead ? undefined : state.timelineError,
        session: dead || ready ? null : state.session,
        liveSessionBackendId: dead || ready ? undefined : state.liveSessionBackendId,
        liveSessionRevision: dead || ready ? undefined : state.liveSessionRevision,
        liveSessionLifecycleRevision: dead || ready ? undefined : state.liveSessionLifecycleRevision,
        sessions: dead ? [] : action.status.cwd !== state.status.cwd
          ? state.sessionsByProject[action.status.cwd ?? ''] ?? []
          : state.sessions,
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
      const live = incoming?.liveState
      const accepted = live && liveScopeMatches(state, live, incoming?.sessionFile)
      if (live && !accepted) return state
      const sameLiveBackend = accepted && state.liveSessionBackendId === live.backendId
      const older = sameLiveBackend && live.revision < (state.liveSessionRevision ?? -1)
      // Display metadata alone does not prove idle: a tool/message update can
      // precede the first owned STATE at the same revision after selection.
      const equalKnownLifecycle = sameLiveBackend && live.revision === state.liveSessionRevision
        && state.liveSessionLifecycleRevision === live.revision
      const preserveLifecycle = older || equalKnownLifecycle
      const projectable = accepted && !older
      const sameBackend = !live || !state.liveSessionBackendId || state.liveSessionBackendId === live.backendId
      const compactionEventState = projectable && !preserveLifecycle ? undefined
        : sameSession && sameBackend ? state.compactionEventState : undefined
      const compacting = preserveLifecycle ? state.compacting : compactionEventState ?? incoming?.isCompacting ?? false
      const busy = preserveLifecycle ? state.busy : Boolean(incoming?.isStreaming || compacting)
      const projected = projectable ? applyLiveSnapshot(state, live, busy) : state
      return {
        ...projected,
        session: incoming,
        busy,
        compacting,
        liveSessionLifecycleRevision: projectable ? live.revision : state.liveSessionLifecycleRevision,
        liveSessionBackendHistory: projectable ? rememberLiveBackend(state, live) : state.liveSessionBackendHistory,
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
      return {
        ...state,
        sessionsByProject,
        sessions: state.status.cwd ? sessionsByProject[state.status.cwd] ?? [] : []
      }
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
      const branchesByProject = Object.fromEntries(
        Object.entries(state.branchesByProject).filter(([cwd]) => projectCwds.has(cwd))
      )
      // Project identity is the primary repository; session identity remains
      // the individual worktree cwd. Folding duplicate project rows must not
      // discard the retained project's branch session caches.
      const sessionCwds = new Set(projectCwds)
      for (const branches of Object.values(branchesByProject)) {
        for (const branch of branches) sessionCwds.add(branch.cwd)
      }
      const sessionsByProject = Object.fromEntries(
        Object.entries(state.sessionsByProject).filter(([cwd]) => sessionCwds.has(cwd))
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
        && (scope.sessionPath === undefined || scope.sessionPath === state.liveSessionOwnerPath
          || !state.session?.sessionFile || scope.sessionPath === state.session.sessionFile)
      if (scope && !preserve) return state
      // A selected backend can hydrate before the cache paints. Its current
      // message is authoritative; do not append an older cached final with the
      // same unique identity merely because their text differs. Ambiguous SDK
      // timestamps remain distinct. This preference is cache restoration only.
      const legacyAssistantBridge = (row: TimelineItem, item: TimelineItem): boolean => Boolean(
        preserve && (!action.cachedBackendId || action.cachedBackendId === state.liveSessionBackendId)
        && row.kind === 'assistant' && item.kind === 'assistant'
        && state.liveSessionTurnIds?.includes(row.id)
        && row.messageTimestamp !== undefined && row.messageTimestamp === item.messageTimestamp
        && !(row.entryId && item.entryId && row.entryId !== item.entryId)
        && !(row.liveMessageId && item.liveMessageId && row.liveMessageId !== item.liveMessageId)
      )
      const incoming = action.replayHistory ? action.items.map((item) => {
        const bridge = state.timeline.some((row) => legacyAssistantBridge(row, item))
        const candidates = state.timeline.filter((row) => sameLiveIdentity(row, item) || legacyAssistantBridge(row, item))
        const cachedCopies = action.items.filter((row) => sameLiveIdentity(row, item)
          || (bridge && row.kind === 'assistant' && item.kind === 'assistant'
            && row.messageTimestamp === item.messageTimestamp))
        const sourceCopies = bridge ? state.timeline.filter((row) => row.kind === 'assistant'
          && item.kind === 'assistant' && row.messageTimestamp === item.messageTimestamp) : candidates
        if (candidates.length !== 1 || sourceCopies.length !== 1 || cachedCopies.length !== 1) return item
        const current = candidates[0]
        const replacement = { ...current,
          ...((item.kind === 'user' || item.kind === 'assistant') && (current.kind === 'user' || current.kind === 'assistant')
            ? { entryId: current.entryId ?? item.entryId, liveMessageId: current.liveMessageId ?? item.liveMessageId } : {}),
          ...(item.kind === 'user' && current.kind === 'user'
            ? { images: current.images?.length ? current.images : item.images } : {}),
          historical: item.historical, noReveal: item.noReveal }
        const fields = cachedSnapshotFields(state, current)
        if (replacement.kind === 'assistant' && item.kind === 'assistant') {
          if (fields.has('text') && item.text.length > replacement.text.length) replacement.text = item.text
          if (fields.has('thinking') && item.thinking.length > replacement.thinking.length) replacement.thinking = item.thinking
          if (fields.has('error') && (item.error?.length ?? 0) > (replacement.error?.length ?? 0)) replacement.error = item.error
        }
        if (replacement.kind === 'user' && item.kind === 'user' && fields.has('text') && item.text.length > replacement.text.length) replacement.text = item.text
        return replacement
      }) : action.items
      const merged = preserve ? preserveTimelineToolState(state.timeline, incoming,
        state.status.phase !== 'stopped' && state.status.phase !== 'error'
      ) : incoming
      // Only the explicit selection cache restore overrides retained reveal
      // flags. Ordinary revalidation/paging must not replay mounted history.
      const timeline = action.replayHistory ? merged.map((item) => {
        const cached = action.items.find((row) => row.id === item.id || sameLiveIdentity(row, item)
          || legacyAssistantBridge(item, row))
        return cached ? { ...item, historical: true, noReveal: false } : item
      }) : merged
      // Empty cache projections cannot prove an empty persisted branch. An
      // accepted disk read can, without consulting SDK/list message counts.
      const acceptedHistory = !action.replayHistory || action.items.length > 0
      const loaded: AgentState = {
        ...state,
        timeline,
        liveSessionBackendId: state.liveSessionBackendId ?? (preserve ? action.cachedBackendId : undefined),
        timelineLoadId: action.loadId ?? state.timelineLoadId,
        mode: action.mode ?? state.mode,
        timelineMutation: 'replace',
        timelineReady: state.timelineReady || acceptedHistory,
        timelineLoading: acceptedHistory ? false : state.timelineLoading,
        timelineError: acceptedHistory ? undefined : state.timelineError,
        // History replacement must not erase a running/compacting backend
        // selected while the page was being loaded.
        busy: state.busy,
        compacting: state.compacting
      }
      // A cache/page dispatched after hydration may contain a pre-final draft.
      // Replay the accepted projection at this event boundary, including its
      // empty-final tombstones, rather than resurrecting cached partial text.
      const live = state.session?.liveState
      return preserve && live && live.backendId === state.liveSessionBackendId
        && live.revision === state.liveSessionRevision
        ? { ...applyLiveSnapshot(loaded, live), timelineMutation: 'replace' } : loaded
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
    case 'timelineLoading': {
      // A scoped loadEntries may be rejected after a queued cwd/selection
      // change. Closing the reader's shell alone must not imply readiness.
      const unreadHistory = !action.loading && state.timelineLoading
        && !state.timelineReady && Boolean(state.liveSessionOwnerPath)
      return {
        ...state,
        timelineLoading: action.loading,
        timelineError: action.loading ? undefined
          : state.timelineError || (unreadHistory ? '会话历史未载入，请重新加载。' : undefined)
      }
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
        liveSessionOwnerPath: action.sessionPath,
        liveSessionScopeSelected: true,
        historyRevealRestorePending: Boolean(action.sessionPath),
        liveSessionBackendId: undefined,
        liveSessionBackendHistory: state.liveSessionBackendHistory?.sessionPath === action.sessionPath
          ? state.liveSessionBackendHistory : undefined,
        liveSessionRevision: undefined,
        liveSessionLifecycleRevision: undefined,
        liveSessionTurnIds: undefined,
        timelineScopeRevision: state.timelineScopeRevision + 1,
        mode: 'build',
        yolo: false,
        timelineMutation: 'replace',
        timelineReady: false,
        timelineLoading: false,
        timelineError: undefined,
        busy: false,
        compacting: false,
        compactionEventState: undefined,
        queued: { steering: 0, followUp: 0 },
        queuedMessages: { steering: [], followUp: [], nativeFollowUpCount: 0 }
      }
    case 'event': {
      const live = action.event._pionLive
      if (live && (!liveScopeMatches(state, live)
        || (live.backendId === state.liveSessionBackendId && live.revision <= (state.liveSessionRevision ?? -1)))) return state
      const base = live ? {
        ...state,
        timeline: state.liveSessionBackendId && state.liveSessionBackendId !== live.backendId
          ? dropStreamingTails(state.timeline) : state.timeline,
        liveSessionOwnerPath: live.sessionPath ?? state.liveSessionOwnerPath,
        liveSessionBackendId: live.backendId,
        liveSessionBackendHistory: rememberLiveBackend(state, live),
        liveSessionRevision: live.revision,
        liveSessionLifecycleRevision: state.liveSessionBackendId === live.backendId
          ? state.liveSessionLifecycleRevision : undefined
      } : state
      let next = reduceEvent(base, action.event)
      if (live) {
        // Only root lifecycle events, not arbitrary display deltas, establish
        // busy/compacting authority at the forwarded metadata revision.
        if (['agent_start', 'agent_settled', 'compaction_start', 'compaction_end'].includes(action.event.type)
          && !('parentToolCallId' in action.event && action.event.parentToolCallId)) {
          next = { ...next, liveSessionLifecycleRevision: live.revision }
        }
        const turnIds = action.event.type === 'agent_start' || state.liveSessionBackendId !== live.backendId
          ? [] : state.liveSessionTurnIds ?? []
        if (next.timeline !== base.timeline || action.event.type === 'agent_start' || state.liveSessionBackendId !== live.backendId) {
          const previousIds = new Set(base.timeline.map((row) => row.id))
          const nextIds = new Set(next.timeline.map((row) => row.id))
          next = { ...next, liveSessionTurnIds: [...turnIds.filter((id) => nextIds.has(id)),
            ...next.timeline.filter((row) => !previousIds.has(row.id)).map((row) => row.id)].slice(-256) }
        }
      }
      return next.timeline === state.timeline ? next : { ...next, timelineMutation: 'append' }
    }
  }
}

/** Remember only real replacements in the same cwd/path, including a queued clear. */
function rememberLiveBackend(state: AgentState, live: LiveSessionState | Omit<LiveSessionState, 'events' | 'truncated'>): AgentState['liveSessionBackendHistory'] {
  const previous = state.liveSessionBackendHistory
  const sameScope = previous?.cwd === live.cwd && previous.sessionPath === live.sessionPath
  if (!sameScope) return { cwd: live.cwd, sessionPath: live.sessionPath, current: live.backendId, retired: [] }
  if (previous.current === live.backendId) return previous
  return { ...previous, current: live.backendId, retired: [...previous.retired, previous.current].slice(-16) }
}

/** Unknown SDK IDs are allowed within the selected cwd, never across workspaces. */
function liveScopeMatches(
  state: AgentState, live: Omit<LiveSessionState, 'events' | 'truncated'>, path?: string
): boolean {
  if (state.status.cwd !== live.cwd) return false
  const known = state.liveSessionBackendHistory
  if (known?.cwd === live.cwd && known.sessionPath === live.sessionPath && known.retired.includes(live.backendId)) return false
  const selected = state.liveSessionScopeSelected ? state.liveSessionOwnerPath : state.session?.sessionFile
  if (selected && live.sessionPath && selected !== live.sessionPath) return false
  return !path || !live.sessionPath || path === live.sessionPath
}

function dropStreamingTails(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => !(item.kind === 'assistant' && item.streaming)
    && !(item.kind === 'tool' && item.tool.live && item.tool.status === 'running'))
}

function liveMessageIdentity(message: WireMessage | undefined): { liveMessageId?: string; entryId?: string } {
  const liveMessageId = message?._pionLiveMessageId
  const entryId = message?._pionLiveEntryId
  return {
    ...(typeof liveMessageId === 'string' && liveMessageId.length > 0 && liveMessageId.length <= 512 ? { liveMessageId } : {}),
    ...(typeof entryId === 'string' && entryId.length > 0 && entryId.length <= 512 ? { entryId } : {})
  }
}

function identifiedAssistant(
  items: TimelineItem[], identity: { liveMessageId?: string; entryId?: string }
): Extract<TimelineItem, { kind: 'assistant' }> | undefined {
  const candidates = items.filter((row): row is Extract<TimelineItem, { kind: 'assistant' }> => row.kind === 'assistant'
    && !(identity.liveMessageId && row.liveMessageId && identity.liveMessageId !== row.liveMessageId)
    && !(identity.entryId && row.entryId && identity.entryId !== row.entryId))
  const live = identity.liveMessageId ? candidates.filter((row) => row.liveMessageId === identity.liveMessageId) : []
  const matches = live.length > 0 ? live : identity.entryId ? candidates.filter((row) => row.entryId === identity.entryId) : []
  return matches.length === 1 ? matches[0] : undefined
}

function uniqueStreamingAssistant(items: TimelineItem[], timestamp?: number): Extract<TimelineItem, { kind: 'assistant' }> | undefined {
  const streaming = items.filter((row): row is Extract<TimelineItem, { kind: 'assistant' }> => row.kind === 'assistant' && row.streaming)
  // An anonymous late final with a different known clock cannot close the
  // current draft. Missing clocks remain eligible only when truly unique.
  const candidates = timestamp === undefined ? streaming
    : streaming.filter((row) => row.messageTimestamp === undefined || row.messageTimestamp === timestamp)
  return candidates.length === 1 ? candidates[0] : undefined
}

function readSnapshotFields(payload: unknown): Set<string> {
  const value = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)._pionLiveTruncatedFields : undefined
  return new Set(Array.isArray(value) ? value.filter((field) =>
    typeof field === 'string' && ['text', 'thinking', 'error', 'diff', 'outputText'].includes(field)) : [])
}

/** Only the exact accepted snapshot may explain why its current row is short. */
function cachedSnapshotFields(state: AgentState, row: TimelineItem): Set<string> {
  const live = state.session?.liveState
  if (!live || live.backendId !== state.liveSessionBackendId || live.revision !== state.liveSessionRevision
    || live.cwd !== state.status.cwd || live.sessionPath !== state.liveSessionOwnerPath
    || (row.kind !== 'user' && row.kind !== 'assistant')) return new Set()
  const messages = live.events.flatMap((input) => {
    const event = input as WireEvent
    if (event.type !== 'message_start' && event.type !== 'message_end') return []
    if (!event.message || event.message.role !== row.kind) return []
    const identity = liveMessageIdentity(event.message)
    const matches = row.liveMessageId ? identity.liveMessageId === row.liveMessageId
      : !identity.liveMessageId && row.messageTimestamp !== undefined && wireMessageTimestamp(event.message) === row.messageTimestamp
    return matches ? [{ type: event.type, message: event.message }] : []
  })
  if (messages.filter((event) => event.type === 'message_start').length !== 1) return new Set()
  return readSnapshotFields(messages.at(-1)?.message)
}

function sameStrongMessageIdentity(a: TimelineItem, b: TimelineItem): boolean {
  return (a.kind === 'user' || a.kind === 'assistant') && (b.kind === 'user' || b.kind === 'assistant')
    && sameLiveIdentity(a, b)
    && Boolean((a.entryId && b.entryId && a.entryId === b.entryId)
      || (a.liveMessageId && b.liveMessageId && a.liveMessageId === b.liveMessageId))
}

function sameLiveIdentity(a: TimelineItem, b: TimelineItem): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'tool' && b.kind === 'tool') return a.tool.id === b.tool.id
  // Both identities are constraints, not competing fallbacks. A stale entry
  // attachment must not erase proof that these were two different sends.
  if ((a.kind === 'user' || a.kind === 'assistant') && (b.kind === 'user' || b.kind === 'assistant')
    && a.liveMessageId && b.liveMessageId && a.liveMessageId !== b.liveMessageId) return false
  if ('entryId' in a && 'entryId' in b && a.entryId && b.entryId) return a.entryId === b.entryId
  if ((a.kind === 'assistant' || a.kind === 'user') && (b.kind === 'assistant' || b.kind === 'user')) {
    if (a.liveMessageId && b.liveMessageId) return a.liveMessageId === b.liveMessageId
    if (a.messageTimestamp === undefined || a.messageTimestamp !== b.messageTimestamp) return false
    // A unique persisted timestamp/text can bridge to the bounded live user
    // projection, which intentionally omits images. Never equate two known
    // image sets or different stable IDs merely by their text/timestamp.
    if (a.kind === 'user' && b.kind === 'user') {
      const omittedProjectionImages = (a.entryId && !a.liveMessageId && b.liveMessageId && !b.images?.length)
        || (b.entryId && !b.liveMessageId && a.liveMessageId && !a.images?.length)
      return a.text === b.text && (Boolean(omittedProjectionImages)
        || JSON.stringify(a.images ?? []) === JSON.stringify(b.images ?? []))
    }
    return a.kind === 'assistant' && b.kind === 'assistant'
      && (a.streaming || b.streaming || (a.text === b.text && a.thinking === b.thinking && a.error === b.error))
  }
  return false
}

/** Replay display data only: no lifecycle, task projection or other side effects. */
function applyLiveSnapshot(state: AgentState, live: LiveSessionState, active = state.busy): AgentState {
  let replay = { ...state, timeline: [] as TimelineItem[] }
  const tombstones: { item: TimelineItem; fields: Set<string> }[] = []
  const truncatedFields = new Map<number, Set<string>>()
  const readFields = readSnapshotFields
  const currentTools = new Map(state.timeline.flatMap((row) => row.kind === 'tool' ? [[row.tool.id, row] as const] : []))
  const finalTools = new Map<string, { payload: ToolResultPayload; isError: boolean }>()
  for (const input of live.events) {
    const event = input as WireEvent
    if (event.type === 'message_end' && event.message.role === 'toolResult' && typeof event.message.toolCallId === 'string') {
      finalTools.set(event.message.toolCallId, { payload: event.message as ToolResultPayload, isError: Boolean(event.message.isError) })
    } else if (event.type === 'tool_execution_end' && !finalTools.has(event.toolCallId)) {
      finalTools.set(event.toolCallId, { payload: event.result as ToolResultPayload, isError: event.isError })
    }
  }
  for (const event of live.events) {
    if (!['message_start', 'message_update', 'message_end', 'entry_appended',
      'tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) continue
    if (event.type === 'entry_appended' && (event as WireEvent & { type: 'entry_appended' }).entry?.type !== 'message') continue
    const before = replay.timeline
    replay = reduceEvent(replay, event, true)
    const wire = event as WireEvent
    const payload = wire.type === 'message_start' || wire.type === 'message_end' ? wire.message
      : wire.type === 'message_update' ? (wire.assistantMessageEvent as unknown as Record<string, unknown>)?.error
        ?? (wire.assistantMessageEvent as unknown as Record<string, unknown>)?.message
        ?? wire.assistantMessageEvent
      : wire.type === 'tool_execution_end' ? wire.result
      : wire.type === 'tool_execution_update' ? wire.partialResult : undefined
    const fields = readFields(payload)
    const target = wire.type === 'message_start' ? replay.timeline.at(-1)
      : wire.type === 'message_end' && wire.message.role === 'toolResult'
        ? replay.timeline.find((row) => row.kind === 'tool' && row.tool.id === wire.message.toolCallId)
      : wire.type === 'tool_execution_end' || wire.type === 'tool_execution_update'
        ? replay.timeline.find((row) => row.kind === 'tool' && row.tool.id === wire.toolCallId)
      : wire.type === 'message_end' || wire.type === 'message_update'
        ? before.filter((row) => row.kind === 'assistant' && row.streaming).at(-1) : undefined
    if (target && payload) {
      if (wire.type === 'message_update') {
        const previous = truncatedFields.get(target.id) ?? new Set<string>()
        for (const field of fields) previous.add(field)
        truncatedFields.set(target.id, previous)
      } else truncatedFields.set(target.id, fields)
    }
    if (event.type === 'tool_execution_start') {
      // Seed an identical final before replaying it, preserving the validated
      // preview objects rather than decoding the same image a second time.
      replay.timeline = replay.timeline.map((row) => {
        if (row.kind !== 'tool' || row.tool.id !== event.toolCallId) return row
        const current = currentTools.get(row.tool.id)
        const final = finalTools.get(row.tool.id)
        const payload = final?.payload
        const isError = final?.isError ?? false
        if (current?.kind !== 'tool' || !payload) return row
        return toolResultMatches(current.tool, payload, isError)
          ? { ...row, tool: current.tool }
          : { ...row, tool: { ...row.tool, images: current.tool.images, imageNotice: current.tool.imageNotice } }
      })
    }
    if (event.type === 'message_end') {
      for (const item of before) {
        if (item.kind === 'assistant' && item.streaming && !replay.timeline.some((row) => row.id === item.id)) tombstones.push({ item, fields })
      }
    }
  }
  let existing = state.liveSessionBackendId && state.liveSessionBackendId !== live.backendId
    ? dropStreamingTails(state.timeline) : state.timeline
  const compatibleAssistant = (row: TimelineItem, item: TimelineItem): boolean =>
    row.kind === 'assistant' && item.kind === 'assistant'
    && !(row.liveMessageId && item.liveMessageId && row.liveMessageId !== item.liveMessageId)
    && !(row.entryId && item.entryId && row.entryId !== item.entryId)
  // A timestampless empty final may only remove the current unpersisted draft,
  // not completed/history rows. Prefer the last streaming row in that turn.
  for (const { item: tombstone, fields } of tombstones) {
    const candidates = existing.filter((item) => sameLiveIdentity(item, tombstone)
      && item.kind === 'assistant' && (item.streaming || state.liveSessionTurnIds?.includes(item.id)))
    const matched = candidates.length === 1 ? candidates : []
    const fallback = tombstone.kind === 'assistant'
      ? existing.filter((item) => item.kind === 'assistant' && item.streaming && !item.entryId
        && compatibleAssistant(item, tombstone)
        && (tombstone.messageTimestamp === undefined || item.messageTimestamp === undefined)).at(-1) : undefined
    if (fields.has('text') || fields.has('thinking') || fields.has('error')) {
      const current = matched[0] ?? fallback
      if (current?.kind === 'assistant') {
        replay.timeline.push({ ...current, text: fields.has('text') ? current.text : '',
          thinking: fields.has('thinking') ? current.thinking : '',
          error: fields.has('error') ? current.error : undefined, streaming: false })
        truncatedFields.set(current.id, fields)
      }
    } else existing = existing.filter((item) => !matched.includes(item) && item !== fallback)
  }
  // A metadata-only STATE must not spend the selection reveal boundary.
  // The event revision can also arrive before STATE; that is not a restore.
  const revealHistory = Boolean(state.historyRevealRestorePending)
  const matched = new Set<number>()
  const incoming = replay.timeline.map((source) => {
    const item = revealHistory ? { ...source, historical: true, noReveal: false } : source
    const compatible = existing.filter((row) => !matched.has(row.id) && sameLiveIdentity(row, item))
    const strong = compatible.filter((row) => sameStrongMessageIdentity(row, item))
    const candidates = strong.length > 0 ? strong : compatible
    const active = candidates.filter((row) => (row.kind === 'assistant' && row.streaming)
      || state.liveSessionTurnIds?.includes(row.id))
    const matches = strong.length > 0 ? sameStrongMessageIdentity : sameLiveIdentity
    const ambiguousUser = item.kind === 'user'
      && (candidates.length > 1 || replay.timeline.filter((row) => matches(row, item)).length !== 1
        || candidates.some((candidate) => replay.timeline.filter((row) => matches(candidate, row)).length > 1))
    const identified = ambiguousUser ? undefined
      : active.length === 1 ? active[0] : candidates.length === 1 ? candidates[0] : undefined
    const current = identified
      ?? (item.kind === 'assistant' && item.messageTimestamp === undefined && !item.liveMessageId && !item.entryId
        ? existing.find((row) => row.kind === item.kind && compatibleAssistant(row, item)
          && !matched.has(row.id) && state.liveSessionTurnIds?.includes(row.id)) : undefined)
      ?? (item.kind === 'assistant'
        ? existing.filter((row) => row.kind === 'assistant' && row.streaming && !row.entryId && !matched.has(row.id)
          && compatibleAssistant(row, item)
          && (item.messageTimestamp === undefined || row.messageTimestamp === undefined)).at(-1) : undefined)
    if (!current) return item
    matched.add(current.id)
    if ((current.historyReconciled && current.kind === 'assistant' && item.kind === 'assistant'
      && current.entryId && !current.streaming && item.streaming)
      || (current.kind === 'tool' && item.kind === 'tool' && current.tool.resultReceived && !item.tool.resultReceived)) {
      return revealHistory ? { ...current, historical: true, noReveal: false } : current
    }
    const replacement = { ...item, id: current.id,
      historical: revealHistory ? true : current.historical,
      noReveal: revealHistory ? false : current.noReveal,
      historyReconciled: current.historyReconciled }
    if ((replacement.kind === 'assistant' || replacement.kind === 'user')
      && (current.kind === 'assistant' || current.kind === 'user')) {
      if (!replacement.entryId && current.entryId) replacement.entryId = current.entryId
      replacement.liveMessageId ??= current.liveMessageId
      replacement.messageTimestamp ??= current.messageTimestamp
    }
    // Only explicit per-field budget loss can protect cached longer output.
    const fields = truncatedFields.get(item.id) ?? new Set<string>()
    if (replacement.kind === 'assistant' && current.kind === 'assistant') {
      if (fields.has('text') && replacement.text.length < current.text.length) replacement.text = current.text
      if (fields.has('thinking') && replacement.thinking.length < current.thinking.length) replacement.thinking = current.thinking
      if (fields.has('error') && (replacement.error?.length ?? 0) < (current.error?.length ?? 0)) replacement.error = current.error
      if (replacement.text === current.text && replacement.thinking === current.thinking
        && replacement.streaming === current.streaming && replacement.error === current.error
        && replacement.entryId === current.entryId && replacement.liveMessageId === current.liveMessageId
        && replacement.messageTimestamp === current.messageTimestamp
        && replacement.historical === current.historical && replacement.noReveal === current.noReveal) return current
    }
    if (replacement.kind === 'user' && current.kind === 'user') {
      if (fields.has('text') && replacement.text.length < current.text.length) replacement.text = current.text
      if (current.images?.length && !replacement.images?.length) replacement.images = current.images
    }
    if (replacement.kind === 'tool' && current.kind === 'tool') {
      // The display snapshot excludes result details/argument image metadata.
      // Missing projection metadata is not evidence that a final removed it.
      replacement.tool = { ...replacement.tool,
        diff: replacement.tool.diff ?? current.tool.diff,
        todos: replacement.tool.todos ?? current.tool.todos,
        imageModelInfo: replacement.tool.imageModelInfo ?? current.tool.imageModelInfo,
        imageSettingsInfo: replacement.tool.imageSettingsInfo ?? current.tool.imageSettingsInfo }
      for (const key of ['outputText', 'diff'] as const) {
        const previous = current.tool[key]
        if (fields.has(key) && previous !== undefined && (replacement.tool[key]?.length ?? 0) < previous.length) replacement.tool[key] = previous
      }
      for (const key of ['command', 'writeContent', 'path'] as const) {
        replacement.tool[key] ??= current.tool[key]
      }
      if (replacement.historical === current.historical && replacement.noReveal === current.noReveal
        && Object.keys({ ...current.tool, ...replacement.tool }).every((key) =>
          current.tool[key as keyof ToolItem] === replacement.tool[key as keyof ToolItem])) return current
    }
    return replacement
  })
  const replacements = new Map(incoming.filter((row) => matched.has(row.id)).map((row) => [row.id, row]))
  const retained = existing.map((row) => replacements.get(row.id) ?? row)
  const added = incoming.filter((row) => !matched.has(row.id))
  // A final snapshot can finish a draft whose start clock differed from the
  // stored final. Fold only the now-proven unique clock/full-body counterpart.
  const reconciled = reconcileCompletedAssistantRows(reconcileNewerTimelineItems(retained, added).items)
  // A bounded disk page can arrive before the complete live turn. Strictly
  // matched messages/calls are ordering anchors: put the missing opening and
  // early calls before their next shared row, not after the page's later tools.
  // Keep existing history order and fall back to appending when no consistent
  // shared anchor proves placement; snapshot sequence is never a disk ID.
  const byId = new Map(reconciled.map((row) => [row.id, row]))
  const acceptedRows = (rows: TimelineItem[]): TimelineItem[] => rows.flatMap((row) => {
    const accepted = byId.get(row.id)
    return accepted ? [accepted] : []
  })
  // The identity pass uses page placement, but these additions came from a
  // snapshot, not a newer disk page. Keep the actual retained display order.
  const ordered = orderTimelineAroundAnchors(acceptedRows(retained), acceptedRows(incoming))
  // Backend idle is authoritative, but busy alone must never complete every
  // tool: other calls can remain active after one message/result finishes.
  const settled = active ? ordered : finalizeStreaming({ ...state, timeline: ordered }).timeline
  const timeline = settled.length === state.timeline.length
    && settled.every((row, index) => row === state.timeline[index]) ? state.timeline : settled
  return {
    ...state,
    timeline,
    liveSessionOwnerPath: live.sessionPath ?? state.liveSessionOwnerPath,
    liveSessionBackendId: live.backendId,
    liveSessionRevision: live.revision,
    liveSessionTurnIds: incoming.map((row) => row.id).slice(-256),
    historyRevealRestorePending: revealHistory && (incoming.length > 0 || tombstones.length > 0)
      ? false : state.historyRevealRestorePending,
    timelineMutation: 'append'
  }
}

function reduceEvent(state: AgentState, input: WireEventInput, replay = false): AgentState {
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
  if (!replay && tasks !== undefined && (typeof resultId !== 'string' || !state.taskResultIds.includes(resultId))) {
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
        const row: Extract<TimelineItem, { kind: 'user' }> = {
          kind: 'user', id: nextTimelineId(), ...liveMessageIdentity(message),
          messageTimestamp: wireMessageTimestamp(message),
          text: messageText(message), images: messageImages(message), live: true
        }
        const candidates = state.timeline.filter((item) => sameStrongMessageIdentity(item, row))
        // A new send must not steal an older history row's entry ID, even if
        // the SDK clock/text collide. Repeated starts need a real shared ID.
        const current = candidates.length === 1 ? candidates[0] : undefined
        if (current?.kind === 'user') {
          const truncated = Array.isArray(message._pionLiveTruncatedFields) && message._pionLiveTruncatedFields.includes('text')
          const replacement = { ...current, liveMessageId: row.liveMessageId ?? current.liveMessageId,
            ...((current.entryId ?? row.entryId) ? { entryId: current.entryId ?? row.entryId } : {}),
            messageTimestamp: row.messageTimestamp ?? current.messageTimestamp,
            text: truncated ? current.text : row.text,
            images: row.images?.length ? row.images : current.images }
          return { ...state, timeline: state.timeline.map((item) => item === current ? replacement : item) }
        }
        return { ...state, timeline: [...state.timeline, row] }
      }
      if (message?.role === 'assistant') {
        const identity = liveMessageIdentity(message)
        const existing = identifiedAssistant(state.timeline, identity)
        // A replayed start must not create a second draft or erase a mounted
        // final. Clock/text alone do not prove that this is a repeated start.
        if (existing) return { ...state, timeline: state.timeline.map((row) => row === existing
          ? { ...existing, entryId: existing.entryId ?? identity.entryId,
            liveMessageId: existing.liveMessageId ?? identity.liveMessageId } : row) }
        return { ...state, timeline: [...state.timeline, {
          kind: 'assistant', id: nextTimelineId(), ...identity,
          messageTimestamp: wireMessageTimestamp(message), text: '', thinking: '', streaming: true, live: true
        }] }
      }
      return state
    }

    case 'message_update': {
      const sub = event.assistantMessageEvent
      if (!sub) return state
      const identity = liveMessageIdentity({ role: 'assistant',
        _pionLiveMessageId: (input as Record<string, unknown>)._pionLiveMessageId })
      const target = identity.liveMessageId ? identifiedAssistant(state.timeline, identity)
        : uniqueStreamingAssistant(state.timeline)
      if (!target?.streaming) return state
      const timeline = state.timeline.map((item) => {
        if (item !== target) return item
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
      if (message?.role === 'user') {
        const identity = liveMessageIdentity(message)
        // User ends supplement a known start only. An end alone cannot prove
        // a new bubble, and missing timestamps cannot identify legacy rows.
        const candidates = state.timeline.filter((item) => item.kind === 'user'
          && ((identity.liveMessageId && item.liveMessageId === identity.liveMessageId)
            || (identity.entryId && item.entryId === identity.entryId))
          && !(identity.entryId && item.entryId && identity.entryId !== item.entryId)
          && !(identity.liveMessageId && item.liveMessageId && identity.liveMessageId !== item.liveMessageId))
        const current = candidates.length === 1 ? candidates[0] : undefined
        if (current?.kind !== 'user') return state
        return { ...state, timeline: state.timeline.map((item) => item === current
          ? { ...current, ...identity, messageTimestamp: wireMessageTimestamp(message) ?? current.messageTimestamp } : item) }
      }
      if (message?.role !== 'assistant') return state
      const identity = liveMessageIdentity(message)
      const timestamp = wireMessageTimestamp(message)
      const target = identity.liveMessageId || identity.entryId
        ? identifiedAssistant(state.timeline, identity)
        : uniqueStreamingAssistant(state.timeline, timestamp)
      if (!target) return state
      const text = messageText(message)
      const thinking = messageThinking(message)
      const error = assistantErrorText(message)
      const timeline = state.timeline.flatMap((item) => {
        if (item !== target) return [item]
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
          entryId: identity.entryId ?? item.entryId,
          liveMessageId: identity.liveMessageId ?? item.liveMessageId,
          messageTimestamp: timestamp ?? item.messageTimestamp,
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
      // A late entry cannot be assigned to the last row merely by role.
      // Identity-only snapshot attachments have no content; normal entries do
      // and must agree with the complete user message including its images.
      const identity = liveMessageIdentity(persistedMessage)
      const candidates = timeline.filter((item) => {
        if (item.kind !== role || (item.kind !== 'user' && item.kind !== 'assistant')
          || item.entryId || (item.kind === 'assistant' && item.errorContext)) return false
        if (identity.liveMessageId && item.liveMessageId) return identity.liveMessageId === item.liveMessageId
        if (timestamp === undefined || item.messageTimestamp !== timestamp) return false
        return item.kind !== 'user' || persistedMessage?.content === undefined
          || (item.text === messageText(persistedMessage)
            && JSON.stringify(item.images ?? []) === JSON.stringify(messageImages(persistedMessage) ?? []))
      })
      if (candidates.length === 1) {
        const item = candidates[0]
        const i = timeline.indexOf(item)
        timeline[i] = { ...item, entryId: entry.id } as TimelineItem
      }
      return { ...state, timeline }
    }

    case 'tool_execution_start': {
      const existing = state.timeline.find((item) => item.kind === 'tool' && item.tool.id === event.toolCallId)
      if (existing?.kind === 'tool') {
        if (existing.tool.resultReceived || (existing.tool.live && existing.tool.status === 'running')) return state
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

/** True backend idle closes display-only running indicators, not result payloads. */
function finalizeStreaming(state: AgentState): AgentState {
  const timeline = state.timeline.flatMap((item): TimelineItem[] => {
    if (item.kind === 'tool' && item.tool.status === 'running') {
      return [{ ...item, tool: { ...item.tool, status: 'done' } }]
    }
    if (item.kind !== 'assistant' || !item.streaming) return [item]
    if (item.text === '' && item.thinking === '' && !item.error) return []
    return [{ ...item, streaming: false }]
  })
  return { ...state, timeline }
}
