import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { BackendPool } from '../../src/main/agent/backend-pool'
import type { BackendRecord } from '../../src/main/agent/types'

const sdk = vi.hoisted(() => ({ start: vi.fn(), state: vi.fn(), stop: vi.fn() }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => {
  const actual = await original<typeof import('@earendil-works/pi-coding-agent')>()
  return { ...actual, RpcClient: class extends actual.RpcClient {
    override start() { return sdk.start(this) }
    override getState() { return sdk.state(this) }
    override stop() { return sdk.stop(this) }
  } }
})
vi.mock('../../src/main/pi-runtime', () => ({ pionRuntimePath: () => '/fixture/agent-runtime.mjs' }))
vi.mock('../../src/main/subagent-settings', () => ({ subagentSettingsFilePath: () => '/fixture/subagents.json' }))
vi.mock('../../src/main/question-settings', () => ({ questionSettingsFilePath: () => '/fixture/questions.json' }))

class Child extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  stdio = [{ closed: false }, { closed: false }, { closed: false }]
  exit() { this.exitCode = 0; this.emit('exit', 0, null) }
  close() { this.stdio.forEach(stream => { stream.closed = true }); this.emit('close', this.exitCode, null) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function gap() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function harness() {
  sdk.start.mockReset()
  sdk.state.mockReset().mockRejectedValue(new Error('initial state failed'))
  sdk.stop.mockReset().mockResolvedValue(undefined)
  const pool = new BackendPool()
  const cwd = resolve('/fixture/project')
  const path = join(cwd, 'saved.jsonl')
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    backendPool: pool, backendKeysBySessionPath: new Map(), activeKey: 'writer', activeCwd: cwd, activeSessionPath: path,
    toolPermissionStore: { filePath: '/fixture/permissions.json' }, backendArgs: vi.fn(async () => []),
    attachBackendEvents: vi.fn(), setActiveBackendStatus: vi.fn(), setStatus: vi.fn(),
    pushRunningSessionPaths: vi.fn(), pushSessionInfo: vi.fn(), refreshSidebarSessions: vi.fn(),
    clearBackendToolPermissionRequests: vi.fn(), clearBackendExtensionUiRequests: vi.fn(),
    markSubagentBackendGone: vi.fn()
  })
  return { bridge, pool, cwd, path }
}
afterEach(() => { vi.useRealTimers() })

