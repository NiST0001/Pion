import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import { RunStore } from '../../src/main/run-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentBridge send and local queue', () => {
  it('sends Enter messages directly while preserving existing follow-ups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-send-queue-'))
    roots.push(root)
    const runStore = new RunStore(join(root, 'runs.json'))
    const state = {
      sessionId: 'session-1',
      isStreaming: false,
      isCompacting: false,
      messageCount: 1,
      pendingMessageCount: 1
    }
    const queued = { runId: 'queued-run', text: '稍后处理', images: [] }
    const backend = {
      key: 'backend-1',
      cwd: root,
      phase: 'running',
      busy: false,
      compacting: false,
      modePrimed: 'build',
      pendingRunIds: ['queued-run'],
      localFollowUps: [queued],
      client: {
        getState: vi.fn(async () => state),
        prompt: vi.fn(async () => undefined),
        steer: vi.fn(async () => undefined)
      },
      startPromise: Promise.resolve()
    } as unknown as BackendRecord
    const bridge = Object.assign(Object.create(AgentBridge.prototype), {
      activeKey: backend.key,
      activeCwd: backend.cwd,
      runStore,
      desiredModes: new Map([[backend.key, 'build']]),
      ensureActiveBackend: vi.fn(async () => backend),
      syncBackendSession: vi.fn(async () => undefined),
      pushSessionInfo: vi.fn(async () => undefined),
      refreshSidebarSessions: vi.fn(async () => undefined),
      pushRunCheckpoint: vi.fn()
    }) as AgentBridge

    await bridge.send('立即发送')

    expect(backend.client.prompt).toHaveBeenCalledWith('立即发送', [])
    expect(backend.client.prompt).toHaveBeenCalledTimes(1)
    expect(backend.client.steer).not.toHaveBeenCalled()
    expect(backend.localFollowUps).toEqual([queued])
    await runStore.flush()
  })
})
