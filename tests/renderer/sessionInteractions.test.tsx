// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSessionInteractionRequest, useAppInteractionState } from '../../src/renderer/src/hooks/useAppInteractionState'
import type {
  ExtensionUiRequest, ExtensionUiResponse, ProjectToolPermissionPolicy, ProjectTrustInfo,
  ToolPermissionRequest, ToolPermissionResolution
} from '../../src/shared/types'

interface Scope { cwd: string; sessionPath?: string }
const A: Scope = { cwd: '/worktree/a', sessionPath: '/sessions/a.jsonl' }
const B: Scope = { cwd: A.cwd, sessionPath: '/sessions/b.jsonl' }
const other: Scope = { cwd: '/worktree/b', sessionPath: B.sessionPath }
const trust = (cwd: string): ProjectTrustInfo => ({ cwd, requiresTrust: false, decision: 'trusted', source: 'not-required' })
const policy = (cwd: string): ProjectToolPermissionPolicy => ({
  cwd, source: 'default', rules: { read: 'ask', write: 'ask', shell: 'ask', network: 'ask', external: 'ask' }
})
const question = (id: string, scope = A): ExtensionUiRequest => ({
  id, ...scope, method: 'editor', title: id, scope: 'workspace', createdAt: 1, timeoutAt: null
})
const permission = (id: string, scope = A): ToolPermissionRequest => ({
  id, ...scope, toolName: 'bash', category: 'shell', policyCategories: ['shell'], summary: id,
  detail: '', risks: [], canRemember: false, createdAt: 1, timeoutAt: 60_000
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function bridge() {
  let permissions: (requests: ToolPermissionRequest[]) => void = () => {}
  let questions: (requests: ExtensionUiRequest[]) => void = () => {}
  const off = vi.fn()
  const api = {
    getCompletionNotificationsEnabled: vi.fn(async () => true),
    getProjectTrust: vi.fn(async (cwd: string) => trust(cwd)),
    getToolPermissionPolicy: vi.fn(async (cwd: string) => policy(cwd)),
    getPendingToolPermissionRequests: vi.fn(async (): Promise<ToolPermissionRequest[]> => []),
    getPendingExtensionUiRequests: vi.fn(async (): Promise<ExtensionUiRequest[]> => []),
    onToolPermissionRequests: vi.fn((listener: typeof permissions) => { permissions = listener; return off }),
    onExtensionUiRequests: vi.fn((listener: typeof questions) => { questions = listener; return off }),
    getModelProviderAuthState: vi.fn(async () => null),
    onModelProviderAuthState: vi.fn(() => off),
    resolveToolPermission: vi.fn(async (_id: string, _resolution: ToolPermissionResolution) => {}),
    resolveExtensionUiRequest: vi.fn(async (_id: string, _response: ExtensionUiResponse) => {})
  }
  vi.stubGlobal('pion', api)
  return { api, off, pushPermissions: (value: ToolPermissionRequest[]) => permissions(value),
    pushQuestions: (value: ExtensionUiRequest[]) => questions(value) }
}
function renderInteractions(scope = A) {
  return renderHook((current: Scope) => useAppInteractionState({
    ...current, hasBridge: true, policyEnabled: true, agentBusy: false,
    statusPhase: 'ready', updateProjectTrust: async (cwd) => trust(cwd)
  }), { initialProps: scope })
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('session interactions', () => {
  it('matches exact cwd/path, resolves the visible request by id behind A, and keeps auth global', async () => {
    const qA = question('q-a'), qB = question('q-b', B)
    const pA = permission('p-a'), pB = permission('p-b', B)
    const missing = { cwd: A.cwd }
    const auth: ExtensionUiRequest = { ...question('auth', other), scope: 'global', source: 'provider-auth' }
    for (const [request, cwd, path, expected] of [
      [qA, A.cwd, A.sessionPath, true], [qA, `${A.cwd}/`, A.sessionPath, false],
      [qA, A.cwd, B.sessionPath, false], [qA, other.cwd, A.sessionPath, false],
      [qA, undefined, A.sessionPath, false], [question('new', missing), A.cwd, A.sessionPath, false],
      [question('new', missing), A.cwd, undefined, true],
      [{ ...qA, scope: 'global' as const }, A.cwd, A.sessionPath, false]
    ] as const) expect(isSessionInteractionRequest(request, cwd, path)).toBe(expected)

    const h = bridge()
    const { result, rerender } = renderInteractions()
    await act(async () => {
      h.pushQuestions([qA, qB, question('q-new', missing), question('q-other', other), auth])
      h.pushPermissions([pA, pB, permission('p-new', missing), permission('p-other', other)])
    })
    const old = result.current
    rerender(B)
    await act(async () => {
      await old.handleExtensionUiResolve(qA.id, { value: 'stale A' })
      await old.handleToolPermissionResolve(pA.id, 'allow-once')
      for (const id of ['q-new', 'q-other']) await result.current.handleExtensionUiResolve(id, { value: 'wrong scope' })
      for (const id of ['p-new', 'p-other']) await result.current.handleToolPermissionResolve(id, 'allow-once')
    })
    expect(h.api.resolveExtensionUiRequest).not.toHaveBeenCalled()
    expect(h.api.resolveToolPermission).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.handleExtensionUiResolve(qB.id, { value: 'B answer' })
      await result.current.handleToolPermissionResolve(pB.id, 'allow-once')
      await result.current.handleExtensionUiResolve(auth.id, { cancelled: true })
    })
    expect(h.api.resolveExtensionUiRequest.mock.calls).toEqual([[qB.id, { value: 'B answer' }], [auth.id, { cancelled: true }]])
    expect(h.api.resolveToolPermission.mock.calls).toEqual([[pB.id, 'allow-once']])
    expect(result.current.extensionUiRequests[0]).toBe(qA)
    expect(result.current.toolPermissionRequests[0]).toBe(pA)
    rerender(missing)
    await act(async () => {
      await result.current.handleExtensionUiResolve('q-new', { value: 'new session' })
      await result.current.handleToolPermissionResolve('p-new', 'deny')
    })
    expect(h.api.resolveExtensionUiRequest).toHaveBeenLastCalledWith('q-new', { value: 'new session' })
    expect(h.api.resolveToolPermission).toHaveBeenLastCalledWith('p-new', 'deny')
  })

  it('does not let late initial queries replace either pushed requests or a pushed empty list', async () => {
    for (const empty of [false, true]) {
      const h = bridge()
      const initialQuestions = deferred<ExtensionUiRequest[]>(), initialPermissions = deferred<ToolPermissionRequest[]>()
      h.api.getPendingExtensionUiRequests.mockReturnValueOnce(initialQuestions.promise)
      h.api.getPendingToolPermissionRequests.mockReturnValueOnce(initialPermissions.promise)
      const { result, unmount } = renderInteractions()
      const questions = empty ? [] : [question('pushed')], permissions = empty ? [] : [permission('pushed')]
      act(() => { h.pushQuestions(questions); h.pushPermissions(permissions) })
      await act(async () => {
        initialQuestions.resolve([question('stale')])
        initialPermissions.resolve([permission('stale')])
      })
      expect(result.current.extensionUiRequests).toEqual(questions)
      expect(result.current.toolPermissionRequests).toEqual(permissions)
      unmount()
      expect(h.off).toHaveBeenCalledTimes(3)
    }
  })

  it('deduplicates real per-request RPCs across selection changes and fences errors and policy refreshes', async () => {
    const h = bridge()
    const questionRpc = deferred<void>(), permissionRpc = deferred<void>()
    h.api.resolveExtensionUiRequest.mockReturnValueOnce(questionRpc.promise)
    h.api.resolveToolPermission.mockReturnValueOnce(permissionRpc.promise)
    const { result, rerender } = renderInteractions()
    await act(async () => {
      h.pushQuestions([question('q-a'), question('q-b', B)])
      h.pushPermissions([permission('p-a'), permission('p-b', B)])
    })
    let answerA!: Promise<void>, approveA!: Promise<void>
    act(() => {
      answerA = result.current.handleExtensionUiResolve('q-a', { value: 'A' })
      approveA = result.current.handleToolPermissionResolve('p-a', 'allow-once')
      void result.current.handleExtensionUiResolve('q-a', { cancelled: true })
      void result.current.handleToolPermissionResolve('p-a', 'deny')
    })
    expect(h.api.resolveExtensionUiRequest).toHaveBeenCalledTimes(1)
    expect(h.api.resolveToolPermission).toHaveBeenCalledTimes(1)
    rerender(B)
    expect(result.current.extensionUiResolutions.get('q-a')?.busy).toBe(true)
    expect(result.current.toolPermissionResolutions.get('p-a')?.busy).toBe(true)
    await act(async () => {
      await result.current.handleExtensionUiResolve('q-b', { value: 'B' })
      await result.current.handleToolPermissionResolve('p-b', 'allow-once')
    })
    expect(h.api.resolveExtensionUiRequest.mock.calls).toEqual([['q-a', { value: 'A' }], ['q-b', { value: 'B' }]])
    expect(h.api.resolveToolPermission.mock.calls).toEqual([['p-a', 'allow-once'], ['p-b', 'allow-once']])
    await act(async () => {
      questionRpc.reject(new Error('A answer failed'))
      permissionRpc.reject(new Error('A permission failed'))
      await Promise.all([answerA, approveA])
    })
    expect([...result.current.extensionUiResolutions]).toEqual([['q-a', { busy: false, error: 'A answer failed' }]])
    expect([...result.current.toolPermissionResolutions]).toEqual([['p-a', { busy: false, error: 'A permission failed' }]])
    expect(result.current.toolPermissionError).toBe('')
    expect(result.current.extensionUiRequests.map((request) => request.id)).toEqual(['q-a'])
    expect(result.current.toolPermissionRequests.map((request) => request.id)).toEqual(['p-a'])

    await act(async () => rerender(A))
    const refresh = deferred<ProjectToolPermissionPolicy>()
    h.api.getToolPermissionPolicy.mockReturnValueOnce(refresh.promise)
    let retryA!: Promise<void>
    await act(async () => { retryA = result.current.handleToolPermissionResolve('p-a', 'allow-once') })
    expect(h.api.getToolPermissionPolicy).toHaveBeenLastCalledWith(A.cwd)
    expect(result.current.toolPermissionResolutions.get('p-a')?.busy).toBe(true)
    await act(async () => rerender(other))
    expect(result.current.toolPermissionPolicy).toEqual(policy(other.cwd))
    expect(result.current.toolPermissionResolutions.get('p-a')?.busy).toBe(true)
    await act(async () => { refresh.resolve({ ...policy(A.cwd), source: 'saved' }); await retryA })
    expect(result.current.toolPermissionPolicy).toEqual(policy(other.cwd))
    expect(result.current.toolPermissionResolutions.has('p-a')).toBe(false)
  })
})
