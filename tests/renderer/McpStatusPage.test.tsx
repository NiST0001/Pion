// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpStatusPage } from '../../src/renderer/src/features/capabilities/McpStatusPage'
import { SkillsToolsModal } from '../../src/renderer/src/features/capabilities/SkillsToolsModal'
import type { McpServerState, McpServerStatus, McpStatusSnapshot } from '../../src/shared/mcp'
import type { PionApi } from '../../src/shared/pion-api'

const targetA = { cwd: '/repo/a', sessionPath: '/sessions/a.jsonl' }
const targetB = { cwd: '/repo/b', sessionPath: '/sessions/b.jsonl' }

function snapshot(overrides: Partial<McpStatusSnapshot> = {}): McpStatusSnapshot {
  return {
    ...targetA, backendId: 'backend-a', runtimeId: 'runtime-a', revision: 1, receivedAt: Date.now(),
    availability: 'native', phase: 'ready', diagnosticsOmitted: false,
    servers: [{ name: 'a-server', state: 'connected', exposure: 'deferred', toolCount: 3 }],
    ...overrides
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}
function fakeApi() {
  const listeners = new Set<(value: McpStatusSnapshot) => void>()
  const subscriptions: { listener: (value: McpStatusSnapshot) => void; unsubscribe: ReturnType<typeof vi.fn> }[] = []
  const order: string[] = []
  const api = {
    getMcpStatus: vi.fn<PionApi['getMcpStatus']>(async () => { order.push('read'); return snapshot() }),
    onMcpStatus: vi.fn<PionApi['onMcpStatus']>((listener) => {
      order.push('subscribe')
      listeners.add(listener)
      const unsubscribe = vi.fn(() => { listeners.delete(listener) })
      subscriptions.push({ listener, unsubscribe })
      return unsubscribe
    }),
    getCapabilities: vi.fn<PionApi['getCapabilities']>(async () => ({ skills: [], tools: [
      { name: 'mcp__registered__tool', label: 'Registered metadata only', source: 'builtin' }
    ] }))
  } satisfies Pick<PionApi, 'getMcpStatus' | 'onMcpStatus' | 'getCapabilities'>
  vi.stubGlobal('pion', api)
  return { api, order, subscriptions, push: (value: McpStatusSnapshot) => {
    act(() => { for (const listener of listeners) listener(value) })
  } }
}
async function flush(): Promise<void> { await act(async () => undefined) }
async function advance(ms: number): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const mcpTab = () => fireEvent.click(screen.getByRole('button', { name: /MCP.*服务器状态/ }))
const toolsTab = () => fireEvent.click(screen.getByRole('button', { name: /工具.*文件与命令/ }))
const refresh = () => fireEvent.click(screen.getByRole('button', { name: '刷新' }))
let visibility: DocumentVisibilityState

// These API mocks are memory-only: no Electron, SDK, config, server or session starts.
describe('McpStatusPage read-only observations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('does not fetch MCP on skills/tools tabs or infer connections from capability metadata', async () => {
    const { api, order } = fakeApi()
    api.getMcpStatus.mockResolvedValue(snapshot({ servers: [] }))
    const { rerender } = render(<SkillsToolsModal open onClose={vi.fn()} target={targetA} />)
    await flush()
    expect(api.getCapabilities).toHaveBeenCalledTimes(1)
    expect(api.getMcpStatus).not.toHaveBeenCalled()
    expect(api.onMcpStatus).not.toHaveBeenCalled()
    toolsTab()
    expect(screen.getByText('Registered metadata only')).toBeInTheDocument()
    expect(api.getMcpStatus).not.toHaveBeenCalled()
    mcpTab()
    await flush()
    expect(screen.getByRole('heading', { level: 3, name: 'MCP' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('未配置服务器')
    expect(screen.queryByText('registered')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // A resolved-value mock does not log its implementation, so test subscription
    // ordering with the actual default fake reader on the next mount.
    toolsTab()
    api.getMcpStatus.mockImplementation(async () => { order.push('read'); return snapshot() })
    mcpTab()
    await flush()
    expect(order.slice(-2)).toEqual(['subscribe', 'read'])
    expect(api.getCapabilities).toHaveBeenCalledTimes(1)
    rerender(<SkillsToolsModal open={false} onClose={vi.fn()} target={targetA} />)
    await advance(15_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
  })

  it('distinguishes all eight server states, actual zero tools, unknown counts and hidden exposure', async () => {
    const { api } = fakeApi()
    const states: McpServerState[] = ['connecting', 'connected', 'disconnected', 'needs-auth', 'failed', 'closed', 'starting', 'disabled']
    api.getMcpStatus.mockResolvedValue(Object.assign(snapshot({ servers: states.map<McpServerStatus>((state, index) => ({
      name: `server-${index}`, state, exposure: index === 7 ? 'hidden' : index === 5 ? 'codemode' : index === 4 ? 'direct' : 'deferred',
      ...(state === 'connected' ? { toolCount: 0 } : {})
    })) }), { error: 'secret-diagnostic', url: 'https://secret.invalid', headers: { Authorization: 'secret-token' }, command: 'secret-command' }))
    const { container } = render(<McpStatusPage target={targetA} />)
    await flush()
    const table = screen.getByRole('table', { name: 'MCP 服务器状态' })
    for (const label of ['连接中', '已连接', '已断开', '等待登录', '连接失败', '已关闭', '等待启动', '已禁用']) {
      expect(within(table).getByText(label)).toBeInTheDocument()
    }
    expect(within(table).getByText('0 项')).toBeInTheDocument()
    expect(within(table).getAllByText('未统计')).toHaveLength(7)
    expect(within(table).getByText('已隐藏')).toHaveAttribute('title', '隐藏工具不停止服务器连接。')
    expect(screen.getByText(/后台约每 3 秒更新/)).toHaveTextContent('工具数是服务器登记数量，不等于已获准数量')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
    expect(container.querySelector('a, input, select, img')).toBeNull()
    expect(container).not.toHaveTextContent('secret-')
    expect(container).not.toHaveTextContent('secret.invalid')
  })

  it.each([
    { availability: 'replaced', phase: 'unavailable', title: '旧插件接管' },
    { availability: 'inactive', phase: 'unavailable', title: '原生 MCP 未启用' },
    { availability: 'unavailable', phase: 'unavailable', reason: 'no-backend', title: '没有会话后端' },
    { availability: 'native', phase: 'waiting', reason: 'waiting-status', title: '等待状态' },
    { availability: 'native', phase: 'unavailable', reason: 'query-timeout', title: '状态查询超时' },
    { availability: 'native', phase: 'unavailable', reason: 'unsupported-sdk', title: '状态格式不受支持' },
  ] as const)('separates the safe $title observation from a legitimate empty native list', async ({ title, ...status }) => {
    const { api } = fakeApi()
    api.getMcpStatus.mockResolvedValue(snapshot({ ...status, servers: [] }))
    render(<McpStatusPage target={targetA} />)
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent(title)
    expect(screen.getByRole('status')).not.toHaveTextContent('未配置服务器')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('does not call an omitted diagnostic tail an empty configuration', async () => {
    const { api } = fakeApi()
    api.getMcpStatus.mockResolvedValue(snapshot({ servers: [], diagnosticsOmitted: true }))
    render(<McpStatusPage target={targetA} />)
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent('暂无可列出的服务器')
    expect(screen.getByRole('status')).toHaveTextContent('不能据此判定配置为空')
    expect(screen.getByText(/部分诊断已省略/)).toBeInTheDocument()
    expect(screen.queryByText('未配置服务器')).not.toBeInTheDocument()
  })

  it('hides an old connected list on read failure without exposing raw exceptions and allows explicit retry', async () => {
    const { api } = fakeApi()
    render(<McpStatusPage target={targetA} />)
    await flush()
    expect(screen.getByText('a-server')).toBeInTheDocument()
    api.getMcpStatus.mockRejectedValueOnce(new Error('Authorization=secret-token https://secret.invalid --secret-command'))
    refresh()
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent('读取状态失败')
    expect(document.body).not.toHaveTextContent('secret')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    refresh()
    await flush()
    expect(screen.getByText('a-server')).toBeInTheDocument()
  })

  it('lets a new backend push win over an initially captured old backend read with a higher revision', async () => {
    const { api, push } = fakeApi()
    const oldRead = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValueOnce(oldRead.promise)
    render(<McpStatusPage target={targetA} scope="same-tuple" />)
    const replacement = snapshot({ backendId: 'backend-b', runtimeId: 'runtime-b', revision: 1,
      servers: [{ name: 'new-backend', state: 'connected', exposure: 'direct', toolCount: 7 }] })
    push(replacement)
    expect(screen.getByText('new-backend')).toBeInTheDocument()
    await act(async () => { oldRead.resolve(snapshot({ revision: 99 })); await oldRead.promise })
    expect(screen.getByText('new-backend')).toBeInTheDocument()
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
    api.getMcpStatus.mockResolvedValue(replacement)
    await advance(3_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText('new-backend')).toBeInTheDocument()
  })

  it('orders the same backend by main revision, not by a changing runtimeId', async () => {
    const { api, push } = fakeApi()
    api.getMcpStatus.mockResolvedValue(snapshot({ revision: 20 }))
    render(<McpStatusPage target={targetA} />)
    await flush()
    push(snapshot({ revision: 21, runtimeId: 'sdk-reloaded', servers: [{ name: 'after-reload', state: 'connecting', exposure: 'hidden' }] }))
    push(snapshot({ revision: 19, runtimeId: 'sdk-older' }))
    expect(screen.getByText('after-reload')).toBeInTheDocument()
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
    await advance(3_000)
    expect(screen.getByText('after-reload')).toBeInTheDocument()
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
    push(snapshot({ backendId: 'replacement-backend', revision: 1,
      servers: [{ name: 'replacement', state: 'connected', exposure: 'direct', toolCount: 2 }] }))
    push(snapshot({ revision: 100 })) // A previously displayed, superseded backend cannot revive.
    expect(screen.getByText('replacement')).toBeInTheDocument()
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
  })

  it('requires a bound backend to match and replaces old connections with a safe owner-loss reply', async () => {
    const { api, push } = fakeApi()
    render(<McpStatusPage target={{ ...targetA, backendId: 'backend-a' }} />)
    await flush()
    push(snapshot({ backendId: 'backend-b', revision: 99, servers: [{ name: 'wrong-backend', state: 'connected', exposure: 'direct', toolCount: 1 }] }))
    expect(screen.queryByText('wrong-backend')).not.toBeInTheDocument()
    expect(screen.getByText('a-server')).toBeInTheDocument()
    api.getMcpStatus.mockResolvedValueOnce(snapshot({ availability: 'unavailable', phase: 'unavailable', reason: 'no-backend',
      backendId: undefined, runtimeId: undefined, revision: 0, servers: [] }))
    refresh()
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent('没有会话后端')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    api.getMcpStatus.mockResolvedValueOnce(snapshot({ backendId: 'backend-b' }))
    refresh()
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent('状态未知')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('reads a new selection independently while rejecting the old read, catch and finally', async () => {
    const { api, subscriptions, push } = fakeApi()
    const pending = deferred<McpStatusSnapshot>()
    const next = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValueOnce(pending.promise).mockReturnValueOnce(next.promise)
    const selectionRef = { current: { generation: 1 } }
    const { rerender } = render(<McpStatusPage target={targetA} scope="A" selectionRef={selectionRef} />)
    selectionRef.current.generation = 2
    rerender(<McpStatusPage target={targetB} scope="B" selectionRef={selectionRef} />)
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    act(() => { subscriptions[0].listener(snapshot()) })
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
    const b = snapshot({ ...targetB, backendId: 'backend-b', servers: [{ name: 'b-server', state: 'connected', exposure: 'direct', toolCount: 4 }] })
    push(b)
    await act(async () => { pending.reject(new Error('secret-old-scope')); await pending.promise.catch(() => undefined) })
    expect(screen.getByText('b-server')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('secret-old-scope')
    await advance(3_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    await act(async () => { next.resolve(b); await next.promise })
    api.getMcpStatus.mockResolvedValue(b)
    await advance(3_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(3)
    expect(api.getMcpStatus.mock.calls.at(-1)?.[0]).toEqual(targetB)
    expect(screen.getByText('b-server')).toBeInTheDocument()
  })

  it('expires a connected push independently of a permanently pending read', async () => {
    const { api, push } = fakeApi()
    const pending = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValue(pending.promise)
    render(<McpStatusPage target={targetA} />)
    const observed = snapshot()
    push(observed)
    expect(screen.getByText('a-server')).toBeInTheDocument()
    await advance(12_001)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('状态已过期')
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    // The same observation keeps its deadline after a clock rollback.
    vi.setSystemTime(new Date(observed.receivedAt - 60_000))
    push(observed)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('状态已过期')
    push(snapshot({ ...observed, revision: 2, receivedAt: Date.now() }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    await act(async () => { pending.resolve(observed); await pending.promise })
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
  })

  it('does not renew a ready observation by repeatedly reading the same cache frame', async () => {
    const { api, push } = fakeApi()
    const observed = snapshot()
    api.getMcpStatus.mockResolvedValue(observed)
    render(<McpStatusPage target={targetA} />)
    await flush()
    await advance(11_999)
    expect(screen.getByRole('table')).toBeInTheDocument()
    await advance(2)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('状态已过期')
    refresh()
    await flush()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    push(snapshot({ revision: 2 }))
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('rejects an A→B→A late result before React commits even when scope strings match', async () => {
    const { api, push } = fakeApi()
    const pending = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValueOnce(pending.promise)
    const selectionRef = { current: { generation: 1 } }
    const { rerender } = render(<McpStatusPage target={targetA} scope="A" selectionRef={selectionRef} />)
    // This is the actual mutable selection ref, not a render-time copy. No
    // intervening React render is needed to invalidate all old closures.
    selectionRef.current.generation++ // B intent
    selectionRef.current.generation++ // A intent
    push(snapshot({ servers: [{ name: 'late-push', state: 'connected', exposure: 'direct', toolCount: 1 }] }))
    await act(async () => {
      pending.resolve(snapshot())
      await pending.promise
    })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '读取中…' })).toBeDisabled() // late finally cannot flip it.
    await advance(3_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    rerender(<McpStatusPage target={targetA} scope="A" selectionRef={selectionRef} />)
    await flush()
    expect(screen.getByText('a-server')).toBeInTheDocument()
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
  })

  it('reads again after tab switches or reopening while retiring the old page callbacks', async () => {
    const { api, subscriptions } = fakeApi()
    const pending = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValueOnce(pending.promise)
    const close = vi.fn()
    const { rerender } = render(<SkillsToolsModal open onClose={close} target={targetA} />)
    await flush()
    mcpTab()
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    toolsTab()
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    await advance(15_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    const fresh = snapshot({ servers: [{ name: 'remounted', state: 'connected', exposure: 'direct', toolCount: 1 }] })
    api.getMcpStatus.mockImplementation(async () => snapshot({ ...fresh, receivedAt: Date.now() }))
    mcpTab()
    await flush()
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText('remounted')).toBeInTheDocument()
    rerender(<SkillsToolsModal open={false} onClose={close} target={targetA} />)
    expect(subscriptions[1].unsubscribe).toHaveBeenCalledTimes(1)
    await advance(15_000)
    rerender(<SkillsToolsModal open onClose={close} target={targetA} />)
    await flush()
    expect(screen.getByRole('heading', { level: 3, name: '技能' })).toBeInTheDocument()
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    mcpTab()
    await flush()
    expect(api.getMcpStatus).toHaveBeenCalledTimes(3)
    act(() => { subscriptions[0].listener(snapshot()) })
    await act(async () => { pending.resolve(snapshot()); await pending.promise })
    expect(screen.getByText('remounted')).toBeInTheDocument()
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
  })

  it('subscribes/reads only while visible and rejects an earlier visibility epoch after showing again', async () => {
    const { api, subscriptions, push } = fakeApi()
    const pending = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValueOnce(pending.promise)
    visibility = 'hidden'
    render(<McpStatusPage target={targetA} />)
    expect(api.getMcpStatus).not.toHaveBeenCalled()
    expect(api.onMcpStatus).not.toHaveBeenCalled()
    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    visibility = 'hidden'
    fireEvent(document, new Event('visibilitychange'))
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    await advance(15_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    expect(api.onMcpStatus).toHaveBeenCalledTimes(2)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    act(() => { subscriptions[0].listener(snapshot()) })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const fresh = snapshot({ revision: 2, servers: [{ name: 'visible-update', state: 'connected', exposure: 'deferred', toolCount: 2 }] })
    push(fresh)
    await act(async () => { pending.resolve(snapshot()); await pending.promise })
    expect(screen.getByText('visible-update')).toBeInTheDocument()
    expect(screen.queryByText('a-server')).not.toBeInTheDocument()
    api.getMcpStatus.mockResolvedValue(fresh)
    await advance(3_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(3)
  })

  it('keeps one in-flight read per visible page after timeout, without retry queues', async () => {
    const { api } = fakeApi()
    const pending = deferred<McpStatusSnapshot>()
    api.getMcpStatus.mockReturnValueOnce(pending.promise)
    render(<McpStatusPage target={targetA} />)
    await advance(2_000)
    expect(screen.getByRole('status')).toHaveTextContent('读取状态超时')
    expect(screen.getByRole('status')).toHaveTextContent('原读取可能仍未结束')
    await advance(30_000)
    refresh()
    expect(api.getMcpStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('读取状态超时')
    await act(async () => { pending.resolve(snapshot()); await pending.promise })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await advance(3_000)
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText('a-server')).toBeInTheDocument()
  })

})
