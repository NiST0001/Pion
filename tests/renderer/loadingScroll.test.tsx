// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

// These cases verify loading-space ownership, independently of the motion curve.
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })))
})
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const item: TimelineItem = { kind: 'user', id: 1, text: 'loaded' }

function setup(loading: boolean, content = 0) {
  const element = document.createElement('div')
  document.body.append(element)
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
  Object.defineProperty(timeline, 'offsetHeight', { configurable: true, get: () => height })
  const totalHeight = () => Math.max(400, height, parseFloat(surface.style.minHeight) || 0)
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => 400 }, scrollHeight: { get: totalHeight },
    scrollTop: {
      get: () => { top = Math.max(0, Math.min(top, totalHeight() - 400)); return top },
      set: (value: number) => { top = Math.max(0, Math.min(value, totalHeight() - 400)) }
    }
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
  return { ...hook, options, element, surface, timeline,
    content: (value: number) => { height = value; if (value > 0 && !timeline.firstElementChild) addRow() },
    prepend: (value: number) => {
      height += value
      for (const [row, offset] of offsets) offsets.set(row, offset + value)
      addRow()
    }
  }
}

it('reclaims collapsed detail height even when the outer surface remains pinned', () => {
  let resize = () => {}
  const observed: Element[] = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe(element: Element) { observed.push(element) }
    disconnect() {}
  })
  const h = setup(false, 1000)
  expect(observed).toContain(h.element.querySelector('.timeline'))
  // Open a detail, scroll inside the expanded history, then collapse it in
  // several animation frames without changing the timeline array.
  for (let pass = 0; pass < 2; pass++) {
    h.content(4000)
    act(() => resize())
    h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
    h.element.scrollTop = 3000
    act(() => h.result.current.handleTimelineScroll())
    expect(h.surface.style.minHeight).toBe('4000px')
    h.content(2500)
    act(() => resize())
    expect(h.element.scrollHeight).toBe(2500)
    h.content(1000)
    act(() => resize())
    expect(h.element.scrollHeight).toBe(1000)
    expect(h.element.scrollTop).toBe(600)
    act(() => h.result.current.handleTimelineScroll())
    // Clamping to the smaller end must not silently restore live following.
    h.content(1400)
    act(() => resize())
    expect(h.element.scrollTop).toBe(600)
  }
})

it.each(['growth', 'shrink'] as const)('reconciles late %s already included in the first resize measurement', (change) => {
  let resize = () => {}
  let lateLayout = false
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() { lateLayout = true }
  })
  const h = setup(false, 4000)
  if (change === 'shrink') {
    h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
    h.element.scrollTop = 3000
    act(() => h.result.current.handleTimelineScroll())
    expect(h.surface.style.minHeight).toBe('4000px')
  }
  const style = getComputedStyle.bind(window)
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudo) => {
    // Passive cleanup precedes the replacement RO effect, but follows the
    // layout effects. Its initial measure therefore already sees late layout.
    if (lateLayout) { lateLayout = false; h.content(change === 'growth' ? 4400 : 1000) }
    return style(element, pseudo)
  })
  const options = { ...h.options, hasNewerHistory: () => false }
  h.rerender(options)
  expect(h.timeline.offsetHeight).toBe(change === 'growth' ? 4400 : 1000)
  expect(h.element.scrollTop).toBe(change === 'growth' ? 3600 : 3000)
  act(() => resize())
  expect(h.element.scrollTop).toBe(change === 'growth' ? 4000 : 600)
  expect(h.surface.style.minHeight).toBe('')
  if (change === 'shrink') {
    // A later layout snapshot can differ even when the next RO geometry
    // equals its previous delivery (the reservation masks scrollHeight).
    h.content(4000)
    h.rerender({ ...options, busy: true })
    h.content(1000)
    act(() => resize())
    expect(h.surface.style.minHeight).toBe('')
    expect(h.element.scrollTop).toBe(600)
    act(() => h.result.current.handleTimelineScroll())
    h.content(1400)
    act(() => resize())
    expect(h.element.scrollTop).toBe(600)
  }
})

