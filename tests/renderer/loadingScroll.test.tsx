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
  element.append(surface)
  let height = content, top = 0
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
  return { ...hook, options, element, surface, content: (value: number) => { height = value } }
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

it('does not undo upward scrolling when an older page arrives', () => {
  const h = setup(false, 2000)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 }))
  h.element.scrollTop = 50
  act(() => h.result.current.handleTimelineScroll())
  h.content(2500)
  h.rerender({ ...h.options, timeline: [{ ...item, id: 0 }, item], timelineMutation: 'prepend' })
  expect(h.element.scrollTop).toBe(50)
  expect(h.options.loadOlder).toHaveBeenCalledWith({ viaScroll: true })
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
