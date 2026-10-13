import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerComputerUseIpc } from '../../src/main/ipc/computer-use'
import { ComputerUseService } from '../../src/main/computer-use/service'
import { WaylandComputerUseDriver } from '../../src/main/computer-use/wayland-driver'
import { IPC, IPC_EVENTS } from '../../src/shared/ipc'
import { createDisabledComputerUseStatus, type ComputerUseOwner, type ComputerUseStatus } from '../../src/shared/computer-use'
import { makeStaticPng } from '../fixtures/static-png'

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: electron }))

type CaptureResult = { state: ComputerUseStatus; png: Uint8Array; previewPng?: Uint8Array }
function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  let ownerId: number | undefined = 7
  let destroyed = false
  const mainFrame = {}
  const sender = { id: 7, mainFrame, isDestroyed: () => destroyed }
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const owner: ComputerUseOwner = { ownerWindowId: 7, backendId: 'local-preview', runtimeId: 'local-preview', runId: 'local-preview-1', generation: 1 }
  let state = createDisabledComputerUseStatus()
  const snapshot = () => structuredClone(state)
  const service = {
    // Real getState returns fresh validated metadata, not the mutable broker state.
    getState: vi.fn(snapshot), start: vi.fn(async () => snapshot()),
    capture: vi.fn(async (): Promise<CaptureResult> => ({ state: snapshot(), png: new Uint8Array(8 * 1024 * 1024).fill(0xa5) })),
    stop: vi.fn(async () => snapshot())
  }
  const createLocalOwner = vi.fn(() => owner)
  registerComputerUseIpc({ ipcMain: { handle: (channel, handler) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel, handler) } } as Pick<IpcMain, 'handle'>, service, getMainWindowId: () => ownerId, createLocalOwner, getLocalOwner: () => owner })
  return {
    service, get state() { return snapshot() }, event, owner, createLocalOwner,
    setState: (value: ComputerUseStatus) => { state = structuredClone(value) },
    invoke: (channel: string, e = event, ...args: unknown[]) => handlers.get(channel)!(e, ...args),
    destroy: () => { destroyed = true }, replace: () => { ownerId = 9 }, removeWindow: () => { ownerId = undefined },
    navigate: () => { sender.mainFrame = {} }
  }
}
const consent = { capture: true, upload: false, retention: 'sdk-session', control: false }
function capturedState(): ComputerUseStatus {
  return {
    ...createDisabledComputerUseStatus(), state: 'ready',
    frame: { id: 'frame-1', width: 800, height: 600, createdAt: 1, scopeRevision: 0, captureScope: 'window', actualScope: 'window' }
  }
}
function projected(state: ComputerUseStatus): ComputerUseStatus {
  const result = structuredClone(state)
  delete result.owner
  delete result.receipt
  return result
}

