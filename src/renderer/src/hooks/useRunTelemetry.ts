import { useEffect, useMemo, useState } from 'react'
import type { RunOperation, RunTelemetryUpdate } from '../../../shared/types'
import { compareMetricsRuns, isExecutingRun, isRunMetricsCandidate } from '../../../shared/operations'

const VISIBLE_RUN_LIMIT = 20

function belongsToSelection(run: RunOperation, sessionPath?: string, cwd?: string): boolean {
  if (sessionPath && run.sessionPath === sessionPath) return true
  return Boolean(cwd && run.cwd === cwd && (!sessionPath || !run.sessionPath))
}

interface TelemetryState {
  runs: RunOperation[]
  revisions: Map<string, number>
}
const emptyTelemetry = (): TelemetryState => ({ runs: [], revisions: new Map() })

function mergeRuns(current: TelemetryState, update: RunTelemetryUpdate, sessionPath?: string, cwd?: string): TelemetryState {
  const revisions = new Map(current.revisions)
  const byId = new Map(current.runs.map((run) => [run.id, run]))
  for (const run of update.runs) {
    if (Math.max(revisions.get(run.id) ?? -1, byId.get(run.id)?.revision ?? -1) > run.revision) continue
    revisions.delete(run.id)
    revisions.set(run.id, run.revision)
    // Keep bounded tombstones for requeued/discarded records too, so a late
    // initial snapshot cannot resurrect their older running state.
    if (revisions.size > 256) revisions.delete(revisions.keys().next().value!)
    if (belongsToSelection(run, sessionPath, cwd) && isRunMetricsCandidate(run)) byId.set(run.id, run)
    else byId.delete(run.id)
  }
  return {
    revisions,
    runs: [...byId.values()].sort(compareMetricsRuns).slice(0, VISIBLE_RUN_LIMIT)
  }
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
  const [telemetry, setTelemetry] = useState<TelemetryState>(emptyTelemetry)
  const runs = telemetry.runs
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !hasBridge || (!sessionPath && !cwd)) {
      setTelemetry(emptyTelemetry())
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setTelemetry(emptyTelemetry())
    const off = window.pion.onRunTelemetry((update) => {
      if (active) setTelemetry((current) => mergeRuns(current, update, sessionPath, cwd))
    })
    void window.pion.getRunTelemetry({ sessionPath, cwd, limit: VISIBLE_RUN_LIMIT, metricsOnly: true })
      .then((result) => {
        if (!active) return
        setTelemetry((current) => mergeRuns(current, { runs: result }, sessionPath, cwd))
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
    () => runs.find(isExecutingRun) ?? null,
    [runs]
  )
  return { runs, latestRun, activeRun, loading }
}
