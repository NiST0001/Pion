// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DisclosureRevealGate } from '../../src/renderer/src/features/common/DisclosureRevealGate'
import { REVIEW_REVEAL_CHUNK_SIZE, REVIEW_REVEAL_COARSE_SIZE, ReviewRevealText } from '../../src/renderer/src/features/review/ReviewRevealText'
import { subscribeTextRevealOrder, TEXT_REVEAL_FRAME_CHARACTER_BUDGET } from '../../src/renderer/src/utils/textRevealOrder'
import {
  SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_DURATION_MS, SCREEN_TEXT_REVEAL_LIVE_DURATION_MS, SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
} from '../../src/renderer/src/utils/screenTextReveal'

let bounds: WeakMap<Element, DOMRect>
let frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  // Install timers once, before the explicit frame queue. Reinstalling them in
  // a test replaces our RAF stub and admits old text only on a later time jump.
  vi.useFakeTimers()
  bounds = new WeakMap()
  frames = new Map()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return bounds.get(this) ?? new DOMRect(0, 0, 800, 600)
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function advanceFrame(): void {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(performance.now()))
  })
}

function historyDeadline(count: number): number {
  return Math.ceil(Math.min((count - 1) * SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS)
    + SCREEN_TEXT_REVEAL_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS)
}

function observeReveals() {
  let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean; time: number }>) => void
  const targets: Element[] = []
  const created = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    private seen = new Set<Element>()
    constructor(callback: typeof intersect) { intersect = callback; created() }
    observe(target: Element) {
      if (!this.seen.has(target)) { this.seen.add(target); targets.push(target); bounds.set(target, new DOMRect(0, 1200, 200, 20)) }
    }
    unobserve() {}
    disconnect = disconnect
  })
  return { created, disconnect, targets,
    hide: (...entries: Element[]) => act(() => intersect(entries.map(target => ({ target, isIntersecting: false, time: performance.now() + 1 })))),
    notify: (...entries: Element[]) => act(() => intersect(entries.map(target => ({ target, isIntersecting: true, time: performance.now() + 1 })))),
    reveal: (...entries: Element[]) => {
      entries.forEach(target => bounds.set(target, new DOMRect(10, 10, 200, 20)))
      act(() => intersect(entries.map(target => ({ target, isIntersecting: true, time: performance.now() + 1 }))))
    }
  }
}

it('waits for disclosure motion before observing and allocating only visible bounded chunks', () => {
  const observer = observeReveals()
  const text = 'a'.repeat(REVIEW_REVEAL_CHUNK_SIZE * 3)
  const { container } = render(<div className="chat-scroll"><DisclosureRevealGate open>
    <pre><ReviewRevealText text={text} /></pre>
  </DisclosureRevealGate></div>)
  expect(container.textContent).toBe(text)
  expect(container.querySelector('pre > span')).toHaveStyle({ opacity: '0' })
  expect(observer.created).not.toHaveBeenCalled()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(199))
  expect(observer.targets).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  expect(observer.created).toHaveBeenCalledOnce()
  expect(observer.targets).toHaveLength(3)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  observer.reveal(observer.targets[1])
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
  act(() => vi.advanceTimersByTime(historyDeadline(REVIEW_REVEAL_CHUNK_SIZE)))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('waits for every nested gate and cancels a pending release when closed', () => {
  const observer = observeReveals()
  const view = (outer: boolean, inner: boolean) => <div className="chat-scroll">
    <DisclosureRevealGate open={outer}><DisclosureRevealGate open={inner}>
      <ReviewRevealText text="nested" />
    </DisclosureRevealGate></DisclosureRevealGate>
  </div>
  const { container, rerender } = render(view(true, false))
  act(() => vi.advanceTimersByTime(200))
  expect(observer.created).not.toHaveBeenCalled()
  rerender(view(true, true))
  act(() => vi.advanceTimersByTime(100))
  rerender(view(false, true))
  act(() => vi.advanceTimersByTime(200))
  expect(observer.created).not.toHaveBeenCalled()
  rerender(view(true, true))
  act(() => vi.advanceTimersByTime(199))
  expect(observer.created).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(observer.targets).toHaveLength(1)
  observer.reveal(observer.targets[0])
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(6)
})

it('unregisters waiting observers on close and ignores late intersections until reopening', () => {
  const observer = observeReveals()
  const view = (open: boolean) => <div className="chat-scroll"><DisclosureRevealGate open={open}>
    <ReviewRevealText text="waiting" />
  </DisclosureRevealGate></div>
  const { container, rerender } = render(view(true))
  act(() => vi.advanceTimersByTime(200))
  const target = observer.targets[0]
  rerender(view(false))
  observer.reveal(target)
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(view(true))
  act(() => vi.advanceTimersByTime(200))
  observer.reveal(observer.targets[1])
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(7)
})

it('does not restart a completed history chunk for updates behind a closed gate', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old'))
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  act(() => vi.advanceTimersByTime(historyDeadline(3)))
  rerender(view(false, 'old up'))
  rerender(view(false, 'old updated'))
  expect(container.textContent).toBe('old updated')
  act(() => vi.advanceTimersByTime(900))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(view(true, 'old updated'))
  act(() => vi.advanceTimersByTime(199))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(8)
  expect([...container.querySelectorAll('.screen-text-reveal-history')].map((node) => node.textContent).join('')).toBe(' updated')
})

it.each([
  ['live', 'old'], ['live', 'replacement\nwith new geometry'],
  ['history', 'old'], ['history', 'replacement\nwith new geometry']
] as const)('projects authoritative %s replacement %j as transparent ordinary text until release', (mode, replacement) => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode={mode} />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old complete chunk'))
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  act(() => vi.advanceTimersByTime(900))
  const chunk = container.querySelector('.disclosure-reveal-gate > span')
  rerender(view(false, replacement))
  expect(container.textContent).toBe(replacement)
  expect(chunk).toHaveStyle({ opacity: '0' })
  expect(chunk?.childNodes).toHaveLength(1)
  expect(chunk?.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(view(true, replacement))
  act(() => vi.advanceTimersByTime(199))
  expect(container.textContent).toBe(replacement)
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect(chunk).toHaveStyle({ opacity: '0' })
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  advanceFrame()
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect(chunk).not.toHaveStyle({ opacity: '0' })
  expect(container.textContent).toBe(replacement)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent).join('')).toBe(replacement)
  act(() => vi.advanceTimersByTime(900))
  expect(container.textContent).toBe(replacement)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('ends obsolete live fades for authoritative replacements without replacing the chunk root', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old unfinished'))
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  const chunk = container.querySelector('.disclosure-reveal-gate > span')
  const obsolete = container.querySelector('[data-screen-reveal-character]')
  expect(obsolete).not.toBeNull()
  rerender(view(false, 'new'))
  expect(container.textContent).toBe('new')
  expect(obsolete?.isConnected).toBe(false)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect(chunk).toHaveStyle({ opacity: '0' })
  rerender(view(true, 'latest'))
  act(() => vi.advanceTimersByTime(199))
  expect(container.textContent).toBe('latest')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  advanceFrame()
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent).join('')).toBe('latest')
})

it.each([
  ['replacement', 'fresh', false, false],
  ['shortening', 'old', true, false],
  ['replacement after a pause', 'fresh', true, true],
  ['shortening after a pause', 'old', false, true]
] as const)('retires only the reused chunk’s obsolete tail on %s', (_label, replacement, other, paused) => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const start = performance.now() + 1000
  const original = 'old'.repeat(40)
  const view = (open: boolean, text: string, futureLine: boolean) => <div className="chat-scroll">
    <section className={futureLine ? 'screen-text-reveal-line' : undefined}
      data-line-reveal-ready="true" data-line-reveal-start={start}>
      <DisclosureRevealGate open={open}>
        {other && <pre data-part="other"><ReviewRevealText text="0123456789" /></pre>}
        <pre data-part="target"><ReviewRevealText text={text} /></pre>
      </DisclosureRevealGate>
    </section>
  </div>
  const { container, rerender } = render(view(true, original, true))
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  const chunk = container.querySelector('[data-part="target"] > span')!
  const obsolete = [...chunk.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  const otherCharacters = [...container.querySelectorAll<HTMLElement>('[data-part="other"] [data-screen-reveal-character]')]
  const otherDelays = otherCharacters.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))
  expect(obsolete).toHaveLength(original.length)
  rerender(view(!paused, replacement, false))
  expect(container.querySelector('[data-part="target"] > span')).toBe(chunk)
  expect(chunk.textContent).toBe(replacement)
  obsolete.forEach(node => expect(node.isConnected).toBe(false))
  expect(chunk.querySelector('[data-screen-reveal-character]')).toBeNull()
  if (paused) {
    rerender(view(true, replacement, false))
    act(() => vi.advanceTimersByTime(200))
  }
  advanceFrame()
  const fresh = [...chunk.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(fresh.map(node => node.textContent).join('')).toBe(replacement)
  expect(parseFloat(fresh[0].style.getPropertyValue('--screen-text-reveal-delay')))
    .toBeCloseTo(other ? start + 10 * SCREEN_TEXT_REVEAL_STAGGER_MS - performance.now() : 0)
  expect([...container.querySelectorAll('[data-part="other"] [data-screen-reveal-character]')]).toEqual(otherCharacters)
  expect(otherCharacters.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))).toEqual(otherDelays)
})

