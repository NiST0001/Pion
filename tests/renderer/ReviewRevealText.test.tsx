// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DisclosureRevealGate } from '../../src/renderer/src/features/common/DisclosureRevealGate'
import { REVIEW_REVEAL_CHUNK_SIZE, ReviewRevealText } from '../../src/renderer/src/features/review/ReviewRevealText'
import {
  SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_DURATION_MS, SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
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
  let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
  const targets: Element[] = []
  const created = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; created() }
    observe(target: Element) { targets.push(target); bounds.set(target, new DOMRect(0, 1200, 200, 20)) }
    unobserve() {}
    disconnect = disconnect
  })
  return { created, disconnect, targets,
    notify: (...entries: Element[]) => act(() => intersect(entries.map(target => ({ target, isIntersecting: true })))),
    reveal: (...entries: Element[]) => {
      entries.forEach(target => bounds.set(target, new DOMRect(10, 10, 200, 20)))
      act(() => intersect(entries.map(target => ({ target, isIntersecting: true }))))
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
  const past = vi.spyOn(container.querySelector<HTMLElement>('[data-part="past"]')!, 'getBoundingClientRect')
  const completed = vi.spyOn(container.querySelector<HTMLElement>('[data-part="static"]')!, 'getBoundingClientRect')
  const queued = vi.spyOn(container.querySelector<HTMLElement>('[data-part="future"]')!, 'getBoundingClientRect')
  observer.reveal(observer.targets[0])
  advanceFrame()
  expect(past).not.toHaveBeenCalled()
  expect(completed).not.toHaveBeenCalled()
  expect(queued).toHaveBeenCalledTimes(1)
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
  expect(from.mock.calls.filter(([value]) => typeof value === 'string').map(([value]) => value)).toEqual([tail + suffix])
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
