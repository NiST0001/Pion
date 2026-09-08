import { useEffect, useRef, useState } from 'react'

/**
 * Start secondary IPC reads in ordered waves once a session first paints.
 * Readiness is a startup gate, not a subscription lifetime: pagination and
 * history jumps temporarily unset it without changing the selected session.
 */
export function useSessionResourceStage(key: string, ready: boolean): number {
  const [progress, setProgress] = useState({ key: '', stage: 0 })
  const startedKey = useRef<string | null>(null)
  const timers = useRef<number[]>([])

  // Only an actual project/session switch (or unmount) tears down the waves.
  useEffect(() => {
    startedKey.current = null
    setProgress({ key, stage: 0 })
    return () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current = []
      startedKey.current = null
    }
  }, [key])

  useEffect(() => {
    if (!key || !ready || startedKey.current === key) return
    startedKey.current = key
    for (const [stage, delay] of [0, 80, 320, 460].entries()) {
      timers.current.push(window.setTimeout(() => {
        setProgress((current) => current.key === key
          ? { key, stage: Math.max(current.stage, stage + 1) }
          : current)
      }, delay))
    }
    // Do not cancel on ready=false: active telemetry must keep streaming
    // while the user reads another window of this same session's history.
  }, [key, ready])

  return progress.key === key ? progress.stage : 0
}
