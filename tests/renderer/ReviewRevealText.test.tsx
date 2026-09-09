// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
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
  const first = container.querySelector('pre > span')
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  rerender(<pre><ReviewRevealText text={text + 'new'} mode="live" /></pre>)
  expect(container.querySelector('pre > span')).toBe(first)
  expect([...container.querySelectorAll('.screen-text-reveal-live')].map((node) => node.textContent).join('')).toBe('new')
  act(() => vi.advanceTimersByTime(300))
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe(text + 'new')
})

it('does not allocate animation characters when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const { container, rerender } = render(<ReviewRevealText text="first" mode="live" />)
  rerender(<ReviewRevealText text="first appended" mode="live" />)
  expect(container.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(0)
  expect(container.textContent).toBe('first appended')
})
