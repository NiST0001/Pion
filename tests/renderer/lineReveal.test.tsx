// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchLineReveals } from '../../src/renderer/src/utils/lineReveal'
import { SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS } from '../../src/renderer/src/utils/screenTextReveal'

function rect(top: number, height = 20, width = 400): DOMRect {
  return { top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() {} }
}

describe('viewport-owned line reveal order', () => {
  let frames: Map<number, FrameRequestCallback>
  let resizeCallbacks: Array<() => void>
  let mutationCallbacks: Array<() => void>
  let stops: Array<() => void>
  let frameId: number
  const mutationObserve = vi.fn()
  const resizeObserve = vi.fn()

  beforeEach(() => {
    frames = new Map(); resizeCallbacks = []; mutationCallbacks = []; stops = []; frameId = 0
    mutationObserve.mockClear(); resizeObserve.mockClear()
    vi.spyOn(performance, 'now').mockReturnValue(100)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = ++frameId; frames.set(id, callback); return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallbacks.push(callback) }
      observe = resizeObserve
      unobserve = vi.fn()
      disconnect = vi.fn()
    })
    const NativeMutationObserver = MutationObserver
    vi.stubGlobal('MutationObserver', class extends NativeMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback)
        mutationCallbacks.push(() => callback([], this))
      }
      override observe(target: Node, options?: MutationObserverInit): void {
        mutationObserve(target, options)
        super.observe(target, options)
      }
    })
  })
  afterEach(() => {
    stops.forEach(stop => stop())
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const root = () => {
    const element = document.createElement('main')
    element.dataset.lineRevealOwner = 'true'
    element.getBoundingClientRect = vi.fn(() => rect(100, 100))
    document.body.append(element)
    return element
  }
  const line = (parent: HTMLElement, mode: 'history' | 'live' = 'history', top = 120) => {
    const element = document.createElement('div')
    element.className = `screen-text-reveal-line screen-text-reveal-line-${mode}`
    element.getBoundingClientRect = vi.fn(() => rect(top))
    parent.append(element)
    return element
  }
  const openingGate = (parent: HTMLElement, top = 130, height = 30) => {
    const element = document.createElement('section')
    element.dataset.textRevealOpen = 'true'
    element.dataset.textRevealReady = 'false'
    element.getBoundingClientRect = vi.fn(() => rect(top, height))
    parent.append(element)
    return element
  }
  const watch = (element: HTMLElement) => { const stop = watchLineReveals(element); stops.push(stop); return stop }
  const flush = async () => {
    await Promise.resolve()
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(performance.now()))
    await Promise.resolve()
  }
  const start = (element: HTMLElement) => Number(element.dataset.lineRevealStart)

  it('shares a single DOM-ordered batch across history/live and bubble/child without charging a shell slot', async () => {
    const container = root()
    const history = line(container)
    const bubble = line(container, 'live')
    bubble.dataset.lineRevealContainer = 'true'
    const first = line(bubble, 'live')
    const second = line(bubble, 'live')
    const staticLine = line(container)
    staticLine.classList.add('screen-text-reveal-static')
    const last = line(container)
    const elements = [history, bubble, first, second, staticLine, last]
    elements.forEach(element => {
      element.getBoundingClientRect = vi.fn(() => {
        expect(elements.every(candidate => candidate.dataset.lineRevealReady !== 'true')).toBe(true)
        return rect(120)
      })
    })
    const reveal = vi.fn()
    container.addEventListener('pion:line-reveal', reveal)
    watch(container)
    expect(elements.every(element => !element.dataset.lineRevealReady)).toBe(true)
    await flush()
    expect(elements.map(start)).toEqual([100, 120, 120, 160, 100, 200])
    expect(elements.map(element => element.style.getPropertyValue('--screen-text-reveal-delay')))
      .toEqual(['0ms', '20ms', '20ms', '60ms', '0ms', '100ms'])
    expect(reveal).toHaveBeenCalledTimes(1)
    await flush()
    expect(reveal).toHaveBeenCalledTimes(1)
    elements.forEach(element => expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1))
  })

  it('skips old text geometry on character cleanup and scroll with no pending rows, then wakes for a new future tail', async () => {
    const container = root()
    const parent = line(container)
    const text = document.createElement('span')
    text.dataset.textRevealStart = '250'
    text.textContent = '已准入'
    text.getBoundingClientRect = vi.fn(() => rect(120))
    parent.append(text)
    watch(container)
    await flush()
    expect(start(parent)).toBe(100)
    vi.mocked(text.getBoundingClientRect).mockClear()
    vi.mocked(container.getBoundingClientRect).mockClear()
    const styles = vi.spyOn(globalThis, 'getComputedStyle')
    text.dataset.textRevealStart = '600'
    text.replaceChildren(document.createTextNode('回收字符节点'))
    container.dispatchEvent(new Event('scroll'))
    await flush()
    expect(text.getBoundingClientRect).not.toHaveBeenCalled()
    expect(container.getBoundingClientRect).not.toHaveBeenCalled()
    expect(styles).not.toHaveBeenCalled()

    const later = line(container, 'live', 160)
    await flush()
    expect(text.getBoundingClientRect).toHaveBeenCalledTimes(1)
    expect(start(later)).toBe(600)
    expect(container.firstElementChild).toBe(parent)
    expect(parent.firstElementChild).toBe(text)
  })

  it('does not remeasure committed past text while rows wait below the viewport, but preserves a new pending commit', async () => {
    const container = root()
    const parent = line(container)
    const text = document.createElement('span')
    text.dataset.textRevealStart = '100'
    text.textContent = '已开始的正文'
    text.getBoundingClientRect = vi.fn(() => rect(120))
    parent.append(text)
    const later = line(container, 'live', 220)
    const styles = vi.spyOn(globalThis, 'getComputedStyle')
    watch(container)
    await flush()
    text.replaceChildren(document.createTextNode('回收后正文'))
    container.dispatchEvent(new Event('scroll'))
    await flush()
    expect(text.getBoundingClientRect).not.toHaveBeenCalled()
    expect(styles).not.toHaveBeenCalledWith(text)
    expect(later).not.toHaveAttribute('data-line-reveal-ready')

    text.dataset.textRevealPending = 'true'
    later.getBoundingClientRect = vi.fn(() => rect(160))
    await flush()
    expect(text.getBoundingClientRect).toHaveBeenCalled()
    expect(later).not.toHaveAttribute('data-line-reveal-ready')
    delete text.dataset.textRevealPending
    text.dataset.textRevealStart = '300'
    await flush()
    expect(start(later)).toBe(300)
  })

  it('admits a parent but holds later lines until its visible pending text commits its actual start', async () => {
    const container = root()
    const parent = line(container, 'history', 120)
    const text = document.createElement('span')
    text.dataset.textRevealPending = 'true'
    text.textContent = '待准入'
    text.getBoundingClientRect = vi.fn(() => rect(120))
    parent.append(text)
    const later = line(container, 'live', 160)
    watch(container)
    await flush()
    expect(start(parent)).toBe(100)
    expect(later).not.toHaveAttribute('data-line-reveal-ready')
    const parentDelay = parent.style.getPropertyValue('--screen-text-reveal-delay')
    vi.mocked(performance.now).mockReturnValue(150)
    await flush() // A slower frame alone cannot retire the pending barrier.
    expect(later).not.toHaveAttribute('data-line-reveal-ready')
    delete text.dataset.textRevealPending
    text.dataset.textRevealStart = '250' // Simulate only the real character commit's publication.
    await flush()
    expect(start(later)).toBe(250)
    expect(later.style.getPropertyValue('--screen-text-reveal-delay')).toBe('100ms')
    expect(container.firstElementChild).toBe(parent)
    expect(parent.firstElementChild).toBe(text)
    expect(start(parent)).toBe(100)
    expect(parent.style.getPropertyValue('--screen-text-reveal-delay')).toBe(parentDelay)
  })

  it('does not let pending text clipped by nested nonzero scroll geometry block a visible lower line', async () => {
    const container = root()
    const parent = line(container, 'history', 120)
    const outer = document.createElement('section')
    // JSDOM does not expand overflow shorthand into its computed longhands.
    outer.style.overflowY = 'hidden'
    outer.getBoundingClientRect = vi.fn(() => rect(110, 40))
    parent.append(outer)
    const inner = document.createElement('section')
    inner.style.overflowY = 'auto'
    inner.getBoundingClientRect = vi.fn(() => rect(100, 90))
    outer.append(inner)
    const text = document.createElement('span')
    text.dataset.textRevealPending = 'true'
    text.textContent = '在根视口内，但被嵌套容器裁掉'
    text.getBoundingClientRect = vi.fn(() => rect(160, 20))
    inner.append(text)
    const otherText = text.cloneNode(true) as HTMLElement
    otherText.getBoundingClientRect = vi.fn(() => rect(160, 20))
    inner.append(otherText)
    const later = line(container, 'live', 180)
    const styles = vi.spyOn(globalThis, 'getComputedStyle')
    watch(container)
    await flush()
    expect(text.getBoundingClientRect).toHaveBeenCalled()
    expect(otherText.getBoundingClientRect).toHaveBeenCalledTimes(1)
    expect(inner.getBoundingClientRect).toHaveBeenCalledTimes(1)
    expect(outer.getBoundingClientRect).toHaveBeenCalledTimes(1)
    expect(styles.mock.calls.filter(([element]) => element === inner)).toHaveLength(1)
    expect(styles.mock.calls.filter(([element]) => element === outer)).toHaveLength(1)
    expect(text).toHaveAttribute('data-text-reveal-pending', 'true')
    expect(text).not.toHaveAttribute('data-text-reveal-start')
    expect(start(parent)).toBe(100)
    expect(start(later)).toBe(120)
    expect(later).toHaveAttribute('data-line-reveal-ready', 'true')
  })

  it('commits rows before a visible opening gate but holds later new rows until its explicit ready mutation', async () => {
    const container = root()
    const before = line(container, 'history', 100)
    const gate = openingGate(container, 125)
    const inside = line(gate, 'live', 130)
    const later = line(container, 'history', 160)
    const retained = line(container, 'history', 180)
    retained.dataset.lineRevealReady = 'true'
    retained.dataset.lineRevealStart = '50'
    retained.style.setProperty('--screen-text-reveal-delay', '7ms')
    watch(container)
    await flush()
    expect(start(before)).toBe(100)
    expect(inside).not.toHaveAttribute('data-line-reveal-ready')
    expect(later).not.toHaveAttribute('data-line-reveal-ready')
    await flush() // Drain the preceding row's mutation, not a polling loop.
    expect(frames.size).toBe(0)

    vi.mocked(performance.now).mockReturnValue(300)
    await flush() // Elapsed 200ms alone cannot stand in for the disclosure's readiness.
    expect(later).not.toHaveAttribute('data-line-reveal-ready')
    expect(frames.size).toBe(0)
    gate.dataset.textRevealReady = 'true'
    await flush()
    expect(start(inside)).toBe(300)
    expect(start(later)).toBe(340)
    expect(start(before)).toBe(100)
    expect(before.style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    expect(start(retained)).toBe(50)
    expect(retained.style.getPropertyValue('--screen-text-reveal-delay')).toBe('7ms')
    expect(gate.firstElementChild).toBe(inside)
  })

  it.each(['hidden', 'closed', 'closed ancestor', 'closed details', 'above viewport', 'below viewport', 'nested clip'] as const)(
    'does not let an opening gate block later rows when %s', async exclusion => {
      const container = root()
      const before = line(container, 'history', 100)
      const outer = document.createElement(exclusion === 'closed details' ? 'details' : 'section')
      outer.getBoundingClientRect = vi.fn(() => rect(125, 40))
      container.append(outer)
      const inner = document.createElement('section')
      inner.getBoundingClientRect = vi.fn(() => rect(120, 60))
      outer.append(inner)
      const top = exclusion === 'above viewport' ? 50 : exclusion === 'below viewport' ? 220 : 140
      const gate = openingGate(inner, top, 25)
      const inside = line(gate, 'history', top)
      const later = line(container, 'live', 180)
      if (exclusion === 'hidden') outer.hidden = true
      if (exclusion === 'closed') gate.dataset.textRevealOpen = 'false'
      if (exclusion === 'closed ancestor') {
        outer.dataset.textRevealOpen = 'false'
        outer.dataset.textRevealReady = 'false'
      }
      if (exclusion === 'nested clip') {
        outer.style.overflowY = 'hidden'
        outer.getBoundingClientRect = vi.fn(() => rect(110, 25))
        inner.style.overflowY = 'auto'
      }
      watch(container)
      await flush()
      expect(start(before)).toBe(100)
      expect(start(later)).toBe(120)
      expect(inside).not.toHaveAttribute('data-line-reveal-ready')
      expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
      if (exclusion === 'nested clip') {
        expect(outer.getBoundingClientRect).toHaveBeenCalled()
        expect(inner.getBoundingClientRect).toHaveBeenCalled()
      }
    }
  )

  it.each(['earlier', 'later'] as const)('keeps DOM order when the %s opening gate finishes first', async firstReady => {
    const container = root()
    container.getBoundingClientRect = vi.fn(() => rect(100, 220))
    const before = line(container, 'history', 105)
    const firstGate = openingGate(container, 135)
    const first = line(firstGate, 'history', 140)
    const middle = line(container, 'live', 180)
    const secondGate = openingGate(container, 220)
    const second = line(secondGate, 'history', 225)
    const later = line(container, 'live', 270)
    watch(container)
    await flush()
    expect(start(before)).toBe(100)
    for (const element of [first, middle, second, later]) expect(element).not.toHaveAttribute('data-line-reveal-ready')

    vi.mocked(performance.now).mockReturnValue(150)
    const gates = firstReady === 'earlier' ? [firstGate, secondGate] : [secondGate, firstGate]
    gates[0].dataset.textRevealReady = 'true'
    await flush()
    if (firstReady === 'earlier') {
      expect([first, middle].map(start)).toEqual([150, 170])
    } else {
      for (const element of [first, middle]) expect(element).not.toHaveAttribute('data-line-reveal-ready')
    }
    for (const element of [second, later]) expect(element).not.toHaveAttribute('data-line-reveal-ready')

    vi.mocked(performance.now).mockReturnValue(300)
    gates[1].dataset.textRevealReady = 'true'
    await flush()
    expect([before, first, middle, second, later].map(start)).toEqual(
      firstReady === 'earlier' ? [100, 150, 170, 300, 320] : [100, 300, 320, 360, 380]
    )
    if (firstReady === 'earlier') {
      expect(first.style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
      expect(middle.style.getPropertyValue('--screen-text-reveal-delay')).toBe('20ms')
    }
  })

  it('observes a nested zero-size opening gate with potential content and wakes on its real size change without polling', async () => {
    const container = root()
    const wrapper = document.createElement('section')
    wrapper.getBoundingClientRect = vi.fn(() => rect(120, 40))
    container.append(wrapper)
    const gate = openingGate(wrapper, 130, 0)
    const inside = line(gate, 'history', 135)
    inside.textContent = '等待展开的正文'
    watch(container)
    await flush()
    expect(resizeObserve).toHaveBeenCalledWith(gate)
    expect(inside).not.toHaveAttribute('data-line-reveal-ready')
    expect(frames.size).toBe(0)

    gate.getBoundingClientRect = vi.fn(() => rect(130, 30))
    resizeCallbacks[0]() // No attribute, scroll, or synthetic readiness change wakes this scan.
    expect(frames.size).toBe(1)
    await flush()
    expect(gate.getBoundingClientRect).toHaveBeenCalled()
    expect(inside).not.toHaveAttribute('data-line-reveal-ready')
    expect(frames.size).toBe(0)
    gate.dataset.textRevealReady = 'true'
    await flush()
    expect(inside).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(start(inside)).toBe(100)
  })

  it('retires only completed owned line fades so display-none reopening cannot restart them', async () => {
    const container = root()
    const complete = line(container)
    const unfinished = line(container, 'live')
    const pending = line(container, 'history', 250)
    const character = document.createElement('span')
    unfinished.append(character)
    const stop = watch(container)
    await flush()
    const finish = (element: HTMLElement, name = 'screen-text-reveal') => {
      const event = new Event('animationend', { bubbles: true })
      Object.defineProperty(event, 'animationName', { value: name })
      element.dispatchEvent(event)
    }
    finish(character)
    finish(unfinished, 'unrelated')
    finish(pending)
    for (const element of [unfinished, pending]) expect(element).not.toHaveClass('screen-text-reveal-static')
    finish(complete)
    expect(complete).toHaveClass('screen-text-reveal-static')
    const originalStart = complete.dataset.lineRevealStart
    container.hidden = true
    await flush()
    container.hidden = false
    await flush()
    expect(complete).toHaveClass('screen-text-reveal-static')
    expect(complete.dataset.lineRevealStart).toBe(originalStart)
    stop()
    finish(unfinished)
    expect(unfinished).not.toHaveClass('screen-text-reveal-static')
  })

  it('keeps separate roots independent, including a nested owner and an empty timeline', async () => {
    const firstRoot = root()
    for (let index = 0; index < 12; index++) line(firstRoot, 'live')
    const secondRoot = root()
    const second = line(secondRoot)
    firstRoot.append(secondRoot)
    watch(firstRoot)
    watch(secondRoot)
    watch(root())
    await flush()
    expect(start(second)).toBe(100)
    expect(second.style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    const appended = line(firstRoot, 'live')
    await flush()
    expect(start(appended)).toBe(580)
  })

  it('keeps rows appended while hidden behind retained future starts after rebinding the watcher', async () => {
    const container = root()
    const queued = [line(container), line(container, 'live'), line(container, 'live')]
    const stop = watch(container)
    await flush()
    const previous = queued.map(element => ({
      start: start(element), delay: element.style.getPropertyValue('--screen-text-reveal-delay')
    }))
    const lastStart = previous[previous.length - 1].start
    expect(lastStart).toBeGreaterThan(performance.now())

    stop()
    container.setAttribute('aria-hidden', 'true')
    container.style.visibility = 'hidden'
    const appended = line(container)
    await flush()
    expect(appended).not.toHaveAttribute('data-line-reveal-ready')

    vi.mocked(performance.now).mockReturnValue(110)
    container.removeAttribute('aria-hidden')
    container.style.removeProperty('visibility')
    watch(container)
    await flush()
    expect(start(appended)).toBeGreaterThanOrEqual(lastStart + SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS)
    await flush() // Drain the style mutation scan without replaying retained rows.
    queued.forEach((element, index) => {
      expect(container.children[index]).toBe(element)
      expect(start(element)).toBe(previous[index].start)
      expect(element.style.getPropertyValue('--screen-text-reveal-delay')).toBe(previous[index].delay)
    })
  })

  it('keeps below-window lines pending, makes only old upper rows static and admits scrolling without replay', async () => {
    const container = root()
    const above = line(container, 'history', -40)
    const upperWindow = line(container, 'history', 10)
    const visible = line(container, 'live', 120)
    const below = line(container, 'history', 220)
    watch(container)
    await flush()
    expect(above).toHaveClass('screen-text-reveal-static')
    expect(start(upperWindow)).toBe(100)
    expect(start(visible)).toBe(120)
    expect(below).not.toHaveAttribute('data-line-reveal-ready')
    expect(below).not.toHaveClass('screen-text-reveal-static')
    below.getBoundingClientRect = vi.fn(() => rect(140))
    below.dispatchEvent(new Event('scroll')) // Non-bubbling nested scroll still reaches capture.
    await flush()
    expect(start(below)).toBe(160)
    expect(start(visible)).toBe(120)
    expect(visible.style.getPropertyValue('--screen-text-reveal-delay')).toBe('20ms')
  })

  it('waits for hidden ancestors, every disclosure gate, closed details and real zero-size layout', async () => {
    const container = root()
    const hidden = document.createElement('section'); hidden.hidden = true; container.append(hidden)
    const hiddenLine = line(hidden)
    const aria = document.createElement('section'); aria.setAttribute('aria-hidden', 'true'); container.append(aria)
    const ariaLine = line(aria)
    const gate = document.createElement('section'); gate.dataset.textRevealOpen = 'false'; gate.dataset.textRevealReady = 'false'; container.append(gate)
    const nested = document.createElement('section'); nested.dataset.textRevealOpen = 'false'; nested.dataset.textRevealReady = 'false'; gate.append(nested)
    const gated = line(nested, 'live')
    const details = document.createElement('details'); container.append(details)
    const summary = document.createElement('summary'); details.append(summary)
    const summaryLine = line(summary)
    const detailsLine = line(details)
    const zero = line(container)
    zero.getBoundingClientRect = vi.fn(() => rect(120, 0, 0))
    watch(container)
    await flush()
    expect(start(summaryLine)).toBe(100)
    for (const element of [hiddenLine, ariaLine, gated, detailsLine, zero]) {
      expect(element).not.toHaveAttribute('data-line-reveal-ready')
    }
    expect(resizeObserve).toHaveBeenCalledWith(zero)
    hidden.hidden = false; aria.removeAttribute('aria-hidden'); gate.dataset.textRevealOpen = 'true'; gate.dataset.textRevealReady = 'true'
    details.open = true
    zero.getBoundingClientRect = vi.fn(() => rect(140))
    resizeCallbacks[0]()
    await flush()
    expect([hiddenLine, ariaLine, detailsLine, zero].map(start)).toEqual([120, 140, 160, 180])
    expect(gated).not.toHaveAttribute('data-line-reveal-ready')
    nested.dataset.textRevealOpen = 'true'; nested.dataset.textRevealReady = 'true'
    await flush()
    expect(start(gated)).toBe(200)
    const original = detailsLine.dataset.lineRevealStart
    details.open = false; await flush()
    details.open = true; details.dispatchEvent(new Event('toggle')); await flush()
    expect(detailsLine.dataset.lineRevealStart).toBe(original)
  })

  it('coalesces events, retries zero-size roots and ignores callbacks after cleanup or a replacement watcher', async () => {
    const container = root()
    container.getBoundingClientRect = vi.fn(() => rect(100, 0, 0))
    const pending = line(container)
    const stop = watch(container)
    await flush()
    expect(pending).not.toHaveAttribute('data-line-reveal-ready')
    container.getBoundingClientRect = vi.fn(() => rect(100, 100))
    resizeCallbacks[0](); mutationCallbacks[0](); window.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)
    const lateFrame = [...frames.values()][0]
    stop()
    watch(container)
    lateFrame(100); resizeCallbacks[0](); mutationCallbacks[0]()
    expect(pending).not.toHaveAttribute('data-line-reveal-ready')
    expect(frames.size).toBe(1)
    await flush()
    expect(start(pending)).toBe(100)
    expect(mutationObserve).toHaveBeenCalledWith(container, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: expect.arrayContaining(['class', 'style', 'hidden', 'aria-hidden', 'data-text-reveal-ready',
        'data-text-reveal-open', 'data-text-reveal-pending', 'data-text-reveal-start', 'open'])
    })
  })
})