describe('backend initialization child ownership', () => {
  it('retains its writer and path until actual stop, exit and stdio close all settle', async () => {
    const h = harness()
    const child = new Child()
    const stop = deferred<void>()
    sdk.start.mockImplementation((client: { process: unknown }) => { client.process = child; return Promise.resolve() })
    sdk.stop.mockImplementation((client: { process: unknown }) => { client.process = null; return stop.promise })
    const rejected = h.bridge.createBackend('writer', h.cwd, h.path).catch((error: Error) => error)
    await gap()
    expect(sdk.stop).toHaveBeenCalledTimes(1)
    const backend = h.pool.get('writer')!
    expect(backend).toMatchObject({ phase: 'error', historyStopFailed: true })
    expect(backend.startupProcess).toBe(child)
    await expect(h.bridge.createBackend('other-key', h.cwd, h.path)).rejects.toThrow('writer')
    stop.resolve()
    child.exit()
    await gap()
    expect(h.pool.get('writer')).toBe(backend)
    expect(h.bridge.backendKeysBySessionPath.get(h.path)).toBe('writer')
    child.close()
    expect(await rejected).toMatchObject({ message: 'initial state failed' })
    expect(h.pool.get('writer')).toBeUndefined()
    expect(h.bridge.backendKeysBySessionPath.has(h.path)).toBe(false)
    expect(backend.startupProcess).toBeUndefined()
    expect(h.bridge.markSubagentBackendGone).toHaveBeenLastCalledWith(backend, true)
  })

  it.each(['state-read', 'path-mismatch'])('quarantines the child, cwd and real paths after %s and unknown stop, despite late exit/close', async (stage) => {
    vi.useFakeTimers()
    const h = harness()
    const actualPath = join(h.cwd, 'actual.jsonl')
    if (stage === 'path-mismatch') sdk.state.mockResolvedValueOnce({ sessionFile: actualPath })
    const child = new Child()
    sdk.start.mockImplementation((client: { process: unknown }) => { client.process = child; return Promise.resolve() })
    sdk.stop.mockImplementation(async (client: { process: unknown }) => { client.process = null })
    const rejected = h.bridge.createBackend('writer', h.cwd, h.path).catch((error: Error) => error)
    await gap()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await rejected).toMatchObject({ message: stage === 'state-read' ? 'initial state failed' : expect.stringContaining('路径') })
    const backend = h.pool.get('writer')!
    expect(backend.startupProcess).toBe(child)
    expect(h.bridge.backendKeysBySessionPath.get(h.path)).toBe('writer')
    expect(h.bridge.quarantinedSessionPaths.has(h.path)).toBe(true)
    if (stage === 'path-mismatch') {
      expect(backend.sessionPath).toBe(actualPath)
      expect(h.bridge.backendKeysBySessionPath.get(actualPath)).toBe('writer')
      expect(h.bridge.quarantinedSessionPaths.has(actualPath)).toBe(true)
    }
    expect(h.bridge.unconfirmedStoppedWorktreeCwds.has(h.cwd)).toBe(true)
    child.exit()
    child.close()
    await gap()
    expect(h.pool.get('writer')).toBe(backend)
    await expect(h.bridge.createBackend('new', h.cwd, join(h.cwd, 'different.jsonl'))).rejects.toThrow('writer')
    expect(sdk.start).toHaveBeenCalledTimes(1)
    expect(sdk.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['never-spawned', 'spawn-negative'])('releases a failed start only with a trusted %s receipt', async (kind) => {
    const h = harness()
    sdk.start.mockImplementation((client: { process: unknown }) => {
      if (kind === 'spawn-negative') {
        const child = new Child()
        // Node's ENOENT spawn-negative: no exit event, negative exitCode and closed pipes.
        child.exitCode = -2
        child.close()
        client.process = child
      }
      return Promise.reject(new Error('start failed'))
    })
    await expect(h.bridge.createBackend('writer', h.cwd, h.path)).rejects.toThrow('start failed')
    expect(h.pool.size).toBe(0)
    expect(h.bridge.backendKeysBySessionPath.size).toBe(0)
    expect(h.bridge.startupQuarantinedCwds).toBeUndefined()
    expect(h.bridge.quarantinedSessionPaths).toBeUndefined()
    expect(sdk.state).not.toHaveBeenCalled()
    expect(sdk.stop).toHaveBeenCalledTimes(1)
  })

  it('requires the pinned start implementation before trusting a rejected start with no child', async () => {
    const h = harness()
    h.bridge.attachBackendEvents.mockImplementationOnce((backend: BackendRecord) => {
      backend.client.start = vi.fn(async () => { throw new Error('custom start failed') })
    })
    await expect(h.bridge.createBackend('writer', h.cwd, h.path)).rejects.toThrow('custom start failed')
    expect(h.pool.get('writer')).toMatchObject({ historyStopFailed: true, startupProcess: null })
    expect(h.bridge.startupQuarantinedCwds.has(h.cwd)).toBe(true)
    expect(h.bridge.quarantinedSessionPaths.has(h.path)).toBe(true)
    expect(sdk.start).not.toHaveBeenCalled()
    expect(sdk.stop).not.toHaveBeenCalled()
  })

  it('keeps an incompatible or lost child handle isolated rather than treating null as a negative receipt', async () => {
    const h = harness()
    sdk.start.mockImplementation(async (client: { process: unknown }) => {
      // A successfully returned start with a null handle has no exit receipt.
      client.process = null
    })
    await expect(h.bridge.createBackend('writer', h.cwd, h.path)).rejects.toThrow('initial state failed')
    const backend = h.pool.get('writer') as BackendRecord
    expect(backend.historyStopFailed).toBe(true)
    expect(h.bridge.backendKeysBySessionPath.get(h.path)).toBe('writer')
    expect(h.bridge.startupQuarantinedCwds.has(h.cwd)).toBe(true)
    expect(sdk.stop).not.toHaveBeenCalled()
  })
})
