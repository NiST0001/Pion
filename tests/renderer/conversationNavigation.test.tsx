// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

vi.mock('../../src/renderer/src/utils/historyReveal', () => ({ armPendingHistoryRevealRows: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('conversation navigation', () => {
  it('compensates floating summary clearance without leaving manual reading', () => {
    let resize = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    const element = document.createElement('div')
    element.style.paddingTop = '38px'
    // Attach the fixture so jsdom invalidates computed styles on padding changes,
    // as it does for the real mounted scroll viewport.
    document.body.append(element)
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const { result } = renderHook(() => useConversationNavigation({
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: false,
      historyJump: null, loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {})
    }))
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
    element.scrollTop = 500
    act(() => result.current.handleTimelineScroll())
    element.style.paddingTop = '76px'
    act(() => resize())
    expect(element.scrollTop).toBe(538)
    act(() => { result.current.handleTimelineScroll(); resize() })
    expect(element.scrollTop).toBe(538)
    element.style.paddingTop = '38px'
    act(() => resize())
    expect(element.scrollTop).toBe(500)
  })

  it('locates history inside the unobscured area between both floating rows', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const element = document.createElement('div')
    element.style.setProperty('--conversation-top-clearance', '50px')
    element.style.setProperty('--conversation-bottom-clearance', '120px')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const target = document.createElement('div')
    target.dataset.entryId = 'target'
    target.getBoundingClientRect = () => ({ top: 600 - element.scrollTop } as DOMRect)
    element.append(target)
    renderHook(() => useConversationNavigation({
      scrollRef: { current: element }, timeline: [{ kind: 'user', id: 1, text: 'target' }],
      timelineMutation: 'replace', busy: false, historyJump: { entryId: 'target', nonce: 1 },
      loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {})
    }))
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(element.scrollTop).toBeCloseTo(600 - (50 + (400 - 50 - 120) * 0.38))
  })

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
      sessionPath: '/a', historyJump: null,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
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
    target.getBoundingClientRect = () => ({ top: 1702 - element.scrollTop } as DOMRect)
    element.append(target)
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [{ kind: 'user', id: 1, text: 'near end' }], timelineMutation: 'replace', busy: true,
      historyJump: { entryId: 'near-end', nonce: 1 }, panelsVisible: false,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [...options.timeline], panelsVisible: true })
    expect(element.scrollTop).toBe(1550)
    // Deliberate scrolling back to the bottom restores normal live following.
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = 1600
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [...options.timeline], panelsVisible: false })
    expect(element.scrollTop).toBe(2000)
  })

  it('keeps the exact clicked short message selected, including when the viewport clamps its position', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } })
    const previous = document.createElement('div')
    const target = document.createElement('div')
    previous.className = target.className = 'row-user'
    previous.dataset.entryId = 'previous'
    target.dataset.entryId = 'clicked'
    previous.getBoundingClientRect = () => ({ top: 860 - element.scrollTop } as DOMRect)
    target.getBoundingClientRect = () => ({ top: 880 - element.scrollTop } as DOMRect)
    element.append(previous, target)
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: true,
      historyJump: { entryId: 'clicked', nonce: 1 },
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(element.scrollTop).toBe(600) // target cannot reach the anchor at the document's end
    expect(target).toHaveProperty('className', 'row-user history-jump-target')
    act(() => result.current.handleTimelineScroll())
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(result.current.visibleHistoryEntryId).toBe('clicked')
    rerender({ ...options, timeline: [], busy: false })
    expect(result.current.visibleHistoryEntryId).toBe('clicked')
    // Genuine scrolling releases the explicit selection and tracks visible rows again.
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
    element.scrollTop -= 20
    act(() => result.current.handleTimelineScroll())
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(result.current.visibleHistoryEntryId).toBe('previous')
  })

  it('aligns adjacent messages to the same anchor used for active-row tracking', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const rows = ['previous', 'clicked'].map((id, index) => {
      const row = document.createElement('div')
      row.className = 'row-user'
      row.dataset.entryId = id
      row.getBoundingClientRect = () => ({ top: 620 + index * 20 - element.scrollTop, height: 18 } as DOMRect)
      element.append(row)
      return row
    })
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: false,
      historyJump: { entryId: 'clicked', nonce: 1 },
      loadOlder: async () => undefined, loadNewer: async () => undefined
    }
    const { result } = renderHook(() => useConversationNavigation(options))
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(rows[1].getBoundingClientRect().top).toBe(152)
    act(() => result.current.handleTimelineScroll())
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(result.current.visibleHistoryEntryId).toBe('clicked')
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
    target.getBoundingClientRect = () => ({ top: 652 - element.scrollTop } as DOMRect)
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
