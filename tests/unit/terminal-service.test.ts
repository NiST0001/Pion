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
  const processes: Array<{ data?: (data: string) => void; exit?: (event: { exitCode: number }) => void; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; disposeData: ReturnType<typeof vi.fn>; disposeExit: ReturnType<typeof vi.fn> }> = []
  mock.spawn.mockImplementation(() => {
    const process = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      disposeData: vi.fn(() => { process.data = undefined }),
      disposeExit: vi.fn(() => { process.exit = undefined }) } as typeof processes[number]
    processes.push(process)
    return { ...process,
      onData: (callback: (data: string) => void) => { process.data = callback; return { dispose: process.disposeData } },
      onExit: (callback: (event: { exitCode: number }) => void) => { process.exit = callback; return { dispose: process.disposeExit } }
    }
  })
  const service = new TerminalService()
  const send = vi.fn()
  let destroyed = false
  const closed: Array<() => void> = []
  service.bind({ webContents: { id: 1, send, isDestroyed: () => destroyed }, once: (_event: string, callback: () => void) => closed.push(callback) } as unknown as BrowserWindow)
  service.bind({ webContents: { id: 2, send: vi.fn(), isDestroyed: () => false }, once: vi.fn() } as unknown as BrowserWindow)
  const bindOwner = (owner: number): void => service.bind({
    webContents: { id: owner, send: vi.fn(), isDestroyed: () => false }, once: vi.fn()
  } as unknown as BrowserWindow)
  return { service, send, processes, bindOwner, closeWindow: () => { destroyed = true; closed.forEach((callback) => callback()) } }
}

it('retains a closing PTY and its exit listener until actual exit releases its cwd', async () => {
  const { service, processes, send } = setup()
  const cwd = resolve('/project/worktree')
  const terminal = await service.open(1, cwd, 80, 24)
  expect(() => service.assertWorktreeDeletionIdle(cwd)).toThrow(/终端/)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project'))).toThrow(/终端/)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project/worktree/nested'))).toThrow(/终端/)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project/worktree-other'))).not.toThrow()
  const lateData = processes[0].data!
  service.close(1, terminal.id)
  expect(processes[0].kill).toHaveBeenCalledOnce()
  expect(processes[0].disposeData).toHaveBeenCalledOnce()
  expect(processes[0].disposeExit).not.toHaveBeenCalled()
  expect(() => service.write(1, terminal.id, 'pwd\r')).toThrow(/不存在/)
  expect(() => service.assertWorktreeDeletionIdle(cwd)).toThrow(/未确认|尚未确认/)
  lateData('late output')
  processes[0].exit?.({ exitCode: 0 })
  expect(processes[0].disposeExit).toHaveBeenCalledOnce()
  expect(() => service.assertWorktreeDeletionIdle(cwd)).not.toThrow()
  expect(send).not.toHaveBeenCalled()
})

it('releases only the actual closing PTY, including shared cwd and owner destruction', async () => {
  const { service, processes, closeWindow } = setup()
  const cwd = resolve('/project/worktree')
  const otherCwd = resolve('/other')
  await service.open(1, cwd, 80, 24)
  const sameCwd = await service.open(2, cwd, 80, 24)
  const other = await service.open(2, otherCwd, 80, 24)
  closeWindow()
  service.close(2, sameCwd.id)
  processes[2].kill.mockImplementation(() => { throw new Error('exit unknown') })
  service.close(2, other.id)
  processes[0].exit?.({ exitCode: 0 })
  expect(() => service.assertWorktreeDeletionIdle(cwd)).toThrow(/尚未确认/)
  processes[1].exit?.({ exitCode: 0 })
  expect(() => service.assertWorktreeDeletionIdle(cwd)).not.toThrow()
  expect(() => service.assertWorktreeDeletionIdle(otherCwd)).toThrow(/尚未确认/)
})

