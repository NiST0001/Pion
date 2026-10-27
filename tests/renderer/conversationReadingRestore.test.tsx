// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import {
  readConversationReadingPosition as read,
  saveConversationReadingPosition as save,
  type ConversationReadingPosition
} from '../../src/renderer/src/utils/conversationReadingPosition'
import type { SessionHistoryIndex } from '../../src/shared/types'

vi.mock('../../src/renderer/src/utils/historyReveal', () => ({ armPendingHistoryRevealRows: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.replaceChildren()
})
const cwd = '/project', path = '/sessions/a'
const position: ConversationReadingPosition = { version: 1, end: false, entryId: 'u1', offset: -652 }
const indexFor = (sessionPath = path): SessionHistoryIndex => ({
  sessionPath, totalEntries: 10, leafId: 'leaf',
  landmarks: [{ entryId: 'u1', entryIndex: 0, ordinal: 1, snippet: '', timestamp: '2026-01-01' }]
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(initial: Partial<Parameters<typeof useConversationNavigation>[0]> = {}, clampToSurface = false) {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const element = document.createElement('div')
  element.className = 'chat-scroll'
  const surface = document.createElement('div')
  const content = document.createElement('div')
  content.className = 'timeline'
  surface.append(content)
  element.append(surface)
  document.body.append(element)
  let height = 3000, top = 0, newer = false
  const surfaceHeight = () => clampToSurface ? Math.max(height, parseFloat(surface.style.minHeight) || 0) : height
  const clamp = (value: number) => Math.max(0, Math.min(surfaceHeight() - 400, value))
  if (clampToSurface) surface.getBoundingClientRect = () => ({ height: surfaceHeight() } as DOMRect)
  Object.defineProperties(element, {
    scrollHeight: { get: surfaceHeight }, clientHeight: { value: 400 },
    scrollTop: {
      // A layout read also applies the browser's clamp after min-height shrinks.
      get: () => { if (clampToSurface) top = clamp(top); return top },
      set: (value: number) => { top = clamp(value) }
    }
  })
  Object.defineProperty(content, 'offsetHeight', { get: () => height })
  const row = document.createElement('div')
  row.className = 'row-user'
  row.dataset.entryId = 'u1'
  row.getBoundingClientRect = () => ({ top: 400 - top } as DOMRect)
  content.append(row)
  let props: Parameters<typeof useConversationNavigation>[0] = {
    scrollRef: { current: element }, timeline: [{ kind: 'user', id: 1, entryId: 'u1', text: 'prompt' }],
    timelineMutation: 'replace', timelineReady: true, busy: false,
    projectCwd: cwd, sessionPath: path, historyIndexSessionPath: path, historyIndex: indexFor(),
    historyJump: null, persistReadingPosition: true,
    loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {}),
    hasNewerHistory: () => newer,
    restoreHistoryReadingPosition: vi.fn(async () => true),
    loadLatestHistory: vi.fn(async () => true), ...initial
  }
  const hook = renderHook(options => useConversationNavigation(options), { initialProps: props })
  hook.result.current.scrollSurfaceRef.current = surface
  const update = (changes: Partial<typeof props>) => { props = { ...props, ...changes }; hook.rerender(props) }
  const frame = () => act(() => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(20))
  })
  const finish = () => { for (let count = 0; frames.size && count < 20; count++) frame() }
  const gesture = (nextTop: number) => {
    act(() => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
      element.scrollTop = nextTop
      hook.result.current.handleTimelineScroll()
    })
    finish()
  }
  const locate = (saved = position, nonce = 1, readingToken?: object) => {
    const calls = vi.mocked(props.restoreHistoryReadingPosition!).mock.calls
    update({ historyJump: { entryId: saved.entryId!, readingOffset: saved.offset, nonce,
      readingToken: readingToken ?? calls[calls.length - 1]?.[3] } })
    finish()
  }
  const persist = () => act(() => { vi.advanceTimersByTime(250) })
  return { ...hook, element, surface, row, frame, finish, gesture, locate, persist, update,
    props: () => props, height: (value: number) => { height = value }, newer: (value: boolean) => { newer = value } }
}

async function settle() { await act(async () => { await Promise.resolve() }) }

