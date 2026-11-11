import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentBridge as Bridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'

let AgentBridge: typeof import('../../src/main/agent/agent-bridge').AgentBridge
let RpcClient: typeof import('@earendil-works/pi-coding-agent').RpcClient
let processExit: typeof import('../../src/main/process-exit')
let BackendPool: typeof import('../../src/main/agent/backend-pool').BackendPool
const children: CapturedProcess[] = []

class CapturedProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdio = [{ closed: false }, { closed: false }, { closed: false }]

  finish(): void {
    this.exitCode = 0
    this.emit('exit', 0, null)
    this.stdio.forEach(stream => { stream.closed = true })
    this.emit('close', 0, null)
  }
}

function fixture() {
  const cwd = resolve('mock-project'), path = resolve('mock-sessions', 'session.jsonl')
  const backendPool = new BackendPool()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    backendPool, backendKeysBySessionPath: new Map(), stopping: false,
    toolPermissionStore: { filePath: resolve('mock-user-data', 'permissions.json') },
    backendArgs: vi.fn(async () => []), clearBackendToolPermissionRequests: vi.fn(), clearBackendExtensionUiRequests: vi.fn(),
    pushSessionInfo: vi.fn(), refreshSidebarSessions: vi.fn(), pushRunningSessionPaths: vi.fn()
  }) as Bridge
  const internals = bridge as unknown as {
    createBackend(key: string, cwd: string, path: string): Promise<BackendRecord>
    processStopClient(backend: BackendRecord): InstanceType<typeof RpcClient>
    stopHistoryWriter(backend: BackendRecord): Promise<void>
    startupQuarantinedCwds?: Set<string>
  }
  const child = new CapturedProcess()
  children.push(child)
  const state = { sessionId: 'actual-sdk-session', sessionFile: path, isStreaming: false, isCompacting: false,
    messageCount: 0, pendingMessageCount: 0, thinkingLevel: 'off', steeringMode: 'all', followUpMode: 'all', autoCompactionEnabled: true }
  vi.spyOn(RpcClient.prototype, 'getState').mockResolvedValue(state as Awaited<ReturnType<InstanceType<typeof RpcClient>['getState']>>)
  const stop = vi.spyOn(RpcClient.prototype, 'stop').mockImplementation(async function (this: InstanceType<typeof RpcClient>) {
    child.finish()
    ;(this as unknown as { process: CapturedProcess | null }).process = null
  })
  return { bridge, internals, backendPool, child, cwd, path, stop }
}

describe('AgentBridge actual SDK start wiring (synthetic processes only)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({ app: { getPath: () => resolve('mock-user-data') }, BrowserWindow: {} }))
    ;({ AgentBridge } = await import('../../src/main/agent/agent-bridge'))
    ;({ RpcClient } = await import('@earendil-works/pi-coding-agent'))
    ;({ BackendPool } = await import('../../src/main/agent/backend-pool'))
    processExit = await import('../../src/main/process-exit')
  })
  afterEach(() => { children.splice(0).forEach(child => child.finish()); vi.restoreAllMocks() })
  afterAll(() => { vi.doUnmock('electron'); vi.resetModules() })

  it('prepares the same stable captured-child adapter immediately before the real SDK start call', async () => {
    const h = fixture()
    const prepare = vi.spyOn(processExit, 'prepareProcessStart')
    vi.spyOn(RpcClient.prototype, 'start').mockImplementation(function (this: InstanceType<typeof RpcClient>) {
      const backend = [...h.backendPool.values()][0]
      expect(prepare).toHaveBeenCalledExactlyOnceWith(h.internals.processStopClient(backend))
      ;(this as unknown as { process: CapturedProcess }).process = h.child
      return Promise.resolve()
    })
    const backend = await h.internals.createBackend('actual', h.cwd, h.path)
    const adapter = h.internals.processStopClient(backend)
    await h.internals.stopHistoryWriter(backend)
    expect(h.internals.processStopClient(backend)).toBe(adapter)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(backend.historyStopFailed).toBe(false)
    // A later start reuses that adapter identity and retires the old success.
    processExit.prepareProcessStart(adapter)
    await expect(processExit.stopWithProcessExitBarrier(adapter, true)).rejects.toMatchObject({ closeUnknown: true })
    expect(h.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['start', 'initial-state'])('closes the captured child once after %s fails, without retaining a false cwd quarantine', async (stage) => {
    const h = fixture()
    const prepare = vi.spyOn(processExit, 'prepareProcessStart')
    vi.spyOn(RpcClient.prototype, 'start').mockImplementation(function (this: InstanceType<typeof RpcClient>) {
      ;(this as unknown as { process: CapturedProcess }).process = h.child
      if (stage === 'start') throw new Error('synthetic startup failure')
      return Promise.resolve()
    })
    if (stage === 'initial-state') vi.mocked(RpcClient.prototype.getState).mockRejectedValueOnce(new Error('synthetic initial-state failure'))
    await expect(h.internals.createBackend('actual', h.cwd, h.path)).rejects.toThrow('synthetic')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.child.exitCode).toBe(0)
    expect(h.child.stdio.every(stream => stream.closed)).toBe(true)
    expect(h.backendPool.size).toBe(0)
    expect(h.internals.startupQuarantinedCwds?.has(h.cwd)).not.toBe(true)
  })
})
