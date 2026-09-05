import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  VerificationKind,
  VerificationPlan,
  VerificationPolicy,
  VerificationRun,
  VerificationSnapshotUpdate
} from '../../../shared/types'

function mergeRuns(current: VerificationRun[], update: VerificationSnapshotUpdate, cwd?: string): VerificationRun[] {
  const byId = new Map(current.map((run) => [run.id, run]))
  for (const run of update.runs) {
    if (!cwd || run.cwd === cwd) byId.set(run.id, run)
  }
  return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, 30)
}

export function useVerification({
  hasBridge,
  enabled = true,
  cwd,
  sessionPath
}: {
  hasBridge: boolean
  enabled?: boolean
  cwd?: string
  sessionPath?: string
}): {
  plan: VerificationPlan | null
  policy: VerificationPolicy | null
  runs: VerificationRun[]
  latestRun: VerificationRun | null
  activeRun: VerificationRun | null
  liveLog: string
  loading: boolean
  busy: boolean
  error: string
  start: (kinds?: VerificationKind[]) => Promise<void>
  rerun: (runId: string) => Promise<void>
  cancel: (runId: string) => Promise<void>
  updatePolicy: (updates: Partial<Omit<VerificationPolicy, 'cwd'>>) => Promise<void>
  rediscover: () => Promise<void>
} {
  const [plan, setPlan] = useState<VerificationPlan | null>(null)
  const [policy, setPolicy] = useState<VerificationPolicy | null>(null)
  const [runs, setRuns] = useState<VerificationRun[]>([])
  const [logs, setLogs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (force = false): Promise<void> => {
    if (!hasBridge || !cwd) {
      setPlan(null)
      setPolicy(null)
      setRuns([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const [nextPlan, nextPolicy, nextRuns] = await Promise.all([
        window.pion.discoverVerification(cwd, force),
        window.pion.getVerificationPolicy(cwd),
        window.pion.listVerificationRuns(cwd)
      ])
      setPlan(nextPlan)
      setPolicy(nextPolicy)
      setRuns(nextRuns)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [cwd, hasBridge])

  useEffect(() => {
    setLogs({})
    if (!enabled) {
      setPlan(null)
      setPolicy(null)
      setRuns([])
      setLoading(false)
      return
    }
    void load(true)
    if (!hasBridge) return
    const offRuns = window.pion.onVerificationRuns((update) => {
      setRuns((current) => mergeRuns(current, update, cwd))
    })
    const offLog = window.pion.onVerificationLog((update) => {
      setLogs((current) => ({
        ...current,
        [update.runId]: `${current[update.runId] ?? ''}${update.text}`.slice(-24_000)
      }))
    })
    return () => {
      offRuns()
      offLog()
    }
  }, [cwd, enabled, hasBridge, load])

  const perform = useCallback(async (operation: () => Promise<VerificationRun>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const run = await operation()
      setRuns((current) => mergeRuns(current, { runs: [run] }, cwd))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [cwd])

  const latestRun = runs[0] ?? null
  const activeRun = useMemo(
    () => runs.find((run) => run.state === 'queued' || run.state === 'running') ?? null,
    [runs]
  )

  return {
    plan,
    policy,
    runs,
    latestRun,
    activeRun,
    liveLog: latestRun ? logs[latestRun.id] ?? '' : '',
    loading,
    busy,
    error,
    start: (kinds) => cwd
      ? perform(() => window.pion.startVerification(cwd, { kinds, sessionPath }))
      : Promise.resolve(),
    rerun: (runId) => perform(() => window.pion.rerunVerification(runId)),
    cancel: (runId) => perform(() => window.pion.cancelVerification(runId)),
    updatePolicy: async (updates) => {
      if (!cwd) return
      setBusy(true)
      setError('')
      try {
        setPolicy(await window.pion.setVerificationPolicy(cwd, updates))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    rediscover: () => load(true)
  }
}
