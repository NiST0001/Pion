// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/renderer/src/features/settings/SettingsModal'
import type { SettingsActions } from '../../src/renderer/src/features/settings/SettingsModal'
import type { ModelProviderAuthState, ModelProviderInfo } from '../../src/shared/types'

function settingsActions(
  addModelProvider = vi.fn(async () => undefined),
  providers: ModelProviderInfo[] = []
): SettingsActions {
  return {
    setModel: vi.fn(async () => undefined),
    listModelProviders: vi.fn(async () => providers),
    loginModelProvider: vi.fn(async () => providers),
    logoutModelProvider: vi.fn(async () => providers),
    cancelModelProviderAuth: vi.fn(async () => undefined),
    openModelProviderAuthUrl: vi.fn(async () => undefined),
    addModelProvider,
    setAutoCompaction: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    compactNow: vi.fn(async () => undefined),
    exportSessionHtml: vi.fn(async () => '/tmp/session.html'),
    renameSession: vi.fn(async () => undefined),
    setSteeringMode: vi.fn(async () => undefined),
    setFollowUpMode: vi.fn(async () => undefined)
  }
}

function renderSettings(
  actions: SettingsActions,
  agentBusy = false,
  modelProviderAuthState: ModelProviderAuthState | null = null
): void {
  render(
    <SettingsModal
      open
      session={null}
      models={[]}
      modelProviderAuthState={modelProviderAuthState}
      agentBusy={agentBusy}
      completionNotificationsEnabled
      onCompletionNotificationsChange={vi.fn()}
      sessionPreviewDensity="compact"
      onSessionPreviewDensityChange={vi.fn()}
      historyNavGap={10}
      onHistoryNavGapChange={vi.fn()}
      historyNavMaxVisible={40}
      onHistoryNavMaxVisibleChange={vi.fn()}
      showMetricDuration
      showMetricCost={false}
      onMetricDurationChange={vi.fn()}
      onMetricCostChange={vi.fn()}
      projectTrust={null}
      projectTrustBusy={false}
      projectTrustError=""
      onProjectTrustChange={vi.fn()}
      toolPermissionPolicy={null}
      toolPermissionBusy={false}
      toolPermissionError=""
      onToolPermissionChange={vi.fn()}
      onToolPermissionReset={vi.fn()}
      onClose={vi.fn()}
      actions={actions}
    />
  )
}

describe('SettingsModal provider setup', () => {
  it('adds a compatible provider from the models page', async () => {
    const addModelProvider = vi.fn(async () => undefined)
    renderSettings(settingsActions(addModelProvider))

    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /提供商 ID/ }), {
      target: { value: 'Local-OpenAI' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: /模型 ID/ }), {
      target: { value: 'qwen2.5-coder:7b\nllama3.1:8b' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /推理模型/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存并加载' }))

    await waitFor(() => expect(addModelProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'local-openai',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      modelIds: ['qwen2.5-coder:7b', 'llama3.1:8b'],
      contextWindow: 128000,
      maxTokens: 16384,
      reasoning: true
    })))
    expect(screen.queryByText('添加自定义提供商')).not.toBeInTheDocument()
  })

  it('uses Pi provider auth methods instead of a hard-coded provider subset', async () => {
    const providers: ModelProviderInfo[] = [{
      id: 'openai-codex',
      name: 'OpenAI Codex',
      modelCount: 7,
      configured: false,
      authMethods: [{
        type: 'oauth',
        name: 'OpenAI (ChatGPT Plus/Pro)',
        loginLabel: 'Sign in with ChatGPT',
        interactive: true,
        subscription: true
      }]
    }]
    const actions = settingsActions(vi.fn(async () => undefined), providers)
    renderSettings(actions)

    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    expect(await screen.findByText('OpenAI Codex')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }))

    await waitFor(() => expect(actions.loginModelProvider).toHaveBeenCalledWith('openai-codex', 'oauth'))
  })

  it('shows device-code progress without exposing credentials', async () => {
    const authState: ModelProviderAuthState = {
      operationId: 'auth-1',
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      authType: 'oauth',
      phase: 'waiting',
      message: '请在浏览器中输入设备代码以完成登录。',
      url: 'https://github.com/login/device',
      links: [{ url: 'https://github.com/login/device', label: '打开验证页面' }],
      userCode: 'ABCD-EFGH',
      startedAt: 1
    }
    renderSettings(settingsActions(), false, authState)
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))

    expect(await screen.findByLabelText('设备代码')).toHaveTextContent('ABCD-EFGH')
    expect(screen.getByRole('button', { name: /打开验证页面/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /API 密钥/ })).not.toBeInTheDocument()
  })

  it('disables provider reload while the selected session is running', () => {
    renderSettings(settingsActions(), true)
    expect(screen.getByRole('button', { name: '添加提供商' })).toBeDisabled()
  })
})
