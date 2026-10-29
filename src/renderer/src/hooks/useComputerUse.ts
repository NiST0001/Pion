import { useCallback, useEffect, useRef, useState } from 'react'
import { createDisabledComputerUseStatus, normalizeComputerUseStatus } from '../../../shared/computer-use'
import type { ComputerUseConsent, ComputerUseStatus } from '../../../shared/computer-use'
import type { ComputerUseLocalApi } from '../../../shared/pion-api'

// Preserve real IPC reservations across close/unmount/reopen. A hidden UI does
// not cancel a native transaction or grant permission to start another one.
type StartReceipt = { scope: number; revision: number; closedRevision?: number }
type Reservation = { operation: boolean; stop: boolean; stopRejected: boolean; unknown: boolean; unknownRevision: number; unknownScope: number;
  revision: number; scope: number; start?: StartReceipt; unknownStart?: StartReceipt; listeners: Set<() => void> }
const reservations = new WeakMap<ComputerUseLocalApi, Reservation>()
function reservation(api: ComputerUseLocalApi) {
  let value = reservations.get(api)
  if (!value) { value = { operation: false, stop: false, stopRejected: false, unknown: false, unknownRevision: -1, unknownScope: -1,
    revision: -1, scope: -1, listeners: new Set() }; reservations.set(api, value) }
  return value
}
const stopped = (state: ComputerUseStatus) => !state.actualPending && state.state === 'stopped'
  && (state.coordination === 'released' || state.coordination === 'unclaimed')
const foreignBlocked = (state: ComputerUseStatus) => state.state === 'quarantined'
  && state.coordination === 'blocked' && !state.actualPending && !state.owner
// Only real monotonic metadata can certify the exact stop belonging to a start.
function recordStatus(slot: Reservation, value: unknown) {
  const next = normalizeComputerUseStatus(value)
  if (!next || next.revision < slot.revision || next.scopeRevision < slot.scope
    || (next.revision === slot.revision && next.scopeRevision !== slot.scope)) return undefined
  const progressed = next.revision > slot.revision
  slot.revision = next.revision; slot.scope = next.scopeRevision
  const start = slot.start ?? slot.unknownStart
  const closedStart = start && progressed && (stopped(next) || foreignBlocked(next))
    && next.scopeRevision === start.scope + 1 && next.revision > start.revision
  if (closedStart) start.closedRevision = next.revision
  // A foreign marker says nothing about arbitrary local uncertainty. It only
  // closes the exact rejected start that reserved this slot, never a Stop.
  if (!slot.stop && next.revision > slot.unknownRevision
    && ((closedStart && slot.unknownStart === start)
      || (stopped(next) && next.scopeRevision === slot.unknownScope + 1))) {
    slot.unknown = false
    slot.unknownStart = undefined
  }
  return next
}
function publish(slot: Reservation) { slot.listeners.forEach(listener => listener()) }
const observable = (state: ComputerUseStatus) => state.coordination === 'held' && state.state === 'ready'
  && state.consent?.capture === true && state.capability?.capture === true
  && ((state.consent.control === false && state.consent.captureScope !== 'display'
    && state.capability.method === 'portal-screencast' && state.capability.scope !== 'display')
    || (state.consent.control === true && state.consent.captureScope === 'display'
      && state.capability.method === 'portal-screencast+wayland-virtual-input' && state.capability.scope === 'display'))
const pending = (state: ComputerUseStatus) => state.actualPending || state.state === 'acting'