it('clears every old chunk immediately for an authoritative empty update behind a closed gate', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old'.repeat(REVIEW_REVEAL_CHUNK_SIZE)))
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]').length).toBeGreaterThan(0)
  rerender(view(false, ''))
  expect(container.textContent).toBe('')
  expect(container.querySelector('.disclosure-reveal-gate')?.childNodes).toHaveLength(0)
  rerender(view(true, ''))
  act(() => vi.advanceTimersByTime(1100))
  expect(container.textContent).toBe('')
  expect(container.querySelector('.disclosure-reveal-gate')?.childNodes).toHaveLength(0)
})

it('does not let the missing-observer fallback start before the gate releases', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<DisclosureRevealGate open><ReviewRevealText text="fallback" /></DisclosureRevealGate>)
  act(() => vi.advanceTimersByTime(199))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(8)
})

it('plays all accumulated text on its first release rather than just the last token', () => {
  const observer = observeReveals()
  const view = (text: string) => <div className="chat-scroll"><DisclosureRevealGate open>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate></div>
  const { container, rerender } = render(view('first'))
  act(() => vi.advanceTimersByTime(80))
  rerender(view('first second'))
  act(() => vi.advanceTimersByTime(80))
  rerender(view('first second third'))
  expect(observer.created).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(40))
  observer.reveal(observer.targets[0])
  advanceFrame()
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe('first second third')
})

it('defers live suffixes across closing and reopening without replaying the completed prefix', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old'))
  // Commit the released gate first: character deadlines start when React
  // mounts the fade, not while the gate's timer is still inside a batched act.
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  act(() => vi.advanceTimersByTime(900))
  const chunk = container.querySelector('.disclosure-reveal-gate > span')
  rerender(view(false, 'old first'))
  rerender(view(false, 'old first second'))
  expect(container.textContent).toBe('old first second')
  expect(container.querySelector('.disclosure-reveal-gate > span > span:last-child')).toHaveStyle({ opacity: '0' })
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(view(true, 'old first second'))
  act(() => vi.advanceTimersByTime(199))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  advanceFrame()
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe(' first second')
})

