import { resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { createPionRuntime, parseRuntimeArgs } from '../../src/main/agent/runtime-host'

const mocks = vi.hoisted(() => ({ services: vi.fn(), session: vi.fn(), runtime: vi.fn(), settings: vi.fn(), create: vi.fn(), open: vi.fn() }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...await original<typeof import('@earendil-works/pi-coding-agent')>(),
  createAgentSessionServices: mocks.services,
  createAgentSessionFromServices: mocks.session,
  createAgentSessionRuntime: mocks.runtime,
  SettingsManager: { create: mocks.settings },
  SessionManager: { create: mocks.create, open: mocks.open }
}))
const cwd = resolve('project')
beforeEach(() => {
  vi.clearAllMocks()
  const manager = { getCwd: () => cwd, buildSessionContext: () => ({ messages: [] }) }
  const settings = { getEnabledModels: () => [], getDefaultProvider: () => undefined, getDefaultModel: () => undefined }
  mocks.create.mockReturnValue(manager)
  mocks.open.mockReturnValue(manager)
  mocks.settings.mockReturnValue(settings)
  mocks.services.mockResolvedValue({ settingsManager: settings, modelRuntime: {}, diagnostics: [] })
  mocks.session.mockResolvedValue({ session: {}, extensionsResult: {} })
  mocks.runtime.mockImplementation(async (factory, target) => factory(target))
})

it('parses only the private RPC arguments and fails closed on unknown flags', () => {
  expect(parseRuntimeArgs(['--mode', 'rpc', '--no-approve', '--extension', './permissions.ts'], cwd)).toMatchObject({ approved: false, extensions: [resolve(cwd, 'permissions.ts')] })
  expect(() => parseRuntimeArgs(['--session'], cwd)).toThrow(/Missing/)
  expect(() => parseRuntimeArgs(['--mode', 'print'], cwd)).toThrow(/RPC/)
  expect(() => parseRuntimeArgs(['--unexpected'], cwd)).toThrow(/Unsupported/)
})

it('injects a compiled SDK tool, preserves trust gating, and recreates tools for replacement sessions', async () => {
  await createPionRuntime(['--mode', 'rpc', '--no-approve', '--extension', './permissions.ts'], cwd)
  expect(mocks.settings).toHaveBeenCalledWith(cwd, expect.any(String), { projectTrusted: false })
  expect(mocks.session).toHaveBeenCalledWith(expect.objectContaining({ customTools: [expect.objectContaining({ name: 'pion_ask_user' }), expect.objectContaining({ name: 'pion_subagents' })] }))
  expect(mocks.services).toHaveBeenCalledWith(expect.objectContaining({ resourceLoaderOptions: { additionalExtensionPaths: [resolve(cwd, 'permissions.ts')], extensionFactories: [expect.any(Function)] } }))
  const [factory, target] = mocks.runtime.mock.calls[0]
  await factory({ ...target, sessionStartEvent: { reason: 'new' } })
  expect(mocks.session).toHaveBeenCalledTimes(2)
  await expect(factory({ ...target, cwd: resolve('other-project') })).rejects.toThrow(/跨项目/)
})
