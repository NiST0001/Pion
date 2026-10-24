import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcClient } from '@earendil-works/pi-coding-agent'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { BackendPool } from '../../src/main/agent/backend-pool'
import { PendingRequestStore } from '../../src/main/agent/pending-requests'
import { newBackendCapabilityState, readCapabilityRuntimeNotice, type CapabilityCommands } from '../../src/main/agent/capability-state'
import type { BackendRecord } from '../../src/main/agent/types'
import { CapabilitySettingsStore } from '../../src/main/capability-settings'
import { readCapabilityResources } from '../../src/main/capability-catalogue'
import { RunStore } from '../../src/main/run-store'
import { CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_SOURCE, capabilityEnabled, type CapabilityPreferences, type CapabilityItem, type CapabilityRuntimeNotice } from '../../src/shared/capability-settings'

vi.mock('../../src/main/capability-catalogue', () => ({
  readCapabilityResources: vi.fn(async (options: { preferences: CapabilityPreferences; runtimeItems?: CapabilityItem[] }) => ({
    catalogueRevision: 'a'.repeat(64), notices: ['动态能力仍可能未知。'],
    items: [{ id: 'tool:read', kind: 'tool', name: 'read', label: 'read', description: 'Pi', origin: 'pi', available: true,
      enabled: capabilityEnabled(options.preferences, 'tool:read', 'tool') },
    { id: 'tool:pion_subagents', kind: 'subagent', name: 'pion_subagents', label: '子代理', description: 'Pion', origin: 'pion', available: true,
      enabled: capabilityEnabled(options.preferences, 'tool:pion_subagents', 'subagent') }, ...(options.runtimeItems ?? []).filter(item => item.id === 'tool:dynamic')
      .map(item => ({ ...item, enabled: capabilityEnabled(options.preferences, item.id, item.kind, item.enabled) }))],
    extensionPaths: ['/private/extension'], skillPaths: ['/private/skill'], promptPaths: ['/private/prompt'], themePaths: ['/private/theme']
  }))
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
async function gap() { for (let i = 0; i < 30; i++) await Promise.resolve() }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function harness(persisted = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'pion-capability-bridge-'))
  roots.push(cwd)
  const store = new CapabilitySettingsStore(join(cwd, 'capabilities.json'))
  await store.get()
  const path = join(cwd, 'allocated-not-persisted.jsonl')
  if (persisted) await writeFile(path, '{}\n')
  const plan = join(cwd, 'pion-plan-mode-extension.ts')
  const state = { sessionId: 'original', sessionFile: path, sessionName: undefined as string | undefined, isStreaming: false, isCompacting: false,
    messageCount: persisted ? 2 : 0, pendingMessageCount: 0, thinkingLevel: 'high',
    model: { provider: 'exact-provider', id: 'exact-model' }, steeringMode: 'all', followUpMode: 'one-at-a-time', autoCompactionEnabled: true }
  let runtime = 'runtime-0'
  let revision = 0
  let subagents = true
  let listener: (event: unknown) => void = () => undefined
  const order: string[] = []
  const notice = (): CapabilityRuntimeNotice => ({ version: 1, revision, runtimeId: runtime, cwd,
    sessionPath: state.sessionFile, subagentsEnabled: subagents, notices: [], items: capabilityEnabled(store.getSnapshot()!, 'extension:dynamic', 'extension')
      ? [{ id: 'tool:dynamic', kind: 'tool', name: 'dynamic', label: '动态工具', description: '动态', origin: 'extension', enabled: true, available: true }] : [] })
  const command = (name: string, path: string, description = '') => ({ name, description, source: 'extension',
    sourceInfo: { path, source: path.startsWith('<inline:') ? 'inline' : 'cli', scope: 'temporary', origin: 'top-level' } })
  const commands = () => [command(CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_SOURCE, JSON.stringify(notice())),
    command('plan', plan), command('pion-subagents', '<inline:pion-subagents>')] as CapabilityCommands
  const replace = async () => {
    order.push('replace')
    runtime = `runtime-${store.getSnapshot()!.revision}`
    revision = store.getSnapshot()!.revision
    subagents = capabilityEnabled(store.getSnapshot()!, 'tool:pion_subagents', 'subagent')
    return { cancelled: false }
  }
  const client = {
    // Use the real pinned decoder: generic mocked Error messages are NOT SDK
    // negative response receipts and must remain unknown/quarantined.
    getData: (RpcClient.prototype as unknown as { getData(response: unknown): unknown }).getData,
    getState: vi.fn(async () => ({ ...state, model: { ...state.model } })), getCommands: vi.fn(async () => commands()),
    switchSession: vi.fn(replace), newSession: vi.fn(async () => {
      const result = await replace()
      state.sessionId = 'fresh-id'
      state.sessionFile = join(cwd, 'fresh-allocated.jsonl')
      state.sessionName = undefined
      state.model = { provider: 'default', id: 'default' }
      state.thinkingLevel = 'off'
      return result
    }),
    prompt: vi.fn(async (message: string): Promise<'handled' | 'started'> => {
      order.push(message)
      if (message === '/pion-subagents off') subagents = false
      return message.startsWith('/') ? 'handled' : 'started'
    }),
    steer: vi.fn(async () => 'queued'), setModel: vi.fn(async (provider: string, id: string) => { state.model = { provider, id }; return { provider, id } }),
    setThinkingLevel: vi.fn(async (value: string) => { state.thinkingLevel = value }),
    setSessionName: vi.fn(async (value: string) => { state.sessionName = value }), compact: vi.fn(async () => undefined),
    setSteeringMode: vi.fn(), setFollowUpMode: vi.fn(), setAutoCompaction: vi.fn(),
    onEvent: vi.fn((callback: (event: unknown) => void) => { listener = callback })
  }
  const backend = { key: 'retained-backend', cwd, sessionPath: path, client, phase: 'running', busy: false, compacting: false,
    modePrimed: 'build', subagentsEnabled: true, pendingRunIds: [], localFollowUps: [], queueAutoReady: true,
    startPromise: Promise.resolve(), capability: { ...newBackendCapabilityState(0), state: 'applied', appliedRevision: 0,
      planCommandPath: plan, notice: notice(), commands: commands() } } as unknown as BackendRecord
  const pool = new BackendPool()
  pool.add(backend)
  const runStore = new RunStore(join(cwd, 'runs.json'))
  const frame = {}
  // White-box harness: actual Bridge methods and event adapter, only RPC and
  // metadata/trust/history readers mocked; never launch a real SDK/MCP/model.
  const bridge = Object.assign(Object.create(AgentBridge.prototype), {
    backendPool: pool, runStore, activeKey: backend.key, activeCwd: cwd, activeSessionPath: path,
    sessionSelectionGeneration: 0, historyRevision: 0, sessionOperationsInFlight: 0,
    backendKeysBySessionPath: new Map([[path, backend.key]]), desiredModes: new Map([[backend.key, 'build']]),
    yoloSessions: new Set(), unreadSessionPaths: new Set(), sessionCompletedListeners: new Set(), runCompletedListeners: new Set(),
    pendingRequests: new PendingRequestStore({ pushToolPermissionRequests() {}, pushExtensionUiRequests() {} }),
    win: { webContents: { id: 7, mainFrame: frame, send: vi.fn() } }, status: { phase: 'ready', cwd },
    ensureActiveBackend: vi.fn(async () => backend), syncBackendSession: vi.fn(async () => undefined),
    pushSessionInfo: vi.fn(async () => undefined), refreshSidebarSessions: vi.fn(async () => undefined),
    pushRunningSessionPaths: vi.fn(), pushRunCheckpoint: vi.fn(), setActiveBackendStatus: vi.fn(),
    getProjectTrust: vi.fn(() => ({ cwd, requiresTrust: false, decision: 'trusted', source: 'not-required' })),
    openSessionManager: vi.fn(() => ({ getCwd: () => cwd, getSessionId: () => 'original' })),
    refreshRunCheckpoint: vi.fn(async () => null)
  })
  bridge.configureCapabilitySettings(store)
  bridge.attachBackendEvents(backend)
  const emit = (type: string, extra: Record<string, unknown> = {}) => listener({ type, ...extra })
  const save = async (change: { type: 'preset'; preset: 'minimal' | 'standard' | 'no-skills' } = { type: 'preset', preset: 'standard' }) => {
    await store.update(store.getSnapshot()!.revision, change, [])
    await gap()
  }
  const waitApply = async () => {
    await gap()
    if (backend.capability?.applyPromise) await backend.capability.applyPromise.catch(() => undefined)
    await gap()
  }
  const negative = (command: string, error: string): never => {
    client.getData({ type: 'response', id: 'req_1', command, success: false, error })
    throw new Error('Expected the SDK decoder to reject the negative response')
  }
  return { bridge, backend, pool, client, state, store, cwd, path, notice, commands, save, emit, waitApply, order, runStore, negative }
}

describe('capability Bridge read and source receipts', () => {
  it('reads only existing getCommands, hides the private command and never reloads from a getter', async () => {
    const h = await harness()
    const result = await h.bridge.getCapabilitySettings(h.cwd)
    expect(result.application.state).toBe('applied')
    expect(result.items.some((item: CapabilityItem) => item.id === 'tool:dynamic')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('/private/')
    expect((await h.bridge.getCommands()).some((item: { name: string }) => item.name === CAPABILITY_RUNTIME_COMMAND)).toBe(false)
    expect(h.client.switchSession).not.toHaveBeenCalled()
    expect(h.client.newSession).not.toHaveBeenCalled()
    expect(h.client.prompt).not.toHaveBeenCalled()
    h.pool.delete(h.backend.key)
    const global = await h.bridge.getCapabilitySettings()
    expect(global.application.state).toBe('no-backend')
    expect(global.items.some((item: CapabilityItem) => item.id === 'tool:dynamic')).toBe(false)
    expect(h.bridge.ensureActiveBackend).not.toHaveBeenCalled()
  })

  it('rechecks the desired/catalogue revisions and refuses unknown slots before saving', async () => {
    const h = await harness()
    h.backend.busy = true
    const request = { cwd: h.cwd, expectedRevision: 0, catalogueRevision: 'a'.repeat(64),
      change: { type: 'toggle', id: 'tool:not-registered', enabled: true } }
    await expect(h.bridge.updateCapabilitySettings(request)).rejects.toThrow('目录')
    await expect(h.bridge.updateCapabilitySettings({ ...request, catalogueRevision: 'b'.repeat(64) })).rejects.toThrow('变更')
    expect((await h.store.get()).revision).toBe(0)
    expect(h.client.newSession).not.toHaveBeenCalled()
    expect(h.client.switchSession).not.toHaveBeenCalled()
  })

  it('keeps verified dynamic slots after their extension is disabled, without overriding desired false or another source', async () => {
    const h = await harness()
    expect((await h.bridge.getCapabilitySettings(h.cwd)).items.find((item: CapabilityItem) => item.id === 'tool:dynamic')).toMatchObject({ enabled: true })
    await h.save({ type: 'preset', preset: 'minimal' })
    await h.waitApply()
    expect(h.backend.capability?.notice?.items).toEqual([])
    const off = await h.bridge.getCapabilitySettings(h.cwd)
    expect(off.items.find((item: CapabilityItem) => item.id === 'tool:dynamic')).toMatchObject({ enabled: false, available: false })
    const toggled = await h.bridge.updateCapabilitySettings({ cwd: h.cwd, expectedRevision: off.revision,
      catalogueRevision: off.catalogueRevision, change: { type: 'toggle', id: 'tool:dynamic', enabled: true } })
    expect(toggled.items.find((item: CapabilityItem) => item.id === 'tool:dynamic')?.enabled).toBe(true)
    await h.waitApply()
    const catalogue = vi.mocked(readCapabilityResources)
    const original = catalogue.getMockImplementation()!
    const changedSource = async (options: Parameters<typeof readCapabilityResources>[0]) => ({ ...await original(options), catalogueRevision: 'b'.repeat(64) })
    catalogue.mockImplementationOnce(changedSource).mockImplementationOnce(changedSource)
    expect((await h.bridge.getCapabilitySettings(h.cwd)).items.some((item: CapabilityItem) => item.id === 'tool:dynamic')).toBe(false)
    const replacementClient = { ...h.client }
    h.backend.client = replacementClient as unknown as BackendRecord['client']
    expect((await h.bridge.getCapabilitySettings(h.cwd)).items.some((item: CapabilityItem) => item.id === 'tool:dynamic')).toBe(false)
  })

  it('rejects wrong command source, old runtime, wrong cwd/revision and late owner', async () => {
    const h = await harness()
    const commands = h.commands()
    const scope = { cwd: h.cwd, sessionPath: h.path, revision: 0 }
    expect(() => readCapabilityRuntimeNotice([{ ...commands[0], sourceInfo: { ...commands[0].sourceInfo, path: '/fake.ts' } }], scope)).toThrow()
    expect(() => readCapabilityRuntimeNotice(commands, { ...scope, revision: 1 })).toThrow()
    expect(() => readCapabilityRuntimeNotice(commands, { ...scope, cwd: '/wrong' })).toThrow()
    expect(() => readCapabilityRuntimeNotice(commands, { ...scope, retiredRuntimeIds: ['runtime-0'] })).toThrow()
    const pending = deferred<CapabilityCommands>()
    h.client.getCommands.mockReturnValueOnce(pending.promise)
    const reading = h.bridge.getCapabilitySettings(h.cwd)
    await gap()
    h.bridge.win = { webContents: { id: 8, mainFrame: {}, send: vi.fn() } }
    pending.resolve(commands)
    await expect(reading).rejects.toThrow('窗口')
    expect(h.client.newSession).not.toHaveBeenCalled()
  })
})

describe('capability Bridge control rejection receipts', () => {
  it.each(['Model not found: missing/model', 'No API key for missing/model'])('does not quarantine the confirmed SDK business negative: %s', async (message) => {
    const h = await harness()
    const pending = deferred<void>()
    h.client.setModel.mockImplementationOnce(async () => { await pending.promise; return h.negative('set_model', message) })
    const changing = h.bridge.setModel('missing', 'model')
    const rejected = expect(changing).rejects.toThrow(message)
    await gap()
    expect(h.backend.controlDispatchPromises?.size).toBe(1)
    pending.resolve()
    await rejected
    expect(h.backend.controlDispatchPromises?.size).toBe(0)
    expect(h.backend.capability?.quarantined).not.toBe(true)
    await h.save()
    await h.waitApply()
    expect(h.backend.capability?.state).toBe('applied')
  })

  it('does not lock the project after the SDK rejects an empty idle compaction', async () => {
    const h = await harness()
    h.client.compact.mockImplementationOnce(async () => h.negative('compact', 'Nothing to compact (session too small)'))
    await expect(h.bridge.compactNow()).rejects.toThrow('Nothing to compact')
    expect(h.backend.controlDispatchPromises?.size).toBe(0)
    expect(h.backend.capability?.quarantined).not.toBe(true)
  })

  it.each(['unbranded-known', 'transport', 'sdk-unknown'])('keeps an unknown invoked failure quarantined (%s)', async (kind) => {
    const h = await harness()
    h.client.setModel.mockImplementationOnce(async () => {
      if (kind === 'sdk-unknown') return h.negative('set_model', 'Unknown runtime cleanup failure')
      throw new Error(kind === 'transport' ? 'Timeout waiting for response to set_model' : 'Model not found: missing/model')
    })
    await expect(h.bridge.setModel('missing', 'model')).rejects.toThrow()
    expect(h.backend.controlDispatchPromises?.size).toBe(0)
    expect(h.backend.capability?.quarantined).toBe(true)
    await h.save()
    await h.waitApply()
    expect(h.client.newSession).not.toHaveBeenCalled()
  })
})

describe('capability Bridge true-idle application', () => {
  it('saves while busy and waits for settle, prompt RPC AND completion listener before replacing ahead of FIFO', async () => {
    const h = await harness(true)
    const rpc = deferred<'started'>()
    const completion = deferred<void>()
    h.bridge.runCompletedListeners.add(() => completion.promise)
    h.client.prompt.mockImplementationOnce(() => rpc.promise)
    const sending = h.bridge.send('active input')
    await gap()
    h.emit('agent_start')
    const queued = h.bridge.createRun(h.backend, null, 'queued input', [], 'follow-up', 'queued')
    h.backend.localFollowUps!.push({ runId: queued.id, text: 'queued input', images: [] })
    await h.save()
    expect(h.backend.capability?.state).toBe('pending')
    expect(h.client.switchSession).not.toHaveBeenCalled()
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] })
    h.emit('agent_settled')
    await gap()
    expect(h.client.switchSession).not.toHaveBeenCalled()
    rpc.resolve('started')
    await sending
    await gap()
    expect(h.client.switchSession).not.toHaveBeenCalled()
    completion.resolve()
    await h.waitApply()
    expect(h.client.switchSession).toHaveBeenCalledWith(h.path)
    expect(h.client.newSession).not.toHaveBeenCalled()
    expect(h.backend.capability?.state).toBe('applied')
    expect(h.order.indexOf('replace')).toBeLessThan(h.order.indexOf('queued input'))
    expect(h.client.prompt.mock.calls.filter(([text]) => text === 'queued input')).toHaveLength(1)
    await h.runStore.flush()
  })

  it('sends an explicitly admitted first idle input after applying without inventing a settle receipt', async () => {
    const h = await harness()
    h.backend.queueAutoReady = false
    h.backend.capability!.requestedRevision = 1
    h.backend.capability!.state = 'pending'
    // Hold the save's application until its actual write is committed, then
    // exercise the explicit input admission rather than automatic queue readiness.
    h.backend.busy = true
    await h.save()
    h.backend.busy = false
    await h.bridge.send('first idle input')
    await h.waitApply()
    expect(h.client.newSession).toHaveBeenCalledTimes(1)
    expect(h.client.prompt.mock.calls.filter(([text]) => text === 'first idle input')).toHaveLength(1)
    expect(h.order.indexOf('replace')).toBeLessThan(h.order.indexOf('first idle input'))
    expect(h.backend.capability?.idleInputRunId).toBeUndefined()
    await h.runStore.flush()
  })

  it('does not resume an unknown RPC merely because busy becomes false or a getter polls', async () => {
    const h = await harness()
    h.backend.busy = true
    h.backend.capability!.runPending = true
    await h.save()
    h.backend.busy = false // logical stop/idle is not a positive settle receipt
    await h.bridge.getCapabilitySettings(h.cwd)
    await gap()
    expect(h.client.newSession).not.toHaveBeenCalled()
    expect(h.backend.capability?.state).toBe('pending')
  })

  it('uses newSession for an allocated missing file and restores exact model/thinking, mode and off preference', async () => {
    const h = await harness()
    h.backend.subagentsEnabled = false
    h.backend.modePrimed = 'plan'
    h.state.sessionName = '保留的空会话名称'
    const preferences = new Map([[h.path, { provider: 'older-provider', modelId: 'older-model' }]])
    const modelPreferences = {
      getSessionModel: vi.fn((path: string) => preferences.get(path)),
      setSessionModel: vi.fn(async (path: string, preference: { provider: string; modelId: string }) => { preferences.set(path, preference) }),
      deleteSessionModel: vi.fn()
    }
    h.bridge.sessionModelPreferences = modelPreferences
    h.bridge.desiredModes.set(h.backend.key, 'plan')
    await h.save()
    await h.waitApply()
    expect(h.client.switchSession).not.toHaveBeenCalled()
    expect(h.client.newSession).toHaveBeenCalledTimes(1)
    expect(h.client.setModel).toHaveBeenCalledWith('exact-provider', 'exact-model')
    expect(h.client.setThinkingLevel).toHaveBeenCalledWith('high')
    expect(h.client.setSessionName).toHaveBeenCalledWith('保留的空会话名称')
    expect(h.state.sessionName).toBe('保留的空会话名称')
    expect(modelPreferences.setSessionModel).toHaveBeenCalledWith(h.state.sessionFile, { provider: 'exact-provider', modelId: 'exact-model' })
    expect(preferences.get(h.path)).toEqual({ provider: 'older-provider', modelId: 'older-model' })
    expect(modelPreferences.deleteSessionModel).not.toHaveBeenCalled()
    expect(h.bridge.activeSessionPath).toBe(h.state.sessionFile)
    expect(h.bridge.backendKeysBySessionPath.get(h.state.sessionFile)).toBe(h.backend.key)
    expect(h.client.prompt).toHaveBeenCalledWith('/plan start')
    expect(h.client.prompt).toHaveBeenCalledWith('/pion-subagents off')
    expect(h.backend.subagentsEnabled).toBe(false)
    expect(h.bridge.activeKey).toBe('retained-backend')
    expect(h.backend.capability?.appliedRevision).toBe(1)
    expect(h.backend.capability?.notice?.runtimeId).toBe('runtime-1')
  })

  it.each([false, true])('keeps a cancelled replacement runtime readable and retries only an explicit change (persisted=%s)', async (persisted) => {
    const h = await harness(persisted)
    await h.bridge.getCapabilitySettings(h.cwd)
    const oldNotice = h.backend.capability!.notice
    const oldCommands = h.backend.capability!.commands
    const oldCatalogue = h.backend.capability!.catalogue
    if (persisted) h.client.switchSession.mockResolvedValueOnce({ cancelled: true })
    else h.client.newSession.mockResolvedValueOnce({ cancelled: true })
    await h.save()
    await h.waitApply()
    expect(h.backend.capability).toMatchObject({ state: 'failed', appliedRevision: 0, retiredRuntimeIds: [] })
    expect(h.backend.capability?.quarantined).not.toBe(true)
    expect(h.backend.capability?.notice).toBe(oldNotice)
    expect(h.backend.capability?.commands).toBe(oldCommands)
    expect(h.backend.capability?.catalogue).toBe(oldCatalogue)
    expect(h.backend.sessionPath).toBe(h.path)
    expect(h.state.sessionId).toBe('original')
    const current = await h.bridge.getCapabilitySettings(h.cwd)
    expect(current.items.some((item: CapabilityItem) => item.id === 'tool:dynamic')).toBe(true)
    await h.waitApply()
    expect(h.client.switchSession.mock.calls.length + h.client.newSession.mock.calls.length).toBe(1)
    await h.save()
    await h.waitApply()
    expect(h.backend.capability).toMatchObject({ state: 'applied', appliedRevision: 2 })
  })

  it('does not query an application intermediate or let a late old read/finally replace the fresh epoch query', async () => {
    const h = await harness(true)
    expect(await h.bridge.getSessionInfo()).toMatchObject({ modelId: 'exact-model' })
    const late = deferred<typeof h.state>()
    h.client.getState.mockReturnValueOnce(late.promise)
    const oldRead = h.bridge.getSessionInfo()
    await gap()
    const replace = h.client.switchSession.getMockImplementation()!
    h.client.switchSession.mockImplementationOnce(async () => {
      const result = await replace()
      h.state.model = { provider: 'default', id: 'default' }
      h.state.thinkingLevel = 'off'
      return result
    })
    const restoring = deferred<void>()
    const restore = deferred<void>()
    h.client.setModel.mockImplementationOnce(async (provider, id) => {
      restoring.resolve()
      await restore.promise
      h.state.model = { provider, id }
      return { provider, id }
    })
    await h.save()
    await restoring.promise
    const duringCount = h.client.getState.mock.calls.length
    expect(await h.bridge.getSessionInfo()).toMatchObject({ modelId: 'exact-model', thinkingLevel: 'high' })
    expect(h.client.getState).toHaveBeenCalledTimes(duringCount)
    restore.resolve()
    await h.waitApply()
    const fresh = deferred<typeof h.state>()
    h.client.getState.mockReturnValueOnce(fresh.promise)
    const count = h.client.getState.mock.calls.length
    const freshRead = h.bridge.getSessionInfo()
    await gap()
    expect(h.client.getState).toHaveBeenCalledTimes(count) // old actual RPC still owns the chain
    late.resolve({ ...h.state, model: { provider: 'stale', id: 'stale' } })
    expect(await oldRead).toBeNull()
    await gap()
    const secondRead = h.bridge.getSessionInfo()
    await gap()
    expect(h.client.getState).toHaveBeenCalledTimes(count + 1) // old finally did not free the new query
    fresh.resolve({ ...h.state, model: { ...h.state.model } })
    expect(await freshRead).toMatchObject({ modelId: 'exact-model', thinkingLevel: 'high' })
    expect(await secondRead).toMatchObject({ modelId: 'exact-model', thinkingLevel: 'high' })
    expect(h.bridge.sessionInfoSnapshots.get(h.backend).info.modelId).toBe('exact-model')
  })

  it('rejects an old-runtime acknowledgement after replacement and leaves the saved revision unapplied', async () => {
    const h = await harness(true)
    const old = h.commands()
    h.client.getCommands.mockResolvedValue(old)
    await h.save()
    await h.waitApply()
    expect(h.backend.capability).toMatchObject({ state: 'failed', appliedRevision: 0, quarantined: true })
    expect(h.client.switchSession).toHaveBeenCalledTimes(1)
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('retains the real apply promise and isolates replacement failure instead of claiming applied or retrying', async () => {
    const h = await harness(true)
    const replacement = deferred<{ cancelled: boolean }>()
    h.client.switchSession.mockReturnValueOnce(replacement.promise)
    await h.save()
    await gap()
    expect(h.backend.capability?.applyPromise).toBeDefined()
    await expect(h.bridge.newSession()).rejects.toThrow('应用')
    expect(h.client.prompt).not.toHaveBeenCalled()
    replacement.reject(new Error('RPC timeout; actual shutdown unknown'))
    await h.waitApply()
    expect(h.backend.capability).toMatchObject({ state: 'failed', appliedRevision: 0, quarantined: true })
    await h.save()
    await h.bridge.getCapabilitySettings(h.cwd)
    await h.waitApply()
    expect(h.client.switchSession).toHaveBeenCalledTimes(1)
    expect(h.backend.capability?.state).toBe('failed')
  })

  it('keeps presets one-shot and global subagents separate from the session preference', async () => {
    const h = await harness()
    h.backend.busy = true
    await h.save({ type: 'preset', preset: 'minimal' })
    expect(h.backend.subagentsEnabled).toBe(true)
    await h.store.update(1, { type: 'toggle', id: 'tool:pion_subagents', enabled: true }, [{ id: 'tool:pion_subagents', kind: 'subagent' } as CapabilityItem])
    expect(capabilityEnabled(await h.store.get(), 'tool:pion_subagents', 'subagent')).toBe(true)
    expect(capabilityEnabled(await h.store.get(), 'tool:other', 'tool')).toBe(false)
    expect(Object.keys(await h.store.get())).not.toContain('mode')
    expect(h.client.newSession).not.toHaveBeenCalled()
  })
})
