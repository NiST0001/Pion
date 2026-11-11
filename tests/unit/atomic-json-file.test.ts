import { beforeEach, expect, it, vi } from 'vitest'
import { writeAtomicJson } from '../../src/main/atomic-json-file'

const io = vi.hoisted(() => ({ mkdir: vi.fn(), open: vi.fn(), rename: vi.fn(), unlink: vi.fn() }))
vi.mock('node:fs/promises', () => io)
const handle = { writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  io.mkdir.mockResolvedValue(undefined)
  io.open.mockResolvedValue(handle)
  io.rename.mockResolvedValue(undefined)
  io.unlink.mockResolvedValue(undefined)
  handle.writeFile.mockResolvedValue(undefined)
  handle.sync.mockResolvedValue(undefined)
  handle.close.mockResolvedValue(undefined)
})

it('cleans its closed wx staging file when the publication owner retires', async () => {
  const failure = new Error('retired owner')
  await expect(writeAtomicJson('/project/settings.json', { enabled: true }, () => { throw failure })).rejects.toBe(failure)
  const temporary = io.open.mock.calls[0][0]
  expect(io.open).toHaveBeenCalledWith(temporary, 'wx', 0o600)
  expect(handle.close).toHaveBeenCalledTimes(1)
  expect(io.rename).not.toHaveBeenCalled()
  expect(io.unlink).toHaveBeenCalledExactlyOnceWith(temporary)
})

it('never cleans a staging path whose exclusive open failed', async () => {
  const failure = Object.assign(new Error('occupied staging path'), { code: 'EEXIST' })
  io.open.mockRejectedValueOnce(failure)
  await expect(writeAtomicJson('/project/settings.json', {})).rejects.toBe(failure)
  expect(handle.close).not.toHaveBeenCalled()
  expect(io.unlink).not.toHaveBeenCalled()
  expect(io.rename).not.toHaveBeenCalled()
})

it('waits for actual close before checking the owner and publishing', async () => {
  let finish!: () => void
  let entered!: () => void
  const closing = new Promise<void>((resolve) => { finish = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  handle.close.mockImplementationOnce(() => { entered(); return closing })
  const guard = vi.fn()
  const pending = writeAtomicJson('/project/settings.json', {}, guard)
  await started
  expect(guard).not.toHaveBeenCalled()
  expect(io.rename).not.toHaveBeenCalled()
  finish()
  await pending
  expect(guard).toHaveBeenCalledTimes(1)
  expect(io.rename).toHaveBeenCalledExactlyOnceWith(io.open.mock.calls[0][0], '/project/settings.json')
})

it('retains an uncertain-close staging file without retrying close or publishing', async () => {
  const failure = new Error('close outcome unknown')
  handle.close.mockRejectedValueOnce(failure)
  const guard = vi.fn()
  await expect(writeAtomicJson('/project/settings.json', {}, guard)).rejects.toBe(failure)
  expect(handle.close).toHaveBeenCalledTimes(1)
  expect(guard).not.toHaveBeenCalled()
  expect(io.unlink).not.toHaveBeenCalled()
  expect(io.rename).not.toHaveBeenCalled()
})