it.each(['live', 'history'] as const)('retains unfinished %s fades while the gate closes and only adds deferred suffixes on release', (mode) => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode={mode} />
  </DisclosureRevealGate>
  const text = 'a'.repeat(120)
  const { container, rerender } = render(view(true, text))
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  const original = [...container.querySelectorAll('[data-screen-reveal-character]')]
  act(() => vi.advanceTimersByTime(50))
  rerender(view(false, text + 'bc'))
  act(() => vi.advanceTimersByTime(50))
  rerender(view(true, text + 'bcd'))
  expect([...container.querySelectorAll('[data-screen-reveal-character]')]).toEqual(original)
  act(() => vi.advanceTimersByTime(200))
  advanceFrame()
  const active = [...container.querySelectorAll('[data-screen-reveal-character]')]
  expect(active).toHaveLength(123)
  original.forEach((node, index) => expect(active[index]).toBe(node))
  expect(active.slice(120).map((node) => node.textContent).join('')).toBe('bcd')
  act(() => vi.advanceTimersByTime(900))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it.each(['history', 'live'] as const)('holds later independent %s text behind a visible opening gate until its actual release', (mode) => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<div className="chat-scroll">
    <pre data-part="before"><ReviewRevealText text="before" mode={mode} /></pre>
    <DisclosureRevealGate open><pre data-part="inside"><ReviewRevealText text="inside" mode={mode} /></pre></DisclosureRevealGate>
    <pre data-part="after"><ReviewRevealText text="after" mode={mode} /></pre>
  </div>)
  const before = container.querySelector('[data-part="before"]')!
  const inside = container.querySelector('[data-part="inside"]')!
  const after = container.querySelector('[data-part="after"]')!
  const gate = container.querySelector('.disclosure-reveal-gate')!
  const characters = (element: Element) => [...element.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(container.querySelector('.screen-text-reveal-line')).toBeNull()
  expect(frames.size).toBe(1)
  advanceFrame()
  const prefix = characters(before)
  const delays = prefix.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))
  expect(prefix).toHaveLength(6)
  expect(characters(inside)).toHaveLength(0)
  expect(characters(after)).toHaveLength(0)
  expect(after.firstElementChild).toHaveAttribute('data-text-reveal-pending', 'true')
  expect(after.firstElementChild).not.toHaveAttribute('data-text-reveal-start')
  act(() => vi.advanceTimersByTime(199))
  advanceFrame()
  expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
  expect(characters(after)).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  expect(gate).toHaveAttribute('data-text-reveal-ready', 'true')
  expect(characters(after)).toHaveLength(0)
  advanceFrame()
  const inner = characters(inside), later = characters(after)
  expect(inner.map(node => node.textContent).join('')).toBe('inside')
  expect(later.map(node => node.textContent).join('')).toBe('after')
  expect(parseFloat(later[0].style.getPropertyValue('--screen-text-reveal-delay')))
    .toBeGreaterThanOrEqual(parseFloat(inner.at(-1)!.style.getPropertyValue('--screen-text-reveal-delay')))
  expect(characters(before)).toEqual(prefix)
  expect(prefix.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))).toEqual(delays)
  act(() => vi.advanceTimersByTime(1000))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it.each(['closed', 'above viewport', 'below viewport', 'nested clip'] as const)(
  'does not let a %s disclosure block later independent text', exclusion => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { container } = render(<div className="chat-scroll">
      <section style={exclusion === 'nested clip' ? { overflowY: 'hidden' } : undefined}>
        <DisclosureRevealGate open={exclusion !== 'closed'}><ReviewRevealText text="waiting" /></DisclosureRevealGate>
      </section>
      <pre><ReviewRevealText text="later" /></pre>
    </div>)
    const root = container.firstElementChild!
    const outer = root.firstElementChild!
    const gate = container.querySelector('.disclosure-reveal-gate')!
    const later = container.querySelector('pre > span')!
    const top = exclusion === 'above viewport' ? -50 : exclusion === 'below viewport' ? 500 : 150
    bounds.set(root, new DOMRect(0, 0, 400, 400))
    bounds.set(outer, new DOMRect(0, 0, 300, 100))
    bounds.set(gate, new DOMRect(0, top, 200, 30))
    bounds.set(gate.firstElementChild!, new DOMRect(0, top, 200, 30))
    bounds.set(later, new DOMRect(0, 250, 200, 30))
    expect(frames.size).toBe(1)
    advanceFrame()
    expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
    expect(gate.querySelector('[data-screen-reveal-character]')).toBeNull()
    const characters = [...later.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    expect(characters.map(node => node.textContent).join('')).toBe('later')
    expect(characters[0].style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    expect(later).not.toHaveAttribute('data-text-reveal-pending')
    expect(later).toHaveAttribute('data-text-reveal-start', String(performance.now()))
  }
)

it('keeps gated reduced-motion text immediately static without observers or character DOM', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const observer = observeReveals()
  const { container } = render(<DisclosureRevealGate open><ReviewRevealText text="static" /></DisclosureRevealGate>)
  expect(container.textContent).toBe('static')
  expect(container.querySelector('.disclosure-reveal-gate > span')).not.toHaveStyle({ opacity: '0' })
  expect(observer.created).not.toHaveBeenCalled()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('retains character animation and releases character nodes after it finishes', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container, rerender } = render(<ReviewRevealText text="hello" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.firstElementChild).toHaveAttribute('data-text-reveal-pending', 'true')
  expect(container.firstElementChild).not.toHaveAttribute('data-text-reveal-start')
  expect(frames.size).toBe(1)
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(5)
  expect(container.firstElementChild).not.toHaveAttribute('data-text-reveal-pending')
  expect(container.firstElementChild).toHaveAttribute('data-text-reveal-start', String(performance.now()))
  act(() => { vi.advanceTimersByTime(historyDeadline(5)) })
  expect(container.textContent).toBe('hello')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<ReviewRevealText text="hello" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('allocates characters only for intersecting bounded chunks of a long single line', () => {
  const observer = observeReveals()
  const text = '长🙂'.repeat(2000)
  const { container } = render(<div className="chat-scroll"><pre><ReviewRevealText text={text} /></pre></div>)
  expect(container.textContent).toBe(text)
  expect(observer.created).toHaveBeenCalledOnce()
  expect(observer.targets.length).toBe(Math.ceil(4000 / REVIEW_REVEAL_CHUNK_SIZE))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  observer.reveal(observer.targets[0])
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
  act(() => vi.advanceTimersByTime(historyDeadline(REVIEW_REVEAL_CHUNK_SIZE)))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe(text)
})

it.each([['history', 180], ['live', 360]] as const)('shares one DOM-ordered %s clock and cap across instances and later batches', (mode, cap) => {
  const observer = observeReveals()
  const { container, unmount } = render(<div className="chat-scroll"><pre>
    <ReviewRevealText text={'a'.repeat(REVIEW_REVEAL_CHUNK_SIZE * 2)} mode={mode} />
    <ReviewRevealText text={'b'.repeat(REVIEW_REVEAL_CHUNK_SIZE)} mode={mode} />
    <ReviewRevealText text="later" mode={mode} />
  </pre></div>)
  expect(observer.created).toHaveBeenCalledOnce()
  observer.reveal(observer.targets[2], observer.targets[0], observer.targets[1])
  expect(frames.size).toBe(1)
  advanceFrame()
  const chunks = [...container.querySelectorAll('pre > span')]
  const delays = (chunk: Element) => [...chunk.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    .map(node => parseFloat(node.style.getPropertyValue('--screen-text-reveal-delay')))
  const first = delays(chunks[0]), second = delays(chunks[1]), third = delays(chunks[2])
  expect(first[0]).toBe(0)
  expect(first.at(-1)).toBeLessThanOrEqual(second[0])
  expect(second.at(-1)).toBeLessThanOrEqual(third[0])
  expect(second[0]).toBe(cap)
  expect(third.at(-1)).toBe(cap)
  expect([...first, ...second, ...third].every(delay => delay <= cap)).toBe(true)
  const original = [...container.querySelectorAll('[data-screen-reveal-character]')]
  act(() => vi.advanceTimersByTime(40))
  observer.reveal(observer.targets[3])
  advanceFrame()
  expect(delays(chunks[3])[0]).toBe(cap - 40)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].slice(0, original.length)).toEqual(original)
  unmount()
  expect(observer.disconnect).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
  observer.notify(observer.targets[0])
  advanceFrame()
  expect(frames.size).toBe(0)
})

it('measures future barriers but skips past/static headers when admitting newly visible text', () => {
  const observer = observeReveals()
  const future = performance.now() + 1000
  const { container } = render(<div className="chat-scroll">
    <section data-part="past" className="screen-text-reveal-line" data-line-reveal-ready="true"
      data-line-reveal-start={performance.now() - 100}>already started</section>
    <section data-part="static" className="screen-text-reveal-line screen-text-reveal-static">completed</section>
    <section data-part="future" className="screen-text-reveal-line" data-line-reveal-ready="true"
      data-line-reveal-start={future}>queued header</section>
    <pre><ReviewRevealText text="new detail" /></pre>
  </div>)
  const past = container.querySelector<HTMLElement>('[data-part="past"]')!
  const completed = container.querySelector<HTMLElement>('[data-part="static"]')!
  const queued = container.querySelector<HTMLElement>('[data-part="future"]')!
  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  reads.mockClear()
  observer.reveal(observer.targets[0])
  advanceFrame()
  expect(reads.mock.contexts.filter(node => node === past)).toHaveLength(0)
  expect(reads.mock.contexts.filter(node => node === completed)).toHaveLength(0)
  expect(reads.mock.contexts.filter(node => node === queued)).toHaveLength(1)
  const characters = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(characters.map(node => node.textContent).join('')).toBe('new detail')
  expect(parseFloat(characters[0].style.getPropertyValue('--screen-text-reveal-delay'))).toBeGreaterThanOrEqual(1000)
  expect(container.querySelector('pre > span')).toHaveAttribute('data-text-reveal-start', String(future))
})

it('does not inherit future character delays when a new scope reuses the same root', () => {
  const observer = observeReveals()
  const view = (scope: 'A' | 'B', start: number) => <div className="chat-scroll" data-line-reveal-scope={scope}>
    <section className="screen-text-reveal-line" data-line-reveal-ready="true" data-line-reveal-start={start}>
      <ReviewRevealText key={scope} text={scope === 'A' ? 'queued' : 'fresh'} />
    </section>
  </div>
  const { container, rerender } = render(view('A', performance.now() + 1000))
  const root = container.firstElementChild
  const previousChunk = observer.targets[0]
  observer.reveal(previousChunk)
  advanceFrame()
  const previousCharacters = [...previousChunk.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(previousCharacters).toHaveLength(6)
  expect(parseFloat(previousCharacters[0].style.getPropertyValue('--screen-text-reveal-delay'))).toBe(1000)
  expect(parseFloat(previousCharacters.at(-1)!.style.getPropertyValue('--screen-text-reveal-delay'))).toBeCloseTo(1006)

  // Do not advance time: A's admitted tail is still in the future when its
  // last subscriber is removed and B mounts a genuinely new text instance.
  rerender(view('B', performance.now()))
  expect(container.firstElementChild).toBe(root)
  expect(root).toHaveAttribute('data-line-reveal-scope', 'B')
  expect(observer.created).toHaveBeenCalledTimes(2)
  expect(observer.disconnect).toHaveBeenCalledOnce()
  expect(observer.targets[1]).not.toBe(previousChunk)
  expect(previousChunk.isConnected).toBe(false)
  observer.reveal(observer.targets[1])
  advanceFrame()
  const fresh = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(fresh.map(node => node.textContent).join('')).toBe('fresh')
  fresh.forEach((node, index) => expect(parseFloat(node.style.getPropertyValue('--screen-text-reveal-delay')))
    .toBeCloseTo(index * SCREEN_TEXT_REVEAL_STAGGER_MS))
})

it.each([['history', 180], ['live', 360]] as const)(
  'budgets visible %s requests in DOM order across frames with one absolute cap', (mode, cap) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const root = document.createElement('div')
    root.className = 'chat-scroll'
    document.body.append(root)
    const elements = Array.from({ length: 5 }, () => document.createElement('span'))
    root.append(...elements)
    const calls: Array<{ index: number; delay: number; maxDelay: number; at: number }> = []
    const subscriptions = elements.map(element => subscribeTextRevealOrder(element))
    const count = Math.floor(TEXT_REVEAL_FRAME_CHARACTER_BUDGET / 2)
    // Reverse registration order to exercise DOM ordering, independent of IO.
    subscriptions.forEach((_, index) => {
      const i = subscriptions.length - index - 1
      subscriptions[i].wait({ count, mode, admit: ordered => calls.push({ index: i, ...ordered, at: performance.now() }) })
    })
    const origin = performance.now()
    advanceFrame()
    expect(calls.map(call => call.index)).toEqual([0, 1])
    expect(frames.size).toBe(1)
    act(() => vi.advanceTimersByTime(40))
    advanceFrame()
    expect(calls.map(call => call.index)).toEqual([0, 1, 2, 3])
    expect(calls[2].delay).toBe(cap - 40)
    expect(calls[2].maxDelay).toBe(0)
    act(() => vi.advanceTimersByTime(cap + 1))
    advanceFrame()
    expect(calls.map(call => call.index)).toEqual([0, 1, 2, 3, 4])
    expect(calls[4].delay).toBe(0)
    expect(calls[4].maxDelay).toBe(0)
    expect(calls.slice(0, 4).every(call => call.at + call.delay <= origin + cap)).toBe(true)
    expect(frames.size).toBe(0)
    subscriptions.forEach(subscription => subscription.dispose())
    root.remove()
  }
)

it.each([['history', 180, SCREEN_TEXT_REVEAL_DURATION_MS], ['live', 360, SCREEN_TEXT_REVEAL_LIVE_DURATION_MS]] as const)(
  'keeps the original %s continuation cap when pending tail content grows', (mode, cap, duration) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const original = 'a'.repeat(960) + 'b'.repeat(80)
    const view = (text: string) => <div className="chat-scroll"><ReviewRevealText text={text} mode={mode} /></div>
    const { container, rerender } = render(view(original))
    advanceFrame()
    const first = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    const firstDelays = first.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))
    expect(first).toHaveLength(960)
    const tail = container.querySelector('.chat-scroll > span:last-child')!
    expect(tail).toHaveAttribute('data-text-reveal-pending', 'true')
    act(() => vi.advanceTimersByTime(40))
    rerender(view(original + 'c'.repeat(20)))
    advanceFrame()
    const characters = [...tail.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    expect(characters).toHaveLength(100)
    expect(characters.map(node => node.textContent).join('')).toBe('b'.repeat(80) + 'c'.repeat(20))
    expect(characters.map(node => parseFloat(node.style.getPropertyValue('--screen-text-reveal-delay'))))
      .toEqual(Array(100).fill(cap - 40))
    expect([...container.querySelectorAll('[data-screen-reveal-character]')].slice(0, 960)).toEqual(first)
    expect(first.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))).toEqual(firstDelays)
    const remaining = cap - 40 + duration + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
    act(() => vi.advanceTimersByTime(remaining - 1))
    expect(first.every(node => node.isConnected)).toBe(true)
    expect([...tail.querySelectorAll('[data-screen-reveal-character]')]).toEqual(characters)
    act(() => vi.advanceTimersByTime(1))
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    expect(container.textContent).toBe(original + 'c'.repeat(20))
  }
)

