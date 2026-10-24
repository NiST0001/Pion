// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/renderer/src/features/settings/SettingsModal'
import type { SettingsActions } from '../../src/renderer/src/features/settings/SettingsModal'
import type { SettingsNavigationRequest } from '../../src/renderer/src/features/settings/settingsNavigation'
import type { ModelProviderInfo, PionApi, SessionInfo } from '../../src/shared/types'
import { DEFAULT_QUESTION_SETTINGS } from '../../src/shared/question-settings'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'

type SettingsProps = ComponentProps<typeof SettingsModal>

const session: SessionInfo = {
  sessionId: 'navigation-session', sessionName: '原会话名称', messageCount: 2, isStreaming: false
}
const provider: ModelProviderInfo = {
  id: 'runtime-provider', name: 'Runtime Provider', modelCount: 3, configured: true,
  storedCredentialType: 'oauth', configuredSource: 'stored',
  authMethods: [
    { type: 'oauth', name: 'Runtime subscription', loginLabel: '使用 Runtime 订阅登录', interactive: true },
    { type: 'api_key', name: '系统密钥', interactive: false }
  ]
}
const otherProvider: ModelProviderInfo = {
  id: 'other-provider', name: 'Other Provider', modelCount: 1, configured: false,
  authMethods: [{ type: 'api_key', name: 'API key', interactive: true }]
}

function settingsActions(providers: ModelProviderInfo[] = []): SettingsActions {
  return {
    setModel: vi.fn(async () => undefined),
    listModelProviders: vi.fn(async () => providers),
    setModelProviderEnabled: vi.fn(async () => providers),
    loginModelProvider: vi.fn(async () => providers),
    logoutModelProvider: vi.fn(async () => providers),
    cancelModelProviderAuth: vi.fn(async () => undefined),
    openModelProviderAuthUrl: vi.fn(async () => undefined),
    addModelProvider: vi.fn(async () => undefined),
    setAutoCompaction: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    compactNow: vi.fn(async () => undefined),
    exportSessionHtml: vi.fn(async () => '/tmp/session.html'),
    renameSession: vi.fn(async () => undefined),
    setSteeringMode: vi.fn(async () => undefined),
    setFollowUpMode: vi.fn(async () => undefined)
  }
}

function renderSettings(overrides: Partial<SettingsProps> = {}) {
  const props: SettingsProps = {
    open: true, session, models: [], modelProviderAuthState: null, agentBusy: false,
    completionNotificationsEnabled: true, onCompletionNotificationsChange: vi.fn(),
    sessionPreviewDensity: 'compact', onSessionPreviewDensityChange: vi.fn(),
    historyNavGap: 10, onHistoryNavGapChange: vi.fn(),
    historyNavMaxVisible: 40, onHistoryNavMaxVisibleChange: vi.fn(),
    showMetricDuration: true, showMetricCost: false,
    onMetricDurationChange: vi.fn(), onMetricCostChange: vi.fn(),
    projectTrust: null, projectTrustBusy: false, projectTrustError: '', onProjectTrustChange: vi.fn(),
    toolPermissionPolicy: null, toolPermissionBusy: false, toolPermissionError: '',
    onToolPermissionChange: vi.fn(), onToolPermissionReset: vi.fn(),
    onClose: vi.fn(), actions: settingsActions(), ...overrides
  }
  return { ...render(<SettingsModal {...props} />), props }
}

function goToPage(name: RegExp): void {
  fireEvent.click(within(screen.getByRole('navigation', { name: '设置分类' })).getByRole('button', { name }))
}

function directory(): HTMLElement {
  return screen.getByText('Pi 提供商目录').closest<HTMLElement>('.provider-directory')!
}

