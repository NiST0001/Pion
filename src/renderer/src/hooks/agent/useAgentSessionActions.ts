import { useCallback, useEffect, useRef } from 'react'
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
  /** Explicit navigation intent; this mutation's STATE/history updates retain ownership. */
  captureSelectionIntent?: () => () => boolean
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
  captureSelection,
  captureSelectionIntent = captureSelection
}: UseAgentSessionActionsOptions) {
  const windowApi = typeof window === 'undefined' ? undefined : window.pion
  const apiOwner = useRef({ api, windowApi })
  if (apiOwner.current.api !== api || apiOwner.current.windowApi !== windowApi) apiOwner.current = { api, windowApi }
  const owner = apiOwner.current
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const isCurrentApi = useCallback(() => mounted.current && apiOwner.current === owner
    && (typeof window === 'undefined' ? undefined : window.pion) === owner.windowApi, [owner])

  const reorderSessions = useCallback((cwd: string, paths: string[]): void => {
    saveSessionOrder(cwd, paths)
    dispatch({ type: 'reorderSessions', cwd, paths })
  }, [dispatch])

  const refreshProjectSessions = useCallback(async (cwd: string): Promise<void> => {
    if (!api || !isCurrentApi()) return
    const sessions = await api.listSessions(cwd)
    if (!isCurrentApi()) return
    dispatch({ type: 'projectSessionsUpdate', cwd, sessions })
  }, [api, dispatch, isCurrentApi])

  const deleteSession = useCallback(
    async (sessionPath: string): Promise<void> => {
      if (!api || !isCurrentApi()) return
      const isSelected = captureSelection()
      const selectedOwner = timelineOwnerPath.current
      const result = await api.deleteSession(sessionPath)
      if (!isCurrentApi()) return
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
    [api, captureSelection, clearTimeline, historyCursor, isCurrentApi, reloadTimeline, reloadTimelineAfterDelete, timelineCache, timelineOwnerPath]
  )

  const copySession = useCallback(
    async (sessionPath: string): Promise<void> => {
      if (!api || !isCurrentApi()) return
      const isSelected = captureSelectionIntent()
      const result = await api.copySession(sessionPath)
      if (result.cancelled || !isCurrentApi() || !isSelected()) return
      clearTimeline()
      timelineOwnerPath.current = undefined
      historyCursor.current = null
      await reloadTimeline()
    },
    [api, captureSelectionIntent, clearTimeline, historyCursor, isCurrentApi, reloadTimeline, timelineOwnerPath]
  )

  const getSessionForkMessages = useCallback(
    async (sessionPath: string): Promise<ForkMessageOption[]> => {
      if (!api || !isCurrentApi()) return []
      const messages = await api.getSessionForkMessages(sessionPath)
      return isCurrentApi() ? messages : []
    },
    [api, isCurrentApi]
  )

  const forkSession = useCallback(
    async (sessionPath: string, entryId: string): Promise<string> => {
      if (!api || !isCurrentApi()) return ''
      const isSelected = captureSelectionIntent()
      const result = await api.forkSession(sessionPath, entryId)
      if (result.cancelled || !isCurrentApi() || !isSelected()) return ''
      clearTimeline()
      timelineOwnerPath.current = undefined
      historyCursor.current = null
      await reloadTimeline()
      // The owned reload selects the fork's new path itself. Fence explicit
      // navigation/API replacement, rather than rejecting that valid update.
      return isCurrentApi() && isSelected() ? result.text : ''
    },
    [api, captureSelectionIntent, clearTimeline, historyCursor, isCurrentApi, reloadTimeline, timelineOwnerPath]
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
