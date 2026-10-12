import { useCallback } from 'react'
import type { Dispatch } from 'react'
import type { Action } from '../../agent/types'
import type {
  AddModelProviderInput,
  AgentMode,
  ModelProviderAuthType,
  ModelProviderInfo,
  PionApi
} from '../../../../shared/types'

interface UseAgentModelActionsOptions {
  api: PionApi | undefined
  dispatch: Dispatch<Action>
  refreshModels: () => Promise<void>
  /** Capture the shared logical selection plus API/SDK backend identity. */
  captureSelection?: () => () => boolean
}

const captureUnscopedSelection = () => () => true

export function useAgentModelActions({
  api,
  dispatch,
  refreshModels,
  captureSelection = captureUnscopedSelection
}: UseAgentModelActionsOptions) {
  const setModel = useCallback(
    async (provider: string, modelId: string): Promise<void> => {
      if (!api) return
      const isSelected = captureSelection()
      await api.setModel(provider, modelId)
      if (isSelected()) await refreshModels()
    },
    [api, refreshModels, captureSelection]
  )

  const listModelProviders = useCallback(async (): Promise<ModelProviderInfo[]> => {
    if (!api) return []
    return api.listModelProviders()
  }, [api])

  const setModelProviderEnabled = useCallback(async (providerId: string, enabled: boolean): Promise<ModelProviderInfo[]> => {
    if (!api) throw new Error('preload 桥未加载')
    const isSelected = captureSelection()
    const providers = await api.setModelProviderEnabled(providerId, enabled)
    if (isSelected()) await refreshModels()
    return providers
  }, [api, refreshModels, captureSelection])

  const loginModelProvider = useCallback(async (
    providerId: string,
    authType: ModelProviderAuthType
  ): Promise<ModelProviderInfo[]> => {
    if (!api) throw new Error('preload 桥未加载')
    const isSelected = captureSelection()
    const providers = await api.loginModelProvider(providerId, authType)
    if (isSelected()) await refreshModels()
    return providers
  }, [api, refreshModels, captureSelection])

  const logoutModelProvider = useCallback(async (
    providerId: string
  ): Promise<ModelProviderInfo[]> => {
    if (!api) throw new Error('preload 桥未加载')
    const isSelected = captureSelection()
    const providers = await api.logoutModelProvider(providerId)
    if (isSelected()) await refreshModels()
    return providers
  }, [api, refreshModels, captureSelection])

  const cancelModelProviderAuth = useCallback(async (): Promise<void> => {
    await api?.cancelModelProviderAuth()
  }, [api])

  const openModelProviderAuthUrl = useCallback(async (url: string): Promise<void> => {
    if (!api) throw new Error('preload 桥未加载')
    await api.openModelProviderAuthUrl(url)
  }, [api])

  const addModelProvider = useCallback(
    async (input: AddModelProviderInput): Promise<void> => {
      if (!api) throw new Error('preload 桥未加载')
      const isSelected = captureSelection()
      const models = await api.addModelProvider(input)
      if (isSelected()) dispatch({ type: 'models', models })
    },
    [api, dispatch, captureSelection]
  )

  const setThinkingLevel = useCallback(
    async (level: string): Promise<void> => {
      if (!api) return
      await api.setThinkingLevel(level)
    },
    [api]
  )

  const setMode = useCallback(
    async (mode: AgentMode): Promise<void> => {
      if (!api) return
      const isSelected = captureSelection()
      await api.setMode(mode)
      if (isSelected()) dispatch({ type: 'mode', mode })
    },
    [api, dispatch, captureSelection]
  )

  const setYoloMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!api) return
      await api.setYoloMode(enabled)
    },
    [api]
  )

  const setSubagentsMode = useCallback(async (enabled: boolean, sessionId: string): Promise<void> => {
    if (!api) throw new Error('preload 桥未加载')
    await api.setSubagentsMode(enabled, sessionId)
  }, [api])

  return {
    setSubagentsMode,
    setModel,
    listModelProviders,
    setModelProviderEnabled,
    loginModelProvider,
    logoutModelProvider,
    cancelModelProviderAuth,
    openModelProviderAuthUrl,
    addModelProvider,
    setThinkingLevel,
    setMode,
    setYoloMode
  }
}
