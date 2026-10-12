import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertQuestionSettingsOwner, QuestionSettingsStore } from '../../src/main/question-settings'
import { DEFAULT_QUESTION_SETTINGS, parseQuestionWaitMetadata, validateQuestionSettings } from '../../src/shared/question-settings'
import { readRuntimeQuestionSettings } from '../../src/main/agent/ask-user'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('validates defaults, finite boundaries and explicit unlimited without coercion', () => {
  expect(DEFAULT_QUESTION_SETTINGS).toEqual({ timeoutMinutes: 10 })
  for (const timeoutMinutes of [1, 300, null]) expect(validateQuestionSettings({ timeoutMinutes })).toEqual({ timeoutMinutes })
  for (const value of [undefined, null, [], {}, { timeoutMinutes: '10' }, { timeoutMinutes: 0 }, { timeoutMinutes: 301 },
    { timeoutMinutes: 1.5 }, { timeoutMinutes: NaN }, { timeoutMinutes: Infinity }, { timeoutMinutes: 10, apiKey: 'secret' }]) {
    expect(() => validateQuestionSettings(value)).toThrow()
  }
})

it('projects only bounded private deadline metadata, without trusting it as an authentication boundary', () => {
  const value = { version: 1, nonce: 'backend-nonce', toolCallId: 'call-1', phase: 'begin', timeoutMs: null }
  expect(parseQuestionWaitMetadata([JSON.stringify(value)])).toEqual(value)
  expect(parseQuestionWaitMetadata([JSON.stringify({ ...value, timeoutMs: 300 * 60_000 })])).toMatchObject({ timeoutMs: 300 * 60_000 })
  for (const invalid of [{ ...value, timeoutMs: 0 }, { ...value, timeoutMs: 300 * 60_000 + 1 },
    { ...value, toolCallId: 'x'.repeat(257) }, { ...value, nonce: '' }, { ...value, question: 'private' }, { ...value, phase: 'unknown' }]) {
    expect(parseQuestionWaitMetadata([JSON.stringify(invalid)])).toBeUndefined()
  }
  expect(parseQuestionWaitMetadata(['x'.repeat(2049)])).toBeUndefined()
  expect(parseQuestionWaitMetadata([JSON.stringify(value), JSON.stringify(value)])).toBeUndefined()
})

it('rejects child frames, destroyed senders and non-owning windows', () => {
  const frame = {}
  const event = { sender: { id: 10, mainFrame: frame, isDestroyed: () => false }, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent
  expect(() => assertQuestionSettingsOwner(event, 10)).not.toThrow()
  expect(() => assertQuestionSettingsOwner(event, undefined)).toThrow('所属主窗口')
  expect(() => assertQuestionSettingsOwner(event, 11)).toThrow('所属主窗口')
  expect(() => assertQuestionSettingsOwner({ ...event, senderFrame: {} as Electron.WebFrameMain }, 10)).toThrow()
  expect(() => assertQuestionSettingsOwner({ ...event, sender: { ...event.sender, isDestroyed: () => true } } as Electron.IpcMainInvokeEvent, 10)).toThrow()
})

it('persists an independent private file, reads next-question settings and rejects simultaneous saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-question-settings-'))
  roots.push(root)
  const path = join(root, 'questions.json')
  vi.stubEnv('PION_QUESTION_SETTINGS_FILE', path)
  const store = new QuestionSettingsStore(() => path)
  expect(await store.get()).toEqual(DEFAULT_QUESTION_SETTINGS)
  expect(await readRuntimeQuestionSettings()).toEqual(DEFAULT_QUESTION_SETTINGS)
  const input = { timeoutMinutes: 300 }
  const pending = store.set(input)
  input.timeoutMinutes = 1
  await expect(store.set({ timeoutMinutes: null })).rejects.toThrow('仍在保存')
  expect(await pending).toEqual({ timeoutMinutes: 300 })
  expect(await readRuntimeQuestionSettings()).toEqual({ timeoutMinutes: 300 })
  await store.set({ timeoutMinutes: null })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ timeoutMinutes: null })
  expect(await readRuntimeQuestionSettings()).toEqual({ timeoutMinutes: null })
})

it('does not silently overwrite corrupt settings or accept oversized runtime files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-question-settings-corrupt-'))
  roots.push(root)
  const path = join(root, 'questions.json')
  vi.stubEnv('PION_QUESTION_SETTINGS_FILE', path)
  const store = new QuestionSettingsStore(() => path)
  await writeFile(path, '{broken')
  await expect(store.get()).rejects.toThrow()
  await expect(readRuntimeQuestionSettings()).rejects.toThrow('未提供答案或授权')
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await writeFile(path, ' '.repeat(4097))
  await expect(store.get()).rejects.toThrow('文件过大')
  await expect(readRuntimeQuestionSettings()).rejects.toThrow('未提供答案或授权')
})

it('checks the captured owner again before publishing settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-question-settings-owner-'))
  roots.push(root)
  const path = join(root, 'questions.json')
  const store = new QuestionSettingsStore(() => path)
  await store.set({ timeoutMinutes: 10 })
  let calls = 0
  const pending = store.set({ timeoutMinutes: null }, () => { if (++calls > 1) throw new Error('owner changed') })
  await expect(pending).rejects.toThrow('owner changed')
  expect(await store.get()).toEqual({ timeoutMinutes: 10 })
})
