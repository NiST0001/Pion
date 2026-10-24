import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CapabilitySettingsStore, readCapabilityPreferences, validateCapabilityPreferences } from '../../src/main/capability-settings'
import {
  DEFAULT_CAPABILITY_PREFERENCES, PI_CORE_TOOL_NAMES, capabilityEnabled,
  type CapabilityChange, type CapabilityItem, type CapabilityKind, type CapabilityPreferences
} from '../../src/shared/capability-settings'

const MCP = `mcp:${'a'.repeat(64)}`
const SKILL = `skill:${'b'.repeat(64)}`
const EXTENSION = `extension:${'c'.repeat(64)}`
function item(id: string, kind: CapabilityKind): CapabilityItem {
  return { id, kind, name: id, label: id, description: '', origin: kind === 'tool' ? 'pi' : 'pion', enabled: true, available: true }
}
const ITEMS: readonly CapabilityItem[] = [
  ...PI_CORE_TOOL_NAMES.map((name) => item(`tool:${name}`, 'tool')),
  item('tool:pion_task', 'tool'), item('tool:pion_subagents', 'subagent'),
  item(MCP, 'mcp'), item(SKILL, 'skill'), item(EXTENSION, 'extension')
]
const OFF = { tool: false, mcp: false, skill: false, extension: false }
const ON = { tool: true, mcp: true, skill: true, extension: true }
const roots: string[] = []

