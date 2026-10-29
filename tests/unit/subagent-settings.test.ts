import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertSubagentSettingsOwner, SubagentSettingsStore } from '../../src/main/subagent-settings'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_LIMITS, SUBAGENT_THINKING_LEVELS, validateSubagentModelSelection, validateSubagentSettings } from '../../src/shared/subagents'
import { readRuntimeSubagentSettings } from '../../src/main/agent/subagents'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('accepts 1–100 children and 1–300 minutes without changing defaults', () => {
  expect(DEFAULT_SUBAGENT_SETTINGS).toMatchObject({ maxParallel: 3, timeoutMinutes: 10 })
  for (const [maxParallel, timeoutMinutes] of [[1, 1], [100, 300]]) {
    expect(validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel, timeoutMinutes }))
      .toMatchObject({ maxParallel, timeoutMinutes })
  }
  expect(() => validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 101 })).toThrow()
  expect(() => validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, timeoutMinutes: 301 })).toThrow()
})

it('accepts 1000 turns while retaining the 24-turn default and rejecting 1001', () => {
  expect(DEFAULT_SUBAGENT_SETTINGS.maxTurns).toBe(24)
  for (const maxTurns of [1, 64, 65, 1000]) {
    expect(validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, maxTurns }).maxTurns).toBe(maxTurns)
  }
  expect(() => validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, maxTurns: 1001 })).toThrow('1–1000')
})

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

it('normalizes legacy settings to inherited model/thinking and clones exact model identities', () => {
  const { defaultModel: _defaultModel, defaultThinkingLevel: _defaultThinkingLevel, ...legacy } = DEFAULT_SUBAGENT_SETTINGS
  expect(validateSubagentSettings(legacy)).toEqual({ ...legacy, defaultModel: null, defaultThinkingLevel: null })
  const model = { provider: 'provider-a', id: 'model-a' }
  const normalized = validateSubagentSettings({ ...legacy, defaultModel: model })
  expect(normalized.defaultModel).toEqual(model)
  expect(normalized.defaultModel).not.toBe(model)
  model.id = 'changed'
  expect(normalized.defaultModel!.id).toBe('model-a')
  expect(validateSubagentModelSelection(null)).toBeNull()
  expect(validateSubagentModelSelection({ provider: 'p'.repeat(128), id: 'i'.repeat(256) })).toEqual({ provider: 'p'.repeat(128), id: 'i'.repeat(256) })
})

it('accepts the locked SDK thinking levels and inheritance, rejecting arbitrary values', () => {
  expect(SUBAGENT_THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  for (const defaultThinkingLevel of [...SUBAGENT_THINKING_LEVELS, null, undefined]) {
    expect(validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, defaultThinkingLevel }).defaultThinkingLevel)
      .toBe(defaultThinkingLevel ?? null)
  }
  for (const defaultThinkingLevel of ['', 'auto', 'HIGH', 'high ', 0, false, [], {}]) {
    expect(() => validateSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS, defaultThinkingLevel })).toThrow('思考等级无效')
  }
})

it.each([undefined, '', [], { provider: 'p' }, { provider: 'p', id: '' },
  { provider: 'p'.repeat(129), id: 'm' }, { provider: 'p', id: 'i'.repeat(257) },
  { provider: 'p ', id: 'm' }, { provider: 'p', id: 'm\n' },
  { provider: 'p', id: 'm', apiKey: 'do-not-save' }, { provider: 'p', id: 'm', name: 'display-only' }
])('rejects an invalid explicit model selection: %j', (model) => {
  expect(() => validateSubagentModelSelection(model)).toThrow()
})

it('persists captured model/thinking across store reopening without aliasing queued input or returned values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pion-subagent-model-settings-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  const store = new SubagentSettingsStore(() => path)
  vi.stubEnv('PION_SUBAGENT_SETTINGS_FILE', path)
  const input = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'provider-a', id: 'model-a' }, defaultThinkingLevel: 'high' as const }
  const savedPromise = store.set(input)
  input.defaultModel.id = 'changed-before-write'
  Object.assign(input, { defaultThinkingLevel: 'off' })
  const saved = await savedPromise
  expect(saved.defaultModel).toEqual({ provider: 'provider-a', id: 'model-a' })
  saved.defaultModel!.id = 'changed-after-return'
  expect((await store.get()).defaultModel).toEqual({ provider: 'provider-a', id: 'model-a' })
  expect(await readRuntimeSubagentSettings()).toMatchObject({ defaultModel: { provider: 'provider-a', id: 'model-a' }, defaultThinkingLevel: 'high' })
  expect(await new SubagentSettingsStore(() => path).get()).toMatchObject({ defaultModel: { provider: 'provider-a', id: 'model-a' }, defaultThinkingLevel: 'high' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ defaultModel: { provider: 'provider-a', id: 'model-a' }, defaultThinkingLevel: 'high' })
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
  expect(() => store.set({ ...last, maxParallel: 101 })).toThrow()
  expect(await store.get()).toEqual(last)
  await writeFile(path, '{broken', 'utf8')
  await expect(readRuntimeSubagentSettings()).rejects.toThrow('无法读取子代理设置')
  await expect(store.set(first)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await expect(store.get()).rejects.toThrow()
})
