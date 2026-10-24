import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  sessionPath?: string
  policyEnabled: boolean
  agentBusy: boolean
  statusPhase: AgentStatus['phase']
  updateProjectTrust: (cwd: string, decision: boolean | null) => Promise<ProjectTrustInfo>
}

export function isSessionInteractionRequest(
  request: { cwd: string; sessionPath?: string; scope?: 'workspace' | 'global' },
  cwd?: string,
  sessionPath?: string
): boolean {
  return request.scope !== 'global' && !!cwd && request.cwd === cwd && request.sessionPath === sessionPath
}

interface RequestResolution {
  busy: boolean
  error: string
}

/** Keep actual IPC slots and errors attached to the request, not the selected session. */
function useRequestResolutions(requests: readonly { id: string }[]) {
  const requestsRef = useRef(requests)
  requestsRef.current = requests
  const pending = useRef(new Set<string>())
  const [states, setStates] = useState<ReadonlyMap<string, RequestResolution>>(() => new Map())

  useEffect(() => {
    const ids = new Set(requests.map((request) => request.id))
    setStates((current) => {
      const next = new Map([...current].filter(([id]) => ids.has(id) || pending.current.has(id)))
      return next.size === current.size ? current : next
    })
  }, [requests])

  const resolve = useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
    if (pending.current.has(id)) return
    pending.current.add(id)
    setStates((current) => new Map(current).set(id, { busy: true, error: '' }))
    let message = ''
    try {
      await action()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    } finally {
      pending.current.delete(id)
      setStates((current) => {
        const next = new Map(current)
        if (message && requestsRef.current.some((request) => request.id === id)) {
          next.set(id, { busy: false, error: message })
        } else next.delete(id)
        return next
      })
    }
  }, [])

  return { states, resolve }
}

export function useAppInteractionState({
  hasBridge,
  cwd,
  sessionPath,
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
  const [extensionUiRequests, setExtensionUiRequests] = useState<ExtensionUiRequest[]>([])
  const [modelProviderAuthState, setModelProviderAuthState] = useState<ModelProviderAuthState | null>(null)
  const toolPermissionResolutions = useRequestResolutions(toolPermissionRequests)
  const extensionUiResolutions = useRequestResolutions(extensionUiRequests)
  const scope = useMemo(() => ({ cwd, sessionPath }), [cwd, sessionPath])
  const scopeRef = useRef(scope)
  scopeRef.current = scope

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
    let pushed = false
    const off = window.pion.onToolPermissionRequests((requests) => {
      pushed = true
      if (active) setToolPermissionRequests(requests)
    })
    void window.pion.getPendingToolPermissionRequests().then((requests) => {
      if (active && !pushed) setToolPermissionRequests(requests)
    }).catch((error: unknown) => console.error('[pion] failed to load permission requests:', error))
    return () => {
      active = false
      off()
    }
  }, [hasBridge])

  useEffect(() => {
    if (!hasBridge) return
    let active = true
    let pushed = false
    const off = window.pion.onExtensionUiRequests((requests) => {
      pushed = true
      if (active) setExtensionUiRequests(requests)
    })
    void window.pion.getPendingExtensionUiRequests().then((requests) => {
      if (active && !pushed) setExtensionUiRequests(requests)
    }).catch((error: unknown) => console.error('[pion] failed to load interaction requests:', error))
    return () => {
      active = false
      off()
    }
  }, [hasBridge])

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
    id: string,
    resolution: ToolPermissionResolution
  ): Promise<void> => {
    const request = toolPermissionRequests.find((item) => item.id === id)
    const owner = scopeRef.current
    if (!hasBridge || !request || !isSessionInteractionRequest(request, owner.cwd, owner.sessionPath)) return
    await toolPermissionResolutions.resolve(id, async () => {
      try {
        await window.pion.resolveToolPermission(id, resolution)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('已结束') || message.includes('已关闭')) {
          setToolPermissionRequests((current) => current.filter((item) => item.id !== id))
        }
        throw error
      }
      setToolPermissionRequests((current) => current.filter((item) => item.id !== id))
      if (scopeRef.current !== owner || !owner.cwd) return
      const policy = await window.pion.getToolPermissionPolicy(owner.cwd)
      if (scopeRef.current === owner) setToolPermissionPolicy(policy)
    })
  }, [hasBridge, toolPermissionRequests, toolPermissionResolutions.resolve])

  const handleExtensionUiResolve = useCallback(async (
    id: string,
    response: ExtensionUiResponse
  ): Promise<void> => {
    const request = extensionUiRequests.find((item) => item.id === id)
    const owner = scopeRef.current
    if (!hasBridge || !request || (request.scope !== 'global'
      && !isSessionInteractionRequest(request, owner.cwd, owner.sessionPath))) return
    await extensionUiResolutions.resolve(id, async () => {
      try {
        await window.pion.resolveExtensionUiRequest(id, response)
        setExtensionUiRequests((current) => current.filter((item) => item.id !== id))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('已结束') || message.includes('已关闭')) {
          setExtensionUiRequests((current) => current.filter((item) => item.id !== id))
        }
        throw error
      }
    })
  }, [hasBridge, extensionUiRequests, extensionUiResolutions.resolve])

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
    toolPermissionResolutions: toolPermissionResolutions.states,
    extensionUiRequests,
    modelProviderAuthState,
    extensionUiResolutions: extensionUiResolutions.states,
    handleCompletionNotificationsChange,
    handleProjectTrustChange,
    handleToolPermissionChange,
    handleToolPermissionReset,
    handleToolPermissionResolve,
    handleExtensionUiResolve
  }
}