it('joins owner opens and earlier closing PTYs while leaving future windows usable', async () => {
  const { service, processes, bindOwner } = setup()
  const first = await service.open(1, resolve('/project-first'), 80, 24)
  await service.open(1, resolve('/project-second'), 80, 24)
  service.close(1, first.id)
  let finishPath!: (cwd: string) => void
  vi.mocked(realpath).mockImplementationOnce(() => new Promise<string>((done) => { finishPath = done }))
  const opening = service.open(1, resolve('/opening'), 80, 24)
  const openRejected = expect(opening).rejects.toThrow(/窗口已关闭/)
  const disposal = service.disposeOwner(1)
  expect(service.disposeOwner(1)).toBe(disposal)
  let finished = false
  void disposal.then(() => { finished = true })
  expect(processes[0].kill).toHaveBeenCalledOnce()
  expect(processes[1].kill).toHaveBeenCalledOnce()
  await expect(service.open(1, resolve('/new'), 80, 24)).rejects.toThrow(/窗口已关闭/)
  await service.open(2, resolve('/other-window'), 80, 24)
  processes[0].exit?.({ exitCode: 0 })
  processes[1].exit?.({ exitCode: 0 })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project-first'))).toThrow(/打开/)
  finishPath(resolve('/opening'))
  await openRejected
  await disposal
  expect(finished).toBe(true)
  expect(() => service.assertWorktreeDeletionIdle(resolve('/project-first'))).not.toThrow()
  expect(mock.spawn).toHaveBeenCalledTimes(3)
  bindOwner(3)
  await expect(service.open(3, resolve('/reopened-window'), 80, 24)).resolves.toMatchObject({ cwd: resolve('/reopened-window') })
})

it('shuts down permanently and joins prior owner disposal and manually closing PTYs', async () => {
  const { service, processes, bindOwner, closeWindow } = setup()
  const firstCwd = resolve('/first-owner')
  const secondCwd = resolve('/second-owner')
  await service.open(1, firstCwd, 80, 24)
  const second = await service.open(2, secondCwd, 80, 24)
  processes[0].kill.mockImplementation(() => { throw new Error('kill result unknown') })
  closeWindow()
  service.close(2, second.id)
  const shutdown = service.shutdown()
  expect(service.shutdown()).toBe(shutdown)
  let finished = false
  void shutdown.then(() => { finished = true })
  await expect(service.open(2, resolve('/late'), 80, 24)).rejects.toThrow(/服务已关闭/)
  expect(() => bindOwner(3)).toThrow(/服务已关闭/)
  expect(() => service.assertWorktreeDeletionIdle(firstCwd)).toThrow(/尚未确认/)
  processes[1].exit?.({ exitCode: 0 })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(() => service.assertWorktreeDeletionIdle(secondCwd)).not.toThrow()
  expect(() => service.assertWorktreeDeletionIdle(firstCwd)).toThrow(/尚未确认/)
  processes[0].exit?.({ exitCode: 0 })
  await shutdown
  expect(finished).toBe(true)
  expect(processes[0].kill).toHaveBeenCalledOnce()
  expect(processes[1].kill).toHaveBeenCalledOnce()
  expect(() => service.assertWorktreeDeletionIdle(firstCwd)).not.toThrow()
})

it('counts running and closing PTYs separately from exited snapshots', async () => {
  const { service, processes } = setup()
  for (let index = 0; index < 8; index += 1) {
    await service.open(1, resolve(`/exited-${index}`), 80, 24)
    processes[index].exit?.({ exitCode: 0 })
  }
  const live = []
  for (let index = 0; index < 8; index += 1) live.push(await service.open(1, resolve(`/live-${index}`), 80, 24))
  await expect(service.open(1, resolve('/next'), 80, 24)).rejects.toThrow(/最多运行 8/)
  service.close(1, live[0].id)
  await expect(service.open(1, resolve('/next'), 80, 24)).rejects.toThrow(/最多运行 8/)
  processes[8].exit?.({ exitCode: 0 })
  await expect(service.open(1, resolve('/next'), 80, 24)).resolves.toMatchObject({ cwd: resolve('/next') })
})

it('bounds exited snapshots independently and refreshes their replay LRU', async () => {
  const { service, processes } = setup()
  const snapshots = []
  for (let index = 0; index < 8; index += 1) {
    snapshots.push(await service.open(1, resolve(`/exited-${index}`), 80, 24))
    processes[index].exit?.({ exitCode: 0 })
  }
  expect((await service.open(1, snapshots[0].cwd, 80, 24)).id).toBe(snapshots[0].id)
  await service.open(1, resolve('/exited-next'), 80, 24)
  processes[8].exit?.({ exitCode: 0 })
  expect((await service.open(1, snapshots[0].cwd, 80, 24)).id).toBe(snapshots[0].id)
  expect((await service.open(1, snapshots[1].cwd, 80, 24)).id).not.toBe(snapshots[1].id)
  expect(mock.spawn).toHaveBeenCalledTimes(10)
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
