import { describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_USE_KEYS, COMPUTER_USE_LIMITS, DEFAULT_COMPUTER_USE_CAPABILITY,
  DEFAULT_COMPUTER_USE_CONSENT, createDisabledComputerUseStatus,
  normalizeComputerUseFrame, normalizeComputerUseStatus, reserveComputerUseAction,
  reserveComputerUseCapture, sameComputerUseOwner, validateComputerUseAction,
  validateComputerUseActRequest, validateComputerUseBudget, validateComputerUseCapability,
  validateComputerUseConsent, validateComputerUseFrame, validateComputerUseModelImage,
  validateComputerUseOwner, validateComputerUseReceipt, validateComputerUseStatus,
  type ComputerUseFrame, type ComputerUseOwner
} from '../../src/shared/computer-use'

// Pure fixtures only. These checks do not launch an OS helper, SDK or image decoder.
const owner: ComputerUseOwner = { ownerWindowId: 1, backendId: 'backend-1', runtimeId: 'runtime-1', runId: 'run-1', generation: 1 }
const frame: ComputerUseFrame = { id: 'frame-1', width: 800, height: 600, createdAt: 10.25, scopeRevision: 1, captureScope: 'unknown-window-or-display', actualScope: 'unknown-window-or-display' }
const receipt = { requestId: 'request-1', actionId: 'action-1', toolCallId: 'call-1', frameId: 'frame-1', scopeRevision: 1, status: 'executed', actualPending: false }
const emptyBudget = { actions: 0, captures: 0, frameBytes: 0, framePixels: 0 }

