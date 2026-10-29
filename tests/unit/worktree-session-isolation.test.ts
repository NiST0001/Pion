import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { SessionDiscovery, sessionDiscoveryDirectory } from '../../src/main/agent/session-discovery'
import { SessionTokenCache } from '../../src/main/agent/session-token-cache'
import { IPC_EVENTS } from '../../src/shared/ipc'
import type { SessionMeta } from '../../src/shared/types'

const info = (cwd: string, id: string): SessionMeta => ({
  projectCwd: resolve(cwd), id, path: resolve(`/tmp/${id}.jsonl`), timestamp: new Date(0).toISOString(), mtime: 1,
  messageCount: 1, preview: id
})
const roots: string[] = []
// Token work has its own boundary; identity tests below retain real discovery.
beforeEach(() => { vi.spyOn(SessionTokenCache.prototype, 'read').mockResolvedValue(undefined) })
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storage() {
  const root = await mkdtemp(join(tmpdir(), 'pion-bridge-discovery-'))
  roots.push(root)
  return root
}

async function persisted(agentDir: string, cwd: string, id: string) {
  const directory = sessionDiscoveryDirectory(cwd, agentDir)
  const path = join(directory, `unrelated-filename-${id}.jsonl`)
  await mkdir(directory, { recursive: true })
  await writeFile(path, [
    { type: 'session', version: 3, cwd, id, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: 'entry-1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: id, timestamp: Date.parse('2026-01-01T00:00:01.000Z') } }
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return path
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

it('filters a real colliding SDK bucket by persisted header cwd without SDK factories or filename identity', async () => {
  const agentDir = await storage()
  const root = join(agentDir, 'repository-feature')
  const other = join(agentDir, 'repository', 'feature')
  expect(sessionDiscoveryDirectory(root, agentDir)).toBe(sessionDiscoveryDirectory(other, agentDir))
  const own = await persisted(agentDir, root, 'own')
  const foreign = await persisted(agentDir, other, 'foreign')
  const list = vi.spyOn(SessionManager, 'list')
  const open = vi.spyOn(SessionManager, 'open')
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { sessionDiscovery: new SessionDiscovery(() => agentDir) })
  expect((await bridge.listSessions(root)).map((session: SessionMeta) => [session.id, session.projectCwd, session.path])).toEqual([['own', root, own]])
  expect((await bridge.listSessions(other)).map((session: SessionMeta) => [session.id, session.projectCwd, session.path])).toEqual([['foreign', other, foreign]])
  expect(list).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('keeps primary and linked worktree queries separate without moving their session files', async () => {
  const agentDir = await storage()
  const root = join(agentDir, 'project')
  const worktree = join(agentDir, 'elsewhere', 'feature')
  const mainPath = await persisted(agentDir, root, 'root')
  const branchPath = await persisted(agentDir, worktree, 'feature')
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { sessionDiscovery: new SessionDiscovery(() => agentDir) })
  const main = await bridge.listSessions(root)
  const branch = await bridge.listSessions(worktree)
  expect(main[0]).toMatchObject({ projectCwd: root, id: 'root', path: mainPath })
  expect(branch[0]).toMatchObject({ projectCwd: worktree, id: 'feature', path: branchPath })
  expect(main[0].path).not.toBe(branch[0].path)
})

it('shares repeated discovery without caching caller mutations', async () => {
  const pending = deferred<SessionMeta[]>()
  const list = vi.spyOn(SessionDiscovery.prototype, 'list').mockReturnValue(pending.promise)
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
  const cwd = resolve('/tmp/background')
  const session = info(cwd, 'first')
  const list = vi.spyOn(SessionDiscovery.prototype, 'list').mockResolvedValueOnce([]).mockResolvedValueOnce([session])
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
  const pending = deferred<SessionMeta[]>()
  vi.spyOn(SessionDiscovery.prototype, 'list').mockReturnValue(pending.promise)
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
  vi.spyOn(SessionDiscovery.prototype, 'list').mockRejectedValue(new Error('discovery failed'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const send = vi.fn()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    status: { cwd: '/tmp/project' }, win: { webContents: { send } }
  })
  await bridge.refreshSidebarSessions(false)
  expect(send).not.toHaveBeenCalled()
  await expect(bridge.listSessions('/tmp/project')).rejects.toThrow('discovery failed')
})

async function flushTotals() {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

function sidebarWindow() {
  return { isDestroyed: vi.fn(() => false), webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() } }
}

it('returns exact-cwd rows before token totals settle, then publishes the scoped supplement without loading a backend', async () => {
  const firstCwd = resolve('/tmp/first-project')
  const secondCwd = resolve('/tmp/second-project')
  const tokens = deferred<number | undefined>()
  const list = vi.spyOn(SessionDiscovery.prototype, 'list').mockImplementation(async (cwd) => [info(cwd, cwd === firstCwd ? 'first' : 'second')])
  const read = vi.spyOn(SessionTokenCache.prototype, 'read').mockReturnValue(tokens.promise)
  const win = sidebarWindow()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    win, status: { cwd: firstCwd }, ensureActiveBackend: vi.fn()
  })
  const first = await bridge.listSessions(firstCwd)
  const second = await bridge.listSessions(secondCwd)
  expect(first).toEqual([expect.objectContaining({ id: 'first', projectCwd: firstCwd, sidebarRevision: 1 })])
  expect(second).toEqual([expect.objectContaining({ id: 'second', projectCwd: secondCwd, sidebarRevision: 2 })])
  expect(first[0]).not.toHaveProperty('totalTokens')
  expect(second[0]).not.toHaveProperty('allMessagesText')
  expect(win.webContents.send).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledWith(first[0].path, { id: 'first', cwd: firstCwd })
  expect(read).toHaveBeenCalledWith(second[0].path, { id: 'second', cwd: secondCwd })
  expect(read).toHaveBeenCalledTimes(2)
  tokens.resolve(23)
  await flushTotals()
  expect(win.webContents.send.mock.calls).toEqual([
    [IPC_EVENTS.AgentSessions, [{ ...first[0], totalTokens: 23 }]],
    [IPC_EVENTS.AgentSessions, [{ ...second[0], totalTokens: 23 }]]
  ])
  expect((await bridge.listSessions(secondCwd))[0]).toEqual({ ...second[0], totalTokens: 23 })
  expect(list).toHaveBeenCalledTimes(2)
  expect(bridge.ensureActiveBackend).not.toHaveBeenCalled()
  expect(bridge.status.cwd).toBe(firstCwd)
})

it('does not publish an old token result after a hard mutation starts a newer discovery', async () => {
  const cwd = resolve('/tmp/project')
  const oldTokens = deferred<number | undefined>()
  const newTokens = deferred<number | undefined>()
  vi.spyOn(SessionDiscovery.prototype, 'list').mockResolvedValueOnce([info(cwd, 'deleted')]).mockResolvedValueOnce([info(cwd, 'fresh')])
  const read = vi.spyOn(SessionTokenCache.prototype, 'read').mockReturnValueOnce(oldTokens.promise).mockReturnValueOnce(newTokens.promise)
  const win = sidebarWindow()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { win })
  const first = await bridge.listSessions(cwd)
  bridge.sessionListCache.invalidate(cwd)
  const latest = await bridge.listSessions(cwd)
  expect(latest[0].sidebarRevision).toBeGreaterThan(first[0].sidebarRevision)
  expect(read).toHaveBeenCalledTimes(1)
  oldTokens.resolve(999)
  await flushTotals()
  expect(win.webContents.send).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledTimes(2)
  newTokens.resolve(7)
  await flushTotals()
  expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_EVENTS.AgentSessions, [{ ...latest[0], totalTokens: 7 }])
})