describe('ComputerUse local owner IPC (no OS)', () => {
  it.each([IPC.ComputerUseGetState, IPC.ComputerUseStart, IPC.ComputerUseCapture, IPC.ComputerUseStop])('rejects secondary frames, guests and destroyed senders independently: %s', async channel => {
    const h = harness()
    const args = channel === IPC.ComputerUseStart ? [consent] : channel === IPC.ComputerUseCapture ? [{ scopeRevision: 0 }] : []
    for (const event of [{ ...h.event, senderFrame: {} }, { ...h.event, sender: { ...h.event.sender, id: 8 } }, { ...h.event, senderFrame: null }]) {
      await expect(Promise.resolve().then(() => h.invoke(channel, event as IpcMainInvokeEvent, ...args))).rejects.toThrow('owner')
    }
    h.destroy()
    await expect(Promise.resolve().then(() => h.invoke(channel, h.event, ...args))).rejects.toThrow('owner')
    expect(h.service.start).not.toHaveBeenCalled()
    expect(h.service.capture).not.toHaveBeenCalled()
    expect(h.service.stop).not.toHaveBeenCalled()
    expect(h.service.getState).not.toHaveBeenCalled()
  })
  it('queries only cached metadata and never falls back to Agent/OS', () => {
    const h = harness()
    expect(h.invoke(IPC.ComputerUseGetState)).toEqual(h.state)
    expect(h.service.getState).toHaveBeenCalledOnce()
    expect(h.service.start).not.toHaveBeenCalled()
    expect(h.service.capture).not.toHaveBeenCalled()
    expect(h.createLocalOwner).not.toHaveBeenCalled()
  })
  it('constructing the service/driver and reading inactive status never spawns or probes', () => {
    const spawn = vi.fn(() => { throw new Error('unexpected helper execution') })
    const factory = vi.fn(() => new WaylandComputerUseDriver('/explicit/project/helper', spawn))
    const publish = vi.fn(), clock = vi.fn(() => 1), randomId = vi.fn(() => 'id-1')
    new WaylandComputerUseDriver('/explicit/project/helper', spawn)
    const service = new ComputerUseService({ driverFactory: factory, publish, clock, randomId })
    expect(service.getState()).toEqual(createDisabledComputerUseStatus())
    service.getState().budget.captures = 80
    expect(service.getState().budget.captures).toBe(0)
    for (const callback of [spawn, factory, publish, clock, randomId]) expect(callback).not.toHaveBeenCalled()
    // Read the buddy source only: do not execute the helper, shell or main entry.
    const helper = readFileSync(new URL('../../src/main/computer-use/helper-client.ts', import.meta.url), 'utf8')
    expect(helper).toContain("spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })")
    const driver = readFileSync(new URL('../../src/main/computer-use/wayland-driver.ts', import.meta.url), 'utf8')
    expect(driver).toContain('constructor(private readonly binary: string, private readonly start?: HelperSpawn) {}')
  })
  it('accepts only explicit local capture consent, host-generates identity', async () => {
    const h = harness()
    for (const invalid of [{ ...consent, upload: true }, { ...consent, control: true }, { ...consent, capture: false }, { ...consent, owner: h.owner }, { ...consent, backendId: 'spoof' }]) await expect(h.invoke(IPC.ComputerUseStart, h.event, invalid)).rejects.toThrow()
    await h.invoke(IPC.ComputerUseStart, h.event, consent)
    expect(h.service.start).toHaveBeenCalledExactlyOnceWith(h.owner, consent)
  })
  it.each([IPC.ComputerUseGetState, IPC.ComputerUseStart, IPC.ComputerUseCapture, IPC.ComputerUseStop])('strips host owner and receipt without mutating service metadata: %s', async channel => {
    const h = harness()
    const state = { ...capturedState(), owner: h.owner, receipt: { requestId: 'request-1', actionId: 'action-1', toolCallId: 'tool-1', frameId: 'frame-1', scopeRevision: 0, status: 'executed' as const, actualPending: false } }
    h.setState(state)
    const result = await h.invoke(channel, h.event, ...(channel === IPC.ComputerUseStart ? [consent] : channel === IPC.ComputerUseCapture ? [{ scopeRevision: 0 }] : []))
    expect(result).toEqual(channel === IPC.ComputerUseCapture ? { state: projected(state), previewUnavailable: 'thumbnail-not-supported' } : projected(state))
    expect(h.state).toEqual(state)
  })
  it('requires exact scope revision, returns metadata not original 8 MiB bytes when preview is missing', async () => {
    const h = harness()
    h.setState(capturedState())
    for (const invalid of [undefined, { scopeRevision: 1 }, { scopeRevision: 0, path: '/tmp/raw.png' }, { scopeRevision: 0, owner: h.owner }]) await expect(h.invoke(IPC.ComputerUseCapture, h.event, invalid)).rejects.toThrow()
    const result = await h.invoke(IPC.ComputerUseCapture, h.event, { scopeRevision: 0 })
    expect(result).toEqual({ state: h.state, previewUnavailable: 'thumbnail-not-supported' })
    expect(h.service.capture).toHaveBeenCalledExactlyOnceWith(h.owner)
  })
  it.each([[1, 1], [512, 512]])('returns only independent real %sx%s display PNG bytes as a data URL', async (width, height) => {
    const h = harness()
    const state = capturedState()
    h.setState(state)
    const previewPng = Uint8Array.from(makeStaticPng(width, height))
    const png = Uint8Array.from(makeStaticPng(800, 600))
    const expected = Buffer.from(previewPng)
    expect(expected).not.toEqual(Buffer.from(png))
    h.service.capture.mockResolvedValueOnce({ state: structuredClone(state), png, previewPng })
    const result = await h.invoke(IPC.ComputerUseCapture, h.event, { scopeRevision: 0 }) as { state: ComputerUseStatus; preview: string }
    expect(Object.keys(result).sort()).toEqual(['preview', 'state'])
    expect(result.state).toEqual(state)
    expect(result.preview).toBe(`data:image/png;base64,${expected.toString('base64')}`)
    const copied = Buffer.from(result.preview.slice('data:image/png;base64,'.length), 'base64')
    expect(copied).toEqual(expected)
    expect(copied).not.toEqual(Buffer.from(png))
    expect(copied.readUInt32BE(16)).toBe(width)
    expect(copied.readUInt32BE(20)).toBe(height)
    expect(copied.byteLength).toBeLessThanOrEqual(96 * 1024)
    png.fill(0)
    previewPng.fill(0)
    expect(Buffer.from(result.preview.slice('data:image/png;base64,'.length), 'base64')).toEqual(expected)
  })
  it('never substitutes the small real model PNG when there is no independent preview', async () => {
    const h = harness()
    const state = capturedState()
    h.setState(state)
    h.service.capture.mockResolvedValueOnce({ state, png: Uint8Array.from(makeStaticPng()) })
    expect(await h.invoke(IPC.ComputerUseCapture, h.event, { scopeRevision: 0 })).toEqual({ state, previewUnavailable: 'thumbnail-not-supported' })
  })
  it.each(['bytes', 'short', 'signature', 'IHDR', 'IHDR-length', 'width513', 'height513', 'width0', 'height0'] as const)('rejects supplied preview %s, never falling back to the model PNG', async kind => {
    const h = harness()
    const state = capturedState()
    h.setState(state)
    let preview: Buffer = Buffer.from(makeStaticPng())
    if (kind === 'bytes') preview = Buffer.concat([preview, Buffer.alloc(96 * 1024 + 1 - preview.length)])
    if (kind === 'short') preview = preview.subarray(0, 56)
    if (kind === 'signature') preview[0] = 0
    if (kind === 'IHDR') preview.write('IDAT', 12, 'ascii')
    if (kind === 'IHDR-length') preview.writeUInt32BE(12, 8)
    if (kind === 'width513') preview = makeStaticPng(513, 1)
    if (kind === 'height513') preview = makeStaticPng(1, 513)
    if (kind === 'width0') preview.writeUInt32BE(0, 16)
    if (kind === 'height0') preview.writeUInt32BE(0, 20)
    h.service.capture.mockResolvedValueOnce({ state, png: Uint8Array.from(makeStaticPng()), previewPng: Uint8Array.from(preview) })
    const returned = vi.fn()
    await expect(Promise.resolve(h.invoke(IPC.ComputerUseCapture, h.event, { scopeRevision: 0 })).then(returned)).rejects.toThrow('preview unavailable')
    expect(returned).not.toHaveBeenCalled()
  })
  it.each([
    [IPC.ComputerUseStart, 'replace'], [IPC.ComputerUseCapture, 'replace'], [IPC.ComputerUseStop, 'replace'],
    [IPC.ComputerUseStart, 'destroy'], [IPC.ComputerUseCapture, 'destroy'], [IPC.ComputerUseStop, 'destroy'],
    [IPC.ComputerUseStart, 'navigate'], [IPC.ComputerUseCapture, 'navigate'], [IPC.ComputerUseStop, 'navigate'],
    [IPC.ComputerUseStart, 'removeWindow'], [IPC.ComputerUseCapture, 'removeWindow'], [IPC.ComputerUseStop, 'removeWindow']
  ] as const)('discards late completion after owner loss: %s %s', async (channel, loss) => {
    const h = harness()
    const state = capturedState()
    h.setState(state)
    let resolve!: (value: ComputerUseStatus | CaptureResult) => void
    const pending = new Promise<ComputerUseStatus | CaptureResult>(r => { resolve = r })
    if (channel === IPC.ComputerUseStart) h.service.start.mockImplementationOnce(() => pending as Promise<ComputerUseStatus>)
    if (channel === IPC.ComputerUseCapture) h.service.capture.mockImplementationOnce(() => pending as Promise<CaptureResult>)
    if (channel === IPC.ComputerUseStop) h.service.stop.mockImplementationOnce(() => pending as Promise<ComputerUseStatus>)
    const returned = vi.fn()
    const result = Promise.resolve(h.invoke(channel, h.event, ...(channel === IPC.ComputerUseStart ? [consent] : channel === IPC.ComputerUseCapture ? [{ scopeRevision: 0 }] : []))).then(returned)
    h[loss]()
    resolve(channel === IPC.ComputerUseCapture ? { state, png: Uint8Array.from(makeStaticPng(800, 600)), previewPng: Uint8Array.from(makeStaticPng()) } : state)
    await expect(result).rejects.toThrow('owner')
    expect(returned).not.toHaveBeenCalled()
  })
  it.each(['scope', 'frame', 'frameRemoved'] as const)('discards preview after current immutable service %s changes mid-await', async kind => {
    const h = harness()
    const state = capturedState()
    h.setState(state)
    let resolve!: (result: CaptureResult) => void
    h.service.capture.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const returned = vi.fn()
    const pending = Promise.resolve(h.invoke(IPC.ComputerUseCapture, h.event, { scopeRevision: 0 })).then(returned)
    const current = structuredClone(state)
    if (kind === 'scope') { current.scopeRevision++; current.frame!.scopeRevision++ }
    if (kind === 'frame') current.frame!.id = 'frame-2'
    if (kind === 'frameRemoved') delete current.frame
    h.setState(current)
    resolve({ state: structuredClone(state), png: Uint8Array.from(makeStaticPng(800, 600)), previewPng: Uint8Array.from(makeStaticPng()) })
    await expect(pending).rejects.toThrow(kind === 'scope' ? 'stale scope' : 'stale frame')
    expect(returned).not.toHaveBeenCalled()
  })
  it('discards result scope changes even when current scope still matches the request', async () => {
    const h = harness()
    const state = capturedState()
    h.setState(state)
    const changed = structuredClone(state)
    changed.scopeRevision++
    changed.frame!.scopeRevision++
    h.service.capture.mockResolvedValueOnce({ state: changed, png: Uint8Array.from(makeStaticPng()), previewPng: Uint8Array.from(makeStaticPng()) })
    await expect(h.invoke(IPC.ComputerUseCapture, h.event, { scopeRevision: 0 })).rejects.toThrow('stale scope')
  })
  it('stop from current owner aborts all local preview, without accepting identity arguments', async () => {
    const h = harness()
    await expect(h.invoke(IPC.ComputerUseStop, h.event, h.owner)).rejects.toThrow('arguments')
    await h.invoke(IPC.ComputerUseStop)
    expect(h.service.stop).toHaveBeenCalledExactlyOnceWith(undefined, 'local-user-stop')
  })
  it('preload exposes an independent namespace; subscribing never captures/starts and unsubscribes only its listener', async () => {
    await import('../../src/preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1]
    expect(Object.keys(api.computerUse).sort()).toEqual(['capture', 'getState', 'onState', 'start', 'stop'])
    api.computerUse.getState()
    expect(electron.invoke).toHaveBeenLastCalledWith(IPC.ComputerUseGetState)
    const invokesBefore = electron.invoke.mock.calls.length
    const listener = vi.fn()
    const unsubscribe = api.computerUse.onState(listener)
    const [channel, wrapped] = electron.on.mock.calls.at(-1)!
    expect(channel).toBe(IPC_EVENTS.ComputerUseState)
    wrapped({}, createDisabledComputerUseStatus())
    expect(listener).toHaveBeenCalledExactlyOnceWith(createDisabledComputerUseStatus())
    unsubscribe()
    expect(electron.off).toHaveBeenLastCalledWith(channel, wrapped)
    expect(electron.invoke.mock.calls.length).toBe(invokesBefore)
    expect(electron.send).not.toHaveBeenCalled()
    api.computerUse.capture({ scopeRevision: 4 })
    expect(electron.invoke).toHaveBeenLastCalledWith(IPC.ComputerUseCapture, { scopeRevision: 4 })
  })
})
