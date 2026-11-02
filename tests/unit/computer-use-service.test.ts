import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { encodeHelperPacket } from '../../src/main/computer-use/helper-client'
import { WaylandComputerUseDriver } from '../../src/main/computer-use/wayland-driver'
import { ComputerUseService, type ComputerUseServiceOptions } from '../../src/main/computer-use/service'
import type { ComputerUseDriver, ComputerUseDriverFrame } from '../../src/main/computer-use/driver'
import type { ComputerUseCoordination, ComputerUseCoordinationClaim, ComputerUseCoordinationReceipt } from '../../src/main/computer-use/coordination'
import { COMPUTER_USE_LIMITS as L, validateComputerUseStatus, type ComputerUseAction, type ComputerUseCapability, type ComputerUseOwner, type ComputerUseStatus } from '../../src/shared/computer-use'
import type { ComputerUseDiagnostics } from '../../src/shared/computer-use-diagnostics'
import { makeStaticPng } from '../fixtures/static-png'

// Source-only regression fixtures: no OS helper, desktop, SDK or remote calls.
const A: ComputerUseOwner = { ownerWindowId: 1, backendId: 'a', runtimeId: 'a', runId: 'a', generation: 1 }
const B: ComputerUseOwner = { ...A, backendId: 'b' }
const consent = { capture: true, upload: false, control: false, retention: 'sdk-session' as const }
const capability: ComputerUseCapability = { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, scope: 'window', unsupportedReason: 'control-unavailable' }
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const raw = (): ComputerUseDriverFrame => ({ png: new Uint8Array(makeStaticPng()), width: 1, height: 1, sourceType: 'window', streamId: 'stream-1' })
function fixture(extra: Partial<ComputerUseServiceOptions> = {}) {
  let time = 10
  let id = 0
  const driver: ComputerUseDriver = { open: vi.fn(async () => capability), capture: vi.fn(async () => raw()), close: vi.fn(async () => {}) }
  const driverFactory = vi.fn(() => driver)
  const publish = vi.fn((status: ComputerUseStatus) => { validateComputerUseStatus(status) })
  const receipt: ComputerUseCoordinationReceipt = Object.freeze({ kind: 'computer-use-coordination-receipt' })
  const coordination: ComputerUseCoordination = {
    claim: vi.fn(async () => ({ kind: 'claimed' as const, receipt })),
    release: vi.fn(async (supplied: ComputerUseCoordinationReceipt) => { if (supplied !== receipt) throw new Error('foreign receipt') })
  }
  const service = new ComputerUseService({ coordination, driverFactory, clock: () => time, randomId: () => `frame-${++id}`, publish, ...extra })
  return { service, driver, driverFactory, publish, coordination, receipt, setTime: (value: number) => { time = value } }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

const inputConsent = { ...consent, control: true, captureScope: 'display' as const }
const inputCapability: ComputerUseCapability = { platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' }
function inputFixture(extra: Partial<ComputerUseServiceOptions> = {}) {
  const f = fixture({ allowVirtualInput: true, assertOwned: vi.fn(), ...extra })
  vi.mocked(f.driver.open).mockResolvedValue(inputCapability)
  let sequence = 0
  vi.mocked(f.driver.capture).mockImplementation(async () => ({ ...raw(), sourceType: 'display', inputFrame: { sequence: ++sequence, topology: 1 } }))
  f.driver.act = vi.fn(async () => {})
  return f
}
const inputRequest = (f: ReturnType<typeof inputFixture>) => ({ frameId: f.service.getState().frame!.id, action: { type: 'type' as const, text: 'private-text' } })

describe('ComputerUse development-only local input (mock, no desktop)', () => {
  it.each([undefined, false, true])('DMA config %s is pure metadata and cannot grant capture/control or claim a lease', async allowDmaBufReadback => {
    const f = fixture({ allowDmaBufReadback })
    const state = f.service.getState()
    expect(state).toMatchObject({ dmaBufDevelopmentEnabled: allowDmaBufReadback === true, inputDevelopmentEnabled: false,
      state: 'disabled', coordination: 'not-checked', actualPending: false, consent: { capture: false, control: false, upload: false },
      capability: { capture: false, control: false, method: 'unavailable' } })
    state.budget.captures = 1
    expect(f.service.getState().budget.captures).toBe(0)
    await f.service.stop()
    await expect(f.service.start(A, { ...consent, capture: false })).rejects.toThrow('consent required')
    await expect(f.service.start(A, inputConsent)).rejects.toThrow('input unavailable')
    for (const spy of [f.coordination.claim, f.coordination.release, f.driverFactory, f.driver.open, f.driver.capture, f.publish]) expect(spy).not.toHaveBeenCalled()
  })
  it.each(['default', 'no-assert', 'deny', 'window-control', 'display-only'] as const)('rejects %s before coordination or driver construction', async kind => {
    const f = inputFixture(kind === 'default' ? { allowVirtualInput: undefined } : kind === 'no-assert' ? { assertOwned: undefined } : kind === 'deny' ? { assertOwned: () => { throw new Error('deny') } } : {})
    const approval = kind === 'window-control' ? { ...inputConsent, captureScope: 'window' as const } : kind === 'display-only' ? { ...inputConsent, control: false } : inputConsent
    await expect(f.service.start(A, approval)).rejects.toThrow()
    expect(f.coordination.claim).not.toHaveBeenCalled()
    expect(f.driverFactory).not.toHaveBeenCalled()
  })

  it('opts in exactly, installs only actual display mappings, consumes each frame and commits before dispatch', async () => {
    const assertOwned = vi.fn()
    const f = inputFixture({ assertOwned })
    await f.service.start(A, inputConsent)
    expect(f.driver.open).toHaveBeenCalledWith(A, expect.any(Object), expect.any(AbortSignal), { control: true, captureScope: 'display' })
    await f.service.capture(A)
    const request = inputRequest(f)
    f.driver.act = vi.fn(async (action: ComputerUseAction, fence: { sequence: number; topology: number }) => {
      expect(action).toEqual(request.action)
      expect(fence).toEqual({ sequence: 1, topology: 1 })
      expect(f.service.getState()).toMatchObject({ state: 'acting', actualPending: true, budget: { actions: 1 } })
    })
    const result = await f.service.act(A, request)
    expect(result).toMatchObject({ state: 'ready', actualPending: false, budget: { actions: 1 } })
    expect(result.frame).toBeUndefined()
    expect(result.receipt).toBeUndefined()
    expect(assertOwned).toHaveBeenCalledWith(A, 'act', 'before')
    expect(assertOwned).toHaveBeenCalledWith(A, 'act', 'after')
    await expect(f.service.act(A, request)).rejects.toThrow()
    for (const [state] of f.publish.mock.calls) expect(JSON.stringify(state)).not.toMatch(/inputFrame|sequence|topology|private-text|toolCallId/)
    await f.service.stop(A)
  })

  it.each(['legacy', 'wrong-scope', 'no-act'] as const)('never downgrades %s capability into capture-only', async kind => {
    const f = inputFixture()
    if (kind === 'legacy') vi.mocked(f.driver.open).mockResolvedValue(capability)
    if (kind === 'wrong-scope') vi.mocked(f.driver.open).mockResolvedValue({ ...inputCapability, scope: 'window' })
    if (kind === 'no-act') delete f.driver.act
    await expect(f.service.start(A, inputConsent)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.driver.capture).not.toHaveBeenCalled()
  })

  it.each(['missing', 'window', 'bad-png', 'bad-preview'] as const)('accounts real bytes then rejects %s mapping/image', async kind => {
    const f = inputFixture()
    await f.service.start(A, inputConsent)
    const frame: ComputerUseDriverFrame = { ...raw(), sourceType: 'display', inputFrame: { sequence: 1, topology: 1 } }
    if (kind === 'missing') delete frame.inputFrame
    if (kind === 'window') frame.sourceType = 'window'
    if (kind === 'bad-png') frame.png = new Uint8Array([1, 2, 3])
    if (kind === 'bad-preview') frame.previewPng = new Uint8Array([1, 2, 3])
    vi.mocked(f.driver.capture).mockResolvedValue(frame)
    await expect(f.service.capture(A)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState().budget).toMatchObject({ captures: 1, frameBytes: frame.png.byteLength, framePixels: 1 })
    expect(f.driver.act).not.toHaveBeenCalled()
  })

  it('rejects foreign owner without consuming frame; expiry consumes matched frame and requires new observation', async () => {
    const f = inputFixture()
    await f.service.start(A, inputConsent)
    await f.service.capture(A)
    const request = inputRequest(f)
    await expect(f.service.act(B, request)).rejects.toThrow('owner')
    expect(f.service.getState().frame?.id).toBe(request.frameId)
    f.setTime(10 + L.frameMaxAgeMs + 1)
    await expect(f.service.act(A, request)).rejects.toThrow()
    expect(f.service.getState().frame).toBeUndefined()
    expect(f.service.getState().budget.actions).toBe(0)
    await f.service.capture(A)
    await f.service.act(A, inputRequest(f))
    await f.service.stop(A)
  })

  it.each(['stop', 'revoke', 'close-fails'] as const)('holds actual act pending through %s; late action cannot restore ready', async kind => {
    const f = inputFixture()
    const acting = deferred<void>(), closing = deferred<void>()
    f.driver.act = vi.fn(() => acting.promise)
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    await f.service.start(A, inputConsent)
    await f.service.capture(A)
    const result = f.service.act(A, inputRequest(f)).catch(error => error)
    await tick()
    if (kind === 'revoke') f.service.revoke(A)
    const stopped = f.service.stop(A)
    await tick()
    if (kind === 'close-fails') closing.reject(new Error('close unknown'))
    else closing.resolve()
    await tick()
    expect(f.service.getState().actualPending).toBe(true)
    expect(f.coordination.release).not.toHaveBeenCalled()
    await expect(f.service.start(B, inputConsent)).rejects.toThrow('occupied')
    acting.resolve()
    expect(await result).toBeInstanceOf(Error)
    const final = await stopped
    expect(final.state).toBe(kind === 'close-fails' ? 'quarantined' : 'stopped')
    expect(final.budget.actions).toBe(1)
    expect(final.frame).toBeUndefined()
    expect(f.coordination.release).toHaveBeenCalledTimes(kind === 'close-fails' ? 0 : 1)
    expect(f.driver.act).toHaveBeenCalledTimes(1)
  })

  it('keeps action budget exhausted after consuming matched frame without dispatch', async () => {
    const f = inputFixture()
    await f.service.start(A, inputConsent)
    await f.service.capture(A)
    const request = inputRequest(f)
    ;(f.service as unknown as { state: ComputerUseStatus }).state.budget.actions = L.maxActions
    await expect(f.service.act(A, request)).rejects.toThrow()
    expect(f.service.getState().frame).toBeUndefined()
    expect(f.driver.act).not.toHaveBeenCalled()
    expect(f.service.getState().budget.actions).toBe(L.maxActions)
    await f.service.stop(A)
  })

  it.each(['sequence', 'topology', 'frame-id'] as const)('rejects capture ABA on %s rather than guessing a fresh mapping', async kind => {
    const f = inputFixture(kind === 'frame-id' ? { randomId: () => 'same-frame' } : {})
    await f.service.start(A, inputConsent)
    await f.service.capture(A)
    await f.service.act(A, inputRequest(f))
    vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), sourceType: 'display', inputFrame: { sequence: kind === 'sequence' ? 1 : 2, topology: kind === 'topology' ? 2 : 1 } })
    await expect(f.service.capture(A)).rejects.toThrow()
    const final = await f.service.stop(A)
    expect(final.budget.captures).toBe(2)
    expect(f.driver.act).toHaveBeenCalledTimes(1)
  })

  it('rechecks actual owner on late act completion and never publishes success after deny', async () => {
    let denied = false
    const f = inputFixture({ assertOwned: (_owner, operation) => { if (denied && operation === 'act') throw new Error('deny') } })
    const acting = deferred<void>()
    f.driver.act = vi.fn(() => acting.promise)
    await f.service.start(A, inputConsent)
    await f.service.capture(A)
    const pending = f.service.act(A, inputRequest(f))
    await tick()
    denied = true
    acting.resolve()
    await expect(pending).rejects.toThrow()
    expect((await f.service.stop(A)).budget.actions).toBe(1)
  })

  it('does not refund failed dispatch or synthesize a success receipt', async () => {
    const f = inputFixture()
    f.driver.act = vi.fn(async () => { throw new Error('unknown outcome') })
    await f.service.start(A, inputConsent)
    await f.service.capture(A)
    await expect(f.service.act(A, inputRequest(f))).rejects.toThrow()
    const final = await f.service.stop(A)
    expect(final.budget.actions).toBe(1)
    expect(final.receipt).toBeUndefined()
    expect(f.driver.act).toHaveBeenCalledTimes(1)
  })
})

