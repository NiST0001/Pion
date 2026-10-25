// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, type AgentState } from '../../src/renderer/src/agent/types'
import type { ExtensionUiRequest, SessionMeta, ToolPermissionRequest } from '../../src/shared/types'
import { isSessionInteractionRequest } from '../../src/renderer/src/hooks/useAppInteractionState'
import type { SubagentSessionList, SubagentSessionSnapshot, SubagentSessionSummary } from '../../src/shared/subagent-sessions'
import type { PionApi } from '../../src/shared/pion-api'

// This renders the real App, Sidebar/SessionItems, ChatTimeline/ChatMessage,
// Markdown, tool cards, Composer and both conversation-navigation instances.
// Only the backend owner and unrelated resource hooks/dialogs are substituted.
// The real readonly observer uses an entirely in-memory, mocked IPC API below;
// no SDK, network, filesystem or existing user configuration is consulted.
const owner = { value: null as unknown }
const interactionRequests = { current: [] as ExtensionUiRequest[] }
const permissionRequests = { current: [] as ToolPermissionRequest[] }
const resolveInteraction = vi.fn()
const resolvePermission = vi.fn()
let App: typeof import('../../src/renderer/src/App').App

// Keep registrations suite-local: coverage/all imports multiple suites in one
// isolate, so hoisted mocks would replace the real hooks in unrelated tests.
const mockModules = [
  '../../src/renderer/src/hooks/useAgent',
  '../../src/renderer/src/hooks/useWindowEffects',
  '../../src/renderer/src/hooks/useSessionResourceStage',
  '../../src/renderer/src/hooks/useRunTelemetry',
  '../../src/renderer/src/hooks/useRunRecovery',
  '../../src/renderer/src/hooks/useVerification',
  '../../src/renderer/src/hooks/useWorkflows',
  '../../src/renderer/src/hooks/useGitWorkspace',
  '../../src/renderer/src/hooks/usePanelLayout',
  '../../src/renderer/src/hooks/useDockLayout',
  '../../src/renderer/src/hooks/useAppInteractionState',
  '../../src/renderer/src/hooks/useMessageRevert',
  '../../src/renderer/src/hooks/useSessionModes',
  '../../src/renderer/src/app/WorkbenchDialogs',
  '../../src/renderer/src/features/chrome/TitleBar',
  '../../src/renderer/src/features/chrome/DockHeader',
  '../../src/renderer/src/features/operations/ToolPermissionModal',
  '../../src/renderer/src/features/operations/RunMetricsStrip',
  '../../src/renderer/src/features/session/HistoryNavigator',
  '../../src/renderer/src/features/operations/RunRecoveryBanner'
] as const

const cwd = '/project'
const parentPath = '/parent.jsonl'
const otherPath = '/other.jsonl'
const summary: SubagentSessionSummary = {
  id: 'child', backendId: 'backend', runtimeId: 'runtime', parentToolCallId: 'delegation',
  parentSessionId: 'parent', parentSessionPath: parentPath, cwd,
  name: '代码检查', status: 'completed', revision: 1, truncated: false
}
const snapshot: SubagentSessionSnapshot = {
  ...summary,
  rows: [
    { id: 'message-1-thinking', kind: 'thinking', text: '检查边界与竞态' },
    { id: 'message-1-text', kind: 'assistant', text: '**普通回复**\n\n- 检查完成\n\n![不可加载图片](https://example.test/private.png)\n\n[不可访问链接](https://example.test)' },
    { id: 'tool-2', kind: 'tool', toolName: 'read', text: '读取工具的纯文字结果', state: 'completed' }
  ]
}
function session(path: string, name: string): SessionMeta {
  return { path, id: path, name, projectCwd: cwd, timestamp: '2026-01-01T00:00:00Z',
    mtime: 1, preview: name, messageCount: 1 }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(phase: AgentState['status']['phase'] = 'running') {
  const sessions = [session(parentPath, '父任务'), session(otherPath, '另一个普通会话')]
  const state: AgentState = {
    ...initialState, status: { phase, cwd },
    session: { sessionId: 'parent', sessionFile: parentPath, sessionName: '父任务', isStreaming: false, messageCount: 1 },
    timelineReady: true, liveSessionOwnerPath: parentPath,
    timeline: [{ kind: 'user', id: 101, text: '父历史消息', entryId: 'parent-entry' }],
    sessions, sessionsByProject: { [cwd]: sessions }, projects: [{ cwd, name: '项目', addedAt: 1, lastUsedAt: 1 }],
    tasks: [{ id: '1', title: '父目标', status: 'in_progress' }],
    queued: { steering: 0, followUp: 1 },
    queuedMessages: { steering: [], followUp: ['父排队消息'], nativeFollowUpCount: 0 }
  }
  const actions = {
    bootstrap: vi.fn(async () => {}), switchSession: vi.fn(async () => ({ cancelled: false })),
    start: vi.fn(async () => {}), reloadTimeline: vi.fn(async () => {}),
    loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {}), hasNewerHistory: vi.fn(() => false),
    send: vi.fn(async () => {}), queue: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    setModel: vi.fn(), setThinkingLevel: vi.fn(), setSubagentsMode: vi.fn()
  }
  owner.value = { state, actions, selectionRef: { current: { generation: 1, ownerPath: parentPath } }, hasBridge: true }
  let listener: ((list: SubagentSessionList) => void) | undefined
  const apiMocks = {
    listSubagentSessions: vi.fn(async (): Promise<SubagentSessionList> => ({ revision: 1, sessions: [summary] })),
    getSubagentSession: vi.fn(async (): Promise<SubagentSessionSnapshot | null> => snapshot),
    onSubagentSessions: vi.fn((callback: (list: SubagentSessionList) => void) => { listener = callback; return vi.fn() })
  }
  // Every window.pion method is an in-memory mock, including accidental calls
  // outside the expected three observer methods. No real preload is retained.
  const fallback = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const api = new Proxy(apiMocks, { get(target, key) {
    if (key in target) return target[key as keyof typeof target]
    if (!fallback.has(key)) fallback.set(key, vi.fn(async () => undefined))
    return fallback.get(key)
  } }) as unknown as PionApi
  vi.stubGlobal('pion', api)
  return { state, actions, apiMocks, fallback, push: (list: SubagentSessionList) => listener?.(list) }
}