it.each([['history', 180], ['live', 360]] as const)(
  'gives an independently replaced %s pending tail a new horizon', (mode, cap) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const prefix = 'a'.repeat(960)
    const view = (text: string) => <div className="chat-scroll"><ReviewRevealText text={text} mode={mode} /></div>
    const { container, rerender } = render(view(prefix + 'b'.repeat(80)))
    advanceFrame()
    act(() => vi.advanceTimersByTime(40))
    rerender(view(prefix + 'c'.repeat(80)))
    advanceFrame()
    const tail = container.querySelector('.chat-scroll > span:last-child')!
    const characters = [...tail.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    expect(characters.map(node => node.textContent).join('')).toBe('c'.repeat(80))
    expect(parseFloat(characters.at(-1)!.style.getPropertyValue('--screen-text-reveal-delay'))).toBe(cap)
  }
)

it.each([['history', 180, 1.2], ['live', 360, 2.4]] as const)(
  'starts a fresh %s horizon for a suffix after its previous request was admitted', (mode, cap, stagger) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = (suffix: string, waiting: boolean) => <div className="chat-scroll">
      <ReviewRevealText text={'a' + suffix} mode={mode} />
      {waiting && <ReviewRevealText text={'b'.repeat(1040)} mode={mode} />}
    </div>
    const { container, rerender } = render(view('', true))
    advanceFrame()
    const first = container.querySelector('[data-screen-reveal-character]')!
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(961)
    act(() => vi.advanceTimersByTime(40))
    rerender(view('c'.repeat(150), false))
    advanceFrame()
    const characters = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    expect(characters[0]).toBe(first)
    expect(characters.slice(1).map(node => node.textContent).join('')).toBe('c'.repeat(150))
    expect(parseFloat(characters.at(-1)!.style.getPropertyValue('--screen-text-reveal-delay')))
      .toBeCloseTo(Math.min(149 * stagger, cap))
  }
)

it('retains the continuation characters until their original absolute fade deadline', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const chunks = Math.floor(TEXT_REVEAL_FRAME_CHARACTER_BUDGET / REVIEW_REVEAL_CHUNK_SIZE) + 1
  const text = 'a'.repeat(chunks * REVIEW_REVEAL_CHUNK_SIZE)
  const { container } = render(<div className="chat-scroll"><ReviewRevealText text={text} /></div>)
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength((chunks - 1) * REVIEW_REVEAL_CHUNK_SIZE)
  act(() => vi.advanceTimersByTime(40))
  advanceFrame()
  const lastChunk = container.querySelector('.chat-scroll > span:last-child')!
  const characters = [...lastChunk.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(characters).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
  expect(parseFloat(characters[0].style.getPropertyValue('--screen-text-reveal-delay')))
    .toBe(SCREEN_TEXT_REVEAL_MAX_DELAY_MS - 40)
  const deadline = SCREEN_TEXT_REVEAL_MAX_DELAY_MS - 40 + SCREEN_TEXT_REVEAL_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
  act(() => vi.advanceTimersByTime(deadline - 1))
  expect([...lastChunk.querySelectorAll('[data-screen-reveal-character]')]).toEqual(characters)
  act(() => vi.advanceTimersByTime(1))
  expect(lastChunk.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe(text)
})

it('advances an oversized first request and waits at an unready barrier without polling', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = document.createElement('div')
  root.className = 'chat-scroll'
  const first = document.createElement('span'), barrier = document.createElement('div'), later = document.createElement('span')
  barrier.className = 'screen-text-reveal-line'
  root.append(first, barrier, later)
  document.body.append(root)
  const firstSubscription = subscribeTextRevealOrder(first), laterSubscription = subscribeTextRevealOrder(later)
  const firstAdmit = vi.fn(), laterAdmit = vi.fn()
  firstSubscription.wait({ count: TEXT_REVEAL_FRAME_CHARACTER_BUDGET + 1, mode: 'history', admit: firstAdmit })
  laterSubscription.wait({ count: 1, mode: 'history', admit: laterAdmit })
  advanceFrame()
  expect(firstAdmit).toHaveBeenCalledOnce()
  expect(laterAdmit).not.toHaveBeenCalled()
  expect(frames.size).toBe(0)
  await act(async () => { barrier.remove() })
  expect(frames.size).toBe(1)
  advanceFrame()
  expect(laterAdmit).toHaveBeenCalledOnce()
  firstSubscription.dispose()
  laterSubscription.dispose()
  root.remove()
})

it.each(['hidden', 'scope', 'dispose'] as const)('revalidates a queued continuation after %s', async change => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = document.createElement('div')
  root.className = 'chat-scroll'
  root.dataset.lineRevealScope = 'old'
  const first = document.createElement('span'), second = document.createElement('span')
  root.append(first, second)
  document.body.append(root)
  const a = subscribeTextRevealOrder(first), b = subscribeTextRevealOrder(second)
  const firstAdmit = vi.fn(), secondAdmit = vi.fn()
  a.wait({ count: TEXT_REVEAL_FRAME_CHARACTER_BUDGET, mode: 'history', admit: firstAdmit })
  b.wait({ count: 1, mode: 'history', admit: secondAdmit })
  advanceFrame()
  expect(firstAdmit).toHaveBeenCalledOnce()
  expect(frames.size).toBe(1)
  await act(async () => {
    if (change === 'hidden') root.hidden = true
    if (change === 'scope') root.dataset.lineRevealScope = 'new'
    if (change === 'dispose') b.dispose()
  })
  advanceFrame()
  if (change === 'scope') expect(secondAdmit).toHaveBeenCalledWith({ delay: 0, maxDelay: SCREEN_TEXT_REVEAL_MAX_DELAY_MS })
  else expect(secondAdmit).not.toHaveBeenCalled()
  expect(frames.size).toBe(0)
  if (change === 'hidden') {
    await act(async () => { root.hidden = false })
    expect(frames.size).toBe(1)
    advanceFrame()
    expect(secondAdmit).toHaveBeenCalledOnce()
  }
  a.dispose()
  b.dispose()
  root.remove()
})

it('skips known offscreen pending geometry during scroll and measures an entered target immediately', () => {
  const observer = observeReveals()
  const root = document.createElement('div')
  root.className = 'chat-scroll'
  const elements = Array.from({ length: 120 }, () => document.createElement('span'))
  root.append(...elements)
  document.body.append(root)
  const admits = elements.map(() => vi.fn())
  const subscriptions = elements.map((element, index) => {
    const subscription = subscribeTextRevealOrder(element)
    subscription.wait({ count: 1, mode: 'history', admit: admits[index] })
    return subscription
  })
  observer.hide(...elements)
  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  const styles = vi.spyOn(window, 'getComputedStyle')
  reads.mockClear()
  styles.mockClear()
  root.dispatchEvent(new Event('scroll'))
  advanceFrame()
  expect(reads.mock.contexts.some(node => elements.includes(node as HTMLSpanElement))).toBe(false)
  expect(styles.mock.calls.some(([node]) => elements.includes(node as HTMLSpanElement))).toBe(false)
  observer.reveal(elements[42])
  advanceFrame()
  expect(admits[42]).toHaveBeenCalledOnce()
  expect(admits.filter(admit => admit.mock.calls.length)).toHaveLength(1)
  subscriptions.forEach(subscription => subscription.dispose())
  observer.reveal(elements[43])
  expect(frames.size).toBe(0)
  root.remove()
})

it('ignores a stale negative after a new request while preserving other queued receipts', () => {
  let callback!: (entries: IntersectionObserverEntry[]) => void
  let queued: IntersectionObserverEntry[] = []
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: typeof callback) { callback = cb }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { const entries = queued; queued = []; return entries }
  })
  const root = document.createElement('div'), first = document.createElement('span'), second = document.createElement('span')
  root.className = 'chat-scroll'
  root.append(first, second); document.body.append(root)
  const a = subscribeTextRevealOrder(first), b = subscribeTextRevealOrder(second)
  const calls: string[] = []
  a.wait({ count: 1, mode: 'history', admit: () => calls.push('old') })
  b.wait({ count: 1, mode: 'history', admit: () => calls.push('second') })
  act(() => vi.advanceTimersByTime(10))
  const entry = (target: Element, isIntersecting: boolean, time: number) => ({ target, isIntersecting, time }) as IntersectionObserverEntry
  queued = [entry(second, false, performance.now())]
  a.wait({ count: 1, mode: 'history', admit: () => calls.push('first') })
  act(() => callback([entry(first, false, performance.now() - 1)]))
  advanceFrame()
  expect(calls).toEqual(['first'])
  act(() => callback([entry(second, true, performance.now() + 1)]))
  advanceFrame()
  expect(calls).toEqual(['first', 'second'])
  a.dispose(); b.dispose()
  act(() => callback([entry(second, true, performance.now() + 1)]))
  expect(frames.size).toBe(0)
  root.remove()
})