it('retires a token publisher after unbind even if the same window object returns', async () => {
  const cwd = resolve('/tmp/project')
  const tokens = deferred<number | undefined>()
  vi.spyOn(SessionDiscovery.prototype, 'list').mockResolvedValue([info(cwd, 'own')])
  vi.spyOn(SessionTokenCache.prototype, 'read').mockReturnValue(tokens.promise)
  const win = sidebarWindow()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { win })
  await bridge.listSessions(cwd)
  bridge.unbind(win)
  bridge.win = win // A -> detached -> A must not revive the old receipt.
  tokens.resolve(12)
  await flushTotals()
  expect(win.webContents.send).not.toHaveBeenCalled()
  expect((await bridge.listSessions(cwd))[0].totalTokens).toBe(12)
})

it.each([false, true])('publishes to a replacement window only after it reads that cwd (read=%s)', async (readAgain) => {
  const cwd = resolve('/tmp/project')
  const tokens = deferred<number | undefined>()
  const list = vi.spyOn(SessionDiscovery.prototype, 'list').mockResolvedValue([info(cwd, 'own')])
  vi.spyOn(SessionTokenCache.prototype, 'read').mockReturnValue(tokens.promise)
  const firstWin = sidebarWindow()
  const nextWin = sidebarWindow()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { win: firstWin })
  const sessions = await bridge.listSessions(cwd)
  bridge.win = nextWin
  if (readAgain) await bridge.listSessions(cwd)
  tokens.resolve(12)
  await flushTotals()
  expect(firstWin.webContents.send).not.toHaveBeenCalled()
  if (readAgain) expect(nextWin.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_EVENTS.AgentSessions, [{ ...sessions[0], totalTokens: 12 }])
  else expect(nextWin.webContents.send).not.toHaveBeenCalled()
  expect(list).toHaveBeenCalledTimes(1)
})

it.each(['window', 'webContents'] as const)('does not push a completed supplement to destroyed %s', async (destroyed) => {
  const tokens = deferred<number | undefined>()
  vi.spyOn(SessionDiscovery.prototype, 'list').mockResolvedValue([info('/tmp/project', 'own')])
  vi.spyOn(SessionTokenCache.prototype, 'read').mockReturnValue(tokens.promise)
  const win = sidebarWindow()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { win })
  await bridge.listSessions('/tmp/project')
  if (destroyed === 'window') win.isDestroyed.mockReturnValue(true)
  else win.webContents.isDestroyed.mockReturnValue(true)
  tokens.resolve(12)
  await flushTotals()
  expect(win.webContents.send).not.toHaveBeenCalled()
})

it('does not send an ambiguous empty supplement or read tokens from another persisted cwd', async () => {
  const agentDir = await storage()
  const cwd = join(agentDir, 'project-feature')
  const foreign = join(agentDir, 'project', 'feature')
  await persisted(agentDir, foreign, 'foreign')
  const read = vi.spyOn(SessionTokenCache.prototype, 'read').mockResolvedValue(5)
  const win = sidebarWindow()
  const bridge = Object.assign(Object.create(AgentBridge.prototype), { win, sessionDiscovery: new SessionDiscovery(() => agentDir) })
  expect(await bridge.listSessions(cwd)).toEqual([])
  await flushTotals()
  expect(read).not.toHaveBeenCalled()
  expect(win.webContents.send).not.toHaveBeenCalled()
})
