import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { CapabilityCommands } from '../../src/main/agent/capability-state'
import { capabilityResourceId } from '../../src/main/capability-ids'
import {
  capabilityEnabled, CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_SOURCE, DEFAULT_CAPABILITY_PREFERENCES,
  PI_CORE_TOOL_NAMES, type CapabilityItem, type CapabilityPreferences
} from '../../src/shared/capability-settings'

let root: string
let home: string
let agentDir: string
let cwd: string
let readResources: typeof import('../../src/main/capability-catalogue')['readCapabilityResources']
const forbidden = vi.fn(() => { throw new Error('Catalogue attempted an execution/connection/installation') })
const prefs = (patch: Partial<CapabilityPreferences> = {}): CapabilityPreferences => ({
  ...DEFAULT_CAPABILITY_PREFERENCES, defaults: { ...DEFAULT_CAPABILITY_PREFERENCES.defaults }, overrides: {}, ...patch
})
async function file(path: string, content: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content) }
async function json(path: string, value: unknown) { await file(path, JSON.stringify(value)) }
async function skill(path: string, name: string, extra = '') {
  await file(path, `---\nname: ${name}\ndescription: ${name} metadata\n${extra}---\nDo not run the supporting scripts during discovery.\n`)
  return path
}
const scan = (preferences = prefs(), projectTrusted = true, runtimeItems?: CapabilityItem[]) =>
  readResources({ cwd, agentDir, projectTrusted, preferences, runtimeItems })

/** Emit the real policy's ON/OFF notice, including its final Skill selection.
 * Only the in-memory Pion observer runs; no SDK session or user factory starts.
 * Source receipts are fixture input to the bridge parser, not catalogue proof.
 */
async function runtimeNotice(preferences: CapabilityPreferences, items: CapabilityItem[], skillPath: string) {
  const { loadSkills } = await import('@earendil-works/pi-coding-agent')
  const { createCapabilityPolicy } = await import('../../src/main/agent/capability-policy')
  const { readCapabilityRuntimeNotice } = await import('../../src/main/agent/capability-state')
  const policy = createCapabilityPolicy({ preferences, cwd, runtimeId: `fixture-${preferences.revision}`,
    loadout: { allowed: () => true, initialize: () => undefined } as Parameters<typeof createCapabilityPolicy>[0]['loadout'],
    items: items.map((item) => ({ ...item, enabled: capabilityEnabled(preferences, item.id, item.kind, item.enabled) })),
    notices: [], getSessionPath: () => undefined, getSubagentsEnabled: () => false, getMcpItems: () => [] })
  let selected: ReturnType<typeof loadSkills> = { skills: [], diagnostics: [] }
  policy.initialize([], undefined, () => selected.skills)
  const actual = items.filter((item) => (item.kind === 'tool' || item.kind === 'subagent')
    && capabilityEnabled(preferences, item.id, item.kind, item.enabled)).map((item) => ({ name: item.name, exposure: 'direct',
    sourceInfo: { path: '<inline:fixture>', source: 'inline', scope: 'temporary', origin: 'top-level' } }))
  let description = ''
  const handlers = new Map<string, () => void>()
  const api = { on: (name: string, handler: () => void) => { handlers.set(name, handler); return () => handlers.delete(name) },
    getAllTools: () => actual, getActiveTools: () => actual.map((item) => item.name),
    registerCommand: (_name: string, command: { description?: string }) => { description = command.description ?? '' } } as unknown as ExtensionAPI
  if (typeof policy.extension === 'function') throw new Error('Expected a named Pion observer')
  await policy.extension.factory(api)
  handlers.get('session_start')!()
  // Mirror a late resources_discover load: assign the final loader result only
  // after skillsOverride, then observe its actual policy notice.
  selected = policy.skillsOverride(loadSkills({ cwd, agentDir, skillPaths: [skillPath], includeDefaults: false }))
  await Promise.resolve()
  policy.refreshNotice()
  const commands: CapabilityCommands = [{ name: CAPABILITY_RUNTIME_COMMAND, description, source: 'extension',
    sourceInfo: { path: CAPABILITY_RUNTIME_SOURCE, source: 'inline', scope: 'temporary', origin: 'top-level' } }]
  return readCapabilityRuntimeNotice(commands, { cwd, revision: preferences.revision })
}

