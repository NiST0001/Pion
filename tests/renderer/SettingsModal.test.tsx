// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/renderer/src/features/settings/SettingsModal'
import type { SettingsActions } from '../../src/renderer/src/features/settings/SettingsModal'
import { applyTheme, currentTheme } from '../../src/renderer/src/utils/theme'
import type { ThemeId } from '../../src/renderer/src/utils/theme'
import type {
  ModelProviderAuthState,
  ModelProviderInfo,
  PionApi,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  SessionInfo
} from '../../src/shared/types'

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

type SettingsProps = ComponentProps<typeof SettingsModal>

function renderSettings(
  actions: SettingsActions,
  agentBusy = false,
  modelProviderAuthState: ModelProviderAuthState | null = null,
  overrides: Partial<SettingsProps> = {}
) {
  const props: SettingsProps = {
    open: true,
    session: null,
    models: [],
    modelProviderAuthState,
    agentBusy,
    completionNotificationsEnabled: true,
    onCompletionNotificationsChange: vi.fn(),
    sessionPreviewDensity: 'compact',
    onSessionPreviewDensityChange: vi.fn(),
    historyNavGap: 10,
    onHistoryNavGapChange: vi.fn(),
    historyNavMaxVisible: 40,
    onHistoryNavMaxVisibleChange: vi.fn(),
    showMetricDuration: true,
    showMetricCost: false,
    onMetricDurationChange: vi.fn(),
    onMetricCostChange: vi.fn(),
    projectTrust: null,
    projectTrustBusy: false,
    projectTrustError: '',
    onProjectTrustChange: vi.fn(),
    toolPermissionPolicy: null,
    toolPermissionBusy: false,
    toolPermissionError: '',
    onToolPermissionChange: vi.fn(),
    onToolPermissionReset: vi.fn(),
    onClose: vi.fn(),
    actions,
    ...overrides
  }
  return { ...render(<SettingsModal {...props} />), props }
}

function goToSettingsPage(name: RegExp): void {
  fireEvent.click(within(screen.getByRole('navigation', { name: '设置分类' })).getByRole('button', { name }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

it('keeps four immediately applied themes without a redundant live-preview section', () => {
  const root = document.documentElement
  const priorTheme = root.dataset.theme
  const priorScheme = root.style.colorScheme
  const stored = localStorage.getItem('pion:theme')
  try {
    renderSettings(settingsActions())
    fireEvent.click(screen.getByRole('button', { name: /外观/ }))
    expect(screen.queryByText('实时预览')).not.toBeInTheDocument()
    expect(screen.queryByText(/陶土主题会统一调整/)).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '毛玻璃' })).toBeInTheDocument()
    expect(document.querySelectorAll('.theme-choice')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /陶土浅色/ }))
    expect(root.dataset.theme).toBe('terracotta-light')
    expect(localStorage.getItem('pion:theme')).toBe('terracotta-light')
    fireEvent.click(screen.getByRole('button', { name: /陶土深色/ }))
    expect(root.dataset.theme).toBe('terracotta-dark')
  } finally {
    if (priorTheme === undefined) delete root.dataset.theme
    else root.dataset.theme = priorTheme
    root.style.colorScheme = priorScheme
    if (stored === null) localStorage.removeItem('pion:theme')
    else localStorage.setItem('pion:theme', stored)
  }
})

