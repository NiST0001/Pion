// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentModelActions } from '../../src/renderer/src/hooks/agent/useAgentModelActions'
import { ModelsPage } from '../../src/renderer/src/features/settings/ModelsPage'
import type { ModelProviderInfo, PionApi } from '../../src/shared/types'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const provider: ModelProviderInfo = {
  id: 'openai-codex', name: 'OpenAI Codex', modelCount: 7, configured: true,
  configuredSource: 'stored', configuredLabel: 'Pi 凭据', storedCredentialType: 'oauth',
  authMethods: [{ type: 'oauth', name: 'ChatGPT', interactive: true, subscription: true }]
}

function harness() {
  // A narrow API mock, not a complete preload or SDK implementation.
  const api = {
    setModelProviderEnabled: vi.fn<PionApi['setModelProviderEnabled']>(),
    setModel: vi.fn<PionApi['setModel']>().mockResolvedValue(undefined),
    loginModelProvider: vi.fn<PionApi['loginModelProvider']>(),
    logoutModelProvider: vi.fn<PionApi['logoutModelProvider']>(),
    addModelProvider: vi.fn<PionApi['addModelProvider']>()
  } satisfies Pick<PionApi, 'setModelProviderEnabled' | 'setModel' | 'loginModelProvider' | 'logoutModelProvider' | 'addModelProvider'>
  const refreshModels = vi.fn(async (): Promise<void> => undefined)
  const dispatch = vi.fn()
  const hook = renderHook(() => useAgentModelActions({ api: api as unknown as PionApi, refreshModels, dispatch }))
  return { api, refreshModels, dispatch, ...hook }
}

function expectNoMutation(h: ReturnType<typeof harness>) {
  expect(h.api.setModel).not.toHaveBeenCalled()
  expect(h.api.loginModelProvider).not.toHaveBeenCalled()
  expect(h.api.logoutModelProvider).not.toHaveBeenCalled()
  expect(h.api.addModelProvider).not.toHaveBeenCalled()
  expect(h.dispatch).not.toHaveBeenCalled()
}

describe('provider display actions', () => {
  it.each([false, true])('forwards the exact %s boolean and returns unchanged catalog/auth metadata after one refresh', async (enabled) => {
    const h = harness()
    const catalog = [{ ...provider, enabled }]
    h.api.setModelProviderEnabled.mockResolvedValue(catalog)
    h.refreshModels.mockImplementation(async () => {
      expect(h.api.setModelProviderEnabled).toHaveBeenCalledExactlyOnceWith(provider.id, enabled)
    })
    await expect(h.result.current.setModelProviderEnabled(provider.id, enabled)).resolves.toBe(catalog)
    expect(catalog[0]).toEqual({ ...provider, enabled })
    expect(catalog[0].authMethods).toBe(provider.authMethods)
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expectNoMutation(h)
  })

  it('waits for the saved catalog and then for refresh, without selecting a fallback model', async () => {
    const h = harness()
    const saved = deferred<ModelProviderInfo[]>()
    const refreshed = deferred<void>()
    const catalog = [{ ...provider, enabled: false }]
    h.api.setModelProviderEnabled.mockReturnValue(saved.promise)
    h.refreshModels.mockReturnValue(refreshed.promise)
    let settled = false
    const action = h.result.current.setModelProviderEnabled(provider.id, false).then((result) => {
      settled = true
      return result
    })
    expect(h.refreshModels).not.toHaveBeenCalled()
    saved.resolve(catalog)
    await saved.promise
    await Promise.resolve()
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    expectNoMutation(h)
    refreshed.resolve()
    await expect(action).resolves.toBe(catalog)
    expect(settled).toBe(true)
    expectNoMutation(h)
  })

  it('propagates backend failure without refresh, model selection or auth/config mutation', async () => {
    const h = harness()
    const error = new Error('显示设置保存失败')
    h.api.setModelProviderEnabled.mockRejectedValue(error)
    await expect(h.result.current.setModelProviderEnabled(provider.id, false)).rejects.toBe(error)
    expect(h.refreshModels).not.toHaveBeenCalled()
    expectNoMutation(h)
  })

  it('propagates refresh failure without retrying a committed visibility save', async () => {
    const h = harness()
    h.api.setModelProviderEnabled.mockResolvedValue([{ ...provider, enabled: false }])
    const error = new Error('刷新模型失败')
    h.refreshModels.mockRejectedValue(error)
    await expect(h.result.current.setModelProviderEnabled(provider.id, false)).rejects.toBe(error)
    expect(h.api.setModelProviderEnabled).toHaveBeenCalledExactlyOnceWith(provider.id, false)
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expectNoMutation(h)
  })

  it('rejects a missing preload before refresh or dispatch', async () => {
    const refreshModels = vi.fn(async () => undefined)
    const dispatch = vi.fn()
    const { result } = renderHook(() => useAgentModelActions({ api: undefined, refreshModels, dispatch }))
    await expect(result.current.setModelProviderEnabled(provider.id, false)).rejects.toThrow('preload 桥未加载')
    expect(refreshModels).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    // Preserve the existing setModel missing-bridge behavior.
    await expect(result.current.setModel(provider.id, 'gpt-5')).resolves.toBeUndefined()
    expect(refreshModels).not.toHaveBeenCalled()
  })

  it('preserves explicit ordinary setModel selection and refresh independently of visibility', async () => {
    const h = harness()
    await h.result.current.setModel('other-provider', 'explicit-model')
    expect(h.api.setModel).toHaveBeenCalledExactlyOnceWith('other-provider', 'explicit-model')
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expect(h.api.setModelProviderEnabled).not.toHaveBeenCalled()
    expect(h.api.loginModelProvider).not.toHaveBeenCalled()
    expect(h.api.logoutModelProvider).not.toHaveBeenCalled()
    expect(h.api.addModelProvider).not.toHaveBeenCalled()
  })
})

