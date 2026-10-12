import { expect, it, vi } from 'vitest'
import { registerWindowIpc } from '../../src/main/ipc/window'
import { IPC } from '../../src/shared/ipc'
import type { QuestionSettingsStore } from '../../src/main/question-settings'
vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))

it('wires settings through the injected store and rejects owner/main-frame and late owner changes', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const get = vi.fn()
  const set = vi.fn()
  let owner: number | undefined = 10
  registerWindowIpc({
    ipcMain: { handle: (channel, callback) => { handlers.set(channel, callback) }, on: vi.fn() },
    windowFromWebContents: vi.fn(),
    windowEffects: {} as Parameters<typeof registerWindowIpc>[0]['windowEffects'],
    terminals: {} as Parameters<typeof registerWindowIpc>[0]['terminals'],
    questionSettings: { get, set } as unknown as QuestionSettingsStore,
    getMainWindowId: () => owner
  })
  const frame = {}
  const event = { sender: { id: 10, mainFrame: frame, isDestroyed: () => false }, senderFrame: frame }
  const read = handlers.get(IPC.GetQuestionSettings)!
  const save = handlers.get(IPC.SetQuestionSettings)!
  await expect(read({ ...event, senderFrame: {} })).rejects.toThrow('所属主窗口')
  owner = 11
  await expect(save(event, { timeoutMinutes: null })).rejects.toThrow('所属主窗口')
  expect(set).not.toHaveBeenCalled()
  owner = 10
  let finish!: (value: { timeoutMinutes: number }) => void
  get.mockImplementation(() => new Promise((done) => { finish = done }))
  const pending = read(event)
  owner = undefined
  finish({ timeoutMinutes: 10 })
  await expect(pending).rejects.toThrow('窗口已变更')
  owner = 10
  set.mockImplementation(async (_value, assertCurrent) => { owner = undefined; assertCurrent() })
  await expect(save(event, { timeoutMinutes: null })).rejects.toThrow('窗口已变更')
})