describe('SettingsModal page state and callbacks', () => {
  let priorApi: PionApi | undefined
  let priorTheme: ThemeId
  let priorThemeAttribute: string | undefined
  let priorScheme: string
  let priorStoredTheme: string | null
  let finishPendingThemeSave: (() => void) | undefined

  beforeEach(() => {
    finishPendingThemeSave = undefined
    priorApi = window.pion
    priorTheme = currentTheme()
    priorThemeAttribute = document.documentElement.dataset.theme
    priorScheme = document.documentElement.style.colorScheme
    priorStoredTheme = localStorage.getItem('pion:theme')
  })

  afterEach(async () => {
    // A failed assertion must not leave the real theme utility's write queue blocked.
    await act(async () => { finishPendingThemeSave?.() })
    if (priorApi === undefined) delete (window as unknown as { pion?: PionApi }).pion
    else window.pion = priorApi
    applyTheme(priorTheme)
    if (priorThemeAttribute === undefined) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = priorThemeAttribute
    document.documentElement.style.colorScheme = priorScheme
    if (priorStoredTheme === null) localStorage.removeItem('pion:theme')
    else localStorage.setItem('pion:theme', priorStoredTheme)
  })

  it('keeps session drafts and retry choices across pages without replacing the focused input on parent updates', () => {
    const session: SessionInfo = {
      sessionId: 'settings-session',
      sessionName: '原会话名称',
      isStreaming: false,
      messageCount: 2
    }
    const actions = settingsActions()
    const { rerender, props } = renderSettings(actions, false, null, { session })
    goToSettingsPage(/^会话/)

    const nameInput = screen.getByPlaceholderText('未命名') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '尚未保存的会话名称' } })
    nameInput.focus()
    nameInput.setSelectionRange(2, 5)
    expect(nameInput).toHaveFocus()

    rerender(<SettingsModal {...props} session={{ ...session, messageCount: 3 }} showMetricCost />)
    expect(screen.getByPlaceholderText('未命名')).toBe(nameInput)
    expect(nameInput).toHaveValue('尚未保存的会话名称')
    expect(nameInput).toHaveFocus()
    expect([nameInput.selectionStart, nameInput.selectionEnd]).toEqual([2, 5])

    const retrySwitch = () => within(screen.getByText('自动重试').closest<HTMLElement>('.setting-row')!).getByRole('switch')
    expect(retrySwitch()).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(retrySwitch())
    expect(actions.setAutoRetry).toHaveBeenCalledExactlyOnceWith(false)

    goToSettingsPage(/^外观/)
    goToSettingsPage(/^会话/)
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('尚未保存的会话名称')
    expect(retrySwitch()).toHaveAttribute('aria-checked', 'false')
    expect(actions.setAutoRetry).toHaveBeenCalledTimes(1)
    expect(actions.renameSession).not.toHaveBeenCalled()
  })

  it('keeps export and compaction busy across navigation and receives their results while another page is open', async () => {
    const exported = deferred<string>()
    const compacted = deferred<void>()
    const actions = settingsActions()
    actions.exportSessionHtml = vi.fn(() => exported.promise)
    actions.compactNow = vi.fn(() => compacted.promise)
    renderSettings(actions)
    goToSettingsPage(/^会话/)
    fireEvent.click(screen.getByRole('button', { name: /立即压缩/ }))
    fireEvent.click(screen.getByRole('button', { name: /导出 HTML/ }))

    goToSettingsPage(/^诊断/)
    goToSettingsPage(/^会话/)
    const compactButton = screen.getByRole('button', { name: /压缩中/ })
    const exportButton = screen.getByRole('button', { name: /导出 HTML/ })
    expect(compactButton).toBeDisabled()
    expect(exportButton).toBeDisabled()
    fireEvent.click(compactButton)
    fireEvent.click(exportButton)
    expect(actions.compactNow).toHaveBeenCalledTimes(1)
    expect(actions.exportSessionHtml).toHaveBeenCalledTimes(1)

    goToSettingsPage(/^关于 Pion/)
    await act(async () => {
      compacted.resolve(undefined)
      exported.resolve('/tmp/pion-shared-session.html')
      await Promise.all([compacted.promise, exported.promise])
    })
    goToSettingsPage(/^会话/)
    expect(screen.getByRole('button', { name: /立即压缩/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /导出 HTML/ })).toBeEnabled()
    expect(screen.getByText('/tmp/pion-shared-session.html')).toBeInTheDocument()
    expect(actions.compactNow).toHaveBeenCalledTimes(1)
    expect(actions.exportSessionHtml).toHaveBeenCalledTimes(1)
  })

  it('retains refreshed stderr across pages, including a delayed response, and only displays the last 6000 characters', async () => {
    const refreshed = deferred<string>()
    const getStderr = vi.fn<PionApi['getStderr']>().mockReturnValueOnce(refreshed.promise).mockResolvedValue('')
    window.pion = { getStderr } as unknown as PionApi
    renderSettings(settingsActions())
    goToSettingsPage(/^诊断/)
    expect(screen.getByText('点击“刷新日志”读取子进程输出。')).toBeInTheDocument()
    expect(getStderr).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /刷新日志/ }))
    goToSettingsPage(/^关于 Pion/)

    const output = `discarded-prefix:${'日志'.repeat(3100)}:latest-tail`
    const expectedTail = output.slice(-6000)
    await act(async () => {
      refreshed.resolve(output)
      await refreshed.promise
    })
    goToSettingsPage(/^诊断/)
    expect(screen.getByText(expectedTail).textContent).toBe(expectedTail)
    expect(screen.getByText(expectedTail).textContent).toHaveLength(6000)
    expect(screen.queryByText(/discarded-prefix/)).not.toBeInTheDocument()

    goToSettingsPage(/^外观/)
    goToSettingsPage(/^诊断/)
    expect(screen.getByText(expectedTail).textContent).toBe(expectedTail)
    expect(getStderr).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /刷新日志/ }))
    expect(await screen.findByText('(空)')).toBeInTheDocument()
    expect(screen.queryByText(expectedTail)).not.toBeInTheDocument()
    expect(getStderr).toHaveBeenCalledTimes(2)
  })

  it('retains a theme-save error across pages and lets selecting the theme again retry without reverting the appearance', async () => {
    const saved = deferred<ThemeId>()
    finishPendingThemeSave = () => saved.resolve('terracotta-light')
    const setTheme = vi.fn<PionApi['setTheme']>().mockReturnValueOnce(saved.promise).mockImplementation(async (theme) => theme)
    window.pion = { setTheme } as unknown as PionApi
    renderSettings(settingsActions())
    goToSettingsPage(/^外观/)
    fireEvent.click(screen.getByRole('button', { name: /陶土浅色/ }))
    expect(document.documentElement.dataset.theme).toBe('terracotta-light')
    await waitFor(() => expect(setTheme).toHaveBeenCalledExactlyOnceWith('terracotta-light'))

    goToSettingsPage(/^诊断/)
    await act(async () => { saved.reject(new Error('disk full')) })
    goToSettingsPage(/^外观/)
    expect(screen.getByRole('alert')).toHaveTextContent('主题保存失败，请重新选择后重试。')
    expect(screen.getByRole('button', { name: /陶土浅色/ })).toHaveAttribute('aria-pressed', 'true')
    goToSettingsPage(/^关于 Pion/)
    goToSettingsPage(/^外观/)
    expect(screen.getByRole('alert')).toHaveTextContent('主题保存失败')

    fireEvent.click(screen.getByRole('button', { name: /陶土浅色/ }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(setTheme).toHaveBeenCalledTimes(2))
    expect(setTheme).toHaveBeenLastCalledWith('terracotta-light')
    expect(document.documentElement.dataset.theme).toBe('terracotta-light')
    expect(localStorage.getItem('pion:theme')).toBe('terracotta-light')
  })

  it('ignores an older theme-save failure after choosing a newer theme on a revisited appearance page', async () => {
    const oldSave = deferred<ThemeId>()
    finishPendingThemeSave = () => oldSave.resolve('terracotta-light')
    const setTheme = vi.fn<PionApi['setTheme']>().mockReturnValueOnce(oldSave.promise).mockImplementation(async (theme) => theme)
    window.pion = { setTheme } as unknown as PionApi
    renderSettings(settingsActions())
    goToSettingsPage(/^外观/)
    fireEvent.click(screen.getByRole('button', { name: /陶土浅色/ }))
    await waitFor(() => expect(setTheme).toHaveBeenCalledExactlyOnceWith('terracotta-light'))

    goToSettingsPage(/^诊断/)
    goToSettingsPage(/^外观/)
    fireEvent.click(screen.getByRole('button', { name: /^深色/ }))
    expect(screen.getByRole('button', { name: /^深色/ })).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset.theme).toBe('plain-dark')
    await act(async () => { oldSave.reject(new Error('stale write failed')) })
    await waitFor(() => expect(setTheme.mock.calls).toEqual([['terracotta-light'], ['plain-dark']]))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    goToSettingsPage(/^关于 Pion/)
    goToSettingsPage(/^外观/)
    expect(screen.getByRole('button', { name: /^深色/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBe('plain-dark')
    expect(localStorage.getItem('pion:theme')).toBe('plain-dark')
  })

  it('forwards project-trust and tool-policy decisions independently and respects updated busy and error props', () => {
    const projectTrust: ProjectTrustInfo = {
      cwd: '/workspace/pion',
      requiresTrust: true,
      decision: 'untrusted',
      source: 'saved'
    }
    const toolPermissionPolicy: ProjectToolPermissionPolicy = {
      cwd: projectTrust.cwd,
      source: 'saved',
      rules: { read: 'allow', write: 'ask', shell: 'ask', network: 'ask', external: 'ask' }
    }
    const onProjectTrustChange = vi.fn()
    const onToolPermissionChange = vi.fn()
    const onToolPermissionReset = vi.fn()
    const { rerender, props } = renderSettings(settingsActions(), false, null, {
      projectTrust,
      toolPermissionPolicy,
      onProjectTrustChange,
      onToolPermissionChange,
      onToolPermissionReset
    })
    goToSettingsPage(/^安全与信任/)
    expect(screen.getByText('未信任项目资源')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '不信任' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '信任项目' }))
    expect(onProjectTrustChange).toHaveBeenCalledExactlyOnceWith(true)

    rerender(<SettingsModal {...props} projectTrust={{ ...projectTrust, decision: 'trusted' }} />)
    expect(screen.getByText('已信任项目资源')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '信任项目' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '不信任' }))
    const trustRow = screen.getByText('Pi 项目信任').closest<HTMLElement>('.setting-row')!
    fireEvent.click(within(trustRow).getByRole('button', { name: '恢复默认' }))
    expect(onProjectTrustChange.mock.calls).toEqual([[true], [false], [null]])

    const shellPolicy = screen.getByRole('group', { name: '运行 Shell 命令' })
    expect(within(shellPolicy).getByRole('button', { name: '询问' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(shellPolicy).getByRole('button', { name: '允许' }))
    fireEvent.click(within(screen.getByRole('group', { name: '插件与扩展工具' })).getByRole('button', { name: '拒绝' }))
    expect(onToolPermissionChange.mock.calls).toEqual([['shell', 'allow'], ['external', 'deny']])
    const toolSettings = screen.getByText('工具执行权限').closest<HTMLElement>('.settings-section')!
    fireEvent.click(within(toolSettings).getByRole('button', { name: '恢复默认' }))
    expect(onToolPermissionReset).toHaveBeenCalledTimes(1)
    expect(onProjectTrustChange).toHaveBeenCalledTimes(3)

    rerender(<SettingsModal {...props}
      projectTrustBusy toolPermissionBusy
      projectTrustError="项目信任保存失败" toolPermissionError="工具策略保存失败"
    />)
    goToSettingsPage(/^关于 Pion/)
    goToSettingsPage(/^安全与信任/)
    expect(screen.getByText('项目信任保存失败')).toBeInTheDocument()
    expect(screen.getByText('工具策略保存失败')).toBeInTheDocument()
    const trustButton = screen.getByRole('button', { name: '信任项目' })
    const allowShell = within(screen.getByRole('group', { name: '运行 Shell 命令' })).getByRole('button', { name: '允许' })
    expect(trustButton).toBeDisabled()
    expect(allowShell).toBeDisabled()
    fireEvent.click(trustButton)
    fireEvent.click(allowShell)
    for (const reset of screen.getAllByRole('button', { name: '恢复默认' })) {
      expect(reset).toBeDisabled()
      fireEvent.click(reset)
    }
    expect(onProjectTrustChange).toHaveBeenCalledTimes(3)
    expect(onToolPermissionChange).toHaveBeenCalledTimes(2)
    expect(onToolPermissionReset).toHaveBeenCalledTimes(1)
  })
})

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