describe('ComputerUse cached diagnostics remain display-only and lease-owned', () => {
  it('does not read driver diagnostics on construction, state reads, pending claim or successful start', async () => {
    const f = fixture()
    const getDiagnostics = vi.fn(() => ({ open: 'portal-connect-failed' as const }))
    f.driver.getDiagnostics = getDiagnostics
    const claiming = deferred<ComputerUseCoordinationClaim>()
    vi.mocked(f.coordination.claim).mockReturnValue(claiming.promise)
    expect(f.service.getState()).not.toHaveProperty('diagnostics')
    expect(f.service.getState()).not.toHaveProperty('diagnostics')
    const starting = f.service.start(A, consent)
    await tick()
    f.service.getState()
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(getDiagnostics).not.toHaveBeenCalled()
    claiming.resolve({ kind: 'claimed', receipt: f.receipt })
    await starting
    expect(f.service.getState()).not.toHaveProperty('diagnostics')
    expect(getDiagnostics).not.toHaveBeenCalled()
    await f.service.stop(A)
  })

  it('retains fixed open and close failures without treating either code as release proof', async () => {
    const f = fixture()
    const cache: ComputerUseDiagnostics = {}
    f.driver.getDiagnostics = vi.fn(() => cache)
    vi.mocked(f.driver.open).mockImplementation(async () => {
      cache.open = 'pipewire-start-failed'
      throw new Error('native private path /home/private and window title')
    })
    vi.mocked(f.driver.close).mockImplementation(async () => {
      cache.close = 'portal-close-failed'
      throw new Error('portal private URI and token')
    })
    await expect(f.service.start(A, consent)).rejects.toThrow('ComputerUse start failed or revoked')
    const stopped = await f.service.stop(A)
    expect(stopped).toMatchObject({
      state: 'quarantined', owner: A, actualPending: true, coordination: 'held',
      diagnostics: { open: 'pipewire-start-failed', close: 'portal-close-failed' },
      capability: { unsupportedReason: 'stop-unverified' }
    })
    expect(f.coordination.release).not.toHaveBeenCalled()
    const reads = vi.mocked(f.driver.getDiagnostics).mock.calls.length
    expect(f.service.getState()).toEqual(stopped)
    await f.service.stop(A)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driver.getDiagnostics).toHaveBeenCalledTimes(reads)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    for (const [state] of f.publish.mock.calls) {
      expect(JSON.stringify(state)).not.toMatch(/private|URI|token/)
    }
  })

  it.each(['throw', 'raw-code', 'extra-field', 'accessor'] as const)(
    'ignores %s diagnostics without overriding actual successful or uncertain close', async invalid => {
      for (const closeFails of [false, true]) {
        const f = fixture()
        const rawSecret = 'raw-private-diagnostic /home/private token'
        const accessor = vi.fn(() => rawSecret)
        f.driver.getDiagnostics = vi.fn(() => {
          if (invalid === 'throw') throw new Error(rawSecret)
          if (invalid === 'raw-code') return { close: rawSecret } as unknown as ComputerUseDiagnostics
          if (invalid === 'extra-field') return { close: 'portal-close-failed', stderr: rawSecret } as unknown as ComputerUseDiagnostics
          return Object.defineProperty({}, 'close', { enumerable: true, get: accessor }) as ComputerUseDiagnostics
        })
        vi.mocked(f.driver.open).mockRejectedValue(new Error(rawSecret))
        if (closeFails) vi.mocked(f.driver.close).mockRejectedValue(new Error(rawSecret))
        await expect(f.service.start(A, consent)).rejects.toThrow('ComputerUse start failed or revoked')
        const stopped = await f.service.stop(A)
        expect(stopped).not.toHaveProperty('diagnostics')
        expect(stopped).toMatchObject(closeFails
          ? { state: 'quarantined', actualPending: true, coordination: 'held', owner: A }
          : { state: 'stopped', actualPending: false, coordination: 'released' })
        expect(f.coordination.release).toHaveBeenCalledTimes(closeFails ? 0 : 1)
        expect(accessor).not.toHaveBeenCalled()
        expect(f.driver.close).toHaveBeenCalledTimes(1)
        for (const [state] of f.publish.mock.calls) expect(JSON.stringify(state)).not.toContain(rawSecret)
      }
    }
  )

  it('preserves first failure per operation while copying cache, published snapshots and state reads', async () => {
    const f = fixture()
    const cache: ComputerUseDiagnostics = { open: 'window-selection-failed', capture: 'capture-frame-failed' }
    f.driver.getDiagnostics = vi.fn(() => cache)
    const closing = deferred<void>()
    vi.mocked(f.driver.close).mockImplementation(() => {
      cache.open = 'helper-transport-error'
      cache.capture = 'helper-protocol-invalid'
      cache.close = 'pipewire-stop-failed'
      return closing.promise
    })
    await f.service.start(A, consent)
    vi.mocked(f.driver.capture).mockRejectedValue(new Error('private capture error'))
    await expect(f.service.capture(A)).rejects.toThrow('ComputerUse capture failed or revoked')
    const stopped = f.service.stop(A)
    const first = f.service.getState()
    expect(first.diagnostics).toEqual({ open: 'window-selection-failed', capture: 'capture-frame-failed' })
    const snapshot = f.publish.mock.calls.find(([state]) => state.diagnostics !== undefined)![0]
    expect(snapshot.diagnostics).not.toBe(first.diagnostics)
    expect(first.diagnostics).not.toBe(cache)
    expect(snapshot.diagnostics).not.toBe(cache)
    first.diagnostics!.open = 'request-state-invalid'
    snapshot.diagnostics!.capture = 'request-state-invalid'
    expect(f.service.getState().diagnostics).toEqual({ open: 'window-selection-failed', capture: 'capture-frame-failed' })
    closing.resolve()
    const final = await stopped
    expect(final).toMatchObject({ state: 'stopped', coordination: 'released', actualPending: false })
    expect(final.diagnostics).toEqual({ open: 'window-selection-failed', capture: 'capture-frame-failed', close: 'pipewire-stop-failed' })
    cache.close = 'both-stop-failed'
    final.diagnostics!.close = 'request-state-invalid'
    expect(f.service.getState().diagnostics).toEqual({ open: 'window-selection-failed', capture: 'capture-frame-failed', close: 'pipewire-stop-failed' })
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
  })

  it('resets diagnostics immediately for a new start and does not consult the retired driver for the new owner', async () => {
    const f = fixture()
    const oldCache: ComputerUseDiagnostics = { open: 'portal-connect-failed' }
    const oldGetter = vi.fn(() => oldCache)
    f.driver.getDiagnostics = oldGetter
    vi.mocked(f.driver.open).mockRejectedValue(new Error('old open failed'))
    await expect(f.service.start(A, consent)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState().diagnostics).toEqual(oldCache)
    const oldReads = oldGetter.mock.calls.length
    const nextCache: ComputerUseDiagnostics = { capture: 'helper-transport-error' }
    const next: ComputerUseDriver = {
      open: vi.fn(async () => capability),
      capture: vi.fn(async () => { throw new Error('new capture failed') }),
      close: vi.fn(async () => {}),
      getDiagnostics: vi.fn(() => nextCache)
    }
    f.driverFactory.mockReturnValue(next)
    const starting = f.service.start(B, consent)
    expect(f.service.getState()).toMatchObject({ owner: B, state: 'preparing' })
    expect(f.service.getState()).not.toHaveProperty('diagnostics')
    await starting
    oldCache.open = 'both-stop-failed'
    expect(f.service.getState()).not.toHaveProperty('diagnostics')
    expect(next.getDiagnostics).not.toHaveBeenCalled()
    await expect(f.service.capture(B)).rejects.toThrow()
    await f.service.stop(B)
    expect(f.service.getState().diagnostics).toEqual(nextCache)
    expect(oldGetter).toHaveBeenCalledTimes(oldReads)
    expect(f.service.getState().diagnostics).not.toHaveProperty('open')
  })

  it.each(['open', 'capture'] as const)('late old %s work retains the slot, and retired callbacks cannot collect into the next lease', async operation => {
    const f = fixture()
    const oldCache: ComputerUseDiagnostics = {}
    const oldGetter = vi.fn(() => oldCache)
    f.driver.getDiagnostics = oldGetter
    let oldNotice!: () => void
    f.driver.onRevoked = vi.fn(listener => { oldNotice = listener; return vi.fn() })
    const opening = deferred<ComputerUseCapability>()
    const capturing = deferred<ComputerUseDriverFrame>()
    if (operation === 'open') vi.mocked(f.driver.open).mockReturnValue(opening.promise)
    else {
      await f.service.start(A, consent)
      vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    }
    const returned = vi.fn()
    const failed = expect((operation === 'open' ? f.service.start(A, consent) : f.service.capture(A)).then(returned)).rejects.toThrow('revoked')
    await tick()
    const stopping = f.service.stop(A)
    await tick()
    expect(f.service.getState()).toMatchObject({ owner: A, actualPending: true, coordination: 'held' })
    expect(f.coordination.release).not.toHaveBeenCalled()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    oldCache[operation] = operation === 'open' ? 'post-start-not-deliverable' : 'capture-frame-failed'
    if (operation === 'open') opening.resolve(capability)
    else capturing.resolve(raw())
    await failed
    await stopping
    expect(returned).not.toHaveBeenCalled()
    expect(f.service.getState().diagnostics).toEqual(oldCache)
    expect(f.service.getState().budget.framePixels).toBe(operation === 'capture' ? 1 : 0)
    const reads = oldGetter.mock.calls.length
    const next: ComputerUseDriver = {
      open: vi.fn(async () => capability), capture: vi.fn(async () => raw()), close: vi.fn(async () => {})
    }
    f.driverFactory.mockReturnValue(next)
    await f.service.start(B, consent)
    const before = f.service.getState()
    oldCache.close = 'portal-close-failed'
    oldNotice()
    await tick()
    expect(f.service.getState()).toEqual(before)
    expect(before).toMatchObject({ owner: B, state: 'ready', actualPending: false, budget: { captures: 0, frameBytes: 0, framePixels: 0 } })
    expect(before).not.toHaveProperty('diagnostics')
    expect(oldGetter).toHaveBeenCalledTimes(reads)
    expect(next.close).not.toHaveBeenCalled()
    await f.service.stop(B)
    expect(oldGetter).toHaveBeenCalledTimes(reads)
  })
})

