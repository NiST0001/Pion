// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

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
  const settle = () => { for (let n = 0; n < 40; n++) frame() }
  let height = 2000, top = 0
  let resize = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  const element = document.createElement('div')
  document.body.append(element)
  const readClientHeight = vi.fn(() => 400)
  const readScrollHeight = vi.fn(() => height)
  Object.defineProperties(element, {
    clientHeight: { get: readClientHeight }, scrollHeight: { get: readScrollHeight },
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
  return { ...hook, props, element, scroll, append, frame, settle, readClientHeight, readScrollHeight,
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

it('does not enqueue marker/follow work or re-read target geometry for duplicate resize deliveries', () => {
  const h = setup()
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1900)
  const style = vi.spyOn(globalThis, 'getComputedStyle')
  h.readClientHeight.mockClear()
  h.readScrollHeight.mockClear()
  const requestFrame = vi.mocked(window.requestAnimationFrame)
  requestFrame.mockClear()
  for (let delivery = 0; delivery < 3; delivery++) h.layout(0)
  // One read batch per delivery; no extra animator target or marker chain.
  expect(style).toHaveBeenCalledTimes(3)
  expect(h.readClientHeight).toHaveBeenCalledTimes(3)
  expect(h.readScrollHeight).toHaveBeenCalledTimes(3)
  expect(requestFrame).not.toHaveBeenCalled()
  expect(h.pendingFrame()).toHaveLength(0)
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

// Match the real tool/subagent button, thinking <summary>, and accessible
// disclosure paths without depending on labels or changing their event owners.
function disclosure(element: HTMLElement, tag: 'button' | 'summary' | 'div') {
  const control = document.createElement(tag)
  if (tag === 'div') { control.setAttribute('role', 'button'); control.tabIndex = 0 }
  const child = document.createElement('span')
  control.append(child)
  if (tag === 'summary') {
    const details = document.createElement('details')
    details.append(control)
    element.append(details)
  } else element.append(control)
  return { control, child }
}

it.each(['button', 'summary', 'div'] as const)('keeps smooth end follow through a %s disclosure click and later layout growth', (tag) => {
  const h = setup()
  const { control, child } = disclosure(h.element, tag)
  const click = vi.fn()
  control.addEventListener('click', click)
  child.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  child.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(click).toHaveBeenCalledOnce()
  h.layout(300)
  expect(h.element.scrollTop).toBe(1600)
  h.frame()
  expect(h.element.scrollTop).toBeGreaterThan(1600)
  expect(h.element.scrollTop).toBeLessThan(1900)
  h.layout(100) // disclosure animation/late Markdown continues growing
  h.settle()
  expect(h.element.scrollTop).toBe(2000)
  expect(h.props.loadOlder).not.toHaveBeenCalled()
  expect(h.props.loadNewer).not.toHaveBeenCalled()
})

it('keeps an in-flight follow curve when a disclosure is clicked before it catches up', () => {
  const h = setup()
  h.append(300)
  h.frame()
  const before = h.element.scrollTop
  const { child } = disclosure(h.element, 'button')
  child.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  h.layout(100)
  expect(h.element.scrollTop).toBe(before)
  h.settle()
  expect(h.element.scrollTop).toBe(2000)
})

it('does not let a control outside the viewport suppress a scrollbar gesture', () => {
  const h = setup()
  const wrapper = document.createElement('div')
  wrapper.setAttribute('role', 'button')
  wrapper.append(h.element)
  h.element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1600)
})

it.each(['button', 'summary', 'div'] as const)('does not resume history reading when a %s disclosure is clicked', (tag) => {
  const h = setup()
  h.scroll(600)
  const { child } = disclosure(h.element, tag)
  child.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  child.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  h.layout(300)
  h.append(100)
  h.settle()
  expect(h.element.scrollTop).toBe(600)
})

it.each(['button', 'summary', 'div'] as const)('preserves existing follow intent on keyboard disclosure activation for %s', (tag) => {
  const h = setup()
  const { control } = disclosure(h.element, tag)
  control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(h.props.loadOlder).not.toHaveBeenCalled()
  expect(h.props.loadNewer).not.toHaveBeenCalled()
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1900)
  h.scroll(600)
  control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(600)
})

it.each(['background', 'scrollbar', 'text', 'image'] as const)('immediately cancels follow on %s pointerdown, not only after scrolling', (target) => {
  const h = setup()
  h.append(100)
  const late = h.pendingFrame()
  const node = target === 'scrollbar' ? h.element : document.createElement(target === 'image' ? 'img' : 'div')
  if (node !== h.element) h.element.append(node)
  node.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  act(() => late.forEach(callback => callback(100)))
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1600)
})

it('cancels for wheel over a control and held-pointer dragging outside controls', () => {
  for (const event of [new WheelEvent('wheel', { deltaY: -100, bubbles: true }),
    new MouseEvent('pointermove', { buttons: 1, bubbles: true })]) {
    const h = setup()
    const { child } = disclosure(h.element, 'button')
    const target = event.type === 'pointermove' ? h.element : child
    target.dispatchEvent(event)
    h.layout(300)
    h.settle()
    expect(h.element.scrollTop).toBe(1600)
    h.unmount()
  }
})

it('keeps disclosure taps and small pointer movement following, but pauses for a real touch scroll', () => {
  const h = setup()
  const { child } = disclosure(h.element, 'button')
  const touch = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true })
    Object.defineProperty(event, 'touches', { value: [{ clientY: y }] })
    child.dispatchEvent(event)
  }
  touch('touchstart', 200)
  child.dispatchEvent(new MouseEvent('pointermove', { buttons: 1, bubbles: true }))
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1900)
  touch('touchmove', 220)
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1900)
})

it('leaves nested output scrolling local and footer editing out of reading gestures', () => {
  const h = setup()
  const output = document.createElement('pre')
  output.style.overflowY = 'auto'
  Object.defineProperties(output, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } })
  output.scrollTop = 100
  const input = document.createElement('textarea')
  h.element.append(output, input)
  output.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))
  input.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(1900)
  expect(h.props.loadOlder).not.toHaveBeenCalled()
})

it('does not release an explicit history jump or its selected owner on a control click', () => {
  const h = setup()
  const row = document.createElement('div')
  row.className = 'row-user'
  row.dataset.entryId = 'target'
  row.getBoundingClientRect = () => ({ top: 752 - h.element.scrollTop } as DOMRect)
  h.element.append(row)
  const { child } = disclosure(row, 'button')
  h.rerender({ ...h.props, historyJump: { entryId: 'target', nonce: 1 } })
  // Clicking while the jump frame is still pending must not cancel its owner.
  child.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  h.settle()
  expect(h.element.scrollTop).toBe(600)
  expect(h.result.current.visibleHistoryEntryId).toBe('target')
  child.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  h.layout(300)
  h.settle()
  expect(h.element.scrollTop).toBe(600)
  expect(h.result.current.visibleHistoryEntryId).toBe('target')
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