type PageProps = ComponentProps<typeof ModelsPage>
function pageProps(overrides: Partial<PageProps> = {}): PageProps {
  return {
    models: [], groups: [], session: null, busyKey: '', error: '', agentBusy: false,
    providerAuthState: null, onSelect: vi.fn(), onListProviders: vi.fn(async () => [provider]),
    onSetProviderEnabled: vi.fn(async (_id: string, enabled: boolean) => [{ ...provider, enabled }]),
    onLoginProvider: vi.fn(async () => [provider]), onLogoutProvider: vi.fn(async () => [provider]),
    onCancelProviderAuth: vi.fn(async () => undefined), onOpenProviderAuthUrl: vi.fn(async () => undefined),
    onAddProvider: vi.fn(async () => undefined), ...overrides
  }
}
const switchName = '显示 OpenAI Codex 的模型'

describe('ModelsPage display response ownership', () => {
  it('keeps both compact and directory switches synchronized without ambiguous single-role queries', async () => {
    const props = pageProps()
    render(<ModelsPage {...props} />)
    await screen.findByRole('switch', { name: switchName })
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    expect(screen.getAllByRole('switch', { name: switchName })).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('switch', { name: switchName })[1])
    await waitFor(() => {
      for (const control of screen.getAllByRole('switch', { name: switchName })) {
        expect(control).toHaveAttribute('aria-checked', 'false')
      }
    })
    expect(props.onSetProviderEnabled).toHaveBeenCalledExactlyOnceWith(provider.id, false)
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onLoginProvider).not.toHaveBeenCalled()
    expect(props.onLogoutProvider).not.toHaveBeenCalled()
    expect(props.onAddProvider).not.toHaveBeenCalled()
  })

  it('does not apply a pending response to a newly mounted page owner', async () => {
    const pending = deferred<ModelProviderInfo[]>()
    const old = pageProps({ onSetProviderEnabled: vi.fn(() => pending.promise) })
    const view = render(<ModelsPage key="old-owner" {...old} />)
    fireEvent.click(await screen.findByRole('switch', { name: switchName }))
    const next = pageProps()
    view.rerender(<ModelsPage key="new-owner" {...next} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: switchName })).toHaveAttribute('aria-checked', 'true'))
    await act(async () => { pending.resolve([{ ...provider, enabled: false }]); await pending.promise })
    expect(screen.getByRole('switch', { name: switchName })).toHaveAttribute('aria-checked', 'true')
    expect(next.onSetProviderEnabled).not.toHaveBeenCalled()
  })

  it('invalidates an old pending response when the catalog/action owner changes without remounting', async () => {
    const pending = deferred<ModelProviderInfo[]>()
    const old = pageProps({ onSetProviderEnabled: vi.fn(() => pending.promise) })
    const view = render(<ModelsPage {...old} />)
    fireEvent.click(await screen.findByRole('switch', { name: switchName }))
    const next = pageProps()
    view.rerender(<ModelsPage {...next} />)
    await act(async () => { pending.resolve([{ ...provider, enabled: false }]); await pending.promise })
    // A new callback owner must get a fresh catalog; old pending data must not
    // overwrite it or leave the newly installed callback permanently unread.
    await waitFor(() => expect(next.onListProviders).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('switch', { name: switchName })).toHaveAttribute('aria-checked', 'true')
    expect(next.onSetProviderEnabled).not.toHaveBeenCalled()
  })
})