export function useComputerUse(active: boolean) {
  const [state, setState] = useState(createDisabledComputerUseStatus)
  const [preview, setPreview] = useState<string>()
  const [previewUnavailable, setPreviewUnavailable] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(active)
  const current = useRef(state)
  // Cached/default state is display-only until this active effect accepts host metadata.
  // Read readiness never occupies or releases the real native-operation reservation.
  const lifecycle = useRef({ active: false, generation: 0, events: 0, known: false })
  const apiRef = useRef<ComputerUseLocalApi | undefined>(undefined)
  const owned = useRef<{ scope: number; base: number; starting: boolean } | undefined>(undefined)
  const failedStart = useRef<StartReceipt | undefined>(undefined)
  const clearPreview = useCallback(() => { setPreview(undefined); setPreviewUnavailable(undefined) }, [])
  const accept = useCallback((value: unknown) => {
    const next = normalizeComputerUseStatus(value)
    if (!next || next.revision < current.current.revision || next.scopeRevision < current.current.scopeRevision
      || (next.revision === current.current.revision && (next.scopeRevision !== current.current.scopeRevision
        || next.frame?.id !== current.current.frame?.id))) return false
    const old = current.current
    if (next.scopeRevision !== old.scopeRevision || next.frame?.id !== old.frame?.id || !observable(next)) clearPreview()
    if (foreignBlocked(next) || (owned.current && next.scopeRevision !== owned.current.scope
      && !(owned.current.starting && next.scopeRevision === owned.current.base))) owned.current = undefined
    current.current = next
    lifecycle.current.known = true
    setState(next)
    return true
  }, [clearPreview])

  const requestStop = useCallback((explicit = false) => {
    clearPreview()
    const api = apiRef.current
    const owner = owned.current
    if (!api || (explicit && lifecycle.current.known && foreignBlocked(current.current) && !owner)
      || (!explicit && (!owner || (owner.scope !== current.current.scopeRevision
      && !(owner.starting && owner.base === current.current.scopeRevision))))) return
    const slot = reservation(api)
    if (slot.stop || (!explicit && current.current.scopeRevision < slot.scope)
      || (explicit && !lifecycle.current.active)) return
    const start = slot.start ?? slot.unknownStart
    // A second Stop for this start's already-running host close is the same
    // operation, not a new scope. Preserve its receipt and real IPC reservation.
    if (explicit && lifecycle.current.known && current.current.state === 'stopping' && current.current.actualPending
      && start && start.closedRevision === undefined && !slot.stopRejected
      && current.current.scopeRevision === start.scope + 1 && current.current.revision > start.revision
      && current.current.scopeRevision === slot.scope && current.current.revision === slot.revision
      && (!slot.unknown || (slot.unknownStart === start && slot.unknownScope === start.scope))) {
      setBusy(true); setError('正在停止；释放尚未确认。')
      return
    }
    const baseScope = owner && (owner.scope === current.current.scopeRevision
      || (owner.starting && owner.base === current.current.scopeRevision)) ? owner.scope : Math.max(current.current.scopeRevision, slot.scope)
    const baseRevision = Math.max(current.current.revision, slot.revision)
    owned.current = undefined // Never replay this stop after reopening.
    slot.stop = true
    slot.stopRejected = false
    slot.unknownStart = undefined // Stop uncertainty cannot inherit a start-only proof.
    slot.unknown = true
    slot.unknownRevision = baseRevision
    slot.unknownScope = baseScope
    const generation = lifecycle.current.generation
    const valid = () => lifecycle.current.active && lifecycle.current.generation === generation
    if (valid()) { setBusy(true); setError('正在停止；释放尚未确认。') }
    // Invoke synchronously during cleanup, never after awaiting an old start.
    void (async () => {
      try {
        const next = recordStatus(slot, await api.stop())
        if (next && stopped(next) && next.scopeRevision === baseScope + 1
          && next.revision > baseRevision) slot.unknown = false
        if (next && valid() && accept(next)) setError(slot.unknown ? '已隔离：停止尚未确认。' : undefined)
      } catch {
        slot.stopRejected = true
        slot.unknown = true
        slot.unknownRevision = Math.max(slot.revision, baseRevision)
        if (valid()) { setState(previous => ({ ...previous, state: 'quarantined' })); setError('已隔离：停止尚未确认。') }
      } finally {
        slot.stop = false
        publish(slot)
        if (valid()) setBusy(!lifecycle.current.known || slot.operation || slot.unknown || pending(current.current))
      }
    })()
  }, [accept, clearPreview])

  const closeLocalPane = useCallback(() => {
    lifecycle.current.active = false
    lifecycle.current.known = false
    lifecycle.current.generation++
    clearPreview()
    requestStop()
  }, [clearPreview, requestStop])

  useEffect(() => {
    if (!active) { closeLocalPane(); return }
    const api = window.pion.computerUse
    apiRef.current = api
    lifecycle.current.active = true
    lifecycle.current.known = false
    const generation = ++lifecycle.current.generation
    const valid = () => lifecycle.current.active && lifecycle.current.generation === generation
    const slot = reservation(api)
    setBusy(true)
    setError(slot.unknown ? '已隔离：停止尚未确认。' : '正在读取本地观察状态。')
    const refresh = () => {
      if (!valid()) return
      setBusy(!lifecycle.current.known || slot.operation || slot.stop || slot.unknown || pending(current.current))
      // Pending cleanup is not a failure receipt. A rejected Stop, however,
      // must not be hidden by the last accepted (now stale) stopping status.
      const hostStopping = lifecycle.current.known && current.current.state === 'stopping' && current.current.actualPending
        && (!slot.unknown || (!slot.stopRejected && current.current.scopeRevision === slot.unknownScope + 1))
      const failureClosed = failedStart.current?.closedRevision !== undefined && stopped(current.current)
        && current.current.scopeRevision === failedStart.current.scope + 1
        && current.current.revision >= failedStart.current.closedRevision
      setError(previous => hostStopping ? '正在停止；释放尚未确认。' : slot.unknown ? '已隔离：停止尚未确认。'
        : failureClosed ? '本次启动未成功，收尾已确认。' : previous?.startsWith('已隔离') || previous?.startsWith('正在停止')
          || (lifecycle.current.known && (previous === '正在读取本地观察状态。' || previous === '无法读取本地观察状态。')) ? undefined : previous)
    }
    slot.listeners.add(refresh)
    const unsubscribe = api.onState(next => {
      if (!valid()) return
      const recorded = recordStatus(slot, next)
      if (recorded && accept(recorded)) { lifecycle.current.events++; refresh() }
    })
    const events = lifecycle.current.events
    void api.getState().then(next => {
      if (!valid() || events !== lifecycle.current.events) return
      const recorded = recordStatus(slot, next)
      if (recorded && accept(recorded)) refresh()
    }, () => { if (valid() && !lifecycle.current.known && !slot.unknown) setError('无法读取本地观察状态。') })
    return () => { slot.listeners.delete(refresh); closeLocalPane(); unsubscribe() }
  }, [active, accept, closeLocalPane])

  const onStart = useCallback((consent: ComputerUseConsent) => {
    const api = apiRef.current
    if (!api || !lifecycle.current.active || !lifecycle.current.known || consent.capture !== true || consent.upload !== false
      || consent.retention !== 'sdk-session'
      || !((consent.control === false && (consent.captureScope === undefined || consent.captureScope === 'window'))
        || (consent.control === true && consent.captureScope === 'display'))) return
    // Configuration metadata is not consent. Reject before reserving a native
    // operation: this backend gate can reject before allocating any scope.
    if (consent.captureScope === 'display' && current.current.inputDevelopmentEnabled !== true) {
      setError('当前实例未启用开发输入；未实机验收')
      return
    }
    const slot = reservation(api)
    const before = current.current
    if (slot.operation || slot.stop || slot.unknown || pending(before) || before.scopeRevision < slot.scope
      || !(foreignBlocked(before) || (before.coordination === 'unclaimed' && before.state === 'stopped')
        || (['not-checked', 'released'].includes(before.coordination)
          && ['disabled', 'stopped', 'awaiting-consent'].includes(before.state)))) return
    slot.operation = true
    slot.stopRejected = false
    // Host start reserves exactly the next scope before its first async wait.
    const receipt: StartReceipt = { scope: before.scopeRevision + 1, revision: before.revision }
    slot.start = receipt
    failedStart.current = undefined
    owned.current = { scope: receipt.scope, base: before.scopeRevision, starting: true }
    const generation = lifecycle.current.generation
    const valid = () => lifecycle.current.active && lifecycle.current.generation === generation
    setBusy(true); setError(undefined); clearPreview()
    void (async () => {
      try {
        const next = recordStatus(slot, await api.start({ capture: true, upload: false, control: consent.control, retention: 'sdk-session',
          ...(consent.captureScope === undefined ? {} : { captureScope: consent.captureScope }) }))
        if (next && valid() && owned.current?.scope === before.scopeRevision + 1
          && (next.scopeRevision === before.scopeRevision + 1 || foreignBlocked(next))) accept(next)
      } catch {
        if (valid()) failedStart.current = receipt
        if (receipt.closedRevision === undefined || slot.unknown) {
          if (!slot.unknown) {
            slot.unknownStart = receipt
            slot.unknown = true
            slot.unknownRevision = Math.max(current.current.revision, slot.revision)
            slot.unknownScope = receipt.scope
          }
          if (valid()) {
            if (current.current.state === 'stopping' && current.current.actualPending
              && current.current.scopeRevision === receipt.scope + 1 && slot.unknownStart === receipt) {
              setError('正在停止；释放尚未确认。')
            } else { setState(previous => ({ ...previous, state: 'quarantined' })); setError('已隔离：观察启动结果未确认。') }
          }
        }
      }
      finally {
        slot.operation = false
        if (slot.start === receipt) slot.start = undefined
        publish(slot)
        if (owned.current?.scope === before.scopeRevision + 1) owned.current.starting = false
        if (valid()) setBusy(!lifecycle.current.known || slot.stop || slot.unknown || pending(current.current))
      }
    })()
  }, [accept, clearPreview])

  const onCapture = useCallback(() => {
    const api = apiRef.current
    if (!api || !lifecycle.current.active || !lifecycle.current.known) return
    const slot = reservation(api)
    const before = current.current
    if (slot.operation || slot.stop || slot.unknown || before.actualPending || before.scopeRevision < slot.scope || !observable(before)
      || owned.current?.scope !== before.scopeRevision) return
    slot.operation = true
    const generation = lifecycle.current.generation
    const valid = () => lifecycle.current.active && lifecycle.current.generation === generation
    setBusy(true); setError(undefined); clearPreview()
    void (async () => {
      try {
        const result = await api.capture({ scopeRevision: before.scopeRevision })
        if (!valid() || owned.current?.scope !== before.scopeRevision
          || current.current.scopeRevision !== before.scopeRevision
          || result.state.scopeRevision !== before.scopeRevision || !observable(result.state)
          || result.state.revision < current.current.revision
          || (result.state.revision === current.current.revision && result.state.frame?.id !== current.current.frame?.id)) return
        const recorded = recordStatus(slot, result.state)
        if (!recorded || !accept(recorded)) return
        setPreview(result.preview)
        setPreviewUnavailable(result.previewUnavailable ? '当前系统无法生成本地缩略图。' : undefined)
      } catch { if (valid()) setError('无法获取本地静态截图。') }
      finally { slot.operation = false; publish(slot); if (valid()) setBusy(!lifecycle.current.known || slot.stop || slot.unknown || pending(current.current)) }
    })()
  }, [accept, clearPreview])

  const onStop = useCallback(() => requestStop(true), [requestStop])
  // Mode changes revoke only this page's exact scope, not a passively read lease.
  const onModeChange = useCallback(() => requestStop(), [requestStop])
  return { state, preview, previewUnavailable, busy, error, onStart, onCapture, onStop, onModeChange, closeLocalPane }
}