it('keeps offscreen eligibility indexed while an admitted chunk changes its characters', async () => {
  const observer = observeReveals()
  const root = document.createElement('div'), first = document.createElement('span'), later = document.createElement('span')
  root.className = 'chat-scroll'
  first.textContent = 'a'
  root.append(first, later)
  document.body.append(root)
  const firstSubscription = subscribeTextRevealOrder(first), laterSubscription = subscribeTextRevealOrder(later)
  const firstAdmit = vi.fn(), laterAdmit = vi.fn()
  firstSubscription.wait({ count: 1, mode: 'history', admit: firstAdmit })
  laterSubscription.wait({ count: 1, mode: 'history', admit: laterAdmit })
  observer.hide(later)
  observer.reveal(first)
  advanceFrame()
  expect(firstAdmit).toHaveBeenCalledOnce()
  bounds.set(later, new DOMRect(10, 10, 200, 20))
  await act(async () => {
    const character = document.createElement('span')
    character.dataset.screenRevealCharacter = 'true'
    character.textContent = 'a'
    first.replaceChildren(character)
  })
  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  reads.mockClear()
  advanceFrame()
  expect(reads.mock.contexts).not.toContain(later)
  expect(laterAdmit).not.toHaveBeenCalled()
  firstSubscription.dispose()
  laterSubscription.dispose()
  root.remove()
})

it.each(['child', 'style'] as const)('wakes negative candidates on ordinary admitted-owner %s changes', async change => {
  const observer = observeReveals()
  const root = document.createElement('div'), first = document.createElement('span'), later = document.createElement('span')
  root.className = 'chat-scroll'; first.textContent = 'a'; root.append(first, later); document.body.append(root)
  const a = subscribeTextRevealOrder(first), b = subscribeTextRevealOrder(later), admit = vi.fn()
  a.wait({ count: 1, mode: 'history', admit: () => {} })
  b.wait({ count: 1, mode: 'history', admit })
  observer.hide(later); observer.reveal(first); advanceFrame()
  bounds.set(later, new DOMRect(10, 10, 200, 20))
  await act(async () => {
    if (change === 'child') first.append(document.createElement('b'))
    else first.style.width = '20px'
  })
  advanceFrame()
  expect(admit).toHaveBeenCalledOnce()
  a.dispose(); b.dispose(); root.remove()
})

it('rebinds moved roots and wakes detached pending work on reconnection', async () => {
  const observer = observeReveals()
  const old = document.createElement('section'), fresh = document.createElement('section')
  const root = document.createElement('div'), target = document.createElement('span')
  root.className = 'chat-scroll'; root.append(target); old.append(root); document.body.append(old, fresh)
  const subscription = subscribeTextRevealOrder(target), admit = vi.fn()
  subscription.wait({ count: 1, mode: 'history', admit }); observer.hide(target)
  await act(async () => { root.remove() })
  advanceFrame()
  fresh.hidden = true
  await act(async () => { fresh.append(root) })
  bounds.set(target, new DOMRect(10, 10, 200, 20))
  advanceFrame()
  expect(admit).not.toHaveBeenCalled()
  await act(async () => { old.hidden = true })
  expect(frames.size).toBe(0)
  await act(async () => { fresh.hidden = false })
  advanceFrame()
  expect(admit).toHaveBeenCalledOnce()
  subscription.dispose(); old.remove(); fresh.remove()
})

it('keeps a moved pending element bound to its original semantic root', async () => {
  const observer = observeReveals()
  const old = document.createElement('div'), fresh = document.createElement('div'), target = document.createElement('span')
  old.className = fresh.className = 'chat-scroll'
  old.append(target); document.body.append(old, fresh)
  const subscription = subscribeTextRevealOrder(target), admit = vi.fn()
  subscription.wait({ count: 1, mode: 'history', admit }); observer.hide(target)
  await act(async () => { fresh.append(target) })
  observer.reveal(target); advanceFrame()
  expect(admit).not.toHaveBeenCalled()
  subscription.dispose(); old.remove(); fresh.remove()
})

it.each(['hidden', 'style', 'remove barrier', 'reparent'] as const)(
  'invalidates affected offscreen eligibility on %s without another intersection', async change => {
    const observer = observeReveals()
    const outer = document.createElement('div'), root = document.createElement('div')
    root.className = 'chat-scroll'
    const branch = document.createElement('section'), target = document.createElement('span')
    const barrier = document.createElement('div')
    barrier.className = 'screen-text-reveal-line'
    branch.append(target)
    root.append(barrier, branch)
    outer.append(root)
    document.body.append(outer)
    const admit = vi.fn(), subscription = subscribeTextRevealOrder(target)
    subscription.wait({ count: 1, mode: 'history', admit })
    observer.hide(target)
    bounds.set(target, new DOMRect(10, 10, 200, 20))
    advanceFrame()
    expect(admit).not.toHaveBeenCalled()
    await act(async () => {
      if (change === 'hidden') outer.hidden = true
      if (change === 'style') outer.style.display = 'none'
      if (change === 'remove barrier') barrier.remove()
      if (change === 'reparent') { barrier.remove(); root.append(target) }
    })
    if (change === 'hidden' || change === 'style') {
      advanceFrame()
      expect(admit).not.toHaveBeenCalled()
      await act(async () => {
        barrier.remove()
        if (change === 'hidden') outer.hidden = false
        else outer.style.display = ''
      })
    }
    advanceFrame()
    expect(admit).toHaveBeenCalledOnce()
    subscription.dispose()
    outer.remove()
  }
)

it('falls back to all pending geometry for an unknown mutation and ignores late callbacks', () => {
  const observer = observeReveals()
  let callback!: MutationCallback
  vi.stubGlobal('MutationObserver', class {
    constructor(receive: MutationCallback) { callback = receive }
    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  })
  const root = document.createElement('div'), target = document.createElement('span')
  root.className = 'chat-scroll'
  root.append(target)
  document.body.append(root)
  const admit = vi.fn(), subscription = subscribeTextRevealOrder(target)
  subscription.wait({ count: 1, mode: 'history', admit })
  observer.hide(target)
  bounds.set(target, new DOMRect(10, 10, 200, 20))
  advanceFrame()
  expect(admit).not.toHaveBeenCalled()
  callback([{ type: 'unknown' } as unknown as MutationRecord], {} as MutationObserver)
  advanceFrame()
  expect(admit).toHaveBeenCalledOnce()
  subscription.dispose()
  callback([{ type: 'unknown' } as unknown as MutationRecord], {} as MutationObserver)
  observer.reveal(target)
  expect(frames.size).toBe(0)
  root.remove()
})

it('does not schedule idle subscribers, including a replaced pending subscription', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = document.createElement('div'), element = document.createElement('span')
  root.className = 'chat-scroll'
  root.append(element)
  document.body.append(root)
  const old = subscribeTextRevealOrder(element)
  old.wait({ count: 1, mode: 'history', admit: vi.fn() })
  const replacement = subscribeTextRevealOrder(element)
  advanceFrame()
  root.dispatchEvent(new Event('scroll'))
  expect(frames.size).toBe(0)
  old.dispose()
  replacement.dispose()
  root.remove()
})

it.each([['history', 180], ['live', 360]] as const)(
  'preserves a single coarse %s wake across a slow frame and plain pre root', (mode, cap) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const start = performance.now() + 1000
    const { container } = render(<pre className="screen-text-reveal-line" data-line-reveal-ready="true"
      data-line-reveal-start={start}><ReviewRevealText mode={mode} text={'a'.repeat(REVIEW_REVEAL_COARSE_SIZE)} deferOffscreen /></pre>)
    advanceFrame()
    expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1100))
    advanceFrame()
    const chars = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    expect(chars.length).toBeGreaterThan(0)
    expect(Math.max(...chars.map(node => parseFloat(node.style.getPropertyValue('--screen-text-reveal-delay')))))
      .toBeLessThanOrEqual(cap - 100)
  }
)

it('refines only an entered coarse block while preserving all text', () => {
  const observer = observeReveals()
  const text = '🙂a'.repeat(REVIEW_REVEAL_COARSE_SIZE * 2)
  const { container } = render(<div className="chat-scroll"><pre><ReviewRevealText text={text} deferOffscreen /></pre></div>)
  const coarse = [...container.querySelectorAll('pre > span')]
  expect(coarse).toHaveLength(4)
  expect(observer.targets).toEqual(coarse)
  expect(container.textContent).toBe(text)
  observer.reveal(coarse[0])
  advanceFrame()
  expect(container.textContent).toBe(text)
  expect(coarse[0].querySelectorAll(':scope > span')).toHaveLength(Math.ceil(REVIEW_REVEAL_COARSE_SIZE / REVIEW_REVEAL_CHUNK_SIZE))
  expect(coarse[1].childNodes).toHaveLength(1)
  expect(coarse[1].firstChild?.nodeType).toBe(Node.TEXT_NODE)
  expect(observer.created).toHaveBeenCalledOnce()
  observer.reveal(observer.targets[4])
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
  expect(container.textContent).toBe(text)
})

