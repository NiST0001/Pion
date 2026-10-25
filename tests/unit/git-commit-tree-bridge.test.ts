import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import type { PionApi } from '../../src/shared/pion-api'

// Mock-only bridge checks: no Git process or Electron window is started.
afterEach(() => {
  vi.doUnmock('node:child_process')
  vi.doUnmock('electron')
  vi.resetModules()
})

it('passes pinned commit tips to stdin and keeps a failed input pending until Git settles', async () => {
  let finish!: (value: { stdout: string; stderr: string }) => void
  const completion = new Promise<{ stdout: string; stderr: string }>((resolve) => { finish = resolve })
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  const execute = vi.fn(() => Object.assign(completion, { child: { stdin } }))
  vi.doMock('node:child_process', () => ({
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execute })
  }))
  const { runGit } = await import('../../src/main/git')
  const tips = `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`
  const pending = runGit('/repo', ['--no-lazy-fetch', 'log', '--stdin'], { input: tips, trim: false, timeout: 30_000 })
  expect(stdin.end).toHaveBeenCalledExactlyOnceWith(tips)
  expect(execute).toHaveBeenCalledWith('git', ['-C', '/repo', '--no-lazy-fetch', 'log', '--stdin'], expect.objectContaining({ timeout: 30_000 }))
  const failure = new Error('stdin failed')
  stdin.emit('error', failure)
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish({ stdout: 'unused output', stderr: '' })
  await expect(pending).rejects.toBe(failure)
})

it('preload forwards cwd and the exact optional commit graph cursor', async () => {
  let api!: PionApi
  const page = { root: '/repo', revision: 'revision' }
  const invoke = vi.fn(async () => page)
  const expose = vi.fn((_name: string, value: PionApi) => { api = value })
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: expose },
    ipcRenderer: { invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }
  }))
  await import('../../src/preload/index')
  expect(invoke).not.toHaveBeenCalled()
  const cursor = { revision: 'a'.repeat(64), offset: 200 }
  await expect(api.getGitCommitTree('/repo', cursor)).resolves.toBe(page)
  expect(invoke).toHaveBeenLastCalledWith(IPC.GitCommitTree, '/repo', cursor)
  await api.getGitCommitTree('/repo')
  expect(invoke).toHaveBeenLastCalledWith(IPC.GitCommitTree, '/repo', undefined)
})