beforeEach(async () => {
  vi.resetModules()
  forbidden.mockClear()
  root = await mkdtemp(join(tmpdir(), 'pion-capability-catalogue-'))
  home = join(root, 'home')
  agentDir = join(home, '.pi', 'agent')
  cwd = join(root, 'repo', 'nested', 'workspace')
  await mkdir(agentDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(join(root, 'repo', '.git')) // ancestor discovery boundary, not a real Git invocation
  vi.stubEnv('HOME', home)
  vi.stubGlobal('fetch', forbidden)
  vi.doMock('@earendil-works/pi-coding-agent', async (original) => {
    const sdk = await original<typeof import('@earendil-works/pi-coding-agent')>()
    // Exercise real public resource discovery. Every execution/lifecycle route
    // is guarded; no user profile, factory, model, npm command or MCP is needed.
    type ExecutingMethods = Record<'runCommand' | 'runCommandCapture' | 'runCommandSync' | 'installParsedSource'
      | 'getLatestNpmVersion' | 'repairMissingGitDependencies' | 'refreshTemporaryGitSource', (...args: unknown[]) => unknown>
    const prototype = sdk.DefaultPackageManager.prototype as unknown as ExecutingMethods
    for (const key of ['runCommand', 'runCommandCapture', 'runCommandSync', 'installParsedSource',
      'getLatestNpmVersion', 'repairMissingGitDependencies', 'refreshTemporaryGitSource'] as const) vi.spyOn(prototype, key).mockImplementation(forbidden)
    vi.spyOn(sdk.DefaultPackageManager.prototype, 'resolveExtensionSources').mockImplementation(forbidden)
    vi.spyOn(sdk.SettingsManager, 'create').mockImplementation(forbidden)
    return {
      ...sdk, getAgentDir: () => agentDir,
      DefaultResourceLoader: forbidden, ModelRuntime: forbidden, createAgentSession: forbidden,
      createMcpExtension: forbidden, createCodemodeExtension: forbidden, createToolSearchExtension: forbidden
    }
  })
  readResources = (await import('../../src/main/capability-catalogue')).readCapabilityResources
})
afterEach(async () => {
  try { expect(forbidden).not.toHaveBeenCalled() }
  finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.doUnmock('@earendil-works/pi-coding-agent')
    vi.resetModules()
    await rm(root, { recursive: true, force: true })
  }
})

