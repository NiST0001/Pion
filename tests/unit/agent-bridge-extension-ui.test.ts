import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { PendingRequestStore } from '../../src/main/agent/pending-requests'
import type { ProviderAuthUi } from '../../src/main/agent/provider-auth-ui'
import { RunStore } from '../../src/main/run-store'
import { DEFAULT_TOOL_PERMISSION_RULES, RUN_CHECKPOINT_MARKER, TOOL_PERMISSION_MARKER, ToolPermissionStore } from '../../src/main/tool-permissions'
import { IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import { QUESTION_WAIT_WIDGET_KEY } from '../../src/shared/question-settings'
import { QUESTION_CUSTOM_ANSWER_OPTION, encodeQuestionCustomAnswer } from '../../src/shared/question-answer'
import type { ExtensionUiRequest, ExtensionUiResponse, RunOperation } from '../../src/shared/types'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })))
})

async function fixture(): Promise<{
  bridge: AgentBridge
  backend: Record<string, unknown>
  writes: string[]
  handle(event: unknown): boolean
  emit(event: unknown): void
  prepareQuestion(): void
}> {
  const root = await mkdtemp(join(tmpdir(), 'pion-extension-ui-'))
  roots.push(root)
  const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')))
  const writes: string[] = []
  let listener: ((event: unknown) => void) | undefined
  const backend = {
    key: 'backend-1',
    cwd: root,
    client: {
      onEvent: (callback: (event: unknown) => void) => { listener = callback },
      getState: vi.fn(async () => ({})),
      process: {
        stdin: {
          destroyed: false,
          writable: true,
          write: (value: string) => writes.push(value)
        }
      }
    },
    phase: 'running',
    busy: true,
    queueAutoReady: false,
    pendingRunIds: [],
    startPromise: Promise.resolve()
  }
  const internals = bridge as unknown as {
    backendPool: { add(backendValue: unknown): void }
    handleExtensionUiRequest(backendValue: unknown, event: unknown): boolean
    attachBackendEvents(backendValue: unknown): void
    createRun(backendValue: unknown, state: null, message: string, images: [], kind: 'prompt', status: 'dispatching'): RunOperation
  }
  internals.backendPool.add(backend)
  internals.attachBackendEvents(backend)
  return {
    bridge,
    backend,
    writes,
    handle: (event) => internals.handleExtensionUiRequest(backend, event),
    emit: (event) => listener?.(event),
    prepareQuestion: () => {
      const run = internals.createRun(backend, null, 'question fixture', [], 'prompt', 'dispatching')
      Object.assign(backend, { questionUiNonce: 'nonce', nativeToolReceipts: new Map([['native-question', {
        name: 'pion_ask_user', runId: run.id, backendId: run.usageBackendId, rootId: 'native-question',
        state: 'running', usageConsumed: false
      }]]) })
    }
  }
}

function beginNativeQuestion(h: Awaited<ReturnType<typeof fixture>>): void {
  h.prepareQuestion()
  h.emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: QUESTION_WAIT_WIDGET_KEY,
    widgetLines: [JSON.stringify({ version: 1, nonce: 'nonce', toolCallId: 'native-question', phase: 'begin', timeoutMs: 60_000 })] })
}

