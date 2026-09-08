import { afterEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
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
