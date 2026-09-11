import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import { IPC_EVENTS } from '../../src/shared/ipc'

it('publishes a new session once it is listed, including when another project is active', async () => {
  const path = resolve('/tmp/new-session.jsonl')
  const cwd = resolve('/tmp/background-project')
  const session = { path, projectCwd: cwd, id: 'new' }
  const send = vi.fn()
  const listSessions = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([session])
  const backendPool = new Map<string, BackendRecord>()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    activeKey: 'other-session', backendPool, historyRevision: 0,
    sessionManagers: new Map(), sessionManagerSignatures: new Map(), backendKeysBySessionPath: new Map(),
    updateRunSession: vi.fn(), pushRunningSessionPaths: vi.fn(), restoreQueuedRuns: vi.fn(),
    listSessions, win: { webContents: { send } }
  }) as { syncBackendSession: (backend: BackendRecord) => Promise<void> }
  const backend = { key: 'new', cwd, client: { getState: vi.fn().mockResolvedValue({ sessionFile: path, sessionId: 'new' }) } } as unknown as BackendRecord
  backendPool.set(backend.key, backend)
  await bridge.syncBackendSession(backend)
  expect(send).not.toHaveBeenCalled()
  expect(backend.sidebarPublishedSessionPath).toBeUndefined()
  await bridge.syncBackendSession(backend)
  expect(listSessions).toHaveBeenLastCalledWith(cwd)
  expect(send).toHaveBeenCalledWith(IPC_EVENTS.AgentSessions, [session])
  await bridge.syncBackendSession(backend)
  expect(send).toHaveBeenCalledTimes(1)
  expect(listSessions).toHaveBeenCalledTimes(2)
})
