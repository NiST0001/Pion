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
import { COMPUTER_USE_DIAGNOSTIC_CODES, NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST, copyComputerUseDiagnostics } from '../../src/shared/computer-use-diagnostics'

// Pure fixtures only. These checks do not launch an OS helper, SDK or image decoder.
const owner: ComputerUseOwner = { ownerWindowId: 1, backendId: 'backend-1', runtimeId: 'runtime-1', runId: 'run-1', generation: 1 }
const frame: ComputerUseFrame = { id: 'frame-1', width: 800, height: 600, createdAt: 10.25, scopeRevision: 1, captureScope: 'unknown-window-or-display', actualScope: 'unknown-window-or-display' }
const receipt = { requestId: 'request-1', actionId: 'action-1', toolCallId: 'call-1', frameId: 'frame-1', scopeRevision: 1, status: 'executed', actualPending: false }
const emptyBudget = { actions: 0, captures: 0, frameBytes: 0, framePixels: 0 }

describe('ComputerUse pure fixed contracts', () => {
  it('copies only explicit boolean development configuration without granting capability or consent', () => {
    const disabled = createDisabledComputerUseStatus()
    expect(disabled.inputDevelopmentEnabled).toBe(false)
    const { inputDevelopmentEnabled: _enabled, ...legacy } = disabled
    expect(validateComputerUseStatus(legacy).inputDevelopmentEnabled).not.toBe(true)
    for (const inputDevelopmentEnabled of [false, true]) {
      const copy = validateComputerUseStatus({ ...disabled, inputDevelopmentEnabled })
      expect(copy.inputDevelopmentEnabled).toBe(inputDevelopmentEnabled)
      expect(copy.consent).toEqual(DEFAULT_COMPUTER_USE_CONSENT)
      expect(copy.capability).toEqual(DEFAULT_COMPUTER_USE_CAPABILITY)
    }
    for (const inputDevelopmentEnabled of [undefined, null, 0, 1, 'true', {}, []]) {
      expect(normalizeComputerUseStatus({ ...disabled, inputDevelopmentEnabled })).toBeUndefined()
    }
    const getter = vi.fn(() => true)
    const accessor = Object.defineProperty(disabled, 'inputDevelopmentEnabled', { enumerable: true, get: getter })
    expect(normalizeComputerUseStatus(accessor)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })
  it('copies explicit DMA-BUF configuration only, with legacy omission disabled and no inferred grants', () => {
    const disabled = createDisabledComputerUseStatus()
    expect(disabled.dmaBufDevelopmentEnabled).toBe(false)
    const { dmaBufDevelopmentEnabled: _enabled, ...legacy } = disabled
    expect(validateComputerUseStatus(legacy).dmaBufDevelopmentEnabled).not.toBe(true)
    for (const dmaBufDevelopmentEnabled of [false, true]) {
      const copy = validateComputerUseStatus({ ...disabled, dmaBufDevelopmentEnabled })
      expect(copy.dmaBufDevelopmentEnabled).toBe(dmaBufDevelopmentEnabled)
      expect(copy.consent).toEqual(DEFAULT_COMPUTER_USE_CONSENT)
      expect(copy.capability).toEqual(DEFAULT_COMPUTER_USE_CAPABILITY)
      expect(copy).toMatchObject({ state: 'disabled', actualPending: false, coordination: 'not-checked' })
    }
    for (const dmaBufDevelopmentEnabled of [undefined, null, 0, 1, 'true', {}, []]) {
      expect(normalizeComputerUseStatus({ ...disabled, dmaBufDevelopmentEnabled })).toBeUndefined()
    }
    const getter = vi.fn(() => true)
    expect(normalizeComputerUseStatus(Object.defineProperty(disabled, 'dmaBufDevelopmentEnabled', { enumerable: true, get: getter }))).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })
  it('keeps the native request diagnostic matrix exact and immutable', () => {
    expect(NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST).toEqual({
      hello: ['request-state-invalid'],
      open: ['portal-connect-failed', 'window-selection-failed', 'selection-not-deliverable',
        'pipewire-start-failed', 'post-start-not-deliverable', 'request-state-invalid', 'display-selection-failed', 'input-open-failed'],
      capture: ['capture-frame-failed', 'selection-not-deliverable', 'request-state-invalid'],
      act: ['input-action-failed'],
      close: ['pipewire-stop-failed', 'portal-close-failed', 'both-stop-failed', 'input-stop-failed']
    })
    expect(Object.isFrozen(NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST)).toBe(true)
    for (const codes of Object.values(NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST)) expect(Object.isFrozen(codes)).toBe(true)
  })
  it('copies only four fixed diagnostic slots and the exact bounded codes', () => {
    expect(COMPUTER_USE_DIAGNOSTIC_CODES).toEqual([
      'portal-connect-failed', 'window-selection-failed', 'selection-not-deliverable',
      'pipewire-start-failed', 'post-start-not-deliverable', 'capture-frame-failed',
      'pipewire-stop-failed', 'portal-close-failed', 'both-stop-failed', 'request-state-invalid',
      'display-selection-failed', 'input-open-failed', 'input-action-failed', 'input-stop-failed',
      'helper-protocol-invalid', 'helper-exit-unverified', 'helper-transport-error', 'helper-preview-invalid'
    ])
    expect(Object.isFrozen(COMPUTER_USE_DIAGNOSTIC_CODES)).toBe(true)
    for (const slot of ['open', 'capture', 'act', 'close'] as const) {
      for (const code of COMPUTER_USE_DIAGNOSTIC_CODES) {
        const diagnostics = { [slot]: code }
        const copy = copyComputerUseDiagnostics(diagnostics)
        expect(copy).toEqual(diagnostics)
        expect(copy).not.toBe(diagnostics)
        expect(validateComputerUseStatus({ ...createDisabledComputerUseStatus(), diagnostics }).diagnostics).toEqual(diagnostics)
      }
    }
    expect(copyComputerUseDiagnostics({})).toEqual({})
    expect(copyComputerUseDiagnostics(Object.assign(Object.create(null), { open: 'portal-connect-failed' })))
      .toEqual({ open: 'portal-connect-failed' })
  })

  it('deep-copies diagnostics without changing coordination, pending, receipt or consent', () => {
    const diagnostics = { open: 'pipewire-start-failed', capture: 'capture-frame-failed', close: 'portal-close-failed' }
    const status = { ...createDisabledComputerUseStatus(), state: 'quarantined', coordination: 'held',
      scopeRevision: 1, actualPending: true, owner: { ...owner },
      receipt: { ...receipt, status: 'outcome-unknown', actualPending: true }, diagnostics }
    const copy = validateComputerUseStatus(status)
    expect(copy).toEqual(status)
    expect(copy.diagnostics).not.toBe(diagnostics)
    expect(Reflect.ownKeys(copy.diagnostics!)).toEqual(['open', 'capture', 'close'])
    expect(copy.consent).not.toBe(status.consent)
    expect(copy.receipt).not.toBe(status.receipt)
    const { diagnostics: _diagnostics, ...withoutDiagnostics } = copy
    const { diagnostics: _inputDiagnostics, ...legacyStatus } = status
    expect(withoutDiagnostics).toEqual(validateComputerUseStatus(legacyStatus))
    copy.diagnostics!.open = 'helper-protocol-invalid'
    diagnostics.close = 'both-stop-failed'
    expect(diagnostics.open).toBe('pipewire-start-failed')
    expect(copy.diagnostics!.close).toBe('portal-close-failed')
    expect(copy).toMatchObject({ state: 'quarantined', coordination: 'held', actualPending: true,
      consent: DEFAULT_COMPUTER_USE_CONSENT, receipt: { status: 'outcome-unknown', actualPending: true } })
    for (const invalid of [{ ...status, state: 'stopped' }, { ...status, state: 'ready' },
      { ...status, actualPending: false }]) expect(normalizeComputerUseStatus(invalid)).toBeUndefined()
    const legacy = createDisabledComputerUseStatus()
    expect(validateComputerUseStatus(legacy)).toEqual(legacy)
    expect(Object.hasOwn(validateComputerUseStatus(legacy), 'diagnostics')).toBe(false)
  })

  it('rejects all raw diagnostic data, unknown fields and codes without invoking accessors', () => {
    const getter = vi.fn(() => 'portal-connect-failed')
    const accessor = Object.defineProperty({}, 'open', { enumerable: true, get: getter })
    const invalidDiagnostics = [
      undefined, null, true, 1, 'portal-connect-failed', [], ['portal-connect-failed'],
      Object.assign(Object.create({ inherited: true }), { open: 'portal-connect-failed' }), accessor,
      Object.defineProperty({}, 'open', { value: 'portal-connect-failed', enumerable: false }),
      { open: undefined }, { capture: null }, { close: ['portal-close-failed'] },
      { open: 'unknown-code' }, { open: '/home/private/frame.png' },
      { capture: 'file:///home/private/frame.png' }, { close: 'Error: private native failure' },
      { open: 'portal-connect-failed', rawFilename: '/home/private/frame.png' },
      { open: 'portal-connect-failed', uri: 'file:///home/private/frame.png' },
      { close: 'portal-close-failed', error: 'private native failure' },
      { open: 'portal-connect-failed', other: 'helper-transport-error' },
      { open: 'portal-connect-failed', [Symbol('private')]: 'secret' }
    ]
    for (const diagnostics of invalidDiagnostics) {
      expect(copyComputerUseDiagnostics(diagnostics)).toBeUndefined()
      const status = { ...createDisabledComputerUseStatus(), diagnostics }
      expect(() => validateComputerUseStatus(status)).toThrow('Invalid ComputerUse contract')
      expect(normalizeComputerUseStatus(status)).toBeUndefined()
    }
    const statusGetter = vi.fn(() => ({ open: 'portal-connect-failed' }))
    const accessorStatus = Object.defineProperty(createDisabledComputerUseStatus(), 'diagnostics', {
      enumerable: true, get: statusGetter
    })
    expect(() => validateComputerUseStatus(accessorStatus)).toThrow('Invalid ComputerUse contract')
    expect(normalizeComputerUseStatus(accessorStatus)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(statusGetter).not.toHaveBeenCalled()
  })

  it('copies only the bounded coordination enum and treats missing legacy metadata as unchecked', () => {
    const status = createDisabledComputerUseStatus()
    const { coordination: _coordination, ...legacy } = status
    expect(validateComputerUseStatus(legacy)).toEqual(status)
    for (const coordination of ['not-checked', 'held', 'blocked', 'unknown', 'released', 'unclaimed']) {
      const input = { ...status, coordination }
      const copy = validateComputerUseStatus(input)
      expect(copy).toEqual(input)
      expect(copy).not.toBe(input)
    }
    for (const coordination of [undefined, null, true, 1, '', 'active', {}, { receipt: 'secret' }]) {
      expect(normalizeComputerUseStatus({ ...status, coordination })).toBeUndefined()
    }
    const getter = vi.fn(() => 'held')
    const accessor = { ...status }
    Object.defineProperty(accessor, 'coordination', { enumerable: true, get: getter })
    expect(normalizeComputerUseStatus(accessor)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    for (const extra of [{ lockPath: '/home/user/marker' }, { coordinationReceipt: 'secret' },
      { pid: 123 }, { token: 'secret' }, { [Symbol('receipt')]: 'secret' }]) {
      expect(normalizeComputerUseStatus({ ...status, ...extra })).toBeUndefined()
    }
  })

  it('defaults to disabled, unknown Wayland scope and independently denied consents', () => {
    const status = createDisabledComputerUseStatus()
    expect(validateComputerUseStatus(status)).toEqual(status)
    expect(status.state).toBe('disabled')
    expect(status.coordination).toBe('not-checked')
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
