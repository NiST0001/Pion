// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const item: TimelineItem = { kind: 'user', id: 1, text: 'loaded' }

function setup(loading: boolean, content = 0) {
  const element = document.createElement('div')
  const surface = document.createElement('div')
  const timeline = document.createElement('div')
  timeline.className = 'timeline'
  element.append(surface)
  surface.append(timeline)
  let height = content, top = 0
  const offsets = new Map<HTMLElement, number>()
  const addRow = () => {
    const row = document.createElement('div')
    offsets.set(row, 0)
    Object.defineProperty(row, 'offsetTop', { get: () => offsets.get(row) ?? 0 })
    timeline.prepend(row)
  }
  if (content > 0) addRow()
  Object.defineProperty(timeline, 'offsetHeight', { get: () => height })
  const totalHeight = () => Math.max(400, height, parseFloat(surface.style.minHeight) || 0)
  Object.defineProperties(element, {
    clientHeight: { value: 400 }, scrollHeight: { get: totalHeight },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, totalHeight() - 400)) } }
  })
  surface.getBoundingClientRect = () => ({ height: totalHeight() } as DOMRect)
  const options: Parameters<typeof useConversationNavigation>[0] = {
    scrollRef: { current: element }, timeline: loading ? [] : [item], timelineMutation: 'replace',
    timelineLoading: loading, busy: false, sessionPath: undefined, historyJump: null,
    loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
  }
  const hook = renderHook((props) => useConversationNavigation(props), { initialProps: options })
  hook.result.current.scrollSurfaceRef.current = surface
  hook.rerender({ ...options, busy: true })
  return { ...hook, options, element, surface,
    content: (value: number) => { height = value; if (value > 0 && !timeline.firstElementChild) addRow() },
    prepend: (value: number) => {
      height += value
      for (const [row, offset] of offsets) offsets.set(row, offset + value)
      addRow()
    }
  }
}

it('lets users scroll into blank loading space and keeps it when partial content arrives', () => {
  const h = setup(true)
  expect(h.element.scrollHeight).toBe(1200)
  expect(h.element.scrollTop).toBe(0)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 300 }))
  h.element.scrollTop = 300
  act(() => h.result.current.handleTimelineScroll())
  h.content(100)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false, sessionPath: '/first-persisted-session' })
  expect(h.element.scrollTop).toBe(300)
  expect(h.element.scrollHeight).toBe(1200)
  // Replacing/rendering fewer rows cannot clamp the viewport back to them.
  h.content(40)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false, sessionPath: '/first-persisted-session', busy: true })
  expect(h.element.scrollTop).toBe(300)
  // Returning to the real end is explicit, not a consequence of loading ending.
  h.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  expect(h.surface.style.minHeight).toBe('')
  expect(h.element.scrollTop).toBe(0)
})

it('honors keyboard scrolling even before the first message has rendered', () => {
  const h = setup(true)
  h.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
  h.content(2000)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false })
  expect(h.element.scrollTop).toBe(0)
})

it('stops following on pointer/touch input before the browser emits a scroll event', () => {
  const h = setup(false, 2000)
  expect(h.element.scrollTop).toBe(1600)
  h.element.dispatchEvent(new Event('touchstart'))
  h.content(2400)
  h.rerender({ ...h.options, timeline: [item, { ...item, id: 2 }], timelineMutation: 'append' })
  expect(h.element.scrollTop).toBe(1600)
  h.element.dispatchEvent(new Event('pointerdown'))
  h.content(2800)
  h.rerender({ ...h.options, timeline: [item, { ...item, id: 2 }], timelineMutation: 'replace' })
  expect(h.element.scrollTop).toBe(1600)
})

it('preserves the visible message and additional upward input when an older page arrives', () => {
  const h = setup(false, 2000)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 }))
  h.element.scrollTop = 50
  act(() => h.result.current.handleTimelineScroll())
  // Continue scrolling while the request is pending, rather than restoring
  // the request-time offset (50) when its response arrives.
  h.element.scrollTop = 25
  act(() => h.result.current.handleTimelineScroll())
  h.prepend(500)
  h.rerender({ ...h.options, timeline: [{ ...item, id: 0 }, item], timelineMutation: 'prepend' })
  expect(h.element.scrollTop).toBe(525)
  expect(500 - h.element.scrollTop).toBe(-25)
  expect(h.options.loadOlder).toHaveBeenCalledWith({ viaScroll: true })
})

