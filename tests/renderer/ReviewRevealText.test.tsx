// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DisclosureRevealGate } from '../../src/renderer/src/features/common/DisclosureRevealGate'
import { REVIEW_REVEAL_CHUNK_SIZE, ReviewRevealText } from '../../src/renderer/src/features/review/ReviewRevealText'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function observeReveals() {
  let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
  const targets: Element[] = []
  const created = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; created() }
    observe(target: Element) { targets.push(target) }
    unobserve() {}
    disconnect() {}
  })
  return { created, targets, reveal: (target: Element) => act(() => intersect([{ target, isIntersecting: true }])) }
}

it('waits for disclosure motion before observing and allocating only visible bounded chunks', () => {
  vi.useFakeTimers()
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
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
  act(() => vi.advanceTimersByTime(468))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('waits for every nested gate and cancels a pending release when closed', () => {
  vi.useFakeTimers()
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
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(6)
})

it('unregisters waiting observers on close and ignores late intersections until reopening', () => {
  vi.useFakeTimers()
  const observer = observeReveals()
  const view = (open: boolean) => <div className="chat-scroll"><DisclosureRevealGate open={open}>
    <ReviewRevealText text="waiting" />
  </DisclosureRevealGate></div>
  const { container, rerender } = render(view(true))
  act(() => vi.advanceTimersByTime(200))
  const target = observer.targets[0]
  rerender(view(false))
  observer.reveal(target)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(view(true))
  act(() => vi.advanceTimersByTime(200))
  observer.reveal(observer.targets[1])
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(7)
})

it('does not restart a completed history chunk for updates behind a closed gate', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old'))
  act(() => vi.advanceTimersByTime(200))
  act(() => vi.advanceTimersByTime(468))
  rerender(view(false, 'old updated'))
  act(() => vi.advanceTimersByTime(900))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(view(true, 'old updated'))
  act(() => vi.advanceTimersByTime(199))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(11)
})

it.each([
  ['live', 'old'], ['live', 'replacement\nwith new geometry'],
  ['history', 'old'], ['history', 'replacement\nwith new geometry']
] as const)('projects authoritative %s replacement %j as transparent ordinary text until release', (mode, replacement) => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode={mode} />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old complete chunk'))
  act(() => vi.advanceTimersByTime(200))
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
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect(chunk).not.toHaveStyle({ opacity: '0' })
  expect(container.textContent).toBe(replacement)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent).join('')).toBe(replacement)
  act(() => vi.advanceTimersByTime(900))
  expect(container.textContent).toBe(replacement)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('ends obsolete live fades for authoritative replacements without replacing the chunk root', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old unfinished'))
  act(() => vi.advanceTimersByTime(200))
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
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent).join('')).toBe('latest')
})

it('clears every old chunk immediately for an authoritative empty update behind a closed gate', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old'.repeat(REVIEW_REVEAL_CHUNK_SIZE)))
  act(() => vi.advanceTimersByTime(200))
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
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<DisclosureRevealGate open><ReviewRevealText text="fallback" /></DisclosureRevealGate>)
  act(() => vi.advanceTimersByTime(199))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(8)
})

it('plays all accumulated text on its first release rather than just the last token', () => {
  vi.useFakeTimers()
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
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe('first second third')
})

it('defers live suffixes across closing and reopening without replaying the completed prefix', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const { container, rerender } = render(view(true, 'old'))
  // Commit the released gate first: character deadlines start when React
  // mounts the fade, not while the gate's timer is still inside a batched act.
  act(() => vi.advanceTimersByTime(200))
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
  expect(container.querySelector('.disclosure-reveal-gate > span')).toBe(chunk)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe(' first second')
})

