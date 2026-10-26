import { useCallback, useEffect, useRef, useState } from 'react'
import type { PionApi } from '../../../shared/pion-api'
import { validateSessionOrganization, type SessionOrganization, type SessionOrganizationChange } from '../../../shared/session-organization'

export const EMPTY_SESSION_ORGANIZATION: SessionOrganization = { version: 1, revision: 0, folders: [], sessions: [] }
type OrganizationApi = Pick<PionApi, 'getSessionOrganization' | 'updateSessionOrganization'>
type Owner = { api: OrganizationApi | undefined }
type View = { owner: Owner; snapshot: SessionOrganization | null; loading: boolean; error: string }

export function useSessionOrganization(api: OrganizationApi | undefined) {
  const ownerRef = useRef<Owner>({ api })
  if (ownerRef.current.api !== api) ownerRef.current = { api }
  const owner = ownerRef.current
  const [view, setView] = useState<View>({ owner, snapshot: null, loading: true, error: '' })
  const current = view.owner === owner ? view : { owner, snapshot: null, loading: true, error: '' }
  const latest = useRef(current)
  latest.current = current
  const mounted = useRef(false)
  const reading = useRef<{ owner: Owner; promise: Promise<void> } | null>(null)
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const available = typeof api?.getSessionOrganization === 'function' && typeof api?.updateSessionOrganization === 'function'

  const publish = useCallback((patch: Partial<Omit<View, 'owner'>>): void => {
    if (!mounted.current || ownerRef.current !== owner) return
    const before = latest.current
    const snapshot = patch.snapshot && before.snapshot && patch.snapshot.revision < before.snapshot.revision
      ? before.snapshot : patch.snapshot
    const next = { ...before, ...patch, owner, ...('snapshot' in patch ? { snapshot: snapshot ?? null } : {}) }
    latest.current = next
    setView(next)
  }, [owner])

  const refresh = useCallback((): Promise<void> => {
    if (reading.current?.owner === owner) return reading.current.promise
    if (!available || !api) {
      publish({ loading: false, error: '会话整理暂不可用，请重新打开应用。' })
      return Promise.resolve()
    }
    publish({ loading: true, error: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await api.getSessionOrganization()
        if (mounted.current && ownerRef.current === owner) {
          publish({ snapshot: validateSessionOrganization(result), loading: false, error: '' })
        }
      } catch (error) {
        publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (reading.current?.promise === promise) reading.current = null
      }
    })
    reading.current = { owner, promise }
    return promise
  }, [api, available, owner, publish])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  const update = useCallback(async (change: SessionOrganizationChange): Promise<void> => {
    if (!mounted.current || ownerRef.current !== owner || !available || !api || !latest.current.snapshot) {
      throw new Error('会话整理尚未读取完成，请稍后重试。')
    }
    if (pending.current) throw new Error('会话整理正在保存，请稍后重试。')
    pending.current = true
    setSaving(true)
    try {
      const result = await api.updateSessionOrganization(change)
      if (!mounted.current || ownerRef.current !== owner) throw new Error('会话整理所属页面已变化。')
      publish({ snapshot: validateSessionOrganization(result), error: '' })
    } catch (error) {
      publish({ error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }, [api, available, owner, publish])

  return {
    organization: current.snapshot ?? EMPTY_SESSION_ORGANIZATION,
    ready: current.snapshot !== null,
    loading: current.loading,
    saving,
    error: current.error,
    update,
    refresh
  }
}
