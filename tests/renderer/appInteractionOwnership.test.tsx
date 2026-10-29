// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppInteractionState } from '../../src/renderer/src/hooks/useAppInteractionState'
import type {
  ExtensionUiRequest, ModelProviderAuthState, ProjectToolPermissionPolicy, ProjectTrustInfo,
  ToolPermissionRequest, ToolPermissionRules
} from '../../src/shared/types'

interface Scope { cwd: string; sessionPath: string }
const A: Scope = { cwd: '/project/a', sessionPath: '/sessions/a.jsonl' }
const B: Scope = { ...A, sessionPath: '/sessions/b.jsonl' }
const other: Scope = { cwd: '/project/b', sessionPath: '/sessions/c.jsonl' }
const trust = (cwd: string, source: ProjectTrustInfo['source'] = 'default'): ProjectTrustInfo => ({
  cwd, requiresTrust: true, decision: source === 'saved' ? 'trusted' : 'ask', source
})
const policy = (cwd: string, source: ProjectToolPermissionPolicy['source'] = 'default'): ProjectToolPermissionPolicy => ({
  cwd, source, rules: { read: 'ask', write: 'ask', shell: 'ask', network: 'ask', external: 'ask' }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function bridge() {
  let permissionListener: (requests: ToolPermissionRequest[]) => void = () => {}
  let uiListener: (requests: ExtensionUiRequest[]) => void = () => {}
  let authListener: (state: ModelProviderAuthState | null) => void = () => {}
  const off = vi.fn()
  const api = {
    getCompletionNotificationsEnabled: vi.fn(async () => true),
    setCompletionNotificationsEnabled: vi.fn(async (_enabled: boolean) => {}),
    getProjectTrust: vi.fn(async (cwd: string) => trust(cwd)),
    setProjectTrust: vi.fn(async (cwd: string, _decision: boolean | null) => trust(cwd, 'saved')),
    getToolPermissionPolicy: vi.fn(async (cwd: string) => policy(cwd)),
    setToolPermissionPolicy: vi.fn(async (cwd: string, _rules: Partial<ToolPermissionRules> | null) => policy(cwd, 'saved')),
    getPendingToolPermissionRequests: vi.fn(async (): Promise<ToolPermissionRequest[]> => []),
    getPendingExtensionUiRequests: vi.fn(async (): Promise<ExtensionUiRequest[]> => []),
    onToolPermissionRequests: vi.fn((listener: typeof permissionListener) => { permissionListener = listener; return off }),
    onExtensionUiRequests: vi.fn((listener: typeof uiListener) => { uiListener = listener; return off }),
    getModelProviderAuthState: vi.fn(async (): Promise<ModelProviderAuthState | null> => null),
    onModelProviderAuthState: vi.fn((listener: typeof authListener) => { authListener = listener; return off }),
    resolveToolPermission: vi.fn(async () => {}),
    resolveExtensionUiRequest: vi.fn(async () => {})
  }
  vi.stubGlobal('pion', api)
  return { api, off, pushPermissions: (requests: ToolPermissionRequest[]) => permissionListener(requests),
    pushUi: (requests: ExtensionUiRequest[]) => uiListener(requests),
    pushAuth: (state: ModelProviderAuthState | null) => authListener(state) }
}
function renderInteractions() {
  return renderHook((scope: Scope) => {
    const api = window.pion
    return useAppInteractionState({ ...scope, hasBridge: true, policyEnabled: true, agentBusy: false,
      statusPhase: 'ready', updateProjectTrust: (cwd, decision) => api.setProjectTrust(cwd, decision) })
  }, { initialProps: A })
}
type State = ReturnType<typeof useAppInteractionState>
type SaveKind = 'trust' | 'change' | 'reset'
function save(state: State, kind: SaveKind) {
  if (kind === 'trust') return state.handleProjectTrustChange(true)
  if (kind === 'reset') return state.handleToolPermissionReset()
  return state.handleToolPermissionChange('shell', 'deny')
}
const busy = (state: State, kind: SaveKind) => kind === 'trust' ? state.projectTrustBusy : state.toolPermissionBusy
const error = (state: State, kind: SaveKind) => kind === 'trust' ? state.projectTrustError : state.toolPermissionError
const source = (state: State, kind: SaveKind) => kind === 'trust' ? state.projectTrust?.source : state.toolPermissionPolicy?.source
function delaySave(api: ReturnType<typeof bridge>['api'], kind: SaveKind) {
  const trustRpc = deferred<ProjectTrustInfo>(), policyRpc = deferred<ProjectToolPermissionPolicy>()
  if (kind === 'trust') api.setProjectTrust.mockReturnValueOnce(trustRpc.promise)
  else api.setToolPermissionPolicy.mockReturnValueOnce(policyRpc.promise)
  return {
    calls: () => kind === 'trust' ? api.setProjectTrust.mock.calls.length : api.setToolPermissionPolicy.mock.calls.length,
    resolve: () => kind === 'trust' ? trustRpc.resolve(trust(A.cwd, 'saved')) : policyRpc.resolve(policy(A.cwd, 'saved')),
    reject: () => kind === 'trust' ? trustRpc.reject(new Error('old save failed')) : policyRpc.reject(new Error('old save failed'))
  }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('app interaction save ownership', () => {
  it.each<SaveKind>(['trust', 'change', 'reset'])('retains the real %s save slot across cwd A-B-A without publishing late success', async (kind) => {
    const h = bridge(), pending = delaySave(h.api, kind)
    const { result, rerender } = renderInteractions()
    await act(async () => {})
    let saving!: Promise<void>
    act(() => {
      const selected = result.current
      saving = save(selected, kind)
      void save(selected, kind)
      if (kind !== 'trust') void selected.handleToolPermissionReset()
    })
    expect(pending.calls()).toBe(1)
    expect(busy(result.current, kind)).toBe(true)
    await act(async () => rerender(other))
    expect(result.current.projectTrust?.cwd).toBe(other.cwd)
    expect(busy(result.current, kind)).toBe(false)
    await act(async () => { await save(result.current, kind) })
    expect(pending.calls()).toBe(1)
    await act(async () => rerender(A))
    await act(async () => { pending.resolve(); await saving })
    expect(source(result.current, kind)).toBe('default')
    expect(error(result.current, kind)).toBe('')
    expect(busy(result.current, kind)).toBe(false)
    await act(async () => { await save(result.current, kind) })
    expect(pending.calls()).toBe(2)
    expect(source(result.current, kind)).toBe('saved')
  })

  it.each<SaveKind>(['trust', 'change', 'reset'])('retires %s errors and callbacks across same-cwd session A-B-A', async (kind) => {
    const h = bridge(), pending = delaySave(h.api, kind)
    const { result, rerender } = renderInteractions()
    await act(async () => {})
    const old = result.current
    let saving!: Promise<void>
    act(() => { saving = save(old, kind) })
    await act(async () => rerender(B))
    expect(busy(result.current, kind)).toBe(false)
    await act(async () => rerender(A))
    await act(async () => { pending.reject(); await saving })
    expect(error(result.current, kind)).toBe('')
    await act(async () => { await save(old, kind) })
    expect(pending.calls()).toBe(1)
    if (kind === 'trust') h.api.setProjectTrust.mockRejectedValueOnce(new Error('current save failed'))
    else h.api.setToolPermissionPolicy.mockRejectedValueOnce(new Error('current save failed'))
    await act(async () => { await save(result.current, kind) })
    expect(error(result.current, kind)).toBe('current save failed')
    expect(busy(result.current, kind)).toBe(false)
    await act(async () => rerender(B))
    expect(error(result.current, kind)).toBe('')
  })

  it.each<SaveKind>(['trust', 'change', 'reset'])('retains the actual %s save Promise across hook unmounts', async (kind) => {
    const h = bridge(), pending = delaySave(h.api, kind)
    const first = renderInteractions()
    await act(async () => {})
    let saving!: Promise<void>
    act(() => { saving = save(first.result.current, kind) })
    first.unmount()
    const reopened = renderInteractions()
    await act(async () => { await save(reopened.result.current, kind) })
    expect(pending.calls()).toBe(1)
    await act(async () => { pending.reject(); await saving })
    expect(error(reopened.result.current, kind)).toBe('')
    expect(source(reopened.result.current, kind)).toBe('default')
    await act(async () => { await save(reopened.result.current, kind) })
    expect(pending.calls()).toBe(2)
    expect(source(reopened.result.current, kind)).toBe('saved')
  })

  it.each<SaveKind>(['trust', 'change', 'reset'])('keeps the latest %s save when an earlier initial policy read arrives', async (kind) => {
    const h = bridge(), trustRead = deferred<ProjectTrustInfo>(), permissionRead = deferred<ProjectToolPermissionPolicy>()
    h.api.getProjectTrust.mockReturnValueOnce(trustRead.promise)
    h.api.getToolPermissionPolicy.mockReturnValueOnce(permissionRead.promise)
    const selected = renderInteractions()
    await act(async () => { await save(selected.result.current, kind) })
    expect(source(selected.result.current, kind)).toBe('saved')
    await act(async () => { trustRead.resolve(trust(A.cwd)); permissionRead.resolve(policy(A.cwd)) })
    expect(source(selected.result.current, kind)).toBe('saved')
    expect(error(selected.result.current, kind)).toBe('')
  })

  it('keeps the latest notification choice over late initial reads and older writes', async () => {
    const h = bridge(), initial = deferred<boolean>(), first = deferred<void>(), last = deferred<void>()
    h.api.getCompletionNotificationsEnabled.mockReturnValueOnce(initial.promise)
    h.api.setCompletionNotificationsEnabled.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    const selected = renderInteractions()
    let savingFirst!: Promise<void>, savingLast!: Promise<void>
    act(() => {
      savingFirst = selected.result.current.handleCompletionNotificationsChange(true)
      savingLast = selected.result.current.handleCompletionNotificationsChange(false)
    })
    await act(async () => { last.resolve(); await savingLast })
    expect(selected.result.current.completionNotificationsEnabled).toBe(false)
    await act(async () => { initial.resolve(true); first.resolve(); await savingFirst })
    expect(selected.result.current.completionNotificationsEnabled).toBe(false)
  })

  it('keeps a current auth push over its earlier initial snapshot', async () => {
    const h = bridge(), initial = deferred<ModelProviderAuthState | null>()
    h.api.getModelProviderAuthState.mockReturnValueOnce(initial.promise)
    const selected = renderInteractions()
    const current: ModelProviderAuthState = { operationId: 'current-auth', providerId: 'mock', providerName: 'Mock',
      authType: 'oauth', phase: 'waiting', message: 'current', startedAt: 1 }
    act(() => h.pushAuth(current))
    await act(async () => { initial.resolve(null) })
    expect(selected.result.current.modelProviderAuthState).toBe(current)
  })

  it('observes actual API replacement with hasBridge unchanged and retires API A-B-A saves, reads and pushes', async () => {
    const first = bridge()
    const trustSave = delaySave(first.api, 'trust'), policySave = delaySave(first.api, 'reset')
    const notificationRead = deferred<boolean>(), notificationSave = deferred<void>()
    const authRead = deferred<ModelProviderAuthState | null>()
    const permissionsRead = deferred<ToolPermissionRequest[]>(), uiRead = deferred<ExtensionUiRequest[]>()
    first.api.getCompletionNotificationsEnabled.mockReturnValueOnce(notificationRead.promise)
    first.api.setCompletionNotificationsEnabled.mockReturnValueOnce(notificationSave.promise)
    first.api.getModelProviderAuthState.mockReturnValueOnce(authRead.promise)
    first.api.getPendingToolPermissionRequests.mockReturnValueOnce(permissionsRead.promise)
    first.api.getPendingExtensionUiRequests.mockReturnValueOnce(uiRead.promise)
    const { result, rerender } = renderInteractions()
    await act(async () => {})
    const old = result.current
    let savingTrust!: Promise<void>, savingPolicy!: Promise<void>, savingNotification!: Promise<void>
    act(() => {
      savingTrust = save(old, 'trust')
      savingPolicy = save(old, 'reset')
      savingNotification = old.handleCompletionNotificationsChange(false)
    })
    const second = bridge()
    await act(async () => rerender(A))
    expect(first.off).toHaveBeenCalledTimes(3)
    expect(second.api.getProjectTrust).toHaveBeenCalledWith(A.cwd)
    expect(second.api.onToolPermissionRequests).toHaveBeenCalledTimes(1)
    expect(result.current.projectTrustBusy).toBe(false)
    expect(result.current.toolPermissionBusy).toBe(false)
    await act(async () => {
      await save(result.current, 'trust')
      await save(result.current, 'change')
    })
    expect(second.api.setProjectTrust).not.toHaveBeenCalled()
    expect(second.api.setToolPermissionPolicy).not.toHaveBeenCalled()
    vi.stubGlobal('pion', first.api)
    await act(async () => rerender(A))
    expect(second.off).toHaveBeenCalledTimes(3)
    const staleUi: ExtensionUiRequest = { id: 'old-ui', ...A, method: 'editor', title: 'old',
      scope: 'workspace', createdAt: 1, timeoutAt: null }
    const stalePermission: ToolPermissionRequest = { id: 'old-permission', ...A, toolName: 'bash', category: 'shell',
      policyCategories: ['shell'], summary: 'old', detail: '', risks: [], canRemember: false, createdAt: 1, timeoutAt: 60_000 }
    const staleAuth: ModelProviderAuthState = { operationId: 'old-auth', providerId: 'mock', providerName: 'Mock',
      authType: 'oauth', phase: 'waiting', message: 'old', startedAt: 1 }
    await act(async () => {
      notificationRead.resolve(false)
      notificationSave.resolve()
      authRead.resolve(staleAuth)
      permissionsRead.resolve([stalePermission])
      uiRead.resolve([staleUi])
      second.pushUi([staleUi])
      second.pushPermissions([stalePermission])
      second.pushAuth(staleAuth)
      trustSave.resolve()
      policySave.reject()
      await Promise.all([savingTrust, savingPolicy, savingNotification])
    })
    expect(result.current.projectTrust).toEqual(trust(A.cwd))
    expect(result.current.toolPermissionPolicy).toEqual(policy(A.cwd))
    expect(result.current.projectTrustError).toBe('')
    expect(result.current.toolPermissionError).toBe('')
    expect(result.current.completionNotificationsEnabled).toBe(true)
    expect(result.current.extensionUiRequests).toEqual([])
    expect(result.current.toolPermissionRequests).toEqual([])
    expect(result.current.modelProviderAuthState).toBeNull()
    await act(async () => {
      await save(old, 'trust')
      await save(old, 'reset')
      await old.handleCompletionNotificationsChange(false)
    })
    expect(trustSave.calls()).toBe(1)
    expect(policySave.calls()).toBe(1)
    expect(first.api.setCompletionNotificationsEnabled).toHaveBeenCalledTimes(1)
  })
})
