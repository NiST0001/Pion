import { describe, expect, it, vi } from 'vitest'
import { COMPUTER_USE_LIMITS as L } from '../../src/shared/computer-use'
import { ComputerUseInputPolicy, type ComputerUseInputContext } from '../../src/main/computer-use/input-policy'

const owner = { ownerWindowId: 1, backendId: 'backend', runtimeId: 'runtime', runId: 'run', generation: 1 }
const frame = { id: 'frame-1', width: 100, height: 80, createdAt: 100, scopeRevision: 1, captureScope: 'display', actualScope: 'display' }
const native = { sourceType: 'display', width: 100, height: 80, inputFrame: { sequence: 1, topology: 1 } }
const request = { frameId: frame.id, action: { type: 'click', x: 99, y: 79, button: 'left' } }
function context(): ComputerUseInputContext {
  return { now: 100, startedAt: 0, consent: { capture: true, upload: false, control: true, retention: 'sdk-session', captureScope: 'display' }, capability: { platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' }, budget: { actions: 0, captures: 1, frameBytes: 200, framePixels: 8000 }, assertAllowed: vi.fn() }
}
function setup() {
  const policy = new ComputerUseInputPolicy()
  policy.install(owner, 1, frame, native)
  return policy
}

describe('ComputerUseInputPolicy (pure host frame admission, not native input)', () => {
  it('constructs without callbacks, OS or SDK; returns copied action/fence and reserves only action count', () => {
    const policy = setup(), ctx = context()
    const result = policy.reserve(owner, 1, request, ctx)
    expect(result).toEqual({ action: request.action, nativeFence: { sequence: 1, topology: 1 }, budget: { ...ctx.budget, actions: 1 } })
    expect(result.action).not.toBe(request.action)
    expect(ctx.budget.actions).toBe(0)
    expect(ctx.assertAllowed).toHaveBeenCalledTimes(2)
    result.nativeFence.sequence = 999
    expect(native.inputFrame.sequence).toBe(1)
    expect(new TextEncoder().encode(JSON.stringify(result.action)).byteLength).toBeLessThanOrEqual(8192)
    expect(() => policy.reserve(owner, 1, request, ctx)).toThrow()
  })

  it.each([
    { consent: { ...context().consent, capture: false } },
    { consent: { ...context().consent, control: false } },
    { consent: { ...context().consent, captureScope: undefined } },
    { capability: { ...context().capability, scope: 'window' } },
    { capability: { ...context().capability, control: false } },
    { capability: { ...context().capability, method: 'portal-screencast' } },
    { budget: { ...context().budget, actions: L.maxActions } },
    { now: L.maxDurationMs }, { now: 99 }, { now: 100 + L.frameMaxAgeMs + 1 }
  ])('rejects trusted-context gate %j', patch => {
    expect(() => setup().reserve(owner, 1, request, { ...context(), ...patch })).toThrow()
  })

  it('accepts exact frame age boundary and upload false manual control', () => {
    expect(setup().reserve(owner, 1, request, { ...context(), now: 100 + L.frameMaxAgeMs }).budget.actions).toBe(1)
  })

  it('foreign owner/scope/old frame errors cannot consume the current slot', () => {
    const policy = setup()
    expect(() => policy.reserve({ ...owner, generation: 2 }, 1, request, context())).toThrow()
    expect(() => policy.reserve(owner, 2, request, context())).toThrow()
    expect(() => policy.reserve(owner, 1, { ...request, frameId: 'old' }, context())).toThrow()
    expect(policy.reserve(owner, 1, request, context()).action).toEqual(request.action)
  })

  it('fences A-B-A identities and retired scopes even after clear', () => {
    const policy = setup(), next = { ...owner, generation: 2 }
    policy.install(next, 2, { ...frame, id: 'frame-2', scopeRevision: 2 }, native)
    expect(() => policy.install(owner, 1, frame, native)).toThrow()
    expect(() => policy.revoke(owner, 1)).not.toThrow()
    expect(policy.reserve(next, 2, { ...request, frameId: 'frame-2' }, context()).budget.actions).toBe(1)
    policy.clear()
    expect(() => policy.install(next, 2, { ...frame, scopeRevision: 2 }, native)).toThrow()
  })

  it('does not revive consumed ids or sequences and preserves new frames on bad installation', () => {
    const policy = setup()
    policy.reserve(owner, 1, request, context())
    expect(() => policy.install(owner, 1, frame, { ...native, inputFrame: { sequence: 2, topology: 1 } })).toThrow()
    expect(() => policy.install(owner, 1, { ...frame, id: 'frame-2' }, native)).toThrow()
    policy.install(owner, 1, { ...frame, id: 'frame-2' }, { ...native, inputFrame: { sequence: 2, topology: 1 } })
    expect(() => policy.install(owner, 1, frame, native)).toThrow()
    expect(policy.reserve(owner, 1, { ...request, frameId: 'frame-2' }, context()).nativeFence.sequence).toBe(2)
  })

  it.each([
    { ...native, sourceType: 'window' }, { ...native, width: 99 },
    { ...native, crop: true }, { ...native, inputFrame: undefined },
    { ...native, inputFrame: { sequence: 0, topology: 1 } },
    { ...native, inputFrame: { sequence: 1, topology: 1, extra: true } }
  ])('rejects invalid private native descriptor %j', descriptor => {
    expect(() => new ComputerUseInputPolicy().install(owner, 1, frame, descriptor)).toThrow()
  })

  it('rejects window/unknown scopes and accessors without executing getters', () => {
    const getter = vi.fn(() => 1)
    const fence = Object.defineProperty({ topology: 1 }, 'sequence', { get: getter, enumerable: true })
    expect(() => new ComputerUseInputPolicy().install(owner, 1, frame, { ...native, inputFrame: fence })).toThrow()
    expect(getter).not.toHaveBeenCalled()
    for (const scope of ['window', 'unknown-window-or-display']) {
      expect(() => new ComputerUseInputPolicy().install(owner, 1, { ...frame, captureScope: scope }, native)).toThrow()
    }
    expect(() => new ComputerUseInputPolicy().install(owner, 1, frame, Object.create(native))).toThrow()
  })

  it.each(['你好', 'a\nb', '\u001b[A', 'a\tb', '\u007f', '🙂'])('rejects unsupported text without silently dropping characters: %j', text => {
    expect(() => setup().reserve(owner, 1, { frameId: frame.id, action: { type: 'type', text } }, context())).toThrow()
  })

  it('rejects frame/action accessors and exotic prototypes without running them', () => {
    const getter = vi.fn(() => 100)
    const badFrame = Object.defineProperty({ ...frame }, 'width', { enumerable: true, get: getter })
    expect(() => new ComputerUseInputPolicy().install(owner, 1, badFrame, native)).toThrow()
    const badAction = Object.defineProperty({ type: 'type' }, 'text', { enumerable: true, get: getter })
    expect(() => setup().reserve(owner, 1, { frameId: frame.id, action: badAction }, context())).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects topology changes, invalid revisions and nonfinite clocks', () => {
    const policy = setup()
    expect(() => policy.install(owner, 1, { ...frame, id: 'next' }, { ...native, inputFrame: { sequence: 2, topology: 2 } })).toThrow()
    expect(() => policy.install(owner, 0, { ...frame, scopeRevision: 0 }, native)).toThrow()
    for (const now of [NaN, Infinity, -1]) expect(() => setup().reserve(owner, 1, request, { ...context(), now })).toThrow()
    expect(policy.reserve(owner, 1, request, context()).nativeFence.topology).toBe(1)
  })

  it('bounds retained frame identities by the real capture limit', () => {
    const policy = new ComputerUseInputPolicy()
    for (let sequence = 1; sequence <= L.maxCaptures; sequence++) {
      policy.install(owner, 1, { ...frame, id: `frame-${sequence}` }, { ...native, inputFrame: { sequence, topology: 1 } })
    }
    expect(() => policy.install(owner, 1, { ...frame, id: 'overflow' }, { ...native, inputFrame: { sequence: L.maxCaptures + 1, topology: 1 } })).toThrow()
  })

  it('supports printable ASCII, named keys and bounded scroll, never added request context', () => {
    for (const action of [{ type: 'type', text: 'Hello, "world"! ~' }, { type: 'key', keys: 'Shift+Tab' }, { type: 'scroll', x: 0, y: 0, deltaX: -1, deltaY: 1200 }]) {
      expect(setup().reserve(owner, 1, { frameId: frame.id, action }, context()).action).toEqual(action)
    }
    expect(() => setup().reserve(owner, 1, { ...request, nativeFence: { sequence: 9, topology: 9 } }, context())).toThrow()
  })

  it('burns the slot before callback failure/unknown dispatch and never rolls back budget', () => {
    const policy = setup(), ctx = context()
    ctx.assertAllowed = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('deny') })
    expect(() => policy.reserve(owner, 1, request, ctx)).toThrow()
    expect(() => policy.reserve(owner, 1, request, context())).toThrow()
    expect(ctx.budget.actions).toBe(0) // No driver dispatch happened; service owns committing returned budget.
  })

  it('detects reentrant revocation and backward clocks, without resurrecting leases', () => {
    const policy = setup(), ctx = context()
    ctx.assertAllowed = () => policy.revoke(owner, 1)
    expect(() => policy.reserve(owner, 1, request, ctx)).toThrow()
    expect(() => policy.install(owner, 1, frame, native)).toThrow()
    const second = setup()
    second.reserve(owner, 1, request, { ...context(), now: 200 })
    second.install(owner, 1, { ...frame, id: 'frame-2', createdAt: 150 }, { ...native, inputFrame: { sequence: 2, topology: 1 } })
    expect(() => second.reserve(owner, 1, { ...request, frameId: 'frame-2' }, { ...context(), now: 150 })).toThrow()
  })
})