function expectNoProviderMutation(actions: SettingsActions): void {
  for (const action of [actions.setModel, actions.setModelProviderEnabled, actions.loginModelProvider,
    actions.logoutModelProvider, actions.cancelModelProviderAuth, actions.openModelProviderAuthUrl,
    actions.addModelProvider]) expect(action).not.toHaveBeenCalled()
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

let priorApi: PionApi | undefined
beforeEach(() => {
  priorApi = window.pion
  window.pion = {} as PionApi
})
afterEach(() => {
  cleanup()
  if (priorApi === undefined) delete (window as unknown as { pion?: PionApi }).pion
  else window.pion = priorApi
})

describe('SettingsModal one-shot navigation', () => {
  it('targets new ids while same-id renders and name backfills preserve the selected page and host draft', () => {
    const navigationRequest: SettingsNavigationRequest = { id: 1, page: 'session' }
    const { rerender, container, props } = renderSettings({ navigationRequest })
    const host = container.querySelector('.settings-modal')
    const draft = screen.getByPlaceholderText('未命名') as HTMLInputElement
    fireEvent.change(draft, { target: { value: '尚未保存的草稿' } })
    draft.focus()
    draft.setSelectionRange(1, 4)

    rerender(<SettingsModal {...props} navigationRequest={{ ...navigationRequest }}
      session={{ ...session, sessionName: '迟到回填的名称', isStreaming: true, messageCount: 3 }} />)
    expect(screen.getByPlaceholderText('未命名')).toBe(draft)
    expect(draft).toHaveValue('尚未保存的草稿')
    expect(draft).toHaveFocus()
    expect([draft.selectionStart, draft.selectionEnd]).toEqual([1, 4])

    goToPage(/^关于 Pion/)
    expect(draft).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ ...navigationRequest, page: 'security' }}
      session={{ ...session, sessionName: '另一次名称回填', isStreaming: true }} />)
    expect(screen.getByRole('heading', { name: '关于 Pion' })).toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 2, page: 'appearance' }} />)
    expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument()
    expect(container.querySelector('.settings-modal')).toBe(host)
    goToPage(/^会话/)
    expect(screen.getByPlaceholderText('未命名')).not.toBe(draft)
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('尚未保存的草稿')
    expect(props.actions.renameSession).not.toHaveBeenCalled()
  })

  it('does not replay consumed ids after a newer request, removal, page revisit, or reopen', () => {
    const first: SettingsNavigationRequest = { id: 10, page: 'security' }
    const { rerender, props } = renderSettings({ navigationRequest: first })
    expect(screen.getByRole('heading', { name: '安全与信任' })).toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 11, page: 'diagnostics' }} />)
    expect(screen.getByRole('heading', { name: '诊断' })).toBeInTheDocument()
    goToPage(/^关于 Pion/)
    rerender(<SettingsModal {...props} navigationRequest={undefined} />)
    rerender(<SettingsModal {...props} navigationRequest={{ ...first }} />)
    expect(screen.getByRole('heading', { name: '关于 Pion' })).toBeInTheDocument()
    rerender(<SettingsModal {...props} open={false} />)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} />)
    expect(screen.getByRole('heading', { name: '模型与提供商' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '安全与信任' })).not.toBeInTheDocument()
  })

  it('does not consume a closed request or transiently mount a non-target page when opening', () => {
    const { rerender, props } = renderSettings({ open: false,
      navigationRequest: { id: 20, page: 'appearance' } })
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 21, page: 'diagnostics' }} />)
    rerender(<SettingsModal {...props} open navigationRequest={{ id: 21, page: 'diagnostics' }} />)
    expect(screen.getByRole('heading', { name: '诊断' })).toBeInTheDocument()
    rerender(<SettingsModal {...props} open navigationRequest={{ id: 20, page: 'appearance' }} />)
    expect(screen.getByRole('heading', { name: '诊断' })).toBeInTheDocument()
    expect(props.actions.listModelProviders).not.toHaveBeenCalled()

    rerender(<SettingsModal {...props} open={false} navigationRequest={{ id: 22, page: 'security' }} />)
    rerender(<SettingsModal {...props} open navigationRequest={{ id: 22, page: 'security' }} />)
    expect(screen.getByRole('heading', { name: '安全与信任' })).toBeInTheDocument()
    expect(props.actions.listModelProviders).not.toHaveBeenCalled()
    rerender(<SettingsModal {...props} open={false} navigationRequest={undefined} />)
    rerender(<SettingsModal {...props} open navigationRequest={undefined} />)
    expect(screen.getByRole('heading', { name: '模型与提供商' })).toBeInTheDocument()
    expectNoProviderMutation(props.actions)
  })

  it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('ignores an invalid request id (%s)', (id) => {
    const { rerender, props } = renderSettings({ navigationRequest: { id, page: 'security' } })
    expect(screen.getByRole('heading', { name: '模型与提供商' })).toBeInTheDocument()
    goToPage(/^关于 Pion/)
    rerender(<SettingsModal {...props} navigationRequest={{ id, page: 'session' }} />)
    expect(screen.getByRole('heading', { name: '关于 Pion' })).toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 0, page: 'session' }} />)
    expect(screen.getByRole('heading', { name: '会话' })).toBeInTheDocument()
  })

  it('retains host drafts, retry choices and actual compaction/export pending state across page unmounts and reopen', async () => {
    const compacted = deferred<void>()
    const exported = deferred<string>()
    const actions = settingsActions()
    actions.compactNow = vi.fn(() => compacted.promise)
    actions.exportSessionHtml = vi.fn(() => exported.promise)
    const { rerender, props } = renderSettings({ actions, navigationRequest: { id: 30, page: 'session' } })
    const retry = () => within(screen.getByText('自动重试').closest<HTMLElement>('.setting-row')!).getByRole('switch')
    const draft = screen.getByPlaceholderText('未命名')
    fireEvent.change(draft, { target: { value: '保留在宿主的草稿' } })
    fireEvent.click(retry())
    fireEvent.click(screen.getByRole('button', { name: /立即压缩/ }))
    fireEvent.click(screen.getByRole('button', { name: /导出 HTML/ }))
    rerender(<SettingsModal {...props} navigationRequest={{ id: 31, page: 'diagnostics' }} />)
    expect(draft).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 32, page: 'session' }} />)
    expect(screen.getByPlaceholderText('未命名')).not.toBe(draft)
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('保留在宿主的草稿')
    expect(retry()).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: /压缩中/ }))
    fireEvent.click(screen.getByRole('button', { name: /导出 HTML/ }))
    expect(actions.compactNow).toHaveBeenCalledTimes(1)
    expect(actions.exportSessionHtml).toHaveBeenCalledTimes(1)

    rerender(<SettingsModal {...props} open={false} navigationRequest={undefined} />)
    expect(screen.queryByPlaceholderText('未命名')).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={undefined} />)
    expect(screen.getByRole('heading', { name: '模型与提供商' })).toBeInTheDocument()
    goToPage(/^会话/)
    // A real open transition retains the original name-reset behavior, not child DOM.
    expect(screen.getByPlaceholderText('未命名')).toHaveValue(session.sessionName)
    expect(retry()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: /压缩中/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /导出 HTML/ })).toBeDisabled()
    goToPage(/^关于 Pion/)
    await act(async () => {
      compacted.resolve(undefined)
      exported.resolve('/tmp/navigation-export.html')
      await Promise.all([compacted.promise, exported.promise])
    })
    goToPage(/^会话/)
    expect(screen.getByRole('button', { name: /立即压缩/ })).toBeEnabled()
    expect(screen.getByText('/tmp/navigation-export.html')).toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 33, page: 'about' }} />)
    goToPage(/^会话/)
    expect(screen.getByText('/tmp/navigation-export.html')).toBeInTheDocument()
    expect(actions.compactNow).toHaveBeenCalledTimes(1)
    expect(actions.exportSessionHtml).toHaveBeenCalledTimes(1)
    expect(actions.setAutoRetry).toHaveBeenCalledExactlyOnceWith(false)
  })
})

