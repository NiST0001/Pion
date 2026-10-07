import { afterEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'
import { AgentBridge } from '../../src/main/agent/agent-bridge'

const info = (cwd: string, id: string): SessionInfo => ({
  cwd, id, path: resolve(`/tmp/${id}.jsonl`), created: new Date(0), modified: new Date(1),
  messageCount: 1, firstMessage: id, allMessagesText: id
})
afterEach(() => vi.restoreAllMocks())

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
