import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AgentState, TimelineItem } from '../agent/types'
import type { SessionHistoryIndex } from '../../../shared/types'
import {
  readConversationReadingPosition,
  saveConversationReadingPosition,
  type ConversationReadingPosition
} from '../utils/conversationReadingPosition'

type Restore = (entryId: string, offset: number, isCurrent?: () => boolean, readingToken?: object) => Promise<boolean>
type Phase = 'idle' | 'waiting' | 'request' | 'locating' | 'failed' | 'retired'
interface Options {
  scrollRef: RefObject<HTMLDivElement | null>
  persist: boolean
  viewportActive: boolean
  cwd?: string
  path?: string
  reset: number
  scope: number
  ready: boolean
  loading: boolean
  error?: string | null
  timeline: TimelineItem[]
  index?: SessionHistoryIndex | null
  indexPath?: string
  restore?: Restore
  loadLatest?: (isCurrent?: () => boolean) => Promise<boolean>
  loadNewer: () => Promise<void>
  hasNewer: () => boolean
  anchor: (element: HTMLElement) => number
  following: () => boolean
  canCapture: () => boolean
  hold: () => void
  beginBottom: () => void
  follow: (element: HTMLElement) => void
}
interface Owner {
  api: typeof window.pion
  cwd?: string
  path?: string
  reset: number
  scope: number
  persist: boolean
  restore?: Restore
  loadLatest?: Options['loadLatest']
  writable: boolean
  position: ConversationReadingPosition | null
  snapshot: ConversationReadingPosition | null
  phase: Phase
  token: number
  jumpToken?: object
  resumePhase?: Phase
  attemptedIndex?: SessionHistoryIndex | null
  page?: TimelineItem[]
}

