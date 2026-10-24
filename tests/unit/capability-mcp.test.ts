import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  applyCapabilityMcpRegistrations, capabilityMcpRegistrationItems, loadCapabilityMcpConfiguration
} from '../../src/main/agent/capability-mcp'
import { DEFAULT_CAPABILITY_PREFERENCES, type CapabilityPreferences } from '../../src/shared/capability-settings'

let root: string
let cwd: string
let agentDir: string
const preferences = (patch: Partial<CapabilityPreferences> = {}): CapabilityPreferences => ({
  ...DEFAULT_CAPABILITY_PREFERENCES, defaults: { ...DEFAULT_CAPABILITY_PREFERENCES.defaults }, overrides: {}, ...patch
})
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value)) }
function load(projectTrusted = true, prefs = preferences(), directory = cwd) {
  return loadCapabilityMcpConfiguration({ cwd: directory, agentDir, projectTrusted, preferences: prefs })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pion-capability-mcp-'))
  cwd = join(root, 'project')
  agentDir = join(root, 'agent')
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await mkdir(agentDir)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network permitted') }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.doUnmock('node:fs')
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

it('uses the pinned canonical loader for exact merge, override ownership and private credential preservation', async () => {
  const global = {
    mcpServers: {
      docs: { command: 'never-execute', args: ['private-arg'], env: { TOKEN: '!never-expand', KEY: '${NEVER_LOOK_UP}' }, enabled: false, exposure: 'codemode-deferred' },
      cloud: { url: 'https://private.invalid/mcp', headers: { Authorization: 'private-token' }, oauth: { clientId: 'private-client', clientSecret: '!never-run' } }
    }, autoEnableCodemode: false
  }
  const project = { mcpServers: { docs: { enabled: false, exposure: 'deferred', toolExposure: { get: 'direct' } } }, autoEnableCodemode: true }
  await json(join(agentDir, 'mcp.json'), global)
  await json(join(cwd, '.pi', 'mcp.json'), project)
  const result = load()
  expect(result.config.errors).toEqual([])
  expect(result.config.autoEnableCodemode).toBe(true)
  expect(result.config.projectConfig).toBe(join(cwd, '.pi', 'mcp.json'))
  expect(result.config.servers[0]).toMatchObject({
    name: 'docs', scope: 'global', source: join(agentDir, 'mcp.json'), override: join(cwd, '.pi', 'mcp.json'),
    config: { ...global.mcpServers.docs, exposure: 'deferred', toolExposure: { get: 'direct' } }
  })
  expect(result.items[0]).toMatchObject({ kind: 'mcp', enabled: false, available: true, origin: 'project' })
  const publicText = JSON.stringify({ items: result.items, notices: result.notices })
  for (const secret of ['private-', 'never-execute', 'never-expand', 'NEVER_LOOK_UP', agentDir, cwd, '!never-run']) expect(publicText).not.toContain(secret)
  expect(result.notices.join(' ')).toMatch(/旧 MCP.*关闭.*扩展入口/)
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))).toEqual(global)
  expect(JSON.parse(await readFile(join(cwd, '.pi', 'mcp.json'), 'utf8'))).toEqual(project)
})

it('applies desired enabled before native startup, retaining disabled canonical rows as merge tombstones', async () => {
  await json(join(agentDir, 'mcp.json'), { mcpServers: { same: { command: 'never-execute', enabled: false }, other: { url: 'https://private.invalid/mcp' } } })
  const inherited = load()
  expect(inherited.config.servers.map((entry) => entry.config.enabled)).toEqual([false, true])
  const on = load(true, preferences({ revision: 50, defaults: { tool: true, skill: true, extension: true, mcp: true } }))
  expect(on.items.map((item) => item.id)).toEqual(inherited.items.map((item) => item.id))
  expect(on.config.servers.map((entry) => entry.config.enabled)).toEqual([true, true])
  const off = load(true, preferences({ overrides: { [inherited.items[0].id]: false, [inherited.items[1].id]: false } }))
  // The SDK's configuredEntries merge still sees both names; an extension with
  // a same-name registration must not come back merely because it was disabled.
  expect(off.config.servers.map((entry) => [entry.name, entry.config.enabled])).toEqual([['same', false], ['other', false]])
})

