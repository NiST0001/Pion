import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertSubagentSettingsOwner, SubagentSettingsStore } from '../../src/main/subagent-settings'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_LIMITS, validateSubagentSettings } from '../../src/shared/subagents'
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