it('waits for selection to leave a coarse block before refining without polling', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const text = 'a'.repeat(REVIEW_REVEAL_COARSE_SIZE)
  const { container } = render(<div className="chat-scroll"><ReviewRevealText text={text} deferOffscreen /></div>)
  const coarse = container.querySelector('.chat-scroll > span')!
  const range = document.createRange()
  range.setStart(coarse.firstChild!, 1)
  range.setEnd(coarse.firstChild!, 10)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  advanceFrame()
  expect(coarse.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  expect(frames.size).toBe(0)
  expect(selection.toString()).toBe('a'.repeat(9))
  act(() => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  advanceFrame()
  expect(coarse.querySelectorAll(':scope > span')).toHaveLength(Math.ceil(REVIEW_REVEAL_COARSE_SIZE / REVIEW_REVEAL_CHUNK_SIZE))
  expect(container.textContent).toBe(text)
})

it('hands the coarse barrier to fine requests before admitting later text', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const text = 'a'.repeat(REVIEW_REVEAL_COARSE_SIZE)
  const { container } = render(<div className="chat-scroll">
    <pre data-part="first"><ReviewRevealText text={text} deferOffscreen /></pre>
    <pre data-part="later"><ReviewRevealText text="later" /></pre>
  </div>)
  const first = container.querySelector('[data-part="first"]')!
  const later = container.querySelector('[data-part="later"]')!
  expect(first.firstElementChild).toHaveAttribute('data-text-reveal-pending', 'true')
  advanceFrame()
  expect(first.querySelectorAll(':scope > span > span')).toHaveLength(Math.ceil(REVIEW_REVEAL_COARSE_SIZE / REVIEW_REVEAL_CHUNK_SIZE))
  expect(later.querySelector('[data-screen-reveal-character]')).toBeNull()
  expect(first.querySelector('[data-text-reveal-pending="true"]')).not.toBeNull()
  advanceFrame()
  expect(first.querySelector('[data-screen-reveal-character]')).not.toBeNull()
  expect(later.querySelector('[data-screen-reveal-character]')).toBeNull()
})

it('preserves the same clock horizon across a preparation commit', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<div className="chat-scroll">
    <pre data-part="before"><ReviewRevealText text={'b'.repeat(160)} /></pre>
    <pre data-part="coarse"><ReviewRevealText text={'a'.repeat(REVIEW_REVEAL_COARSE_SIZE)} deferOffscreen /></pre>
  </div>)
  advanceFrame()
  const before = container.querySelectorAll('[data-part="before"] [data-screen-reveal-character]')
  expect(before).toHaveLength(160)
  expect(container.querySelector('[data-part="coarse"] [data-screen-reveal-character]')).toBeNull()
  act(() => vi.advanceTimersByTime(40))
  advanceFrame()
  const fine = [...container.querySelectorAll<HTMLElement>('[data-part="coarse"] [data-screen-reveal-character]')]
  expect(fine.length).toBeGreaterThan(0)
  expect(fine.every(node => parseFloat(node.style.getPropertyValue('--screen-text-reveal-delay')) <= SCREEN_TEXT_REVEAL_MAX_DELAY_MS - 40)).toBe(true)
})

it('retains refined prefixes on append and handles surrogate completion and replacement', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const initial = 'a'.repeat(REVIEW_REVEAL_COARSE_SIZE - 1) + '\ud83d'
  const view = (text: string) => <div className="chat-scroll"><ReviewRevealText text={text} mode="live" deferOffscreen /></div>
  const { container, rerender } = render(view(initial))
  advanceFrame()
  advanceFrame()
  const first = container.querySelector('[data-screen-reveal-character]')!
  const delay = (first as HTMLElement).style.getPropertyValue('--screen-text-reveal-delay')
  rerender(view(initial + '\ude42' + 'b'))
  expect(container.textContent).toBe(initial + '\ude42' + 'b')
  expect(container.querySelector('[data-screen-reveal-character]')).toBe(first)
  expect((first as HTMLElement).style.getPropertyValue('--screen-text-reveal-delay')).toBe(delay)
  rerender(view('new🙂'))
  expect(container.textContent).toBe('new🙂')
  expect(first.isConnected).toBe(false)
  rerender(view('n'))
  expect(container.textContent).toBe('n')
})

it('keeps initially short instances structurally stable and long reduced-motion text static', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container, rerender, unmount } = render(<ReviewRevealText text="short" />)
  advanceFrame()
  const first = container.firstElementChild
  rerender(<ReviewRevealText text={'short' + 'x'.repeat(REVIEW_REVEAL_COARSE_SIZE)} />)
  expect(container.firstElementChild).toBe(first)
  unmount()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const observer = observeReveals()
  const text = 'x'.repeat(REVIEW_REVEAL_COARSE_SIZE * 2)
  const next = render(<div className="chat-scroll"><ReviewRevealText text={text} deferOffscreen /></div>)
  expect(next.container.textContent).toBe(text)
  expect(observer.created).not.toHaveBeenCalled()
  expect(next.container.querySelector('[data-text-reveal-pending]')).toBeNull()
})

it('freezes the default fine structure for long text when the opt-in changes', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const text = 'x'.repeat(REVIEW_REVEAL_COARSE_SIZE)
  const view = (deferOffscreen?: boolean) => <div className="chat-scroll">
    <ReviewRevealText text={text} deferOffscreen={deferOffscreen} />
  </div>
  const { container, rerender } = render(view())
  const chunks = [...container.querySelectorAll('.chat-scroll > span')]
  expect(chunks).toHaveLength(Math.ceil(text.length / REVIEW_REVEAL_CHUNK_SIZE))
  expect(container.querySelector('[data-text-reveal-coarse]')).toBeNull()
  advanceFrame()
  const characters = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  const delays = characters.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))
  expect(characters.length).toBeGreaterThan(0)
  rerender(view(true))
  expect([...container.querySelectorAll('.chat-scroll > span')]).toEqual(chunks)
  expect(container.querySelector('[data-text-reveal-coarse]')).toBeNull()
  expect([...container.querySelectorAll('[data-screen-reveal-character]')]).toEqual(characters)
  expect(characters.map(node => node.style.getPropertyValue('--screen-text-reveal-delay'))).toEqual(delays)
  expect(container.textContent).toBe(text)
})

function admittedFutureSources() {
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = document.createElement('div')
  root.className = 'chat-scroll'
  root.dataset.lineRevealScope = 'same'
  const line = document.createElement('section')
  line.className = 'screen-text-reveal-line'
  line.dataset.lineRevealReady = 'true'
  line.dataset.lineRevealStart = String(performance.now() + 1000)
  const first = document.createElement('span'), second = document.createElement('span')
  line.append(first, second)
  root.append(line)
  document.body.append(root)
  const firstSubscription = subscribeTextRevealOrder(first), secondSubscription = subscribeTextRevealOrder(second)
  const firstAdmit = vi.fn(), secondAdmit = vi.fn()
  firstSubscription.wait({ count: 10, mode: 'history', admit: firstAdmit })
  secondSubscription.wait({ count: 10, mode: 'history', admit: secondAdmit })
  advanceFrame()
  expect(firstAdmit).toHaveBeenCalledWith({ delay: 1000, maxDelay: SCREEN_TEXT_REVEAL_MAX_DELAY_MS })
  expect(secondAdmit.mock.calls[0][0].delay).toBeCloseTo(1000 + 10 * SCREEN_TEXT_REVEAL_STAGGER_MS)
  // Leave the admitted sources connected while removing their independent line barrier.
  line.className = ''
  return { root, line, first, second, firstSubscription, secondSubscription, firstAdmit, secondAdmit }
}

it('reuses weak source identity and prunes collected sources on the next scan', () => {
  const NativeWeakRef = WeakRef
  const sources: Array<{ collected: boolean }> = []
  vi.stubGlobal('WeakRef', class<T extends object> {
    private readonly ref: WeakRef<T>
    readonly state = { collected: false }
    constructor(value: T) { this.ref = new NativeWeakRef(value); sources.push(this.state) }
    deref(): T | undefined { return this.state.collected ? undefined : this.ref.deref() }
  })
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = document.createElement('div')
  root.className = 'chat-scroll'
  const line = document.createElement('section')
  line.className = 'screen-text-reveal-line'
  line.dataset.lineRevealReady = 'true'
  line.dataset.lineRevealStart = String(performance.now() + 1000)
  const source = document.createElement('span')
  line.append(source)
  root.append(line)
  document.body.append(root)
  const first = subscribeTextRevealOrder(source)
  first.wait({ count: 10, mode: 'history', admit: vi.fn() })
  advanceFrame()
  line.className = ''
  first.wait({ count: 1, mode: 'history', admit: vi.fn() })
  advanceFrame()
  expect(sources).toHaveLength(1)
  first.dispose()
  // Model a collected weak referent without depending on a GC schedule.
  sources[0].collected = true
  const fresh = document.createElement('span')
  root.append(fresh)
  const admit = vi.fn(), subscription = subscribeTextRevealOrder(fresh)
  subscription.wait({ count: 1, mode: 'history', admit })
  advanceFrame()
  expect(admit.mock.calls[0][0].delay).toBe(0)
  subscription.dispose()
  root.remove()
})

