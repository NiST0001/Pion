import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { writeAtomicJson } from '../../src/main/atomic-json-file'
import { SessionOrganizationStore } from '../../src/main/session-organization'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('../../src/main/atomic-json-file', () => ({ writeAtomicJson: vi.fn() }))

it('holds queued reads and shutdown until the shared writer actually settles', async () => {
  const empty = { version: 1, revision: 0, folders: [], sessions: [] }
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(empty))
  let finish!: () => void
  vi.mocked(writeAtomicJson).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const store = new SessionOrganizationStore(() => '/organization.json')
  const guard = vi.fn()
  let saved = false, read = false, closed = false
  const update = store.update({ type: 'createFolder', id: 'f', cwd: '/project', name: 'F' }, guard).then((value) => { saved = true; return value })
  await vi.waitFor(() => { expect(writeAtomicJson).toHaveBeenCalledTimes(1) })
  expect(writeAtomicJson).toHaveBeenCalledWith('/organization.json', expect.objectContaining({ revision: 1 }), guard)
  const queued = store.get().then((value) => { read = true; return value })
  const shutdown = store.shutdown().then(() => { closed = true })
  await expect(store.get()).rejects.toThrow('正在退出')
  expect({ saved, read, closed }).toEqual({ saved: false, read: false, closed: false })
  expect(readFile).toHaveBeenCalledTimes(1)
  finish()
  await expect(update).resolves.toMatchObject({ revision: 1 })
  await expect(queued).resolves.toEqual(empty)
  await shutdown
  expect({ saved, read, closed }).toEqual({ saved: true, read: true, closed: true })
  expect(readFile).toHaveBeenCalledTimes(2)
})
