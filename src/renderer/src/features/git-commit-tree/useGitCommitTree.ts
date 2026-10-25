import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitCommitTreePage } from '../../../../shared/git-commit-tree'
import type { PionApi } from '../../../../shared/pion-api'

type ReadKind = 'initial' | 'refresh' | 'older'
interface ReadSlot { settled: Promise<void> }

// Hiding/unmounting invalidates publication, not the IPC. In particular, an
// A → B → A selection must wait for A's real pending read before reading A again.
const actualReads = new WeakMap<PionApi, Map<string, ReadSlot>>()

interface TreeView {
  scope: object
  data?: GitCommitTreePage
  loading: ReadKind | 'waiting' | null
  stale: boolean
  error?: { kind: ReadKind | 'stale'; message: string }
}

export function useGitCommitTree(cwd: string | undefined, visible: boolean) {
  const api = window.pion
  const getter = api?.getGitCommitTree
  const subscriber = api?.onGitSnapshot
  const scope = useMemo(() => ({}), [cwd, api, getter, subscriber])
  const activation = useMemo(() => ({}), [scope, visible])
  const latestActivation = useRef(activation)
  latestActivation.current = activation
  const emptyView = useMemo<TreeView>(() => ({ scope, loading: null, stale: false }), [scope])
  const [view, setView] = useState(emptyView)
  const current = view.scope === scope ? view : emptyView
  const viewRef = useRef(current)
  viewRef.current = current
  const actions = useRef({ refresh: () => {}, loadOlder: () => {} })

  useEffect(() => {
    let alive = true
    let requestId = 0
    let changeVersion = 0
    const isCurrent = (): boolean => alive && latestActivation.current === activation
      && window.pion === api && api?.getGitCommitTree === getter && api?.onGitSnapshot === subscriber
    const publish = (update: (previous: TreeView) => TreeView): void => {
      if (!isCurrent()) return
      const next = update(viewRef.current)
      viewRef.current = next
      setView(next)
    }
    // Keep loaded rows/selection while hidden. Notifications missed while closed
    // make this a retained, explicitly refreshable view, never a passive reload.
    publish((previous) => ({ ...previous, loading: null, stale: previous.stale || (!visible && !!previous.data) }))
    if (!visible || !cwd) return () => { alive = false }
    if (!api || typeof getter !== 'function' || typeof subscriber !== 'function') {
      publish((previous) => ({ ...previous, error: { kind: 'initial', message: '无法读取提交记录，请重试。' } }))
      return () => { alive = false }
    }
    let reads = actualReads.get(api)
    if (!reads) { reads = new Map(); actualReads.set(api, reads) }
    const slots = reads
    const read = (kind: ReadKind): void => {
      if (!isCurrent() || slots.has(cwd)) return
      const base = viewRef.current.data
      if (kind === 'older' && (!base?.nextCursor || viewRef.current.stale)) return
      const cursor = kind === 'older' ? base!.nextCursor! : undefined
      const id = ++requestId
      const version = changeVersion
      const ownsRequest = (): boolean => isCurrent() && requestId === id
      let release!: () => void
      const slot: ReadSlot = { settled: new Promise<void>((resolve) => { release = resolve }) }
      slots.set(cwd, slot)
      publish((previous) => ({ ...previous, loading: kind, error: undefined }))
      const fail = (cause: unknown): void => {
        const needsRefresh = (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '').includes('请刷新')
        if (ownsRequest()) publish((previous) => ({ ...previous, stale: previous.stale || needsRefresh, error: {
          kind: needsRefresh ? 'stale' : kind,
          message: needsRefresh ? '提交历史已变化，请刷新后继续加载。'
            : kind === 'older' ? '加载更早提交失败，现有记录已保留。' : '读取提交记录失败，请重试。'
        } }))
      }
      const settle = (): void => {
        if (slots.get(cwd) === slot) slots.delete(cwd)
        release()
        if (ownsRequest()) publish((previous) => ({ ...previous, loading: null }))
      }
      let pending: Promise<GitCommitTreePage>
      try { pending = api.getGitCommitTree(cwd, cursor) }
      catch (cause) { fail(cause); settle(); return }
      void pending.then((page) => {
        if (!ownsRequest() || changeVersion !== version) return
        if (cursor && (page.revision !== base!.revision || page.root !== base!.root
          || (page.nextCursor && (page.nextCursor.revision !== cursor.revision || page.nextCursor.offset <= cursor.offset)))) {
          publish((previous) => ({ ...previous, stale: true,
            error: { kind: 'stale', message: '提交历史已变化，请刷新后继续加载。' } }))
          return
        }
        const known = new Set(kind === 'older' ? base!.commits.map((commit) => commit.hash) : [])
        const commits = page.commits.filter((commit) => {
          if (known.has(commit.hash)) return false
          known.add(commit.hash)
          return true
        })
        if (cursor && commits.length === 0 && page.nextCursor) {
          publish((previous) => ({ ...previous, stale: true,
            error: { kind: 'stale', message: '提交分页未前进，请刷新后重试。' } }))
          return
        }
        publish((previous) => ({ ...previous, stale: false, error: undefined,
          data: { ...page, commits: kind === 'older' ? [...base!.commits, ...commits] : commits } }))
      }).catch(fail).finally(settle)
    }
    const unsubscribe = api.onGitSnapshot((update) => {
      const changedRoot = update.snapshot.root
      if (!isCurrent() || (changedRoot !== cwd && changedRoot !== viewRef.current.data?.root)) return
      ++changeVersion
      publish((previous) => ({ ...previous, stale: true }))
    })
    actions.current = {
      refresh: () => read(viewRef.current.data ? 'refresh' : 'initial'),
      loadOlder: () => read('older')
    }
    const existing = slots.get(cwd)
    if (existing) {
      publish((previous) => ({ ...previous, loading: 'waiting' }))
      void existing.settled.then(() => {
        if (!isCurrent()) return
        publish((previous) => ({ ...previous, loading: null }))
        if (!viewRef.current.data && !viewRef.current.stale) read('initial')
      })
    } else if (!viewRef.current.data && !viewRef.current.stale) read('initial')
    return () => {
      alive = false
      unsubscribe()
    }
  }, [scope, activation, api, getter, subscriber, cwd, visible])

  return {
    ...current,
    refresh: () => actions.current.refresh(),
    loadOlder: () => actions.current.loadOlder()
  }
}