it('retires all detached character tails when a same-scope window is replaced', () => {
  const { root, line, firstSubscription, secondSubscription } = admittedFutureSources()
  firstSubscription.dispose()
  secondSubscription.dispose()
  line.remove()
  const fresh = document.createElement('span')
  root.append(fresh)
  const admit = vi.fn(), subscription = subscribeTextRevealOrder(fresh)
  subscription.wait({ count: 1, mode: 'history', admit })
  advanceFrame()
  expect(admit.mock.calls[0][0].delay).toBe(0)
  subscription.dispose()
  root.remove()
})

it('keeps an earlier connected source when the latest character tail is removed', () => {
  const { root, second, firstSubscription, secondSubscription } = admittedFutureSources()
  secondSubscription.dispose()
  second.remove()
  const fresh = document.createElement('span')
  root.append(fresh)
  const admit = vi.fn(), subscription = subscribeTextRevealOrder(fresh)
  subscription.wait({ count: 1, mode: 'history', admit })
  advanceFrame()
  expect(admit.mock.calls[0][0].delay).toBeCloseTo(1000 + 10 * SCREEN_TEXT_REVEAL_STAGGER_MS)
  firstSubscription.dispose()
  subscription.dispose()
  root.remove()
})

it('retains connected future sources across a full subscription pause', () => {
  const { root, first, firstSubscription, secondSubscription, firstAdmit, secondAdmit } = admittedFutureSources()
  firstSubscription.dispose()
  secondSubscription.dispose()
  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  reads.mockClear()
  expect(frames.size).toBe(0)
  expect(reads).not.toHaveBeenCalled()
  const resumed = subscribeTextRevealOrder(first)
  const fresh = document.createElement('span')
  root.append(fresh)
  const admit = vi.fn(), subscription = subscribeTextRevealOrder(fresh)
  subscription.wait({ count: 1, mode: 'history', admit })
  advanceFrame()
  expect(admit.mock.calls[0][0].delay).toBeCloseTo(1000 + 20 * SCREEN_TEXT_REVEAL_STAGGER_MS)
  expect(firstAdmit).toHaveBeenCalledOnce()
  expect(secondAdmit).toHaveBeenCalledOnce()
  resumed.dispose()
  subscription.dispose()
  root.remove()
})

it('blocks later visible chunks on an unready parent and wakes from hidden/line attributes without another IO event', async () => {
  const observer = observeReveals()
  const { container } = render(<div className="chat-scroll">
    <section className="screen-text-reveal-line"><ReviewRevealText text="first" /></section>
    <section className="screen-text-reveal-line" data-line-reveal-ready="true" data-line-reveal-start="120"><ReviewRevealText text="next" /></section>
    <section className="screen-text-reveal-line screen-text-reveal-static"><ReviewRevealText text="static parent" /></section>
  </div>)
  const root = container.firstElementChild as HTMLElement
  observer.reveal(observer.targets[2], observer.targets[1], observer.targets[0])
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  const firstLine = root.firstElementChild as HTMLElement
  // A queued intersection cannot consume a chunk that became hidden before RAF.
  observer.notify(observer.targets[1])
  await act(async () => { root.hidden = true })
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  await act(async () => { root.hidden = false })
  expect(frames.size).toBe(1)
  advanceFrame()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  await act(async () => {
    firstLine.dataset.lineRevealReady = 'true'
    firstLine.dataset.lineRevealStart = String(performance.now() + 80)
  })
  expect(frames.size).toBe(1)
  advanceFrame()
  const starts = [...root.querySelectorAll('section')].map(section => parseFloat(
    section.querySelector<HTMLElement>('[data-screen-reveal-character]')!.style.getPropertyValue('--screen-text-reveal-delay')))
  expect(starts[0]).toBe(80)
  expect(starts[1]).toBe(120)
  expect(starts[2]).toBeGreaterThanOrEqual(starts[1])
})

it.each(['line', 'gate'] as const)('wakes pending text when an earlier %s is removed without a geometry event', async barrier => {
  const observer = observeReveals()
  const { container } = render(<div className="chat-scroll">
    {barrier === 'line'
      ? <div className="screen-text-reveal-line">waiting</div>
      : <div data-text-reveal-open="true" data-text-reveal-ready="false">waiting</div>}
    <pre><ReviewRevealText text="detail" /></pre>
  </div>)
  const root = container.firstElementChild!
  const target = observer.targets[0]
  observer.reveal(target)
  advanceFrame()
  expect(target).toHaveAttribute('data-text-reveal-pending', 'true')
  expect(target.querySelector('[data-screen-reveal-character]')).toBeNull()
  expect(frames.size).toBe(0)
  await act(async () => { root.firstElementChild!.remove() })
  expect(frames.size).toBe(1)
  advanceFrame()
  expect(container.querySelector('pre > span')).toBe(target)
  expect(target.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(6)
  expect(target).not.toHaveAttribute('data-text-reveal-pending')
  await act(async () => { root.append(document.createElement('div')) })
  expect(frames.size).toBe(0)
})

it('ignores a disposed group’s late mutation and frame callbacks after a new subscription', () => {
  const callbacks: MutationCallback[] = []
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: MutationCallback) { callbacks.push(callback) }
    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  })
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = document.createElement('div')
  root.className = 'chat-scroll'
  const element = document.createElement('span')
  root.append(element)
  document.body.append(root)
  const oldAdmit = vi.fn(), newAdmit = vi.fn()
  const old = subscribeTextRevealOrder(element)
  old.wait({ count: 1, mode: 'history', admit: oldAdmit })
  const oldFrame = [...frames.values()][0]
  old.dispose()
  const current = subscribeTextRevealOrder(element)
  current.wait({ count: 1, mode: 'history', admit: newAdmit })
  expect(frames.size).toBe(1)
  callbacks[0]([], {} as MutationObserver)
  oldFrame(performance.now())
  expect(frames.size).toBe(1)
  expect(oldAdmit).not.toHaveBeenCalled()
  expect(newAdmit).not.toHaveBeenCalled()
  advanceFrame()
  expect(newAdmit).toHaveBeenCalledOnce()
  current.dispose()
  root.remove()
})

it('waits for earlier sibling headers instead of starting a detail from the middle', async () => {
  const observer = observeReveals()
  const { container } = render(<div className="chat-scroll">
    <div className="screen-text-reveal-line">header</div>
    <pre><ReviewRevealText text="detail" /></pre>
  </div>)
  observer.reveal(observer.targets[0])
  advanceFrame()
  expect(container.querySelector('[data-screen-reveal-character]')).toBeNull()
  const header = container.querySelector<HTMLElement>('.screen-text-reveal-line')!
  await act(async () => {
    header.dataset.lineRevealReady = 'true'
    header.dataset.lineRevealStart = String(performance.now() + 700)
  })
  advanceFrame()
  const characters = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(characters).toHaveLength(6)
  const firstDelay = parseFloat(characters[0].style.getPropertyValue('--screen-text-reveal-delay'))
  const lastDelay = parseFloat(characters.at(-1)!.style.getPropertyValue('--screen-text-reveal-delay'))
  expect(firstDelay).toBeGreaterThanOrEqual(700)
  const deadline = Math.ceil(lastDelay + SCREEN_TEXT_REVEAL_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS)
  expect(deadline).toBeGreaterThanOrEqual(700 + historyDeadline(characters.length))
  // A ready header can still be queued: neither the old 468ms block timeout
  // nor a character-only deadline may recycle the detail before that wait.
  act(() => vi.advanceTimersByTime(468))
  expect([...container.querySelectorAll('[data-screen-reveal-character]')]).toEqual(characters)
  act(() => vi.advanceTimersByTime(deadline - 468 - 1))
  expect([...container.querySelectorAll('[data-screen-reveal-character]')]).toEqual(characters)
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.querySelector('pre')).toHaveTextContent('detail')
})

it('skips offscreen pending ancestors before style reads and wakes on geometry changes', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<div className="chat-scroll">
    <section data-part="offscreen"><ReviewRevealText text="waiting" /></section>
    <section data-part="visible"><ReviewRevealText text="visible" /></section>
  </div>)
  const offscreen = container.querySelector<HTMLElement>('[data-part="offscreen"]')!
  const target = offscreen.firstElementChild!
  bounds.set(target, new DOMRect(0, 1200, 100, 20))
  const styles = vi.spyOn(window, 'getComputedStyle')
  advanceFrame()
  expect(styles.mock.calls.some(([node]) => node === target || node === offscreen)).toBe(false)
  expect(target.querySelector('[data-screen-reveal-character]')).toBeNull()
  expect(container.querySelector('[data-part="visible"] [data-screen-reveal-character]')).not.toBeNull()
  bounds.set(target, new DOMRect(0, 10, 100, 20))
  container.firstElementChild!.dispatchEvent(new Event('scroll'))
  advanceFrame()
  expect(target.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(7)
})

