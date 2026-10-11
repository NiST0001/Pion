// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { REVIEW_REVEAL_CHUNK_SIZE, ReviewRevealText } from '../../src/renderer/src/features/review/ReviewRevealText'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('retains character animation and releases character nodes after it finishes', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', undefined)
  const { container, rerender } = render(<ReviewRevealText text="hello" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(5)
  act(() => { vi.advanceTimersByTime(300) })
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
  act(() => vi.advanceTimersByTime(300))
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
  act(() => vi.advanceTimersByTime(232))
  const first = container.querySelector('pre > span')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<pre><ReviewRevealText text={text + 'new'} mode="live" /></pre>)
  expect(container.querySelector('pre > span')).toBe(first)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe('new')
  act(() => vi.advanceTimersByTime(532))
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
  act(() => vi.advanceTimersByTime(500))
  rerender(<ReviewRevealText text="old appended" mode="live" />)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe(' appended')
  act(() => vi.advanceTimersByTime(32))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(9)
  act(() => vi.advanceTimersByTime(500))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
})

it('does not allocate animation characters when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const { container, rerender } = render(<ReviewRevealText text="first" mode="live" />)
  rerender(<ReviewRevealText text="first appended" mode="live" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe('first appended')
})
