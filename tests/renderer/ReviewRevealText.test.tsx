// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReviewRevealText } from '../../src/renderer/src/features/review/ReviewRevealText'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

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
