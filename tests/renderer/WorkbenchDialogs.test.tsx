// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchDialogs as WorkbenchDialogsComponent } from '../../src/renderer/src/app/WorkbenchDialogs'
import { useDeferredMount } from '../../src/renderer/src/hooks/useDeferredMount'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'
import type { PionApi, SessionMeta } from '../../src/shared/types'

type Props = ComponentProps<typeof WorkbenchDialogsComponent>
const lazyKinds = ['taskHistory', 'capabilities', 'pluginStore', 'branch', 'settings'] as const
type LazyKind = typeof lazyKinds[number]

const historySession: SessionMeta = {
  path: '/sessions/previous.jsonl', id: 'previous', name: '历史会话', projectCwd: '/previous',
  timestamp: '2026-01-01T00:00:00Z', mtime: 1, preview: 'previous task', messageCount: 2
}

function defaultProps(): Props {
  const confirmation = () => ({ open: false, busy: false, error: '', onConfirm: vi.fn(), onCancel: vi.fn() })
  return {
    operations: {
      kind: null,
      onClose: vi.fn(),
      workflow: {
        cwd: '/repo', workflows: [], selected: null, loading: false, busy: false, error: '',
        onSelect: vi.fn(), onCreate: vi.fn(async () => undefined), onStart: vi.fn(async () => undefined),
        onApprovePlan: vi.fn(async () => undefined), onRepair: vi.fn(async () => undefined),
        onWaiveTests: vi.fn(async () => undefined), onResume: vi.fn(async () => undefined),
        onCancel: vi.fn(async () => undefined), onMerge: vi.fn(async () => undefined), onCleanup: vi.fn(async () => undefined)
      },
      verification: {
        plan: null, policy: null, run: null, activeRun: null, liveLog: '', loading: false, busy: false, error: '',
        onStart: vi.fn(), onRerun: vi.fn(), onCancel: vi.fn(), onPolicyChange: vi.fn(), onRepair: vi.fn()
      }
    },
    confirmations: {
      rollback: confirmation(), planModeExit: confirmation(), yolo: confirmation(),
      migration: { ...confirmation(), projectName: '目标项目' }
    },
    taskHistory: { mounted: false, dialog: { session: null, onClose: vi.fn() } },
    capabilities: { mounted: false, dialog: { open: false, onClose: vi.fn() } },
    pluginStore: { mounted: false, dialog: { open: false, onClose: vi.fn() } },
    branch: {
      mounted: false,
      dialog: { open: false, projectName: '分支项目', projectCwd: '/repo/worktree', onClose: vi.fn(), onSubmit: vi.fn(async () => undefined) }
    },
    settings: {
      mounted: false,
      dialog: {
        open: false, session: null, models: [], modelProviderAuthState: null, agentBusy: false,
        completionNotificationsEnabled: true, onCompletionNotificationsChange: vi.fn(),
        sessionPreviewDensity: 'compact', onSessionPreviewDensityChange: vi.fn(),
        historyNavGap: 10, onHistoryNavGapChange: vi.fn(), historyNavMaxVisible: 40, onHistoryNavMaxVisibleChange: vi.fn(),
        showMetricDuration: true, showMetricCost: false, onMetricDurationChange: vi.fn(), onMetricCostChange: vi.fn(),
        projectTrust: null, projectTrustBusy: false, projectTrustError: '', onProjectTrustChange: vi.fn(),
        toolPermissionPolicy: null, toolPermissionBusy: false, toolPermissionError: '',
        onToolPermissionChange: vi.fn(), onToolPermissionReset: vi.fn(), onClose: vi.fn(),
        actions: {
          setModel: vi.fn(async () => undefined), listModelProviders: vi.fn(async () => []),
          loginModelProvider: vi.fn(async () => []), logoutModelProvider: vi.fn(async () => []),
          cancelModelProviderAuth: vi.fn(async () => undefined), openModelProviderAuthUrl: vi.fn(async () => undefined),
          addModelProvider: vi.fn(async () => undefined), setAutoCompaction: vi.fn(async () => undefined),
          setAutoRetry: vi.fn(async () => undefined), compactNow: vi.fn(async () => undefined),
          exportSessionHtml: vi.fn(async () => '/tmp/session.html'), renameSession: vi.fn(async () => undefined),
          setSteeringMode: vi.fn(async () => undefined), setFollowUpMode: vi.fn(async () => undefined)
        }
      }
    }
  }
}

