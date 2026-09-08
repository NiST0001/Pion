import { useCallback, useEffect, useRef, useState } from 'react'
import type { WindowEffectsState } from '../../../shared/window-effects'

export function useWindowEffects(applyToDocument = false) {
  const api = window.pion
  const [state, setState] = useState<WindowEffectsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const accept = useCallback((next: WindowEffectsState) => {
    setState((current) => current && current.revision > next.revision ? current : next)
  }, [])
  useEffect(() => {
    const generation = ++epoch.current
    if (!api?.getWindowEffects || !api.onWindowEffects) return
    const off = api.onWindowEffects((next) => { if (epoch.current === generation) accept(next) })
    void api.getWindowEffects().then((next) => {
      if (epoch.current === generation) accept(next)
    }).catch((cause) => { if (epoch.current === generation) setError(String(cause)) })
    return () => { epoch.current++; off() }
  }, [api, accept])
  useEffect(() => {
    if (!applyToDocument) return
    const root = document.documentElement
    root.dataset.nativeSurface = state?.active ? 'true' : 'false'
    root.dataset.nativeSurfaceBackend = state?.backend ?? 'unsupported'
  }, [applyToDocument, state?.active, state?.backend])
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!api?.setWindowEffects) return
    const generation = epoch.current
    setBusy(true); setError('')
    try {
      const next = await api.setWindowEffects(enabled)
      if (epoch.current === generation) accept(next)
    } catch (cause) {
      if (epoch.current === generation) setError(String(cause))
    } finally { if (epoch.current === generation) setBusy(false) }
  }, [api, accept])
  return { state, busy, error, setEnabled }
}