describe('conversation reading restoration', () => {
  it('flushes the captured old owner on A→B→A and restores the real user offset after remount', async () => {
    const f = fixture()
    f.finish()
    f.gesture(900)
    // Do not wait for the debounce. New loading DOM must never be sampled as A.
    f.element.scrollTop = 50
    f.update({ sessionPath: '/sessions/b', historyScopeRevision: 1, timelineReady: false,
      timelineLoading: true, timeline: [], historyIndex: null, historyIndexSessionPath: undefined })
    expect(read(cwd, path).position).toEqual(position)
    f.update({ sessionPath: path, historyScopeRevision: 2, timelineReady: true, timelineLoading: false,
      timeline: [{ kind: 'user', id: 1, text: 'prompt' }], historyIndex: indexFor(), historyIndexSessionPath: path })
    expect(f.props().restoreHistoryReadingPosition).toHaveBeenCalledWith('u1', -652, expect.any(Function), expect.any(Object))
    await settle()
    f.locate()
    expect(f.element.scrollTop).toBe(900)
    expect(f.row.classList.contains('history-jump-target')).toBe(false)
    f.unmount()
    const remount = fixture()
    await settle()
    remount.locate()
    expect(remount.element.scrollTop).toBe(900)
    remount.update({ timeline: [...remount.props().timeline], timelineMutation: 'append', panelsVisible: true })
    remount.finish()
    expect(remount.element.scrollTop).toBe(900)
  })

  it('retires deferred A requests through A→B→A and a gesture rejects a late reading jump', async () => {
    save(cwd, path, position)
    const pending = deferred<boolean>()
    const checks: (() => boolean)[] = []
    const restore = vi.fn((_entry: string, _offset: number, current?: () => boolean) => {
      checks.push(current!)
      return pending.promise
    })
    const f = fixture({ restoreHistoryReadingPosition: restore })
    expect(checks[0]()).toBe(true)
    const oldToken = vi.mocked(f.props().restoreHistoryReadingPosition!).mock.calls[0][3]
    f.update({ sessionPath: '/sessions/b', historyScopeRevision: 1, timelineReady: false, historyIndex: null })
    expect(checks[0]()).toBe(false)
    f.update({ sessionPath: path, historyScopeRevision: 2, timelineReady: true, historyIndex: indexFor() })
    expect(checks).toHaveLength(2)
    expect(checks[0]()).toBe(false)
    expect(checks[1]()).toBe(true)
    f.locate(position, 4, oldToken) // Same entry/offset from the retired owner is still stale.
    expect(f.element.scrollTop).toBe(0)
    expect(checks[1]()).toBe(true)
    f.persist()
    expect(read(cwd, path).position).toEqual(position)
    f.gesture(700)
    expect(checks[1]()).toBe(false)
    await act(async () => pending.resolve(true))
    f.locate(position, 5) // A stale dispatcher gets no positioning authority.
    expect(f.element.scrollTop).toBe(700)
    f.persist()
    expect(read(cwd, path).position?.offset).toBe(-452)
  })

  it('rejects a replaced API immediately and starts a fresh owner on the next render', async () => {
    save(cwd, path, position)
    vi.stubGlobal('pion', {})
    const pending = deferred<boolean>()
    const checks: (() => boolean)[] = []
    const restore = vi.fn((_entry: string, _offset: number, current?: () => boolean) => {
      checks.push(current!)
      return pending.promise
    })
    const f = fixture({ restoreHistoryReadingPosition: restore })
    expect(checks[0]()).toBe(true)
    vi.stubGlobal('pion', {}) // No props or callback render has occurred yet.
    expect(checks[0]()).toBe(false)
    f.update({})
    expect(checks).toHaveLength(2)
    expect(checks[1]()).toBe(true)
    f.gesture(700)
    await act(async () => pending.resolve(true))
    f.locate()
    expect(f.element.scrollTop).toBe(700)
  })

  it.each(['viewport', 'document'] as const)('retries the saved anchor after a real %s reactivation', async source => {
    save(cwd, path, position)
    const pending = deferred<boolean>()
    const checks: (() => boolean)[] = []
    const restore = vi.fn((_entry: string, _offset: number, current?: () => boolean) => {
      checks.push(current!)
      return pending.promise
    })
    const f = fixture({ restoreHistoryReadingPosition: restore })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const visibility = (value: boolean) => act(() => {
      hidden.mockReturnValue(value)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    if (source === 'viewport') f.update({ viewportActive: false })
    else visibility(true)
    expect(checks[0]()).toBe(false)
    if (source === 'viewport') f.update({ viewportActive: true })
    else visibility(false)
    expect(checks).toHaveLength(2)
    expect(checks[0]()).toBe(false)
    expect(checks[1]()).toBe(true)
    f.locate()
    expect(f.element.scrollTop).toBe(900)
    // The accepted Promise may follow the already-completed React layout.
    expect(checks[1]()).toBe(false)
    await act(async () => pending.resolve(true))
    expect(checks[1]()).toBe(false)
    f.gesture(700)
    f.persist()
    expect(read(cwd, path).position?.offset).toBe(-452)
  })

  it('preserves malformed storage and waits for authoritative ready history before any default write', async () => {
    const key = 'pion:conversation-reading-v1:' + JSON.stringify([cwd, path])
    localStorage.setItem(key, '{broken')
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const bad = fixture()
    bad.finish()
    bad.gesture(800)
    bad.persist()
    act(() => bad.result.current.scrollToBottom())
    bad.finish()
    bad.persist()
    bad.update({ historyResetRevision: 1, timelineReady: false, timelineLoading: true })
    bad.unmount()
    expect(writes).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe('{broken')
    localStorage.clear()
    save(cwd, path, position)
    writes.mockClear()
    const f = fixture({ timelineReady: false, timelineLoading: true, timeline: [], historyIndex: null })
    f.finish()
    f.persist()
    expect(writes).not.toHaveBeenCalled()
    expect(f.props().restoreHistoryReadingPosition).not.toHaveBeenCalled()
    f.update({ timelineLoading: false, timelineError: 'read failed' })
    f.finish()
    f.persist()
    expect(writes).not.toHaveBeenCalled()
    expect(read(cwd, path).position).toEqual(position)
    await settle()
  })

  it('keeps unknown anchors untouched until a new index and excludes read-only or unassigned paths', async () => {
    save(cwd, path, position)
    const f = fixture({ historyIndex: { ...indexFor(), landmarks: [] } })
    f.finish()
    f.persist()
    expect(f.props().restoreHistoryReadingPosition).not.toHaveBeenCalled()
    expect(read(cwd, path).position).toEqual(position)
    expect(f.result.current.showScrollToBottom).toBe(true)
    f.update({ historyIndex: indexFor() })
    expect(f.props().restoreHistoryReadingPosition).toHaveBeenCalledTimes(1)
    await settle()
    f.unmount()
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const child = fixture({ persistReadingPosition: false })
    child.gesture(900)
    child.persist()
    child.unmount()
    const draft = fixture({ sessionPath: undefined })
    draft.gesture(900)
    draft.persist()
    draft.unmount()
    expect(writes).not.toHaveBeenCalled()
    expect(read(cwd, path).position).toEqual(position)
  })

  it('restores end-follow intent without a landmark request', () => {
    save(cwd, path, { version: 1, end: true, offset: 0 })
    const f = fixture()
    f.finish()
    expect(f.element.scrollTop).toBe(2600)
    expect(f.props().restoreHistoryReadingPosition).not.toHaveBeenCalled()
    expect(f.result.current.showScrollToBottom).toBe(false)
    f.height(3200)
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'append' })
    f.finish()
    f.persist()
    expect(f.element.scrollTop).toBe(2800)
    expect(read(cwd, path).position).toEqual({ version: 1, end: true, offset: 0 })
  })

  it('waits for ready before restoring saved end through a cached middle window', async () => {
    const end = { version: 1, end: true, offset: 0 } as const
    save(cwd, path, end)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const pending = deferred<boolean>()
    const loadLatest = vi.fn(() => pending.promise)
    let newer = true
    const f = fixture({ timelineReady: false, timelineLoading: true,
      hasNewerHistory: () => newer, loadLatestHistory: loadLatest })
    f.finish()
    f.persist()
    expect(loadLatest).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    f.update({ timelineReady: true, timelineLoading: false })
    expect(loadLatest).toHaveBeenCalledTimes(1)
    expect(f.result.current.scrollToBottomBusy).toBe(true)
    expect(writes).not.toHaveBeenCalled()
    newer = false
    f.height(4000)
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'replace' })
    await act(async () => pending.resolve(true))
    f.finish()
    expect(f.element.scrollTop).toBe(3600)
    expect(f.result.current.scrollToBottomBusy).toBe(false)
    expect(read(cwd, path).position).toEqual(end)
    expect(f.props().restoreHistoryReadingPosition).not.toHaveBeenCalled()
  })

  it('loads the actual latest window once, waits for its DOM commit, then follows and saves end', async () => {
    const pending = deferred<boolean>()
    const loadLatest = vi.fn(() => pending.promise)
    const f = fixture({ loadLatestHistory: loadLatest })
    f.newer(true)
    f.gesture(900)
    expect(f.result.current.showScrollToBottom).toBe(true)
    act(() => { f.result.current.scrollToBottom(); f.result.current.scrollToBottom() })
    expect(loadLatest).toHaveBeenCalledTimes(1)
    expect(f.result.current.scrollToBottomBusy).toBe(true)
    expect(f.element.scrollTop).toBe(900)
    f.newer(false)
    f.height(4000)
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'replace' })
    await act(async () => pending.resolve(true))
    expect(f.element.scrollTop).toBe(900)
    f.finish()
    expect(f.element.scrollTop).toBe(3600)
    expect(f.result.current.scrollToBottomBusy).toBe(false)
    expect(f.result.current.showScrollToBottom).toBe(false)
    expect(f.props().loadNewer).not.toHaveBeenCalled()
    expect(read(cwd, path).position?.end).toBe(true)
  })

  it('leaves the current reading window intact after latest failure and supports an explicit retry', async () => {
    const retry = deferred<boolean>()
    const loadLatest = vi.fn(async () => false).mockImplementationOnce(async () => false)
      .mockImplementationOnce(() => retry.promise)
    const f = fixture({ loadLatestHistory: loadLatest })
    f.newer(true)
    f.gesture(900)
    f.persist()
    const saved = read(cwd, path).position
    act(() => f.result.current.scrollToBottom())
    await settle()
    f.finish()
    f.persist()
    expect(f.element.scrollTop).toBe(900)
    expect(f.result.current.scrollToBottomBusy).toBe(false)
    expect(f.result.current.showScrollToBottom).toBe(true)
    expect(read(cwd, path).position).toEqual(saved)
    act(() => f.result.current.scrollToBottom())
    expect(loadLatest).toHaveBeenCalledTimes(2)
    const isCurrent = vi.mocked(f.props().loadLatestHistory!).mock.calls[1][0]!
    f.gesture(700)
    expect(isCurrent()).toBe(false)
    f.newer(false)
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'replace' })
    await act(async () => retry.resolve(true))
    f.finish()
    expect(f.element.scrollTop).toBe(700)
  })

  it.each(['false', 'error'] as const)('keeps real blank-tail geometry through a pending latest read and %s', async outcome => {
    const pending = deferred<boolean>()
    const loadLatest = vi.fn(async () => {
      const accepted = await pending.promise
      if (outcome === 'error') throw new Error('latest failed')
      return accepted
    })
    const f = fixture({ loadLatestHistory: loadLatest }, true)
    f.finish()
    f.newer(true)
    f.gesture(900)
    f.persist()
    expect(read(cwd, path).position).toEqual(position)
    // A shorter history window leaves the user's provisional blank tail intact.
    f.height(600)
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'replace' })
    f.gesture(1100)
    const saved = { ...position, offset: -852 }
    expect(f.surface.style.minHeight).toBe('3000px')
    expect(f.element.scrollHeight).toBe(3000)
    expect(f.element.scrollTop).toBe(1100)
    act(() => f.result.current.scrollToBottom())
    expect(loadLatest).toHaveBeenCalledTimes(1)
    expect(f.result.current.scrollToBottomBusy).toBe(true)
    expect(f.surface.style.minHeight).toBe('3000px')
    expect(f.element.scrollTop).toBe(1100)
    // Exercise another layout while pending, including the capture debounce.
    f.update({ timelineLoading: true })
    f.finish()
    f.persist()
    expect(f.surface.style.minHeight).toBe('3000px')
    expect(f.element.scrollHeight).toBe(3000)
    expect(f.element.scrollTop).toBe(1100)
    expect(read(cwd, path).position).toEqual(saved)
    f.update({ timelineLoading: false, timelineError: outcome === 'error' ? 'latest failed' : null })
    await act(async () => pending.resolve(false))
    f.finish()
    f.persist()
    expect(f.result.current.scrollToBottomBusy).toBe(false)
    expect(f.result.current.showScrollToBottom).toBe(true)
    expect(f.surface.style.minHeight).toBe('3000px')
    expect(f.element.scrollTop).toBe(1100)
    expect(read(cwd, path).position).toEqual(saved)
    f.unmount()
    expect(read(cwd, path).position).toEqual(saved)
    // Verify this model really loses range when the actual reservation is removed.
    f.surface.style.minHeight = ''
    expect(f.element.scrollHeight).toBe(600)
    expect(f.element.scrollTop).toBe(200)
    f.element.scrollTop = 1100
    expect(f.element.scrollTop).toBe(200)
  })

  it('preserves a hidden parent DOM position and invalidates old anchors on branch undo', async () => {
    save(cwd, path, position)
    const f = fixture()
    await settle()
    f.locate()
    const reads = vi.spyOn(Storage.prototype, 'getItem')
    f.update({ viewportActive: false })
    f.update({ viewportActive: true })
    f.finish()
    expect(f.element.scrollTop).toBe(900)
    expect(reads).not.toHaveBeenCalled()
    expect(f.props().restoreHistoryReadingPosition).toHaveBeenCalledTimes(1)
    f.update({ historyResetRevision: 1, timelineReady: false, timelineLoading: true, timeline: [], historyJump: null })
    f.update({ historyScopeRevision: 1 }) // A later branch clear keeps the undo tombstone.
    f.update({ timelineReady: true, timelineLoading: false, timeline: [] }) // Accepted empty branch.
    f.finish()
    f.persist()
    expect(f.element.scrollTop).toBe(2600)
    expect(f.props().restoreHistoryReadingPosition).toHaveBeenCalledTimes(1)
    expect(read(cwd, path).position?.end).toBe(true)
  })

  it('writes the explicit undo end tombstone before the replacement history is ready', () => {
    save(cwd, path, position)
    const f = fixture()
    f.update({ historyResetRevision: 1, timelineReady: false, timelineLoading: true, timeline: [] })
    expect(read(cwd, path).position).toEqual({ version: 1, end: true, offset: 0 })
    f.unmount()
    const reopened = fixture({ timelineReady: false, timelineLoading: true })
    expect(reopened.props().restoreHistoryReadingPosition).not.toHaveBeenCalled()
    reopened.update({ timelineReady: true, timelineLoading: false })
    reopened.finish()
    expect(reopened.element.scrollTop).toBe(2600)
  })

  it('retains an in-memory undo tombstone across owner changes when its write fails', async () => {
    save(cwd, path, position)
    const f = fixture()
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    f.update({ historyResetRevision: 1, timelineReady: false, timelineLoading: true })
    expect(writes).toHaveBeenCalled()
    expect(read(cwd, path).position).toEqual(position)
    f.update({ sessionPath: '/sessions/b', historyScopeRevision: 1 })
    f.update({ sessionPath: path, historyScopeRevision: 2, timelineReady: true, timelineLoading: false })
    await settle()
    f.finish()
    expect(f.element.scrollTop).toBe(2600)
    expect(f.props().restoreHistoryReadingPosition).toHaveBeenCalledTimes(1)
    expect(read(cwd, path).position).toEqual(position)
  })

  it.each([
    { offset: -1652, top: 600 },
    { offset: 400, top: 0 }
  ])('clamps an unreachable offset $offset while preserving its source metadata', async ({ offset, top }) => {
    const saved = { ...position, offset }
    save(cwd, path, saved)
    const f = fixture()
    f.height(1000)
    await settle()
    f.locate(saved)
    expect(f.element.scrollTop).toBe(top)
    expect(f.result.current.showScrollToBottom).toBe(true)
    f.persist()
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'append', panelsVisible: true })
    f.finish()
    f.persist()
    expect(read(cwd, path).position).toEqual(saved)
    expect(f.props().loadNewer).not.toHaveBeenCalled()
  })

  it('stops deep restoration after a newer read supplies no accepted window', async () => {
    const saved = { ...position, offset: -1652 }
    save(cwd, path, saved)
    const f = fixture()
    f.height(1000)
    f.newer(true)
    await settle()
    f.locate(saved)
    await settle()
    f.finish()
    f.update({ panelsVisible: true })
    f.finish()
    f.persist()
    expect(f.props().loadNewer).toHaveBeenCalledTimes(1)
    expect(read(cwd, path).position).toEqual(saved)
  })

  it.each(['failure', 'invalid-finish', 'viewport-cancel', 'document-cancel'] as const)(
    'preserves an unrestored anchor after bottom %s and hide/show', async outcome => {
      save(cwd, path, position)
      const pending = deferred<boolean>()
      const restore = vi.fn(async () => true)
      const loadLatest = vi.fn(() => pending.promise)
      const f = fixture({ restoreHistoryReadingPosition: restore, loadLatestHistory: loadLatest })
      f.newer(true)
      act(() => f.result.current.scrollToBottom())
      const check = vi.mocked(f.props().loadLatestHistory!).mock.calls[0][0]!
      f.element.scrollTop = 1200
      f.update({ timeline: [...f.props().timeline], timelineMutation: 'replace' })
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      const visibility = (value: boolean) => act(() => {
        hidden.mockReturnValue(value)
        document.dispatchEvent(new Event('visibilitychange'))
      })
      if (outcome === 'viewport-cancel') f.update({ viewportActive: false })
      if (outcome === 'document-cancel') visibility(true)
      await act(async () => pending.resolve(outcome !== 'failure'))
      f.finish() // invalid-finish still has real newer history.
      if (outcome === 'document-cancel') visibility(false)
      else { f.update({ viewportActive: false }); f.update({ viewportActive: true }) }
      visibility(true)
      visibility(true)
      visibility(false)
      f.finish()
      f.persist()
      expect(check()).toBe(false)
      expect(loadLatest).toHaveBeenCalledTimes(1)
      expect(restore).toHaveBeenCalledTimes(1)
      expect(f.result.current.scrollToBottomBusy).toBe(false)
      expect(f.result.current.showScrollToBottom).toBe(true)
      expect(read(cwd, path).position).toEqual(position)
      f.gesture(700)
      f.persist()
      expect(read(cwd, path).position?.offset).toBe(-452)
    }
  )

  it('retains saved end intent without automatic retries after a failed latest read and reactivation', async () => {
    const saved = { version: 1, end: true, offset: 0 } as const
    save(cwd, path, saved)
    const loadLatest = vi.fn(async () => false)
    const f = fixture({ hasNewerHistory: () => true, loadLatestHistory: loadLatest })
    await settle()
    f.update({ viewportActive: false })
    f.update({ viewportActive: true })
    f.finish()
    f.persist()
    expect(loadLatest).toHaveBeenCalledTimes(1)
    expect(read(cwd, path).position).toEqual(saved)
    expect(f.result.current.scrollToBottomBusy).toBe(false)
  })

  it('rereads latest history to clear an existing error even when the current window reports no newer page', async () => {
    save(cwd, path, position)
    const pending = deferred<boolean>()
    const loadLatest = vi.fn(() => pending.promise)
    const f = fixture({ timelineError: 'read failed', loadLatestHistory: loadLatest })
    f.finish()
    act(() => f.result.current.scrollToBottom())
    expect(loadLatest).toHaveBeenCalledTimes(1)
    expect(f.result.current.scrollToBottomBusy).toBe(true)
    f.update({ timelineError: null, timeline: [...f.props().timeline], timelineMutation: 'replace' })
    await act(async () => pending.resolve(true))
    f.finish()
    expect(f.element.scrollTop).toBe(2600)
    expect(f.result.current.showScrollToBottom).toBe(false)
    expect(read(cwd, path).position?.end).toBe(true)
  })

  it('keeps a deep offset pending until real newer-page content makes it reachable', async () => {
    const deep = { ...position, offset: -1652 }
    save(cwd, path, deep)
    const page = deferred<void>()
    const loadNewer = vi.fn(() => page.promise)
    const f = fixture({ loadNewer })
    f.height(1000)
    f.newer(true)
    await settle()
    f.locate(deep)
    expect(loadNewer).toHaveBeenCalledTimes(1)
    expect(f.element.scrollTop).toBe(0)
    f.persist()
    expect(read(cwd, path).position).toEqual(deep)
    f.height(3000)
    f.update({ timeline: [...f.props().timeline], timelineMutation: 'history-append' })
    await act(async () => page.resolve())
    f.finish()
    expect(f.element.scrollTop).toBe(1900)
    expect(f.result.current.showScrollToBottom).toBe(true)
    expect(read(cwd, path).position).toEqual(deep)
  })
})
