import { resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { createPionRuntime, parseRuntimeArgs } from '../../src/main/agent/runtime-host'

const mocks = vi.hoisted(() => ({ services: vi.fn(), session: vi.fn(), runtime: vi.fn(), settings: vi.fn(), create: vi.fn(), open: vi.fn(), image: vi.fn(), auth: vi.fn() }))
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...await original<typeof import('@earendil-works/pi-coding-agent')>(),
  createAgentSessionServices: mocks.services,
  createAgentSessionFromServices: mocks.session,
  createAgentSessionRuntime: mocks.runtime,
  SettingsManager: { create: mocks.settings },
  SessionManager: { create: mocks.create, open: mocks.open }
}))
vi.mock('../../src/main/agent/image-generation', () => ({ createImageGenerationTool: mocks.image }))
const cwd = resolve('project')
beforeEach(() => {
  vi.clearAllMocks()
  const manager = { getCwd: () => cwd, buildSessionContext: () => ({ messages: [] }) }
  const settings = { getEnabledModels: () => [], getDefaultProvider: () => undefined, getDefaultModel: () => undefined }
  mocks.create.mockReturnValue(manager)
  mocks.open.mockReturnValue(manager)
  mocks.settings.mockReturnValue(settings)
  mocks.auth.mockResolvedValue(undefined)
  mocks.image.mockImplementation((options) => ({
    name: 'pion_generate_image',
    // Exercise only the injected runtime boundary, not the real image API.
    execute: async (signal: AbortSignal) => options.getAuth({ signal, minOAuthValidityMs: 300_000 })
  }))
  mocks.services.mockResolvedValue({ settingsManager: settings, modelRuntime: { getAuth: mocks.auth }, diagnostics: [] })
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
  expect(mocks.session).toHaveBeenCalledWith(expect.objectContaining({ customTools: [expect.objectContaining({ name: 'pion_ask_user' }), expect.objectContaining({ name: 'pion_subagents' }), expect.objectContaining({ name: 'pion_generate_image' })] }))
  expect(mocks.image).toHaveBeenCalledWith({ cwd, getAuth: expect.any(Function) })
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(mocks.services).toHaveBeenCalledWith(expect.objectContaining({ resourceLoaderOptions: { additionalExtensionPaths: [resolve(cwd, 'permissions.ts')], extensionFactories: [expect.any(Function)] } }))
  const [factory, target] = mocks.runtime.mock.calls[0]
  await factory({ ...target, sessionStartEvent: { reason: 'new' } })
  expect(mocks.session).toHaveBeenCalledTimes(2)
  expect(mocks.image).toHaveBeenCalledTimes(2)
  const firstImage = mocks.session.mock.calls[0][0].customTools[2]
  const secondImage = mocks.session.mock.calls[1][0].customTools[2]
  expect(secondImage).not.toBe(firstImage)
  expect(mocks.auth).not.toHaveBeenCalled()
  await expect(factory({ ...target, cwd: resolve('other-project') })).rejects.toThrow(/跨项目/)
  await expect(factory({ ...target, sessionManager: { ...target.sessionManager, getCwd: () => resolve('other-project') } })).rejects.toThrow(/跨项目/)
  expect(mocks.image).toHaveBeenCalledTimes(2)
})

it('captures each backend’s own model runtime and only resolves Codex OAuth when the image tool executes', async () => {
  await createPionRuntime(['--mode', 'rpc', '--approve'], cwd)
  const [factory, target] = mocks.runtime.mock.calls[0]
  const nextAuth = vi.fn().mockResolvedValue(undefined)
  const services = await mocks.services.mock.results[0].value
  mocks.services.mockResolvedValue({ ...services, modelRuntime: { getAuth: nextAuth } })
  await factory({ ...target, sessionStartEvent: { reason: 'resume' } })
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(nextAuth).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  await mocks.session.mock.calls[0][0].customTools[2].execute(signal)
  expect(mocks.auth).toHaveBeenCalledWith('openai-codex', { signal, minOAuthValidityMs: 300_000 })
  expect(nextAuth).not.toHaveBeenCalled()
  await mocks.session.mock.calls[1][0].customTools[2].execute(signal)
  expect(nextAuth).toHaveBeenCalledWith('openai-codex', { signal, minOAuthValidityMs: 300_000 })
  expect(mocks.auth).toHaveBeenCalledTimes(1)
})

it('rejects a stored session from another project before creating services or tools', async () => {
  mocks.open.mockReturnValue({ getCwd: () => resolve('other-project') })
  await expect(createPionRuntime(['--mode', 'rpc', '--session', 'foreign.jsonl'], cwd)).rejects.toThrow('不匹配')
  expect(mocks.services).not.toHaveBeenCalled()
  expect(mocks.image).not.toHaveBeenCalled()
  expect(mocks.auth).not.toHaveBeenCalled()
})
