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
}

export function useAgentModelActions({
  api,
  dispatch,
  refreshModels
}: UseAgentModelActionsOptions) {
  const setModel = useCallback(
    async (provider: string, modelId: string): Promise<void> => {
      if (!api) return
      await api.setModel(provider, modelId)
      await refreshModels()
    },
    [api, refreshModels]
  )

  const listModelProviders = useCallback(async (): Promise<ModelProviderInfo[]> => {
    if (!api) return []
    return api.listModelProviders()
  }, [api])

  const loginModelProvider = useCallback(async (
    providerId: string,
    authType: ModelProviderAuthType
  ): Promise<ModelProviderInfo[]> => {
    if (!api) throw new Error('preload 桥未加载')
    const providers = await api.loginModelProvider(providerId, authType)
    await refreshModels()
    return providers
  }, [api, refreshModels])

  const logoutModelProvider = useCallback(async (
    providerId: string
  ): Promise<ModelProviderInfo[]> => {
    if (!api) throw new Error('preload 桥未加载')
    const providers = await api.logoutModelProvider(providerId)
    await refreshModels()
    return providers
  }, [api, refreshModels])

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
      const models = await api.addModelProvider(input)
      dispatch({ type: 'models', models })
    },
    [api, dispatch]
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
      await api.setMode(mode)
      dispatch({ type: 'mode', mode })
    },
    [api, dispatch]
  )

  const setYoloMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!api) return
      await api.setYoloMode(enabled)
    },
    [api]
  )

  return {
    setModel,
    listModelProviders,
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
