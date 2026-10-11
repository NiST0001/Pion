import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertSubagentSettingsOwner, SubagentSettingsStore } from '../../src/main/subagent-settings'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_LIMITS, validateSubagentModelSelection, validateSubagentSettings } from '../../src/shared/subagents'
import { readRuntimeSubagentSettings } from '../../src/main/agent/subagents'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('rejects child frames and windows other than the owning main window', () => {
  const frame = {}
  const event = { sender: { id: 10, mainFrame: frame }, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent
  expect(() => assertSubagentSettingsOwner(event, 10)).not.toThrow()
  expect(() => assertSubagentSettingsOwner(event, 11)).toThrow('所属主窗口')
  expect(() => assertSubagentSettingsOwner(event, undefined)).toThrow('所属主窗口')
  expect(() => assertSubagentSettingsOwner({ ...event, senderFrame: {} as Electron.WebFrameMain }, 10)).toThrow('所属主窗口')
})

it.each(Object.keys(SUBAGENT_LIMITS) as (keyof typeof SUBAGENT_LIMITS)[])('validates the hard bounds for %s', (key) => {
  for (const value of [0, -1, NaN, Infinity, 1.5, '3', SUBAGENT_LIMITS[key].max + 1]) {
    expect(() => validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, [key]: value })).toThrow()
  }
  expect(validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, [key]: SUBAGENT_LIMITS[key].max })[key]).toBe(SUBAGENT_LIMITS[key].max)
})

it('normalizes legacy settings to inherited model and clones exact model identities', () => {
  const { defaultModel: _defaultModel, ...legacy } = DEFAULT_SUBAGENT_SETTINGS
  expect(validateSubagentSettings(legacy)).toEqual({ ...legacy, defaultModel: null })
  const model = { provider: 'provider-a', id: 'model-a' }
  const normalized = validateSubagentSettings({ ...legacy, defaultModel: model })
  expect(normalized.defaultModel).toEqual(model)
  expect(normalized.defaultModel).not.toBe(model)
  model.id = 'changed'
  expect(normalized.defaultModel!.id).toBe('model-a')
  expect(validateSubagentModelSelection(null)).toBeNull()
  expect(validateSubagentModelSelection({ provider: 'p'.repeat(128), id: 'i'.repeat(256) })).toEqual({ provider: 'p'.repeat(128), id: 'i'.repeat(256) })
})

it.each([undefined, '', [], { provider: 'p' }, { provider: 'p', id: '' },
  { provider: 'p'.repeat(129), id: 'm' }, { provider: 'p', id: 'i'.repeat(257) },
  { provider: 'p ', id: 'm' }, { provider: 'p', id: 'm\n' },
  { provider: 'p', id: 'm', apiKey: 'do-not-save' }, { provider: 'p', id: 'm', name: 'display-only' }
])('rejects an invalid explicit model selection: %j', (model) => {
  expect(() => validateSubagentModelSelection(model)).toThrow()
})

it('saves the captured nested model without aliasing queued input or returned values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-subagent-model-settings-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  const store = new SubagentSettingsStore(() => path)
  vi.stubEnv('PION_SUBAGENT_SETTINGS_FILE', path)
  const input = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'provider-a', id: 'model-a' } }
  const savedPromise = store.set(input)
  input.defaultModel.id = 'changed-before-write'
  const saved = await savedPromise
  expect(saved.defaultModel).toEqual({ provider: 'provider-a', id: 'model-a' })
  saved.defaultModel!.id = 'changed-after-return'
  expect((await store.get()).defaultModel).toEqual({ provider: 'provider-a', id: 'model-a' })
  expect((await readRuntimeSubagentSettings()).defaultModel).toEqual({ provider: 'provider-a', id: 'model-a' })
  expect(JSON.parse(await readFile(path, 'utf8')).defaultModel).toEqual({ provider: 'provider-a', id: 'model-a' })
})

it('persists global defaults atomically and existing runtimes read the next saved configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-subagent-settings-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  const store = new SubagentSettingsStore(() => path)
  vi.stubEnv('PION_SUBAGENT_SETTINGS_FILE', path)
  expect(await store.get()).toEqual(DEFAULT_SUBAGENT_SETTINGS)
  expect(await readRuntimeSubagentSettings()).toEqual(DEFAULT_SUBAGENT_SETTINGS)
  const first = { ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 4 }
  const last = { ...first, maxTurns: 12 }
  await Promise.all([store.set(first), store.set(last)])
  expect(await store.get()).toEqual(last)
  expect(await readRuntimeSubagentSettings()).toEqual(last)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(last)
  expect(() => store.set({ ...last, maxParallel: 99 })).toThrow()
  expect(await store.get()).toEqual(last)
  await writeFile(path, '{broken', 'utf8')
  await expect(readRuntimeSubagentSettings()).rejects.toThrow('无法读取子代理设置')
  await store.set(first)
  expect(await readRuntimeSubagentSettings()).toEqual(first)
})
