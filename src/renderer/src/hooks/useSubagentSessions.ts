import { useCallback, useEffect, useRef, useState } from 'react'
import type { PionApi } from '../../../shared/pion-api'
import { SUBAGENT_SESSION_RETENTION_MS, type SubagentSessionList, type SubagentSessionSnapshot, type SubagentSessionSummary } from '../../../shared/subagent-sessions'

type Target = { id: string; backendId: string }
const keyOf = (target: Target): string => JSON.stringify([target.backendId, target.id])
const terminal = (status: SubagentSessionSummary['status']): boolean => ['completed', 'failed', 'aborted'].includes(status)
// Retention is a countdown, not a display revision. Unrelated children must not invalidate a read.
const bindingOf = (summary: SubagentSessionSummary): string => JSON.stringify([
  summary.backendId, summary.id, summary.runtimeId, summary.parentToolCallId, summary.cwd,
  summary.parentSessionId, summary.parentSessionPath, summary.name, summary.status, summary.truncated
])
const versionOf = (summary: SubagentSessionSummary): string => JSON.stringify([bindingOf(summary), summary.revision])

/** Only observes the host's memory store; never selects or starts an SDK session. */
export function useSubagentSessions(api: PionApi | undefined, enabled = true) {
  const [sessions, setSessions] = useState<SubagentSessionSummary[]>([])
  const [selected, setSelected] = useState<SubagentSessionSnapshot | null>(null)
  const [selectedTarget, setSelectedTarget] = useState<Target | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const target = useRef<Target | null>(null)
  const generation = useRef(0)
  const slot = useRef<Promise<SubagentSessionSnapshot | null> | null>(null)
  const refresh = useRef<() => void>(() => {})
  const scopeApi = useRef(api)
  const deadlines = useRef(new Map<string, number>())
  const expired = useRef(new Map<string, number>())
  const retiredRevisionFloor = useRef(-1)
  const listRevision = useRef(-1)
  const summaries = useRef<SubagentSessionSummary[]>([])
  const close = useCallback(() => {
    generation.current += 1
    target.current = null
    setSelectedTarget(null)
    setSelected(null)
    setLoading(false)
    setError('')
  }, [])
  const open = useCallback((summary: SubagentSessionSummary) => {
    const key = keyOf(summary)
    const known = summaries.current.find((item) => keyOf(item) === key)
    if (!enabled || !api || scopeApi.current !== api || document.hidden || !known || versionOf(known) !== versionOf(summary)
      || expired.current.has(key) || (deadlines.current.get(key) ?? Infinity) <= performance.now()) return
    generation.current += 1
    target.current = { id: known.id, backendId: known.backendId }
    setSelectedTarget(target.current)
    setSelected(null)
    setError('')
    setLoading(true)
    refresh.current()
  }, [api, enabled])

  useEffect(() => {
    if (scopeApi.current !== api) {
      scopeApi.current = api
      deadlines.current.clear()
      expired.current.clear()
      retiredRevisionFloor.current = -1
      listRevision.current = -1
      summaries.current = []
      setSessions([])
      close()
    }
    if (!api || !enabled) {
      summaries.current = []
      setSessions([])
      close()
      return
    }
    let active = true
    let collecting = false
    let epoch = 0
    let unsubscribe: (() => void) | undefined
    let timer: number | undefined
    const rememberExpired = (key: string): void => {
      deadlines.current.delete(key)
      // This floor belongs to the global list, never a child's local revision.
      expired.current.set(key, listRevision.current)
      while (expired.current.size > 1024) {
        const oldest = expired.current.entries().next().value
        if (!oldest) break
        retiredRevisionFloor.current = Math.max(retiredRevisionFloor.current, oldest[1])
        expired.current.delete(oldest[0])
      }
    }
    const accept = (summary: SubagentSessionSummary): boolean => {
      const key = keyOf(summary)
      if (expired.current.has(key)) return false
      if (terminal(summary.status)) {
        const remaining = Math.min(SUBAGENT_SESSION_RETENTION_MS, Math.max(0, summary.retentionRemainingMs ?? SUBAGENT_SESSION_RETENTION_MS))
        deadlines.current.set(key, Math.min(deadlines.current.get(key) ?? Infinity, performance.now() + remaining))
      }
      if ((deadlines.current.get(key) ?? Infinity) <= performance.now()) {
        rememberExpired(key)
        return false
      }
      return true
    }
    const prune = (): void => {
      // Hidden/disabled rows may no longer be in the projection, but their clocks still expire.
      for (const [key, deadline] of deadlines.current) if (deadline <= performance.now()) rememberExpired(key)
      const next = summaries.current.filter(accept)
      if (next.length !== summaries.current.length) {
        summaries.current = next
        if (collecting) setSessions(next)
      }
      if (target.current && expired.current.has(keyOf(target.current))) close()
    }
    const fetchDetail = (): void => {
      prune()
      const current = target.current
      if (!active || !collecting || !current || slot.current) return
      const known = summaries.current.find((item) => keyOf(item) === keyOf(current))
      if (!known) { close(); return }
      const requestVersion = versionOf(known)
      const requestGeneration = generation.current
      const promise = api.getSubagentSession(current.id, current.backendId)
      slot.current = promise
      void promise.then((snapshot) => {
        if (!active || !collecting || requestGeneration !== generation.current) return
        const latest = summaries.current.find((item) => keyOf(item) === keyOf(current))
        if (!latest || versionOf(latest) !== requestVersion) return
        if (!snapshot) {
          rememberExpired(keyOf(current))
          summaries.current = summaries.current.filter((item) => keyOf(item) !== keyOf(current))
          setSessions(summaries.current)
          close()
          return
        }
        if (keyOf(snapshot) !== keyOf(current) || bindingOf(snapshot) !== bindingOf(latest) || snapshot.revision < latest.revision) return
        if (!accept(snapshot)) { prune(); return }
        setSelected((previous) => previous && previous.revision > snapshot.revision ? previous : snapshot)
        setError('')
      }, () => {
        if (active && collecting && requestGeneration === generation.current) setError('子会话读取失败，请稍后重试或返回父会话。')
      }).finally(() => {
        if (slot.current === promise) slot.current = null
        if (active && collecting && requestGeneration === generation.current) setLoading(false)
        // Real IPC settlement owns the slot, even across visibility and API identity changes.
        if (requestGeneration !== generation.current) refresh.current()
      })
    }
    refresh.current = fetchDetail
    const receive = (list: SubagentSessionList): void => {
      if (!active || !collecting || list.revision < listRevision.current
        || (list.revision === listRevision.current && summaries.current.length > 0)
        || list.revision <= retiredRevisionFloor.current) return
      const previous = target.current && summaries.current.find((item) => keyOf(item) === keyOf(target.current!))
      listRevision.current = list.revision
      const incomingKeys = new Set(list.sessions.map(keyOf))
      for (const item of summaries.current) if (!incomingKeys.has(keyOf(item))) rememberExpired(keyOf(item))
      summaries.current = list.sessions.filter(accept)
      setSessions(summaries.current)
      const next = target.current && summaries.current.find((item) => keyOf(item) === keyOf(target.current!))
      if (target.current && !next) close()
      else if (previous && next && versionOf(previous) !== versionOf(next)) {
        generation.current += 1
        setSelected(null)
        setLoading(true)
      }
      fetchDetail()
    }
    const stop = (): void => {
      collecting = false
      epoch += 1
      unsubscribe?.()
      unsubscribe = undefined
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      setSessions([])
      close()
    }
    const start = (): void => {
      if (!active || collecting || document.hidden) return
      collecting = true
      const currentEpoch = ++epoch
      prune()
      setSessions(summaries.current)
      const receiveCurrent = (list: SubagentSessionList): void => {
        if (currentEpoch === epoch) receive(list)
      }
      // Subscribe first: bootstrap responses and detached callbacks are epoch fenced.
      unsubscribe = api.onSubagentSessions(receiveCurrent)
      void api.listSubagentSessions().then(receiveCurrent, () => {
        if (active && collecting && currentEpoch === epoch && listRevision.current < 0) setError('子会话列表读取失败。')
      })
      timer = window.setInterval(() => { prune(); if (target.current) fetchDetail() }, 500)
    }
    const visibility = (): void => { if (document.hidden) stop(); else start() }
    document.addEventListener('visibilitychange', visibility)
    start()
    return () => {
      active = false
      stop()
      document.removeEventListener('visibilitychange', visibility)
      refresh.current = () => {}
    }
  }, [api, enabled, close])

  return { sessions, selected, selectedTarget, open, close, error, loading }
}
