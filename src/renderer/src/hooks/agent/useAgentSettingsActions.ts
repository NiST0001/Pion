import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { PionApi } from '../../../../shared/types'

interface UseAgentSettingsActionsOptions {
  api: PionApi | undefined
  timelineOwnerPath: MutableRefObject<string | undefined>
  reloadTimeline: (sessionPath?: string) => Promise<void>
  refreshHistoryIndex: (sessionPath?: string) => Promise<void>
}

export function useAgentSettingsActions({
  api,
  timelineOwnerPath,
  reloadTimeline,
  refreshHistoryIndex
}: UseAgentSettingsActionsOptions) {
  const setAutoCompaction = useCallback(
    async (enabled: boolean): Promise<void> => {
      await api?.setAutoCompaction(enabled)
    },
    [api]
  )

  const setAutoRetry = useCallback(
    async (enabled: boolean): Promise<void> => {
      await api?.setAutoRetry(enabled)
    },
    [api]
  )

  const compactNow = useCallback(async (customInstructions?: string): Promise<void> => {
    if (!api) return
    await api.compactNow(customInstructions)
    const path = timelineOwnerPath.current
    await reloadTimeline(path)
    if (path) void refreshHistoryIndex(path)
  }, [api, refreshHistoryIndex, reloadTimeline, timelineOwnerPath])

  const exportHtml = useCallback(
    async (): Promise<string> => (await api?.exportSessionHtml()) ?? '',
    [api]
  )

  const renameSession = useCallback(
    async (name: string, sessionPath?: string): Promise<void> => {
      await api?.renameSession(name, sessionPath)
    },
    [api]
  )

  const setSteeringMode = useCallback(
    async (mode: 'all' | 'one-at-a-time'): Promise<void> => {
      await api?.setSteeringMode(mode)
    },
    [api]
  )

  const setFollowUpMode = useCallback(
    async (mode: 'all' | 'one-at-a-time'): Promise<void> => {
      await api?.setFollowUpMode(mode)
    },
    [api]
  )

  return {
    setAutoCompaction,
    setAutoRetry,
    compactNow,
    exportHtml,
    renameSession,
    setSteeringMode,
    setFollowUpMode
  }
}
