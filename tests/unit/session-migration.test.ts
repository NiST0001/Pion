import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { RunStore } from '../../src/main/run-store'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sessionDirFor(cwd: string): string {
  const safePath = `--${cwd.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`
  return join(getAgentDir(), 'sessions', safePath)
}

describe('AgentBridge session project migration', () => {
  it('moves the session file into the target project bucket and rewrites the header cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pion-migrate-'))
    roots.push(root)
    const sourceCwd = join(root, 'project-a')
    const targetCwd = join(root, 'project-b')
    const sourceDir = sessionDirFor(sourceCwd)
    await mkdir(sourceDir, { recursive: true })
    const sessionFile = join(sourceDir, 'session-1.jsonl')
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 's-1', timestamp: '2026-01-01T00:00:00Z', cwd: sourceCwd }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    ].join('\n') + '\n', 'utf8')

    const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')))
    const internals = bridge as unknown as {
      activeCwd: string
      activeSessionPath?: string
      sessionManagers: Map<string, unknown>
    }
    internals.activeCwd = sourceCwd
    internals.activeSessionPath = sessionFile

    const moved = await bridge.migrateSessionToProject(targetCwd)
    expect(moved).toBe(join(sessionDirFor(targetCwd), 'session-1.jsonl'))

    const content = await readFile(moved as string, 'utf8')
    const header = JSON.parse(content.split('\n')[0])
    expect(header.cwd).toBe(targetCwd)
    // 原文件已移走
    await expect(readFile(sessionFile, 'utf8')).rejects.toThrow()
    expect(internals.activeCwd).toBe(targetCwd)
    expect(internals.activeSessionPath).toBe(moved)
  })
})
