import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'
import { AgentBridge } from '../../src/main/agent/agent-bridge'

const info = (cwd: string, id: string): SessionInfo => ({
  cwd, id, path: resolve(`/tmp/${id}.jsonl`), created: new Date(0), modified: new Date(1),
  messageCount: 1, firstMessage: id, allMessagesText: id
})
afterEach(() => vi.restoreAllMocks())

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

it('filters a colliding SDK bucket by persisted cwd instead of relabeling every session', async () => {
  const root = resolve('/tmp/repository-feature')
  const other = resolve('/tmp/repository/feature')
  const list = vi.spyOn(SessionManager, 'list').mockResolvedValue([
    info(root, 'own'), info(other, 'foreign'), info('', 'unknown')
  ])
  const bridge = Object.create(AgentBridge.prototype) as AgentBridge
  expect((await bridge.listSessions(root)).map((session) => [session.id, session.projectCwd])).toEqual([['own', root]])
  expect((await bridge.listSessions(other)).map((session) => [session.id, session.projectCwd])).toEqual([['foreign', other]])
  expect(list).toHaveBeenCalledWith(root)
  expect(list).toHaveBeenCalledWith(other)
})

it('keeps primary and linked worktree queries separate without moving their session files', async () => {
  const root = resolve('/tmp/project')
  const worktree = resolve('/tmp/elsewhere/feature')
  vi.spyOn(SessionManager, 'list').mockImplementation(async (cwd) => [info(cwd, cwd === root ? 'root' : 'feature')])
  const bridge = Object.create(AgentBridge.prototype) as AgentBridge
  const main = await bridge.listSessions(root)
  const branch = await bridge.listSessions(worktree)
  expect(main[0]).toMatchObject({ projectCwd: root, id: 'root', path: resolve('/tmp/root.jsonl') })
  expect(branch[0]).toMatchObject({ projectCwd: worktree, id: 'feature', path: resolve('/tmp/feature.jsonl') })
  expect(main[0].path).not.toBe(branch[0].path)
})

it('shares a repeated SDK discovery without caching full transcript text or caller mutations', async () => {
  const pending = deferred<SessionInfo[]>()
  const list = vi.spyOn(SessionManager, 'list').mockReturnValue(pending.promise)
  const bridge = Object.create(AgentBridge.prototype) as AgentBridge
  const first = bridge.listSessions('/tmp/project')
  const second = bridge.listSessions('/tmp/project')
  expect(list).toHaveBeenCalledTimes(1)
  pending.resolve([info('/tmp/project', 'own')])
  const [a, b] = await Promise.all([first, second])
  expect(a[0]).not.toHaveProperty('allMessagesText')
  a[0].name = 'caller mutation'
  expect(b[0].name).toBeUndefined()
  expect((await bridge.listSessions('/tmp/project'))[0].name).toBeUndefined()
})

it('retries first-session publication after persistence invalidates an earlier empty scan', async () => {
  const cwd = '/tmp/background'
  const session = info(cwd, 'first')
  const list = vi.spyOn(SessionManager, 'list').mockResolvedValueOnce([]).mockResolvedValueOnce([session])
  const send = vi.fn()
  const backend = {
    key: 'background', cwd, sessionPath: session.path,
    client: { getState: vi.fn(async () => ({ sessionFile: session.path, sessionId: session.id })) }
  }
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    historyRevision: 0, backendPool: new Map([[backend.key, backend]]),
    status: { cwd: '/tmp/selected' }, activeKey: 'selected',
    win: { webContents: { send } }, sessionManagers: new Map([[session.path, { cached: true }]]),
    sessionManagerSignatures: new Map([[session.path, 'known-file-signature']]),
    backendKeysBySessionPath: new Map(), updateRunSession: vi.fn(),
    pushRunningSessionPaths: vi.fn(), restoreQueuedRuns: vi.fn()
  })
  await bridge.syncBackendSession(backend)
  expect(bridge.sessionManagers.get(session.path)).toEqual({ cached: true })
  expect(bridge.sessionManagerSignatures.get(session.path)).toBe('known-file-signature')
  expect(send).not.toHaveBeenCalled()
  expect(backend).not.toHaveProperty('sidebarPublishedSessionPath')
  // The event regression in agent-bridge-send-queue covers this completion invalidation.
  bridge.sessionListCache.invalidate(cwd)
  await bridge.syncBackendSession(backend)
  expect(list).toHaveBeenCalledTimes(2)
  expect(backend).toHaveProperty('sidebarPublishedSessionPath', session.path)
  expect(send.mock.calls[0][1][0]).toMatchObject({ projectCwd: cwd, id: 'first' })
  expect(bridge.status.cwd).toBe('/tmp/selected')
})

it('reuses a parsed cold-session manager until the persisted file signature changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-cold-snapshot-'))
  try {
    const path = join(root, 'session.jsonl')
    await writeFile(path, 'first')
    const manager = (count: number) => ({
      buildSessionContext: () => ({ messages: Array.from({ length: count }, () => ({ role: 'user' })), thinkingLevel: 'off' }),
      getSessionFile: () => path, getSessionId: () => 'persisted', getSessionName: () => undefined
    })
    const open = vi.spyOn(SessionManager, 'open')
      .mockReturnValueOnce(manager(1) as unknown as SessionManager)
      .mockReturnValueOnce(manager(2) as unknown as SessionManager)
    const bridge = Object.assign(Object.create(AgentBridge.prototype), {
      activeKey: null, activeSessionPath: path, historyRevision: 0, sessionSelectionGeneration: 0,
      backendPool: new Map(), yoloSessions: new Set(), sessionManagers: new Map(), sessionManagerSignatures: new Map()
    })
    expect(await bridge.getSessionInfo()).toMatchObject({ messageCount: 1 })
    expect(await bridge.getSessionInfo()).toMatchObject({ messageCount: 1 })
    expect(open).toHaveBeenCalledTimes(1)
    await writeFile(path, 'changed file length')
    expect(await bridge.getSessionInfo()).toMatchObject({ messageCount: 2 })
    expect(open).toHaveBeenCalledTimes(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('never publishes a delayed sidebar result over a newly selected project', async () => {
  const pending = deferred<SessionInfo[]>()
  vi.spyOn(SessionManager, 'list').mockReturnValue(pending.promise)
  const send = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    status: { cwd: '/tmp/old' }, win: { webContents: { send } }
  })
  const refreshing = bridge.refreshSidebarSessions(false)
  bridge.status.cwd = '/tmp/new'
  pending.resolve([info('/tmp/old', 'old')])
  await refreshing
  expect(send).not.toHaveBeenCalled()
})

it('retains displayed rows on discovery rejection instead of publishing a false empty list', async () => {
  vi.spyOn(SessionManager, 'list').mockRejectedValue(new Error('discovery failed'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const send = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    status: { cwd: '/tmp/project' }, win: { webContents: { send } }
  })
  await bridge.refreshSidebarSessions(false)
  expect(send).not.toHaveBeenCalled()
  await expect(bridge.listSessions('/tmp/project')).rejects.toThrow('discovery failed')
})
