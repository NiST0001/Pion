// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useHistoryPaging } from '../../src/renderer/src/hooks/useHistoryPaging'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type TimelineItem } from '../../src/renderer/src/agent/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function scroller(initialHeight = 1000) {
  const element = document.createElement('div')
  let height = initialHeight, top = 0
  Object.defineProperties(element, {
    clientHeight: { value: 400 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 400)) } }
  })
  return { element, grow: (value: number) => { height += value } }
}

it('requests the next page on outward wheel input even if scrollTop cannot change, and deduplicates pending requests', async () => {
  const { element } = scroller()
  element.scrollTop = 600
  let finish!: () => void
  const loadNewer = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const h = renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  act(() => { h.result.current.onScroll(false, true) })
  expect(loadNewer).not.toHaveBeenCalled()
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
  expect(element.scrollTop).toBe(600)
  expect(loadNewer).toHaveBeenCalledTimes(1)
  await act(async () => { finish() })
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
  expect(loadNewer).toHaveBeenCalledTimes(2)
  await act(async () => { finish() })
})

it('requests newer history on an outward touch gesture at a hard boundary', () => {
  const { element } = scroller()
  element.scrollTop = 600
  const loadNewer = vi.fn(async () => undefined)
  renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  const start = new Event('touchstart')
  Object.defineProperty(start, 'touches', { value: [{ clientY: 200 }] })
  element.dispatchEvent(start)
  const move = new Event('touchmove')
  Object.defineProperty(move, 'touches', { value: [{ clientY: 100 }] })
  element.dispatchEvent(move)
  expect(loadNewer).toHaveBeenCalledWith({ viaScroll: true })
  expect(element.scrollTop).toBe(600)
})

it('does not page the outer conversation while a nested output can consume scrolling', () => {
  const { element } = scroller()
  element.scrollTop = 600
  const nested = document.createElement('div')
  nested.style.overflowY = 'auto'
  Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } })
  element.append(nested)
  const loadNewer = vi.fn(async () => undefined)
  renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  nested.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }))
  expect(loadNewer).not.toHaveBeenCalled()
  nested.scrollTop = 400
  nested.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }))
  expect(loadNewer).toHaveBeenCalledTimes(1)
})

it('keeps failed requests retryable without an automatic failure loop', async () => {
  const { element } = scroller()
  element.scrollTop = 600
  const loadNewer = vi.fn().mockRejectedValue(new Error('offline'))
  renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  await act(async () => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 })) })
  expect(loadNewer).toHaveBeenCalledTimes(1)
  await act(async () => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 })) })
  expect(loadNewer).toHaveBeenCalledTimes(2)
})

it('keeps an old viewport-fill completion from issuing requests in a replacement session', async () => {
  const { element } = scroller(400)
  const finish: Array<() => void> = []
  const loadOlder = vi.fn(() => new Promise<void>((resolve) => { finish.push(resolve) }))
  const loadNewer = vi.fn(async () => undefined)
  const options = { scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder, loadNewer }
  const h = renderHook((props) => useHistoryPaging(props), { initialProps: options })
  h.rerender({ ...options, owner: 'b' })
  expect(loadOlder).toHaveBeenCalledTimes(2)
  await act(async () => { finish[0]() })
  expect(loadNewer).not.toHaveBeenCalled()
  // Completion of A must not clear B's in-flight guard.
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
  expect(loadNewer).not.toHaveBeenCalled()
  await act(async () => { finish[1]() })
  expect(loadNewer).toHaveBeenCalledTimes(1)
})

it('walks from a jumped page through successive newer pages without auto-pinning, then follows only the real session tail', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const { element, grow } = scroller()
  const row = document.createElement('div')
  row.dataset.entryId = 'target'
  row.getBoundingClientRect = () => ({ top: 900 - element.scrollTop } as DOMRect)
  element.append(row)
  let remaining = 2
  let finish!: () => void
  const loadNewer = vi.fn(() => remaining > 0 ? new Promise<void>((resolve) => { finish = resolve }) : Promise.resolve())
  const first: TimelineItem = { kind: 'user', id: 1, text: 'target' }
  const options: Parameters<typeof useConversationNavigation>[0] = {
    scrollRef: { current: element }, timeline: [first], timelineMutation: 'replace', busy: false,
    sessionPath: '/a', historyJump: { entryId: 'target', nonce: 1 },
    hasNewerHistory: () => remaining > 0, loadOlder: vi.fn(async () => undefined), loadNewer
  }
  const h = renderHook((props) => useConversationNavigation(props), { initialProps: options })
  act(() => frames.splice(0).forEach((callback) => callback(0)))
  expect(element.scrollTop).toBe(600)
  let timeline = [first]
  for (let page = 0; page < 2; page++) {
    const oldBottom = element.scrollHeight - 400
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = oldBottom
    act(() => h.result.current.handleTimelineScroll())
    expect(loadNewer).toHaveBeenCalledTimes(page + 1)
    await act(async () => {
      remaining--
      grow(800)
      timeline = [...timeline, { ...first, id: page + 2 }]
      h.rerender({ ...options, timeline, timelineMutation: 'history-append' })
      finish()
    })
    expect(element.scrollTop).toBe(oldBottom)
  }
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  element.scrollTop = element.scrollHeight
  act(() => h.result.current.handleTimelineScroll())
  expect(element.scrollTop).toBe(2200)
  grow(200)
  h.rerender({ ...options, timeline: [...timeline, { ...first, id: 4 }], timelineMutation: 'append' })
  expect(element.scrollTop).toBe(2400)
})

it('reads session-tail availability from the current cursor, not a stale render snapshot', () => {
  const h = renderHook(() => useAgentHistory({ api: undefined, state: initialState, dispatch: vi.fn() }))
  expect(h.result.current.hasNewerHistory()).toBe(false)
  const cursor = {
    path: '/a', items: [], mode: initialState.mode, apiBefore: 0, apiAfter: 10,
    toolResults: [], complete: true, newerComplete: false, leafId: null, total: 20,
    loading: false, loadId: h.result.current.timelineLoadId.current
  }
  h.result.current.historyCursor.current = cursor
  expect(h.result.current.hasNewerHistory()).toBe(true)
  cursor.newerComplete = true
  expect(h.result.current.hasNewerHistory()).toBe(false)
  cursor.newerComplete = false
  h.result.current.timelineLoadId.current++
  expect(h.result.current.hasNewerHistory()).toBe(false)
})

it('marks history-page append separately from live append in the reducer', () => {
  const state = reducer(initialState, { type: 'appendEntries', items: [{ kind: 'user', id: 1, text: 'page' }] })
  expect(state.timelineMutation).toBe('history-append')
})
