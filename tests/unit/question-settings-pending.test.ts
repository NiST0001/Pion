import { afterEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ open: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn() }))
vi.mock('node:fs/promises', () => io)
vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
import { QuestionSettingsStore } from '../../src/main/question-settings'
import { readRuntimeQuestionSettings } from '../../src/main/agent/ask-user'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks() })
function file() {
  let read = false
  return {
    read: vi.fn(async (buffer: Buffer) => {
      if (read) return { bytesRead: 0 }
      read = true
      const value = Buffer.from('{"timeoutMinutes":10}')
      value.copy(buffer)
      return { bytesRead: value.length }
    }),
    close: vi.fn().mockResolvedValue(undefined)
  }
}

it('main read deadline retains one actual operation until late open/read/close settle', async () => {
  vi.useFakeTimers()
  let finish!: (value: ReturnType<typeof file>) => void
  io.open.mockImplementation(() => new Promise((done) => { finish = done }))
  const store = new QuestionSettingsStore(() => '/settings')
  const first = store.get()
  const rejected = expect(first).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  const second = store.get()
  expect(io.open).toHaveBeenCalledTimes(1)
  const handle = file()
  finish(handle)
  expect(await second).toEqual({ timeoutMinutes: 10 })
  expect(handle.close).toHaveBeenCalledTimes(1)
})

it('runtime read deadline preserves its process-wide slot until the actual late operation settles', async () => {
  vi.useFakeTimers()
  vi.stubEnv('PION_QUESTION_SETTINGS_FILE', '/settings')
  let finish!: (value: ReturnType<typeof file>) => void
  io.open.mockImplementation(() => new Promise((done) => { finish = done }))
  const rejected = expect(readRuntimeQuestionSettings()).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  await expect(readRuntimeQuestionSettings()).rejects.toThrow('仍在读取')
  expect(io.open).toHaveBeenCalledTimes(1)
  const handle = file()
  finish(handle)
  await vi.advanceTimersByTimeAsync(0)
  expect(handle.close).toHaveBeenCalledTimes(1)
  io.open.mockResolvedValue(file())
  expect(await readRuntimeQuestionSettings()).toEqual({ timeoutMinutes: 10 })
})

it('expired main save does not publish a late temporary write or release its slot prematurely', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  io.mkdir.mockResolvedValue(undefined)
  io.unlink.mockResolvedValue(undefined)
  io.writeFile.mockImplementation(() => new Promise<void>((done) => { finish = done }))
  const store = new QuestionSettingsStore(() => '/settings')
  const rejected = expect(store.set({ timeoutMinutes: null })).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  await expect(store.set({ timeoutMinutes: 10 })).rejects.toThrow('仍在保存')
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(io.rename).not.toHaveBeenCalled()
  expect(io.unlink).toHaveBeenCalledTimes(1)
  io.writeFile.mockResolvedValue(undefined)
  io.rename.mockResolvedValue(undefined)
  expect(await store.set({ timeoutMinutes: 10 })).toEqual({ timeoutMinutes: 10 })
})