describe('ComputerUse pure fixed contracts', () => {
  it('defaults to disabled, unknown Wayland scope and independently denied consents', () => {
    const status = createDisabledComputerUseStatus()
    expect(validateComputerUseStatus(status)).toEqual(status)
    expect(status.state).toBe('disabled')
    expect(status.consent).toEqual({ capture: false, upload: false, retention: 'sdk-session', control: false })
    expect(status.capability).toMatchObject({ platform: 'linux-wayland', method: 'unavailable', capture: false, control: false, scope: 'unknown-window-or-display', unsupportedReason: 'not-probed' })
    status.budget.actions = 1
    status.consent!.control = true
    expect(createDisabledComputerUseStatus().budget.actions).toBe(0)
    expect(DEFAULT_COMPUTER_USE_CONSENT.control).toBe(false)
    expect(Object.isFrozen(COMPUTER_USE_LIMITS)).toBe(true)
    expect(COMPUTER_USE_LIMITS.maxActions).toBe(40)
    expect(COMPUTER_USE_LIMITS.maxCaptures).toBe(80)
    expect(COMPUTER_USE_LIMITS.maxDurationMs).toBe(600_000)
  })

  it('copies complete owner identities and compares every incarnation field, not a nonce', () => {
    expect(validateComputerUseOwner(owner)).toEqual(owner)
    expect(validateComputerUseOwner(owner)).not.toBe(owner)
    expect(sameComputerUseOwner(owner, { ...owner })).toBe(true)
    for (const changed of [{ ownerWindowId: 2 }, { backendId: 'other' }, { runtimeId: 'other' }, { runId: 'other' }, { generation: 2 }]) {
      expect(sameComputerUseOwner(owner, { ...owner, ...changed })).toBe(false)
    }
    for (const invalid of [null, [], { ...owner, generation: NaN }, { ...owner, ownerWindowId: 0 }, { ...owner, backendId: 'a'.repeat(257) }, { ...owner, nonce: 'auth' }]) {
      expect(() => validateComputerUseOwner(invalid)).toThrow()
    }
  })

  it('never coerces consent or infers upload/control from capture', () => {
    expect(validateComputerUseConsent({ ...DEFAULT_COMPUTER_USE_CONSENT, capture: true })).toEqual({ capture: true, upload: false, retention: 'sdk-session', control: false })
    for (const invalid of [{ ...DEFAULT_COMPUTER_USE_CONSENT, capture: 'true' }, { ...DEFAULT_COMPUTER_USE_CONSENT, retention: 'memory-only' }, { ...DEFAULT_COMPUTER_USE_CONSENT, alwaysAllow: true }]) {
      expect(() => validateComputerUseConsent(invalid)).toThrow()
    }
  })

  it('declares real capture/control support independently and rejects impossible methods', () => {
    expect(validateComputerUseCapability(DEFAULT_COMPUTER_USE_CAPABILITY)).toEqual(DEFAULT_COMPUTER_USE_CAPABILITY)
    expect(validateComputerUseCapability({ platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, scope: 'display', unsupportedReason: 'control-unavailable' })).toMatchObject({ capture: true, control: false })
    for (const invalid of [
      { ...DEFAULT_COMPUTER_USE_CAPABILITY, platform: 'linux-x11' },
      { ...DEFAULT_COMPUTER_USE_CAPABILITY, method: 'shell' },
      { ...DEFAULT_COMPUTER_USE_CAPABILITY, capture: true },
      { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: true, scope: 'window' },
      { platform: 'linux-wayland', method: 'portal-remote-desktop', capture: false, control: false, scope: 'window' }
    ]) expect(() => validateComputerUseCapability(invalid)).toThrow()
  })

  it('accepts only single fixed actions in frame image pixels and exact key combinations', () => {
    const valid = [
      { type: 'click', x: 0, y: 599, button: 'left' },
      { type: 'scroll', x: 799, y: 0, deltaX: -1200, deltaY: 1200 },
      { type: 'type', text: '中文😀\n' }
    ]
    for (const value of valid) expect(validateComputerUseAction(value, frame)).toEqual(value)
    for (const keys of COMPUTER_USE_KEYS) expect(validateComputerUseAction({ type: 'key', keys }, frame)).toEqual({ type: 'key', keys })
    expect(validateComputerUseActRequest({ frameId: frame.id, action: valid[0] }, frame)).toEqual({ frameId: frame.id, action: valid[0] })
    for (const invalid of [
      { type: 'click', x: NaN, y: 0, button: 'left' }, { type: 'click', x: Infinity, y: 0, button: 'left' },
      { type: 'click', x: 0.1, y: 0, button: 'left' }, { type: 'click', x: -1, y: 0, button: 'left' },
      { type: 'click', x: 800, y: 0, button: 'left' }, { type: 'click', x: 0, y: 600, button: 'left' },
      { type: 'click', x: '1', y: 0, button: 'left' }, { type: 'click', x: 0, y: 0, button: 'right' },
      { type: 'click', x: 0, y: 0, button: 'left', text: 'ignored' },
      { type: 'scroll', x: 0, y: 0, deltaX: 1201, deltaY: 0 },
      { type: 'key', keys: 'Super+Return' }, { type: 'key', keys: ['Enter'] },
      { type: 'key', keys: 'Control+v' }, { type: 'type', text: '' },
      { type: 'type', text: '\ud800' }, { type: 'type', text: 'secret\0text' },
      { type: 'eval', code: 'run()' }, { type: 'shell', command: 'echo example' },
      { type: 'keyDown', keys: 'Enter' }, { type: 'type', text: 'ok', path: '/tmp/example' }
    ]) expect(() => validateComputerUseAction(invalid, frame)).toThrow()
    expect(() => validateComputerUseActRequest({ frameId: 'old-frame', action: valid[0] }, frame)).toThrow()
    expect(() => validateComputerUseActRequest({ frameId: frame.id, action: valid[0], owner }, frame)).toThrow()
  })

  it('rejects the entire oversized UTF-8 action before any partial normalization', () => {
    expect(validateComputerUseAction({ type: 'type', text: 'a'.repeat(4096) }, frame)).toMatchObject({ type: 'type' })
    expect(() => validateComputerUseAction({ type: 'type', text: '中'.repeat(1366) }, frame)).toThrow()
    // JSON escape expansion must also fit the whole payload budget.
    expect(() => validateComputerUseAction({ type: 'type', text: '\u0001'.repeat(4096) }, frame)).toThrow()
    const withGetter = { type: 'type', get text() { throw new Error('getter should not run') } }
    expect(() => validateComputerUseAction(withGetter, frame)).toThrow('Invalid ComputerUse contract')
    expect(() => validateComputerUseAction(Object.assign(Object.create({ type: 'type' }), { text: 'ok' }), frame)).toThrow()
    expect(() => validateComputerUseAction({ type: 'type', text: 'ok', [Symbol('hidden')]: 'unknown' }, frame)).toThrow()
  })

  it('keeps actual capture scope explicit without claiming window identity or OS mapping', () => {
    const copy = validateComputerUseFrame({ ...frame, windowId: 'window-1', displayId: 'display-1' })
    expect(copy.actualScope).toBe('unknown-window-or-display')
    expect(copy.createdAt).toBe(10.25)
    for (const invalid of [{ ...frame, createdAt: -1 }, { ...frame, createdAt: Infinity }, { ...frame, width: 4097 }, { ...frame, width: 4096, height: 4096 }, { ...frame, osX: -100 }, { ...frame, image: 'data:image/png;base64,raw' }]) {
      expect(normalizeComputerUseFrame(invalid)).toBeUndefined()
    }
    expect(normalizeComputerUseFrame(frame)).toEqual(frame)
  })

  it('has separate capture, byte, pixel and action budgets that cannot be refunded', () => {
    expect(reserveComputerUseCapture(emptyBudget, 100, 200)).toEqual({ actions: 0, captures: 1, frameBytes: 100, framePixels: 200 })
    expect(emptyBudget).toEqual({ actions: 0, captures: 0, frameBytes: 0, framePixels: 0 })
    expect(reserveComputerUseAction(emptyBudget).actions).toBe(1)
    for (const budget of [
      { ...emptyBudget, captures: COMPUTER_USE_LIMITS.maxCaptures },
      { ...emptyBudget, frameBytes: COMPUTER_USE_LIMITS.maxTotalFrameBytes },
      { ...emptyBudget, framePixels: COMPUTER_USE_LIMITS.maxTotalFramePixels }
    ]) expect(() => reserveComputerUseCapture(budget, 1, 1)).toThrow()
    expect(() => reserveComputerUseCapture(emptyBudget, COMPUTER_USE_LIMITS.maxFrameBytes + 1, 1)).toThrow()
    expect(() => reserveComputerUseCapture(emptyBudget, 1, COMPUTER_USE_LIMITS.maxFramePixels + 1)).toThrow()
    expect(() => reserveComputerUseAction({ ...emptyBudget, actions: 40 })).toThrow()
    expect(() => validateComputerUseBudget({ ...emptyBudget, captures: -1 })).toThrow()
  })

  it.each(['frameBytes', 'framePixels'] as const)('permits exact remaining %s independently but rejects a one-unit excess', field => {
    const cap = field === 'frameBytes' ? COMPUTER_USE_LIMITS.maxTotalFrameBytes : COMPUTER_USE_LIMITS.maxTotalFramePixels
    const budget = { ...emptyBudget, [field]: cap - 2 }
    const exact = reserveComputerUseCapture(budget, field === 'frameBytes' ? 2 : 1, field === 'framePixels' ? 2 : 1)
    expect(exact[field]).toBe(cap)
    expect(exact.captures).toBe(1)
    expect(() => reserveComputerUseCapture(budget, field === 'frameBytes' ? 3 : 1, field === 'framePixels' ? 3 : 1)).toThrow()
    expect(() => reserveComputerUseCapture(exact, 1, 1)).toThrow()
    expect(budget[field]).toBe(cap - 2)
  })

  it('does not turn timeout, interruption or actual pending into executed success', () => {
    expect(validateComputerUseReceipt(receipt)).toEqual(receipt)
    for (const status of ['failed', 'interrupted', 'outcome-unknown']) {
      expect(validateComputerUseReceipt({ ...receipt, status, actualPending: true })).toMatchObject({ status, actualPending: true })
    }
    for (const invalid of [{ ...receipt, status: 'success' }, { ...receipt, actualPending: true }, { ...receipt, status: 'rejected-before-execution', actualPending: true }, { ...receipt, rawResult: 'private' }]) {
      expect(() => validateComputerUseReceipt(invalid)).toThrow()
    }
    const status = { ...createDisabledComputerUseStatus(), state: 'quarantined', scopeRevision: 1, actualPending: true, owner, receipt: { ...receipt, status: 'outcome-unknown', actualPending: true } }
    expect(normalizeComputerUseStatus(status)).toEqual(status)
    for (const invalid of [{ ...status, state: 'stopped' }, { ...status, actualPending: false }, { ...status, scopeRevision: 2 }]) expect(normalizeComputerUseStatus(invalid)).toBeUndefined()
  })

  it('fails closed on raw diagnostic/images in bounded status rather than passing through', () => {
    const status = { ...createDisabledComputerUseStatus(), state: 'ready', scopeRevision: 1, owner, frame, receipt }
    const copy = validateComputerUseStatus(status)
    expect(copy).toEqual(status)
    expect(copy.owner).not.toBe(owner)
    expect(copy.frame).not.toBe(frame)
    for (const invalid of [{ ...status, base64: 'raw' }, { ...status, images: [] }, { ...status, action: { type: 'type', text: 'secret' } }, { ...status, owner: { ...owner, token: 'secret' } }, { ...status, frame: { ...frame, bytes: new Uint8Array([1]) } }, { ...status, scopeRevision: 0 }]) {
      expect(normalizeComputerUseStatus(invalid)).toBeUndefined()
    }
  })

  it('rejects prototypes, accessors, symbols and non-enumerable fields at every status boundary', () => {
    const status = { ...createDisabledComputerUseStatus(), state: 'ready', scopeRevision: 1, owner, frame, receipt }
    const getter = vi.fn(() => 'ready')
    const accessor = { ...status }
    Object.defineProperty(accessor, 'state', { enumerable: true, get: getter })
    const hidden = { ...status }
    Object.defineProperty(hidden, 'debug', { enumerable: false, value: 'private' })
    for (const invalid of [
      Object.assign(Object.create({ inherited: true }), status), accessor, hidden,
      { ...status, [Symbol('private')]: 'secret' },
      { ...status, owner: Object.assign(Object.create(owner), owner) },
      { ...status, budget: { ...emptyBudget, captures: '0' } },
      { ...status, consent: { ...DEFAULT_COMPUTER_USE_CONSENT, upload: 1 } },
      { ...status, capability: { ...DEFAULT_COMPUTER_USE_CAPABILITY, diagnostic: 'raw' } },
      { ...status, frame: { ...frame, createdAt: NaN } },
      { ...status, receipt: { ...receipt, actualPending: 'false' } }
    ]) expect(normalizeComputerUseStatus(invalid)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(normalizeComputerUseStatus(Object.assign(Object.create(null), status))).toEqual(status)
  })

  it('admits equality at each reservation cap and rejects only the next reservation', () => {
    const atCap = reserveComputerUseCapture({
      actions: 0, captures: COMPUTER_USE_LIMITS.maxCaptures - 1,
      frameBytes: COMPUTER_USE_LIMITS.maxTotalFrameBytes - COMPUTER_USE_LIMITS.maxFrameBytes,
      framePixels: COMPUTER_USE_LIMITS.maxTotalFramePixels - COMPUTER_USE_LIMITS.maxFramePixels
    }, COMPUTER_USE_LIMITS.maxFrameBytes, COMPUTER_USE_LIMITS.maxFramePixels)
    expect(atCap).toEqual({ actions: 0, captures: COMPUTER_USE_LIMITS.maxCaptures,
      frameBytes: COMPUTER_USE_LIMITS.maxTotalFrameBytes, framePixels: COMPUTER_USE_LIMITS.maxTotalFramePixels })
    expect(() => reserveComputerUseCapture(atCap, 1, 1)).toThrow()
    expect(reserveComputerUseAction({ ...emptyBudget, actions: COMPUTER_USE_LIMITS.maxActions - 1 }).actions).toBe(COMPUTER_USE_LIMITS.maxActions)
    for (const createdAt of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) {
      expect(normalizeComputerUseFrame({ ...frame, createdAt })).toBeUndefined()
    }
  })

  it('clones all nested status records without leaking consent or receipt mutations', () => {
    const status = { ...createDisabledComputerUseStatus(), state: 'ready', scopeRevision: 1, owner: { ...owner }, frame: { ...frame }, receipt: { ...receipt } }
    const copy = validateComputerUseStatus(status)
    copy.owner!.generation++
    copy.consent!.control = true
    copy.capability!.capture = true
    copy.frame!.width = 1
    copy.receipt!.actualPending = true
    copy.budget.captures++
    expect(validateComputerUseStatus(status)).toEqual(status)
    expect(status.owner.generation).toBe(owner.generation)
    expect(status.consent!.control).toBe(false)
    expect(status.capability!.capture).toBe(false)
    expect(status.frame.width).toBe(frame.width)
    expect(status.receipt.actualPending).toBe(false)
    expect(status.budget.captures).toBe(0)
  })

  it('keeps the separately bounded model image transport out of UI status', () => {
    const bytes = new Uint8Array([1, 2, 3]) // Admission fixture, NOT a valid PNG.
    const image = { frameId: frame.id, mimeType: 'image/png', bytes }
    const copy = validateComputerUseModelImage(image, frame)
    bytes[0] = 9
    expect(copy.bytes[0]).toBe(1)
    for (const invalid of [{ ...image, frameId: 'other' }, { ...image, mimeType: 'image/svg+xml' }, { ...image, bytes: new Uint8Array() }, { ...image, bytes: new Uint8Array(COMPUTER_USE_LIMITS.maxFrameBytes + 1) }, { ...image, path: '/tmp/frame.png' }, { ...image, base64: 'raw' }]) {
      expect(() => validateComputerUseModelImage(invalid, frame)).toThrow()
    }
    expect(normalizeComputerUseStatus({ ...createDisabledComputerUseStatus(), modelImage: image })).toBeUndefined()
    // Neither raw image nor display thumbnail grants model/control authority.
    for (const key of ['png', 'previewPng', 'preview', 'modelImage']) {
      expect(normalizeComputerUseStatus({ ...createDisabledComputerUseStatus(), [key]: bytes })).toBeUndefined()
    }
  })
})