describe('ComputerUse durable coordination and actual ownership ledger', () => {
  describe('synthetic Linux helper protocol', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    beforeEach(() => { Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' }) })
    afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform) })

  it.each(['window-selection-failed', 'pipewire-start-failed'] as const)('failed native open %s can release after client-disconnected receipt and actual close, without automatic restart', async diagnosticCode => {
    const children: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = []
    const drivers: WaylandComputerUseDriver[] = []
    const commands: string[][] = []
    const factory = vi.fn(() => {
      const index = children.length
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
      children.push(child)
      commands.push([])
      child.stdin.on('data', (packet: Buffer) => {
        const request = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString()) as { id: number; generation: number; kind: string }
        commands[index].push(request.kind)
        const kind = request.kind === 'open' ? (index === 0 ? 'error' : 'opened') : request.kind === 'close' ? 'closed' : 'hello'
        child.stdout.emit('data', encodeHelperPacket({ id: request.id, generation: request.generation, kind,
          ...(kind === 'hello' ? { captureAccountingVersion: 1 } : {}),
          ...(kind === 'error' ? { diagnosticCode } : {}),
          ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}),
          ...(kind === 'closed' ? { closeReceipt: { version: 1, boundary: 'client-disconnected' } } : {}) }))
      })
      const driver = new WaylandComputerUseDriver('/explicit/mock-helper', false, () => child as unknown as ChildProcessWithoutNullStreams)
      drivers.push(driver)
      return driver
    })
    const f = fixture({ driverFactory: factory })
    const releasing = deferred<void>()
    vi.mocked(f.coordination.release).mockReturnValueOnce(releasing.promise)
    await expect(f.service.start(A, consent)).rejects.toThrow('ComputerUse start failed or revoked')
    const stopping = f.service.stop(A)
    await tick()
    expect(commands[0]).toEqual(['hello', 'open', 'close'])
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, coordination: 'held', owner: A, consent: { capture: false }, diagnostics: { open: diagnosticCode } })
    expect(f.coordination.release).not.toHaveBeenCalled()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    children[0].emit('exit', 0, null)
    children[0].stdout.emit('end')
    await tick()
    expect(f.coordination.release).not.toHaveBeenCalled()
    children[0].emit('close', 0, null)
    await drivers[0].close()
    await tick()
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, owner: A, coordination: 'held', diagnostics: { open: diagnosticCode } })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    releasing.resolve()
    const stopped = await stopping
    expect(stopped).toMatchObject({ state: 'stopped', actualPending: false, coordination: 'released', diagnostics: { open: diagnosticCode } })
    expect(stopped.owner).toBeUndefined()
    expect(f.publish.mock.calls.some(([state]) => state.state === 'ready')).toBe(false)
    f.service.getState()
    await f.service.stop(A)
    await tick()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(f.coordination.claim).toHaveBeenCalledTimes(1)
    // Only another explicit approval/start may enter a new lease; no automatic
    // retry, diagnostic reinterpretation or historical marker release occurred.
    const nextOwner = { ...B, generation: 2 }
    await f.service.start(nextOwner, consent)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(f.coordination.claim).toHaveBeenCalledTimes(2)
    expect(f.service.getState()).toMatchObject({ state: 'ready', owner: nextOwner, actualPending: false })
    expect(f.service.getState().scopeRevision).toBeGreaterThan(stopped.scopeRevision)
    expect(f.service.getState()).not.toHaveProperty('diagnostics')
    const nextStop = f.service.stop(nextOwner)
    await tick()
    children[1].emit('close', 0, null)
    await nextStop
    expect(f.coordination.release).toHaveBeenCalledTimes(2)
  })

  it.each(['legacy-error', 'poisoned-receipt'] as const)('%s cannot become release proof after normal process close or repeated Stop', async mode => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    const commands: string[] = []
    child.stdin.on('data', (packet: Buffer) => {
      const request = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString()) as { id: number; generation: number; kind: string }
      commands.push(request.kind)
      const identity = { id: request.id, generation: request.generation }
      if (request.kind === 'hello') child.stdout.emit('data', encodeHelperPacket({ ...identity, kind: 'hello', captureAccountingVersion: 1 }))
      else if (request.kind === 'open') child.stdout.emit('data', encodeHelperPacket({ ...identity, kind: 'error', diagnosticCode: 'window-selection-failed' }))
      else if (mode === 'legacy-error') child.stdout.emit('data', encodeHelperPacket({ ...identity, kind: 'error', diagnosticCode: 'portal-close-failed' }))
      else {
        // A wrong response poisons this exact close. A subsequent new receipt
        // is not a transport reset or historical-stop recovery mechanism.
        child.stdout.emit('data', encodeHelperPacket({ ...identity, kind: 'hello' }))
        child.stdout.emit('data', encodeHelperPacket({ ...identity, kind: 'closed', closeReceipt: { version: 1, boundary: 'client-disconnected' } }))
      }
    })
    const factory = vi.fn(() => new WaylandComputerUseDriver('/explicit/mock-helper', false, () => child as unknown as ChildProcessWithoutNullStreams))
    const f = fixture({ driverFactory: factory })
    await expect(f.service.start(A, consent)).rejects.toThrow()
    const stopping = f.service.stop(A)
    await tick()
    child.emit('close', 0, null)
    await stopping
    const state = f.service.getState()
    expect(state).toMatchObject({ state: 'quarantined', owner: A, actualPending: true, coordination: 'held', diagnostics: { open: 'window-selection-failed' }, capability: { unsupportedReason: 'stop-unverified' } })
    expect(state.diagnostics?.close).toBe(mode === 'legacy-error' ? 'portal-close-failed' : 'helper-protocol-invalid')
    expect(f.coordination.release).not.toHaveBeenCalled()
    await f.service.stop(A)
    f.service.getState()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.service.getState()).toEqual(state)
    expect(commands).toEqual(['hello', 'open', 'close'])
    expect(factory).toHaveBeenCalledTimes(1)
    expect(f.coordination.claim).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('normal native closed (DMA config %s) releases exactly once after local process/stdio and coordination settle', async dmaBufReadback => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    const commands: string[] = []
    child.stdin.on('data', (packet: Buffer) => {
      const request = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString()) as { id: number; generation: number; kind: string }
      commands.push(request.kind)
      const kind = request.kind === 'open' ? 'opened' : request.kind === 'close' ? 'closed' : 'hello'
      // closed represents native standard Portal close + actual PW join, not
      // a separate revoked/Session.Closed notification. Local exit is still held.
      child.stdout.emit('data', encodeHelperPacket({ id: request.id, generation: request.generation, kind,
        ...(kind === 'hello' ? { captureAccountingVersion: 1, ...(dmaBufReadback ? { dmaBufReadbackVersion: 1 } : {}) } : {}),
        ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}),
        ...(kind === 'closed' ? { closeReceipt: { version: 1, boundary: 'client-disconnected' } } : {}) }))
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', dmaBufReadback, () => child as unknown as ChildProcessWithoutNullStreams)
    const f = fixture({ driverFactory: () => driver, allowDmaBufReadback: dmaBufReadback })
    const releasing = deferred<void>()
    vi.mocked(f.coordination.release).mockReturnValue(releasing.promise)
    await f.service.start(A, consent)
    const stopping = f.service.stop(A)
    await tick()
    expect(commands).toEqual(['hello', 'open', 'close'])
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, coordination: 'held', owner: A })
    expect(f.coordination.release).not.toHaveBeenCalled()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(() => f.service.stop(B)).toThrow('owner mismatch')
    child.emit('exit', 0, null)
    child.stdout.emit('end')
    await tick()
    expect(f.coordination.release).not.toHaveBeenCalled()
    child.emit('close', 0, null)
    // Wait for the actual helper/driver promise chain, not an arbitrary timeout.
    await driver.close()
    await tick()
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, coordination: 'held', owner: A })
    expect(f.service.stop(A)).toBe(stopping)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    releasing.resolve()
    expect(await stopping).toMatchObject({ state: 'stopped', actualPending: false, coordination: 'released' })
    expect(f.service.getState().owner).toBeUndefined()
    await f.service.stop()
    f.service.getState()
    expect(commands).toEqual(['hello', 'open', 'close'])
    expect(f.coordination.claim).toHaveBeenCalledTimes(1)
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
  })

  })

  it('rejects Windows capture before helper spawn and releases the local mock claim', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
    try {
      const start = vi.fn(() => { throw new Error('unexpected helper spawn') })
      const driver = new WaylandComputerUseDriver('/explicit/mock-helper', false, start)
      const f = fixture({ driverFactory: () => driver })
      await expect(f.service.start(A, consent)).rejects.toThrow('ComputerUse start failed or revoked')
      await f.service.stop(A)
      expect(start).not.toHaveBeenCalled()
      expect(f.coordination.claim).toHaveBeenCalledTimes(1)
      expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
      expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false, coordination: 'released' })
      expect(f.publish.mock.calls.some(([state]) => state.state === 'ready')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('never constructs or opens a chooser before the actual durable claim settles', async () => {
    const f = fixture()
    const claiming = deferred<ComputerUseCoordinationClaim>()
    vi.mocked(f.coordination.claim).mockReturnValue(claiming.promise)
    const start = f.service.start(A, consent)
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'preparing', coordination: 'not-checked', actualPending: true })
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.open).not.toHaveBeenCalled()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    claiming.resolve({ kind: 'claimed', receipt: f.receipt })
    await start
    expect(f.service.getState()).toMatchObject({ state: 'ready', coordination: 'held' })
    expect(f.driver.open).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.service.getState())).not.toContain('receipt')
    for (const [state] of f.publish.mock.calls) expect(state).not.toHaveProperty('receipt')
    await f.service.stop(A)
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', coordination: 'released', actualPending: false })
  })

  it('stop during claim retains the real slot and records late receipt before releasing without a chooser', async () => {
    const f = fixture()
    const claiming = deferred<ComputerUseCoordinationClaim>()
    const releasing = deferred<void>()
    vi.mocked(f.coordination.claim).mockReturnValue(claiming.promise)
    vi.mocked(f.coordination.release).mockReturnValue(releasing.promise)
    const failed = expect(f.service.start(A, consent)).rejects.toThrow('revoked')
    await tick()
    const stopped = f.service.stop(A)
    await tick()
    expect(f.service.stop(A)).toBe(stopped)
    expect(f.service.getState()).toMatchObject({ owner: A, actualPending: true, state: 'stopping' })
    expect(f.coordination.release).not.toHaveBeenCalled()
    claiming.resolve({ kind: 'claimed', receipt: f.receipt })
    await failed
    await tick()
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.driver.close).not.toHaveBeenCalled()
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
    expect(f.service.getState()).toMatchObject({ owner: A, state: 'stopping', actualPending: true, coordination: 'held' })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    releasing.resolve()
    await stopped
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false, coordination: 'released' })
    expect(f.service.getState().owner).toBeUndefined()
  })

  it.each([false, true])('foreign occupancy gives only zero-own-resources proof, including stop during claim: %s', async stopEarly => {
    const f = fixture()
    const claiming = deferred<ComputerUseCoordinationClaim>()
    vi.mocked(f.coordination.claim).mockReturnValue(claiming.promise)
    const failed = expect(f.service.start(A, consent)).rejects.toThrow()
    await tick()
    const stopped = stopEarly ? f.service.stop(A) : undefined
    claiming.resolve({ kind: 'occupied' })
    await failed
    await (stopped ?? f.service.stop(A))
    const state = f.service.getState()
    expect(state).toMatchObject({ state: 'quarantined', coordination: 'blocked', actualPending: false, consent: { capture: false } })
    expect(state.owner).toBeUndefined()
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.close).not.toHaveBeenCalled()
    expect(f.coordination.release).not.toHaveBeenCalled()
    f.service.getState()
    await f.service.stop(A)
    await f.service.stop()
    expect(f.service.getState()).toEqual(state)
    expect(f.coordination.claim).toHaveBeenCalledTimes(1)
    // Only another explicit user start can recheck; no foreign marker deletion.
    vi.mocked(f.coordination.claim).mockResolvedValue({ kind: 'claimed', receipt: f.receipt })
    await f.service.start(B, consent)
    expect(f.coordination.claim).toHaveBeenCalledTimes(2)
    await f.service.stop(B)
  })

  it.each(['unknown', 'reject', 'malformed'] as const)('uncertain claim %s stays quarantined forever without driver or unlink retry', async result => {
    const f = fixture()
    if (result === 'reject') vi.mocked(f.coordination.claim).mockRejectedValue(new Error('unknown filesystem transaction'))
    else vi.mocked(f.coordination.claim).mockResolvedValue(result === 'unknown' ? { kind: 'unknown' } : { kind: 'claimed' } as ComputerUseCoordinationClaim)
    await expect(f.service.start(A, consent)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A, coordination: 'unknown' })
    const state = f.service.getState()
    // A void local cleanup (there was no driver) cannot settle unknown FS work.
    f.service.getState()
    await f.service.stop(A)
    await f.service.stop()
    expect(f.service.getState()).toEqual(state)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.close).not.toHaveBeenCalled()
    expect(f.coordination.claim).toHaveBeenCalledTimes(1)
    expect(f.coordination.release).not.toHaveBeenCalled()
  })

  it('a pending claim has no cancellation proof; late unknown after stop keeps its slot permanently', async () => {
    const f = fixture()
    const claiming = deferred<ComputerUseCoordinationClaim>()
    vi.mocked(f.coordination.claim).mockReturnValue(claiming.promise)
    const failed = expect(f.service.start(A, consent)).rejects.toThrow()
    await tick()
    const stopped = f.service.stop(A)
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, owner: A })
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.coordination.release).not.toHaveBeenCalled()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    claiming.resolve({ kind: 'unknown' })
    await failed
    await stopped
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', coordination: 'unknown', actualPending: true, owner: A })
    expect(f.service.stop(A)).toBe(stopped)
    expect(f.coordination.claim).toHaveBeenCalledTimes(1)
    expect(f.coordination.release).not.toHaveBeenCalled()
  })

  it('failed-clean claim certifies unclaimed locally but not a released desktop marker', async () => {
    const f = fixture()
    vi.mocked(f.coordination.claim).mockResolvedValue({ kind: 'failed-clean' })
    await expect(f.service.start(A, consent)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false, coordination: 'unclaimed' })
    expect(f.service.getState().owner).toBeUndefined()
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.coordination.release).not.toHaveBeenCalled()
  })

  it.each(['stop', 'expired', 'expired-stop'] as const)('certifies unclaimed only after pre-claim %s work actually settles', async reason => {
    const f = fixture()
    const start = f.service.start(A, consent)
    const failed = expect(start).rejects.toThrow()
    if (reason !== 'stop') f.setTime(10 + L.maxDurationMs)
    const stopping = reason !== 'expired' ? f.service.stop(A) : undefined
    expect(f.service.getState().actualPending).toBe(true)
    expect(f.service.getState().coordination).toBe('not-checked')
    await failed
    await (stopping ?? f.service.stop(A))
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false, coordination: 'unclaimed', scopeRevision: 2 })
    expect(f.service.getState().owner).toBeUndefined()
    expect(f.coordination.claim).not.toHaveBeenCalled()
    expect(f.coordination.release).not.toHaveBeenCalled()
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.close).not.toHaveBeenCalled()
    f.setTime(11 + L.maxDurationMs)
    await f.service.start(B, consent)
    await f.service.stop(B)
  })

  it.each(['deny', 'document', 'expired'] as const)('rechecks %s after durable claim, retains its receipt and never opens a chooser', async reason => {
    let authorized = true
    const f = fixture({ assertOwned: () => { if (!authorized) throw new Error('changed host peer/document or deny') } })
    const claiming = deferred<ComputerUseCoordinationClaim>()
    vi.mocked(f.coordination.claim).mockReturnValue(claiming.promise)
    const failed = expect(f.service.start(A, consent)).rejects.toThrow()
    await tick()
    if (reason === 'expired') f.setTime(10 + L.maxDurationMs)
    else authorized = false
    claiming.resolve({ kind: 'claimed', receipt: f.receipt })
    await failed
    await f.service.stop(A)
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', coordination: 'released' })
    expect(f.publish.mock.calls.some(([state]) => state.state === 'ready')).toBe(false)
  })

  it('a synchronous held-state subscriber stop cannot dispatch the constructor, subscription or chooser', async () => {
    let service!: ComputerUseService
    const f = fixture({ publish: state => { if (state.state === 'preparing' && state.coordination === 'held') void service.stop(A) } })
    service = f.service
    f.driver.onRevoked = vi.fn(() => vi.fn())
    await expect(service.start(A, consent)).rejects.toThrow('revoked')
    await service.stop(A)
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.driver.onRevoked).not.toHaveBeenCalled()
    expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
  })

  it('rechecks synchronous host revocation after the pure factory before subscribing', async () => {
    let deny = false
    const f = fixture({ assertOwned: () => { if (deny) throw new Error('deny') } })
    f.driver.onRevoked = vi.fn(() => vi.fn())
    f.driverFactory.mockImplementation(() => { deny = true; return f.driver })
    await expect(f.service.start(A, consent)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.driver.onRevoked).not.toHaveBeenCalled()
    expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
  })

  it('synchronous subscription revocation blocks open and holds the marker until real close', async () => {
    const f = fixture()
    const closing = deferred<void>()
    const unsubscribe = vi.fn()
    f.driver.onRevoked = vi.fn(listener => { listener(); return unsubscribe })
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    await expect(f.service.start(A, consent)).rejects.toThrow('revoked')
    const stopped = f.service.stop(A)
    expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.coordination.release).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', coordination: 'held', actualPending: true })
    closing.resolve()
    await stopped
    expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('late physical capture accounting and strict driver close both precede marker release', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const capturing = deferred<ComputerUseDriverFrame>()
    const closing = deferred<void>()
    const releasing = deferred<void>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    vi.mocked(f.coordination.release).mockImplementation(receipt => {
      expect(receipt).toBe(f.receipt)
      expect(f.service.getState()).toMatchObject({ actualPending: true, budget: { frameBytes: raw().png.byteLength, framePixels: 1 } })
      return releasing.promise
    })
    const failed = expect(f.service.capture(A)).rejects.toThrow('revoked')
    await tick()
    const stopped = f.service.stop(A)
    closing.resolve()
    await tick()
    expect(f.coordination.release).not.toHaveBeenCalled()
    capturing.resolve(raw())
    await failed
    await tick()
    expect(f.coordination.release).toHaveBeenCalledTimes(1)
    expect(f.service.getState()).toMatchObject({ state: 'stopping', coordination: 'held', actualPending: true, owner: A })
    expect(f.publish.mock.calls.filter(([state]) => state.state === 'stopped')).toHaveLength(0)
    releasing.resolve()
    await stopped
    expect(f.service.getState()).toMatchObject({ state: 'stopped', coordination: 'released', actualPending: false })
  })

  it.each(['reject', 'nonvoid'] as const)('unverified driver close %s retains held coordination and never calls release', async result => {
    const f = fixture()
    await f.service.start(A, consent)
    const closing = deferred<void>()
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    const stopping = f.service.stop(A)
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', coordination: 'held', actualPending: true, owner: A, consent: { capture: false } })
    expect(f.service.stop(A)).toBe(stopping)
    expect(() => f.service.stop(B)).toThrow('owner mismatch')
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.coordination.release).not.toHaveBeenCalled()
    if (result === 'reject') closing.reject(new Error('unknown helper termination'))
    else closing.resolve(false as unknown as void)
    await stopping
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', coordination: 'held', actualPending: true, owner: A })
    await f.service.stop(A)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    expect(f.coordination.release).not.toHaveBeenCalled()
  })

  it.each(['reject', 'nonvoid'] as const)('known close failure %s quarantines even while physical capture remains pending', async result => {
    const f = fixture()
    await f.service.start(A, consent)
    const capturing = deferred<ComputerUseDriverFrame>()
    const closing = deferred<void>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    const failed = expect(f.service.capture(A)).rejects.toThrow('revoked')
    await tick()
    let stopSettled = false
    const stopping = f.service.stop(A)
    void stopping.then(() => { stopSettled = true })
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', owner: A, actualPending: true, coordination: 'held' })
    if (result === 'reject') closing.reject(new Error('actual close unverified'))
    else closing.resolve(false as unknown as void)
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', owner: A, actualPending: true, coordination: 'held', capability: { unsupportedReason: 'stop-unverified' } })
    expect(stopSettled).toBe(false)
    expect(f.coordination.release).not.toHaveBeenCalled()
    expect(f.service.stop(A)).toBe(stopping)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    capturing.resolve(raw())
    await failed
    await stopping
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', owner: A, actualPending: true, budget: { frameBytes: raw().png.byteLength, framePixels: 1 } })
    expect(f.coordination.release).not.toHaveBeenCalled()
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it.each(['reject', 'nonvoid'] as const)('uncertain marker release %s never retries, frees the slot or publishes stopped', async result => {
    const f = fixture()
    await f.service.start(A, consent)
    const releasing = deferred<void>()
    vi.mocked(f.coordination.release).mockReturnValue(releasing.promise)
    const stopped = f.service.stop(A)
    // Wait for the release admission after the strict driver-close gate.
    await vi.waitFor(() => expect(f.coordination.release).toHaveBeenCalledExactlyOnceWith(f.receipt))
    expect(f.service.getState()).toMatchObject({ state: 'stopping', coordination: 'held', actualPending: true, owner: A, consent: { capture: false } })
    expect(f.service.stop(A)).toBe(stopped)
    expect(() => f.service.stop(B)).toThrow('owner mismatch')
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    if (result === 'reject') releasing.reject(new Error('uncertain unlink'))
    else releasing.resolve(false as unknown as void)
    await stopped
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', coordination: 'unknown', actualPending: true, owner: A })
    expect(f.service.stop(A)).toBe(stopped)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    expect(f.coordination.release).toHaveBeenCalledTimes(1)
    expect(f.publish.mock.calls.some(([state]) => state.state === 'stopped')).toBe(false)
  })
})

