// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSlashCommands } from '../../src/renderer/src/hooks/useSlashCommands'
import { initialState, type AgentState } from '../../src/renderer/src/agent/types'
import { DESKTOP_SLASH_COMMANDS, PENDING_PI_SLASH_COMMAND_NAMES } from '../../src/shared/slash-commands'
import type { SessionCommandInfo, SessionCommandTarget } from '../../src/shared/slash-command-protocol'
import type { ImageContent, PionApi, SessionMeta } from '../../src/shared/types'

afterEach(cleanup)

type Options = Parameters<typeof useSlashCommands>[0]

const target: SessionCommandTarget = {
  cwd: '/project/A', sessionId: 'session-A', sessionPath: '/sessions/A.jsonl', backendId: 'backend-A'
}
const info: SessionCommandInfo = {
  ...target, sessionName: '完整会话名称',
  stats: {
    userMessages: 401, assistantMessages: 602, toolCalls: 803, toolResults: 804, totalMessages: 1807,
    tokens: { input: 1101, output: 2202, cacheRead: 3303, cacheWrite: 4404, total: 11010 }, cost: 9.876543
  }
}
const savedSessions: SessionMeta[] = [
  { path: target.sessionPath!, id: target.sessionId, name: '当前会话', projectCwd: target.cwd,
    timestamp: '2026-05-01T00:00:00Z', mtime: 1, preview: 'current preview', messageCount: 20 },
  { path: '/sessions/resume.jsonl', id: 'resume-id', name: '另一会话', projectCwd: target.cwd,
    timestamp: '2026-05-02T00:00:00Z', mtime: 2, preview: 'resume preview', messageCount: 5 },
  { path: 'pion:pending:unsaved', id: 'unsaved', name: '乐观占位', projectCwd: target.cwd,
    timestamp: '2026-05-03T00:00:00Z', mtime: 3, preview: 'not persisted', messageCount: 1, optimistic: true }
]

function readyState(): AgentState {
  return {
    ...initialState,
    status: { phase: 'running', cwd: target.cwd },
    session: { sessionId: target.sessionId, sessionFile: target.sessionPath, sessionName: '当前名称',
      isStreaming: false, messageCount: 20, provider: 'provider-one', modelId: 'duplicate', thinkingLevel: 'low' },
    liveSessionBackendId: target.backendId,
    models: [
      { provider: 'provider-one', id: 'duplicate', name: 'One display name' },
      { provider: 'provider-two', id: 'duplicate', name: 'Two display name' },
      { provider: 'provider-two', id: 'family/model:exact id', name: 'Nested / exact display' }
    ],
    thinkingLevels: ['off', 'low', 'max'],
    commands: [
      { name: 'review', source: 'extension' },
      { name: 'my-template', source: 'prompt' },
      { name: 'skill:pdf', source: 'skill' }
    ],
    // Deliberately a middle history page: neither /copy nor /session may use it.
    timeline: [{ kind: 'assistant', id: 7, text: 'obsolete middle-page assistant', thinking: '', streaming: false, historical: true }]
  }
}

function mockApi() {
  // Only a local typed IPC mock. No real preload, SDK, clipboard, model or file IO.
  return {
    listSessions: vi.fn<PionApi['listSessions']>().mockResolvedValue(savedSessions),
    getSessionCommandInfo: vi.fn<PionApi['getSessionCommandInfo']>().mockResolvedValue(info),
    copyLastAssistantText: vi.fn<PionApi['copyLastAssistantText']>().mockResolvedValue(true),
    exportSessionForCommand: vi.fn<PionApi['exportSessionForCommand']>().mockResolvedValue('/project/A/session.html'),
    getPiChangelog: vi.fn<PionApi['getPiChangelog']>().mockResolvedValue({ version: '99.8.7-test', markdown: '# Pi only changelog\nSDK entry' }),
    closeWindow: vi.fn<PionApi['closeWindow']>(),
    send: vi.fn<PionApi['send']>().mockResolvedValue(undefined),
    queue: vi.fn<PionApi['queue']>().mockResolvedValue(undefined),
    getRunTelemetry: vi.fn<PionApi['getRunTelemetry']>().mockResolvedValue([]),
    getEntries: vi.fn<PionApi['getEntries']>().mockResolvedValue(null),
    getEntriesPage: vi.fn<PionApi['getEntriesPage']>().mockResolvedValue(null),
    getState: vi.fn<PionApi['getState']>().mockResolvedValue(null),
    loginModelProvider: vi.fn<PionApi['loginModelProvider']>().mockResolvedValue([]),
    logoutModelProvider: vi.fn<PionApi['logoutModelProvider']>().mockResolvedValue([]),
    setProjectTrust: vi.fn<PionApi['setProjectTrust']>(),
    getProjectTrust: vi.fn<PionApi['getProjectTrust']>(),
    newSession: vi.fn<PionApi['newSession']>().mockResolvedValue(undefined),
    copySession: vi.fn<PionApi['copySession']>(),
    switchSession: vi.fn<PionApi['switchSession']>(),
    compactNow: vi.fn<PionApi['compactNow']>().mockResolvedValue(undefined),
    exportSessionHtml: vi.fn<PionApi['exportSessionHtml']>().mockResolvedValue('/wrong-legacy-export.html'),
    stopAgent: vi.fn<PionApi['stopAgent']>().mockResolvedValue(undefined),
    openTerminal: vi.fn<PionApi['openTerminal']>(),
    writeTerminal: vi.fn<PionApi['writeTerminal']>().mockResolvedValue(undefined)
  }
}

