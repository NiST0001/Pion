// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function setup() {
  let height = 2000, top = 0
  let resize = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  const element = document.createElement('div')
  Object.defineProperties(element, {
    clientHeight: { value: 400 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(height - 400, value)) } }
  })
  let timeline: TimelineItem[] = [{ kind: 'assistant', id: 1, text: 'initial', streaming: true }]
  const props: Parameters<typeof useConversationNavigation>[0] = {
    scrollRef: { current: element }, timeline, timelineMutation: 'replace', busy: true,
    sessionPath: '/a', historyJump: null, loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
  }
  const hook = renderHook((options) => useConversationNavigation(options), { initialProps: props })
  const scroll = (value: number) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: value > top ? 100 : -100 }))
    element.scrollTop = value
    act(() => hook.result.current.handleTimelineScroll())
  }
  const append = (size = 300) => {
    height += size
    timeline = [...timeline, { kind: 'assistant', id: timeline.length + 1, text: 'new output', streaming: true }]
    hook.rerender({ ...props, timeline, timelineMutation: 'append' })
  }
  return { ...hook, props, element, scroll, append,
    layout: (size: number) => { height += size; act(() => resize()) }
  }
}

it('does not follow new messages or delayed output while the user is above the end', () => {
  vi.useFakeTimers()
  const h = setup()
  expect(h.element.scrollTop).toBe(1600)
  h.scroll(600)
  h.append()
  h.layout(500)
  expect(h.element.scrollTop).toBe(600)
  // An unrelated later programmatic positioning is not user consent.
  act(() => vi.advanceTimersByTime(400))
  h.element.scrollTop = h.element.scrollHeight
  act(() => h.result.current.handleTimelineScroll())
  const before = h.element.scrollTop
  h.append()
  expect(h.element.scrollTop).toBe(before)
})

it('does not confuse the prefetch zone with the end, but follows after a manual return and pauses again on departure', () => {
  const h = setup()
  h.scroll(800)
  h.scroll(1550) // 50px from the end used to re-enable following.
  expect(h.element.scrollTop).toBe(1550)
  h.append()
  expect(h.element.scrollTop).toBe(1550)
  h.scroll(h.element.scrollHeight - 400)
  h.append(200)
  expect(h.element.scrollTop).toBe(h.element.scrollHeight - 400)
  h.layout(500) // image/Markdown finishes without a new parent render
  expect(h.element.scrollTop).toBe(h.element.scrollHeight - 400)
  h.scroll(900)
  h.append(1000)
  expect(h.element.scrollTop).toBe(900)
})

it('can resume on outward input at the hard end without a new scroll event', () => {
  const h = setup()
  h.element.dispatchEvent(new Event('pointerdown')) // suspend follow intent
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  // Already at 1600; the browser has no movement to report.
  h.append(200)
  expect(h.element.scrollTop).toBe(1800)
})

it('keeps a long, continuous user scroll eligible to resume following', () => {
  vi.useFakeTimers()
  const h = setup()
  h.scroll(600)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  for (const position of [900, 1200, 1600]) {
    act(() => vi.advanceTimersByTime(200))
    h.element.scrollTop = position
    act(() => h.result.current.handleTimelineScroll())
  }
  h.append()
  expect(h.element.scrollTop).toBe(1900)
})
