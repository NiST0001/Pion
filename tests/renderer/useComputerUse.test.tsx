// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useComputerUse } from '../../src/renderer/src/hooks/useComputerUse'
import { createDisabledComputerUseStatus, COMPUTER_USE_LIMITS } from '../../src/shared/computer-use'
import { ComputerUseService } from '../../src/main/computer-use/service'
import type { ComputerUseCoordination, ComputerUseCoordinationClaim } from '../../src/main/computer-use/coordination'
import type { ComputerUseDriver } from '../../src/main/computer-use/driver'
import type { ComputerUseConsent, ComputerUseStatus } from '../../src/shared/computer-use'
import type { PionApi, ComputerUseLocalApi } from '../../src/shared/pion-api'
const consent = { capture: true, upload: false, control: false, retention: 'sdk-session' as const }
const observing = (scope = 1, revision = 2): ComputerUseStatus => ({ ...createDisabledComputerUseStatus(), state: 'ready', coordination: 'held', revision, scopeRevision: scope, consent,
  capability: { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, unsupportedReason: 'control-unavailable', scope: 'window' } })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const descriptor = Object.getOwnPropertyDescriptor(window, 'pion')
afterEach(() => { cleanup(); if (descriptor) Object.defineProperty(window, 'pion', descriptor); else delete (window as unknown as { pion?: unknown }).pion })
function mock() {
  let listener: (state: ComputerUseStatus) => void = () => {}
  const unsubscribe = vi.fn()
  const api = { getState: vi.fn().mockResolvedValue(createDisabledComputerUseStatus()), start: vi.fn().mockResolvedValue(observing()), capture: vi.fn(), act: vi.fn(), stop: vi.fn().mockResolvedValue({ ...createDisabledComputerUseStatus(), state: 'stopped', coordination: 'released', revision: 9, scopeRevision: 2 }),
    onState: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe }) } satisfies ComputerUseLocalApi
  window.pion = { computerUse: api } as unknown as PionApi
  return { api, emit: (state: ComputerUseStatus) => listener(state), unsubscribe }
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }
const stoppedStatus = (scope = 2, revision = 4): ComputerUseStatus => ({ ...createDisabledComputerUseStatus(), state: 'stopped', coordination: 'released', scopeRevision: scope, revision })

