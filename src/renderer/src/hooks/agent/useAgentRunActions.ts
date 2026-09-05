import { useCallback } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { ImageContent, PionApi, SessionMeta } from '../../../../shared/types'
import type { Action, AgentState } from '../../agent/types'
import type { HistoryCursor } from '../../agent/timeline'
import type { TimelineCacheEntry } from '../../agent/timeline'

interface UseAgentRunActionsOptions {
  api: PionApi | undefined
  state: AgentState
  dispatch: Dispatch<Action>
  refreshModels: () => Promise<void>
  optimisticSessionTimers: MutableRefObject<Map<string, number>>
  timelineLoadId: MutableRefObject<number>
  historyIndexLoadId: MutableRefObject<number>
  historyIndexInFlight: MutableRefObject<{ path: string; promise: Promise<void> } | null>
  historyCursor: MutableRefObject<HistoryCursor | null>
  timelineCache: MutableRefObject<Map<string, TimelineCacheEntry>>
  timelineOwnerPath: MutableRefObject<string | undefined>
  expectedTimeline: MutableRefObject<{ path: string; items: AgentState['timeline'] } | null>
  reloadTimeline: (sessionPath?: string) => Promise<void>
}

export function useAgentRunActions({
  api,
  state,
  dispatch,
  refreshModels,
  optimisticSessionTimers,
  timelineLoadId,
  historyIndexLoadId,
  historyIndexInFlight,
  historyCursor,
  timelineOwnerPath,
  expectedTimeline
}: UseAgentRunActionsOptions) {
  const send = useCallback(
    async (message: string, images: ImageContent[] = []): Promise<void> => {
      const prompt = message.trim()
      if (!api || (prompt === '' && images.length === 0)) return

      const cwd = state.status.cwd
      const session = state.session
      const alreadyListed = Boolean(cwd && session && state.sessionsByProject[cwd]?.some((item) => (
        item.id === session.sessionId && !item.optimistic
      )))
      const shouldProject = Boolean(cwd && session && session.messageCount === 0 && !alreadyListed)
      const optimisticKey = shouldProject && cwd && session
        ? `${cwd}\u0000${session.sessionId}`
        : null
      if (shouldProject && cwd && session && optimisticKey) {
        const now = Date.now()
        const preview = prompt.replace(/\s+/g, ' ').slice(0, 90) || '图片消息'
        const optimisticSession: SessionMeta = {
          projectCwd: cwd,
          path: session.sessionFile ?? `pion:pending:${session.sessionId}`,
          id: session.sessionId,
          name: session.sessionName,
          timestamp: new Date(now).toISOString(),
          mtime: now,
          preview,
          messageCount: 1,
          optimistic: true
        }
        dispatch({ type: 'optimisticSession', session: optimisticSession })
        const existingTimer = optimisticSessionTimers.current.get(optimisticKey)
        if (existingTimer) window.clearTimeout(existingTimer)
        optimisticSessionTimers.current.set(optimisticKey, window.setTimeout(() => {
          optimisticSessionTimers.current.delete(optimisticKey)
          dispatch({ type: 'removeOptimisticSession', cwd, id: session.sessionId })
        }, 30_000))
      }

      try {
        await api.send(prompt, images)
        await refreshModels()
      } catch (error) {
        if (optimisticKey && cwd && session) {
          const timer = optimisticSessionTimers.current.get(optimisticKey)
          if (timer) window.clearTimeout(timer)
          optimisticSessionTimers.current.delete(optimisticKey)
          dispatch({ type: 'removeOptimisticSession', cwd, id: session.sessionId })
        }
        throw error
      }
    },
    [api, dispatch, optimisticSessionTimers, refreshModels, state.session, state.sessionsByProject, state.status.cwd]
  )

  const queue = useCallback(
    async (message: string, images: ImageContent[] = []): Promise<void> => {
      if (!api || (message.trim() === '' && images.length === 0)) return
      await api.queue(message.trim(), images)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const sendQueuedMessage = useCallback(
    async (kind: 'steering' | 'followUp', index: number): Promise<void> => {
      if (!api || !Number.isInteger(index) || index < 0) return
      await api.sendQueuedMessage(kind, index)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const abort = useCallback(async (): Promise<void> => {
    if (!api) return
    await api.abort()
  }, [api])

  const rollbackRunCheckpoint = useCallback(async () => {
    if (!api) return null
    const checkpoint = await api.rollbackRunCheckpoint()
    dispatch({ type: 'runCheckpoint', checkpoint })
    return checkpoint
  }, [api, dispatch])

  const newSession = useCallback(async (): Promise<void> => {
    if (!api) return
    ++timelineLoadId.current
    ++historyIndexLoadId.current
    historyIndexInFlight.current = null
    historyCursor.current = null
    timelineOwnerPath.current = undefined
    expectedTimeline.current = null
    dispatch({ type: 'historyIndex', index: null })
    // Clear the visible conversation before backend startup. The new backend
    // can take a moment to initialize, and the previous session must not stay
    // on screen while that happens.
    dispatch({ type: 'clearTimeline' })
    await api.newSession()
    await refreshModels()
  }, [api, dispatch, expectedTimeline, historyCursor, historyIndexInFlight, historyIndexLoadId, refreshModels, timelineLoadId, timelineOwnerPath])

  return {
    send,
    queue,
    sendQueuedMessage,
    abort,
    rollbackRunCheckpoint,
    newSession
  }
}
