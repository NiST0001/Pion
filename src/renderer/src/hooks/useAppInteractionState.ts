import { useCallback, useEffect, useState } from 'react'
import type {
  AgentStatus,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ModelProviderAuthState,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  ToolPermissionCategory,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRules
} from '../../../shared/types'

interface UseAppInteractionStateOptions {
  hasBridge: boolean
  cwd?: string
  policyEnabled: boolean
  agentBusy: boolean
  statusPhase: AgentStatus['phase']
  updateProjectTrust: (cwd: string, decision: boolean | null) => Promise<ProjectTrustInfo>
}

export function useAppInteractionState({
  hasBridge,
  cwd,
  policyEnabled,
  agentBusy,
  statusPhase,
  updateProjectTrust
}: UseAppInteractionStateOptions) {
  const [completionNotificationsEnabled, setCompletionNotificationsEnabled] = useState(true)
  const [projectTrust, setProjectTrust] = useState<ProjectTrustInfo | null>(null)
  const [projectTrustBusy, setProjectTrustBusy] = useState(false)
  const [projectTrustError, setProjectTrustError] = useState('')
  const [toolPermissionPolicy, setToolPermissionPolicy] = useState<ProjectToolPermissionPolicy | null>(null)
  const [toolPermissionBusy, setToolPermissionBusy] = useState(false)
  const [toolPermissionError, setToolPermissionError] = useState('')
  const [toolPermissionRequests, setToolPermissionRequests] = useState<ToolPermissionRequest[]>([])
  const [toolPermissionResolveBusy, setToolPermissionResolveBusy] = useState(false)
  const [toolPermissionResolveError, setToolPermissionResolveError] = useState('')
  const [extensionUiRequests, setExtensionUiRequests] = useState<ExtensionUiRequest[]>([])
  const [modelProviderAuthState, setModelProviderAuthState] = useState<ModelProviderAuthState | null>(null)
  const [extensionUiResolveBusy, setExtensionUiResolveBusy] = useState(false)
  const [extensionUiResolveError, setExtensionUiResolveError] = useState('')

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    void window.pion.getCompletionNotificationsEnabled()
      .then((enabled) => {
        if (active) setCompletionNotificationsEnabled(enabled)
      })
      .catch((error: unknown) => {
        console.error('[pion] failed to load notification setting:', error)
      })
    return () => {
      active = false
    }
  }, [hasBridge])

  useEffect(() => {
    if (!hasBridge || !cwd || !policyEnabled) {
      setProjectTrust(null)
      setToolPermissionPolicy(null)
      return
    }
    let active = true
    setProjectTrustError('')
    setToolPermissionError('')
    void Promise.all([
      window.pion.getProjectTrust(cwd),
      window.pion.getToolPermissionPolicy(cwd)
    ])
      .then(([trust, policy]) => {
        if (!active) return
        setProjectTrust(trust)
        setToolPermissionPolicy(policy)
      })
      .catch((error: unknown) => {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        setProjectTrustError(message)
        setToolPermissionError(message)
      })
    return () => {
      active = false
    }
  }, [cwd, hasBridge, policyEnabled])

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    const off = window.pion.onToolPermissionRequests((requests) => {
      if (active) setToolPermissionRequests(requests)
    })
    void window.pion.getPendingToolPermissionRequests().then((requests) => {
      if (active) setToolPermissionRequests(requests)
    })
    return () => {
      active = false
      off()
    }
  }, [hasBridge])

  useEffect(() => {
    setToolPermissionResolveError('')
  }, [toolPermissionRequests[0]?.id])

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    const off = window.pion.onExtensionUiRequests((requests) => {
      if (active) setExtensionUiRequests(requests)
    })
    void window.pion.getPendingExtensionUiRequests().then((requests) => {
      if (active) setExtensionUiRequests(requests)
    })
    return () => {
      active = false
      off()
    }
  }, [hasBridge])

  useEffect(() => {
    setExtensionUiResolveError('')
  }, [extensionUiRequests[0]?.id])

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    const off = window.pion.onModelProviderAuthState((providerAuthState) => {
      if (active) setModelProviderAuthState(providerAuthState)
    })
    void window.pion.getModelProviderAuthState()
      .then((providerAuthState) => {
        if (active) setModelProviderAuthState(providerAuthState)
      })
      .catch(() => undefined)
    return () => {
      active = false
      off()
    }
  }, [hasBridge])

  const handleCompletionNotificationsChange = useCallback(async (enabled: boolean): Promise<void> => {
    if (!hasBridge) return
    try {
      await window.pion.setCompletionNotificationsEnabled(enabled)
      setCompletionNotificationsEnabled(enabled)
    } catch (error) {
      console.error('[pion] failed to update notification setting:', error)
    }
  }, [hasBridge])

  const handleProjectTrustChange = useCallback(async (decision: boolean | null): Promise<void> => {
    if (!cwd || projectTrustBusy || agentBusy || statusPhase === 'starting') return
    setProjectTrustBusy(true)
    setProjectTrustError('')
    try {
      setProjectTrust(await updateProjectTrust(cwd, decision))
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectTrustBusy(false)
    }
  }, [agentBusy, cwd, projectTrustBusy, statusPhase, updateProjectTrust])

  const handleToolPermissionChange = useCallback(async (
    category: ToolPermissionCategory,
    decision: ToolPermissionDecision
  ): Promise<void> => {
    if (!cwd || toolPermissionBusy) return
    const updates: Partial<ToolPermissionRules> = { [category]: decision }
    setToolPermissionBusy(true)
    setToolPermissionError('')
    try {
      setToolPermissionPolicy(await window.pion.setToolPermissionPolicy(cwd, updates))
    } catch (error) {
      setToolPermissionError(error instanceof Error ? error.message : String(error))
    } finally {
      setToolPermissionBusy(false)
    }
  }, [cwd, toolPermissionBusy])

  const handleToolPermissionReset = useCallback(async (): Promise<void> => {
    if (!cwd || toolPermissionBusy) return
    setToolPermissionBusy(true)
    setToolPermissionError('')
    try {
      setToolPermissionPolicy(await window.pion.setToolPermissionPolicy(cwd, null))
    } catch (error) {
      setToolPermissionError(error instanceof Error ? error.message : String(error))
    } finally {
      setToolPermissionBusy(false)
    }
  }, [cwd, toolPermissionBusy])

  const handleToolPermissionResolve = useCallback(async (
    resolution: ToolPermissionResolution
  ): Promise<void> => {
    const request = toolPermissionRequests[0]
    if (!request || toolPermissionResolveBusy) return
    setToolPermissionResolveBusy(true)
    setToolPermissionResolveError('')
    try {
      await window.pion.resolveToolPermission(request.id, resolution)
      setToolPermissionRequests((current) => current.filter((item) => item.id !== request.id))
      if (cwd) setToolPermissionPolicy(await window.pion.getToolPermissionPolicy(cwd))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToolPermissionResolveError(message)
      if (message.includes('已结束') || message.includes('已关闭')) {
        setToolPermissionRequests((current) => current.filter((item) => item.id !== request.id))
      }
    } finally {
      setToolPermissionResolveBusy(false)
    }
  }, [cwd, toolPermissionRequests, toolPermissionResolveBusy])

  const handleExtensionUiResolve = useCallback(async (
    response: ExtensionUiResponse
  ): Promise<void> => {
    const request = extensionUiRequests[0]
    if (!request || extensionUiResolveBusy) return
    setExtensionUiResolveBusy(true)
    setExtensionUiResolveError('')
    try {
      await window.pion.resolveExtensionUiRequest(request.id, response)
      setExtensionUiRequests((current) => current.filter((item) => item.id !== request.id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setExtensionUiResolveError(message)
      if (message.includes('已结束') || message.includes('已关闭')) {
        setExtensionUiRequests((current) => current.filter((item) => item.id !== request.id))
      }
    } finally {
      setExtensionUiResolveBusy(false)
    }
  }, [extensionUiRequests, extensionUiResolveBusy])

  return {
    completionNotificationsEnabled,
    projectTrust,
    setProjectTrust,
    projectTrustBusy,
    projectTrustError,
    toolPermissionPolicy,
    toolPermissionBusy,
    toolPermissionError,
    toolPermissionRequests,
    toolPermissionResolveBusy,
    toolPermissionResolveError,
    extensionUiRequests,
    modelProviderAuthState,
    extensionUiResolveBusy,
    extensionUiResolveError,
    handleCompletionNotificationsChange,
    handleProjectTrustChange,
    handleToolPermissionChange,
    handleToolPermissionReset,
    handleToolPermissionResolve,
    handleExtensionUiResolve
  }
}
