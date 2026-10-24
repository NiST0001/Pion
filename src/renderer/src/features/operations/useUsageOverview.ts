import { useEffect, useMemo, useRef, useState } from 'react'
import type { PionApi } from '../../../../shared/pion-api'
import type { UsageOverview, UsageOverviewQuery } from '../../../../shared/usage-overview'

type Getter = PionApi['getUsageOverview']
interface ReadSlot { activation: object; scope: object; selection: object; result: Promise<UsageOverview> }

// A closed/unmounted view retires publication, never the real IPC reservation.
const actualReads = new WeakMap<PionApi, WeakMap<Getter, ReadSlot>>()
const SLOW_READ_MS = 8_000

function slotsFor(api: PionApi): WeakMap<Getter, ReadSlot> {
  let slots = actualReads.get(api)
  if (!slots) { slots = new WeakMap(); actualReads.set(api, slots) }
  return slots
}

function startRead(api: PionApi, getter: Getter, activation: object, scope: object,
  selection: { query: UsageOverviewQuery | undefined }): ReadSlot {
  const slots = slotsFor(api)
  const slot = { activation, scope, selection,
    result: Promise.resolve().then(() => selection.query === undefined ? getter.call(api) : getter.call(api, selection.query)) }
  slots.set(getter, slot)
  const release = (): void => { if (slots.get(getter) === slot) slots.delete(getter) }
  void slot.result.then(release, release)
  return slot
}

interface OverviewView {
  scope: object
  data?: UsageOverview
  attempted: boolean
  loading: boolean
  slow: boolean
  error?: string
}

/** Refresh on each open or explicit request; unrelated session/cwd changes do not read. */
export function useUsageOverview(open: boolean, suppliedApi?: PionApi, query?: UsageOverviewQuery) {
  const api = suppliedApi ?? (typeof window === 'undefined' ? undefined : window.pion)
  const getter = api?.getUsageOverview
  const scope = useMemo(() => ({}), [api, getter])
  const year = query?.year
  const month = query?.month
  const date = query?.date
  const startDay = query?.startDay ?? 1
  const selection = useMemo(() => ({ query: year ? { year, startDay }
    : date ? { date, startDay } : month ? { month, startDay } : startDay !== 1 ? { startDay } : undefined }),
    [scope, year, month, date, startDay])
  // Capture this opening's initial selection separately: reopening must not
  // revive a deferred selection from a retired opening. New filter clicks may
  // still queue once, after the previous actual read/close settles.
  const opening = useMemo(() => ({ initialSelection: selection }), [scope, open])
  const activation = useMemo(() => ({}), [opening, selection])
  const latestActivation = useRef(activation)
  latestActivation.current = activation
  const emptyView = useMemo<OverviewView>(() => ({ scope, attempted: false, loading: false, slow: false }), [scope])
  const [view, setView] = useState(emptyView)
  const current = view.scope === scope ? view : emptyView
  const viewRef = useRef(current)
  viewRef.current = current
  const refreshRef = useRef(() => {})

  useEffect(() => {
    let alive = true
    let requestId = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const isCurrent = (): boolean => {
      if (!alive) return false
      if (!open || latestActivation.current !== activation || api?.getUsageOverview !== getter
        || (suppliedApi === undefined && (typeof window === 'undefined' || window.pion !== api))) {
        alive = false
        return false
      }
      return true
    }
    const publish = (update: (previous: OverviewView) => OverviewView): void => {
      if (!isCurrent()) return
      const next = update(viewRef.current)
      viewRef.current = next
      setView(next)
    }
    refreshRef.current = () => {}
    if (!open) return () => { alive = false }
    if (!api || typeof getter !== 'function') {
      publish((previous) => ({ ...previous, attempted: true, loading: false, slow: false,
        error: '当前桌面主进程不支持使用总览，请更新后重试。' }))
      return () => { alive = false }
    }

    const observe = (slot: ReadSlot, ownsResult: boolean, readLatestSelection = false): void => {
      const id = ++requestId
      const ownsRequest = (): boolean => isCurrent() && id === requestId
      publish((previous) => ({ ...previous, attempted: true, loading: true, slow: false, error: undefined }))
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (ownsRequest()) publish((previous) => ({ ...previous, slow: true }))
      }, SLOW_READ_MS)
      const settle = (): void => {
        if (!ownsRequest()) return
        clearTimeout(timer)
        publish((previous) => ({ ...previous, loading: false, slow: false }))
        // A new explicit filter is not a retry of the old one. Coalesce rapid
        // selections while the real old read/close still holds its reservation.
        if (readLatestSelection) refresh()
      }
      void slot.result.then((data) => {
        if (ownsRequest() && ownsResult) publish((previous) => previous.data && data.revision < previous.data.revision
          ? { ...previous, error: '读取到较旧的快照，已保留上次成功数据。' }
          : { ...previous, data, error: undefined })
        settle()
      }, () => {
        if (ownsRequest() && ownsResult) publish((previous) => ({ ...previous,
          error: previous.data ? '刷新失败，已保留上次成功快照。请重试。' : '读取使用总览失败，请重试。' }))
        settle()
      })
    }
    const refresh = (): void => {
      if (!isCurrent() || slotsFor(api).has(getter)) return
      observe(startRead(api, getter, activation, scope, selection), true)
    }
    refreshRef.current = refresh
    const existing = slotsFor(api).get(getter)
    // StrictMode's effect replay keeps the same logical activation; a real
    // close/remount/API change has a different token and cannot adopt its data.
    if (existing) observe(existing, existing.activation === activation,
      existing.scope === scope && existing.selection !== selection && selection !== opening.initialSelection)
    else refresh()

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [activation, open, api, getter, suppliedApi, scope, selection, opening])

  const available = !!api && typeof getter === 'function'
  const pending = !!(api && typeof getter === 'function' && actualReads.get(api)?.has(getter))
  return {
    data: current.data,
    error: current.error,
    loading: open && (current.loading || pending),
    slow: current.slow,
    available,
    refresh: () => refreshRef.current()
  }
}
