import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunRecoveryCandidate, RunTelemetryQuery, RunTelemetryUpdate } from '../../../shared/types'

function isRelevantUpdate(
  update: RunTelemetryUpdate,
  candidateIds: Set<string>,
  sessionPath?: string,
  cwd?: string
): boolean {
  return update.runs.some((run) => (
    candidateIds.has(run.id)
    || ((run.state === 'interrupted' || (run.state === 'queued' && run.interruptedAt !== undefined))
      && (run.sessionPath === sessionPath || (!run.sessionPath && run.cwd === cwd)))
  ))
}

export function useRunRecovery({
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
  candidates: RunRecoveryCandidate[]
  busyId: string | null
  error: string
  resume: (runId: string) => Promise<void>
  discard: (runId: string) => Promise<void>
  restoreCheckpoint: (runId: string) => Promise<void>
} {
  const [candidates, setCandidates] = useState<RunRecoveryCandidate[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const candidatesRef = useRef(candidates)
  candidatesRef.current = candidates

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !hasBridge || (!sessionPath && !cwd)) {
      setCandidates([])
      return
    }
    const request = ++generation.current
    const query: RunTelemetryQuery = { sessionPath, cwd, limit: 50 }
    try {
      const next = await window.pion.getRunRecoveryCandidates(query)
      if (generation.current === request) setCandidates(next)
    } catch (cause) {
      if (generation.current !== request) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [cwd, enabled, hasBridge, sessionPath])

  useEffect(() => {
    setCandidates([])
    setError('')
    void refresh()
    if (!enabled || !hasBridge) return
    const off = window.pion.onRunTelemetry((update) => {
      const ids = new Set(candidatesRef.current.map((candidate) => candidate.run.id))
      if (isRelevantUpdate(update, ids, sessionPath, cwd)) void refresh()
    })
    return off
  }, [cwd, enabled, hasBridge, refresh, sessionPath])

  const perform = useCallback(async (
    runId: string,
    operation: () => Promise<unknown>
  ): Promise<void> => {
    setBusyId(runId)
    setError('')
    try {
      await operation()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }, [refresh])

  return {
    candidates,
    busyId,
    error,
    resume: (runId) => perform(runId, () => window.pion.resumeRun(runId)),
    discard: (runId) => perform(runId, () => window.pion.discardRunRecovery(runId)),
    restoreCheckpoint: (runId) => perform(runId, () => window.pion.restoreRecoveredCheckpoint(runId))
  }
}