function openedProps(props: Props, open: readonly LazyKind[]): Props {
  return {
    ...props,
    taskHistory: { ...props.taskHistory, dialog: { ...props.taskHistory.dialog, session: open.includes('taskHistory') ? historySession : null } },
    capabilities: { ...props.capabilities, dialog: { ...props.capabilities.dialog, open: open.includes('capabilities') } },
    pluginStore: { ...props.pluginStore, dialog: { ...props.pluginStore.dialog, open: open.includes('pluginStore') } },
    branch: { ...props.branch, dialog: { ...props.branch.dialog, open: open.includes('branch') } },
    settings: { ...props.settings, dialog: { ...props.settings.dialog, open: open.includes('settings') } }
  }
}

// Probes measure composition identity, not the real panels' own open/reset effects.
function createProbe<P extends { onClose: () => void }>(name: LazyKind, isOpen: (props: P) => boolean) {
  const load = vi.fn()
  const mount = vi.fn()
  const unmount = vi.fn()
  const record = vi.fn<(props: P) => void>()
  function Probe(props: P) {
    const [draft, setDraft] = useState('')
    record(props)
    useEffect(() => {
      mount()
      return () => { unmount() }
    }, [])
    if (!isOpen(props)) return null
    return (
      <section data-testid={`${name}-probe`}>
        <input aria-label={`${name} draft`} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" onClick={props.onClose}>{name} close</button>
      </section>
    )
  }
  return { Component: Probe, load, mount, unmount, record }
}

