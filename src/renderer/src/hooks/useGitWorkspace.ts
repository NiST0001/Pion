import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GitCommitResult,
  GitConflictContent,
  GitDiffScope,
  GitFileDiff,
  GitSelectionRequest,
  GitWorkspaceSnapshot
} from '../../../shared/types'

export function useGitWorkspace({
  hasBridge,
  cwd,
  enabled
}: {
  hasBridge: boolean
  cwd?: string
  enabled: boolean
}): {
  snapshot: GitWorkspaceSnapshot | null
  diff: GitFileDiff | null
  conflict: GitConflictContent | null
  loading: boolean
  diffLoading: boolean
  busy: boolean
  error: string
  result: string
  refresh: () => Promise<void>
  loadDiff: (path: string, scope: GitDiffScope) => Promise<void>
  stage: (paths: string[]) => Promise<void>
  unstage: (paths: string[]) => Promise<void>
  discard: (paths: string[]) => Promise<void>
  applySelection: (request: Omit<GitSelectionRequest, 'cwd' | 'snapshotId'>) => Promise<void>
  commit: (message: string) => Promise<GitCommitResult | null>
  readConflict: (path: string) => Promise<void>
  resolveConflict: (path: string, strategy: 'ours' | 'theirs' | 'content', content?: string) => Promise<void>
  continueOperation: () => Promise<void>
  abortOperation: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<GitWorkspaceSnapshot | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [conflict, setConflict] = useState<GitConflictContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const refreshGeneration = useRef(0)
  const diffGeneration = useRef(0)
  const busyRef = useRef(false)
  const rootRef = useRef<string | undefined>(undefined)
  busyRef.current = busy

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasBridge || !cwd || !enabled || busyRef.current) return
    const generation = ++refreshGeneration.current
    setLoading(true)
    try {
      const next = await window.pion.getGitStatus(cwd)
      if (refreshGeneration.current !== generation) return
      rootRef.current = next.root
      setSnapshot((current) => current?.snapshotId === next.snapshotId && current.root === next.root && current.operation === next.operation ? current : next)
      setError('')
    } catch (cause) {
      if (refreshGeneration.current !== generation) return
      setSnapshot(null)
      setDiff(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (refreshGeneration.current === generation) setLoading(false)
    }
  }, [cwd, enabled, hasBridge])

  useEffect(() => {
    rootRef.current = undefined
    setSnapshot(null)
    setDiff(null)
    setConflict(null)
    setResult('')
    setError('')
    if (!enabled || !hasBridge || !cwd) return
    void refresh()
    const off = window.pion.onGitSnapshot((update) => {
      if (update.snapshot.root === cwd || update.snapshot.root === rootRef.current) {
        rootRef.current = update.snapshot.root
        setSnapshot((current) => current?.snapshotId === update.snapshot.snapshotId && current.root === update.snapshot.root && current.operation === update.snapshot.operation ? current : update.snapshot)
      }
    })
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 2_500)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [cwd, enabled, hasBridge, refresh])

  const loadDiff = useCallback(async (path: string, scope: GitDiffScope): Promise<void> => {
    if (!cwd) return
    const generation = ++diffGeneration.current
    setDiffLoading(true)
    setError('')
    try {
      const next = await window.pion.getGitDiff(cwd, path, scope)
      if (diffGeneration.current === generation) setDiff(next)
    } catch (cause) {
      if (diffGeneration.current !== generation) return
      setDiff(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (diffGeneration.current === generation) setDiffLoading(false)
    }
  }, [cwd])

  const mutate = useCallback(async (
    operation: (current: GitWorkspaceSnapshot) => Promise<GitWorkspaceSnapshot>
  ): Promise<void> => {
    if (!snapshot) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      const next = await operation(snapshot)
      setSnapshot(next)
      setDiff(null)
      setConflict(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh, snapshot])

  return {
    snapshot,
    diff,
    conflict,
    loading,
    diffLoading,
    busy,
    error,
    result,
    refresh,
    loadDiff,
    stage: (paths) => mutate((current) => window.pion.stageGitPaths(current.root, current.snapshotId, paths)),
    unstage: (paths) => mutate((current) => window.pion.unstageGitPaths(current.root, current.snapshotId, paths)),
    discard: (paths) => mutate((current) => window.pion.discardGitPaths(current.root, current.snapshotId, paths)),
    applySelection: (request) => mutate((current) => window.pion.applyGitSelection({
      ...request,
      cwd: current.root,
      snapshotId: current.snapshotId
    })),
    commit: async (message) => {
      if (!snapshot) return null
      setBusy(true)
      setError('')
      setResult('')
      try {
        const committed = await window.pion.commitGit(snapshot.root, snapshot.snapshotId, message)
        setSnapshot(committed.snapshot)
        setDiff(null)
        setResult(committed.summary || `已提交 ${committed.commit.slice(0, 8)}`)
        return committed
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await refresh()
        return null
      } finally {
        setBusy(false)
      }
    },
    readConflict: async (path) => {
      if (!snapshot) return
      setDiffLoading(true)
      setError('')
      try {
        setConflict(await window.pion.readGitConflict(snapshot.root, path))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setDiffLoading(false)
      }
    },
    resolveConflict: (path, strategy, content) => mutate((current) =>
      window.pion.resolveGitConflict(current.root, current.snapshotId, path, strategy, content)
    ),
    continueOperation: () => mutate((current) =>
      window.pion.continueGitOperation(current.root, current.snapshotId)
    ),
    abortOperation: () => mutate((current) =>
      window.pion.abortGitOperation(current.root, current.snapshotId)
    )
  }
}
