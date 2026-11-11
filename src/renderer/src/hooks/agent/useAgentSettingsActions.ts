import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { PionApi } from '../../../../shared/types'
import type { SessionCommandTarget } from '../../../../shared/slash-command-protocol'

interface UseAgentSettingsActionsOptions {
  api: PionApi | undefined
  captureSessionCommand: () => { target: SessionCommandTarget; isSelected: () => boolean }
  timelineOwnerPath: MutableRefObject<string | undefined>
  reloadTimeline: (sessionPath?: string) => Promise<void>
  refreshHistoryIndex: (sessionPath?: string) => Promise<void>
}

export function useAgentSettingsActions({
  api,
  captureSessionCommand,
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

  const exportHtml = useCallback(async (): Promise<string> => {
    if (!api) throw new Error('preload 桥未加载')
    // Own the target and publication here; stale success and failure both return an empty display result.
    const { target, isSelected } = captureSessionCommand()
    try {
      const path = await api.exportSessionForCommand(target)
      return isSelected() ? path : ''
    } catch (error) {
      if (!isSelected()) return ''
      throw error
    }
  }, [api, captureSessionCommand])

  const renameSession = useCallback(
    async (name: string, sessionPath?: string): Promise<void> => {
      await api?.renameSession(name, sessionPath)
    },
    [api]
  )

  const migrateSessionToProject = useCallback(
    async (cwd: string): Promise<string | null> => {
      if (!api) return null
      return api.migrateSessionToProject(cwd)
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
    migrateSessionToProject,
    setSteeringMode,
    setFollowUpMode
  }
}