it('ignores zero geometry and nested clipping without allowing offscreen unready parents to block visible text', () => {
  const observer = observeReveals()
  const { container } = render(<div className="chat-scroll"><div style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
    <section className="screen-text-reveal-line"><ReviewRevealText text="offscreen" /></section>
    <ReviewRevealText text={'x'.repeat(REVIEW_REVEAL_CHUNK_SIZE * 2)} />
  </div></div>)
  const clip = container.querySelector('.chat-scroll > div')!
  bounds.set(clip, new DOMRect(0, 0, 100, 60))
  bounds.set(observer.targets[0], new DOMRect(140, 10, 40, 20))
  bounds.set(observer.targets[0].parentElement!, new DOMRect(140, 10, 40, 20))
  bounds.set(observer.targets[1], new DOMRect(0, 0, 0, 0))
  bounds.set(observer.targets[2], new DOMRect(10, 10, 40, 20))
  observer.notify(observer.targets[0], observer.targets[1], observer.targets[2])
  advanceFrame()
  expect(observer.targets[0].querySelector('[data-screen-reveal-character]')).toBeNull()
  expect(observer.targets[1].querySelector('[data-screen-reveal-character]')).toBeNull()
  expect(observer.targets[2].querySelectorAll('[data-screen-reveal-character]')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
})

it('rechunks only the committed tail and appended suffix without splitting surrogate pairs', () => {
  const observer = observeReveals()
  const prefix = '🙂'.repeat(REVIEW_REVEAL_CHUNK_SIZE)
  const tail = '🙂'.repeat(REVIEW_REVEAL_CHUNK_SIZE - 1) + '\ud83d'
  const { container, rerender } = render(<div className="chat-scroll"><pre><ReviewRevealText text={prefix + tail} /></pre></div>)
  const first = container.querySelector('pre > span')
  expect(observer.targets).toHaveLength(2)
  const from = vi.spyOn(Array, 'from')
  const suffix = '\ude42新'
  rerender(<div className="chat-scroll"><pre><ReviewRevealText text={prefix + tail + suffix} /></pre></div>)
  // Chunking walks code points directly, without copying the tail to an array.
  expect(from.mock.calls.filter(([value]) => typeof value === 'string')).toHaveLength(0)
  expect(container.querySelector('pre > span')).toBe(first)
  expect([...container.querySelectorAll('pre > span')].map((node) => node.textContent)).toEqual([prefix, prefix, '新'])
  expect(container.textContent).toBe(prefix + tail + suffix)
  rerender(<div className="chat-scroll"><pre><ReviewRevealText text="replacement🙂" /></pre></div>)
  expect(container.textContent).toBe('replacement🙂')
  rerender(<div className="chat-scroll"><pre><ReviewRevealText text="rep" /></pre></div>)
  expect(container.textContent).toBe('rep')
})

it('keeps completed history prefixes static when an appended low surrogate completes their last character', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const prefix = 'a'.repeat(REVIEW_REVEAL_CHUNK_SIZE - 1)
  const { container, rerender } = render(<pre><ReviewRevealText text={prefix + '\ud83d'} /></pre>)
  advanceFrame()
  act(() => vi.advanceTimersByTime(historyDeadline(REVIEW_REVEAL_CHUNK_SIZE)))
  const chunk = container.querySelector('pre > span')
  rerender(<pre><ReviewRevealText text={prefix + '🙂好'} /></pre>)
  advanceFrame()
  expect(container.querySelector('pre > span')).toBe(chunk)
  expect(chunk?.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  expect(chunk?.firstChild?.textContent).toBe(prefix)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent)).toEqual(['🙂', '好'])
  expect(container.textContent).toBe(prefix + '🙂好')
})

it('does not let a short history suffix finish or reanimate its older prefix', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const text = 'a'.repeat(117)
  const { container, rerender, unmount } = render(<ReviewRevealText text={text} />)
  advanceFrame()
  const before = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  const delays = before.map((node) => node.style.getPropertyValue('--screen-text-reveal-delay'))
  act(() => vi.advanceTimersByTime(50))
  rerender(<ReviewRevealText text={text + 'bc'} />)
  advanceFrame()
  act(() => vi.advanceTimersByTime(50))
  rerender(<ReviewRevealText text={text + 'bcd'} />)
  advanceFrame()
  const active = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(active).toHaveLength(120)
  before.forEach((node, index) => {
    expect(active[index]).toBe(node)
    expect(node.style.getPropertyValue('--screen-text-reveal-delay')).toBe(delays[index])
  })
  expect(parseFloat(active[119].style.getPropertyValue('--screen-text-reveal-delay'))).toBeCloseTo(42.8)
  act(() => vi.advanceTimersByTime(263))
  const event = new Event('webkitAnimationEnd', { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: 'screen-text-reveal' })
  fireEvent(active[119], event)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')]).toEqual(active.slice(0, -1))
  // Each original range keeps its own actual deadline, not a restarted 468ms
  // block timer. Finishing the newest suffix must not recycle older ranges.
  act(() => vi.advanceTimersByTime(64))
  before.forEach(node => expect(node.isConnected).toBe(true))
  act(() => vi.advanceTimersByTime(1))
  before.forEach(node => expect(node.isConnected).toBe(false))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(2)
  act(() => vi.advanceTimersByTime(2))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  const prefix = container.firstElementChild?.firstChild
  rerender(<ReviewRevealText text={text + 'bcde'} />)
  advanceFrame()
  expect(container.firstElementChild?.firstChild).toBe(prefix)
  expect(prefix?.nodeType).toBe(Node.TEXT_NODE)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent)).toEqual(['e'])
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('reclaims live spans, animates only new suffixes and keeps completed chunks stable', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const text = 'a'.repeat(REVIEW_REVEAL_CHUNK_SIZE) + 'old'
  const { container, rerender } = render(<pre><ReviewRevealText text={text} mode="live" /></pre>)
  advanceFrame()
  act(() => vi.advanceTimersByTime(300))
  // The old cleanup deadline must not cut off the slower live cascade.
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(text.length)
  act(() => vi.advanceTimersByTime(568))
  const first = container.querySelector('pre > span')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<pre><ReviewRevealText text={text + 'new'} mode="live" /></pre>)
  advanceFrame()
  expect(container.querySelector('pre > span')).toBe(first)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe('new')
  act(() => vi.advanceTimersByTime(868))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe(text + 'new')
})

it('reclaims after the last character animation, not an earlier character', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<ReviewRevealText text="abc" mode="live" />)
  advanceFrame()
  const characters = container.querySelectorAll('[data-screen-reveal-character]')
  const finish = (element: Element): void => {
    // JSDOM has no AnimationEvent constructor; React selects the supported
    // Webkit event name. Real Chromium uses the standard animationend event.
    const event = new Event('webkitAnimationEnd', { bubbles: true })
    Object.defineProperty(event, 'animationName', { value: 'screen-text-reveal' })
    fireEvent(element, event)
  }
  finish(characters[0])
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(3)
  finish(characters[2])
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe('abc')
})

it('restarts the cleanup deadline for each appended suffix without replaying the prefix', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container, rerender } = render(<ReviewRevealText text="old" mode="live" />)
  advanceFrame()
  act(() => vi.advanceTimersByTime(900))
  rerender(<ReviewRevealText text="old appended" mode="live" />)
  advanceFrame()
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe(' appended')
  act(() => vi.advanceTimersByTime(32))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(9)
  act(() => vi.advanceTimersByTime(868))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('preserves concurrent fade groups when a newer short suffix finishes first', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const original = 'a'.repeat(120)
  const { container, rerender } = render(<ReviewRevealText text={original} mode="live" />)
  advanceFrame()
  const before = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  const delays = before.map((node) => node.style.getPropertyValue('--screen-text-reveal-delay'))
  act(() => vi.advanceTimersByTime(100))
  rerender(<ReviewRevealText text={original + 'bc'} mode="live" />)
  advanceFrame()
  act(() => vi.advanceTimersByTime(100))
  rerender(<ReviewRevealText text={original + 'bcd'} mode="live" />)
  advanceFrame()
  const active = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  expect(active).toHaveLength(123)
  before.forEach((node, index) => {
    expect(active[index]).toBe(node)
    expect(node.style.getPropertyValue('--screen-text-reveal-delay')).toBe(delays[index])
  })
  const finish = (element: Element): void => {
    const event = new Event('webkitAnimationEnd', { bubbles: true })
    Object.defineProperty(event, 'animationName', { value: 'screen-text-reveal' })
    fireEvent(element, event)
  }
  finish(active[122])
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(122)
  expect(container.querySelector('[data-screen-reveal-character]')).toBe(before[0])
  act(() => vi.advanceTimersByTime(900))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<ReviewRevealText text={original + 'bcde'} mode="live" />)
  advanceFrame()
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent)).toEqual(['e'])
})

it('does not allocate animation characters when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const { container, rerender } = render(<ReviewRevealText text="first" mode="live" />)
  rerender(<ReviewRevealText text="first appended" mode="live" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe('first appended')
})