afterEach(async () => {
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; path: string; store: CapabilitySettingsStore }> {
  const root = await mkdtemp(join(tmpdir(), 'pion-capability-settings-'))
  roots.push(root)
  const path = join(root, 'pion-capabilities.json')
  return { root, path, store: new CapabilitySettingsStore(path) }
}

it('inherits missing settings without writing, and never exposes the cached objects', async () => {
  const { root, path, store } = await fixture()
  expect(store.filePath).toBe(path)
  expect(store.getSnapshot()).toBeUndefined()
  expect(await readCapabilityPreferences()).toEqual(DEFAULT_CAPABILITY_PREFERENCES)
  const preferences = await store.get()
  expect(preferences).toEqual(DEFAULT_CAPABILITY_PREFERENCES)
  preferences.defaults.tool = false
  preferences.overrides['tool:read'] = false
  const snapshot = store.getSnapshot()!
  snapshot.defaults.skill = false
  expect(await store.get()).toEqual(DEFAULT_CAPABILITY_PREFERENCES)
  expect(await readdir(root)).toEqual([])
})

it('applies minimal in one revision, disables newly discovered capabilities, and permits later overrides', async () => {
  const { path, store } = await fixture()
  store.onChanged((preferences) => { preferences.defaults.tool = true; preferences.overrides['tool:read'] = false })
  const changes: CapabilityPreferences[] = []
  const unsubscribe = store.onChanged((preferences) => { changes.push(preferences) })
  store.onChanged(() => { throw new Error('listener fixture') })
  const minimal = await store.update(0, { type: 'preset', preset: 'minimal' }, ITEMS)
  expect(minimal).toEqual({
    version: 1, revision: 1, defaults: OFF,
    overrides: Object.fromEntries(PI_CORE_TOOL_NAMES.map((name) => [`tool:${name}`, true]))
  })
  expect(changes).toEqual([minimal])
  for (const entry of ITEMS) {
    expect(capabilityEnabled(minimal, entry.id, entry.kind)).toBe(entry.kind === 'tool' && PI_CORE_TOOL_NAMES.some((name) => entry.id === `tool:${name}`))
  }
  for (const [id, kind] of [
    ['tool:new_tool', 'tool'], [`mcp:${'d'.repeat(64)}`, 'mcp'],
    [`skill:${'e'.repeat(64)}`, 'skill'], [`extension:${'f'.repeat(64)}`, 'extension']
  ] as const) expect(capabilityEnabled(minimal, id, kind)).toBe(false)

  await store.update(1, { type: 'toggle', id: 'tool:pion_subagents', enabled: true }, ITEMS)
  const toggled = await store.update(2, { type: 'toggle', id: 'tool:read', enabled: false }, ITEMS)
  expect(capabilityEnabled(toggled, 'tool:pion_subagents', 'subagent')).toBe(true)
  expect(capabilityEnabled(toggled, 'tool:pion_subagents', 'tool')).toBe(true)
  expect(capabilityEnabled(toggled, 'tool:read', 'tool')).toBe(false)
  expect(await new CapabilitySettingsStore(path).get()).toEqual(toggled)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(toggled)
  unsubscribe()
  await store.update(3, { type: 'preset', preset: 'standard' }, ITEMS)
  expect(changes.map((preferences) => preferences.revision)).toEqual([1, 2, 3])
  const standard = store.getSnapshot()!
  expect(standard.defaults).toEqual(ON)
  expect(standard.overrides).toEqual({})
  expect(capabilityEnabled(standard, 'tool:new_tool', 'tool')).toBe(true)
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
})

it('no-skills only changes the skill default and skill overrides, without retaining a preset', async () => {
  const { root, path, store } = await fixture()
  const neighboring = ['settings.json', 'mcp.json', 'auth.json']
  for (const name of neighboring) await writeFile(join(root, name), `untouched-${name}`)
  await store.update(0, { type: 'toggle', id: 'tool:read', enabled: false }, ITEMS)
  await store.update(1, { type: 'toggle', id: MCP, enabled: false }, ITEMS)
  const before = await store.update(2, { type: 'toggle', id: SKILL, enabled: true }, ITEMS)
  const after = await store.update(3, { type: 'preset', preset: 'no-skills' }, ITEMS)
  expect(after).toEqual({
    ...before, revision: 4, defaults: { ...before.defaults, skill: false },
    overrides: { 'tool:read': false, [MCP]: false }
  })
  expect(capabilityEnabled(after, `skill:${'d'.repeat(64)}`, 'skill')).toBe(false)
  const toggled = await store.update(4, { type: 'toggle', id: SKILL, enabled: true }, ITEMS)
  expect(capabilityEnabled(toggled, SKILL, 'skill')).toBe(true)
  expect(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort()).toEqual(['defaults', 'overrides', 'revision', 'version'])
  for (const name of neighboring) expect(await readFile(join(root, name), 'utf8')).toBe(`untouched-${name}`)
})

it('serializes revision checks, rejects stale concurrent presets, and captures a queued toggle', async () => {
  const { path, store } = await fixture()
  const listener = vi.fn()
  store.onChanged(listener)
  const results = await Promise.allSettled([
    store.update(0, { type: 'preset', preset: 'minimal' }, ITEMS),
    store.update(0, { type: 'preset', preset: 'standard' }, ITEMS)
  ])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(store.getSnapshot()!.defaults).toEqual(OFF)
  expect(store.getSnapshot()!.revision).toBe(1)
  expect(listener).toHaveBeenCalledTimes(1)
  const change: CapabilityChange = { type: 'toggle', id: 'tool:pion_task', enabled: true }
  const updating = store.update(1, change, ITEMS)
  change.enabled = false
  const next = await updating
  expect(next.overrides['tool:pion_task']).toBe(true)
  expect(next.revision).toBe(2)
  expect(await readCapabilityPreferences(path)).toEqual(next)
  for (const invalid of [
    { type: 'toggle', id: 'tool:unknown', enabled: true },
    { type: 'toggle', id: 'subagent:pion_subagents', enabled: true },
    { type: 'toggle', id: 'tool:read', enabled: 'false' },
    { type: 'preset', preset: 'minimal', activePreset: 'minimal' }
  ]) await expect(store.update(2, invalid as CapabilityChange, ITEMS)).rejects.toThrow()
  for (const revision of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(store.update(revision, { type: 'preset', preset: 'minimal' }, ITEMS)).rejects.toThrow()
  }
  expect(store.getSnapshot()).toEqual(next)
  expect(listener).toHaveBeenCalledTimes(2)
})

it('strictly validates fields, IDs, revisions, booleans, prototypes and both size budgets', async () => {
  const base = DEFAULT_CAPABILITY_PREFERENCES
  for (const value of [
    null, [], { ...base, version: 2 }, { ...base, revision: -1 }, { ...base, revision: 0.5 },
    { ...base, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...base, activePreset: 'minimal' },
    { ...base, defaults: { ...base.defaults, tool: 'true' } },
    { ...base, defaults: { ...base.defaults, subagent: true } },
    { ...base, overrides: { 'tool:read': 'false' } },
    { ...base, overrides: { 'tool:read\n': true } },
    { ...base, overrides: { 'tool:constructor': true } },
    { ...base, overrides: { 'mcp:non-opaque': true } },
    { ...base, overrides: JSON.parse('{"__proto__":true}') },
    Object.create(base)
  ]) expect(() => validateCapabilityPreferences(value)).toThrow()
  const getter = vi.fn(() => 1)
  expect(() => validateCapabilityPreferences({ ...base, get revision() { return getter() } })).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() => validateCapabilityPreferences({
    ...base, overrides: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`tool:t${i}`, true]))
  })).toThrow()
  expect(() => validateCapabilityPreferences({
    ...base, overrides: Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [`tool:${`t${i}`.padEnd(128, 'x')}`, true]))
  })).toThrow('256 KiB')
  const { path, store } = await fixture()
  await writeFile(path, JSON.stringify({ ...base, revision: Number.MAX_SAFE_INTEGER }))
  await expect(store.update(Number.MAX_SAFE_INTEGER, { type: 'preset', preset: 'minimal' }, ITEMS)).rejects.toThrow('上限')
  expect((await readCapabilityPreferences(path)).revision).toBe(Number.MAX_SAFE_INTEGER)
})