it('uses row displacement even when reserved blank space masks the new page height', () => {
  const h = setup(true)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  h.content(400)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false })
  h.element.scrollTop = 50
  act(() => h.result.current.handleTimelineScroll())
  h.prepend(300)
  h.rerender({ ...h.options, timeline: [{ ...item, id: 0 }, item], timelineLoading: false, timelineMutation: 'prepend' })
  expect(h.element.scrollTop).toBe(350)
  expect(h.element.scrollHeight).toBe(1500)
})

it('keeps a viewport already in blank space free from prepend repositioning', () => {
  const h = setup(true)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  h.content(400)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false })
  h.element.scrollTop = 700
  act(() => h.result.current.handleTimelineScroll())
  h.prepend(300)
  h.rerender({ ...h.options, timeline: [{ ...item, id: 0 }, item], timelineLoading: false, timelineMutation: 'prepend' })
  expect(h.element.scrollTop).toBe(700)
})

it('does not recursively load older pages on the scroll event emitted by compensation', () => {
  const h = setup(false, 2000)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 }))
  h.element.scrollTop = 20
  act(() => h.result.current.handleTimelineScroll())
  h.prepend(30)
  h.rerender({ ...h.options, timeline: [{ ...item, id: 0 }, item], timelineMutation: 'prepend' })
  expect(h.element.scrollTop).toBe(50)
  h.options.loadOlder = vi.fn(async () => undefined)
  h.rerender({ ...h.options, timeline: [{ ...item, id: 0 }, item], timelineMutation: 'prepend' })
  act(() => h.result.current.handleTimelineScroll())
  expect(h.options.loadOlder).not.toHaveBeenCalled()
})

it.each([1000, 200])('drops the old blank tail before locating a jump into a %ipx page', (targetHeight) => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const h = setup(false, 5000)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }))
  h.element.scrollTop = 4000
  act(() => h.result.current.handleTimelineScroll())
  expect(h.surface.style.minHeight).toBe('5000px')

  h.content(targetHeight)
  const row = h.surface.querySelector<HTMLElement>('.timeline > div')!
  row.dataset.entryId = 'target'
  const targetTop = Math.min(250, targetHeight / 2)
  row.getBoundingClientRect = () => ({ top: targetTop - h.element.scrollTop } as DOMRect)
  const jumped = { ...h.options, historyJump: { entryId: 'target', nonce: 1 } }
  h.rerender(jumped)
  // Release in the commit, not after the user has scrolled into stale space.
  expect(h.surface.style.minHeight).toBe('')
  expect(h.element.scrollHeight).toBe(Math.max(400, targetHeight))
  act(() => frames.splice(0).forEach((callback) => callback(0)))
  const expectedTop = Math.max(0, Math.min(targetHeight - 400, targetTop - 152))
  expect(h.element.scrollTop).toBe(expectedTop)
  expect(h.result.current.visibleHistoryEntryId).toBe('target')

  // The jump's own scroll event and unrelated updates cannot resurrect the
  // old gesture or its reservation, nor pin the page to its end.
  act(() => h.result.current.handleTimelineScroll())
  h.rerender({ ...jumped, busy: true })
  expect(h.surface.style.minHeight).toBe('')
  expect(h.element.scrollTop).toBe(expectedTop)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 500 }))
  h.element.scrollTop = h.element.scrollHeight
  const bottomBeforeEvent = h.element.scrollTop
  act(() => h.result.current.handleTimelineScroll())
  expect(h.element.scrollTop).toBe(bottomBeforeEvent)
  expect(h.element.scrollHeight).toBe(Math.max(400, targetHeight))
})

it('allows a user gesture to cancel a queued history jump before its animation frame', () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const h = setup(false, 2000)
  const row = document.createElement('div')
  row.dataset.entryId = 'target'
  row.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
  h.surface.append(row)
  h.rerender({ ...h.options, historyJump: { entryId: 'target', nonce: 1 } })
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
  h.element.scrollTop = 1000
  act(() => h.result.current.handleTimelineScroll())
  act(() => frames.splice(0).forEach((callback) => callback(0)))
  expect(h.element.scrollTop).toBe(1000)
})
