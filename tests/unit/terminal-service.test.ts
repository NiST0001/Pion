import { afterEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { TerminalService } from '../../src/main/terminal-service'
import { IPC_EVENTS } from '../../src/shared/ipc'

const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: mock.spawn }))
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function setup() {
  const processes: Array<{ data?: (data: string) => void; exit?: (event: { exitCode: number }) => void; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }> = []
  mock.spawn.mockImplementation(() => {
    const process = { write: vi.fn(), resize: vi.fn(), kill: vi.fn() } as typeof processes[number]
    processes.push(process)
    return { ...process,
      onData: (callback: (data: string) => void) => { process.data = callback; return { dispose: vi.fn() } },
      onExit: (callback: (event: { exitCode: number }) => void) => { process.exit = callback; return { dispose: vi.fn() } }
    }
  })
  const service = new TerminalService()
  const send = vi.fn()
  let destroyed = false
  const closed: Array<() => void> = []
  service.bind({ webContents: { id: 1, send, isDestroyed: () => destroyed }, once: (_event: string, callback: () => void) => closed.push(callback) } as unknown as BrowserWindow)
  service.bind({ webContents: { id: 2, send: vi.fn(), isDestroyed: () => false }, once: vi.fn() } as unknown as BrowserWindow)
  return { service, send, processes, closeWindow: () => { destroyed = true; closed.forEach((callback) => callback()) } }
}

it('blocks related live terminals and permanently retains disposed unconfirmed cwd', async () => {
  const { service, processes } = setup()
  const cwd = resolve('/project/worktree')
  const terminal = await service.open(1, cwd, 80, 24)
  expect(() => service.assertWorktreeDeletionIdle(cwd)).toThrow(/终端/)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project'))).toThrow(/终端/)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project/worktree/nested'))).toThrow(/终端/)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project/worktree-other'))).not.toThrow()
  service.close(1, terminal.id)
  expect(processes[0].kill).toHaveBeenCalledOnce()
  expect(() => service.assertWorktreeDeletionIdle(cwd)).toThrow(/未确认|尚未确认/)
  // A stale callback after listener disposal cannot erase the isolation latch.
  processes[0].exit?.({ exitCode: 0 })
  expect(() => service.assertWorktreeDeletionIdle(cwd)).toThrow()
})

it('allows terminals with an observed exit before disposal', async () => {
  const { service, processes } = setup()
  const cwd = resolve('/project')
  const terminal = await service.open(1, cwd, 80, 24)
  processes[0].exit?.({ exitCode: 0 })
  expect(() => service.assertWorktreeDeletionIdle(cwd)).not.toThrow()
  service.close(1, terminal.id)
  expect(() => service.assertWorktreeDeletionIdle(cwd)).not.toThrow()
})

it('reserves opens before realpath and rechecks the mutation guard before spawning', async () => {
  const { service } = setup()
  let finish!: (cwd: string) => void
  vi.mocked(realpath).mockImplementationOnce(() => new Promise<string>((done) => { finish = done }))
  let blocked = false
  service.setMutationGuard(() => { if (blocked) throw new Error('deletion active') })
  const opening = service.open(1, resolve('/project'), 80, 24)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/unrelated'))).toThrow(/打开/)
  blocked = true
  finish(resolve('/project'))
  await expect(opening).rejects.toThrow('deletion active')
  expect(mock.spawn).not.toHaveBeenCalled()
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project'))).not.toThrow()
  await expect(service.open(1, resolve('/project'), 80, 24)).rejects.toThrow('deletion active')
})

it('binds a shell to its opening project and reuses it without changing cwd', async () => {
  const { service, processes, closeWindow } = setup()
  const first = await service.open(1, resolve('/project-a'), 80, 24)
  const same = await service.open(1, resolve('/project-a'), 100, 30)
  const other = await service.open(1, resolve('/project-b'), 80, 24)
  expect(first.id).toBe(same.id)
  expect(other.id).not.toBe(first.id)
  expect(mock.spawn.mock.calls[0][2].cwd).toBe(resolve('/project-a'))
  expect(mock.spawn.mock.calls[1][2].cwd).toBe(resolve('/project-b'))
  service.write(1, first.id, 'pwd\r')
  expect(processes[0].write).toHaveBeenCalledWith('pwd\r')
  expect(() => service.write(2, first.id, 'bad')).toThrow(/不属于/)
  closeWindow()
  expect(processes.every((process) => process.kill.mock.calls.length === 1)).toBe(true)
})

it('deduplicates concurrent opens and replays output without unbounded history', async () => {
  vi.useFakeTimers()
  const { service, processes, send } = setup()
  const [first, second] = await Promise.all([
    service.open(1, resolve('/project-a'), 80, 24), service.open(1, resolve('/project-a'), 80, 24)
  ])
  expect(first.id).toBe(second.id)
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  processes[0].data?.('x'.repeat(300_000))
  vi.advanceTimersByTime(32)
  const snapshot = await service.open(1, resolve('/project-a'), 80, 24)
  expect(snapshot.output.length).toBeLessThanOrEqual(256 * 1024)
  expect(snapshot.sequence).toBe(1)
  expect(send).toHaveBeenCalledWith(IPC_EVENTS.TerminalData, expect.objectContaining({ id: first.id, sequence: 1, reset: true }))
  processes[0].exit?.({ exitCode: 0 })
  expect(() => service.write(1, first.id, 'pwd\r')).toThrow(/退出/)
  service.dispose()
})