it('shares a global source/raw-name switch across no project, A and B without changing canonical files', async () => {
  const global = { mcpServers: { 'raw-name': { command: 'never-execute', env: { TOKEN: 'PRIVATE_CANARY' } } } }
  await json(join(agentDir, 'mcp.json'), global)
  const other = join(root, 'another-cwd')
  await mkdir(join(other, '.pi'), { recursive: true })
  const base = load()
  const id = base.items[0].id
  const off = preferences({ overrides: { [id]: false } }) // Saved while viewing A.
  for (const [directory, trusted] of [[agentDir, false], [cwd, true], [other, true]] as const) {
    const result = load(trusted, off, directory)
    expect(result.items).toMatchObject([{ id, name: 'raw-name', origin: 'user', enabled: false }])
    expect(result.config.servers).toMatchObject([{ name: 'raw-name', config: { enabled: false, env: global.mcpServers['raw-name'].env } }])
  }
  expect(JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))).toEqual(global)
  // Neither SDK namespace normalization nor another global source may alias it.
  await json(join(agentDir, 'mcp.json'), { mcpServers: { raw_name: global.mcpServers['raw-name'] } })
  expect(load().items[0].id).not.toBe(id)
  const secondAgentDir = join(root, 'other-agent')
  await mkdir(secondAgentDir)
  await json(join(secondAgentDir, 'mcp.json'), global)
  const otherSource = loadCapabilityMcpConfiguration({ cwd, agentDir: secondAgentDir, projectTrusted: true, preferences: off })
  expect(otherSource.items[0]).toMatchObject({ enabled: true })
  expect(otherSource.items[0].id).not.toBe(id)
  expect(fetch).not.toHaveBeenCalled()
})

it('binds project definitions and overrides to their exact source, cwd and owner, without changing a global identity', async () => {
  await json(join(agentDir, 'mcp.json'), { mcpServers: { shared: { command: 'never-execute' } } })
  const base = load()
  expect(load(true, preferences(), join(root, 'another-cwd')).items[0].id).toBe(base.items[0].id)
  await json(join(cwd, '.pi', 'mcp.json'), { mcpServers: { shared: { enabled: false } } })
  const overridden = load()
  expect(overridden.config.servers[0].source).toBe(base.config.servers[0].source)
  expect(overridden.items[0].id).not.toBe(base.items[0].id)
  const other = join(root, 'other-project')
  await mkdir(join(other, '.pi'), { recursive: true })
  await json(join(other, '.pi', 'mcp.json'), { mcpServers: { shared: { enabled: false } } })
  const otherOverride = load(true, preferences(), other)
  expect(otherOverride.items[0].id).not.toBe(overridden.items[0].id)
  const reopenFirst = preferences({ overrides: { [overridden.items[0].id]: true } })
  expect(load(true, reopenFirst).items[0].enabled).toBe(true)
  expect(load(true, reopenFirst, other).items[0].enabled).toBe(false)
  await json(join(cwd, '.pi', 'mcp.json'), { mcpServers: { shared: { command: 'new-private-definition' } } })
  const replaced = load()
  expect(replaced.config.servers[0].scope).toBe('project')
  expect(replaced.items[0].id).not.toBe(overridden.items[0].id)
  expect(replaced.items[0].id).not.toBe(base.items[0].id)
  await json(join(other, '.pi', 'mcp.json'), { mcpServers: { shared: { command: 'new-private-definition' } } })
  const closeFirst = preferences({ overrides: { [replaced.items[0].id]: false } })
  expect(load(true, closeFirst).items[0].enabled).toBe(false)
  const otherDefinition = load(true, closeFirst, other)
  expect(otherDefinition.items[0]).toMatchObject({ origin: 'project', enabled: true })
  expect(otherDefinition.items[0].id).not.toBe(replaced.items[0].id)
  const untrusted = load(false, preferences({ defaults: { tool: true, mcp: true, skill: true, extension: true } }))
  expect(untrusted.items[0].id).toBe(base.items[0].id)
  expect(untrusted.config.servers[0].config).toMatchObject({ command: 'never-execute' })
  await writeFile(join(cwd, '.pi', 'mcp.json'), '{"malformed":"PRIVATE_PARSE_DIAGNOSTIC"')
  expect(load(false).config.errors).toEqual([])
  const bad = load(true)
  expect(bad.config.errors).toHaveLength(1)
  expect(JSON.stringify({ items: bad.items, notices: bad.notices, errors: bad.config.errors })).not.toContain('PRIVATE_PARSE_DIAGNOSTIC')
})

