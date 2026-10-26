import { useCallback, useRef } from 'react'
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
  reloadTimelineAfterDelete?: () => Promise<void>
  clearTimeline: (sessionPath?: string) => void
  captureSelection: () => () => boolean
}

export function useAgentSessionActions({
  api,
  dispatch,
  timelineCache,
  timelineOwnerPath,
  historyCursor,
  clearTimeline,
  reloadTimeline,
  reloadTimelineAfterDelete,
  captureSelection
}: UseAgentSessionActionsOptions) {
  const apiOwner = useRef({ api })
  if (apiOwner.current.api !== api) apiOwner.current = { api }
  const owner = apiOwner.current

  const reorderSessions = useCallback((cwd: string, paths: string[]): void => {
    saveSessionOrder(cwd, paths)
    dispatch({ type: 'reorderSessions', cwd, paths })
  }, [dispatch])

  const refreshProjectSessions = useCallback(async (cwd: string): Promise<void> => {
    if (!api || apiOwner.current !== owner) return
    const sessions = await api.listSessions(cwd)
    if (apiOwner.current !== owner) return
    dispatch({ type: 'projectSessionsUpdate', cwd, sessions })
  }, [api, dispatch, owner])

  const deleteSession = useCallback(
    async (sessionPath: string): Promise<void> => {
      if (!api || apiOwner.current !== owner) return
      const isSelected = captureSelection()
      const selectedOwner = timelineOwnerPath.current
      const result = await api.deleteSession(sessionPath)
      if (apiOwner.current !== owner) return
      // Failed removals keep their history intact. A successful old removal
      // may evict its own cache, while only its original selection may reset UI.
      timelineCache.current.delete(sessionPath)
      if (!isSelected() || timelineOwnerPath.current !== selectedOwner) return
      if (timelineOwnerPath.current === sessionPath) {
        timelineOwnerPath.current = undefined
        historyCursor.current = null
      }
      if (result.activeSessionChanged) {
        clearTimeline()
        await (reloadTimelineAfterDelete ?? reloadTimeline)()
      }
    },
    [api, captureSelection, clearTimeline, historyCursor, owner, reloadTimeline, reloadTimelineAfterDelete, timelineCache, timelineOwnerPath]
  )

  const copySession = useCallback(
    async (sessionPath: string): Promise<void> => {
      if (!api) return
      const result = await api.copySession(sessionPath)
      if (!result.cancelled) {
        clearTimeline()
        timelineOwnerPath.current = undefined
        historyCursor.current = null
        await reloadTimeline()
      }
    },
    [api, clearTimeline, historyCursor, reloadTimeline, timelineOwnerPath]
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
      clearTimeline()
      timelineOwnerPath.current = undefined
      historyCursor.current = null
      await reloadTimeline()
      return result.text
    },
    [api, clearTimeline, historyCursor, reloadTimeline, timelineOwnerPath]
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
