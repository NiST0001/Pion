import { useCallback } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { ForkMessageOption, PionApi } from '../../../../shared/types'
import type { Action } from '../../agent/types'
import { saveSessionOrder } from '../../agent/sessionOrder'
import type { HistoryCursor, TimelineCacheEntry } from '../../agent/timeline'

interface UseAgentSessionActionsOptions {
  api: PionApi | undefined
  dispatch: Dispatch<Action>
  timelineCache: MutableRefObject<Map<string, TimelineCacheEntry>>
  timelineOwnerPath: MutableRefObject<string | undefined>
  historyCursor: MutableRefObject<HistoryCursor | null>
  reloadTimeline: (sessionPath?: string) => Promise<void>
}

export function useAgentSessionActions({
  api,
  dispatch,
  timelineCache,
  timelineOwnerPath,
  historyCursor,
  reloadTimeline
}: UseAgentSessionActionsOptions) {
  const reorderSessions = useCallback((cwd: string, paths: string[]): void => {
    saveSessionOrder(cwd, paths)
    dispatch({ type: 'reorderSessions', cwd, paths })
  }, [dispatch])

  const refreshProjectSessions = useCallback(async (cwd: string): Promise<void> => {
    if (!api) return
    const sessions = await api.listSessions(cwd)
    dispatch({ type: 'projectSessionsUpdate', cwd, sessions })
  }, [api, dispatch])

  const deleteSession = useCallback(
    async (sessionPath: string): Promise<void> => {
      if (!api) return
      timelineCache.current.delete(sessionPath)
      if (timelineOwnerPath.current === sessionPath) {
        timelineOwnerPath.current = undefined
        historyCursor.current = null
      }
      const result = await api.deleteSession(sessionPath)
      if (result.activeSessionChanged) await reloadTimeline()
    },
    [api, historyCursor, reloadTimeline, timelineCache, timelineOwnerPath]
  )

  const copySession = useCallback(
    async (sessionPath: string): Promise<void> => {
      if (!api) return
      const result = await api.copySession(sessionPath)
      if (!result.cancelled) {
        timelineOwnerPath.current = undefined
        historyCursor.current = null
        await reloadTimeline()
      }
    },
    [api, historyCursor, reloadTimeline, timelineOwnerPath]
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
      timelineOwnerPath.current = undefined
      historyCursor.current = null
      await reloadTimeline()
      return result.text
    },
    [api, historyCursor, reloadTimeline, timelineOwnerPath]
  )

  return {
    reorderSessions,
    refreshProjectSessions,
    deleteSession,
    copySession,
    getSessionForkMessages,
    forkSession
  }
}