it('reads shrink/clearance geometry before reclaiming reserved height without pulling a reader to the end', () => {
  let resize = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  const h = setup(false, 1000)
  h.content(4000)
  act(() => resize())
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
  h.element.scrollTop = 1500
  act(() => h.result.current.handleTimelineScroll())
  expect(h.surface.style.minHeight).toBe('4000px')
  const phases: string[] = []
  const style = getComputedStyle.bind(window)
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudo) => {
    phases.push('style')
    return style(element, pseudo)
  })
  vi.spyOn(h.timeline, 'offsetHeight', 'get').mockImplementation(() => { phases.push('content'); return 2500 })
  vi.spyOn(h.element, 'clientHeight', 'get').mockImplementation(() => { phases.push('viewport'); return 400 })
  let owner: object | null = h.surface.style
  let descriptor: PropertyDescriptor | undefined
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, 'minHeight')
    owner = Object.getPrototypeOf(owner)
  }
  if (!descriptor || typeof descriptor.set !== 'function') throw new Error('Expected a minHeight setter')
  const minHeight = descriptor.set
  vi.spyOn(h.surface.style, 'minHeight', 'set').mockImplementation(function (this: CSSStyleDeclaration, value: string) {
    phases.push('write')
    minHeight.call(this, value)
  })
  h.content(2500)
  h.element.style.paddingTop = '38px'
  act(() => resize())
  expect(phases).toEqual(['style', 'content', 'viewport', 'write'])
  expect(h.surface.style.minHeight).toBe('')
  expect(h.element.scrollTop).toBe(1538)
  act(() => { h.result.current.handleTimelineScroll(); resize() })
  expect(h.element.scrollTop).toBe(1538)
  expect(h.options.loadNewer).not.toHaveBeenCalled()
})

it('preserves unrelated loading blank space when a detail later shrinks', () => {
  let resize = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  const h = setup(true)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 300 }))
  h.element.scrollTop = 300
  act(() => h.result.current.handleTimelineScroll())
  h.content(400)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false })
  h.content(200)
  act(() => resize())
  expect(h.element.scrollHeight).toBe(1000)
  expect(h.element.scrollTop).toBe(300)
})

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

it('does not retain the loading placeholder after a programmatic scroll with no user gesture', () => {
  const h = setup(true)
  expect(h.element.scrollHeight).toBe(1200)
  // Browser scroll delivery after reserving/clearing content is not a wheel,
  // touch or scrollbar gesture. It must not turn this temporary height sticky.
  act(() => h.result.current.handleTimelineScroll())
  h.content(180)
  h.rerender({ ...h.options, timeline: [item], timelineLoading: false })
  expect(h.surface.style.minHeight).toBe('')
  expect(h.element.scrollHeight).toBe(400)
  expect(h.element.scrollTop).toBe(0)
})

it.each([180, 900])('clears old-session space and follows the actual %ipx page after delayed browser scroll events', (height) => {
  const h = setup(false, 4000)
  const first = { ...h.options, sessionPath: '/a' }
  h.rerender(first)
  h.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }))
  h.element.scrollTop = 1000
  act(() => h.result.current.handleTimelineScroll())
  expect(h.surface.style.minHeight).toBe('4000px')
  h.content(0)
  const loading = { ...first, sessionPath: '/b', timeline: [], timelineLoading: true }
  h.rerender(loading)
  expect(h.element.scrollHeight).toBe(1200)
  act(() => h.result.current.handleTimelineScroll())
  // Include a changed-offset event, not just a synthetic no-movement one.
  h.element.scrollTop = 100
  act(() => h.result.current.handleTimelineScroll())
  const ready = { ...loading, timeline: [item], timelineLoading: false }
  h.content(height)
  h.rerender(ready)
  expect(h.surface.style.minHeight).toBe('')
  expect(h.element.scrollHeight).toBe(Math.max(400, height))
  expect(h.element.scrollTop).toBe(Math.max(0, height - 400))
  // A late event from the transition must not recreate space after ready.
  act(() => h.result.current.handleTimelineScroll())
  h.rerender({ ...ready, busy: true })
  expect(h.surface.style.minHeight).toBe('')
  h.content(height + 500)
  h.rerender({ ...ready, timeline: [item, { ...item, id: 2 }], timelineMutation: 'append' })
  expect(h.element.scrollTop).toBe(height + 100)
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