function createProbes() {
  return {
    taskHistory: createProbe<Props['taskHistory']['dialog']>('taskHistory', (props) => props.session !== null),
    capabilities: createProbe<Props['capabilities']['dialog']>('capabilities', (props) => props.open),
    pluginStore: createProbe<Props['pluginStore']['dialog']>('pluginStore', (props) => props.open),
    branch: createProbe<Props['branch']['dialog']>('branch', (props) => props.open),
    settings: createProbe<Props['settings']['dialog']>('settings', (props) => props.open)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

describe('WorkbenchDialogs composition', () => {
  let WorkbenchDialogs: typeof WorkbenchDialogsComponent
  let probes: ReturnType<typeof createProbes>
  let pluginImportGate: Promise<void> | undefined
  let releasePluginImport: (() => void) | undefined
  let priorApi: PionApi | undefined

  // The same sticky gates remain owned by App; the assembly only consumes them.
  function DeferredHost(props: Props) {
    const taskHistoryMounted = useDeferredMount(props.taskHistory.dialog.session !== null)
    const capabilitiesMounted = useDeferredMount(props.capabilities.dialog.open)
    const pluginStoreMounted = useDeferredMount(props.pluginStore.dialog.open)
    const branchMounted = useDeferredMount(props.branch.dialog.open)
    const settingsMounted = useDeferredMount(props.settings.dialog.open)
    return (
      <WorkbenchDialogs {...props}
        taskHistory={{ ...props.taskHistory, mounted: taskHistoryMounted }}
        capabilities={{ ...props.capabilities, mounted: capabilitiesMounted }}
        pluginStore={{ ...props.pluginStore, mounted: pluginStoreMounted }}
        branch={{ ...props.branch, mounted: branchMounted }}
        settings={{ ...props.settings, mounted: settingsMounted }}
      />
    )
  }

  async function renderDeferred(props: Props) {
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<DeferredHost {...props} />) })
    return view
  }

  beforeEach(async () => {
    // Scope downstream mocks to this suite, including when coverage aggregates files.
    vi.resetModules()
    probes = createProbes()
    pluginImportGate = undefined
    releasePluginImport = undefined
    priorApi = window.pion
    window.pion = {
      getSubagentSettings: vi.fn(async () => ({ ...DEFAULT_SUBAGENT_SETTINGS })),
      setSubagentSettings: vi.fn<PionApi['setSubagentSettings']>(async (value) => value)
    } as unknown as PionApi
    vi.doMock('../../src/renderer/src/features/session/TaskHistoryPanel', () => {
      probes.taskHistory.load()
      return { TaskHistoryPanel: probes.taskHistory.Component }
    })
    vi.doMock('../../src/renderer/src/features/capabilities/SkillsToolsModal', () => {
      probes.capabilities.load()
      return { SkillsToolsModal: probes.capabilities.Component }
    })
    vi.doMock('../../src/renderer/src/features/capabilities/PluginStoreModal', async () => {
      probes.pluginStore.load()
      await pluginImportGate
      return { PluginStoreModal: probes.pluginStore.Component }
    })
    vi.doMock('../../src/renderer/src/features/project/BranchCreateModal', () => {
      probes.branch.load()
      return { BranchCreateModal: probes.branch.Component }
    })
    vi.doMock('../../src/renderer/src/features/settings/SettingsModal', () => {
      probes.settings.load()
      return { SettingsModal: probes.settings.Component }
    })
    WorkbenchDialogs = (await import('../../src/renderer/src/app/WorkbenchDialogs')).WorkbenchDialogs
  })

  afterEach(async () => {
    await act(async () => {
      releasePluginImport?.()
      await pluginImportGate
    })
    cleanup()
    vi.doUnmock('../../src/renderer/src/features/session/TaskHistoryPanel')
    vi.doUnmock('../../src/renderer/src/features/capabilities/SkillsToolsModal')
    vi.doUnmock('../../src/renderer/src/features/capabilities/PluginStoreModal')
    vi.doUnmock('../../src/renderer/src/features/project/BranchCreateModal')
    vi.doUnmock('../../src/renderer/src/features/settings/SettingsModal')
    vi.resetModules()
    if (priorApi === undefined) delete (window as unknown as { pion?: PionApi }).pion
    else window.pion = priorApi
  })

  it('loads each lazy child only on first demand and retains its host and draft across closes and other modal groups', async () => {
    const props = defaultProps()
    const { container, rerender } = render(<DeferredHost {...props} />)
    expect(container).toBeEmptyDOMElement()
    for (const probe of Object.values(probes)) {
      expect(probe.load).not.toHaveBeenCalled()
      expect(probe.mount).not.toHaveBeenCalled()
    }

    const opened = new Set<LazyKind>()
    for (const kind of lazyKinds) {
      await act(async () => { rerender(<DeferredHost {...openedProps(props, [kind])} />) })
      const input = await screen.findByRole('textbox', { name: `${kind} draft` })
      fireEvent.change(input, { target: { value: `${kind} unsaved` } })
      opened.add(kind)
      for (const other of lazyKinds) {
        expect(probes[other].load).toHaveBeenCalledTimes(opened.has(other) ? 1 : 0)
        expect(probes[other].mount).toHaveBeenCalledTimes(opened.has(other) ? 1 : 0)
        expect(probes[other].unmount).not.toHaveBeenCalled()
      }
    }

    const allOpen = openedProps(props, lazyKinds)
    rerender(<DeferredHost {...allOpen} />)
    const inputs = lazyKinds.map((kind) => screen.getByRole('textbox', { name: `${kind} draft` }))
    rerender(<DeferredHost {...allOpen}
      operations={{ ...props.operations, kind: 'agents' }}
      confirmations={{ ...props.confirmations, rollback: { ...props.confirmations.rollback, open: true } }}
    />)
    expect(screen.getByRole('dialog', { name: '隔离多 Agent' })).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    lazyKinds.forEach((kind, index) => {
      expect(screen.getByRole('textbox', { name: `${kind} draft` })).toBe(inputs[index])
      expect(inputs[index]).toHaveValue(`${kind} unsaved`)
    })

    rerender(<DeferredHost {...props} />)
    expect(container).toBeEmptyDOMElement()
    expect(probes.taskHistory.record.mock.calls.at(-1)?.[0].session).toBeNull()
    for (const kind of ['capabilities', 'pluginStore', 'branch', 'settings'] as const) {
      expect(probes[kind].record.mock.calls.at(-1)?.[0].open).toBe(false)
    }
    for (const probe of Object.values(probes)) expect(probe.unmount).not.toHaveBeenCalled()

    rerender(<DeferredHost {...allOpen} />)
    for (const kind of lazyKinds) {
      expect(screen.getByRole('textbox', { name: `${kind} draft` })).toHaveValue(`${kind} unsaved`)
      expect(probes[kind].mount).toHaveBeenCalledTimes(1)
      expect(probes[kind].load).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: `${kind} close` }))
      expect(props[kind].dialog.onClose).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps an already mounted dialog visible and focused while another lazy import is suspended', async () => {
    const pendingPlugin = deferred<void>()
    pluginImportGate = pendingPlugin.promise
    releasePluginImport = () => pendingPlugin.resolve(undefined)
    const props = defaultProps()
    const { rerender } = await renderDeferred(openedProps(props, ['settings']))
    const input = await screen.findByRole('textbox', { name: 'settings draft' })
    fireEvent.change(input, { target: { value: 'do not suspend me' } })
    input.focus()

    await act(async () => { rerender(<DeferredHost {...openedProps(props, ['settings', 'pluginStore'])} />) })
    await waitFor(() => expect(probes.pluginStore.load).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('pluginStore-probe')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'settings draft' })).toBe(input)
    expect(input).toBeVisible()
    expect(input).toHaveFocus()
    expect(input).toHaveValue('do not suspend me')
    expect(probes.settings.mount).toHaveBeenCalledTimes(1)

    await act(async () => { pendingPlugin.resolve(undefined); await pendingPlugin.promise })
    await screen.findByRole('textbox', { name: 'pluginStore draft' })
    expect(screen.getByRole('textbox', { name: 'settings draft' })).toBe(input)
    expect(probes.settings.unmount).not.toHaveBeenCalled()
  })

  it('forwards only the controlled child props, preserving settings actions and branch/session arguments', async () => {
    const props = openedProps(defaultProps(), ['taskHistory', 'branch', 'settings'])
    props.settings.dialog = {
      ...props.settings.dialog,
      session: { sessionId: 'current', sessionName: '当前会话', messageCount: 3, isStreaming: true },
      models: [{ id: 'model-id', provider: 'provider-id', contextWindow: 64000 }],
      modelProviderAuthState: {
        operationId: 'auth', providerId: 'provider-id', providerName: 'Provider', authType: 'oauth',
        phase: 'waiting', message: '请完成认证', startedAt: 1
      },
      agentBusy: true, completionNotificationsEnabled: false, sessionPreviewDensity: 'detailed',
      historyNavGap: 6, historyNavMaxVisible: 24, showMetricDuration: false, showMetricCost: true,
      projectTrust: { cwd: '/repo', requiresTrust: true, decision: 'ask', source: 'default' },
      projectTrustBusy: true, projectTrustError: '信任设置失败',
      toolPermissionPolicy: {
        cwd: '/repo', source: 'saved', rules: { read: 'allow', write: 'ask', shell: 'deny', network: 'ask', external: 'deny' }
      },
      toolPermissionBusy: true, toolPermissionError: '权限设置失败'
    }
    const { rerender } = await renderDeferred(props)
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(3))
    const settings = probes.settings.record.mock.calls.at(-1)![0]
    expect(settings).toEqual(props.settings.dialog)
    expect(settings.actions).toBe(props.settings.dialog.actions)
    expect(settings.onToolPermissionChange).toBe(props.settings.dialog.onToolPermissionChange)
    expect(settings.onCompletionNotificationsChange).toBe(props.settings.dialog.onCompletionNotificationsChange)
    expect(probes.taskHistory.record.mock.calls.at(-1)![0].session).toBe(historySession)
    expect(probes.branch.record.mock.calls.at(-1)![0]).toEqual(props.branch.dialog)

    rerender(<DeferredHost {...props} branch={{ ...props.branch, dialog: { ...props.branch.dialog, projectName: undefined } }} />)
    expect(probes.branch.record.mock.calls.at(-1)![0]).toEqual({ ...props.branch.dialog, projectName: '当前项目' })
  })

  it.each([
    ['rollback', '撤销本轮修改', '确认撤销', '发送前已有的暂存', 'accent'],
    ['planModeExit', '确认进入构建模式', '切换到构建模式', '仍需发送下一条执行请求', 'accent'],
    ['yolo', '确认开启 YOLO 模式', '开启 YOLO', '不会写入项目权限规则', 'danger'],
    ['migration', '迁移会话到项目', '迁移', '运行中的会话需要先等待完成', 'accent']
  ] as const)('wires the %s confirmation copy, errors, busy state and explicit callbacks', (kind, title, label, detail, tone) => {
    const props = defaultProps()
    const controlled = props.confirmations[kind]
    const confirmations = { ...props.confirmations, [kind]: { ...controlled, open: true } }
    const { container, rerender } = render(<WorkbenchDialogs {...props} confirmations={confirmations} />)
    const dialog = screen.getByRole('alertdialog', { name: title })
    expect(container).toBeEmptyDOMElement() // ConfirmDialog still owns its portal.
    expect(dialog).toHaveClass(`confirm-dialog-${tone}`)
    expect(dialog).toHaveTextContent(detail)
    if (kind === 'migration') expect(dialog).toHaveTextContent('将会话迁移到 目标项目？')
    fireEvent.click(within(dialog).getByRole('button', { name: label }))
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(controlled.onConfirm).toHaveBeenCalledTimes(1)
    expect(controlled.onCancel).toHaveBeenCalledTimes(1)
    expect(dialog).toBeInTheDocument() // The assembly does not take ownership of open state.

    rerender(<WorkbenchDialogs {...props} confirmations={{ ...confirmations, [kind]: { ...controlled, open: true, busy: true, error: `${kind} failed` } }} />)
    expect(dialog).toHaveTextContent(`${kind} failed`)
    expect(dialog).not.toHaveTextContent(detail)
    expect(within(dialog).getByRole('button', { name: '处理中…' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: '处理中…' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(controlled.onConfirm).toHaveBeenCalledTimes(1)
    expect(controlled.onCancel).toHaveBeenCalledTimes(1)

    rerender(<WorkbenchDialogs {...props} confirmations={confirmations} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(controlled.onCancel).toHaveBeenCalledTimes(2)
    rerender(<WorkbenchDialogs {...props} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('switches the existing embedded operations panels and forwards repair without inventing a close action', () => {
    const props = defaultProps()
    const operations: Props['operations'] = {
      ...props.operations,
      kind: 'agents',
      workflow: { ...props.operations.workflow, busy: true, error: '工作流读取失败' },
      verification: {
        ...props.operations.verification,
        run: {
          id: 'failed-run', cwd: '/repo', state: 'failed', createdAt: 1, steps: [], selectedKinds: ['test'],
          repairAttempt: 0, repairPrompt: '请修复失败的测试', revision: 1
        },
        liveLog: 'latest verification output', error: '验证失败'
      }
    }
    const { container, rerender } = render(<WorkbenchDialogs {...props} operations={operations} />)
    const dialog = screen.getByRole('dialog', { name: '隔离多 Agent' })
    expect(container).toBeEmptyDOMElement()
    expect(dialog.querySelector('.workflow-panel')).toHaveClass('embedded')
    expect(dialog).toHaveTextContent('工作流读取失败')
    for (const button of within(dialog).getAllByRole('button', { name: '新工作流' })) expect(button).toBeDisabled()

    rerender(<WorkbenchDialogs {...props} operations={{ ...operations, workflow: { ...operations.workflow, busy: false, error: '' } }} />)
    fireEvent.click(within(dialog).getAllByRole('button', { name: '新工作流' })[0])
    const draft = screen.getByPlaceholderText(/Planner、Implementer/)
    fireEvent.change(draft, { target: { value: 'keep workflow goal' } })
    rerender(<WorkbenchDialogs {...props} operations={{ ...operations, workflow: { ...operations.workflow, busy: false, error: 'late status' } }} />)
    expect(screen.getByPlaceholderText(/Planner、Implementer/)).toBe(draft)
    expect(draft).toHaveValue('keep workflow goal')

    rerender(<WorkbenchDialogs {...props} operations={{ ...operations, kind: 'verification' }} />)
    const verificationDialog = screen.getByRole('dialog', { name: '项目自动验证' })
    expect(verificationDialog).toBe(dialog)
    expect(screen.queryByPlaceholderText(/Planner、Implementer/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('自动验证')).toHaveClass('embedded')
    expect(verificationDialog).toHaveTextContent('latest verification output')
    expect(verificationDialog).toHaveTextContent('验证失败')
    fireEvent.click(screen.getByRole('button', { name: '交给 Agent 修复' }))
    expect(operations.verification.onRepair).toHaveBeenCalledExactlyOnceWith('请修复失败的测试')
    expect(operations.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '关闭项目自动验证' }))
    expect(operations.onClose).toHaveBeenCalledTimes(1)
    rerender(<WorkbenchDialogs {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps real settings drafts on sibling updates and pending operations through close and reopen', async () => {
    // Use the actual SettingsModal for its own reset-on-open and async-state behavior.
    vi.doUnmock('../../src/renderer/src/features/settings/SettingsModal')
    const compacted = deferred<void>()
    const exported = deferred<string>()
    const props = defaultProps()
    props.settings.dialog.session = { sessionId: 'current', sessionName: '原会话名称', messageCount: 2, isStreaming: false }
    props.settings.dialog.actions.compactNow = vi.fn(() => compacted.promise)
    props.settings.dialog.actions.exportSessionHtml = vi.fn(() => exported.promise)
    const { rerender } = await renderDeferred(openedProps(props, ['settings']))
    const sessionPage = () => fireEvent.click(within(screen.getByRole('navigation', { name: '设置分类' })).getByRole('button', { name: /^会话/ }))
    try {
      await screen.findByRole('navigation', { name: '设置分类' })
      sessionPage()
      const input = screen.getByPlaceholderText('未命名')
      fireEvent.change(input, { target: { value: '尚未保存的名称' } })
      input.focus()
      await act(async () => { rerender(<DeferredHost {...openedProps(props, ['settings', 'capabilities'])} />) })
      await screen.findByRole('textbox', { name: 'capabilities draft' })
      expect(screen.getByPlaceholderText('未命名')).toBe(input)
      expect(input).toHaveValue('尚未保存的名称')
      expect(input).toHaveFocus()
      fireEvent.click(screen.getByRole('button', { name: /立即压缩/ }))
      fireEvent.click(screen.getByRole('button', { name: /导出 HTML/ }))
      expect(props.settings.dialog.actions.compactNow).toHaveBeenCalledTimes(1)
      expect(props.settings.dialog.actions.exportSessionHtml).toHaveBeenCalledTimes(1)

      rerender(<DeferredHost {...openedProps(props, ['capabilities'])} />)
      expect(screen.queryByRole('navigation', { name: '设置分类' })).not.toBeInTheDocument()
      rerender(<DeferredHost {...openedProps(props, ['settings', 'capabilities'])} />)
      sessionPage()
      // Preserve the child's existing open-transition reset, not a new assembly policy.
      expect(screen.getByPlaceholderText('未命名')).toHaveValue('原会话名称')
      expect(screen.getByRole('button', { name: /压缩中/ })).toBeDisabled()
      expect(screen.getByRole('button', { name: /导出 HTML/ })).toBeDisabled()
      await act(async () => {
        compacted.resolve(undefined)
        exported.resolve('/tmp/retained-session.html')
        await Promise.all([compacted.promise, exported.promise])
      })
      expect(screen.getByRole('button', { name: /立即压缩/ })).toBeEnabled()
      expect(screen.getByRole('button', { name: /导出 HTML/ })).toBeEnabled()
      expect(screen.getByText('/tmp/retained-session.html')).toBeInTheDocument()
      expect(props.settings.dialog.actions.compactNow).toHaveBeenCalledTimes(1)
      expect(props.settings.dialog.actions.exportSessionHtml).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => {
        compacted.resolve(undefined)
        exported.resolve('/tmp/retained-session.html')
        await Promise.all([compacted.promise, exported.promise])
      })
    }
  })
})