describe('AgentBridge extension UI requests', () => {
  it('encodes only validated native custom answers into the existing SDK select value', async () => {
    const h = await fixture()
    beginNativeQuestion(h)
    h.handle({ type: 'extension_ui_request', id: 'native-select', method: 'select', title: '目标平台',
      options: ['1. Windows', '2. Linux', QUESTION_CUSTOM_ANSWER_OPTION] })
    const request = h.bridge.getPendingExtensionUiRequests()[0]
    expect(request.question).toBe(true)
    for (const value of ['unknown choice', encodeQuestionCustomAnswer('untyped custom answer')]) {
      await expect(h.bridge.resolveExtensionUiRequest(request.id, { value })).rejects.toThrow('无效的交互响应')
    }
    for (const customAnswer of [undefined, null, 42, '', ' \t ', 'a'.repeat(256_001)]) {
      await expect(h.bridge.resolveExtensionUiRequest(request.id,
        { customAnswer, value: '1. Windows', confirmed: true, cancelled: true } as unknown as ExtensionUiResponse))
        .rejects.toThrow('无效的交互响应')
    }
    for (const extra of [{ value: '1. Windows' }, { cancelled: true }, { confirmed: true }]) {
      await expect(h.bridge.resolveExtensionUiRequest(request.id,
        { customAnswer: 'macOS', ...extra } as unknown as ExtensionUiResponse)).rejects.toThrow('无效的交互响应')
    }
    expect(h.bridge.getPendingExtensionUiRequests()).toEqual([request])
    expect(h.writes).toEqual([])
    const customAnswer = `  ${'a'.repeat(255_996)}  `
    await h.bridge.resolveExtensionUiRequest(request.id, { customAnswer })
    expect(h.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(JSON.parse(h.writes[0])).toEqual({
      type: 'extension_ui_response', id: 'native-select', value: encodeQuestionCustomAnswer(customAnswer)
    })
  })

  it.each(['ordinary', 'native-input', 'native-no-custom', 'global'])('rejects custom answers outside a supported native select (%s)', async (mode) => {
    const h = await fixture()
    if (mode !== 'ordinary') beginNativeQuestion(h)
    h.handle({ type: 'extension_ui_request', id: 'unsupported-custom', method: mode === 'native-input' ? 'input' : 'select',
      title: 'AI 提问：相同标题不能证明原生来源',
      options: mode === 'native-no-custom' ? ['1. Windows', '2. Linux'] : ['1. Windows', QUESTION_CUSTOM_ANSWER_OPTION] })
    const request = h.bridge.getPendingExtensionUiRequests()[0]
    if (mode === 'global') {
      const internal = h.bridge as unknown as { pendingRequests: PendingRequestStore }
      internal.pendingRequests.getExtensionUi(request.id)!.request.scope = 'global'
    }
    await expect(h.bridge.resolveExtensionUiRequest(request.id, { customAnswer: 'macOS' })).rejects.toThrow('无效的交互响应')
    expect(h.bridge.getPendingExtensionUiRequests()).toHaveLength(1)
    expect(h.writes).toEqual([])
    await h.bridge.resolveExtensionUiRequest(request.id, { cancelled: true })
  })

  it('rejects custom answers for global provider authentication even with question-like options', async () => {
    const h = await fixture()
    const internal = h.bridge as unknown as { providerAuthUi: ProviderAuthUi }
    const answer = internal.providerAuthUi.request('auth', { method: 'select', title: '登录', question: true,
      options: [QUESTION_CUSTOM_ANSWER_OPTION] }, [])
    const request = h.bridge.getPendingExtensionUiRequests()[0]
    expect(request).toMatchObject({ scope: 'global', source: 'provider-auth' })
    await expect(h.bridge.resolveExtensionUiRequest(request.id, { customAnswer: 'token' })).rejects.toThrow('无效的交互响应')
    expect(h.bridge.getPendingExtensionUiRequests()).toHaveLength(1)
    expect(h.writes).toEqual([])
    await h.bridge.resolveExtensionUiRequest(request.id, { cancelled: true })
    expect(await answer).toEqual({ cancelled: true })
  })

  it.each(['valid', 'wrong-nonce', 'unknown-tool', 'nested', 'ended'])('consumes private question widgets and admits only the captured running source (%s)', async (mode) => {
    const h = await fixture()
    h.prepareQuestion()
    if (mode === 'ended') (h.backend.nativeToolReceipts as Map<string, { state: string }>).get('native-question')!.state = 'ended'
    h.emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: QUESTION_WAIT_WIDGET_KEY,
      ...(mode === 'nested' ? { parentToolCallId: 'parent' } : {}), widgetLines: [JSON.stringify({
        version: 1, nonce: mode === 'wrong-nonce' ? 'other' : 'nonce',
        toolCallId: mode === 'unknown-tool' ? 'unknown' : 'native-question', phase: 'begin', timeoutMs: null
      })] })
    expect(h.bridge.getPendingExtensionUiRequests()).toHaveLength(0)
    h.handle({ type: 'extension_ui_request', id: 'question', method: 'input', title: '问题' })
    const request = h.bridge.getPendingExtensionUiRequests()[0]
    expect(request.question).toBe(mode === 'valid' ? true : undefined)
    expect(request.timeoutAt === null).toBe(mode === 'valid')
    await h.bridge.resolveExtensionUiRequest(request.id, { cancelled: true })
  })
  it.each([null, 20 * 60_000])('honors an already-admitted native question deadline (%s), without extending ordinary UI policy', async (timeoutMs) => {
    vi.useFakeTimers()
    const h = await fixture()
    const internal = h.bridge as unknown as {
      capturePendingScope(backend: unknown): unknown
      questionWaitStages: WeakMap<object, unknown>
    }
    internal.questionWaitStages = new WeakMap()
    internal.questionWaitStages.set(h.backend, { version: 1, nonce: 'test', toolCallId: 'native-question',
      phase: 'begin', timeoutMs, scope: internal.capturePendingScope(h.backend) })
    h.handle({ type: 'extension_ui_request', id: 'ask-native', method: 'input', title: '问题' })
    const request = h.bridge.getPendingExtensionUiRequests()[0]
    expect(request.question).toBe(true)
    expect(request.timeoutAt).toBe(timeoutMs === null ? null : request.createdAt + timeoutMs)
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(h.bridge.getPendingExtensionUiRequests()).toHaveLength(1)
    await h.bridge.resolveExtensionUiRequest(request.id, { value: '回答' })
    h.handle({ type: 'extension_ui_request', id: 'ordinary', method: 'input', title: '插件' })
    const ordinary = h.bridge.getPendingExtensionUiRequests()[0]
    expect(ordinary.question).toBeUndefined()
    expect(ordinary.timeoutAt).toBe(ordinary.createdAt + 10 * 60_000)
    await h.bridge.resolveExtensionUiRequest(ordinary.id, { cancelled: true })
  })
  it.each([{ cancelled: true as const }, { value: '   ' }])('keeps an unanswered question busy until actual settlement (%j)', async (response) => {
    const h = await fixture()
    h.backend.activeRunId = 'current-run'
    h.handle({ type: 'extension_ui_request', id: 'ask', method: 'input', title: '请选择' })
    await h.bridge.resolveExtensionUiRequest(h.bridge.getPendingExtensionUiRequests()[0].id, response)
    expect(h.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false, activeRunId: 'current-run' })
    expect(h.backend.turnInterrupted).not.toBe(true)
    expect(JSON.parse(h.writes[0])).toMatchObject({ id: 'ask', ...response })
    h.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false })
    h.emit({ type: 'agent_settled' })
    expect(h.backend).toMatchObject({ busy: false, queueAutoReady: true })
  })

  it('times out only the captured run and client', async () => {
    vi.useFakeTimers()
    const h = await fixture()
    h.backend.activeRunId = 'old-run'
    h.handle({ type: 'extension_ui_request', id: 'ask-old', method: 'input', title: '问题', timeout: 1000 })
    const writes: string[] = []
    h.backend.client = { process: { stdin: { destroyed: false, writable: true, write: (text: string) => writes.push(text) } } }
    h.backend.activeRunId = 'new-run'
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false, activeRunId: 'new-run' })
    expect(writes).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('rejects a late answer after current-run ownership changes without pausing or replying', async () => {
    const h = await fixture()
    h.backend.activeRunId = 'old-run'
    h.handle({ type: 'extension_ui_request', id: 'ask-old', method: 'input', title: '问题' })
    const id = h.bridge.getPendingExtensionUiRequests()[0].id
    h.backend.activeRunId = 'new-run'
    await expect(h.bridge.resolveExtensionUiRequest(id, { cancelled: true })).rejects.toThrow('已关闭')
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false, activeRunId: 'new-run' })
    expect(h.writes).toEqual([])
  })

  it('keeps the captured turn busy after question timeout until actual settlement', async () => {
    vi.useFakeTimers()
    const h = await fixture()
    h.backend.activeRunId = 'current-run'
    h.handle({ type: 'extension_ui_request', id: 'ask-timeout', method: 'input', title: '问题', timeout: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false, activeRunId: 'current-run', turnInterrupted: true })
    expect(JSON.parse(h.writes[0])).toMatchObject({ id: 'ask-timeout', cancelled: true })
    h.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', content: [] }] })
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false })
    h.emit({ type: 'agent_settled' })
    expect(h.backend).toMatchObject({ busy: false, queueAutoReady: true })
  })

  it('does not treat a tool permission deadline as actual run settlement', async () => {
    vi.useFakeTimers()
    const h = await fixture()
    h.backend.activeRunId = 'permission-run'
    h.handle({
      type: 'extension_ui_request', id: 'permission-timeout', method: 'select', timeout: 1000,
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify({
        cwd: h.backend.cwd, toolName: 'write', category: 'write', policyCategories: ['write'],
        summary: '写文件', detail: '写文件', risks: [], canRemember: true
      })}`
    })
    const request = h.bridge.getPendingToolPermissionRequests()[0]
    expect(request).toBeDefined()
    await vi.advanceTimersByTimeAsync(request.timeoutAt - Date.now() + 250)
    expect(h.bridge.getPendingToolPermissionRequests()).toEqual([])
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false, activeRunId: 'permission-run', turnInterrupted: true })
    expect((h.backend.client as { getState: unknown }).getState).not.toHaveBeenCalled()
    h.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', content: [] }] })
    expect(h.backend).toMatchObject({ busy: true, queueAutoReady: false })
    h.emit({ type: 'agent_settled' })
    expect(h.backend).toMatchObject({ busy: false, queueAutoReady: true })
  })

  it('queues and resolves plan questionnaire selections through RPC stdin', async () => {
    const value = await fixture()
    const option = '1. 保持兼容 — 改动较小'
    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-request-1',
      method: 'select',
      title: '实现方式: 请选择计划方向',
      options: [option, '2. 完整重构 — 长期维护更容易']
    })).toBe(true)

    const requests = value.bridge.getPendingExtensionUiRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'select',
      options: [option, '2. 完整重构 — 长期维护更容易']
    } satisfies Partial<ExtensionUiRequest>)

    await value.bridge.resolveExtensionUiRequest(requests[0].id, { value: option })
    expect(value.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response',
      id: 'pi-request-1',
      value: option
    })
  })

  it('notifies listeners when a tool permission request is queued', async () => {
    const value = await fixture()
    const listener = vi.fn()
    const off = value.bridge.onToolPermissionRequested(listener)
    const metadata = {
      cwd: value.backend.cwd,
      toolName: 'write',
      category: 'write',
      policyCategories: ['write'],
      summary: '需要修改项目文件',
      detail: '写入文件',
      risks: [],
      canRemember: true
    }

    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-permission-1',
      method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify(metadata)}`
    })).toBe(true)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'write',
      summary: '需要修改项目文件'
    }))
    off()
  })

  it('projects backend ownership without replacing the canonical permission policy path', async () => {
    const value = await fixture()
    const policyCwd = value.backend.cwd as string
    const sessionPath = join(policyCwd, 'parent.jsonl')
    Object.assign(value.backend, { cwd: join(policyCwd, 'project-link'), sessionPath })
    const store = (value.bridge as unknown as { toolPermissionStore: ToolPermissionStore }).toolPermissionStore
    const policy = { cwd: policyCwd, source: 'saved' as const, rules: { ...DEFAULT_TOOL_PERMISSION_RULES } }
    const grant = vi.spyOn(store, 'allowProjectCategories').mockResolvedValue(policy)
    value.handle({
      type: 'extension_ui_request', id: 'alias-permission', method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify({
        cwd: policyCwd, sessionPath: '/different-metadata-session.jsonl', toolName: 'write',
        category: 'write', policyCategories: ['write'], summary: '修改文件', detail: '', risks: [], canRemember: true
      })}`
    })
    const request = value.bridge.getPendingToolPermissionRequests()[0]
    expect(request).toMatchObject({ cwd: value.backend.cwd, sessionPath })
    await value.bridge.resolveToolPermission(request.id, 'allow-project')
    expect(grant).toHaveBeenCalledWith(policyCwd, ['write'])
    expect(value.bridge.getPendingToolPermissionRequests()).toEqual([])
  })

  it('answers a stale image project grant with deny when a requested category is now denied', async () => {
    const value = await fixture()
    const store = (value.bridge as unknown as { toolPermissionStore: ToolPermissionStore }).toolPermissionStore
    const policy = {
      cwd: value.backend.cwd as string, source: 'saved' as const,
      rules: { ...DEFAULT_TOOL_PERMISSION_RULES, network: 'deny' as const, write: 'ask' as const }
    }
    const grant = vi.spyOn(store, 'allowProjectCategories').mockResolvedValue(policy)
    value.handle({
      type: 'extension_ui_request', id: 'pi-image-permission-denied', method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify({
        cwd: value.backend.cwd, toolName: IMAGE_GENERATION_TOOL_NAME,
        category: 'network', policyCategories: ['network', 'write'],
        summary: '生成图片', detail: '写入新图片并使用 Codex 图片额度', risks: [], canRemember: true
      })}`
    })
    const request = value.bridge.getPendingToolPermissionRequests()[0]
    expect(await value.bridge.resolveToolPermission(request.id, 'allow-project')).toEqual(policy)
    expect(grant).toHaveBeenCalledWith(value.backend.cwd, ['network', 'write'])
    expect(value.bridge.getPendingToolPermissionRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response', id: 'pi-image-permission-denied', value: 'deny'
    })
  })

  it('auto-approves tool permission requests while yolo mode is enabled', async () => {
    const value = await fixture()
    const listener = vi.fn()
    value.bridge.onToolPermissionRequested(listener)
    ;(value.bridge as unknown as { yoloSessions: Set<string> }).yoloSessions.add('backend-1')
    const metadata = {
      cwd: value.backend.cwd,
      toolName: 'bash',
      category: 'shell',
      policyCategories: ['shell'],
      summary: '执行终端命令',
      detail: 'npm test',
      risks: [],
      canRemember: true
    }

    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-permission-yolo',
      method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify(metadata)}`
    })).toBe(true)

    expect(listener).not.toHaveBeenCalled()
    expect(value.bridge.getPendingToolPermissionRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response',
      id: 'pi-permission-yolo',
      value: 'allow-once'
    })
  })

  it('creates the run checkpoint lazily through the gate marker', async () => {
    const value = await fixture()
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q'], { cwd: value.backend.cwd as string })
    ;(value.backend as { activeRunId?: string }).activeRunId = 'run-1'

    expect(value.handle({
      type: 'extension_ui_request',
      id: 'gate-1',
      method: 'select',
      title: RUN_CHECKPOINT_MARKER
    })).toBe(true)

    // 检查点创建要走一串 git 子进程，Windows 高负载下可能超过 waitFor 默认 1s
    await vi.waitFor(() => {
      expect(value.writes.some((line) => line.includes('gate-1'))).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    const response = JSON.parse(value.writes.find((line) => line.includes('gate-1')) ?? '{}')
    expect(response).toMatchObject({
      type: 'extension_ui_response',
      id: 'gate-1',
      value: 'ready'
    })
    const firstCheckpoint = (value.backend as { checkpoint?: unknown }).checkpoint
    expect(firstCheckpoint).toBeTruthy()

    // A second gate in the same run reuses the checkpoint instead of recreating it.
    expect(value.handle({
      type: 'extension_ui_request',
      id: 'gate-2',
      method: 'select',
      title: RUN_CHECKPOINT_MARKER
    })).toBe(true)
    await vi.waitFor(() => {
      expect(value.writes.some((line) => line.includes('gate-2'))).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    expect((value.backend as { checkpoint?: unknown }).checkpoint).toBe(firstCheckpoint)
  })

  it('restores persisted queued runs into the live queue on session sync', async () => {
    const value = await fixture()
    const sessionPath = join(value.backend.cwd as string, 'session.jsonl')
    ;(value.bridge as unknown as { runStore: RunStore }).runStore.create({
      id: 'queued-run-1',
      cwd: value.backend.cwd as string,
      sessionPath,
      kind: 'follow-up',
      state: 'queued',
      createdAt: Date.now(),
      prompt: { message: '重启前排队的消息', images: [] },
      promptPreview: '重启前排队的消息',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: 0 },
      tools: [],
      compactions: [],
      revision: 0
    })
    ;(value.backend.client as { getState?: unknown }).getState = async () => ({ sessionFile: sessionPath })

    await (value.bridge as unknown as { syncBackendSession(b: unknown): Promise<void> })
      .syncBackendSession(value.backend)

    const followUps = (value.backend as { localFollowUps?: Array<{ text: string }> }).localFollowUps
    expect(followUps?.map((item) => item.text)).toEqual(['重启前排队的消息'])

    // 幂等：再次同步不重复入队
    await (value.bridge as unknown as { syncBackendSession(b: unknown): Promise<void> })
      .syncBackendSession(value.backend)
    expect((value.backend as { localFollowUps?: unknown[] }).localFollowUps).toHaveLength(1)
  })

  it('cancels malformed interactive requests instead of leaving the Agent waiting', async () => {
    const value = await fixture()
    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-request-bad',
      method: 'select',
      title: 'missing options',
      options: []
    })).toBe(true)

    expect(value.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response',
      id: 'pi-request-bad',
      cancelled: true
    })
  })
})
