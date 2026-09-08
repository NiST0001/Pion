// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

vi.mock('../../src/renderer/src/utils/historyReveal', () => ({ armPendingHistoryRevealRows: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('conversation navigation', () => {
  it('preserves manual reading on replacement and resizing but follows a genuinely new session', () => {
    let resize = () => undefined as void
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400, configurable: true } })
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: false,
      sessionPath: '/a', historyJump: undefined,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    element.scrollTop = 500
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [] })
    expect(element.scrollTop).toBe(500)
    Object.defineProperty(element, 'clientHeight', { value: 1800 })
    element.scrollTop = 200 // browser clamps the old reading position on resize
    act(() => { resize(); result.current.handleTimelineScroll() })
    rerender({ ...options, timeline: [] })
    expect(element.scrollTop).toBe(200)
    rerender({ ...options, sessionPath: '/b', timeline: [] })
    expect(element.scrollTop).toBe(2000)
  })

  it('does not reenable following from a near-bottom history jump or its scroll event', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const target = document.createElement('div')
    target.dataset.entryId = 'near-end'
    target.scrollIntoView = vi.fn(() => { element.scrollTop = 1550 })
    element.append(target)
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: true,
      historyJump: { entryId: 'near-end', nonce: 1 }, panelsVisible: false,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [], panelsVisible: true })
    expect(element.scrollTop).toBe(1550)
    // Deliberate scrolling back to the bottom restores normal live following.
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = 1600
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [], panelsVisible: false })
    expect(element.scrollTop).toBe(2000)
  })

  it('keeps a history jump in place through live updates, panel changes and settling', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 400 }
    })
    const target = document.createElement('div')
    target.dataset.entryId = 'old-message'
    target.scrollIntoView = vi.fn(() => { element.scrollTop = 500 })
    element.append(target)
    const timeline: TimelineItem[] = []
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline,
      timelineMutation: 'replace' as const, busy: true,
      historyJump: { entryId: 'old-message', nonce: 1 },
      panelsVisible: false,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    act(() => { frames.splice(0).forEach((callback) => callback(0)) })
    expect(element.scrollTop).toBe(500)
    // A same-session refresh may replace the array while keeping mutation=replace.
    rerender({ ...options, timeline: [...timeline] })
    expect(element.scrollTop).toBe(500)
    // No browser scroll event is dispatched: the jump must update follow state itself.
    rerender({ ...options, busy: false, panelsVisible: true })
    expect(element.scrollTop).toBe(500)
    Object.defineProperty(element, 'scrollHeight', { value: 2200 })
    rerender({ ...options, timeline: [...timeline], timelineMutation: 'append' })
    expect(element.scrollTop).toBe(500)
  })
})