it('keeps canonical validation, namespace collisions and the global-only auth baseline under standard-on', async () => {
  await json(join(agentDir, 'mcp.json'), {
    mcpServers: {
      'a-b': { command: 'never-execute' }, a_b: { command: 'must-not-win' },
      authbase: { url: 'https://private.invalid/mcp', auth: { provider: 'private-provider' } },
      invalid_enabled: { command: 'private-command', enabled: 'yes' }, invalid_sse: { type: 'sse', url: 'https://private.invalid/sse' },
      invalid_args: { command: 'private-command', args: [1] }, invalid_env: { command: 'private-command', env: { KEY: 1 } },
      invalid_headers: { url: 'https://private.invalid/mcp', headers: { KEY: 1 } },
      invalid_oauth: { url: 'https://private.invalid/mcp', oauth: { callbackUrl: 'https://remote.invalid/callback' } },
      invalid_timeout: { command: 'private-command', timeout: 0 }
    }
  })
  await json(join(cwd, '.pi', 'mcp.json'), { mcpServers: {
    authbase: { enabled: false },
    repo_auth: { url: 'https://attacker.invalid/mcp', auth: { provider: 'private-provider' } },
    missing_base: { enabled: true }, 'a-b': { enabled: false, env: { KEY: 'illegal-override' } }
  } })
  const result = load(true, preferences({ defaults: { tool: true, mcp: true, skill: true, extension: true } }))
  expect(result.config.servers.map((entry) => entry.name)).toEqual(['a-b', 'authbase'])
  expect(result.config.servers.every((entry) => entry.config.enabled === true)).toBe(true)
  expect(result.config.servers[0].override).toBeUndefined() // invalid override never replaces the baseline
  expect(result.config.servers[1]).toMatchObject({ scope: 'global', config: { auth: { provider: 'private-provider' } } })
  expect(result.config.errors).toHaveLength(1) // bounded fixed notice, not raw SDK errors
  expect(JSON.stringify({ items: result.items, notices: result.notices, errors: result.config.errors })).not.toMatch(/attacker|private-command|private-provider|illegal-override/)
})

it('refuses an unaudited internal loader rather than returning empty config and reviving registrations', async () => {
  vi.resetModules()
  vi.doMock('node:fs', () => ({ readFileSync: () => JSON.stringify({ version: '1.4.1' }) }))
  const adapter = await import('../../src/main/agent/capability-mcp')
  expect(() => adapter.loadCapabilityMcpConfiguration({ cwd, agentDir, projectTrusted: true, preferences: preferences() })).toThrow('无法只读解析当前版本')
  expect(fetch).not.toHaveBeenCalled()
})

it('covers extension registrations with exact owner-bound IDs, without filtering or mutating disabled rows', () => {
  const entries = [
    Object.freeze({ name: 'same', extensionPath: '/extension/one.ts', config: Object.freeze({ enabled: false, command: 'private-one' }), marker: 1 }),
    Object.freeze({ name: 'same', extensionPath: '/extension/two.ts', config: Object.freeze({ enabled: true, command: 'private-two' }), marker: 2 }),
    Object.freeze({ name: 'a-b', extensionPath: '/extension/one.ts', config: Object.freeze({ enabled: true, command: 'private-three' }), marker: 3 }),
    Object.freeze({ name: 'a_b', extensionPath: '/extension/one.ts', config: Object.freeze({ enabled: true, command: 'private-four' }), marker: 4 })
  ]
  const items = capabilityMcpRegistrationItems(entries, preferences(), cwd)
  expect(new Set(items.map((item) => item.id)).size).toBe(4)
  expect(items.map((item) => item.enabled)).toEqual([false, true, true, true])
  const prefs = preferences({ defaults: { tool: true, mcp: true, skill: true, extension: true }, overrides: { [items[1].id]: false } })
  const applied = applyCapabilityMcpRegistrations(entries, prefs, cwd)
  expect(applied.map((entry) => entry.config.enabled)).toEqual([true, false, true, true])
  expect(applied.map((entry) => entry.marker)).toEqual([1, 2, 3, 4])
  expect(entries[0].config.enabled).toBe(false)
  expect(applied[0]).not.toBe(entries[0])
  expect(applied[0].config).not.toBe(entries[0].config)
  expect(capabilityMcpRegistrationItems(entries, prefs, join(root, 'different'))[0].id).not.toBe(items[0].id)
  expect(JSON.stringify(items)).not.toMatch(/extension\/|private-/)
})
