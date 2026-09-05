import { useEffect, useState } from 'react'

/**
 * Let the conversation paint first, then start secondary IPC reads in small
 * ordered waves. Session switches used to start telemetry, recovery, policy,
 * Git, verification and workflow reads in the same render that replaced a
 * long timeline, making every panel compete for the first frame.
 */
export function useSessionResourceStage(key: string, ready: boolean): number {
  const [progress, setProgress] = useState({ key: '', stage: 0 })

  useEffect(() => {
    const timers: number[] = []
    setProgress({ key, stage: 0 })
    if (!key || !ready) return

    // Telemetry/policy stay light. Git waits long enough for the history
    // opacity cascade to become visible; optional operation panels follow last.
    for (const [stage, delay] of [0, 80, 320, 460].entries()) {
      timers.push(window.setTimeout(() => {
        setProgress((current) => current.key === key
          ? { key, stage: stage + 1 }
          : current)
      }, delay))
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [key, ready])

  return progress.key === key ? progress.stage : 0
}
