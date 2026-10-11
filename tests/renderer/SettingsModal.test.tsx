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

it('keeps five immediately applied themes without a redundant live-preview section', () => {
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
    expect(document.querySelectorAll('.theme-choice')).toHaveLength(5)
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

  it('selects the Division theme and keeps all original themes selectable and persistable', async () => {
    const setTheme = vi.fn<PionApi['setTheme']>().mockImplementation(async (theme) => theme)
    window.pion = { setTheme } as unknown as PionApi
    applyTheme('terracotta-dark')
    renderSettings(settingsActions())
    goToSettingsPage(/^外观/)
    expect(screen.getByRole('button', { name: /陶土深色/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /信号橙/ })).toHaveAttribute('aria-pressed', 'false')
    expect(setTheme).not.toHaveBeenCalled()

    const options = [
      { name: /信号橙/, id: 'division-dark', scheme: 'dark' },
      { name: /陶土浅色/, id: 'terracotta-light', scheme: 'light' },
      { name: /^深色/, id: 'plain-dark', scheme: 'dark' },
      { name: /^浅色/, id: 'plain-light', scheme: 'light' },
      { name: /陶土深色/, id: 'terracotta-dark', scheme: 'dark' }
    ] as const
    for (const [index, option] of options.entries()) {
      const button = screen.getByRole('button', { name: option.name })
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-pressed', 'true')
      expect(document.querySelectorAll('.theme-choice[aria-pressed="true"]')).toHaveLength(1)
      expect(document.documentElement.dataset.theme).toBe(option.id)
      expect(document.documentElement.style.colorScheme).toBe(option.scheme)
      expect(localStorage.getItem('pion:theme')).toBe(option.id)
      await waitFor(() => expect(setTheme).toHaveBeenCalledTimes(index + 1))
      expect(setTheme).toHaveBeenLastCalledWith(option.id)
    }
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

  it.each([
    { name: /^深色/, id: 'plain-dark' },
    { name: /信号橙/, id: 'division-dark' }
  ] as const)('ignores an older theme-save failure after choosing $id on a revisited appearance page', async (selected) => {
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
    fireEvent.click(screen.getByRole('button', { name: selected.name }))
    expect(screen.getByRole('button', { name: selected.name })).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset.theme).toBe(selected.id)
    await act(async () => { oldSave.reject(new Error('stale write failed')) })
    await waitFor(() => expect(setTheme.mock.calls).toEqual([['terracotta-light'], [selected.id]]))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    goToSettingsPage(/^关于 Pion/)
    goToSettingsPage(/^外观/)
    expect(screen.getByRole('button', { name: selected.name })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBe(selected.id)
    expect(localStorage.getItem('pion:theme')).toBe(selected.id)
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

describe('SettingsModal provider visibility', () => {
  const provider: ModelProviderInfo = {
    id: 'openai-codex', name: 'OpenAI Codex', modelCount: 7, configured: true,
    configuredSource: 'stored', storedCredentialType: 'oauth',
    authMethods: [{ type: 'oauth', name: 'ChatGPT', interactive: true }]
  }
  const visibilitySwitch = () => screen.getByRole('switch', { name: '显示 OpenAI Codex 的模型' })

  it('forwards visibility booleans during streaming without changing models, auth or configuration', async () => {
    const actions = settingsActions(undefined, [provider])
    actions.setModelProviderEnabled = vi.fn(async (_id: string, enabled: boolean) => [{ ...provider, enabled }])
    const { rerender, props } = renderSettings(actions, true)
    expect(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })).toHaveAttribute('aria-checked', 'true')
    expect(visibilitySwitch()).toBeEnabled()
    fireEvent.click(visibilitySwitch())
    await waitFor(() => expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false'))
    expect(actions.setModelProviderEnabled).toHaveBeenCalledExactlyOnceWith('openai-codex', false)
    rerender(<SettingsModal {...props} models={[]} />)
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(visibilitySwitch())
    await waitFor(() => expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'true'))
    expect(actions.setModelProviderEnabled).toHaveBeenLastCalledWith('openai-codex', true)
    expect(actions.setModel).not.toHaveBeenCalled()
    expect(actions.loginModelProvider).not.toHaveBeenCalled()
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()
    expect(actions.addModelProvider).not.toHaveBeenCalled()
  })

  it('keeps hidden providers reachable outside the add panel and omits unconfigured catalog entries', async () => {
    const actions = settingsActions(undefined, [
      { ...provider, configured: false, enabled: false },
      { ...provider, id: 'unused', name: 'Unused', configured: false }
    ])
    actions.setModelProviderEnabled = vi.fn(async () => [provider])
    renderSettings(actions)
    expect(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('switch', { name: '显示 Unused 的模型' })).not.toBeInTheDocument()
    expect(screen.queryByText('Pi 提供商目录')).not.toBeInTheDocument()
    fireEvent.click(visibilitySwitch())
    await waitFor(() => expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'true'))
  })

  it('disables unsupported callbacks and switches during authentication', async () => {
    const actions = settingsActions(undefined, [provider])
    const { rerender, props } = renderSettings(actions)
    expect(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })).toBeDisabled()
    actions.setModelProviderEnabled = vi.fn(async () => [provider])
    rerender(<SettingsModal {...props} modelProviderAuthState={{
      operationId: 'login', providerId: provider.id, providerName: provider.name,
      authType: 'oauth', phase: 'waiting', message: '等待登录', startedAt: 1
    }} />)
    expect(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })).toBeDisabled()
    fireEvent.click(visibilitySwitch())
    expect(actions.setModelProviderEnabled).not.toHaveBeenCalled()
  })

  it('retains confirmed state on failure and gates repeated pending toggles', async () => {
    const pending = deferred<ModelProviderInfo[]>()
    const actions = settingsActions(undefined, [provider])
    actions.setModelProviderEnabled = vi.fn(() => pending.promise)
    renderSettings(actions)
    await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })
    fireEvent.click(visibilitySwitch())
    fireEvent.click(visibilitySwitch())
    expect(visibilitySwitch()).toBeDisabled()
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'true')
    expect(actions.setModelProviderEnabled).toHaveBeenCalledTimes(1)
    await act(async () => { pending.reject(new Error('显示设置保存失败')) })
    expect(screen.getByRole('alert')).toHaveTextContent('显示设置保存失败')
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'true')
    expect(visibilitySwitch()).toBeEnabled()
  })

  it('rejects older catalog results after a visibility save and preserves focused add drafts', async () => {
    const oldCatalog = deferred<ModelProviderInfo[]>()
    const actions = settingsActions(undefined, [provider])
    actions.setModelProviderEnabled = vi.fn(async () => [{ ...provider, enabled: false }])
    actions.listModelProviders = vi.fn()
      .mockResolvedValueOnce([provider])
      .mockImplementation(() => oldCatalog.promise)
    const { rerender, props } = renderSettings(actions)
    await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    const draft = screen.getByRole('textbox', { name: /提供商 ID/ })
    fireEvent.change(draft, { target: { value: 'draft-provider' } })
    draft.focus()
    rerender(<SettingsModal {...props} actions={{ ...actions }} />)
    expect(screen.getByRole('textbox', { name: /提供商 ID/ })).toBe(draft)
    expect(draft).toHaveFocus()
    fireEvent.click(visibilitySwitch())
    await waitFor(() => expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false'))
    await act(async () => { oldCatalog.resolve([provider]); await oldCatalog.promise })
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false')
    expect(draft).toHaveValue('draft-provider')
    expect(screen.getByText('添加自定义提供商')).toBeInTheDocument()
  })

  it.each([
    { returnedEnabled: undefined, checked: 'false' },
    { returnedEnabled: true, checked: 'true' },
    { returnedEnabled: false, checked: 'false' }
  ])('uses toggle intent only for missing enabled flags ($returnedEnabled)', async ({ returnedEnabled, checked }) => {
    const actions = settingsActions(undefined, [{ ...provider, enabled: true }])
    actions.setModelProviderEnabled = vi.fn(async () => [{ ...provider, enabled: returnedEnabled }])
    renderSettings(actions)
    fireEvent.click(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' }))
    await waitFor(() => expect(visibilitySwitch()).toBeEnabled())
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', checked)
    expect(actions.setModelProviderEnabled).toHaveBeenCalledExactlyOnceWith(provider.id, false)
  })

  it('lets a fresh explicit catalog flag override a previous toggle', async () => {
    const actions = settingsActions(undefined, [{ ...provider, enabled: true }])
    actions.setModelProviderEnabled = vi.fn(async () => [{ ...provider, enabled: false }])
    renderSettings(actions)
    fireEvent.click(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' }))
    await waitFor(() => expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false'))
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      for (const control of screen.getAllByRole('switch', { name: '显示 OpenAI Codex 的模型' })) {
        expect(control).toHaveAttribute('aria-checked', 'true')
      }
    })
    expect(actions.listModelProviders).toHaveBeenCalledTimes(2)
  })

  it('keeps authentication catalogs authoritative after a visibility save', async () => {
    const actions = settingsActions(undefined, [{ ...provider, enabled: true }])
    actions.setModelProviderEnabled = vi.fn(async () => [{ ...provider, enabled: false }])
    actions.logoutModelProvider = vi.fn(async () => [{ ...provider, enabled: true }])
    actions.loginModelProvider = vi.fn(async () => [{ ...provider, enabled: false }])
    renderSettings(actions)
    fireEvent.click(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' }))
    await waitFor(() => expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false'))
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '退出 OpenAI Codex' }))
    await waitFor(() => expect(screen.getAllByRole('switch', { name: '显示 OpenAI Codex 的模型' })[0]).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    await waitFor(() => expect(screen.getAllByRole('switch', { name: '显示 OpenAI Codex 的模型' })[0]).toHaveAttribute('aria-checked', 'false'))
  })

  it.each([
    { changedOwner: 'list', reject: false },
    { changedOwner: 'visibility', reject: false },
    { changedOwner: 'list', reject: true }
  ])('fences pending results and retains the action gate for $changedOwner owner (reject=$reject)', async ({ changedOwner, reject }) => {
    const pending = deferred<ModelProviderInfo[]>()
    const latestCatalog = deferred<ModelProviderInfo[]>()
    const actions = settingsActions(undefined, [{ ...provider, enabled: true }])
    actions.setModelProviderEnabled = vi.fn(() => pending.promise)
    const { rerender, props } = renderSettings(actions)
    const control = await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })
    // Same-event pointer repeats must also meet the ref gate, not just disabled DOM.
    act(() => {
      fireEvent.click(control)
      fireEvent.click(control)
    })
    expect(actions.setModelProviderEnabled).toHaveBeenCalledTimes(1)
    const latestList = vi.fn(() => latestCatalog.promise)
    const latestVisibility = vi.fn(async () => [{ ...provider, enabled: true }])
    const nextActions = changedOwner === 'list'
      ? { ...actions, listModelProviders: latestList }
      : { ...actions, setModelProviderEnabled: latestVisibility }
    if (changedOwner === 'visibility') {
      vi.mocked(actions.listModelProviders).mockImplementation(() => latestCatalog.promise)
    }
    rerender(<SettingsModal {...props} actions={nextActions} />)
    expect(screen.queryByRole('switch', { name: '显示 OpenAI Codex 的模型' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加提供商' })).toBeDisabled()
    expect(latestList).not.toHaveBeenCalled()
    expect(actions.listModelProviders).toHaveBeenCalledTimes(1)
    // More parent renders cannot release a still-unsettled action.
    rerender(<SettingsModal {...props} actions={{ ...nextActions }} models={[]} />)
    expect(latestVisibility).not.toHaveBeenCalled()
    await act(async () => {
      if (reject) {
        pending.reject(new Error('旧 owner 迟到失败'))
        await pending.promise.catch(() => undefined)
      } else {
        pending.resolve([{ ...provider, enabled: false }])
        await pending.promise
      }
    })
    expect(screen.queryByText('旧 owner 迟到失败')).not.toBeInTheDocument()
    await waitFor(() => expect(nextActions.listModelProviders).toHaveBeenCalledTimes(changedOwner === 'list' ? 1 : 2))
    expect(screen.queryByRole('switch', { name: '显示 OpenAI Codex 的模型' })).not.toBeInTheDocument()
    await act(async () => { latestCatalog.resolve([{ ...provider, enabled: true }]); await latestCatalog.promise })
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'true')
    expect(visibilitySwitch()).toBeEnabled()
    expect(latestVisibility).not.toHaveBeenCalled()
  })

  it('clears old errors and reloads owners without replacing the focused custom form', async () => {
    const actions = settingsActions(undefined, [provider])
    actions.setModelProviderEnabled = vi.fn(async () => { throw new Error('旧 owner 保存失败') })
    const { rerender, props } = renderSettings(actions)
    fireEvent.click(await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' }))
    await screen.findByText('旧 owner 保存失败')
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    const draft = screen.getByRole('textbox', { name: /提供商 ID/ })
    fireEvent.change(draft, { target: { value: 'owner-draft' } })
    draft.focus()
    const newCatalog = deferred<ModelProviderInfo[]>()
    const nextActions = { ...actions, listModelProviders: vi.fn(() => newCatalog.promise) }
    rerender(<SettingsModal {...props} actions={nextActions} />)
    expect(screen.queryByText('旧 owner 保存失败')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /提供商 ID/ })).toBe(draft)
    expect(draft).toHaveFocus()
    expect(draft).toHaveValue('owner-draft')
    await act(async () => { newCatalog.resolve([{ ...provider, enabled: false }]); await newCatalog.promise })
    rerender(<SettingsModal {...props} actions={{ ...nextActions }} models={[]} />)
    expect(nextActions.listModelProviders).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: /提供商 ID/ })).toBe(draft)
    expect(draft).toHaveFocus()
    expect(draft).toHaveValue('owner-draft')
    expect(visibilitySwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('also exposes the switch as a sibling of directory authentication buttons', async () => {
    const actions = settingsActions(undefined, [{ ...provider, configured: false }])
    actions.setModelProviderEnabled = vi.fn(async () => [{ ...provider, configured: false, enabled: false }])
    renderSettings(actions)
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    const control = await screen.findByRole('switch', { name: '显示 OpenAI Codex 的模型' })
    expect(control.closest('button')?.parentElement?.closest('button')).toBeNull()
    fireEvent.click(control)
    await waitFor(() => expect(actions.setModelProviderEnabled).toHaveBeenCalledExactlyOnceWith(provider.id, false))
    expect(actions.loginModelProvider).not.toHaveBeenCalled()
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()
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
