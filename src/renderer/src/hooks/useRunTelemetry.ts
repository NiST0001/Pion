import { useEffect, useMemo, useState } from 'react'
import type { RunOperation, RunTelemetryUpdate } from '../../../shared/types'

const VISIBLE_RUN_LIMIT = 20
const LIVE_STATES = new Set<RunOperation['state']>(['queued', 'dispatching', 'running', 'ending'])

function belongsToSelection(run: RunOperation, sessionPath?: string, cwd?: string): boolean {
  if (sessionPath && run.sessionPath === sessionPath) return true
  return Boolean(cwd && run.cwd === cwd && (!sessionPath || !run.sessionPath))
}

function mergeRuns(current: RunOperation[], update: RunTelemetryUpdate, sessionPath?: string, cwd?: string): RunOperation[] {
  const byId = new Map(current.map((run) => [run.id, run]))
  for (const run of update.runs) {
    const existing = byId.get(run.id)
    if (existing && existing.revision > run.revision) continue
    if (belongsToSelection(run, sessionPath, cwd)) byId.set(run.id, run)
    else byId.delete(run.id)
  }
  return [...byId.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, VISIBLE_RUN_LIMIT)
}

export function useRunTelemetry({
  hasBridge,
  enabled = true,
  sessionPath,
  cwd
}: {
  hasBridge: boolean
  enabled?: boolean
  sessionPath?: string
  cwd?: string
}): {
  runs: RunOperation[]
  latestRun: RunOperation | null
  activeRun: RunOperation | null
  loading: boolean
} {
  const [runs, setRuns] = useState<RunOperation[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !hasBridge || (!sessionPath && !cwd)) {
      setRuns([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setRuns([])
    const off = window.pion.onRunTelemetry((update) => {
      if (active) setRuns((current) => mergeRuns(current, update, sessionPath, cwd))
    })
    void window.pion.getRunTelemetry({ sessionPath, cwd, limit: VISIBLE_RUN_LIMIT })
      .then((result) => {
        if (!active) return
        setRuns((current) => mergeRuns(current, { runs: result }, sessionPath, cwd))
      })
      .catch((error: unknown) => {
        console.error('[pion] failed to load run telemetry:', error)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      off()
    }
  }, [cwd, enabled, hasBridge, sessionPath])

  const latestRun = runs[0] ?? null
  const activeRun = useMemo(
    () => runs.find((run) => LIVE_STATES.has(run.state)) ?? null,
    [runs]
  )
  return { runs, latestRun, activeRun, loading }
}