async function paint() { await act(async () => {}) }
function row(container: HTMLElement, path: string) {
  const element = container.querySelector<HTMLElement>(`[data-session-path="${path}"]`)
  expect(element).not.toBeNull()
  return element!
}
function childScroll(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>('.child-chat-scroll')
  expect(element).not.toBeNull()
  return element!
}
function expectNoParentBackendAction(actions: ReturnType<typeof setup>['actions']) {
  expect(actions.switchSession).not.toHaveBeenCalled()
  expect(actions.start).not.toHaveBeenCalled()
  expect(actions.reloadTimeline).not.toHaveBeenCalled()
  expect(actions.send).not.toHaveBeenCalled()
  expect(actions.queue).not.toHaveBeenCalled()
  expect(actions.abort).not.toHaveBeenCalled()
}

describe('App readonly subagent conversation in the ordinary chat surface', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../src/renderer/src/hooks/useAgent', () => ({ useAgent: () => owner.value }))
    vi.doMock('../../src/renderer/src/hooks/useWindowEffects', () => ({ useWindowEffects: vi.fn() }))
    vi.doMock('../../src/renderer/src/hooks/useSessionResourceStage', () => ({ useSessionResourceStage: () => 0 }))
    vi.doMock('../../src/renderer/src/hooks/useRunTelemetry', () => ({ useRunTelemetry: () => ({ runs: [], activeRun: null, latestRun: null }) }))
    vi.doMock('../../src/renderer/src/hooks/useRunRecovery', () => ({ useRunRecovery: () => ({ candidates: [] }) }))
    vi.doMock('../../src/renderer/src/hooks/useVerification', () => ({ useVerification: () => ({}) }))
    vi.doMock('../../src/renderer/src/hooks/useWorkflows', () => ({ useWorkflows: () => ({ workflows: [] }) }))
    vi.doMock('../../src/renderer/src/hooks/useGitWorkspace', () => ({ useGitWorkspace: () => ({ snapshot: null }) }))
    vi.doMock('../../src/renderer/src/hooks/usePanelLayout', () => ({ usePanelLayout: () => ({
      maximized: false, sidebarOpen: true, reviewOpen: false, setSidebarOpen: vi.fn(), setReviewOpen: vi.fn(),
      terminalOpen: false, setTerminalOpen: vi.fn(), browserOpen: false, setBrowserOpen: vi.fn(),
      gitCommitTreeOpen: false, setGitCommitTreeOpen: vi.fn(), resetPanelVisibility: vi.fn()
    }) }))
    vi.doMock('../../src/renderer/src/hooks/useDockLayout', () => ({ useDockLayout: () => ({
      rootRef: { current: null }, panelProps: () => ({}), dragProps: () => ({}), dividers: [],
      movePanel: vi.fn(), reset: vi.fn(), clearDrop: vi.fn()
    }) }))
    vi.doMock('../../src/renderer/src/hooks/useAppInteractionState', () => ({
      isSessionInteractionRequest,
      useAppInteractionState: () => ({
        projectTrust: null, toolPermissionRequests: permissionRequests.current, extensionUiRequests: interactionRequests.current,
        toolPermissionResolutions: new Map(), handleToolPermissionResolve: resolvePermission,
        extensionUiResolutions: new Map(), handleExtensionUiResolve: resolveInteraction
      })
    }))
    vi.doMock('../../src/renderer/src/hooks/useMessageRevert', () => ({ useMessageRevert: () => ({
      draftFrozen: false, canRevert: false,
      onDraftAvailabilityChange: vi.fn(), onRestoreDraftConsumed: vi.fn()
    }) }))
    vi.doMock('../../src/renderer/src/hooks/useSessionModes', () => ({ useSessionModes: () => ({
      handleModeChange: vi.fn(), requestYoloMode: vi.fn()
    }) }))
    vi.doMock('../../src/renderer/src/app/WorkbenchDialogs', () => ({ WorkbenchDialogs: () => null }))
    vi.doMock('../../src/renderer/src/features/chrome/TitleBar', () => ({ TitleBar: () => null }))
    vi.doMock('../../src/renderer/src/features/chrome/DockHeader', () => ({ DockHeader: () => null }))
    vi.doMock('../../src/renderer/src/features/operations/ToolPermissionModal', () => ({ ToolPermissionModal: () => null }))
    // Sentinels expose parent-only controls without live telemetry/history;
    // actual task/queue/Composer controls and ordinary navigation stay real.
    vi.doMock('../../src/renderer/src/features/operations/RunMetricsStrip', () => ({
      RunMetricsStrip: () => <div data-testid="parent-metrics">父统计</div>
    }))
    vi.doMock('../../src/renderer/src/features/session/HistoryNavigator', () => ({
      HistoryNavigator: () => <nav data-testid="parent-history">父历史导航</nav>
    }))
    vi.doMock('../../src/renderer/src/features/operations/RunRecoveryBanner', () => ({ RunRecoveryBanner: () => null }))
    ;({ App } = await import('../../src/renderer/src/App'))
    // The real App imports the complete renderer graph; concurrent suites can
    // exceed the default 30s transform hook limit. Keep this bounded and local;
    // render failures and per-test deadlines still fail normally.
  }, 90_000)
  afterAll(() => {
    for (const module of mockModules) vi.doUnmock(module)
    vi.resetModules()
  })
  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    // JSDOM has no layout; navigation still owns real independent refs/listeners.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  })
  afterEach(() => {
    cleanup()
    owner.value = null
    interactionRequests.current = []
    permissionRequests.current = []
    resolveInteraction.mockReset()
    resolvePermission.mockReset()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('opens from the real session list and uses ordinary bubbles, Markdown, thinking and tool cards', async () => {
    const f = setup()
    const view = render(<App />)
    await paint()
    // Ordinary parent history may fill on its initial mount; child selection
    // and child scrolling must not cause any additional parent page requests.
    const olderCalls = f.actions.loadOlder.mock.calls.length
    const newerCalls = f.actions.loadNewer.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    await paint()
    const child = childScroll(view.container)
    expect(child).toHaveClass('chat-scroll')
    const parent = view.container.querySelector<HTMLElement>('.chat-scroll:not(.child-chat-scroll)')!
    expect(child).not.toBe(parent)
    parent.scrollTop = 75
    child.scrollTop = 10
    fireEvent.scroll(child)
    expect(parent.scrollTop).toBe(75)
    expect(f.actions.loadOlder).toHaveBeenCalledTimes(olderCalls)
    expect(f.actions.loadNewer).toHaveBeenCalledTimes(newerCalls)
    expect(child.querySelector('.timeline .bubble-assistant .markdown strong')).toHaveTextContent('普通回复')
    expect(child.querySelector('.markdown li')).toHaveTextContent('检查完成')
    const thinking = child.querySelector<HTMLDetailsElement>('details.thinking')!
    expect(thinking).not.toHaveAttribute('open')
    expect(thinking.querySelector('pre')).toHaveTextContent('检查边界与竞态')
    // JSDOM does not implement summary's native default action; toggle the
    // actual ordinary details element, rather than faking a child-only widget.
    thinking.open = true
    fireEvent(thinking, new Event('toggle'))
    expect(thinking).toHaveAttribute('open')
    fireEvent.click(within(child).getByRole('button', { name: '展开工具调用（1次）' }))
    const tool = within(child).getByRole('button', { name: '展开读取工具详情' })
    fireEvent.click(tool)
    expect(child.querySelector('.tool-body .tool-output')).toHaveTextContent('读取工具的纯文字结果')
    expect(child.querySelector('img,a,iframe,textarea,[data-entry-id],.message-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: /返回父/ })).not.toBeInTheDocument()
    expect(view.container.querySelector('.subagent-session-pane')).toBeNull()
    expect(f.apiMocks.getSubagentSession).toHaveBeenCalledWith('child', 'backend')
    expectNoParentBackendAction(f.actions)
    expect(f.fallback.size).toBe(0)
  })

  it('keeps pending questions in their own sessions, preserves drafts, and projects the shared blue markers', async () => {
    const f = setup()
    const questions: ExtensionUiRequest[] = [parentPath, otherPath].map((sessionPath, index) => ({
      id: `question-${index}`, cwd, sessionPath, method: 'editor', title: `会话问题 ${index}`,
      question: true, createdAt: 1, timeoutAt: null
    }))
    interactionRequests.current = questions
    const view = render(<App />)
    await paint()
    expect(screen.queryByRole('region', { name: questions[1].title })).not.toBeInTheDocument()
    for (const path of [parentPath, otherPath]) {
      expect(row(view.container, path).querySelector('.side-session-unread-indicator')).toHaveClass('attention')
    }
    expect(screen.getByRole('button', { name: /Agent 提问/ })).toHaveAttribute('aria-expanded', 'true')
    const answerA = screen.getByRole('textbox', { name: questions[0].title })
    fireEvent.change(answerA, { target: { value: 'A 未提交回答' } })
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    await paint()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    fireEvent.click(row(view.container, otherPath))
    await paint()
    expect(screen.queryByRole('region', { name: questions[0].title })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Agent 提问/ })).toHaveAttribute('aria-expanded', 'true')
    const answerB = screen.getByRole('textbox', { name: questions[1].title })
    fireEvent.change(answerB, { target: { value: 'B 回答' } })
    fireEvent.click(screen.getByRole('button', { name: /提交回答/ }))
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(questions[1].id, { value: 'B 回答' })
    fireEvent.click(row(view.container, parentPath))
    await paint()
    expect(screen.getByRole('textbox', { name: questions[0].title })).toBe(answerA)
    expect(answerA).toHaveValue('A 未提交回答')
    expect(answerB).toHaveValue('B 回答')
    expect(row(view.container, parentPath).querySelector('.attention')).not.toBeNull()
    interactionRequests.current = []
    view.rerender(<App />)
    expect(view.container.querySelector('.side-session-unread-indicator')).toBeNull()
    expect(view.container.querySelector('.extension-ui-backdrop')).toBeNull()
    expect(f.actions.abort).not.toHaveBeenCalled()
  })

  it('deduplicates pending sessions and quick-jumps to an uncached project using its original request owner', async () => {
    const f = setup()
    const remoteCwd = '/uncached-project'
    const remotePath = '/uncached-project/sessions/remote.jsonl'
    const remoteTitle = '跨项目待处理请求'
    const parentQuestion: ExtensionUiRequest = {
      id: 'parent-question', cwd, sessionPath: parentPath, method: 'editor', title: '父会话提问',
      question: true, createdAt: 1, timeoutAt: null
    }
    const remoteQuestion: ExtensionUiRequest = {
      ...parentQuestion, id: 'remote-question', cwd: remoteCwd, sessionPath: remotePath, title: remoteTitle
    }
    const permission: ToolPermissionRequest = {
      id: 'remote-permission', cwd: remoteCwd, sessionPath: remotePath, toolName: 'bash',
      category: 'shell', policyCategories: ['shell'], summary: remoteTitle, detail: '等待明确授权',
      risks: [], canRemember: false, createdAt: 1, timeoutAt: Date.now() + 120_000
    }
    interactionRequests.current = [parentQuestion, remoteQuestion, {
      ...parentQuestion, id: 'global-auth', cwd: '/auth-only', sessionPath: '/auth-only.jsonl',
      title: '全局认证请求', source: 'provider-auth', scope: 'global', question: false
    }]
    permissionRequests.current = [permission]
    expect(f.state.sessionsByProject[remoteCwd]).toBeUndefined()
    const view = render(<App />)
    await paint()
    const draft = view.container.querySelector<HTMLTextAreaElement>('.composer textarea')!
    fireEvent.change(draft, { target: { value: '跨项目前保留的父草稿' } })
    fireEvent.click(screen.getByRole('button', { name: /待处理请求.*2.*个会话/ }))
    const requests = screen.getByRole('region', { name: '待处理请求会话' })
    expect(within(requests).getAllByRole('button')).toHaveLength(2)
    expect(within(requests).queryByText('全局认证请求')).not.toBeInTheDocument()
    const remoteButton = within(requests).getByText(remoteTitle).closest('button')!
    expect(remoteButton).not.toBeNull()
    expectNoParentBackendAction(f.actions)
    expect(resolveInteraction).not.toHaveBeenCalled()
    expect(resolvePermission).not.toHaveBeenCalled()
    expect(view.container.querySelector('.composer textarea')).toBe(draft)
    expect(draft).toHaveValue('跨项目前保留的父草稿')

    fireEvent.click(remoteButton)
    await paint()
    expect(f.actions.switchSession).toHaveBeenCalledExactlyOnceWith(remotePath, remoteCwd)
    expect(f.actions.start).not.toHaveBeenCalled()
    expect(f.actions.send).not.toHaveBeenCalled()
    expect(resolveInteraction).not.toHaveBeenCalled()
    expect(resolvePermission).not.toHaveBeenCalled()
    expect(interactionRequests.current).toContain(remoteQuestion)
    expect(permissionRequests.current).toEqual([permission])
    expect(screen.getByRole('button', { name: /待处理请求.*2.*个会话/ })).toBeInTheDocument()
  })

  it('quick-jumps from a child view to its pending parent without switching the SDK or losing mounted drafts', async () => {
    const f = setup()
    const question: ExtensionUiRequest = {
      id: 'pending-parent', cwd, sessionPath: parentPath, method: 'editor', title: '父会话仍待回答',
      question: true, createdAt: 1, timeoutAt: null
    }
    interactionRequests.current = [question]
    const view = render(<App />)
    await paint()
    const draft = view.container.querySelector<HTMLTextAreaElement>('.composer textarea')!
    const parentBubble = view.container.querySelector('.bubble-user')
    const answer = screen.getByRole('textbox', { name: question.title })
    fireEvent.change(draft, { target: { value: '快跳保留的父草稿' } })
    fireEvent.change(answer, { target: { value: '尚未提交的问题草稿' } })
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    await paint()
    expect(childScroll(view.container)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /待处理请求.*1.*个会话/ }))
    const requests = screen.getByRole('region', { name: '待处理请求会话' })
    expectNoParentBackendAction(f.actions)
    expect(resolveInteraction).not.toHaveBeenCalled()
    fireEvent.click(within(requests).getByText('父任务').closest('button')!)
    await paint()
    expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    expect(view.container.querySelector('.bubble-user')).toBe(parentBubble)
    expect(view.container.querySelector('.composer textarea')).toBe(draft)
    expect(draft).toBeVisible()
    expect(draft).toHaveValue('快跳保留的父草稿')
    expect(screen.getByRole('textbox', { name: question.title })).toBe(answer)
    expect(answer).toHaveValue('尚未提交的问题草稿')
    expect(interactionRequests.current).toEqual([question])
    expect(row(view.container, parentPath).querySelector('.attention')).not.toBeNull()
    expectNoParentBackendAction(f.actions)
    expect(resolveInteraction).not.toHaveBeenCalled()
    expect(resolvePermission).not.toHaveBeenCalled()
  })

  it('routes ordinary chat links through the existing internal browser without touching the parent backend', async () => {
    const f = setup()
    const first = 'https://github.com/NiST0001/Pion/actions'
    const second = 'https://github.com/NiST0001/Pion/releases/tag/v0.1.71'
    f.state.timeline = [{ kind: 'assistant', id: 150, text: `[查看构建流程](${first})\n\n[查看发布页面](${second})`, thinking: '', streaming: false }]
    const view = render(<App />)
    await paint()
    expect(view.container.querySelector('webview')).toBeNull()
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByRole('link', { name: '查看构建流程' }))
    await paint()
    await waitFor(() => expect(view.container.querySelector('webview')).not.toBeNull())
    const guest = view.container.querySelector('webview')!
    const loadURL = vi.fn(async () => {})
    Object.assign(guest, { loadURL, getURL: () => 'about:blank', getTitle: () => '', canGoBack: () => false, canGoForward: () => false })
    expect(screen.getByRole('button', { name: '浏览器' })).toHaveAttribute('aria-pressed', 'true')
    expect(loadURL).not.toHaveBeenCalled()
    fireEvent(guest, new Event('dom-ready'))
    await paint()
    expect(loadURL).toHaveBeenCalledExactlyOnceWith(first)
    fireEvent.click(screen.getByRole('button', { name: '浏览器' }))
    await paint()
    expect(view.container.querySelector('webview')).toBe(guest)
    fireEvent.click(screen.getByRole('link', { name: '查看发布页面' }))
    await paint()
    expect(view.container.querySelector('webview')).toBe(guest)
    expect(loadURL).toHaveBeenCalledTimes(2)
    expect(loadURL).toHaveBeenLastCalledWith(second)
    view.rerender(<App />)
    await paint()
    expect(loadURL).toHaveBeenCalledTimes(2)
    expect(openWindow).not.toHaveBeenCalled()
    expectNoParentBackendAction(f.actions)
    expect(f.actions.abort).not.toHaveBeenCalled()
  })

  it('preserves ordinary message/tool/thinking DOM across delayed body refresh and stops streaming on a terminal summary', async () => {
    const f = setup()
    const running = { ...summary, status: 'running' as const }
    const initial: SubagentSessionSnapshot = { ...running, rows: [
      snapshot.rows[2],
      { id: 'message-3-thinking', kind: 'thinking', text: '已有思考', state: 'running' },
      { id: 'message-3-text', kind: 'assistant', text: '已有回复', state: 'running' }
    ] }
    f.apiMocks.listSubagentSessions.mockResolvedValue({ revision: 1, sessions: [running] })
    f.apiMocks.getSubagentSession.mockResolvedValueOnce(initial)
    const view = render(<App />)
    await paint()
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    await paint()
    const child = childScroll(view.container)
    const bubble = child.querySelector('.bubble-assistant')!
    const thinking = child.querySelector<HTMLDetailsElement>('details.thinking')!
    thinking.open = true
    fireEvent(thinking, new Event('toggle'))
    fireEvent.click(within(child).getByRole('button', { name: '展开工具调用（1次）' }))
    fireEvent.click(within(child).getByRole('button', { name: '展开读取工具详情' }))
    const toolBody = child.querySelector('.tool-body')!
    expect(child.querySelector('.row-assistant')).toHaveClass('streaming-reveal')

    const pending = deferred<SubagentSessionSnapshot | null>()
    f.apiMocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const next = { ...running, revision: 2 }
    act(() => f.push({ revision: 2, sessions: [next] }))
    expect(child.querySelector('.bubble-assistant')).toBe(bubble)
    expect(child.querySelector('details.thinking')).toBe(thinking)
    expect(thinking).toHaveAttribute('open')
    expect(child.querySelector('.tool-body')).toBe(toolBody)
    expect(bubble).toHaveTextContent('已有回复')
    expect(child.querySelector('.row-assistant')).toHaveClass('streaming-reveal')
    await act(async () => pending.resolve({ ...initial, ...next, rows: [
      initial.rows[0], { ...initial.rows[1], text: '已有思考新增思考' },
      { ...initial.rows[2], text: '已有回复新增后缀' }
    ] }))
    expect(child.querySelector('.bubble-assistant')).toBe(bubble)
    expect(thinking).toHaveAttribute('open')
    expect(child.querySelector('.tool-body')).toBe(toolBody)
    expect(bubble).toHaveTextContent('已有回复新增后缀')
    expect(thinking.querySelector('pre')).toHaveTextContent('已有思考新增思考')
    // The old prefix is still inside its original fade window, not replayed.
    expect([...thinking.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent).join('')).toBe('已有思考新增思考')

    const oldPending = deferred<SubagentSessionSnapshot | null>()
    const terminalPending = deferred<SubagentSessionSnapshot | null>()
    f.apiMocks.getSubagentSession.mockImplementationOnce(() => oldPending.promise)
      .mockImplementationOnce(() => terminalPending.promise)
    act(() => f.push({ revision: 3, sessions: [{ ...running, revision: 3 }] }))
    const completed = { ...running, revision: 4, status: 'completed' as const, retentionRemainingMs: 1000 }
    act(() => f.push({ revision: 4, sessions: [completed] }))
    expect(child.querySelector('.bubble-assistant')).toBe(bubble)
    expect(child.querySelector('.row-assistant')).not.toHaveClass('streaming-reveal')
    expect(thinking).toHaveAttribute('open')
    expect(child.querySelector('.tool-body')).toBe(toolBody)
    expect(bubble).toHaveTextContent('已有回复新增后缀')
    await act(async () => oldPending.resolve({ ...initial, revision: 4 }))
    expect(child.querySelector('.row-assistant')).not.toHaveClass('streaming-reveal')
    expect(bubble).toHaveTextContent('已有回复新增后缀')
    await act(async () => terminalPending.resolve({ ...initial, ...completed }))
    expect(child.querySelector('.bubble-assistant')).toBe(bubble)
    expect(thinking).toHaveAttribute('open')
    expect(child.querySelector('.tool-body')).toBe(toolBody)
    expectNoParentBackendAction(f.actions)
    expect(f.fallback.size).toBe(0)
  })

  it('binds manual-reading input after opening and reopening the conditional child viewport', async () => {
    const f = setup()
    const view = render(<App />)
    await paint()
    for (const revision of [2, 3]) {
      fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
      await paint()
      const child = childScroll(view.container)
      let height = 1200
      Object.defineProperties(child, {
        clientHeight: { configurable: true, value: 240 },
        scrollHeight: { configurable: true, get: () => height }
      })
      child.scrollTop = 960
      fireEvent.wheel(child, { deltaY: -80 })
      child.scrollTop = 400
      fireEvent.scroll(child)
      const latest = { ...summary, revision }
      f.apiMocks.getSubagentSession.mockResolvedValue({ ...snapshot, ...latest,
        rows: snapshot.rows.map((item) => item.kind === 'assistant'
          ? { ...item, text: `${item.text}\n新增输出 ${revision}` } : item) })
      height = 1500
      act(() => f.push({ revision, sessions: [latest] }))
      await paint()
      expect(child.scrollTop).toBe(400)
      fireEvent.click(row(view.container, parentPath))
      await paint()
      expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    }
    expectNoParentBackendAction(f.actions)
  })

  it.each(['running', 'ready'] as const)('keeps parent timeline and Composer draft mounted and returns by the same parent row (%s backend)', async (phase) => {
    const f = setup(phase)
    const view = render(<App />)
    await paint()
    const parentTimeline = view.container.querySelector<HTMLElement>('.chat-scroll')!
    const parentBubble = parentTimeline.querySelector('.bubble-user')
    const input = view.container.querySelector<HTMLTextAreaElement>('.composer textarea')!
    fireEvent.change(input, { target: { value: '尚未发送的父草稿' } })
    const composer = input.closest('.composer')
    const originalTimeline = f.state.timeline
    expect(screen.getByTestId('parent-metrics')).toBeVisible()
    expect(screen.getByTestId('parent-history')).toBeVisible()
    expect(view.container.querySelector('.task-panel-agent')).not.toBeNull()
    expect(view.container.querySelector('.queue-panel')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    await paint()
    expect(view.container.querySelector('.chat-scroll:not(.child-chat-scroll)')).toBe(parentTimeline)
    expect(parentTimeline.querySelector('.bubble-user')).toBe(parentBubble)
    expect(parentTimeline).toHaveAttribute('inert')
    expect(parentTimeline).toHaveAttribute('aria-hidden', 'true')
    expect(parentTimeline).toHaveStyle({ visibility: 'hidden' })
    expect(view.container.querySelector('.composer textarea')).toBe(input)
    expect(input).toHaveValue('尚未发送的父草稿')
    expect(input.closest('[inert]')).not.toBeNull()
    expect(input.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(composer).not.toBeVisible()
    for (const selector of ['[data-testid="parent-metrics"]', '[data-testid="parent-history"]', '.task-panel-agent', '.queue-panel', '.composer-inline-controls']) {
      const element = view.container.querySelector(selector)
      if (element) expect(element).not.toBeVisible()
    }
    expect(screen.queryByRole('button', { name: /返回父/ })).not.toBeInTheDocument()

    fireEvent.click(row(view.container, parentPath))
    await paint()
    expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    expect(parentTimeline).not.toHaveAttribute('inert')
    expect(parentTimeline).not.toHaveAttribute('aria-hidden')
    expect(view.container.querySelector('.composer')).toBe(composer)
    expect(view.container.querySelector('.composer textarea')).toBe(input)
    expect(input).toHaveValue('尚未发送的父草稿')
    expect(input).toBeVisible()
    expect(screen.getByTestId('parent-metrics')).toBeVisible()
    expect(screen.getByTestId('parent-history')).toBeVisible()
    expect(f.state.timeline).toBe(originalTimeline)
    expectNoParentBackendAction(f.actions)
  })

  it('hides explicitly-visible expanded queue descendants in child view without remounting or collapsing them', async () => {
    // Ancestor-based toBeVisible alone misses CSS visibility inheritance:
    // an expanded shell explicitly sets visible and can escape a hidden parent.
    const styles = document.createElement('style')
    styles.textContent = '.task-panel-list-shell { visibility: visible; }\n'
      + readFileSync('src/renderer/src/styles/subagent-sessions.css', 'utf8')
    document.head.append(styles)
    try {
      const f = setup()
      const view = render(<App />)
      await paint()
      const panel = view.container.querySelector<HTMLElement>('.queue-panel')!
      if (!panel.classList.contains('expanded')) fireEvent.click(panel.querySelector('.task-panel-head')!)
      await paint()
      const shell = panel.querySelector<HTMLElement>('.task-panel-list-shell')!
      const item = panel.querySelector<HTMLElement>('.queue-item')!
      const input = view.container.querySelector<HTMLTextAreaElement>('.composer textarea')!
      fireEvent.change(input, { target: { value: '保留父草稿' } })
      expect(panel).toHaveClass('expanded')
      expect(getComputedStyle(shell).visibility).toBe('visible')
      fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
      await paint()
      expect(view.container.querySelector('.queue-panel')).toBe(panel)
      expect(view.container.querySelector('.queue-item')).toBe(item)
      expect(panel).toHaveClass('expanded')
      expect(panel.closest('.composer-dock')).toHaveAttribute('inert')
      expect(getComputedStyle(shell).visibility).toBe('hidden')
      expect(getComputedStyle(item).visibility).toBe('hidden')
      for (const control of item.querySelectorAll('button')) {
        expect(getComputedStyle(control).visibility).toBe('hidden')
      }
      fireEvent.click(row(view.container, parentPath))
      await paint()
      expect(view.container.querySelector('.queue-panel')).toBe(panel)
      expect(view.container.querySelector('.queue-item')).toBe(item)
      expect(panel).toHaveClass('expanded')
      expect(getComputedStyle(shell).visibility).toBe('visible')
      expect(view.container.querySelector('.composer textarea')).toBe(input)
      expect(input).toHaveValue('保留父草稿')
      expectNoParentBackendAction(f.actions)
      expect(f.fallback.size).toBe(0)
    } finally { styles.remove() }
  })

  it('closes child viewing before switching to another ordinary session, without starting or reloading a project', async () => {
    const f = setup()
    const view = render(<App />)
    await paint()
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    await paint()
    expect(childScroll(view.container)).toBeInTheDocument()
    fireEvent.click(row(view.container, otherPath))
    await paint()
    expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    expect(view.container.querySelector('.composer textarea')).toBeVisible()
    expect(f.actions.switchSession).toHaveBeenCalledExactlyOnceWith(otherPath, cwd)
    expect(f.actions.start).not.toHaveBeenCalled()
    expect(f.actions.reloadTimeline).not.toHaveBeenCalled()
    expect(f.state.timeline).toEqual([{ kind: 'user', id: 101, text: '父历史消息', entryId: 'parent-entry' }])
  })

  it('a pending child response cannot re-open viewing or contaminate parent history after a parent-row click', async () => {
    const f = setup()
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.apiMocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const view = render(<App />)
    await paint()
    const parentBubble = view.container.querySelector('.bubble-user')
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    expect(childScroll(view.container)).toBeInTheDocument()
    expect(view.container.querySelector('.composer textarea')!.closest('[inert]')).not.toBeNull()
    fireEvent.click(row(view.container, parentPath))
    await act(async () => pending.resolve(snapshot))
    expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    expect(view.container.querySelector('.bubble-user')).toBe(parentBubble)
    expect(view.container.querySelector('.composer textarea')).toBeVisible()
    expect(screen.queryByText('普通回复')).not.toBeInTheDocument()
    expectNoParentBackendAction(f.actions)
  })

  it('expires pending readonly viewing automatically and rejects late details/repeated list resurrection', async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const f = setup()
    const terminal = { ...summary, retentionRemainingMs: 1000 }
    const pending = deferred<SubagentSessionSnapshot | null>()
    f.apiMocks.listSubagentSessions.mockResolvedValue({ revision: 1, sessions: [terminal] })
    f.apiMocks.getSubagentSession.mockImplementationOnce(() => pending.promise)
    const view = render(<App />)
    await paint()
    const input = view.container.querySelector<HTMLTextAreaElement>('.composer textarea')!
    fireEvent.change(input, { target: { value: '过期后保留的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: /查看子会话 代码检查/ }))
    expect(childScroll(view.container)).toBeInTheDocument()
    now = 1001
    act(() => vi.advanceTimersByTime(1000))
    expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    expect(input).toBeVisible()
    expect(input).toHaveValue('过期后保留的草稿')
    await act(async () => pending.resolve({ ...snapshot, retentionRemainingMs: 1000 }))
    act(() => f.push({ revision: 2, sessions: [terminal] }))
    expect(view.container.querySelector('.child-chat-scroll')).toBeNull()
    expect(screen.queryByRole('button', { name: /查看子会话 代码检查/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /返回父/ })).not.toBeInTheDocument()
    expect(screen.getByText('父历史消息')).toBeInTheDocument()
    expectNoParentBackendAction(f.actions)
  })
})