describe('SettingsModal session name ownership', () => {
  it('accepts a clean same-session name backfill without navigating away from the selected page', () => {
    const { rerender, props } = renderSettings({ session: { ...session, sessionName: undefined },
      navigationRequest: { id: 1, page: 'session' } })
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('')
    goToPage(/^关于 Pion/)
    rerender(<SettingsModal {...props} session={session} />)
    expect(screen.getByRole('heading', { name: '关于 Pion' })).toBeInTheDocument()
    goToPage(/^会话/)
    expect(screen.getByPlaceholderText('未命名')).toHaveValue(session.sessionName)
    expect(props.actions.renameSession).not.toHaveBeenCalled()
  })

  it('resets the host draft for a different real sessionId even when its name is identical, without selecting a page', () => {
    const { rerender, props } = renderSettings({ navigationRequest: { id: 1, page: 'session' } })
    const input = screen.getByPlaceholderText('未命名')
    fireEvent.change(input, { target: { value: '旧会话草稿' } })
    rerender(<SettingsModal {...props} session={{ ...session, sessionId: 'second-session' }} />)
    expect(screen.getByRole('heading', { name: '会话' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('未命名')).toBe(input)
    expect(input).toHaveValue(session.sessionName)
    fireEvent.change(input, { target: { value: '第二会话草稿' } })
    goToPage(/^关于 Pion/)
    rerender(<SettingsModal {...props} session={{ ...session, sessionId: 'third-session', sessionName: '第三会话' }} />)
    expect(screen.getByRole('heading', { name: '关于 Pion' })).toBeInTheDocument()
    goToPage(/^会话/)
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('第三会话')
    rerender(<SettingsModal {...props} session={null} />)
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('')
    expect(props.actions.renameSession).not.toHaveBeenCalled()
  })

  it('keeps the real rename slot across duplicate Enter, page changes, and close/reopen', async () => {
    const saved = deferred<void>()
    const actions = settingsActions()
    actions.renameSession = vi.fn().mockReturnValueOnce(saved.promise).mockResolvedValue(undefined)
    const { rerender, props } = renderSettings({ actions, navigationRequest: { id: 1, page: 'session' } })
    const input = screen.getByPlaceholderText('未命名')
    fireEvent.change(input, { target: { value: '待保存名称' } })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(actions.renameSession).toHaveBeenCalledExactlyOnceWith('待保存名称')
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    goToPage(/^关于 Pion/)
    goToPage(/^会话/)
    fireEvent.keyDown(screen.getByPlaceholderText('未命名'), { key: 'Enter' })
    rerender(<SettingsModal {...props} open={false} />)
    rerender(<SettingsModal {...props} navigationRequest={{ id: 2, page: 'session' }} />)
    fireEvent.change(screen.getByPlaceholderText('未命名'), { target: { value: '重开后的新草稿' } })
    fireEvent.keyDown(screen.getByPlaceholderText('未命名'), { key: 'Enter' })
    expect(actions.renameSession).toHaveBeenCalledTimes(1)
    await act(async () => { saved.resolve(undefined); await saved.promise })
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('重开后的新草稿')
    expect(screen.queryByRole('button', { name: '已保存' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => undefined)
    expect(actions.renameSession).toHaveBeenCalledTimes(2)
    expect(actions.renameSession).toHaveBeenLastCalledWith('重开后的新草稿')
  })

  it('does not submit a name during IME/repeated Enter, and reports a failed save without an unhandled rejection', async () => {
    const saved = deferred<void>()
    const actions = settingsActions()
    actions.renameSession = vi.fn(() => saved.promise)
    renderSettings({ actions, navigationRequest: { id: 1, page: 'session' } })
    const input = screen.getByPlaceholderText('未命名')
    fireEvent.change(input, { target: { value: '新名称' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', repeat: true })
    expect(actions.renameSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => { saved.reject(new Error('名称写入失败')); await saved.promise.catch(() => undefined) })
    expect(screen.getByText('名称写入失败')).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    fireEvent.change(input, { target: { value: '重试前的新草稿' } })
    expect(screen.queryByText('名称写入失败')).not.toBeInTheDocument()
  })

  it.each([false, true])('ignores a late rename acknowledgement after a real identity change (returnToFirst=%s)', async (returnToFirst) => {
    const saved = deferred<void>()
    const actions = settingsActions()
    actions.renameSession = vi.fn(() => saved.promise)
    const { rerender, props } = renderSettings({ actions, navigationRequest: { id: 1, page: 'session' } })
    fireEvent.change(screen.getByPlaceholderText('未命名'), { target: { value: '第一会话待保存名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(actions.renameSession).toHaveBeenCalledExactlyOnceWith('第一会话待保存名称')
    rerender(<SettingsModal {...props} session={{ ...session, sessionId: 'second-session' }} />)
    if (returnToFirst) rerender(<SettingsModal {...props} session={session} />)
    fireEvent.change(screen.getByPlaceholderText('未命名'), { target: { value: '当前身份的新草稿' } })
    await act(async () => { saved.resolve(undefined); await saved.promise })
    expect(screen.getByPlaceholderText('未命名')).toHaveValue('当前身份的新草稿')
    expect(screen.queryByRole('button', { name: '已保存' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '会话' })).toBeInTheDocument()
    expect(actions.renameSession).toHaveBeenCalledTimes(1)
  })

  it('does not mark a newer same-session draft saved when an older rename settles or its name backfills', async () => {
    const saved = deferred<void>()
    const actions = settingsActions()
    actions.renameSession = vi.fn(() => saved.promise)
    const { rerender, props } = renderSettings({ actions, navigationRequest: { id: 1, page: 'session' } })
    const input = screen.getByPlaceholderText('未命名')
    fireEvent.change(input, { target: { value: '已提交的旧名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.change(input, { target: { value: '提交后的新编辑' } })
    rerender(<SettingsModal {...props} session={{ ...session, sessionName: '已提交的旧名称' }} />)
    await act(async () => { saved.resolve(undefined); await saved.promise })
    expect(screen.getByPlaceholderText('未命名')).toBe(input)
    expect(input).toHaveValue('提交后的新编辑')
    expect(screen.queryByRole('button', { name: '已保存' })).not.toBeInTheDocument()
  })
})

describe('SettingsModal page-local resource lifetime', () => {
  it('remounts question/subagent settings and their independent model directory so failed reads can retry', async () => {
    const getQuestions = vi.fn<PionApi['getQuestionSettings']>()
      .mockRejectedValueOnce(new Error('question read unavailable')).mockResolvedValue({ timeoutMinutes: 22 })
    const getSubagents = vi.fn<PionApi['getSubagentSettings']>()
      .mockRejectedValueOnce(new Error('subagent read unavailable'))
      .mockResolvedValue({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 5 })
    const getModels = vi.fn<PionApi['getSubagentModels']>()
      .mockRejectedValueOnce(new Error('directory unavailable')).mockResolvedValue([])
    window.pion = {
      getQuestionSettings: getQuestions, setQuestionSettings: vi.fn<PionApi['setQuestionSettings']>(async (value) => value),
      getSubagentSettings: getSubagents, setSubagentSettings: vi.fn<PionApi['setSubagentSettings']>(async (value) => value),
      getSubagentModels: getModels
    } as unknown as PionApi
    const { rerender, props } = renderSettings({ navigationRequest: { id: 1, page: 'session' } })
    const question = screen.getByRole('spinbutton', { name: 'AI 提问等待时间（分钟）' })
    const subagent = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
    await screen.findByText('读取失败，未修改已保存设置；可修改后手动保存以修复。')
    await screen.findByText(/读取失败，可修改后保存以修复：Error: subagent read unavailable/)
    await screen.findByText('读取模型目录失败，请重新打开设置重试；已选默认模型保持不变。')
    fireEvent.change(question, { target: { value: '19' } })
    fireEvent.change(subagent, { target: { value: '7' } })

    rerender(<SettingsModal {...props} navigationRequest={{ id: 2, page: 'about' }} />)
    expect(question).not.toBeInTheDocument()
    expect(subagent).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 3, page: 'session' }} />)
    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: 'AI 提问等待时间（分钟）' })).toHaveValue(22)
      expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toHaveValue(5)
    })
    expect(screen.getByRole('spinbutton', { name: 'AI 提问等待时间（分钟）' })).not.toBe(question)
    expect(screen.queryByText(/读取模型目录失败/)).not.toBeInTheDocument()
    expect(getQuestions).toHaveBeenCalledTimes(2)
    expect(getSubagents).toHaveBeenCalledTimes(2)
    expect(getModels).toHaveBeenCalledTimes(2)

    const secondQuestion = screen.getByRole('spinbutton', { name: 'AI 提问等待时间（分钟）' })
    rerender(<SettingsModal {...props} open={false} navigationRequest={undefined} />)
    expect(secondQuestion).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 4, page: 'session' }} />)
    await waitFor(() => expect(getQuestions).toHaveBeenCalledTimes(3))
    expect(getSubagents).toHaveBeenCalledTimes(3)
    expect(getModels).toHaveBeenCalledTimes(3)
    expect(props.actions.listModelProviders).not.toHaveBeenCalled()
    expect(window.pion.setQuestionSettings).not.toHaveBeenCalled()
    expect(window.pion.setSubagentSettings).not.toHaveBeenCalled()
  })

  it('does not release the existing cross-unmount question write slot when a page is closed', async () => {
    const saved = deferred<{ timeoutMinutes: number | null }>()
    const setQuestions = vi.fn(() => saved.promise)
    window.pion = {
      getQuestionSettings: vi.fn(async () => ({ ...DEFAULT_QUESTION_SETTINGS })), setQuestionSettings: setQuestions,
      getSubagentSettings: vi.fn(async () => ({ ...DEFAULT_SUBAGENT_SETTINGS })),
      setSubagentSettings: vi.fn<PionApi['setSubagentSettings']>(async (value) => value)
    } as unknown as PionApi
    const { rerender, props } = renderSettings({ navigationRequest: { id: 1, page: 'session' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '保存提问设置' })).toBeEnabled())
    fireEvent.change(screen.getByRole('spinbutton', { name: 'AI 提问等待时间（分钟）' }), { target: { value: '22' } })
    fireEvent.click(screen.getByRole('button', { name: '保存提问设置' }))
    rerender(<SettingsModal {...props} open={false} />)
    rerender(<SettingsModal {...props} navigationRequest={{ id: 2, page: 'session' }} />)
    const pendingButton = await screen.findByRole('button', { name: '保存中…' })
    expect(pendingButton).toBeDisabled()
    fireEvent.click(pendingButton)
    expect(setQuestions).toHaveBeenCalledExactlyOnceWith({ timeoutMinutes: 22 })
    await act(async () => { saved.resolve({ timeoutMinutes: 22 }); await saved.promise })
    // The old component cannot publish into the new one; a fresh open reads the settled settings.
    rerender(<SettingsModal {...props} open={false} />)
    rerender(<SettingsModal {...props} navigationRequest={{ id: 3, page: 'session' }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存提问设置' })).toBeEnabled())
    expect(setQuestions).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsModal authentication navigation', () => {
  it.each(['login', 'logout'] as const)('only opens and filters the real Pi directory for %s', async (authIntent) => {
    const actions = settingsActions([{ ...provider, enabled: false }, otherProvider])
    renderSettings({ actions, navigationRequest: { id: 40, page: 'models', providerQuery: '  RUNTIME  ', authIntent } })
    expect(screen.getByRole('tab', { name: /Pi 提供商/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: '添加提供商' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toHaveValue('  RUNTIME  ')
    expect(await within(directory()).findByText(provider.id)).toBeInTheDocument()
    expect(within(directory()).queryByText(otherProvider.id)).not.toBeInTheDocument()
    expect(within(directory()).getByRole('status')).toHaveTextContent(authIntent === 'login'
      ? '请选择提供商的认证方式登录，不会自动登录。' : '请选择提供商的“退出”按钮登出，不会自动登出。')
    expect(within(directory()).getByRole('button', { name: '使用 Runtime 订阅登录' })).toBeEnabled()
    expect(within(directory()).getByRole('button', { name: 'API 密钥' })).toBeDisabled()
    expect(within(directory()).getByRole('button', { name: '退出 Runtime Provider' })).toBeEnabled()
    expect(within(directory()).getByRole('switch', { name: '显示 Runtime Provider 的模型' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument()
    expect(actions.listModelProviders).toHaveBeenCalledTimes(1)
    expectNoProviderMutation(actions)
  })

  it.each(['login', 'logout'] as const)('opens the unfiltered Pi catalog for bare %s without choosing an account or method', async (authIntent) => {
    const actions = settingsActions([provider, otherProvider])
    renderSettings({ actions, navigationRequest: { id: 1, page: 'models', authIntent } })
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toHaveValue('')
    expect(await within(directory()).findByText(provider.id)).toBeInTheDocument()
    expect(within(directory()).getByText(otherProvider.id)).toBeInTheDocument()
    expectNoProviderMutation(actions)
  })

  it('uses a provider-only navigation query without requiring an authentication intent', async () => {
    const actions = settingsActions([provider, otherProvider])
    renderSettings({ actions, navigationRequest: { id: 1, page: 'models', providerQuery: otherProvider.id } })
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toHaveValue(otherProvider.id)
    expect(await within(directory()).findByText(otherProvider.id)).toBeInTheDocument()
    expect(within(directory()).queryByText(provider.id)).not.toBeInTheDocument()
    expect(within(directory()).queryByRole('status')).not.toBeInTheDocument()
    expectNoProviderMutation(actions)
  })

  it('preserves same-id user search/tab choices and only a new id opens the Pi directory again', async () => {
    const actions = settingsActions([provider, otherProvider])
    const request: SettingsNavigationRequest = { id: 50, page: 'models', authIntent: 'login', providerQuery: provider.id }
    const { rerender, props } = renderSettings({ actions, navigationRequest: request })
    await within(directory()).findByText(provider.id)
    const search = screen.getByRole('textbox', { name: '搜索 Pi 提供商' })
    fireEvent.change(search, { target: { value: 'other-provider' } })
    search.focus()
    rerender(<SettingsModal {...props} navigationRequest={{ ...request }}
      session={{ ...session, sessionName: '迟到名称', isStreaming: true }} />)
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toBe(search)
    expect(search).toHaveValue('other-provider')
    expect(search).toHaveFocus()
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    const draft = screen.getByRole('textbox', { name: /提供商 ID/ })
    fireEvent.change(draft, { target: { value: 'custom-draft' } })
    rerender(<SettingsModal {...props} navigationRequest={{ ...request }} />)
    expect(screen.getByRole('tab', { name: /自定义 API/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: /提供商 ID/ })).toBe(draft)
    fireEvent.click(screen.getByRole('combobox', { name: 'API 类型' }))
    expect(screen.getByRole('listbox', { name: 'API 类型' })).toBeInTheDocument()

    rerender(<SettingsModal {...props} navigationRequest={{ ...request, id: 51, authIntent: 'logout' }} />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(draft).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Pi 提供商/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toHaveValue(provider.id)
    expect(within(directory()).getByRole('status')).toHaveTextContent('不会自动登出')
    expect(actions.listModelProviders).toHaveBeenCalledTimes(1)
    expectNoProviderMutation(actions)
  })

  it('remounts provider reads on page revisit and reopen without replaying a consumed auth request', async () => {
    const actions = settingsActions([provider, otherProvider])
    const request: SettingsNavigationRequest = { id: 1, page: 'models', authIntent: 'login', providerQuery: provider.id }
    const { rerender, props } = renderSettings({ actions, navigationRequest: request })
    await within(directory()).findByText(provider.id)
    const catalog = directory()
    const search = screen.getByRole('textbox', { name: '搜索 Pi 提供商' })
    fireEvent.change(search, { target: { value: otherProvider.id } })
    goToPage(/^关于 Pion/)
    expect(catalog).not.toBeInTheDocument()
    goToPage(/^模型与提供商/)
    expect(screen.queryByText('Pi 提供商目录')).not.toBeInTheDocument()
    await waitFor(() => expect(actions.listModelProviders).toHaveBeenCalledTimes(2))
    rerender(<SettingsModal {...props} open={false} />)
    expect(screen.queryByRole('navigation', { name: '设置分类' })).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ ...request, authIntent: 'logout' }} />)
    expect(screen.getByRole('heading', { name: '模型与提供商' })).toBeInTheDocument()
    expect(screen.queryByText('Pi 提供商目录')).not.toBeInTheDocument()
    await waitFor(() => expect(actions.listModelProviders).toHaveBeenCalledTimes(3))
    rerender(<SettingsModal {...props} navigationRequest={{ ...request, id: 2, authIntent: 'logout' }} />)
    expect(directory()).not.toBe(catalog)
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).not.toBe(search)
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toHaveValue(provider.id)
    expect(within(directory()).getByRole('status')).toHaveTextContent('不会自动登出')
    expectNoProviderMutation(actions)
  })

  it('does not reopen a manually closed directory or replay auth after navigating away and back', async () => {
    const actions = settingsActions([provider])
    const request: SettingsNavigationRequest = { id: 60, page: 'models', authIntent: 'login' }
    const { rerender, props } = renderSettings({ actions, navigationRequest: request })
    await within(directory()).findByText(provider.id)
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    rerender(<SettingsModal {...props} navigationRequest={{ ...request }} />)
    expect(screen.queryByText('Pi 提供商目录')).not.toBeInTheDocument()
    goToPage(/^关于 Pion/)
    goToPage(/^模型与提供商/)
    rerender(<SettingsModal {...props} navigationRequest={{ ...request }} />)
    expect(screen.queryByText('Pi 提供商目录')).not.toBeInTheDocument()
    expectNoProviderMutation(actions)
  })

  it('shows the ordinary no-match hint without guessing an id or authenticating', async () => {
    const actions = settingsActions([provider])
    renderSettings({ actions, navigationRequest: {
      id: 70, page: 'models', authIntent: 'login', providerQuery: 'not-in-runtime-catalog'
    } })
    expect(await within(directory()).findByText('没有匹配的提供商。')).toBeInTheDocument()
    expect(within(directory()).queryByRole('button', { name: /登录|退出/ })).not.toBeInTheDocument()
    expectNoProviderMutation(actions)
  })

  it.each(['agent', 'auth'] as const)('opens requested auth without bypassing the %s busy gate', async (busy) => {
    const actions = settingsActions([provider])
    renderSettings({ actions, agentBusy: busy === 'agent', modelProviderAuthState: busy === 'auth' ? {
      operationId: 'pending-auth', providerId: provider.id, providerName: provider.name,
      authType: 'oauth', phase: 'waiting', message: '等待已有登录', startedAt: 1
    } : null, navigationRequest: { id: 80, page: 'models', authIntent: 'logout' } })
    await within(directory()).findByText(provider.id)
    const login = within(directory()).getByRole('button', { name: '使用 Runtime 订阅登录' })
    const logout = within(directory()).getByRole('button', { name: '退出 Runtime Provider' })
    expect(login).toBeDisabled()
    expect(logout).toBeDisabled()
    fireEvent.click(login)
    fireEvent.click(logout)
    expectNoProviderMutation(actions)
  })

  it('keeps the original real action gate and rejects a late custom save closing a newer directory request', async () => {
    const pending = deferred<void>()
    const actions = settingsActions([provider])
    actions.addModelProvider = vi.fn(() => pending.promise)
    const { rerender, props } = renderSettings({ actions })
    await screen.findByRole('switch', { name: '显示 Runtime Provider 的模型' })
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    const draft = screen.getByRole('textbox', { name: /提供商 ID/ })
    fireEvent.change(draft, { target: { value: 'pending-custom' } })
    fireEvent.change(screen.getByRole('textbox', { name: /模型 ID/ }), { target: { value: 'custom-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并加载' }))
    const request: SettingsNavigationRequest = { id: 1, page: 'models', authIntent: 'login', providerQuery: provider.id }
    rerender(<SettingsModal {...props} navigationRequest={request} />)
    expect(draft).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ ...request, id: 2, authIntent: 'logout' }} />)
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    const logout = within(directory()).getByRole('button', { name: '退出 Runtime Provider' })
    expect(logout).toBeDisabled()
    fireEvent.click(logout)
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(directory()).toBeVisible()
    expect(screen.getByRole('textbox', { name: '搜索 Pi 提供商' })).toHaveValue(provider.id)
    expect(within(directory()).getByRole('status')).toHaveTextContent('不会自动登出')
    expect(actions.listModelProviders).toHaveBeenCalledTimes(2)
    expect(actions.addModelProvider).toHaveBeenCalledTimes(1)
    expect(actions.loginModelProvider).not.toHaveBeenCalled()
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()
    expect(actions.setModelProviderEnabled).not.toHaveBeenCalled()
    expect(actions.setModel).not.toHaveBeenCalled()
  })

  it.each(['page', 'close'] as const)('retains a pending provider write across %s unmount without keeping every page mounted', async (transition) => {
    const saved = deferred<void>()
    const actions = settingsActions([provider])
    actions.addModelProvider = vi.fn(() => saved.promise)
    const { rerender, props } = renderSettings({ actions })
    await screen.findByRole('switch', { name: '显示 Runtime Provider 的模型' })
    fireEvent.click(screen.getByRole('button', { name: '添加提供商' }))
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    const original = screen.getByRole('textbox', { name: /提供商 ID/ })
    fireEvent.change(original, { target: { value: 'pending-custom' } })
    fireEvent.change(screen.getByRole('textbox', { name: /模型 ID/ }), { target: { value: 'custom-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并加载' }))
    expect(actions.addModelProvider).toHaveBeenCalledTimes(1)
    if (transition === 'page') goToPage(/^关于 Pion/)
    else rerender(<SettingsModal {...props} open={false} />)
    expect(original).not.toBeInTheDocument()
    rerender(<SettingsModal {...props} navigationRequest={{ id: 2, page: 'models', authIntent: 'login' }} />)
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    expect(actions.listModelProviders).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('tab', { name: /自定义 API/ }))
    const fresh = screen.getByRole('textbox', { name: /提供商 ID/ })
    expect(fresh).not.toBe(original)
    expect(screen.getByRole('button', { name: '保存并加载' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存并加载' }))
    expect(actions.addModelProvider).toHaveBeenCalledTimes(1)
    await act(async () => { saved.resolve(undefined); await saved.promise })
    expect(screen.getByRole('textbox', { name: /提供商 ID/ })).toBe(fresh)
    expect(fresh).toBeEnabled()
    expect(actions.listModelProviders).toHaveBeenCalledTimes(2)
    expect(actions.addModelProvider).toHaveBeenCalledTimes(1)
    expect(actions.loginModelProvider).not.toHaveBeenCalled()
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps the existing owner-change gate until real auth settlement while new ids only navigate (reject=%s)', async (reject) => {
    const pending = deferred<ModelProviderInfo[]>()
    const freshCatalog = deferred<ModelProviderInfo[]>()
    const actions = settingsActions([provider])
    actions.loginModelProvider = vi.fn(() => pending.promise)
    const request: SettingsNavigationRequest = { id: 90, page: 'models', authIntent: 'login' }
    const { rerender, props } = renderSettings({ actions, navigationRequest: request })
    const login = await within(directory()).findByRole('button', { name: '使用 Runtime 订阅登录' })
    act(() => { fireEvent.click(login); fireEvent.click(login) })
    expect(actions.loginModelProvider).toHaveBeenCalledExactlyOnceWith(provider.id, 'oauth')
    rerender(<SettingsModal {...props} navigationRequest={{ ...request, id: 91, authIntent: 'logout' }} />)
    const logout = within(directory()).getByRole('button', { name: '退出 Runtime Provider' })
    expect(logout).toBeDisabled()
    fireEvent.click(logout)
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()

    const nextActions = { ...actions, listModelProviders: vi.fn(() => freshCatalog.promise) }
    rerender(<SettingsModal {...props} actions={nextActions}
      navigationRequest={{ ...request, id: 92, authIntent: 'logout', providerQuery: provider.id }} />)
    expect(nextActions.listModelProviders).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    await act(async () => {
      if (reject) pending.reject(new Error('旧 owner 迟到认证错误'))
      else pending.resolve([{ ...provider, name: '旧 owner 迟到目录' }])
      await pending.promise.catch(() => undefined)
    })
    expect(screen.queryByText('旧 owner 迟到认证错误')).not.toBeInTheDocument()
    expect(screen.queryByText('旧 owner 迟到目录')).not.toBeInTheDocument()
    expect(nextActions.listModelProviders).toHaveBeenCalledTimes(1)
    await act(async () => { freshCatalog.resolve([provider]); await freshCatalog.promise })
    expect(within(directory()).getByRole('button', { name: '退出 Runtime Provider' })).toBeEnabled()
    expect(actions.loginModelProvider).toHaveBeenCalledTimes(1)
    expect(actions.logoutModelProvider).not.toHaveBeenCalled()
  })
})

it('navigates trust to security without approving trust, changing policy or opening desktop observation', async () => {
  const computerUse = {
    getState: vi.fn(), onState: vi.fn(), start: vi.fn(), capture: vi.fn(), stop: vi.fn()
  }
  window.pion = { computerUse } as unknown as PionApi
  const { rerender, props } = renderSettings({
    projectTrust: { cwd: '/workspace/pion', requiresTrust: true, decision: 'untrusted', source: 'saved' },
    navigationRequest: { id: 100, page: 'security' }
  })
  expect(screen.getByRole('heading', { name: '安全与信任' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '信任项目' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '桌面观察（实验）' })).toBeInTheDocument()
  expect(document.querySelector('.computer-use-consent')).toBeNull()
  expect(props.actions.listModelProviders).not.toHaveBeenCalled()
  goToPage(/^关于 Pion/)
  rerender(<SettingsModal {...props} navigationRequest={{ id: 101, page: 'security' }} />)
  rerender(<SettingsModal {...props} open={false} />)
  await act(async () => undefined)
  expect(props.onProjectTrustChange).not.toHaveBeenCalled()
  expect(props.onToolPermissionChange).not.toHaveBeenCalled()
  expect(props.onToolPermissionReset).not.toHaveBeenCalled()
  for (const method of Object.values(computerUse)) expect(method).not.toHaveBeenCalled()
  expectNoProviderMutation(props.actions)
})