describe('ComputerUse local observation broker ownership', () => {
  it('constructs and reads disabled state without factory/probing/capture, and cannot control', async () => {
    const f = fixture()
    expect(f.service.getState()).toMatchObject({ state: 'disabled', capability: { capture: false, control: false, unsupportedReason: 'not-probed' } })
    f.service.getState().budget.captures = 80
    expect(f.service.getState().budget.captures).toBe(0)
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.coordination.claim).not.toHaveBeenCalled()
    expect(f.coordination.release).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
    await expect(f.service.act(A, { frameId: 'unobserved', action: { type: 'type', text: 'no' } })).rejects.toThrow()
    expect(f.driverFactory).not.toHaveBeenCalled()
  })

  it('requires capture-only consent and independent host deny before constructing driver', async () => {
    const f = fixture({ assertOwned: () => { throw new Error('deny') } })
    await expect(f.service.start(A, { ...consent, capture: false })).rejects.toThrow()
    await expect(f.service.start(A, { ...consent, control: true })).rejects.toThrow()
    await expect(f.service.start(A, consent)).rejects.toThrow('deny')
    expect(f.coordination.claim).not.toHaveBeenCalled()
    expect(f.driverFactory).not.toHaveBeenCalled()
  })

  it('opens only after approval, holds owner while waiting, and returns pixels only separately', async () => {
    const f = fixture()
    await f.service.start(A, { ...consent, upload: true })
    expect(f.driver.capture).not.toHaveBeenCalled()
    expect(f.service.getState().frame).toBeUndefined()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    await expect(f.service.capture(B)).rejects.toThrow('owner mismatch')
    const result = await f.service.capture(A)
    expect(result.png).toEqual(raw().png)
    expect(result.state.frame).toMatchObject({ actualScope: 'window', captureScope: 'window', width: 1 })
    expect(result.state.frame).not.toHaveProperty('windowId')
    expect(JSON.stringify(result.state)).not.toContain('png')
    for (const [state] of f.publish.mock.calls) expect(state).not.toHaveProperty('png')
    expect(result.state.consent?.upload).toBe(true) // Intent only, no upload API.
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false })
    await f.service.stop(A)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it('stop during real open revokes immediately but holds A until both open and close settle', async () => {
    const f = fixture()
    const opening = deferred<ComputerUseCapability>()
    const closing = deferred<void>()
    vi.mocked(f.driver.open).mockReturnValue(opening.promise)
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    const start = f.service.start(A, consent)
    const failed = expect(start).rejects.toThrow('revoked')
    await tick()
    const stop = f.service.stop(A)
    expect(f.service.stop(A)).toBe(stop)
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    closing.resolve()
    await tick()
    expect(f.service.getState().actualPending).toBe(true)
    opening.resolve(capability)
    await failed
    await stop
    expect(f.service.getState().owner).toBeUndefined()
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    await f.service.start(B, consent)
    expect(f.service.getState().owner).toEqual(B)
  })

  it('late A capture cannot return pixels or replace B; close ACK alone never releases pending', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    await f.service.capture(A)
    const capturing = deferred<ComputerUseDriverFrame>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    const capture = f.service.capture(A)
    const failed = expect(capture).rejects.toThrow('revoked')
    await tick()
    const stop = f.service.stop(A)
    expect(f.service.getState().frame).toBeUndefined()
    await tick() // close resolved; physical capture still running.
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.service.getState().actualPending).toBe(true)
    capturing.resolve(raw())
    await failed
    await stop
    await f.service.start(B, consent)
    expect(f.service.getState().owner).toEqual(B)
    expect(f.service.getState().frame).toBeUndefined()
    expect(() => f.service.revoke(A)).toThrow('owner mismatch')
  })

  it('close rejection quarantines permanently without retry/replacement or false stop proof', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    vi.mocked(f.driver.close).mockRejectedValue(new Error('unknown close'))
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A, capability: { unsupportedReason: 'stop-unverified' } })
    await f.service.stop(A)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driverFactory).toHaveBeenCalledTimes(1)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a driver negative close acknowledgement for actual closure', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    // A broken/untrusted adapter violates the void contract with a negative ACK.
    // Resolving a Promise alone is not a valid close acknowledgement.
    vi.mocked(f.driver.close).mockResolvedValue(false as unknown as void)
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A, capability: { unsupportedReason: 'stop-unverified' } })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it('a rejected open still holds the lease until actual close settles', async () => {
    const f = fixture()
    const closing = deferred<void>()
    vi.mocked(f.driver.open).mockRejectedValue(new Error('chooser failed'))
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    await expect(f.service.start(A, consent)).rejects.toThrow()
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, owner: A })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    const stop = f.service.stop(A)
    closing.resolve()
    await stop
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false })
  })

  it('never treats a forever-pending close as stopped', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const closing = deferred<void>()
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    void f.service.stop(A)
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driverFactory).toHaveBeenCalledTimes(1)
  })

  it('rechecks host deny after async open and capture; late images never escape', async () => {
    let deny = false
    const f = fixture({ assertOwned: () => { if (deny) throw new Error('deny') } })
    await f.service.start(A, consent)
    const capturing = deferred<ComputerUseDriverFrame>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    const capture = f.service.capture(A)
    const failed = expect(capture).rejects.toThrow()
    await tick()
    deny = true
    capturing.resolve(raw())
    await failed
    expect(f.service.getState().frame).toBeUndefined()
    await f.service.stop(A)
    expect(f.service.getState().budget.captures).toBe(1)
    expect(f.service.getState().budget.frameBytes).toBe(raw().png.byteLength)
  })

  it('denies a changed host policy before capture dispatch and counts real rejected attempts', async () => {
    let deny = false
    const f = fixture({ assertOwned: () => { if (deny) throw new Error('deny') } })
    await f.service.start(A, consent)
    deny = true
    await expect(f.service.capture(A)).rejects.toThrow('deny')
    expect(f.driver.capture).not.toHaveBeenCalled()
    expect(f.service.getState().budget.captures).toBe(0)
    deny = false
    vi.mocked(f.driver.capture).mockRejectedValue(new Error('capture failed'))
    await expect(f.service.capture(A)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState().budget.captures).toBe(1)
    expect(f.driver.capture).toHaveBeenCalledTimes(1)
  })

  it('rechecks ownership after a late open and never publishes a ready capability', async () => {
    let deny = false
    const f = fixture({ assertOwned: () => { if (deny) throw new Error('deny') } })
    const opening = deferred<ComputerUseCapability>()
    vi.mocked(f.driver.open).mockReturnValue(opening.promise)
    const start = f.service.start(A, consent)
    const failed = expect(start).rejects.toThrow()
    await tick()
    deny = true
    opening.resolve(capability)
    await failed
    await f.service.stop(A)
    expect(f.publish.mock.calls.some(([state]) => state.state === 'ready')).toBe(false)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it('rejects changed/non-window streams and invalid encoded geometry', async () => {
    for (const changed of [{ sourceType: 'display' }, { streamId: 'stream-2' }, { width: 2 }, { png: new Uint8Array([1, 2]) }]) {
      const f = fixture()
      await f.service.start(A, consent)
      await f.service.capture(A)
      vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), ...changed } as ComputerUseDriverFrame)
      await expect(f.service.capture(A)).rejects.toThrow()
      expect(f.service.getState().frame).toBeUndefined()
      await f.service.stop(A)
      expect(f.service.getState().budget.captures).toBe(2)
    }
  })

  it('runs real PNG integrity checks for untrusted driver bytes without a decoder or OS', async () => {
    const valid = raw().png
    const badCrc = valid.slice()
    badCrc[badCrc.length - 1] ^= 1
    const invalidImages = [valid.slice(0, -1), badCrc, new Uint8Array([...valid, 0])]
    for (const png of invalidImages) {
      const f = fixture()
      await f.service.start(A, consent)
      vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), png })
      await expect(f.service.capture(A)).rejects.toThrow()
      await f.service.stop(A)
      expect(f.service.getState().frame).toBeUndefined()
      expect(f.service.getState().budget).toMatchObject({ captures: 1, frameBytes: png.byteLength, framePixels: 1 })
      expect(f.driver.capture).toHaveBeenCalledTimes(1)
    }
  })

  it('saturates oversized output accounting and counts capture failures without retries', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER, png: new Uint8Array(L.maxFrameBytes + 1) })
    await expect(f.service.capture(A)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState().budget).toMatchObject({ captures: 1, frameBytes: L.maxFrameBytes + 1, framePixels: L.maxTotalFramePixels })
    expect(f.driver.capture).toHaveBeenCalledTimes(1)
    validateComputerUseStatus(f.service.getState())
  })

  it('does not leak mutable input, driver capability, returned or published authorization aliases', async () => {
    const suppliedOwner = { ...A }
    const suppliedConsent = { ...consent }
    const suppliedCapability = { ...capability }
    const f = fixture({ publish: state => {
      if (state.owner) state.owner.backendId = 'attacker'
      if (state.consent) state.consent.control = true
      state.budget.captures = L.maxCaptures
    } })
    vi.mocked(f.driver.open).mockResolvedValue(suppliedCapability)
    const started = await f.service.start(suppliedOwner, suppliedConsent)
    suppliedOwner.backendId = 'other'
    suppliedConsent.capture = false
    suppliedCapability.capture = false
    started.owner!.backendId = 'other'
    started.consent!.control = true
    started.capability!.capture = false
    started.budget.captures = L.maxCaptures
    const captured = await f.service.capture(A)
    captured.state.frame!.width = 2
    captured.state.owner!.generation++
    captured.png[0] = 0
    expect(f.service.getState()).toMatchObject({ owner: A, consent, capability: { capture: true }, budget: { captures: 1 }, frame: { width: 1 } })
    await f.service.stop(A)
  })

  it.each(['start', 'capture'] as const)('a ready subscriber revoke during %s never returns old authority or pixels', async operation => {
    let armed = false
    let service!: ComputerUseService
    const f = fixture({ publish: state => {
      if (armed && state.state === 'ready') service.revoke(A)
    } })
    service = f.service
    if (operation === 'capture') await service.start(A, consent)
    armed = true
    await expect(operation === 'start' ? service.start(A, consent) : service.capture(A)).rejects.toThrow('revoked')
    await service.stop(A)
    expect(service.getState()).toMatchObject({ state: 'stopped', actualPending: false })
    expect(service.getState().frame).toBeUndefined()
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it.each(['preparing', 'observing'] as const)('reentrant revoke at %s blocks driver dispatch and still closes once', async stateToStop => {
    let service!: ComputerUseService
    const f = fixture({ publish: state => { if (state.state === stateToStop) service.revoke(A) } })
    service = f.service
    if (stateToStop === 'observing') await service.start(A, consent)
    await expect(stateToStop === 'preparing' ? service.start(A, consent) : service.capture(A)).rejects.toThrow()
    await service.stop(A)
    expect(service.getState().actualPending).toBe(false)
    if (stateToStop === 'preparing') expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.driver.capture).not.toHaveBeenCalled()
  })

  it('subscriber exceptions cannot skip actual cleanup', async () => {
    const f = fixture({ publish: () => { throw new Error('display failed') } })
    await f.service.start(A, consent)
    await f.service.capture(A)
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false })
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it.each([NaN, Infinity, -1, 9, Number.MAX_SAFE_INTEGER + 1])('rejects invalid or backwards host clock %s before capture', async time => {
    const f = fixture()
    await f.service.start(A, consent)
    f.setTime(time)
    await expect(f.service.capture(A)).rejects.toThrow('clock')
    expect(f.driver.capture).not.toHaveBeenCalled()
    expect(f.service.getState().budget.captures).toBe(0)
    await f.service.stop(A)
  })

  it('expires at exact duration equality but retains a real pending capture until actual settlement', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const capturing = deferred<ComputerUseDriverFrame>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    const attempt = f.service.capture(A)
    const failed = expect(attempt).rejects.toThrow()
    await tick()
    f.setTime(10 + L.maxDurationMs)
    await expect(f.service.capture(A)).rejects.toThrow('duration')
    expect(f.service.getState()).toMatchObject({ actualPending: true, budget: { captures: 1 } })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    capturing.resolve(raw())
    await failed
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false, budget: { captures: 1 } })
  })

  it.each(['frameBytes', 'framePixels'] as const)('returns the last valid capture at exact accumulated %s cap, then denies dispatch', async field => {
    const f = fixture()
    await f.service.start(A, consent)
    // Prime only accumulated counters to avoid allocating/decoding tens of MiB
    // of redundant fixture pixels. The actual final PNG and validator are real.
    const internal = f.service as unknown as { state: ComputerUseStatus }
    const cap = field === 'frameBytes' ? L.maxTotalFrameBytes : L.maxTotalFramePixels
    const increment = field === 'frameBytes' ? raw().png.byteLength : 1
    internal.state.budget[field] = cap - increment
    const result = await f.service.capture(A)
    expect(result.state.budget[field]).toBe(cap)
    expect(result.png).toEqual(raw().png)
    expect(f.driver.capture).toHaveBeenCalledWith(expect.any(AbortSignal), {
      maxFrameBytes: field === 'frameBytes' ? increment : L.maxFrameBytes,
      maxFramePixels: field === 'framePixels' ? increment : L.maxFramePixels,
      maxFrameEdge: L.maxFrameEdge
    })
    await expect(f.service.capture(A)).rejects.toThrow('budget')
    expect(f.driver.capture).toHaveBeenCalledTimes(1)
    await f.service.stop(A)
  })

  it.each(['frameBytes', 'framePixels'] as const)('rejects a delivered capture exceeding remaining %s even when accounting saturates', async field => {
    const f = fixture()
    await f.service.start(A, consent)
    const internal = f.service as unknown as { state: ComputerUseStatus }
    const cap = field === 'frameBytes' ? L.maxTotalFrameBytes : L.maxTotalFramePixels
    const delivered = field === 'framePixels' ? { ...raw(), width: 2, png: new Uint8Array(makeStaticPng(2, 1)) } : raw()
    vi.mocked(f.driver.capture).mockResolvedValue(delivered)
    const increment = field === 'frameBytes' ? delivered.png.byteLength : delivered.width * delivered.height
    internal.state.budget[field] = cap - increment + 1
    await expect(f.service.capture(A)).rejects.toThrow()
    await f.service.stop(A)
    expect(f.service.getState().budget[field]).toBe(cap)
    expect(f.service.getState().frame).toBeUndefined()
    expect(f.driver.capture).toHaveBeenCalledTimes(1)
  })

  it('a clock rollback while capture awaits rejects late pixels and preserves accounting', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const capturing = deferred<ComputerUseDriverFrame>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    const attempt = f.service.capture(A)
    const failed = expect(attempt).rejects.toThrow()
    await tick()
    f.setTime(9)
    capturing.resolve(raw())
    await failed
    await f.service.stop(A)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false, budget: { captures: 1, frameBytes: raw().png.byteLength } })
    expect(f.service.getState().frame).toBeUndefined()
  })

  it('malformed pending output never releases a lease while close still hangs', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const closing = deferred<void>()
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), png: new Uint8Array([1, 2, 3]) })
    await expect(f.service.capture(A)).rejects.toThrow()
    await tick()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, owner: A, budget: { captures: 1, frameBytes: 3 } })
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    const stop = f.service.stop(A)
    closing.resolve()
    await stop
    expect(f.service.getState().actualPending).toBe(false)
  })

  it('late old-scope output is accounted to A only; B starts with a clean budget and newer scope', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const oldScope = f.service.getState().scopeRevision
    const capturing = deferred<ComputerUseDriverFrame>()
    vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    const attempt = f.service.capture(A)
    const failed = expect(attempt).rejects.toThrow()
    await tick()
    const stopped = f.service.stop(A)
    capturing.resolve(raw())
    await failed
    const oldState = await stopped
    expect(oldState.budget).toMatchObject({ captures: 1, frameBytes: raw().png.byteLength, framePixels: 1 })
    await f.service.start(B, consent)
    expect(f.service.getState().budget).toEqual({ captures: 0, actions: 0, frameBytes: 0, framePixels: 0 })
    expect(f.service.getState().scopeRevision).toBeGreaterThan(oldScope)
    await expect(f.service.capture(A)).rejects.toThrow('owner mismatch')
    expect(f.service.getState().owner).toEqual(B)
    await f.service.stop(B)
  })

  it('passes both remaining byte and pixel budgets before dispatch, not just open-time caps', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const internal = f.service as unknown as { state: ComputerUseStatus }
    internal.state.budget.frameBytes = L.maxTotalFrameBytes - 1234
    internal.state.budget.framePixels = L.maxTotalFramePixels - 456
    await f.service.capture(A)
    expect(f.driver.capture).toHaveBeenCalledWith(expect.any(AbortSignal), {
      maxFrameBytes: 1234, maxFramePixels: 456, maxFrameEdge: L.maxFrameEdge
    })
    await f.service.capture(A)
    expect(f.driver.capture).toHaveBeenLastCalledWith(expect.any(AbortSignal), {
      maxFrameBytes: 1234 - raw().png.byteLength, maxFramePixels: 455, maxFrameEdge: L.maxFrameEdge
    })
    await f.service.stop(A)
  })

  it('accounts a PNG actually delivered after abort before rejecting without any image payload', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const delivered = { ...raw(), previewPng: new Uint8Array(makeStaticPng()) }
    const capturing = deferred<ComputerUseDriverFrame>()
    vi.mocked(f.driver.capture).mockImplementation(signal => {
      expect(signal.aborted).toBe(false)
      signal.addEventListener('abort', () => {
        expect(f.service.getState().budget.frameBytes).toBe(0)
        capturing.resolve(delivered)
      }, { once: true })
      return capturing.promise
    })
    const returned = vi.fn()
    const attempt = f.service.capture(A).then(returned)
    const failed = expect(attempt).rejects.toThrow('revoked')
    await tick()
    const stopped = f.service.stop(A)
    expect(vi.mocked(f.driver.capture).mock.calls[0][0].aborted).toBe(true)
    await failed
    await stopped
    expect(returned).not.toHaveBeenCalled()
    expect(f.service.getState().budget).toEqual({ captures: 1, actions: 0, frameBytes: delivered.png.byteLength, framePixels: 1 })
    expect(f.publish.mock.calls.some(([state]) => state.frame !== undefined)).toBe(false)
    await f.service.start(B, consent)
    delivered.png.fill(0)
    delivered.previewPng.fill(0)
    await tick()
    expect(f.service.getState()).toMatchObject({ owner: B, budget: { captures: 0, frameBytes: 0, framePixels: 0 } })
    await f.service.stop(B)
  })

  it('copies original and independently bounded preview PNG without driver or caller aliases', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    const delivered = { ...raw(), width: 800, height: 600, png: new Uint8Array(makeStaticPng(800, 600)), previewPng: new Uint8Array(makeStaticPng(512, 384)) }
    vi.mocked(f.driver.capture).mockResolvedValue(delivered)
    const result = await f.service.capture(A) as Awaited<ReturnType<ComputerUseService['capture']>> & { previewPng?: Uint8Array }
    expect(result.png).toEqual(delivered.png)
    expect(result.previewPng).toEqual(delivered.previewPng)
    expect(result.png).not.toBe(delivered.png)
    expect(result.previewPng).not.toBe(delivered.previewPng)
    expect(result.previewPng!.byteLength).toBeLessThanOrEqual(96 * 1024)
    expect(result.state.budget).toMatchObject({ frameBytes: delivered.png.byteLength, framePixels: 800 * 600 })
    delivered.png.fill(0)
    delivered.previewPng.fill(0)
    expect(result.png[0]).toBe(137)
    expect(result.previewPng![0]).toBe(137)
    result.png.fill(1)
    result.previewPng!.fill(1)
    expect(f.service.getState().frame).toMatchObject({ width: 800, height: 600 })
    expect(JSON.stringify(f.service.getState())).not.toContain('previewPng')
    await f.service.stop(A)
  })

  it.each(['edge', 'bytes', 'integrity'] as const)('rejects independently invalid preview %s without returning original or thumbnail', async kind => {
    const f = fixture()
    await f.service.start(A, consent)
    const previewPng = kind === 'edge' ? new Uint8Array(makeStaticPng(513, 1))
      : kind === 'bytes' ? new Uint8Array(96 * 1024 + 1) : new Uint8Array([137, 80, 78, 71])
    vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), previewPng })
    const returned = vi.fn()
    await expect(f.service.capture(A).then(returned)).rejects.toThrow()
    expect(returned).not.toHaveBeenCalled()
    await f.service.stop(A)
    expect(f.service.getState().budget).toMatchObject({ captures: 1, frameBytes: raw().png.byteLength, framePixels: 1 })
    expect(f.service.getState().frame).toBeUndefined()
  })

  it('a publication callback stop cannot return either copied original or preview', async () => {
    let service!: ComputerUseService
    const f = fixture({ publish: state => {
      if (state.state === 'ready' && state.frame) void service.stop(A)
    } })
    service = f.service
    await service.start(A, consent)
    vi.mocked(f.driver.capture).mockResolvedValue({ ...raw(), previewPng: new Uint8Array(makeStaticPng()) })
    const returned = vi.fn()
    await expect(service.capture(A).then(returned)).rejects.toThrow('revoked')
    await service.stop(A)
    expect(returned).not.toHaveBeenCalled()
    expect(service.getState()).toMatchObject({ state: 'stopped', actualPending: false, budget: { captures: 1 } })
    expect(service.getState().frame).toBeUndefined()
  })

  it('passively subscribes only after start; construction and queries never touch the driver', async () => {
    const f = fixture()
    const subscribe = vi.fn(() => vi.fn())
    f.driver.onRevoked = subscribe
    expect(f.service.getState().state).toBe('disabled')
    expect(f.service.getState().budget.captures).toBe(0)
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(f.driver.open).not.toHaveBeenCalled()
    expect(f.driver.capture).not.toHaveBeenCalled()
    await f.service.start(A, consent)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(f.driver.capture).not.toHaveBeenCalled()
    await f.service.stop(A)
  })

  it('an idle portal revocation synchronously removes an existing frame and consent without another capture', async () => {
    const f = fixture()
    let notify!: () => void
    const unsubscribe = vi.fn()
    f.driver.onRevoked = vi.fn(listener => { notify = listener; return unsubscribe })
    const closing = deferred<void>()
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    await f.service.start(A, consent)
    await f.service.capture(A)
    const scope = f.service.getState().scopeRevision
    expect(f.service.getState().frame).toBeDefined()
    notify()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, owner: A, consent: { capture: false, upload: false, control: false } })
    expect(f.service.getState().frame).toBeUndefined()
    expect(f.service.getState().scopeRevision).toBeGreaterThan(scope)
    await expect(f.service.capture(A)).rejects.toThrow('revoked')
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driver.capture).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
    const stopped = f.service.stop(A)
    closing.resolve()
    await stopped
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(f.service.getState()).toMatchObject({ state: 'stopped', actualPending: false })
  })

  it('a native non-deliverable frame still counts physical pixels and bytes but never returns old or new images', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    await f.service.capture(A)
    const delivered = { ...raw(), width: 2, height: 3, png: new Uint8Array(makeStaticPng(2, 3)), previewPng: new Uint8Array(makeStaticPng()), deliverable: false }
    vi.mocked(f.driver.capture).mockResolvedValue(delivered)
    const returned = vi.fn()
    const before = f.publish.mock.calls.length
    await expect(f.service.capture(A).then(returned)).rejects.toThrow('revoked')
    await f.service.stop(A)
    expect(returned).not.toHaveBeenCalled()
    expect(f.service.getState().frame).toBeUndefined()
    expect(f.service.getState().budget).toEqual({ captures: 2, actions: 0, frameBytes: raw().png.byteLength + delivered.png.byteLength, framePixels: 7 })
    for (const [state] of f.publish.mock.calls.slice(before)) {
      expect(state.frame).toBeUndefined()
      expect(state).not.toHaveProperty('png')
      expect(state).not.toHaveProperty('previewPng')
    }
    expect(f.driver.capture).toHaveBeenCalledTimes(2)
  })

  it.each(['open', 'capture'] as const)('portal notification during real %s retains ownership until both pending and close settle', async operation => {
    const f = fixture()
    let notify!: () => void
    const unsubscribe = vi.fn()
    f.driver.onRevoked = vi.fn(listener => { notify = listener; return unsubscribe })
    const closing = deferred<void>()
    vi.mocked(f.driver.close).mockReturnValue(closing.promise)
    const opening = deferred<ComputerUseCapability>()
    const capturing = deferred<ComputerUseDriverFrame>()
    const delivered = { ...raw(), width: 2, png: new Uint8Array(makeStaticPng(2, 1)), previewPng: new Uint8Array(makeStaticPng()) }
    if (operation === 'open') vi.mocked(f.driver.open).mockReturnValue(opening.promise)
    else {
      await f.service.start(A, consent)
      vi.mocked(f.driver.capture).mockReturnValue(capturing.promise)
    }
    const returned = vi.fn()
    const attempt = (operation === 'open' ? f.service.start(A, consent) : f.service.capture(A)).then(returned)
    const failed = expect(attempt).rejects.toThrow('revoked')
    await tick()
    notify()
    expect(f.service.getState()).toMatchObject({ state: 'stopping', actualPending: true, owner: A, consent: { capture: false } })
    expect(f.service.getState().frame).toBeUndefined()
    const stopped = f.service.stop(A)
    closing.resolve()
    await tick()
    expect(unsubscribe).not.toHaveBeenCalled()
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    if (operation === 'open') opening.resolve(capability)
    else capturing.resolve(delivered)
    await failed
    const oldState = await stopped
    expect(returned).not.toHaveBeenCalled()
    expect(oldState.budget).toEqual({ captures: operation === 'capture' ? 1 : 0, actions: 0, frameBytes: operation === 'capture' ? delivered.png.byteLength : 0, framePixels: operation === 'capture' ? 2 : 0 })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(f.publish.mock.calls.some(([state]) => state.frame !== undefined)).toBe(false)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
  })

  it('unverified portal closure keeps the subscription and lease, and repeated notices do not release or retry', async () => {
    const f = fixture()
    let notify!: () => void
    const unsubscribe = vi.fn()
    f.driver.onRevoked = vi.fn(listener => { notify = listener; return unsubscribe })
    await f.service.start(A, consent)
    vi.mocked(f.driver.close).mockRejectedValue(new Error('close uncertain'))
    notify()
    await f.service.stop(A)
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(f.service.getState()).toMatchObject({ owner: A, actualPending: true, state: 'quarantined', capability: { unsupportedReason: 'stop-unverified' } })
    notify()
    await f.service.stop(A)
    await expect(f.service.start(B, consent)).rejects.toThrow('occupied')
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it.each([false, true])('old portal notices cannot stop B even when unsubscribe throws: %s', async throws => {
    const f = fixture()
    const notices: Array<() => void> = []
    const unsubscribe = vi.fn(() => { if (throws) throw new Error('unsubscribe failed') })
    f.driver.onRevoked = vi.fn(listener => { notices.push(listener); return unsubscribe })
    await f.service.start(A, consent)
    await f.service.stop(A)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await f.service.start(B, consent)
    await f.service.capture(B)
    const before = f.service.getState()
    notices[0]()
    await tick()
    expect(f.service.getState()).toEqual(before)
    expect(f.driver.close).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await f.service.stop(B)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(f.driver.close).toHaveBeenCalledTimes(2)
  })

  it('bounds failed attempts and total lease duration, including user wait', async () => {
    const f = fixture()
    await f.service.start(A, consent)
    expect(L.maxCaptures).toBe(80) // Observation alone cannot create an unlimited workflow.
    for (let i = 0; i < 80; i++) await f.service.capture(A)
    expect(f.service.getState().budget).toMatchObject({ captures: 80, actions: 0 })
    await expect(f.service.capture(A)).rejects.toThrow('budget')
    expect(f.driver.capture).toHaveBeenCalledTimes(L.maxCaptures)
    await f.service.stop(A)
    await f.service.start(A, consent)
    f.setTime(L.maxDurationMs + 11)
    await expect(f.service.capture(A)).rejects.toThrow('duration')
    expect(f.driver.capture).toHaveBeenCalledTimes(L.maxCaptures)
    await f.service.stop(A)
  })
})
