import { expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerWindowIpc } from '../../src/main/ipc/window'
import { IPC } from '../../src/shared/ipc'

type Handler = Parameters<IpcMain['handle']>[1]

function harness(reserveMutation?: Parameters<typeof registerWindowIpc>[0]['reserveMutation']) {
  const handlers = new Map<string, Handler>()
  const owner = { id: 41 as number | undefined }
  const frame = { detached: false }
  const event = { sender: { id: 41, mainFrame: frame, isDestroyed: vi.fn(() => false) }, senderFrame: frame }
  const terminals = { open: vi.fn().mockResolvedValue({ id: 'terminal' }), write: vi.fn(), resize: vi.fn(), close: vi.fn() }
  const windowEffects = { get: vi.fn(), setEnabled: vi.fn().mockResolvedValue({ enabled: true }) }
  const win = { isMaximized: () => true }
  const windowFromWebContents = vi.fn(() => win as unknown as BrowserWindow)
  registerWindowIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, on: vi.fn() },
    terminals: terminals as unknown as Parameters<typeof registerWindowIpc>[0]['terminals'],
    windowEffects: windowEffects as unknown as Parameters<typeof registerWindowIpc>[0]['windowEffects'],
    windowFromWebContents, getMainWindowId: () => owner.id, reserveMutation
  })
  return { event, owner, terminals, windowEffects, windowFromWebContents,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, ...args) }
}

it.each([IPC.GetWindowEffects, IPC.TerminalOpen])(
  'shares the owner/main-frame gate for %s', channel => {
    const h = harness()
    h.event.senderFrame = { detached: false }
    expect(() => h.invoke(channel)).toThrow('所属主窗口的活主帧')
    h.event.senderFrame = h.event.sender.mainFrame
    h.owner.id = 73
    expect(() => h.invoke(channel)).toThrow('所属主窗口的活主帧')
    for (const service of [h.terminals, h.windowEffects]) {
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
    }
  }
)

it('rechecks the original frame before a delayed terminal admission', async () => {
  let admit!: () => void
  const admission = new Promise<void>(resolve => { admit = resolve })
  const h = harness(async operation => { await admission; return operation() })
  const pending = h.invoke(IPC.TerminalOpen, '/project', 80, 24)
  h.event.sender.mainFrame = { detached: false }
  admit()
  await expect(pending).rejects.toThrow('所属主窗口的活主帧')
  expect(h.terminals.open).not.toHaveBeenCalled()
})

it.each([IPC.TerminalOpen, IPC.SetWindowEffects])('rejects a late %s result after main-frame replacement', async channel => {
  const h = harness()
  let finish!: (value: object) => void
  const pendingOperation = new Promise<object>(resolve => { finish = resolve })
  const service = channel === IPC.TerminalOpen ? h.terminals.open : h.windowEffects.setEnabled
  service.mockReturnValue(pendingOperation)
  const pending = h.invoke(channel, '/project', 80, 24)
  h.event.sender.mainFrame = { detached: false }
  finish({})
  await expect(pending).rejects.toThrow('所属主窗口的活主帧')
})

it('passes the captured owner into the appearance service publication gate', async () => {
  const h = harness()
  h.windowEffects.setEnabled.mockImplementationOnce(async (_owner, _enabled, assertCurrent) => {
    h.event.sender.mainFrame = { detached: false }
    assertCurrent()
    return { enabled: true }
  })
  await expect(h.invoke(IPC.SetWindowEffects, true)).rejects.toThrow('所属主窗口的活主帧')
  expect(h.windowEffects.setEnabled).toHaveBeenCalledExactlyOnceWith(41, true, expect.any(Function))
})

it('keeps window-state lookup synchronous and independent of terminal mutation admission', () => {
  const reserveMutation = vi.fn()
  const h = harness(reserveMutation)
  expect(h.invoke(IPC.WindowState)).toBe(true)
  expect(h.windowFromWebContents).toHaveBeenCalledWith(h.event.sender)
  expect(reserveMutation).not.toHaveBeenCalled()
})
