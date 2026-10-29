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

interface PolicySaveSlot {
  pending?: Promise<unknown>
  revision: number
}
// The app may unmount while the main process is still writing. Retain each
// domain's actual Promise across hook instances and API/selection changes.
const trustSaveSlot: PolicySaveSlot = { revision: 0 }
const permissionSaveSlot: PolicySaveSlot = { revision: 0 }

/** Retire visible save state on selection changes while retaining the actual Promise slot. */
function useScopedPolicySave(owner: object, isCurrent: () => boolean, slot: PolicySaveSlot) {
  const [state, setState] = useState<(RequestResolution & { owner: object }) | null>(null)
  const setError = useCallback((error: string) => {
    if (!isCurrent()) return
    setState((current) => ({ owner, busy: current?.owner === owner && current.busy, error }))
  }, [isCurrent, owner])
  const save = useCallback(async <T,>(action: () => Promise<T>, publish: (value: T) => void): Promise<void> => {
    if (slot.pending || !isCurrent()) return
    ++slot.revision
    setState({ owner, busy: true, error: '' })
    let message = ''
    let pending: Promise<T> | undefined
    try {
      pending = action()
      slot.pending = pending
      const value = await pending
      if (isCurrent()) publish(value)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    } finally {
      if (slot.pending === pending) slot.pending = undefined
      if (isCurrent()) setState({ owner, busy: false, error: message })
    }
  }, [isCurrent, owner, slot])
  return { busy: state?.owner === owner && state.busy, error: state?.owner === owner ? state.error : '', setError, save }
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
  const [toolPermissionPolicy, setToolPermissionPolicy] = useState<ProjectToolPermissionPolicy | null>(null)
  const [toolPermissionRequests, setToolPermissionRequests] = useState<ToolPermissionRequest[]>([])
  const [extensionUiRequests, setExtensionUiRequests] = useState<ExtensionUiRequest[]>([])
  const [modelProviderAuthState, setModelProviderAuthState] = useState<ModelProviderAuthState | null>(null)
  const toolPermissionResolutions = useRequestResolutions(toolPermissionRequests)
  const extensionUiResolutions = useRequestResolutions(extensionUiRequests)
  const api = hasBridge ? window.pion : undefined
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const notificationRevision = useRef(0)
  const apiOwner = useMemo(() => ({ api }), [api])
  const scope = useMemo(() => ({ apiOwner, cwd, sessionPath, policyEnabled }), [apiOwner, cwd, sessionPath, policyEnabled])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const isCurrentApi = useCallback(() => mounted.current && scopeRef.current.apiOwner === apiOwner && window.pion === api, [api, apiOwner])
  const isCurrentScope = useCallback(() => scopeRef.current === scope && isCurrentApi(), [isCurrentApi, scope])
  const toolPermissionRequestsOwner = useRef<typeof apiOwner | null>(null)
  const extensionUiRequestsOwner = useRef<typeof apiOwner | null>(null)
  const {
    busy: projectTrustBusy, error: projectTrustError, setError: setProjectTrustError, save: saveProjectTrust
  } = useScopedPolicySave(scope, isCurrentScope, trustSaveSlot)
  const {
    busy: toolPermissionBusy, error: toolPermissionError, setError: setToolPermissionError, save: saveToolPermission
  } = useScopedPolicySave(scope, isCurrentScope, permissionSaveSlot)

  useEffect(() => {
    if (!api) return
    let active = true
    const revision = notificationRevision.current
    void api.getCompletionNotificationsEnabled()
      .then((enabled) => {
        if (active && isCurrentApi() && notificationRevision.current === revision) setCompletionNotificationsEnabled(enabled)
      })
      .catch((error: unknown) => {
        if (active && isCurrentApi()) console.error('[pion] failed to load notification setting:', error)
      })
    return () => {
      active = false
    }
  }, [api, isCurrentApi])

  useEffect(() => {
    if (!api || !cwd || !policyEnabled) {
      setProjectTrust(null)
      setToolPermissionPolicy(null)
      return
    }
    let active = true
    const trustRevision = trustSaveSlot.revision
    const permissionRevision = permissionSaveSlot.revision
    setProjectTrustError('')
    setToolPermissionError('')
    void Promise.all([
      api.getProjectTrust(cwd),
      api.getToolPermissionPolicy(cwd)
    ])
      .then(([trust, policy]) => {
        if (!active || !isCurrentScope()) return
        if (trustSaveSlot.revision === trustRevision) setProjectTrust(trust)
        if (permissionSaveSlot.revision === permissionRevision) setToolPermissionPolicy(policy)
      })
      .catch((error: unknown) => {
        if (!active || !isCurrentScope()) return
        const message = error instanceof Error ? error.message : String(error)
        if (trustSaveSlot.revision === trustRevision) setProjectTrustError(message)
        if (permissionSaveSlot.revision === permissionRevision) setToolPermissionError(message)
      })
    return () => {
      active = false
    }
  }, [api, cwd, isCurrentScope, policyEnabled, setProjectTrustError, setToolPermissionError])

  useEffect(() => {
    if (!api) return
    let active = true
    let pushed = false
    const accept = (requests: ToolPermissionRequest[]) => {
      if (!active || !isCurrentApi()) return
      toolPermissionRequestsOwner.current = apiOwner
      setToolPermissionRequests(requests)
    }
    const off = api.onToolPermissionRequests((requests) => {
      pushed = true
      accept(requests)
    })
    void api.getPendingToolPermissionRequests().then((requests) => {
      if (!pushed) accept(requests)
    }).catch((error: unknown) => {
      if (active && isCurrentApi()) console.error('[pion] failed to load permission requests:', error)
    })
    return () => {
      active = false
      off()
    }
  }, [api, apiOwner, isCurrentApi])

  useEffect(() => {
    if (!api) return
    let active = true
    let pushed = false
    const accept = (requests: ExtensionUiRequest[]) => {
      if (!active || !isCurrentApi()) return
      extensionUiRequestsOwner.current = apiOwner
      setExtensionUiRequests(requests)
    }
    const off = api.onExtensionUiRequests((requests) => {
      pushed = true
      accept(requests)
    })
    void api.getPendingExtensionUiRequests().then((requests) => {
      if (!pushed) accept(requests)
    }).catch((error: unknown) => {
      if (active && isCurrentApi()) console.error('[pion] failed to load interaction requests:', error)
    })
    return () => {
      active = false
      off()
    }
  }, [api, apiOwner, isCurrentApi])

  useEffect(() => {
    if (!api) return
    let active = true
    let pushed = false
    const off = api.onModelProviderAuthState((providerAuthState) => {
      pushed = true
      if (active && isCurrentApi()) setModelProviderAuthState(providerAuthState)
    })
    void api.getModelProviderAuthState()
      .then((providerAuthState) => {
        if (active && !pushed && isCurrentApi()) setModelProviderAuthState(providerAuthState)
      })
      .catch(() => undefined)
    return () => {
      active = false
      off()
    }
  }, [api, isCurrentApi])

  const handleCompletionNotificationsChange = useCallback(async (enabled: boolean): Promise<void> => {
    if (!api || !isCurrentApi()) return
    const revision = ++notificationRevision.current
    try {
      await api.setCompletionNotificationsEnabled(enabled)
      if (isCurrentApi() && notificationRevision.current === revision) setCompletionNotificationsEnabled(enabled)
    } catch (error) {
      if (isCurrentApi() && notificationRevision.current === revision) console.error('[pion] failed to update notification setting:', error)
    }
  }, [api, isCurrentApi])

  const handleProjectTrustChange = useCallback(async (decision: boolean | null): Promise<void> => {
    if (!api || !cwd || agentBusy || statusPhase === 'starting') return
    await saveProjectTrust(() => updateProjectTrust(cwd, decision), setProjectTrust)
  }, [agentBusy, api, cwd, saveProjectTrust, statusPhase, updateProjectTrust])

  const handleToolPermissionChange = useCallback(async (
    category: ToolPermissionCategory,
    decision: ToolPermissionDecision
  ): Promise<void> => {
    if (!api || !cwd) return
    const updates: Partial<ToolPermissionRules> = { [category]: decision }
    await saveToolPermission(() => api.setToolPermissionPolicy(cwd, updates), setToolPermissionPolicy)
  }, [api, cwd, saveToolPermission])

  const handleToolPermissionReset = useCallback(async (): Promise<void> => {
    if (!api || !cwd) return
    await saveToolPermission(() => api.setToolPermissionPolicy(cwd, null), setToolPermissionPolicy)
  }, [api, cwd, saveToolPermission])

  const handleToolPermissionResolve = useCallback(async (
    id: string,
    resolution: ToolPermissionResolution
  ): Promise<void> => {
    const request = toolPermissionRequests.find((item) => item.id === id)
    const owner = scopeRef.current
    if (!api || !isCurrentApi() || toolPermissionRequestsOwner.current !== apiOwner || !request
      || !isSessionInteractionRequest(request, owner.cwd, owner.sessionPath)) return
    await toolPermissionResolutions.resolve(id, async () => {
      try {
        await api.resolveToolPermission(id, resolution)
      } catch (error) {
        if (!isCurrentApi()) return
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('已结束') || message.includes('已关闭')) {
          setToolPermissionRequests((current) => current.filter((item) => item.id !== id))
        }
        throw error
      }
      if (!isCurrentApi()) return
      setToolPermissionRequests((current) => current.filter((item) => item.id !== id))
      if (scopeRef.current !== owner || !owner.cwd) return
      const revision = permissionSaveSlot.revision
      try {
        const policy = await api.getToolPermissionPolicy(owner.cwd)
        if (scopeRef.current === owner && isCurrentApi() && permissionSaveSlot.revision === revision) setToolPermissionPolicy(policy)
      } catch (error) {
        if (scopeRef.current === owner && isCurrentApi() && permissionSaveSlot.revision === revision) throw error
      }
    })
  }, [api, apiOwner, isCurrentApi, toolPermissionRequests, toolPermissionResolutions.resolve])

  const handleExtensionUiResolve = useCallback(async (
    id: string,
    response: ExtensionUiResponse
  ): Promise<void> => {
    const request = extensionUiRequests.find((item) => item.id === id)
    const owner = scopeRef.current
    if (!api || !isCurrentApi() || extensionUiRequestsOwner.current !== apiOwner || !request || (request.scope !== 'global'
      && !isSessionInteractionRequest(request, owner.cwd, owner.sessionPath))) return
    await extensionUiResolutions.resolve(id, async () => {
      try {
        await api.resolveExtensionUiRequest(id, response)
        if (isCurrentApi()) setExtensionUiRequests((current) => current.filter((item) => item.id !== id))
      } catch (error) {
        if (!isCurrentApi()) return
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('已结束') || message.includes('已关闭')) {
          setExtensionUiRequests((current) => current.filter((item) => item.id !== id))
        }
        throw error
      }
    })
  }, [api, apiOwner, isCurrentApi, extensionUiRequests, extensionUiResolutions.resolve])

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