// Real service lifecycle with an in-memory coordinator/driver only. Terminal
// metadata delivery is independently scheduled from the genuinely rejected RPC.
function serviceApi(timing: 'metadata-first' | 'rejection-first', kind: 'occupied' | 'failed-clean' | 'claimed' = 'occupied') {
  let listener: (state: ComputerUseStatus) => void = () => {}
  let time = 10
  let rejected = false
  const queued: ComputerUseStatus[] = []
  const receipt = Object.freeze({ kind: 'computer-use-coordination-receipt' as const })
  const coordination: ComputerUseCoordination = {
    claim: vi.fn(async (): Promise<ComputerUseCoordinationClaim> => kind === 'claimed' ? { kind, receipt } : { kind }),
    release: vi.fn(async () => {})
  }
  const driver: ComputerUseDriver = {
    open: vi.fn(async () => ({ platform: 'linux-wayland' as const, method: 'portal-screencast' as const,
      capture: true, control: false, scope: 'window' as const, unsupportedReason: 'control-unavailable' as const })),
    capture: vi.fn(async () => { throw new Error('capture not used') }), close: vi.fn(async () => {})
  }
  const driverFactory = vi.fn(() => driver)
  const project = (state: ComputerUseStatus) => {
    const { owner: _owner, receipt: _receipt, ...metadata } = state
    return metadata
  }
  const service = new ComputerUseService({ coordination, driverFactory, clock: () => time, randomId: () => 'unused',
    publish: state => {
      const metadata = project(state)
      if (timing === 'rejection-first' && !state.actualPending
        && (state.state === 'stopped' || state.coordination === 'blocked')) queued.push(metadata)
      else listener(metadata)
    } })
  const owner = { ownerWindowId: 1, backendId: 'local', runtimeId: 'local', runId: 'local', generation: 1 }
  const api = {
    getState: vi.fn(async () => project(service.getState())),
    start: vi.fn(async (approval: ComputerUseConsent) => {
      try { return project(await service.start(owner, approval)) }
      catch (error) {
        // Delay RPC rejection, not service cleanup, to exercise the other
        // legitimate publication ordering without fabricating start.resolve.
        if (timing === 'metadata-first') await service.stop(owner)
        rejected = true
        throw error
      }
    }),
    capture: vi.fn(async () => { throw new Error('not used') }),
    act: vi.fn(async () => { throw new Error('not used') }),
    stop: vi.fn(async () => project(await service.stop(owner))),
    onState: vi.fn((callback: typeof listener) => { listener = callback; return () => { listener = () => {} } })
  } satisfies ComputerUseLocalApi
  window.pion = { computerUse: api } as unknown as PionApi
  return { api, service, coordination, driver, driverFactory, rejected: () => rejected,
    setExpired: () => { time = 10 + COMPUTER_USE_LIMITS.maxDurationMs },
    deliver: () => { queued.splice(0).forEach(state => listener(state)) } }
}
it.each(['metadata-first', 'rejection-first'] as const)('closes the real rejected occupied start with exact zero-own proof: %s', async timing => {
  const f = serviceApi(timing)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent)); await flush()
  expect(f.rejected()).toBe(true)
  expect(f.service.getState()).toMatchObject({ state: 'quarantined', coordination: 'blocked', actualPending: false, scopeRevision: 2 })
  if (timing === 'rejection-first') {
    expect(view.result.current.busy).toBe(true)
    act(() => view.result.current.onStart(consent)); expect(f.api.start).toHaveBeenCalledTimes(1)
    act(() => f.deliver())
  }
  expect(view.result.current.busy).toBe(false)
  expect(view.result.current.error).toBeUndefined()
  expect(view.result.current.state).toMatchObject({ state: 'quarantined', coordination: 'blocked', actualPending: false })
  act(() => { view.result.current.onStop(); view.result.current.onCapture() })
  expect(f.api.stop).not.toHaveBeenCalled(); expect(f.api.capture).not.toHaveBeenCalled()
  expect(f.coordination.release).not.toHaveBeenCalled(); expect(f.driverFactory).not.toHaveBeenCalled()
  expect(f.driver.close).not.toHaveBeenCalled()
  expect(f.coordination.claim).toHaveBeenCalledTimes(1)
  act(() => view.result.current.onStart(consent)); await flush()
  act(() => f.deliver())
  expect(f.api.start).toHaveBeenCalledTimes(2)
  expect(f.coordination.claim).toHaveBeenCalledTimes(2)
  expect(view.result.current.busy).toBe(false)
  view.unmount(); expect(f.api.stop).not.toHaveBeenCalled()
})
it.each(['metadata-first', 'rejection-first'] as const)('accepts only positive unclaimed close for the real failed-clean rejection: %s', async timing => {
  const f = serviceApi(timing, 'failed-clean')
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent)); await flush()
  expect(f.rejected()).toBe(true)
  expect(f.service.getState()).toMatchObject({ state: 'stopped', coordination: 'unclaimed', actualPending: false, scopeRevision: 2 })
  if (timing === 'rejection-first') expect(view.result.current.busy).toBe(true)
  act(() => f.deliver())
  expect(view.result.current.busy).toBe(false); expect(view.result.current.error).toBe('本次启动未成功，收尾已确认。')
  expect(f.coordination.release).not.toHaveBeenCalled(); expect(f.driverFactory).not.toHaveBeenCalled()
  act(() => view.result.current.onStart(consent)); await flush(); act(() => f.deliver())
  expect(f.api.start).toHaveBeenCalledTimes(2)
  expect(view.result.current.busy).toBe(false)
})
it.each(['stop', 'expired', 'expired-stop'] as const)('closes actual pre-claim %s with unclaimed and permits explicit retry', async reason => {
  const f = serviceApi('rejection-first', 'claimed')
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => {
    view.result.current.onStart(consent)
    if (reason !== 'stop') f.setExpired()
    if (reason !== 'expired') view.result.current.onStop()
  })
  await flush()
  expect(f.rejected()).toBe(true)
  expect(f.service.getState()).toMatchObject({ state: 'stopped', coordination: 'unclaimed', actualPending: false })
  act(() => f.deliver())
  expect(view.result.current.busy).toBe(false)
  expect(view.result.current.error).toBe(reason === 'expired' ? '本次启动未成功，收尾已确认。' : undefined)
  expect(f.coordination.claim).not.toHaveBeenCalled(); expect(f.coordination.release).not.toHaveBeenCalled()
  expect(f.driverFactory).not.toHaveBeenCalled()
  act(() => view.result.current.onStart(consent)); await flush()
  expect(f.api.start).toHaveBeenCalledTimes(2)
  expect(view.result.current.state).toMatchObject({ state: 'ready', coordination: 'held' })
})
it('leaves a foreign blocked marker passive, permits only explicit retry, and never sends Stop for that marker', async () => {
  const { api, emit } = mock()
  const blocked: ComputerUseStatus = { ...createDisabledComputerUseStatus(), state: 'quarantined', coordination: 'blocked', scopeRevision: 1, revision: 2 }
  api.getState.mockResolvedValue(blocked)
  api.start.mockResolvedValue({ ...blocked, scopeRevision: 2, revision: 4 })
  const view = renderHook(() => useComputerUse(true)); await flush()
  expect(view.result.current.busy).toBe(false)
  act(() => { view.result.current.onStop(); view.result.current.onCapture() })
  expect(api.stop).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
  expect(view.result.current.state.state).toBe('quarantined')
  act(() => emit({ ...blocked, revision: 3 })); await flush()
  expect(api.start).not.toHaveBeenCalled(); expect(api.getState).toHaveBeenCalledTimes(1)
  act(() => view.result.current.onStart(consent)); await flush()
  expect(api.start).toHaveBeenCalledTimes(1)
  expect(view.result.current.state.coordination).toBe('blocked')
  expect(view.result.current.busy).toBe(false)
  view.unmount(); expect(api.stop).not.toHaveBeenCalled()
})
it('requires held ready metadata for capture, including legacy DTOs without coordination', async () => {
  const { api, emit } = mock()
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent)); await flush()
  const { coordination: _coordination, ...legacy } = observing(1, 3)
  act(() => emit(legacy as ComputerUseStatus))
  expect(view.result.current.state.coordination).toBe('not-checked')
  act(() => view.result.current.onCapture()); expect(api.capture).not.toHaveBeenCalled()
  for (const [revision, state] of [[4, 'observing'], [5, 'paused']] as const) {
    act(() => emit({ ...observing(1, revision), state }))
    act(() => view.result.current.onCapture()); expect(api.capture).not.toHaveBeenCalled()
  }
  act(() => emit(observing(1, 6)))
  api.capture.mockResolvedValue({ state: observing(1, 7) })
  act(() => view.result.current.onCapture()); await flush()
  expect(api.capture).toHaveBeenCalledTimes(1)
})
it('does not release an unknown local slot on different-scope foreign blocked or legacy stopped metadata', async () => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise)
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } }); await flush()
  act(() => view.result.current.onStart(consent))
  await act(async () => start.reject(new Error('unconfirmed')))
  const blocked: ComputerUseStatus = { ...createDisabledComputerUseStatus(), state: 'quarantined', coordination: 'blocked', scopeRevision: 3, revision: 4 }
  act(() => emit(blocked))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  view.rerender({ active: false }); api.getState.mockResolvedValue(blocked)
  view.rerender({ active: true }); await flush()
  expect(view.result.current.busy).toBe(true)
  const { coordination: _coordination, ...legacyStop } = stoppedStatus(3, 5)
  act(() => emit(legacyStop as ComputerUseStatus))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it('keeps unknown actual pending state isolated across reopening while allowing explicit local Stop', async () => {
  const { api } = mock()
  const unknown: ComputerUseStatus = { ...observing(7, 10), state: 'quarantined', coordination: 'unknown', actualPending: true }
  api.getState.mockResolvedValue(unknown); api.stop.mockResolvedValue(unknown)
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } }); await flush()
  expect(view.result.current.busy).toBe(true)
  act(() => { view.result.current.onStart(consent); view.result.current.onStop() }); await flush()
  expect(api.start).not.toHaveBeenCalled(); expect(api.stop).toHaveBeenCalledTimes(1)
  view.rerender({ active: false }); view.rerender({ active: true }); await flush()
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).not.toHaveBeenCalled()
})
it('waits for authoritative first read at host scope 2, then owns scope 3 and stops synchronously on close', async () => {
  const { api } = mock(); const read = deferred<ComputerUseStatus>()
  api.getState.mockReturnValue(read.promise); api.start.mockResolvedValue(observing(3, 6))
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } })
  expect(view.result.current.busy).toBe(true); expect(view.result.current.error).toBe('正在读取本地观察状态。')
  act(() => { view.result.current.onStart(consent); view.result.current.onCapture() })
  expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled()
  await act(async () => read.resolve(stoppedStatus(2, 5)))
  expect(view.result.current.busy).toBe(false)
  act(() => view.result.current.onStart(consent)); await flush()
  expect(api.start).toHaveBeenCalledTimes(1); expect(view.result.current.state.scopeRevision).toBe(3)
  view.rerender({ active: false }); expect(api.stop).toHaveBeenCalledTimes(1)
})
it('keeps first read failure unavailable without dispatching a chooser or exposing its error, but allows explicit Stop', async () => {
  const { api } = mock(); const read = deferred<ComputerUseStatus>(); api.getState.mockReturnValue(read.promise)
  const view = renderHook(() => useComputerUse(true))
  await act(async () => read.reject(new Error('SECRET native failure')))
  expect(view.result.current.busy).toBe(true); expect(view.result.current.error).toBe('无法读取本地观察状态。')
  act(() => { view.result.current.onStart(consent); view.result.current.onCapture() })
  expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled()
  act(() => view.result.current.onStop()); expect(api.stop).toHaveBeenCalledTimes(1)
  await flush()
})
it.each(['resolve', 'reject'] as const)('accepts trusted onState before a late first read %s without clearing scope 3 ownership or actual start slot', async outcome => {
  const { api, emit } = mock(); const read = deferred<ComputerUseStatus>(); const start = deferred<ComputerUseStatus>()
  api.getState.mockReturnValue(read.promise); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true))
  act(() => emit(stoppedStatus(2, 5)))
  expect(view.result.current.busy).toBe(false); expect(view.result.current.error).toBeUndefined()
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  act(() => emit(observing(3, 6)))
  await act(async () => { if (outcome === 'resolve') read.resolve(stoppedStatus(2, 5)); else read.reject(new Error('late read')) })
  expect(view.result.current.state.scopeRevision).toBe(3); expect(view.result.current.busy).toBe(true)
  expect(view.result.current.error).toBeUndefined(); expect(api.stop).not.toHaveBeenCalled()
  act(() => view.result.current.onCapture()); expect(api.capture).not.toHaveBeenCalled()
  await act(async () => start.resolve(observing(3, 6)))
  expect(view.result.current.busy).toBe(false)
  view.unmount(); expect(api.stop).toHaveBeenCalledTimes(1)
})
it('requires fresh authority after inactive reset and rejects stale scope ABA or invalid notifications', async () => {
  const { api, emit } = mock()
  api.getState.mockResolvedValue(stoppedStatus(2, 5))
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } }); await flush()
  view.rerender({ active: false })
  const read = deferred<ComputerUseStatus>(); api.getState.mockReturnValue(read.promise)
  view.rerender({ active: true })
  act(() => emit(stoppedStatus(1, 6)))
  act(() => emit({ ...stoppedStatus(2, 6), revision: NaN }))
  act(() => view.result.current.onStart(consent))
  expect(view.result.current.busy).toBe(true); expect(api.start).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled()
  await act(async () => read.resolve(stoppedStatus(2, 5)))
  expect(view.result.current.busy).toBe(false)
})
it('allows explicit Stop before first authority even when a remount displays a scope older than the reservation', async () => {
  const { api } = mock(); api.getState.mockResolvedValue(observing(7, 10))
  const first = renderHook(() => useComputerUse(true)); await flush(); first.unmount()
  expect(api.stop).not.toHaveBeenCalled()
  const read = deferred<ComputerUseStatus>(); api.getState.mockReturnValue(read.promise)
  api.stop.mockResolvedValue(stoppedStatus(8, 11))
  const reopened = renderHook(() => useComputerUse(true))
  expect(reopened.result.current.busy).toBe(true)
  act(() => reopened.result.current.onStop()); expect(api.stop).toHaveBeenCalledTimes(1)
  await flush()
  expect(reopened.result.current.state.scopeRevision).toBe(8); expect(reopened.result.current.busy).toBe(false)
  await act(async () => read.resolve(observing(7, 10)))
  expect(reopened.result.current.state.scopeRevision).toBe(8)
  reopened.unmount(); expect(api.stop).toHaveBeenCalledTimes(1)
})
it('does not let an invalid notification suppress a valid first read', async () => {
  const { api, emit } = mock(); const read = deferred<ComputerUseStatus>(); api.getState.mockReturnValue(read.promise)
  const view = renderHook(() => useComputerUse(true))
  act(() => emit({ ...stoppedStatus(2, 5), scopeRevision: -1 }))
  await act(async () => read.resolve(stoppedStatus(2, 5)))
  expect(view.result.current.state.scopeRevision).toBe(2); expect(view.result.current.busy).toBe(false)
  expect(api.start).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled()
})
it.each(['before', 'after'] as const)('rejects same-revision foreign closure %s the start rejection', async timing => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  const pending: ComputerUseStatus = { ...createDisabledComputerUseStatus(), state: 'quarantined', coordination: 'blocked', scopeRevision: 2, revision: 4, actualPending: true }
  act(() => emit(pending))
  if (timing === 'before') act(() => emit({ ...pending, actualPending: false }))
  await act(async () => start.reject(new Error('start failed')))
  if (timing === 'after') act(() => emit({ ...pending, actualPending: false }))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it.each([
  { name: 'different scope', scopeRevision: 3, revision: 4 },
  { name: 'no revision progress', scopeRevision: 2, revision: 0 },
  { name: 'actual pending', scopeRevision: 2, revision: 4, actualPending: true },
  { name: 'owned pending marker', scopeRevision: 2, revision: 4,
    owner: { ownerWindowId: 1, backendId: 'local', runtimeId: 'local', runId: 'local', generation: 1 } }
])('does not close a rejected start with foreign metadata: $name', async ({ name: _name, ...patch }) => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  await act(async () => start.reject(new Error('start failed')))
  act(() => emit({ ...createDisabledComputerUseStatus(), state: 'quarantined', coordination: 'blocked', ...patch }))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it('does not treat matching-scope legacy stopped or explicit not-checked as local closed proof', async () => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  await act(async () => start.reject(new Error('start failed')))
  const { coordination: _coordination, ...legacy } = stoppedStatus()
  act(() => emit(legacy as ComputerUseStatus))
  expect(view.result.current.busy).toBe(true)
  act(() => emit({ ...stoppedStatus(2, 5), coordination: 'not-checked' }))
  expect(view.result.current.busy).toBe(true)
  act(() => emit({ ...stoppedStatus(2, 6), coordination: 'unclaimed' }))
  expect(view.result.current.busy).toBe(false)
})
it('foreign blocked metadata never clears uncertainty of a rejected Stop, including the former start scope', async () => {
  const { api, emit } = mock()
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent)); await flush()
  api.stop.mockRejectedValue(new Error('stop uncertain'))
  act(() => view.result.current.onStop()); await flush()
  act(() => emit({ ...stoppedStatus(2, 10), state: 'quarantined', coordination: 'blocked' }))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it('retains matching stopped event proof before a late start rejection without releasing the actual RPC slot early', async () => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  act(() => emit(stoppedStatus()))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  await act(async () => start.reject(new Error('late start error')))
  expect(view.result.current.state.state).toBe('stopped'); expect(view.result.current.busy).toBe(false)
  expect(view.result.current.error).toBe('本次启动未成功，收尾已确认。')
})
it.each(['before-rejection', 'after-rejection'] as const)('keeps authoritative stopping pending through a failed start and retains the confirmed failure: %s', async timing => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  const stopping: ComputerUseStatus = { ...stoppedStatus(2, 3), state: 'stopping', coordination: 'held', actualPending: true }
  if (timing === 'before-rejection') act(() => emit(stopping))
  await act(async () => start.reject(new Error('SECRET open failure')))
  if (timing === 'after-rejection') act(() => emit(stopping))
  expect(view.result.current.state).toMatchObject({ state: 'stopping', actualPending: true })
  expect(view.result.current.busy).toBe(true)
  expect(view.result.current.error).toBe('正在停止；释放尚未确认。')
  act(() => { view.result.current.onStart(consent); view.result.current.onCapture() })
  expect(api.start).toHaveBeenCalledTimes(1); expect(api.capture).not.toHaveBeenCalled()
  act(() => emit(stoppedStatus(2, 4)))
  expect(view.result.current.state.state).toBe('stopped'); expect(view.result.current.busy).toBe(false)
  expect(view.result.current.error).toBe('本次启动未成功，收尾已确认。')
})
it.each(['before-click', 'after-click', 'after-close'] as const)('coalesces Stop into the exact failed-start cleanup without expecting scope 3: rejection %s', async timing => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const stopping: ComputerUseStatus = { ...stoppedStatus(2, 3), state: 'stopping', coordination: 'held', actualPending: true }
  // The host reuses its ongoing close; a redundant Stop cannot advance scope.
  api.stop.mockResolvedValue(stopping)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  act(() => emit(stopping))
  if (timing === 'before-click') await act(async () => start.reject(new Error('open failed')))
  act(() => { view.result.current.onStop(); view.result.current.onStop() })
  expect(view.result.current.busy).toBe(true)
  expect(view.result.current.error).toBe('正在停止；释放尚未确认。')
  await flush()
  expect(view.result.current.error).toBe('正在停止；释放尚未确认。')
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  if (timing === 'after-click') await act(async () => start.reject(new Error('open failed')))
  act(() => emit(stoppedStatus(2, 4)))
  if (timing === 'after-close') {
    expect(view.result.current.busy).toBe(true) // The real start RPC still owns its slot.
    act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
    await act(async () => start.reject(new Error('late open failed')))
  }
  expect(view.result.current.busy).toBe(false)
  expect(view.result.current.state).toMatchObject({ state: 'stopped', scopeRevision: 2, coordination: 'released' })
  expect(view.result.current.error).toBe('本次启动未成功，收尾已确认。')
  expect(api.stop).not.toHaveBeenCalled()
})
it.each(['no-start', 'wrong-scope', 'missing-scope', 'stale-revision', 'scope-ABA'] as const)('does not coalesce uncorrelated host stopping into a local start: %s', async kind => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  api.stop.mockRejectedValue(new Error('close uncertain'))
  const view = renderHook(() => useComputerUse(true)); await flush()
  if (kind !== 'no-start') {
    act(() => view.result.current.onStart(consent))
    await act(async () => start.reject(new Error('open uncertain')))
  }
  const stopping: ComputerUseStatus = { ...stoppedStatus(kind === 'wrong-scope' ? 3 : 2, 3), state: 'stopping', coordination: 'held', actualPending: true }
  if (kind === 'missing-scope') {
    const { scopeRevision: _scopeRevision, ...missing } = stopping
    act(() => emit(missing as ComputerUseStatus))
  } else if (kind === 'stale-revision') act(() => emit({ ...stopping, revision: 0 }))
  else {
    if (kind === 'scope-ABA') act(() => emit({ ...stopping, scopeRevision: 3, revision: 4 }))
    act(() => emit(stopping))
  }
  act(() => view.result.current.onStop()); await flush()
  expect(api.stop).toHaveBeenCalledTimes(1)
  expect(view.result.current.busy).toBe(true)
  expect(view.result.current.error).toContain('已隔离')
  act(() => emit(stoppedStatus(2, 5)))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(kind === 'no-start' ? 0 : 1)
})
it.each(['pending', 'rejected'] as const)('distinguishes a host stopping receipt from a rejected Stop RPC: %s', async outcome => {
  const { api, emit } = mock(); const stop = deferred<ComputerUseStatus>(); api.stop.mockReturnValue(stop.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent)); await flush()
  act(() => view.result.current.onStop())
  const stopping: ComputerUseStatus = { ...stoppedStatus(2, 3), state: 'stopping', coordination: 'held', actualPending: true }
  act(() => emit(stopping))
  expect(view.result.current.error).toBe('正在停止；释放尚未确认。')
  await act(async () => { if (outcome === 'pending') stop.resolve(stopping); else stop.reject(new Error('SECRET close failed')) })
  expect(view.result.current.busy).toBe(true)
  if (outcome === 'pending') {
    expect(view.result.current.state.state).toBe('stopping'); expect(view.result.current.error).toBe('正在停止；释放尚未确认。')
  } else {
    expect(view.result.current.state.state).toBe('quarantined'); expect(view.result.current.error).toContain('已隔离')
  }
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it.each(['quarantined', 'invalid', 'no-scope', 'foreign-blocked', 'scope-ABA'] as const)('does not turn failed-start cleanup without an exact positive receipt into success: %s', async proof => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent))
  act(() => emit({ ...stoppedStatus(2, 3), state: 'stopping', coordination: 'held', actualPending: true }))
  await act(async () => start.reject(new Error('open failed')))
  act(() => view.result.current.onStop())
  expect(api.stop).not.toHaveBeenCalled()
  if (proof === 'quarantined') act(() => emit({ ...stoppedStatus(2, 4), state: 'quarantined', actualPending: true }))
  if (proof === 'invalid') act(() => emit({ ...stoppedStatus(2, 4), revision: NaN }))
  if (proof === 'no-scope') {
    const { scopeRevision: _scopeRevision, ...missing } = stoppedStatus(2, 4)
    act(() => emit(missing as ComputerUseStatus))
  }
  if (proof === 'foreign-blocked') act(() => emit({ ...stoppedStatus(3, 4), state: 'quarantined', coordination: 'blocked' }))
  if (proof === 'scope-ABA') {
    act(() => emit({ ...stoppedStatus(3, 4), state: 'quarantined', actualPending: true }))
    act(() => emit(stoppedStatus(2, 5)))
  }
  expect(view.result.current.busy).toBe(true)
  expect(view.result.current.error).not.toBe('本次启动未成功，收尾已确认。')
  if (['quarantined', 'foreign-blocked', 'scope-ABA'].includes(proof)) {
    expect(view.result.current.state.state).toBe('quarantined'); expect(view.result.current.error).toContain('已隔离')
  }
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it('retains inactive cleanup stop receipt across remount and late start rejection', async () => {
  const { api } = mock(); const start = deferred<ComputerUseStatus>(); const stop = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise); api.stop.mockReturnValue(stop.promise)
  const first = renderHook(() => useComputerUse(true)); await flush()
  act(() => first.result.current.onStart(consent)); first.unmount()
  await act(async () => stop.resolve(stoppedStatus()))
  api.getState.mockResolvedValue(stoppedStatus())
  const reopened = renderHook(() => useComputerUse(true)); await flush()
  expect(reopened.result.current.busy).toBe(true)
  await act(async () => start.reject(new Error('late start error')))
  expect(reopened.result.current.busy).toBe(false); expect(reopened.result.current.error).toBeUndefined()
  act(() => reopened.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(2)
})
it.each([
  { name: 'different stop scope', status: stoppedStatus(3, 5) },
  { name: 'stopped with actual pending', status: { ...stoppedStatus(), actualPending: true } },
  { name: 'quarantined with actual pending', status: { ...stoppedStatus(), state: 'quarantined' as const, actualPending: true } },
  { name: 'non-stopped metadata', status: observing(2, 4) },
  { name: 'no revision progress', status: stoppedStatus(2, 0) }
])('does not treat $name as a matching release receipt', async ({ status }) => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); api.start.mockReturnValue(start.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(consent)); act(() => emit(status))
  await act(async () => start.reject(new Error('late')))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it('does not clear rejected stop unknown from an earlier matching receipt or same revision read', async () => {
  const { api, emit } = mock(); const start = deferred<ComputerUseStatus>(); const stop = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise); api.stop.mockReturnValue(stop.promise)
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } }); await flush()
  act(() => view.result.current.onStart(consent)); act(() => view.result.current.onStop())
  act(() => emit(stoppedStatus()))
  await act(async () => stop.reject(new Error('stop failed')))
  await act(async () => start.reject(new Error('start failed')))
  expect(view.result.current.busy).toBe(true)
  view.rerender({ active: false }); api.getState.mockResolvedValue(stoppedStatus())
  view.rerender({ active: true }); await flush()
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
})
it('allows explicit stop of read-only quarantine once while cleanup stays passive', async () => {
  const { api } = mock(); const stop = deferred<ComputerUseStatus>()
  api.getState.mockResolvedValue({ ...observing(7, 10), state: 'quarantined', actualPending: true })
  api.stop.mockReturnValue(stop.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  expect(api.stop).not.toHaveBeenCalled()
  act(() => { view.result.current.onStop(); view.result.current.onStop() })
  expect(api.stop).toHaveBeenCalledTimes(1)
  await act(async () => stop.resolve({ ...stoppedStatus(8, 11), actualPending: true }))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).not.toHaveBeenCalled()
  view.unmount(); expect(api.stop).toHaveBeenCalledTimes(1)
})
it('keeps inactive known cleanup proof when start rejects before reopening', async () => {
  const { api } = mock(); const start = deferred<ComputerUseStatus>(); const stop = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise); api.stop.mockReturnValue(stop.promise)
  const first = renderHook(() => useComputerUse(true)); await flush()
  act(() => first.result.current.onStart(consent)); first.unmount()
  await act(async () => stop.resolve(stoppedStatus()))
  await act(async () => start.reject(new Error('late')))
  api.getState.mockResolvedValue(stoppedStatus())
  const reopened = renderHook(() => useComputerUse(true)); await flush()
  expect(reopened.result.current.busy).toBe(false); expect(reopened.result.current.error).toBeUndefined()
})
const displayConsent = { ...consent, control: true, captureScope: 'display' as const }
it.each(['default', 'legacy'] as const)('rejects disabled development input before reserving a slot or calling the real service: %s', async mode => {
  const f = serviceApi('rejection-first')
  if (mode === 'legacy') {
    const { inputDevelopmentEnabled: _enabled, ...legacy } = f.service.getState()
    f.api.getState.mockResolvedValue(legacy)
  }
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(displayConsent)); await flush()
  expect(f.api.start).not.toHaveBeenCalled()
  expect(f.coordination.claim).not.toHaveBeenCalled(); expect(f.driverFactory).not.toHaveBeenCalled()
  expect(view.result.current.busy).toBe(false)
  expect(view.result.current.state.state).toBe('disabled')
  expect(f.service.getState().scopeRevision).toBe(0)
  act(() => view.result.current.onStart(consent)); await flush(); act(() => f.deliver())
  expect(f.api.start).toHaveBeenCalledExactlyOnceWith(consent)
  expect(view.result.current.busy).toBe(false)
})
it('does not let late configuration overwrite a newer scope or independently grant input', async () => {
  const { api, emit } = mock()
  const read = deferred<ComputerUseStatus>(); api.getState.mockReturnValue(read.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  const newer = stoppedStatus(2, 4)
  act(() => emit(newer))
  await act(async () => read.resolve({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true }))
  act(() => emit({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true, revision: 3 }))
  expect(view.result.current.state).toMatchObject({ scopeRevision: 2, revision: 4, inputDevelopmentEnabled: false })
  act(() => view.result.current.onStart(displayConsent)); await flush()
  expect(api.start).not.toHaveBeenCalled(); expect(view.result.current.busy).toBe(false)
  act(() => emit({ ...newer, revision: 5, inputDevelopmentEnabled: true }))
  expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
  expect(view.result.current.state.consent?.control).toBe(false)
})
it('projects the development gate from configuration only and keeps backend rejection independent', async () => {
  const options = { coordination: { claim: vi.fn(), release: vi.fn() }, driverFactory: vi.fn(),
    clock: vi.fn(), randomId: vi.fn(), publish: vi.fn(), assertOwned: vi.fn() }
  const owner = { ownerWindowId: 1, backendId: 'local', runtimeId: 'local', runId: 'local', generation: 1 }
  for (const enabled of [undefined, false, true]) {
    const service = new ComputerUseService({ ...options, allowVirtualInput: enabled })
    const status = service.getState()
    expect(status.inputDevelopmentEnabled).toBe(enabled === true)
    expect(status.consent?.control).toBe(false); expect(status.consent?.capture).toBe(false)
    expect(status.capability?.control).toBe(false)
    for (const spy of [options.coordination.claim, options.coordination.release, options.driverFactory,
      options.clock, options.randomId, options.publish, options.assertOwned]) expect(spy).not.toHaveBeenCalled()
    if (!enabled) {
      await expect(service.start(owner, displayConsent)).rejects.toThrow('ComputerUse input unavailable')
      expect(service.getState().scopeRevision).toBe(0)
      expect(options.coordination.claim).not.toHaveBeenCalled()
    }
  }
})
const displayReady = (): ComputerUseStatus => ({ ...observing(), inputDevelopmentEnabled: true, consent: displayConsent,
  capability: { platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' } })
it.each([
  { ...consent, captureScope: 'display' as const },
  { ...consent, control: true },
  { ...consent, control: true, captureScope: 'window' as const },
  { ...displayConsent, upload: true }
])('rejects inconsistent scope/control and any upload before IPC: %j', async invalid => {
  const { api } = mock(); api.getState.mockResolvedValue({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true })
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(invalid))
  expect(api.start).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled()
})
it('sends explicit display control consent exactly once through the real reservation and supports manual local capture', async () => {
  const { api, emit } = mock(); api.getState.mockResolvedValue({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true }); api.start.mockResolvedValue(displayReady())
  api.capture.mockResolvedValue({ state: { ...displayReady(), revision: 3 }, preview: 'data:image/png;base64,AAAA' })
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => { view.result.current.onStart(displayConsent); view.result.current.onStart(displayConsent) }); await flush()
  expect(api.start).toHaveBeenCalledExactlyOnceWith(displayConsent)
  act(() => view.result.current.onCapture()); await flush()
  expect(api.capture).toHaveBeenCalledExactlyOnceWith({ scopeRevision: 1 })
  expect(view.result.current.preview).toBeTruthy()
  act(() => emit({ ...displayReady(), revision: 4, state: 'acting', actualPending: false }))
  expect(view.result.current.busy).toBe(true)
  act(() => { view.result.current.onStart(displayConsent); view.result.current.onCapture() })
  expect(api.capture).toHaveBeenCalledTimes(1)
  expect(view.result.current.preview).toBeUndefined()
})
it('mode changes neither stop a passively read input lease nor grant capture or future control', async () => {
  const { api } = mock(); api.getState.mockResolvedValue(displayReady())
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => { view.result.current.onModeChange(); view.result.current.onCapture() })
  expect(api.stop).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled()
  view.unmount(); expect(api.stop).not.toHaveBeenCalled()
})
it('mode change fences a pending display capture, retaining its actual slot after successful Stop', async () => {
  const { api } = mock(); api.getState.mockResolvedValue({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true }); api.start.mockResolvedValue(displayReady())
  const capture = deferred<Awaited<ReturnType<ComputerUseLocalApi['capture']>>>()
  api.capture.mockReturnValue(capture.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onStart(displayConsent)); await flush()
  act(() => view.result.current.onCapture())
  act(() => view.result.current.onModeChange()); await flush()
  expect(api.stop).toHaveBeenCalledTimes(1); expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  await act(async () => capture.resolve({ state: { ...displayReady(), revision: 3 }, preview: 'data:image/png;base64,AAAA' }))
  expect(view.result.current.preview).toBeUndefined(); expect(view.result.current.state.state).toBe('stopped')
  expect(view.result.current.busy).toBe(false)
})
it('mode change stops only the exact owned pending scope, clears previews and holds both real IPC reservations', async () => {
  const { api } = mock(); api.getState.mockResolvedValue({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true })
  const start = deferred<ComputerUseStatus>(); const stop = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise); api.stop.mockReturnValue(stop.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  act(() => view.result.current.onModeChange())
  expect(api.stop).not.toHaveBeenCalled()
  act(() => view.result.current.onStart(displayConsent))
  act(() => { view.result.current.onModeChange(); view.result.current.onModeChange() })
  expect(api.stop).toHaveBeenCalledTimes(1)
  await act(async () => stop.resolve(stoppedStatus()))
  expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  await act(async () => start.resolve(displayReady()))
  expect(view.result.current.state.state).toBe('stopped'); expect(view.result.current.preview).toBeUndefined()
  expect(view.result.current.busy).toBe(false)
})
it('is passive while inactive; reading/closing never stops a foreign lease', async () => {
  const { api } = mock()
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: false } })
  expect(api.getState).not.toHaveBeenCalled(); expect(api.onState).not.toHaveBeenCalled()
  view.rerender({ active: true }); await flush()
  expect(api.getState).toHaveBeenCalledTimes(1)
  view.unmount(); expect(api.stop).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled()
})
it('deduplicates start/capture, sends literal scope and keeps actual capture reserved across stop', async () => {
  const { api } = mock(); const capture = deferred<Awaited<ReturnType<ComputerUseLocalApi['capture']>>>()
  api.capture.mockReturnValue(capture.promise)
  const view = renderHook(() => useComputerUse(true)); await flush()
  const callback = view.result.current.onCapture
  act(() => { view.result.current.onStart(consent); view.result.current.onStart(consent) }); await flush()
  expect(api.start).toHaveBeenCalledTimes(1); expect(api.start).toHaveBeenCalledWith(consent)
  expect(view.result.current.onCapture).toBe(callback)
  act(() => { callback(); callback() })
  expect(api.capture).toHaveBeenCalledTimes(1); expect(api.capture).toHaveBeenCalledWith({ scopeRevision: 1 })
  act(() => view.result.current.onStop()); await flush()
  expect(api.stop).toHaveBeenCalledTimes(1); expect(view.result.current.busy).toBe(true)
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  await act(async () => capture.resolve({ state: observing(1, 3), preview: 'data:image/png;base64,AAAA' }))
  expect(view.result.current.preview).toBeUndefined(); expect(view.result.current.state.state).toBe('stopped')
})
it('ignores late getState after an event and rejects scope ABA', async () => {
  const { api, emit } = mock(); const read = deferred<ComputerUseStatus>(); api.getState.mockReturnValue(read.promise)
  const view = renderHook(() => useComputerUse(true))
  act(() => emit(observing(5, 10)))
  await act(async () => read.resolve(createDisabledComputerUseStatus()))
  expect(view.result.current.state.scopeRevision).toBe(5)
  act(() => emit(observing(6, 11))); act(() => emit(observing(5, 10)))
  expect(view.result.current.state.scopeRevision).toBe(6)
  view.unmount(); expect(api.stop).not.toHaveBeenCalled()
})
it('close stops an owned pending start synchronously; reopen cannot restart before settlement', async () => {
  const { api } = mock(); const start = deferred<ComputerUseStatus>(); const stop = deferred<ComputerUseStatus>()
  api.start.mockReturnValue(start.promise); api.stop.mockReturnValue(stop.promise)
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } }); await flush()
  act(() => view.result.current.onStart(consent))
  view.rerender({ active: false }); expect(api.stop).toHaveBeenCalledTimes(1)
  view.rerender({ active: true }); await flush()
  act(() => view.result.current.onStart(consent)); expect(api.start).toHaveBeenCalledTimes(1)
  await act(async () => start.resolve(observing()))
  expect(view.result.current.state.frame).toBeUndefined()
  await act(async () => stop.resolve({ ...observing(2, 8), state: 'quarantined', actualPending: true }))
  expect(view.result.current.busy).toBe(true)
})
it('does not clear unknown release on a new mount reading old disabled metadata', async () => {
  const { api } = mock()
  const first = renderHook(() => useComputerUse(true)); await flush()
  act(() => first.result.current.onStart(consent)); await flush()
  api.stop.mockRejectedValue(new Error('private'))
  first.unmount(); await flush()
  const reopened = renderHook(() => useComputerUse(true)); await flush()
  expect(reopened.result.current.busy).toBe(true)
  expect(reopened.result.current.error).toContain('已隔离')
  act(() => reopened.result.current.onStart(consent))
  expect(api.start).toHaveBeenCalledTimes(1)
  reopened.unmount(); expect(api.stop).toHaveBeenCalledTimes(1)
})
it('clears previews on frame changes and inactive close; sanitizes unknown stop failure', async () => {
  const { api, emit } = mock()
  const ready = { ...observing(1, 3), state: 'ready' as const, frame: { id: 'frame-a', width: 1, height: 1, createdAt: 1, scopeRevision: 1, captureScope: 'window' as const, actualScope: 'window' as const } }
  api.capture.mockResolvedValue({ state: ready, preview: 'data:image/png;base64,AAAA' })
  const view = renderHook(({ active }) => useComputerUse(active), { initialProps: { active: true } }); await flush()
  act(() => view.result.current.onStart(consent)); await flush(); act(() => view.result.current.onCapture()); await flush()
  expect(view.result.current.preview).toBeTruthy()
  act(() => emit({ ...ready, revision: 4, frame: { ...ready.frame, id: 'frame-b' } }))
  expect(view.result.current.preview).toBeUndefined()
  api.stop.mockRejectedValue(new Error('SECRET /raw/path'))
  act(() => view.result.current.onStop()); await flush()
  expect(view.result.current.error).not.toContain('SECRET'); expect(view.result.current.state.state).toBe('quarantined')
  view.rerender({ active: false }); expect(view.result.current.preview).toBeUndefined(); expect(api.stop).toHaveBeenCalledTimes(1)
})
