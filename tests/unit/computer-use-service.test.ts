import { describe, expect, it, vi } from 'vitest'
import { ComputerUseService, type ComputerUseServiceOptions } from '../../src/main/computer-use/service'
import type { ComputerUseDriver, ComputerUseDriverFrame } from '../../src/main/computer-use/driver'
import { COMPUTER_USE_LIMITS as L, validateComputerUseStatus, type ComputerUseCapability, type ComputerUseOwner, type ComputerUseStatus } from '../../src/shared/computer-use'
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
  const service = new ComputerUseService({ driverFactory, clock: () => time, randomId: () => `frame-${++id}`, publish, ...extra })
  return { service, driver, driverFactory, publish, setTime: (value: number) => { time = value } }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('ComputerUse local observation broker ownership', () => {
  it('constructs and reads disabled state without factory/probing/capture, and cannot control', () => {
    const f = fixture()
    expect(f.service.getState()).toMatchObject({ state: 'disabled', capability: { capture: false, control: false, unsupportedReason: 'not-probed' } })
    f.service.getState().budget.captures = 80
    expect(f.service.getState().budget.captures).toBe(0)
    expect(f.driverFactory).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
    expect('act' in f.service).toBe(false)
  })

  it('requires capture-only consent and independent host deny before constructing driver', async () => {
    const f = fixture({ assertOwned: () => { throw new Error('deny') } })
    await expect(f.service.start(A, { ...consent, capture: false })).rejects.toThrow()
    await expect(f.service.start(A, { ...consent, control: true })).rejects.toThrow()
    await expect(f.service.start(A, consent)).rejects.toThrow('deny')
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
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true })
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
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A })
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
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true })
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
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A, budget: { captures: 1, frameBytes: 3 } })
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
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A, consent: { capture: false, upload: false, control: false } })
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
    expect(f.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, owner: A, consent: { capture: false } })
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