it('lists globals and every fixed slot without cwd, without accidentally trusting a project or probing ComputerUse', async () => {
  const globalSkill = await skill(join(agentDir, 'skills', 'global', 'SKILL.md'), 'global-skill')
  const agentsSkill = await skill(join(home, '.agents', 'skills', 'user', 'SKILL.md'), 'user-agents-skill')
  await skill(join(agentDir, '.pi', 'skills', 'not-selected', 'SKILL.md'), 'must-not-load-project')
  await json(join(agentDir, 'settings.json'), { extensions: ['-builtin:mcp'], defaultTools: ['read', 'grep'], unrelatedProviderSecret: 'PRIVATE_CANARY' })
  await json(join(agentDir, 'mcp.json'), { mcpServers: { personal: { command: 'PRIVATE_COMMAND', enabled: false } } })
  const result = await readResources({ projectTrusted: true, preferences: prefs() })
  expect(result.items.filter((item) => item.kind === 'skill').map((item) => item.name).sort()).toEqual(['global-skill', 'user-agents-skill'])
  expect(result.skillPaths).toEqual(expect.arrayContaining([globalSkill, agentsSkill]))
  for (const name of PI_CORE_TOOL_NAMES) expect(result.items.find((item) => item.id === `tool:${name}`)).toMatchObject({ kind: 'tool', origin: 'pi' })
  for (const name of ['pion_task', 'pion_ask_user', 'pion_generate_image', 'codemode', 'tool_search', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
    expect(result.items.some((item) => item.id === `tool:${name}`)).toBe(true)
  }
  expect(result.items.filter((item) => item.id === 'tool:pion_subagents')).toMatchObject([{ kind: 'subagent' }])
  expect(result.items.find((item) => item.name === 'pion_computer_observe')).toMatchObject({ available: false })
  expect(result.items.find((item) => item.name === 'pion_computer_act')).toMatchObject({ available: false })
  expect(result.items.find((item) => item.id === 'tool:read')?.enabled).toBe(true)
  expect(result.items.find((item) => item.id === 'tool:bash')?.enabled).toBe(false)
  expect(result.items.find((item) => item.id === 'tool:codemode')?.enabled).toBe(false)
  expect(result.extensionPaths).not.toContain('builtin:mcp')
  expect(result.items.find((item) => item.kind === 'mcp')).toMatchObject({ name: 'personal', enabled: false })
  expect(result.catalogueRevision).toMatch(/^[a-f0-9]{64}$/)
  const publicData = JSON.stringify({ items: result.items, notices: result.notices, catalogueRevision: result.catalogueRevision })
  expect(publicData).not.toContain(root)
  expect(publicData).not.toContain('PRIVATE_')
  expect(result.notices.join(' ')).toMatch(/未执行扩展工厂.*未知/)
})

it.each([
  { selection: 'wildcard', defaultTools: ['*'], enabled: [...PI_CORE_TOOL_NAMES, 'codemode', 'tool_search'] },
  { selection: 'names and patterns', defaultTools: ['read', 'g*', 'tool_*'], enabled: ['read', 'grep', 'tool_search'] },
  { selection: 'resolved +grep', defaultTools: ['+grep'], enabled: ['read', 'bash', 'edit', 'write', 'grep'] },
  { selection: 'resolved exact removal', defaultTools: ['-write', '+grep'], enabled: ['read', 'bash', 'edit', 'grep'] }
])('inherits SDK $selection for fixed core and optional extension tools without executing factories', async ({ defaultTools, enabled }) => {
  await json(join(agentDir, 'settings.json'), { defaultTools })
  const result = await scan()
  for (const name of [...PI_CORE_TOOL_NAMES, 'codemode', 'tool_search']) {
    expect(result.items.find((item) => item.id === `tool:${name}`)).toMatchObject({ enabled: enabled.includes(name) })
  }
  expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toEqual({ defaultTools })
})

it.each(['r?ad', 'r[ea]*'])('fails closed with an explicit notice for unsupported defaultTools selection %s', async (entry) => {
  await json(join(agentDir, 'settings.json'), { defaultTools: ['*', entry] })
  await expect(scan()).rejects.toThrow('仅支持精确名称和 *')
})

it('discovers trusted .agents ancestors only through the repository boundary; desired on cannot grant trust', async () => {
  await skill(join(root, '.agents', 'skills', 'outside', 'SKILL.md'), 'outside-repository')
  const ancestor = await skill(join(root, 'repo', '.agents', 'skills', 'ancestor', 'SKILL.md'), 'repository-ancestor')
  const nested = await skill(join(root, 'repo', 'nested', '.agents', 'skills', 'nested', 'SKILL.md'), 'nested-ancestor')
  const local = await skill(join(cwd, '.pi', 'skills', 'project', 'SKILL.md'), 'trusted-project', 'disable-model-invocation: true\n')
  await skill(join(home, '.agents', 'skills', 'personal', 'SKILL.md'), 'personal')
  await file(join(cwd, '.pi', 'extensions', 'project.ts'), 'export default () => { throw new Error("FACTORY_MUST_NOT_RUN") }')
  const trusted = await scan()
  expect(trusted.skillPaths).toEqual(expect.arrayContaining([ancestor, nested, local]))
  expect(trusted.items.some((item) => item.name === 'outside-repository')).toBe(false)
  expect(trusted.items.find((item) => item.name === 'trusted-project')).toMatchObject({ origin: 'project', enabled: true })
  const untrusted = await scan(prefs({ defaults: { tool: true, mcp: true, skill: true, extension: true } }), false)
  expect(untrusted.items.filter((item) => item.kind === 'skill').map((item) => item.name)).toEqual(['personal'])
  expect(untrusted.extensionPaths.every((path) => !path.startsWith(cwd))).toBe(true)
  expect(untrusted.notices.join(' ')).toContain('开启偏好不授予信任')
  expect(untrusted.catalogueRevision).not.toBe(trusted.catalogueRevision)
})

it('keeps SDK-disabled metadata reopenable and returns only preference-selected private paths', async () => {
  const disabled = await skill(join(agentDir, 'skills', 'disabled', 'SKILL.md'), 'disabled-skill')
  const active = await skill(join(agentDir, 'skills', 'active', 'SKILL.md'), 'active-skill')
  const extension = join(agentDir, 'extensions', 'never.ts')
  await file(extension, 'export default () => { throw new Error("FACTORY_MUST_NOT_RUN") }')
  await file(join(agentDir, 'prompts', 'on.md'), 'template')
  await file(join(agentDir, 'prompts', 'off.md'), 'template')
  await json(join(agentDir, 'themes', 'theme.json'), { name: 'metadata-only' })
  const settings = {
    skills: ['-skills/disabled/SKILL.md'], extensions: ['-extensions/never.ts', '-builtin:codemode'], prompts: ['-prompts/off.md']
  }
  await json(join(agentDir, 'settings.json'), settings)
  const first = await scan()
  const skillItem = first.items.find((item) => item.name === 'disabled-skill')!
  const entry = first.items.find((item) => item.kind === 'extension' && item.name === 'never.ts')!
  const builtin = first.items.find((item) => item.kind === 'extension' && item.name === 'codemode')!
  expect(skillItem.id).toBe(capabilityResourceId('skill', disabled))
  expect(skillItem.enabled).toBe(false)
  expect(entry.enabled).toBe(false)
  expect(first.skillPaths).toEqual([active])
  expect(first.extensionPaths).not.toContain(extension)
  expect(first.promptPaths).toEqual([join(agentDir, 'prompts', 'on.md')])
  expect(first.themePaths).toEqual([join(agentDir, 'themes', 'theme.json')])
  const reopened = await scan(prefs({ overrides: { [skillItem.id]: true, [entry.id]: true, [builtin.id]: true } }))
  expect(reopened.skillPaths).toContain(disabled)
  expect(reopened.extensionPaths).toEqual(expect.arrayContaining([extension, 'builtin:codemode']))
  expect(reopened.items.find((item) => item.id === 'tool:codemode')?.available).toBe(true)
  expect(reopened.catalogueRevision).toBe(first.catalogueRevision)
  const off = await scan(prefs({ defaults: { tool: 'inherit', mcp: 'inherit', skill: false, extension: false } }))
  expect(off.skillPaths).toEqual([])
  expect(off.extensionPaths).toEqual([])
  expect(off.items.filter((item) => item.kind === 'skill')).toHaveLength(2)
  expect(off.items.find((item) => item.id === 'tool:codemode')?.available).toBe(false)
  expect(off.catalogueRevision).toBe(first.catalogueRevision)
  expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toEqual(settings)
})

it('never widens a package manifest, even with object-form filters or a standard-on preference', async () => {
  const pkg = join(root, 'package')
  const allowed = await skill(join(pkg, 'skills', 'allowed', 'SKILL.md'), 'allowed-package-skill')
  await skill(join(pkg, 'skills', 'private', 'SKILL.md'), 'manifest-excluded')
  await file(join(pkg, 'extensions', 'good.ts'), 'export default () => { throw new Error("FACTORY_MUST_NOT_RUN") }')
  await file(join(pkg, 'extensions', 'undeclared.ts'), 'export default () => {}')
  await file(join(pkg, 'prompts', 'hidden.md'), 'not declared by manifest')
  await json(join(pkg, 'themes', 'hidden.json'), { name: 'not-declared' })
  await json(join(pkg, 'package.json'), { pi: { extensions: ['extensions/good.ts'], skills: ['skills/**/SKILL.md', '!skills/private/**'], prompts: [] } })
  await json(join(agentDir, 'settings.json'), { packages: [{ source: pkg, extensions: [], skills: ['skills/**'], prompts: ['prompts/*.md'], themes: ['themes/*.json'] }] })
  const inherited = await scan()
  expect(inherited.items.find((item) => item.kind === 'extension' && item.name === 'good.ts')?.enabled).toBe(false)
  const standard = await scan(prefs({ defaults: { tool: true, mcp: true, skill: true, extension: true } }))
  expect(standard.skillPaths).toEqual([allowed])
  expect(standard.items.some((item) => item.name === 'manifest-excluded' || item.name === 'undeclared.ts')).toBe(false)
  expect(standard.extensionPaths).toContain(join(pkg, 'extensions', 'good.ts'))
  expect(standard.promptPaths).toEqual([])
  expect(standard.themePaths).toEqual([])
})

it('handles installed npm tags locally and leaves missing/mismatched packages unknown without legacy probes or repairs', async () => {
  const installed = join(agentDir, 'npm', 'node_modules', 'installed')
  const mismatch = join(agentDir, 'npm', 'node_modules', 'mismatch')
  await file(join(installed, 'entry.ts'), 'export default () => { throw new Error("FACTORY_MUST_NOT_RUN") }')
  await json(join(installed, 'package.json'), { version: '1.2.3', pi: { extensions: ['entry.ts'] } })
  await json(join(mismatch, 'package.json'), { version: '1.0.0', pi: { extensions: ['must-not-load.ts'] } })
  await file(join(mismatch, 'must-not-load.ts'), 'export default () => {}')
  const settings = {
    npmCommand: ['never-run-custom-wrapper'],
    packages: ['npm:installed@next', 'npm:mismatch@^2.0.0', 'npm:missing@latest', 'git:github.com/example/not-installed']
  }
  await json(join(agentDir, 'settings.json'), settings)
  const before = await readdir(agentDir)
  const result = await scan()
  expect(result.extensionPaths).toContain(join(installed, 'entry.ts'))
  expect(result.extensionPaths).not.toContain(join(mismatch, 'must-not-load.ts'))
  expect(result.notices.join(' ')).toContain('unknown')
  expect(result.notices.join(' ')).not.toContain('never-run-custom-wrapper')
  expect(await readdir(agentDir)).toEqual(before) // no tmp/extension install roots or lock files
  expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toEqual(settings)
})

it('retains SDK project package deltas and exposes both colliding Skill identities for later reopening', async () => {
  const pkg = join(root, 'shared-package')
  const packageSkill = await skill(join(pkg, 'skills', 'shared', 'SKILL.md'), 'delta-skill')
  await json(join(pkg, 'package.json'), { pi: { skills: ['skills/shared/SKILL.md'] } })
  await json(join(agentDir, 'settings.json'), { packages: [pkg] })
  await json(join(cwd, '.pi', 'settings.json'), { packages: [{ source: pkg, autoload: false, skills: ['-skills/shared/SKILL.md'] }] })
  const user = await skill(join(agentDir, 'skills', 'same', 'SKILL.md'), 'same-name')
  const project = await skill(join(cwd, '.pi', 'skills', 'same', 'SKILL.md'), 'same-name')
  const first = await scan()
  expect(first.items.find((item) => item.id === capabilityResourceId('skill', packageSkill))).toMatchObject({ enabled: false, origin: 'project' })
  expect(first.skillPaths).toContain(project)
  expect(first.skillPaths).not.toContain(user)
  expect(first.items.filter((item) => item.name === 'same-name')).toHaveLength(2)
  expect(first.items.find((item) => item.id === capabilityResourceId('skill', user))).toMatchObject({ enabled: true, available: false })
  const switched = await scan(prefs({ overrides: { [capabilityResourceId('skill', project)]: false } }))
  expect(switched.skillPaths).toContain(user)
  expect(switched.skillPaths).not.toContain(project)
  expect(switched.catalogueRevision).toBe(first.catalogueRevision)
})

it('keeps source revisions stable across real OFF notices and retains dynamic Skill/extension switches', async () => {
  const entry = join(agentDir, 'extensions', 'dynamic.ts')
  await file(entry, 'export default () => { throw new Error("FACTORY_MUST_NOT_RUN") }')
  const discovered = await skill(join(root, 'runtime-discovered', 'SKILL.md'), 'runtime-discovered')
  const skillId = capabilityResourceId('skill', discovered)
  const runtime: CapabilityItem = { id: 'tool:late_tool', kind: 'tool', name: 'late_tool', label: 'Late tool', description: 'Existing runtime metadata', origin: 'extension', enabled: true, available: true }
  const subagent: CapabilityItem = { ...runtime, id: 'tool:pion_subagents', kind: 'subagent', name: 'pion_subagents', origin: 'pion' }
  const extension: CapabilityItem = { ...runtime, id: capabilityResourceId('extension', '<inline:fixture>', 'temporary', entry), kind: 'extension', name: 'dynamic-entry' }
  const on = await runtimeNotice(prefs(), [runtime, subagent, extension], discovered)
  const first = await scan(prefs(), true, on.items)
  expect(first.items.find((item) => item.id === skillId)).toMatchObject({ kind: 'skill', origin: 'extension', enabled: true, available: true })
  expect(first.items.find((item) => item.id === extension.id)).toMatchObject({ kind: 'extension', enabled: true })
  // Runtime metadata never invents private loader paths. The real SDK loader
  // owns resources_discover and its final Skill filter.
  expect(first.skillPaths).not.toContain(discovered)
  const offPreferences = prefs({ revision: 72, defaults: { tool: false, mcp: false, skill: false, extension: false } })
  const off = await runtimeNotice(offPreferences, [runtime, subagent, extension], discovered)
  expect(off.items.find((item) => item.id === skillId)).toMatchObject({ enabled: false, available: false })
  expect(off.items.find((item) => item.id === runtime.id)).toMatchObject({ enabled: false, available: false })
  const toggled = await scan(offPreferences, true, off.items)
  expect(toggled.catalogueRevision).toBe(first.catalogueRevision)
  expect(toggled.items.find((item) => item.id === skillId)).toMatchObject({ enabled: false, available: false })
  const desired = prefs({ ...offPreferences, revision: 73, overrides: { [runtime.id]: true, [skillId]: true, [extension.id]: true } })
  const reopening = await scan(desired, true, off.items)
  expect(reopening.catalogueRevision).toBe(first.catalogueRevision)
  expect(reopening.items.find((item) => item.id === runtime.id)).toMatchObject({ enabled: true, available: false })
  expect(reopening.items.find((item) => item.id === skillId)).toMatchObject({ enabled: true, available: false })
  expect(reopening.items.find((item) => item.id === extension.id)?.enabled).toBe(true)
  expect(reopening.items.filter((item) => item.id === 'tool:pion_subagents')).toMatchObject([{ kind: 'subagent' }])
  await json(join(agentDir, 'settings.json'), { extensions: ['-extensions/dynamic.ts'] })
  const sdkDisabled = await scan(prefs(), true, on.items)
  expect(sdkDisabled.catalogueRevision).not.toBe(first.catalogueRevision)
  await json(join(agentDir, 'mcp.json'), { mcpServers: { raw: { command: 'never-execute', enabled: false } } })
  const mcpDisabled = await scan(prefs())
  await json(join(agentDir, 'mcp.json'), { mcpServers: { raw: { command: 'never-execute', enabled: true } } })
  expect((await scan(prefs())).catalogueRevision).not.toBe(mcpDisabled.catalogueRevision)
})

it('accepts only bounded runtime metadata with matching kind/keys and an explicit public whitelist', async () => {
  const dynamic: CapabilityItem = { id: capabilityResourceId('skill', 'fixture-source'), kind: 'skill', name: 'discovered',
    label: 'Discovered', description: 'x'.repeat(1024), origin: 'extension', enabled: true, available: false, unavailableReason: 'Not in final loader' }
  const extension: CapabilityItem = { ...dynamic, kind: 'extension', id: capabilityResourceId('extension', 'fixture-source') }
  const clean = await scan(prefs(), true, [dynamic, extension])
  const invalid = [
    null, { ...dynamic, id: 'skill:raw-path' }, { ...dynamic, id: extension.id }, { ...extension, id: dynamic.id },
    { ...dynamic, kind: 'tool', id: 'tool:discovered', name: 'mismatch' },
    { ...dynamic, kind: 'subagent', id: 'tool:discovered' },
    { ...dynamic, kind: 'tool', id: 'tool:pion_subagents', name: 'pion_subagents' },
    { ...dynamic, kind: 'mcp', id: dynamic.id }, { ...dynamic, kind: 'unknown' }, { ...dynamic, origin: 'unknown' },
    { ...dynamic, name: 'x'.repeat(129) }, { ...dynamic, label: 'x'.repeat(129) }, { ...dynamic, description: 'x'.repeat(1025) },
    { ...dynamic, name: 'control\ncharacter' }, { ...dynamic, description: '\u0000' },
    { ...dynamic, unavailableReason: 'x'.repeat(257) }, { ...dynamic, unavailableReason: '\u007f' },
    { ...dynamic, enabled: 'true' }, { ...dynamic, available: 1 }
  ]
  const polluted = await scan(prefs(), true, [
    { ...dynamic, privateConfig: 'PRIVATE_RUNTIME_CANARY', sourcePath: root }, extension, ...invalid
  ] as CapabilityItem[])
  expect(polluted.catalogueRevision).toBe(clean.catalogueRevision)
  expect(polluted.items.filter((item) => item.id === dynamic.id || item.id === extension.id)).toEqual([dynamic, extension])
  expect(JSON.stringify(polluted.items)).not.toMatch(/PRIVATE_RUNTIME_CANARY|sourcePath|privateConfig/)
  expect(JSON.stringify(polluted.items)).not.toContain(root)
})

it.each(['getGlobalSettings', 'getProjectSettings', 'getDefaultTools'] as const)(
  'rejects a failed read-only %s getter instead of publishing an empty complete catalogue', async (method) => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const resolve = vi.spyOn(sdk.DefaultPackageManager.prototype, 'resolve')
    vi.spyOn(sdk.SettingsManager.prototype, method).mockImplementation(() => { throw new Error('PRIVATE_GETTER_DIAGNOSTIC') })
    await expect(scan()).rejects.toThrow('部分资源设置或元数据无法只读解析')
    expect(resolve).not.toHaveBeenCalled()
    expect(await readdir(agentDir)).toEqual([])
  }
)