it('retains unfinished live fades while the gate closes and only adds deferred suffixes on release', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = (open: boolean, text: string) => <DisclosureRevealGate open={open}>
    <ReviewRevealText text={text} mode="live" />
  </DisclosureRevealGate>
  const text = 'a'.repeat(120)
  const { container, rerender } = render(view(true, text))
  act(() => vi.advanceTimersByTime(200))
  const original = [...container.querySelectorAll('[data-screen-reveal-character]')]
  act(() => vi.advanceTimersByTime(50))
  rerender(view(false, text + 'bc'))
  act(() => vi.advanceTimersByTime(50))
  rerender(view(true, text + 'bcd'))
  expect([...container.querySelectorAll('[data-screen-reveal-character]')]).toEqual(original)
  act(() => vi.advanceTimersByTime(200))
  const active = [...container.querySelectorAll('[data-screen-reveal-character]')]
  expect(active).toHaveLength(123)
  original.forEach((node, index) => expect(active[index]).toBe(node))
  expect(active.slice(120).map((node) => node.textContent).join('')).toBe('bcd')
  act(() => vi.advanceTimersByTime(900))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('keeps gated reduced-motion text immediately static without observers or character DOM', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const observer = observeReveals()
  const { container } = render(<DisclosureRevealGate open><ReviewRevealText text="static" /></DisclosureRevealGate>)
  expect(container.textContent).toBe('static')
  expect(container.querySelector('.disclosure-reveal-gate > span')).not.toHaveStyle({ opacity: '0' })
  expect(observer.created).not.toHaveBeenCalled()
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('retains character animation and releases character nodes after it finishes', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container, rerender } = render(<ReviewRevealText text="hello" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(5)
  act(() => { vi.advanceTimersByTime(468) })
  expect(container.textContent).toBe('hello')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<ReviewRevealText text="hello" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('allocates characters only for intersecting bounded chunks of a long single line', () => {
  vi.useFakeTimers()
  let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
  const targets: Element[] = []
  const observerCount = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; observerCount() }
    observe(target: Element) { targets.push(target) }
    unobserve() {}
    disconnect() {}
  })
  const text = '长🙂'.repeat(2000)
  const { container } = render(<div className="chat-scroll"><pre><ReviewRevealText text={text} /></pre></div>)
  expect(container.textContent).toBe(text)
  expect(observerCount).toHaveBeenCalledOnce()
  expect(targets.length).toBe(Math.ceil(4000 / REVIEW_REVEAL_CHUNK_SIZE))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  act(() => intersect([{ target: targets[0], isIntersecting: true }]))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
  act(() => vi.advanceTimersByTime(468))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe(text)
})

it('reclaims live spans, animates only new suffixes and keeps completed chunks stable', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const text = 'a'.repeat(REVIEW_REVEAL_CHUNK_SIZE) + 'old'
  const { container, rerender } = render(<pre><ReviewRevealText text={text} mode="live" /></pre>)
  act(() => vi.advanceTimersByTime(300))
  // The old cleanup deadline must not cut off the slower live cascade.
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(text.length)
  act(() => vi.advanceTimersByTime(568))
  const first = container.querySelector('pre > span')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<pre><ReviewRevealText text={text + 'new'} mode="live" /></pre>)
  expect(container.querySelector('pre > span')).toBe(first)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe('new')
  act(() => vi.advanceTimersByTime(868))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe(text + 'new')
})

it('reclaims after the last character animation, not an earlier character', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container } = render(<ReviewRevealText text="abc" mode="live" />)
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
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container, rerender } = render(<ReviewRevealText text="old" mode="live" />)
  act(() => vi.advanceTimersByTime(900))
  rerender(<ReviewRevealText text="old appended" mode="live" />)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe(' appended')
  act(() => vi.advanceTimersByTime(32))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(9)
  act(() => vi.advanceTimersByTime(868))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('preserves concurrent fade groups when a newer short suffix finishes first', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const original = 'a'.repeat(120)
  const { container, rerender } = render(<ReviewRevealText text={original} mode="live" />)
  const before = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
  const delays = before.map((node) => node.style.getPropertyValue('--screen-text-reveal-delay'))
  act(() => vi.advanceTimersByTime(100))
  rerender(<ReviewRevealText text={original + 'bc'} mode="live" />)
  act(() => vi.advanceTimersByTime(100))
  rerender(<ReviewRevealText text={original + 'bcd'} mode="live" />)
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
  expect([...container.querySelectorAll('[data-screen-reveal-character]')].map((node) => node.textContent)).toEqual(['e'])
})

it('does not allocate animation characters when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const { container, rerender } = render(<ReviewRevealText text="first" mode="live" />)
  rerender(<ReviewRevealText text="first appended" mode="live" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe('first appended')
})