function harness(overrides: Partial<Options> = {}) {
  const api = mockApi()
  const options = {
    api: api as unknown as PionApi,
    state: readyState(),
    selectionRef: { current: { generation: 1, cwd: target.cwd, ownerPath: target.sessionPath,
      sessionId: target.sessionId, sessionPath: target.sessionPath } },
    enabled: true,
    actions: {
      setModel: vi.fn<Options['actions']['setModel']>().mockResolvedValue(undefined),
      setThinkingLevel: vi.fn<Options['actions']['setThinkingLevel']>().mockResolvedValue(undefined),
      compactNow: vi.fn<Options['actions']['compactNow']>().mockResolvedValue(undefined),
      renameSession: vi.fn<Options['actions']['renameSession']>().mockResolvedValue(undefined)
    },
    onOpenSettings: vi.fn<Options['onOpenSettings']>(),
    onNewSession: vi.fn<Options['onNewSession']>().mockResolvedValue(undefined),
    onCloneSession: vi.fn<Options['onCloneSession']>().mockResolvedValue(undefined),
    onSelectSession: vi.fn<Options['onSelectSession']>().mockResolvedValue(undefined),
    onOpenOperations: vi.fn<Options['onOpenOperations']>(),
    onModeChange: vi.fn<Options['onModeChange']>(),
    onRequestYolo: vi.fn<Options['onRequestYolo']>()
  }
  const initialProps: Options = { ...options, ...overrides }
  const hook = renderHook((props: Options) => useSlashCommands(props), { initialProps })
  return { api, options: initialProps, actions: options.actions, callbacks: options, ...hook }
}

type Harness = ReturnType<typeof harness>

async function execute(h: Harness, text: string, images?: ImageContent[]): Promise<boolean> {
  let consumed = false
  await act(async () => { consumed = h.result.current.execute(text, images) })
  return consumed
}

function expectNoSendOrQueue(h: Harness): void {
  expect(h.api.send).not.toHaveBeenCalled()
  expect(h.api.queue).not.toHaveBeenCalled()
  expect(h.api.openTerminal).not.toHaveBeenCalled()
  expect(h.api.writeTerminal).not.toHaveBeenCalled()
}