it('never defaults over a corrupt, oversized, non-file or unreadable configuration', async () => {
  const secret = 'private-config-fixture'
  for (const content of [
    `{"secret":"${secret}",`,
    JSON.stringify({ ...DEFAULT_CAPABILITY_PREFERENCES, overrides: { [secret]: true } }),
    JSON.stringify(DEFAULT_CAPABILITY_PREFERENCES).padEnd(256 * 1024 + 1, ' ')
  ]) {
    const { path, store } = await fixture()
    await writeFile(path, content)
    await expect(store.get()).rejects.toThrow()
    await expect(store.update(0, { type: 'preset', preset: 'standard' }, ITEMS)).rejects.not.toThrow(secret)
    expect(store.getSnapshot()).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(content)
    await rm(path)
    await expect(store.update(0, { type: 'preset', preset: 'minimal' }, ITEMS)).rejects.toThrow()
  }
  const { root, path, store } = await fixture()
  await mkdir(path)
  await expect(store.get()).rejects.toThrow()
  const blocker = join(root, 'not-a-directory')
  await writeFile(blocker, secret)
  await expect(readCapabilityPreferences(join(blocker, 'settings.json'))).rejects.toThrow('读取失败')
  await rm(path, { recursive: true })
  await writeFile(path, JSON.stringify(DEFAULT_CAPABILITY_PREFERENCES).padEnd(256 * 1024, ' '))
  expect(await readCapabilityPreferences(path)).toEqual(DEFAULT_CAPABILITY_PREFERENCES)
})

it('keeps the committed revision on write failure, cleans its private temp and allows a later retry', async () => {
  const { root, path, store } = await fixture()
  const before = await store.update(0, { type: 'preset', preset: 'standard' }, ITEMS)
  const original = await readFile(path, 'utf8')
  const backup = join(root, 'backup')
  await rename(path, backup)
  await mkdir(path)
  await writeFile(join(root, 'unrelated.tmp'), 'keep')
  const listener = vi.fn()
  store.onChanged(listener)
  await expect(store.update(1, { type: 'preset', preset: 'minimal' }, ITEMS)).rejects.toThrow('保存失败')
  expect(store.getSnapshot()).toEqual(before)
  expect(listener).not.toHaveBeenCalled()
  expect((await readdir(root)).sort()).toEqual(['backup', 'pion-capabilities.json', 'unrelated.tmp'])
  expect(await readFile(backup, 'utf8')).toBe(original)
  await rm(path, { recursive: true })
  await rename(backup, path)
  expect((await store.update(1, { type: 'preset', preset: 'minimal' }, ITEMS)).revision).toBe(2)
  expect(listener).toHaveBeenCalledTimes(1)
})

it('rechecks owners before IO and after actual rename without publishing a retired result', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let current = false
  let retireAfterRename = true
  vi.doMock('node:fs/promises', () => ({
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      if (retireAfterRename) current = false
    }
  }))
  vi.resetModules()
  const { CapabilitySettingsStore: GuardedStore } = await import('../../src/main/capability-settings')
  const { root, path } = await fixture()
  const store = new GuardedStore(path)
  const listener = vi.fn()
  store.onChanged(listener)
  const assertCurrent = () => { if (!current) throw new Error('retired owner fixture') }
  await expect(store.update(0, { type: 'preset', preset: 'minimal' }, ITEMS, assertCurrent)).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
  current = true
  await expect(store.update(0, { type: 'preset', preset: 'minimal' }, ITEMS, assertCurrent)).rejects.toThrow('已写入')
  expect(listener).not.toHaveBeenCalled()
  expect(store.getSnapshot()).toBeUndefined()
  const committed = await readCapabilityPreferences(path)
  expect(committed.revision).toBe(1)
  expect(committed.defaults).toEqual(OFF)
  expect(await store.get()).toEqual(committed)
  current = true
  retireAfterRename = false
  await expect(store.update(0, { type: 'preset', preset: 'standard' }, ITEMS, assertCurrent)).rejects.toThrow('已变更')
  const next = await store.update(1, { type: 'preset', preset: 'standard' }, ITEMS, assertCurrent)
  expect(next.defaults).toEqual(ON)
  expect(next.overrides).toEqual({})
  expect(listener).toHaveBeenCalledTimes(1)
})
