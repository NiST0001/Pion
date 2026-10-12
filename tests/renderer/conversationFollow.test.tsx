// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function setup() {
  let clock = 0, nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  const frame = () => act(() => {
    clock += 16
    const ready = [...frames.values()]
    frames.clear()
    ready.forEach(callback => callback(clock))
  })
  const settle = () => { for (let n = 0; n < 24; n++) frame() }
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
  let timeline: TimelineItem[] = [{ kind: 'assistant', id: 1, text: 'initial', thinking: '', streaming: true }]
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
    timeline = [...timeline, { kind: 'assistant', id: timeline.length + 1, text: 'new output', thinking: '', streaming: true }]
    hook.rerender({ ...props, timeline, timelineMutation: 'append' })
  }
  return { ...hook, props, element, scroll, append, frame, settle,
    pendingFrame: () => [...frames.values()],
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
  h.settle()
  expect(h.element.scrollTop).toBe(h.element.scrollHeight - 400)
  h.layout(500) // image/Markdown finishes without a new parent render
  h.settle()
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
  h.settle()
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
  h.settle()
  expect(h.element.scrollTop).toBe(1900)
})

it('moves through intermediate offsets on growth, retargets continuously and never treats its frames as paging gestures', () => {
  const h = setup()
  h.append(48)
  expect(h.element.scrollTop).toBe(1600)
  h.frame()
  expect(h.element.scrollTop).toBeGreaterThan(1600)
  expect(h.element.scrollTop).toBeLessThan(1648)
  act(() => h.result.current.handleTimelineScroll())
  h.layout(48)
  expect(h.element.scrollTop).toBeLessThan(1696)
  h.settle()
  expect(h.element.scrollTop).toBe(1696)
  expect(h.props.loadOlder).not.toHaveBeenCalled()
  expect(h.props.loadNewer).not.toHaveBeenCalled()
})

it('continues growth across same-session replacements and callback identity refreshes without an immediate pin', () => {
  const h = setup()
  h.append(48)
  h.frame()
  const before = h.element.scrollTop
  h.rerender({ ...h.props, timeline: [{ kind: 'assistant', id: 1, text: 'replacement output', thinking: '', streaming: true }],
    timelineMutation: 'replace', hasNewerHistory: () => false })
  expect(h.element.scrollTop).toBe(before)
  h.settle()
  expect(h.element.scrollTop).toBe(1648)
})

it('cancels pending growth as soon as a user starts reading and rejects a late frame', () => {
  const h = setup()
  h.append(48)
  const late = h.pendingFrame()
  h.scroll(800)
  act(() => late.forEach(callback => callback(100)))
  h.settle()
  expect(h.element.scrollTop).toBe(800)
})

it('uses immediate positioning for reduced motion without scheduling growth animation', () => {
  const h = setup()
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
    media, matches: media === '(prefers-reduced-motion: reduce)', onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(() => true)
  })))
  h.append(48)
  expect(h.element.scrollTop).toBe(1648)
})

it('invalidates smooth follow on a real scope change or hidden viewport', () => {
  const h = setup()
  h.append(48)
  const late = h.pendingFrame()
  h.rerender({ ...h.props, sessionPath: '/other' })
  const top = h.element.scrollTop
  act(() => late.forEach(callback => callback(100)))
  expect(h.element.scrollTop).toBe(top)
  h.append(48)
  const hidden = h.pendingFrame()
  h.rerender({ ...h.props, viewportActive: false })
  const atHide = h.element.scrollTop
  act(() => hidden.forEach(callback => callback(200)))
  expect(h.element.scrollTop).toBe(atHide)
})