function expectNoMutation(h: Harness): void {
  for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled()
  expect(h.callbacks.onNewSession).not.toHaveBeenCalled()
  expect(h.callbacks.onCloneSession).not.toHaveBeenCalled()
  expect(h.callbacks.onSelectSession).not.toHaveBeenCalled()
  expect(h.api.exportSessionForCommand).not.toHaveBeenCalled()
  expect(h.api.loginModelProvider).not.toHaveBeenCalled()
  expect(h.api.logoutModelProvider).not.toHaveBeenCalled()
  expect(h.api.setProjectTrust).not.toHaveBeenCalled()
  expectNoSendOrQueue(h)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Independent expected catalog: adding a descriptor alone is not an action test.
const knownNames = [
  'settings', 'model', 'thinking', 'scoped-models', 'login', 'logout', 'new', 'resume', 'name',
  'session', 'tree', 'fork', 'clone', 'compact', 'import', 'copy', 'export', 'share', 'bug', 'trust',
  'reload', 'hotkeys', 'changelog', 'quit', 'debug', 'llama', 'plan', 'yolo', 'verify', 'agents'
]

describe('native slash command interception', () => {
  it.each(knownNames)('consumes the complete /%s instead of sending or queuing it', async (name) => {
    const h = harness()
    expect(await execute(h, ` \t/${name.toUpperCase()} \t`)).toBe(true)
    expectNoSendOrQueue(h)
    expect(h.result.current.commands).toBe(DESKTOP_SLASH_COMMANDS)
  })

  it.each(PENDING_PI_SLASH_COMMAND_NAMES)('keeps /%s visibly pending without invoking any backend operation or model', async (name) => {
    const h = harness()
    expect(await execute(h, `/${name} arbitrary argument`)).toBe(true)
    expect(h.result.current.dialog?.error).toMatch(/尚未接入.*不会发送给模型或转到终端/)
    expect(h.result.current.dialog?.title).toBe(`/${name}`)
    expectNoMutation(h)
    for (const method of Object.values(h.api)) expect(method).not.toHaveBeenCalled()
  })

  it.each([
    '/review security', '/review security\ninclude all files', '/my-template one two',
    '/skill:pdf extract', '/skill:pdf\nextract all pages', '/unknown', '/models', '/newer',
    '/compact.extra', '/clone/path', 'Explain /settings', 'first line\n/settings',
    '```\n/settings\n```', '/', ''
  ])('leaves extension/template/skill names, partial matches and prose %j SDK-owned', async (text) => {
    const h = harness()
    expect(await execute(h, text)).toBe(false)
    expect(h.result.current.dialog).toBeNull()
    expectNoMutation(h)
    for (const method of Object.values(h.api)) expect(method).not.toHaveBeenCalled()
  })

  it('consumes but does not execute native commands from a read-only child projection', async () => {
    const h = harness({ enabled: false })
    for (const name of knownNames) expect(await execute(h, `/${name}`)).toBe(true)
    expect(await execute(h, '/review task')).toBe(false)
    expect(h.result.current.dialog).toBeNull()
    expectNoMutation(h)
    for (const method of Object.values(h.api)) expect(method).not.toHaveBeenCalled()
    expect(h.callbacks.onOpenSettings).not.toHaveBeenCalled()
    expect(h.callbacks.onModeChange).not.toHaveBeenCalled()
    expect(h.callbacks.onRequestYolo).not.toHaveBeenCalled()
  })

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('consumes exact native names with separator %j and reports invalid parameters locally', async (separator) => {
    const h = harness()
    for (const name of knownNames.filter((name) => !['name', 'compact'].includes(name))) {
      expect(await execute(h, `/${name}${separator}unexpected${separator}body`)).toBe(true)
      expect(h.result.current.dialog?.error).toBeTruthy()
      expect(h.result.current.dialog?.title).toBe(`/${name}`)
    }
    expectNoMutation(h)
    expect(h.callbacks.onOpenSettings).not.toHaveBeenCalled()
    expect(h.callbacks.onModeChange).not.toHaveBeenCalled()
    expect(h.callbacks.onRequestYolo).not.toHaveBeenCalled()
    for (const method of Object.values(h.api)) expect(method).not.toHaveBeenCalled()
  })

  it.each(['settings', 'logout', 'new', 'clone', 'resume', 'copy', 'session', 'trust', 'debug', 'changelog', 'quit'])('rejects an unexpected /%s argument before any side effect', async (name) => {
    const h = harness()
    expect(await execute(h, `/${name} extra`)).toBe(true)
    expect(h.result.current.dialog?.error).toContain('不接受参数')
    expectNoMutation(h)
    for (const method of Object.values(h.api)) expect(method).not.toHaveBeenCalled()
  })
})

describe('native model and thinking actions', () => {
  it('selects only an exact provider/id, preserving nested IDs and case rather than display names', async () => {
    const h = harness()
    expect(await execute(h, '/model provider-two/family/model:exact id')).toBe(true)
    expect(h.actions.setModel).toHaveBeenCalledExactlyOnceWith('provider-two', 'family/model:exact id')
    expect(h.result.current.dialog?.text).toContain('provider-two/family/model:exact id')
    expectNoSendOrQueue(h)
  })

  it.each(['duplicate', 'Two display name', 'PROVIDER-TWO/duplicate', 'missing/model'])('opens a search for nonexact model argument %j without choosing a fallback', async (argument) => {
    const h = harness()
    await execute(h, `/model ${argument}`)
    expect(h.result.current.dialog?.title).toBe('选择模型')
    expect(h.result.current.dialog?.initialQuery).toBe(argument)
    expect(h.result.current.dialog?.entries).toHaveLength(3)
    expectNoMutation(h)
  })

  it('keeps duplicate IDs from different providers distinct and passes the selected opaque identity unchanged', async () => {
    const h = harness()
    await execute(h, '/model')
    const dialog = h.result.current.dialog!
    const entries = dialog.entries!
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(3)
    expect(entries.map((entry) => entry.label)).toEqual([
      'provider-one/duplicate', 'provider-two/duplicate', 'provider-two/family/model:exact id'
    ])
    expect(entries.map((entry) => entry.selected)).toEqual([true, false, false])
    await act(async () => { dialog.onSelect?.('duplicate') })
    expect(h.actions.setModel).not.toHaveBeenCalled()
    await act(async () => { dialog.onSelect?.(entries[1].id) })
    expect(h.actions.setModel).toHaveBeenCalledExactlyOnceWith('provider-two', 'duplicate')
    expectNoSendOrQueue(h)
  })

  it('refuses a model removed from the current directory after its chooser opened', async () => {
    const h = harness()
    await execute(h, '/model')
    const dialog = h.result.current.dialog!
    const removed = dialog.entries!.at(-1)!
    h.rerender({ ...h.options, state: { ...h.options.state, models: h.options.state.models.slice(0, -1) } })
    await act(async () => { dialog.onSelect?.(removed.id) })
    expect(h.actions.setModel).not.toHaveBeenCalled()
    expect(h.result.current.dialog?.error).toContain('已不在当前可用目录')
    expectNoSendOrQueue(h)
  })

  it('uses the live supplied thinking directory, including a newly added max level', async () => {
    const h = harness()
    await execute(h, '/thinking')
    expect(h.result.current.dialog?.entries).toEqual([
      { id: 'off', label: 'off', selected: false },
      { id: 'low', label: 'low', selected: true },
      { id: 'max', label: 'max', selected: false }
    ])
    expect(h.actions.setThinkingLevel).not.toHaveBeenCalled()
    await execute(h, '/thinking MAX')
    expect(h.actions.setThinkingLevel).toHaveBeenCalledExactlyOnceWith('max')
    expect(h.result.current.dialog?.text).toContain('max')
    expectNoSendOrQueue(h)
  })

  it('does not hardcode formerly supported thinking levels when the current model has a different directory', async () => {
    const state = readyState()
    state.thinkingLevels = ['off', 'adaptive-future']
    const h = harness({ state })
    await execute(h, '/thinking high')
    expect(h.result.current.dialog?.error).toContain('off、adaptive-future')
    expect(h.actions.setThinkingLevel).not.toHaveBeenCalled()
    await execute(h, '/thinking')
    expect(h.result.current.dialog?.entries?.map((entry) => entry.id)).toEqual(['off', 'adaptive-future'])
    await act(async () => { h.result.current.dialog?.onSelect?.('adaptive-future') })
    expect(h.actions.setThinkingLevel).toHaveBeenCalledExactlyOnceWith('adaptive-future')
  })

  it('rejects a thinking level removed by a newer same-session catalog while its chooser was open', async () => {
    const h = harness()
    await execute(h, '/thinking')
    const choose = h.result.current.dialog!.onSelect!
    h.rerender({ ...h.options, state: { ...h.options.state, thinkingLevels: ['off', 'low'] } })
    await act(async () => { choose('max') })
    expect(h.actions.setThinkingLevel).not.toHaveBeenCalled()
    expect(h.result.current.dialog?.error).toContain('off、low')
    expectNoSendOrQueue(h)
  })

  it.each(['impossible', 'high extra', 'low\nmax'])('rejects invalid thinking argument %j without invoking a model action', async (argument) => {
    const h = harness()
    expect(await execute(h, `/thinking ${argument}`)).toBe(true)
    expect(h.result.current.dialog?.error).toBeTruthy()
    expectNoMutation(h)
  })
})

describe('native navigation and existing application controllers', () => {
  it.each([
    ['/settings', { page: 'models' }],
    ['/login', { page: 'models', authIntent: 'login', providerQuery: '' }],
    ['/login exact-provider-id', { page: 'models', authIntent: 'login', providerQuery: 'exact-provider-id' }],
    ['/logout', { page: 'models', authIntent: 'logout', providerQuery: '' }],
    ['/trust', { page: 'security' }],
    ['/debug', { page: 'diagnostics' }]
  ] as const)('uses %s only as explicit settings navigation, never authentication or trust consent', async (text, request) => {
    const h = harness()
    await execute(h, '/hotkeys')
    expect(await execute(h, text)).toBe(true)
    expect(h.callbacks.onOpenSettings).toHaveBeenCalledExactlyOnceWith(request)
    expect(h.result.current.dialog).toBeNull()
    expectNoMutation(h)
    expect(h.api.getProjectTrust).not.toHaveBeenCalled()
    expect(h.api.getState).not.toHaveBeenCalled()
  })

  it('shows /name with no argument without invoking rename, even when the selected backend is absent', async () => {
    const h = harness({ api: undefined })
    await execute(h, '/name')
    expect(h.result.current.dialog?.title).toBe('会话名称')
    expect(h.result.current.dialog?.text).toBe('当前名称')
    expect(h.actions.renameSession).not.toHaveBeenCalled()
    h.rerender({ ...h.options, state: { ...h.options.state, session: null } })
    await execute(h, '/name')
    expect(h.result.current.dialog?.text).toContain('未命名')
    expect(h.actions.renameSession).not.toHaveBeenCalled()
    expectNoSendOrQueue(h)
  })

  it('forwards an explicit session name and its exact persisted target to the existing rename action', async () => {
    const h = harness()
    await execute(h, '/name 新的 会话名称')
    expect(h.actions.renameSession).toHaveBeenCalledExactlyOnceWith('新的 会话名称', target.sessionPath)
    expect(h.result.current.dialog?.text).toContain('新的 会话名称')
    expectNoSendOrQueue(h)
  })

  it.each(['new', 'clone'] as const)('reuses the /%s application controller rather than invoking the backend lifecycle directly', async (name) => {
    const h = harness()
    await execute(h, `/${name}`)
    expect(h.callbacks[name === 'new' ? 'onNewSession' : 'onCloneSession']).toHaveBeenCalledExactlyOnceWith()
    expect(h.api.newSession).not.toHaveBeenCalled()
    expect(h.api.copySession).not.toHaveBeenCalled()
    expect(h.result.current.dialog).toBeNull()
    expectNoSendOrQueue(h)
  })

  it('does not clone a fresh, unpersisted session', async () => {
    const state = readyState()
    state.session = { ...state.session!, sessionFile: undefined }
    const h = harness({ state })
    await execute(h, '/clone')
    expect(h.result.current.dialog?.error).toContain('尚未持久化')
    expect(h.callbacks.onCloneSession).not.toHaveBeenCalled()
    expect(h.api.copySession).not.toHaveBeenCalled()
  })

  it.each([
    ['/compact', undefined],
    ['/compact 保留精确 API 和测试', '保留精确 API 和测试'],
    ['/compact 第一行\n第二行\n保留缩进  text', '第一行\n第二行\n保留缩进  text']
  ] as const)('reuses compactNow with exact custom instructions for %j, never a normal prompt', async (text, instructions) => {
    const h = harness()
    await execute(h, text)
    expect(h.actions.compactNow).toHaveBeenCalledExactlyOnceWith(instructions)
    expect(h.api.compactNow).not.toHaveBeenCalled()
    expect(h.result.current.dialog?.text).toContain('压缩已完成')
    expectNoSendOrQueue(h)
  })

  it('lists only saved resume choices and forwards the captured cwd/path to the existing session selector', async () => {
    const h = harness()
    await execute(h, '/resume')
    expect(h.api.listSessions).toHaveBeenCalledExactlyOnceWith(target.cwd)
    const dialog = h.result.current.dialog!
    expect(dialog.entries?.map((entry) => entry.id)).toEqual([target.sessionPath, '/sessions/resume.jsonl'])
    expect(dialog.entries?.map((entry) => entry.selected)).toEqual([true, false])
    expect(h.callbacks.onSelectSession).not.toHaveBeenCalled()
    for (const rejected of ['pion:pending:unsaved', '/sessions/not-listed.jsonl']) {
      await act(async () => { dialog.onSelect?.(rejected) })
    }
    expect(h.callbacks.onSelectSession).not.toHaveBeenCalled()
    await act(async () => { dialog.onSelect?.('/sessions/resume.jsonl') })
    expect(h.callbacks.onSelectSession).toHaveBeenCalledExactlyOnceWith(target.cwd, '/sessions/resume.jsonl')
    expect(h.api.switchSession).not.toHaveBeenCalled()
    expect(h.api.newSession).not.toHaveBeenCalled()
    expect(h.result.current.dialog).toBeNull()
  })

  it.each([
    ['/verify', 'verification'], ['/agents', 'agents']
  ] as const)('opens the existing operations panel for %s', async (text, kind) => {
    const h = harness()
    await execute(h, text)
    expect(h.callbacks.onOpenOperations).toHaveBeenCalledExactlyOnceWith(kind)
    expectNoMutation(h)
  })

  it.each([
    ['/plan', 'plan'], ['/plan start', 'plan'], ['/plan exit', 'build'], ['/plan off', 'build']
  ] as const)('delegates %s to the guarded mode controller', async (text, mode) => {
    const h = harness()
    await execute(h, text)
    expect(h.callbacks.onModeChange).toHaveBeenCalledExactlyOnceWith(mode)
    expectNoMutation(h)
  })

  it.each([
    ['/yolo', true], ['/yolo on', true], ['/yolo start', true], ['/yolo off', false], ['/yolo exit', false]
  ] as const)('delegates %s to the explicit YOLO request controller', async (text, enabled) => {
    const h = harness()
    await execute(h, text)
    expect(h.callbacks.onRequestYolo).toHaveBeenCalledExactlyOnceWith(enabled)
    expectNoMutation(h)
  })

  it.each(['/plan maybe', '/yolo maybe'])('does not infer consent from an invalid mode parameter %j', async (text) => {
    const h = harness()
    await execute(h, text)
    expect(h.result.current.dialog?.error).toContain('用法')
    expect(h.callbacks.onModeChange).not.toHaveBeenCalled()
    expect(h.callbacks.onRequestYolo).not.toHaveBeenCalled()
    expectNoMutation(h)
  })
})

describe('authoritative copy, statistics, export and bundled Pi metadata', () => {
  it.each([true, false])('uses backend current-branch copy result %s, not the visible middle-page timeline or a guessed clipboard value', async (copied) => {
    const h = harness()
    h.api.copyLastAssistantText.mockResolvedValue(copied)
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await execute(h, '/copy')
      expect(h.api.copyLastAssistantText).toHaveBeenCalledExactlyOnceWith(target)
      expect(writeText).not.toHaveBeenCalled() // The backend alone owns real branch selection/copy.
      expect(h.api.getEntries).not.toHaveBeenCalled()
      expect(h.api.getEntriesPage).not.toHaveBeenCalled()
      expect(h.result.current.dialog?.text).toBe(copied
        ? '已复制当前分支最后一条助手回复。' : '当前分支尚无可复制的助手文字。')
      expect(h.result.current.dialog?.text).not.toContain('obsolete middle-page assistant')
      expectNoSendOrQueue(h)
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('reads full Pi session statistics rather than the finite telemetry window or timeline counts', async () => {
    const h = harness()
    await execute(h, '/session')
    expect(h.api.getSessionCommandInfo).toHaveBeenCalledExactlyOnceWith(target)
    expect(h.api.getRunTelemetry).not.toHaveBeenCalled()
    expect(h.api.getEntries).not.toHaveBeenCalled()
    expect(h.api.getEntriesPage).not.toHaveBeenCalled()
    const text = h.result.current.dialog?.text
    expect(h.result.current.dialog?.title).toBe('Pi 会话信息')
    for (const expected of ['完整会话名称', target.sessionId, target.cwd, target.sessionPath!,
      '用户消息：401', '助手消息：602', '工具调用：803', '工具结果：804', '消息合计：1807', '$9.876543',
      info.stats.tokens.total.toLocaleString(), '不是上下文占用、有限运行列表之和或远端账单']) {
      expect(text).toContain(expected)
    }
    expectNoSendOrQueue(h)
  })

  it.each([
    ['/export', undefined],
    ['/export ./session.html', './session.html'],
    ['/export "exports/My Session.html"', 'exports/My Session.html'],
    ["/export 'exports/My Session.jsonl'", 'exports/My Session.jsonl'],
    ['/export ./session.jsonl', './session.jsonl'],
    ['/export "~/My Sessions/A.jsonl"', '~/My Sessions/A.jsonl']
  ] as const)('passes the literal path for %j to the explicit command export API, never the legacy HTML-only API', async (text, path) => {
    const h = harness()
    await execute(h, text)
    expect(h.api.exportSessionForCommand).toHaveBeenCalledExactlyOnceWith(target, path)
    expect(h.api.exportSessionHtml).not.toHaveBeenCalled()
    expect(h.result.current.dialog?.text).toContain('已导出：/project/A/session.html')
    expect(h.result.current.dialog?.text).toContain('HTML 包含整棵会话树；JSONL 仅导出当前分支')
    expect(h.result.current.dialog?.text).toContain('敏感内容')
    expectNoSendOrQueue(h)
  })

  it.each(['/export a b.html', '/export "unterminated.html', '/export "a.html" "b.html"', '/export "a\nb.jsonl"'])('intercepts malformed export %j before file IPC or prompt dispatch', async (text) => {
    const h = harness()
    expect(await execute(h, text)).toBe(true)
    expect(h.result.current.dialog?.error).toBeTruthy()
    expectNoMutation(h)
  })

  it('labels the changelog with the returned bundled Pi version, not the Pion app version', async () => {
    const h = harness()
    await execute(h, '/changelog')
    expect(h.api.getPiChangelog).toHaveBeenCalledExactlyOnceWith()
    expect(h.result.current.dialog?.title).toBe('Pi 99.8.7-test 更新日志')
    expect(h.result.current.dialog?.text).toBe('# Pi only changelog\nSDK entry')
    expect(h.result.current.dialog?.description).toContain('Pion 自身的更新记录在设置')
    expect(h.api.getState).not.toHaveBeenCalled()
    expectNoMutation(h)
  })

  it('closes the application window for /quit without stopping/restarting an agent or terminal', async () => {
    const h = harness()
    await execute(h, '/hotkeys')
    await execute(h, '/quit')
    expect(h.api.closeWindow).toHaveBeenCalledExactlyOnceWith()
    expect(h.api.stopAgent).not.toHaveBeenCalled()
    expect(h.result.current.dialog).toBeNull()
    expectNoMutation(h)
  })
})

const occupiedStates: { label: string; change: (state: AgentState) => AgentState }[] = [
  { label: 'busy', change: (state) => ({ ...state, busy: true }) },
  { label: 'compacting', change: (state) => ({ ...state, compacting: true }) },
  { label: 'streaming', change: (state) => ({ ...state, session: { ...state.session!, isStreaming: true } }) },
  { label: 'session compacting', change: (state) => ({ ...state, session: { ...state.session!, isCompacting: true } }) },
  { label: 'steering queue', change: (state) => ({ ...state, queued: { steering: 1, followUp: 0 } }) },
  { label: 'follow-up queue', change: (state) => ({ ...state, queued: { steering: 0, followUp: 1 } }) },
  { label: 'native pending', change: (state) => ({ ...state, session: { ...state.session!, pendingMessageCount: 1 } }) }
]

describe('mutation readiness and current lifecycle gates', () => {
  it.each(occupiedStates)('rejects guarded mutations while $label without forwarding to a model or queue', async ({ change }) => {
    for (const text of ['/model provider-two/duplicate', '/thinking max', '/compact', '/clone', '/export ./a.jsonl']) {
      const h = harness({ state: change(readyState()) })
      expect(await execute(h, text)).toBe(true)
      expect(h.result.current.dialog?.error).toContain('请等待当前运行及收尾完成，并处理排队消息')
      expectNoMutation(h)
    }
  })

  it.each(occupiedStates)('rechecks $label that appears after a model/thinking chooser opened, before invoking its mutation', async ({ change }) => {
    for (const name of ['model', 'thinking']) {
      const h = harness()
      await execute(h, `/${name}`)
      const choose = h.result.current.dialog!.onSelect!
      const key = h.result.current.dialog!.entries!.at(-1)!.id
      h.rerender({ ...h.options, state: change(h.options.state) })
      await act(async () => { choose(key) })
      // This is a lifecycle regression, not a UI-disabled-button assertion.
      expectNoMutation(h)
      expect(h.result.current.dialog?.error).toContain('请等待当前运行及收尾完成，并处理排队消息')
    }
  })

  it.each(['model', 'thinking', 'copy', 'session', 'compact', 'clone', 'export'])('consumes /%s but refuses a backend that is still preparing', async (name) => {
    const state = readyState()
    state.status = { phase: 'starting', cwd: target.cwd }
    const h = harness({ state })
    await execute(h, `/${name}`)
    expect(h.result.current.dialog?.error).toContain('后端就绪')
    expectNoMutation(h)
    expect(h.api.copyLastAssistantText).not.toHaveBeenCalled()
    expect(h.api.getSessionCommandInfo).not.toHaveBeenCalled()
  })
})

describe('real pending operation slots and late publication fences', () => {
  it.each(['resolve', 'reject'] as const)('does not repeat an export after close, or overwrite its newer dialog when the real IPC later %ss', async (settlement) => {
    const h = harness()
    const pending = deferred<string>()
    h.api.exportSessionForCommand.mockReturnValueOnce(pending.promise)
    await execute(h, '/export "first path.html"')
    expect(h.api.exportSessionForCommand).toHaveBeenCalledExactlyOnceWith(target, 'first path.html')
    expect(h.result.current.dialog?.busy).toBe(true)
    act(() => { h.result.current.dialog!.onClose() })
    expect(h.result.current.dialog).toBeNull()
    await execute(h, '/export "second path.html"')
    expect(h.api.exportSessionForCommand).toHaveBeenCalledTimes(1)
    expect(h.result.current.dialog?.error).toContain('实际操作尚未收口')
    const newerId = h.result.current.dialog?.requestId
    await act(async () => {
      if (settlement === 'resolve') pending.resolve('/project/A/first path.html')
      else pending.reject(new Error('late export failure'))
    })
    expect(h.result.current.dialog?.requestId).toBe(newerId)
    expect(h.result.current.dialog?.error).toContain('实际操作尚未收口')
    expect(h.result.current.dialog?.text).toBeUndefined()
    await execute(h, '/export "second path.html"')
    expect(h.api.exportSessionForCommand).toHaveBeenCalledTimes(2)
    expect(h.api.exportSessionForCommand).toHaveBeenLastCalledWith(target, 'second path.html')
    expectNoSendOrQueue(h)
  })

  it('holds a copy slot across a different session owner until the first actual IPC settles', async () => {
    const h = harness()
    const pending = deferred<boolean>()
    h.api.copyLastAssistantText.mockReturnValueOnce(pending.promise)
    await execute(h, '/copy')
    const nextTarget: SessionCommandTarget = {
      cwd: '/project/B', sessionId: 'session-B', sessionPath: '/sessions/B.jsonl', backendId: 'backend-B'
    }
    h.options.selectionRef.current = { generation: 2, cwd: nextTarget.cwd,
      ownerPath: nextTarget.sessionPath, sessionId: nextTarget.sessionId, sessionPath: nextTarget.sessionPath }
    const next: Options = { ...h.options, state: { ...h.options.state,
      status: { phase: 'running', cwd: nextTarget.cwd },
      session: { ...h.options.state.session!, sessionId: nextTarget.sessionId, sessionFile: nextTarget.sessionPath },
      liveSessionBackendId: nextTarget.backendId } }
    h.rerender(next)
    expect(h.result.current.dialog).toBeNull()
    await execute(h, '/copy')
    expect(h.api.copyLastAssistantText).toHaveBeenCalledTimes(1)
    expect(h.result.current.dialog?.error).toContain('实际操作尚未收口')
    await execute(h, '/hotkeys')
    const newerId = h.result.current.dialog?.requestId
    await act(async () => { pending.resolve(true) })
    expect(h.result.current.dialog?.title).toBe('Pion 快捷键')
    expect(h.result.current.dialog?.requestId).toBe(newerId)
    await execute(h, '/copy')
    expect(h.api.copyLastAssistantText).toHaveBeenCalledTimes(2)
    expect(h.api.copyLastAssistantText).toHaveBeenLastCalledWith(nextTarget)
  })

  it.each(['resolve', 'reject'] as const)('rejects A→B→A generation results even when every visible A field matches again (%s)', async (settlement) => {
    const h = harness()
    const pending = deferred<SessionCommandInfo>()
    h.api.getSessionCommandInfo.mockReturnValueOnce(pending.promise)
    await execute(h, '/session')
    const originalSelection = { ...h.options.selectionRef.current }
    h.options.selectionRef.current = { ...originalSelection, generation: 2, cwd: '/project/B', sessionId: 'session-B' }
    h.rerender({ ...h.options })
    expect(h.result.current.dialog).toBeNull()
    h.options.selectionRef.current = { ...originalSelection, generation: 3 }
    h.rerender({ ...h.options })
    expect(h.result.current.dialog).toBeNull()
    await execute(h, '/hotkeys')
    const newerId = h.result.current.dialog?.requestId
    await act(async () => {
      if (settlement === 'resolve') pending.resolve({ ...info, sessionName: 'late A owner' })
      else pending.reject(new Error('late A failure'))
    })
    expect(h.result.current.dialog?.requestId).toBe(newerId)
    expect(h.result.current.dialog?.title).toBe('Pion 快捷键')
    expect(h.result.current.dialog?.text).not.toContain('late A')
    expect(h.result.current.dialog?.error).toBeUndefined()
    expect(h.api.getSessionCommandInfo).toHaveBeenCalledTimes(1)
  })

  it.each(['api', 'backend', 'visibility'] as const)('never revives an old opening after %s changes A→B→A without a selection generation change', async (replacement) => {
    for (const settleWhileAway of [false, true]) {
      const h = harness()
      const pending = deferred<SessionCommandInfo>()
      h.api.getSessionCommandInfo.mockReturnValueOnce(pending.promise)
      await execute(h, '/session')
      const away: Options = replacement === 'api'
        ? { ...h.options, api: mockApi() as unknown as PionApi }
        : replacement === 'backend'
          ? { ...h.options, state: { ...h.options.state, liveSessionBackendId: 'temporary-backend' } }
          : { ...h.options, enabled: false }
      h.rerender(away)
      expect(h.result.current.dialog).toBeNull()
      if (settleWhileAway) await act(async () => { pending.resolve(info) })
      h.rerender({ ...h.options })
      expect(h.result.current.dialog).toBeNull()
      if (!settleWhileAway) await act(async () => { pending.resolve(info) })
      expect(h.result.current.dialog).toBeNull()
      await execute(h, '/session')
      expect(h.api.getSessionCommandInfo).toHaveBeenCalledTimes(2)
      expect(h.result.current.dialog?.title).toBe('Pi 会话信息')
    }
  })

  it.each(['backend', 'api'] as const)('does not publish old results or release the shared real-operation slot after %s replacement', async (replacement) => {
    const h = harness()
    const old = deferred<SessionCommandInfo>()
    h.api.getSessionCommandInfo.mockReturnValueOnce(old.promise)
    await execute(h, '/session')
    const replacementApi = mockApi()
    const next: Options = replacement === 'backend'
      ? { ...h.options, state: { ...h.options.state, liveSessionBackendId: 'backend-replacement' } }
      : { ...h.options, api: replacementApi as unknown as PionApi }
    h.rerender(next)
    expect(h.result.current.dialog).toBeNull()
    await execute(h, '/session')
    expect(h.api.getSessionCommandInfo).toHaveBeenCalledTimes(1)
    expect(replacementApi.getSessionCommandInfo).not.toHaveBeenCalled()
    expect(h.result.current.dialog?.error).toContain('实际操作尚未收口')
    await execute(h, '/hotkeys')
    const newerId = h.result.current.dialog?.requestId
    await act(async () => { old.resolve({ ...info, sessionName: 'late replaced backend' }) })
    expect(h.result.current.dialog?.title).toBe('Pion 快捷键')
    expect(h.result.current.dialog?.requestId).toBe(newerId)
    expect(h.result.current.dialog?.text).not.toContain('late replaced backend')
    await execute(h, '/session')
    if (replacement === 'backend') {
      expect(h.api.getSessionCommandInfo).toHaveBeenCalledTimes(2)
      expect(h.api.getSessionCommandInfo).toHaveBeenLastCalledWith({ ...target, backendId: 'backend-replacement' })
    } else {
      expect(replacementApi.getSessionCommandInfo).toHaveBeenCalledExactlyOnceWith(target)
    }
  })

  it('uses and fences the session live-state backend identity when no dedicated backend field is present', async () => {
    const state = readyState()
    state.liveSessionBackendId = undefined
    state.session = { ...state.session!, liveState: {
      backendId: 'fallback-backend', revision: 1, cwd: target.cwd, sessionPath: target.sessionPath, events: []
    } }
    const h = harness({ state })
    const pending = deferred<boolean>()
    h.api.copyLastAssistantText.mockReturnValueOnce(pending.promise)
    await execute(h, '/copy')
    expect(h.api.copyLastAssistantText).toHaveBeenCalledExactlyOnceWith({ ...target, backendId: 'fallback-backend' })
    h.rerender({ ...h.options, state: { ...state, session: { ...state.session!, liveState: {
      ...state.session!.liveState!, backendId: 'fallback-replacement'
    } } } })
    expect(h.result.current.dialog).toBeNull()
    await execute(h, '/hotkeys')
    await act(async () => { pending.resolve(true) })
    expect(h.result.current.dialog?.title).toBe('Pion 快捷键')
    expect(h.result.current.dialog?.text).not.toContain('已复制')
  })

  it('ignores a stale chooser callback after close or ownership changes, before any mutation', async () => {
    const h = harness()
    await execute(h, '/model')
    const stale = h.result.current.dialog!
    act(() => { stale.onClose() })
    await act(async () => { stale.onSelect?.(stale.entries![0].id) })
    expect(h.actions.setModel).not.toHaveBeenCalled()
    await execute(h, '/thinking')
    const older = h.result.current.dialog!
    h.options.selectionRef.current.generation += 1
    h.rerender({ ...h.options })
    await act(async () => { older.onSelect?.('max') })
    expectNoMutation(h)
  })

  it('deduplicates model choices while the real action is pending and preserves a newer unrelated dialog', async () => {
    const h = harness()
    const pending = deferred<void>()
    h.actions.setModel.mockReturnValueOnce(pending.promise)
    await execute(h, '/model')
    const dialog = h.result.current.dialog!
    const key = dialog.entries![1].id
    await act(async () => { dialog.onSelect?.(key); dialog.onSelect?.(key) })
    expect(h.actions.setModel).toHaveBeenCalledExactlyOnceWith('provider-two', 'duplicate')
    expect(h.result.current.dialog?.busy).toBe(true)
    await execute(h, '/hotkeys')
    const newerId = h.result.current.dialog?.requestId
    await act(async () => { pending.resolve(undefined) })
    expect(h.result.current.dialog?.requestId).toBe(newerId)
    expect(h.result.current.dialog?.title).toBe('Pion 快捷键')
    expect(h.result.current.dialog?.text).not.toContain('已选择')
    expectNoSendOrQueue(h)
  })
})

describe('App native command composition source contracts (no GUI)', () => {
  it('connects interception before ordinary send and separates preparation exceptions from all native names', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const composer = app.slice(app.indexOf('<Composer\n'), app.indexOf('</div>', app.indexOf('<Composer\n')))
    expect(composer).toContain('commands={composerCommands}')
    expect(composer).toContain('localCommandNames={PREPARATION_SLASH_COMMAND_NAMES}')
    expect(composer).toContain('nativeCommandNames={DESKTOP_SLASH_COMMAND_NAMES}')
    expect(composer).toContain('handleComposerSend(text, images)')
    const send = app.slice(app.indexOf('const handleComposerSend ='), app.indexOf('const composerCommands ='))
    expect(send).toMatch(/if \(viewingChild \|\| slashCommands\.execute\(text, images\)\) return[\s\S]*await actions\.send\(text, images\)/)
    expect(app).toContain('const merged = new Map(state.commands.map(')
    expect(app).toContain('for (const command of slashCommands.commands) merged.set(command.name, command)')
    expect(app).toContain('onNewSession: () => handleNewSession(undefined, true)')
    expect(app).toContain('onSelectSession: handleSelectSession')
    expect(app).toContain('await handleCopySession(state.status.cwd')
  })

  it('owns a sticky command slot, independent lazy/Suspense boundary and command stylesheet import', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const dialogs = readFileSync('src/renderer/src/app/WorkbenchDialogs.tsx', 'utf8')
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(app).toContain('const commandDialogMounted = useDeferredMount(slashCommands.dialog !== null)')
    expect(app).toMatch(/command=\{\{\s*mounted: commandDialogMounted,/)
    expect(app).toContain('open: !settingsOpen && !viewingChild && toolPermissionRequests.length === 0 && extensionUiRequests.length === 0')
    expect(dialogs).toContain("const LazyCommandDialog = lazy(() => import('../features/commands/CommandDialog')")
    expect(dialogs).toMatch(/\{command\?\.mounted && \(\s*<Suspense fallback=\{null\}>\s*<LazyCommandDialog \{\.\.\.command\.dialog\} \/>\s*<\/Suspense>\s*\)\}/)
    expect(css).toContain("@import './styles/commands.css';")
  })
})