/** Storage owns only captured metadata. Cleanup never samples a replacement DOM. */
export function useConversationReadingPosition(options: Options) {
  const api = window.pion
  const latest = useRef(options)
  latest.current = options
  const owner = useRef<Owner | null>(null)
  const invalidatedPositions = useRef(new Set<string>())
  const mounted = useRef(true)
  const timer = useRef<number | null>(null)
  const [restoreLayoutRevision, setRestoreLayoutRevision] = useState(0)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const shown = useRef(false)
  const [scrollToBottomBusy, setScrollToBottomBusy] = useState(false)
  const bottom = useRef<{
    owner: Owner; token: number
    fallback: Pick<Owner, 'position' | 'phase' | 'snapshot'>
  } | null>(null)
  const restoreBottomFallback = useCallback(() => {
    const request = bottom.current
    if (!request) return
    const { owner: target, fallback } = request
    target.position = fallback.position
    target.snapshot = fallback.snapshot
    // The replaced/cancelled window has no capture authority. Preserve the
    // source record and wait for a new index or an explicit user action.
    target.phase = fallback.phase === 'retired' ? 'retired' : 'failed'
    bottom.current = null
  }, [])

  const flush = useCallback((target = owner.current) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    if (target?.writable && target.persist && target.cwd && target.path && target.snapshot) {
      if (saveConversationReadingPosition(target.cwd, target.path, target.snapshot)) {
        invalidatedPositions.current.delete(JSON.stringify([target.cwd, target.path]))
      }
    }
  }, [])
  const matches = useCallback((target: Owner, token = target.token): boolean => {
    const current = latest.current
    return mounted.current && owner.current === target && target.token === token
      && window.pion === target.api && current.viewportActive && !document.hidden
      && current.cwd === target.cwd && current.path === target.path
      && current.reset === target.reset && current.scope === target.scope
      && current.persist === target.persist && current.restore === target.restore
      && current.loadLatest === target.loadLatest
  }, [])
  const blocked = useCallback(() => {
    const target = owner.current
    return !!target && target.phase !== 'idle'
  }, [])
  const updateButton = useCallback(() => {
    const current = latest.current
    const element = current.scrollRef.current
    const show = !!element && current.viewportActive && current.timeline.length > 0
      && (current.hasNewer() || !current.following()
        || element.scrollHeight - element.scrollTop - element.clientHeight > 1)
    if (shown.current !== show) { shown.current = show; setShowScrollToBottom(show) }
  }, [])
  const capture = useCallback(() => {
    updateButton()
    const current = latest.current, target = owner.current
    const element = current.scrollRef.current
    if (!target || !matches(target) || !target.writable || !target.persist || !target.cwd || !target.path || !element
      || !current.ready || current.loading || current.error
      || target.phase !== 'idle' || bottom.current || !current.canCapture()) return
    const end = current.following() && !current.hasNewer()
    const anchor = current.anchor(element)
    const rows = [...element.querySelectorAll<HTMLElement>('.row-user')]
    let row = rows[0]
    for (const candidate of rows) {
      if (candidate.getBoundingClientRect().top > anchor) break
      row = candidate
    }
    // Real SDK user IDs only. A newer unpersisted user row must not borrow an
    // older turn's ID, timestamp or body as a persistence identity.
    const entryId = row?.dataset.entryId
    if (!end && (!entryId || rows.filter(item => item.dataset.entryId === entryId).length !== 1)) return
    // A paged prefix can start inside an earlier, unmounted turn. A future
    // user row is an anchor only when the branch index proves it is the first.
    if (!end && row.getBoundingClientRect().top > anchor
      && (!current.index || current.indexPath !== current.path || current.index.sessionPath !== current.path
        || current.index.landmarks[0]?.entryId !== entryId)) return
    const snapshot: ConversationReadingPosition = end ? { version: 1, end: true, offset: 0 }
      : { version: 1, end: false, entryId, offset: row.getBoundingClientRect().top - anchor }
    if (target.snapshot?.end === snapshot.end && target.snapshot.entryId === snapshot.entryId
      && target.snapshot.offset === snapshot.offset) return
    target.snapshot = snapshot
    if (timer.current === null) timer.current = window.setTimeout(() => {
      if (owner.current === target) flush(target)
    }, 200)
  }, [flush, matches, updateButton])

  const retire = useCallback((reason: 'gesture' | 'jump' | 'hidden') => {
    const target = owner.current
    if (!target) return
    if (reason === 'hidden') restoreBottomFallback()
    target.token++
    target.jumpToken = undefined
    target.page = undefined
    if (reason === 'hidden') {
      flush(target)
      if (target.phase !== 'idle' && target.phase !== 'retired') {
        target.resumePhase = target.phase === 'failed' ? 'failed' : 'waiting'
        target.phase = 'retired'
      }
    } else {
      target.phase = 'idle'
      target.position = null
      // A pointer-down may precede the scroll itself. Keep the last trusted
      // snapshot until the gesture yields a new ready-frame capture.
    }
    bottom.current = null
    setScrollToBottomBusy(false)
  }, [flush, restoreBottomFallback])
  const reactivate = useCallback(() => {
    const target = owner.current
    if (!target || !matches(target) || target.phase !== 'retired') return
    target.phase = target.resumePhase ?? (target.position ? 'waiting' : 'idle')
    target.resumePhase = undefined
    if (target.phase === 'waiting') target.attemptedIndex = undefined
  }, [matches])

  useLayoutEffect(() => {
    mounted.current = true
    setScrollToBottomBusy(false)
    return () => {
      mounted.current = false
      restoreBottomFallback()
      const target = owner.current
      if (target) {
        target.token++
        target.page = undefined
        if (['request', 'locating'].includes(target.phase)) {
          target.phase = 'waiting'
          target.attemptedIndex = undefined
        }
      }
      bottom.current = null
      flush()
    }
  }, [flush, restoreBottomFallback])

  // This effect precedes the navigation core's layout effects. Hold follow
  // intent before any replace/resize/panel-pin path can see a saved reader.
  useLayoutEffect(() => {
    const previous = owner.current
    const changed = !previous || previous.api !== api || previous.cwd !== options.cwd || previous.path !== options.path
      || previous.reset !== options.reset || previous.scope !== options.scope
      || previous.persist !== options.persist || previous.restore !== options.restore
      || previous.loadLatest !== options.loadLatest
    if (changed) {
      const undo = !!previous && previous.cwd === options.cwd && previous.path === options.path && previous.reset !== options.reset
      const key = options.cwd && options.path ? JSON.stringify([options.cwd, options.path]) : undefined
      if (undo && key) {
        invalidatedPositions.current.add(key)
        // A successful undo explicitly selects a new branch. Persist only its
        // end intent, never the former branch's captured DOM position.
        if (previous.writable && previous.persist && options.persist) {
          saveConversationReadingPosition(options.cwd!, options.path!, { version: 1, end: true, offset: 0 })
        }
      }
      if (previous) { previous.token++; if (!undo) flush(previous) }
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      bottom.current = null
      setScrollToBottomBusy(false)
      const stored = options.persist && options.cwd && options.path && !undo
        ? readConversationReadingPosition(options.cwd, options.path)
        : { ok: undo ? previous?.writable ?? true : true, position: null }
      const position: ConversationReadingPosition | null = key && invalidatedPositions.current.has(key)
        ? { version: 1, end: true, offset: 0 } : stored.position
      owner.current = {
        api, cwd: options.cwd, path: options.path, reset: options.reset, scope: options.scope,
        persist: options.persist, restore: options.restore, loadLatest: options.loadLatest,
        writable: stored.ok, position, snapshot: null,
        phase: position ? 'waiting' : 'idle', token: 0
      }
    }
    if (!options.viewportActive || document.hidden) {
      if (bottom.current || (owner.current && ['waiting', 'request', 'locating'].includes(owner.current.phase))) retire('hidden')
      updateButton()
    } else {
      reactivate()
      if (blocked()) options.hold()
    }
  }, [api, options.cwd, options.path, options.reset, options.scope, options.persist, options.restore, options.loadLatest,
    options.viewportActive, blocked, flush, retire, reactivate, updateButton])

  useLayoutEffect(() => {
    const target = owner.current, current = latest.current
    if (!target || !matches(target) || !current.ready || current.loading || current.error || !current.restore
      || !target.position || target.position.end || !['waiting', 'failed'].includes(target.phase)
      || !current.index || current.indexPath !== current.path || current.index.sessionPath !== current.path
      || target.attemptedIndex === current.index) return
    const position = target.position
    target.attemptedIndex = current.index
    if (current.index.landmarks.filter(mark => mark.entryId === position.entryId).length !== 1) {
      target.phase = 'failed'
      return
    }
    target.phase = 'request'
    target.page = undefined
    const token = ++target.token
    const tokenObject = {}
    target.jumpToken = tokenObject
    const isCurrent = () => matches(target, token) && ['request', 'locating'].includes(target.phase)
    void current.restore(position.entryId!, position.offset, isCurrent, tokenObject).then(accepted => {
      if (!isCurrent()) return
      target.phase = accepted ? 'locating' : 'failed'
    }, () => { if (isCurrent()) target.phase = 'failed' })
  }, [api, options.ready, options.loading, options.error, options.index, options.indexPath,
    options.cwd, options.path, options.scope, options.reset, options.viewportActive,
    options.persist, options.restore, options.loadLatest, restoreLayoutRevision, matches])

  const isRestoreJump = useCallback((jump: NonNullable<AgentState['historyJump']>) => {
    const target = owner.current
    return !!target && matches(target) && ['request', 'locating'].includes(target.phase)
      && !!target.jumpToken && jump.readingToken === target.jumpToken
      && !!target.position && target.position.entryId === jump.entryId
      && target.position.offset === jump.readingOffset
  }, [matches])
  const completeRestore = useCallback(() => {
    const target = owner.current
    if (!target || !matches(target)) return
    target.phase = 'idle'
    target.position = null
    target.page = undefined
    capture()
  }, [capture, matches])
  const failRestore = useCallback(() => {
    const target = owner.current
    if (target && matches(target) && target.phase !== 'idle') {
      target.phase = 'failed'
      target.page = undefined
      updateButton()
    }
  }, [matches, updateButton])

  // Await React's accepted window, then a real frame boundary. Provider/IPC
  // completion alone has no authority to read or reposition replacement DOM.
  const afterPaint = useCallback((isCurrent: () => boolean, action: () => void) => {
    window.requestAnimationFrame(() => {
      if (!isCurrent()) return
      window.requestAnimationFrame(() => { if (isCurrent()) action() })
    })
  }, [])
  const extendRestore = useCallback(() => {
    const target = owner.current, current = latest.current
    if (!target || !matches(target) || target.page || current.loading || current.error || !current.hasNewer()) return
    const before = current.timeline, token = target.token
    target.page = before
    const isCurrent = () => matches(target, token) && ['request', 'locating'].includes(target.phase)
    void current.loadNewer().then(() => {
      if (!isCurrent()) return
      afterPaint(isCurrent, () => {
        if (latest.current.timeline === before || latest.current.error || latest.current.loading) {
          target.phase = 'failed'
        }
        target.page = undefined
        if (target.phase !== 'failed') setRestoreLayoutRevision(value => value + 1)
      })
    }, () => { if (isCurrent()) { target.page = undefined; target.phase = 'failed' } })
  }, [matches, afterPaint])

  const scrollToBottom = useCallback(() => {
    const current = latest.current, target = owner.current
    if (!target || !matches(target) || bottom.current || !current.scrollRef.current
      || !current.ready || current.loading || (!current.timeline.length && !target.position?.end)) return
    const fallback = { position: target.position, phase: target.phase, snapshot: target.snapshot }
    const token = ++target.token
    target.jumpToken = undefined
    target.page = undefined
    const request = { owner: target, token, fallback }
    bottom.current = request
    target.phase = 'retired'
    setScrollToBottomBusy(true)
    current.beginBottom()
    const isCurrent = () => matches(target, token) && bottom.current === request
    const fail = () => {
      if (!isCurrent()) return
      restoreBottomFallback()
      setScrollToBottomBusy(false)
      updateButton()
    }
    const finish = () => {
      if (!isCurrent()) return
      const next = latest.current, element = next.scrollRef.current
      if (!element || !next.ready || next.loading || next.error || next.hasNewer()) {
        fail()
        return
      }
      bottom.current = null
      setScrollToBottomBusy(false)
      target.phase = 'idle'
      target.position = null
      next.follow(element)
      capture()
      flush(target)
    }
    if (!current.hasNewer() && !current.error) { finish(); return }
    const before = current.timeline
    if (!current.loadLatest) { fail(); return }
    void current.loadLatest(isCurrent).then(accepted => {
      if (!isCurrent()) return
      if (!accepted) { fail(); return }
      afterPaint(isCurrent, () => {
        if (latest.current.timeline === before) { fail(); return }
        finish()
      })
    }, fail)
  }, [matches, restoreBottomFallback, afterPaint, capture, flush, updateButton])

  useLayoutEffect(() => {
    const target = owner.current, current = latest.current
    if (target && matches(target) && target.phase === 'waiting' && target.position?.end
      && current.ready && !current.loading && !current.error) scrollToBottom()
  }, [api, options.ready, options.loading, options.error, options.timeline, options.viewportActive,
    options.cwd, options.path, options.scope, options.reset, options.persist, options.restore, options.loadLatest,
    restoreLayoutRevision, matches, scrollToBottom])

  useEffect(() => {
    const hide = () => {
      if (document.hidden) { flush(); retire('hidden') }
      else { reactivate(); setRestoreLayoutRevision(value => value + 1); capture() }
    }
    const leave = () => flush()
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
    }
  }, [flush, retire, reactivate, capture])
  return {
    capture, retire, blocked, isRestoreJump, completeRestore, failRestore, extendRestore,
    restoreLayoutRevision, showScrollToBottom, scrollToBottom, scrollToBottomBusy
  }
}
