// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnimatedDisclosure } from '../../src/renderer/src/features/common/AnimatedDisclosure'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('mounts on demand, keeps an inert exit shell, then releases expensive details', () => {
  const { container, rerender } = render(<AnimatedDisclosure open={false}><button>detail action</button></AnimatedDisclosure>)
  expect(screen.queryByText('detail action')).not.toBeInTheDocument()
  rerender(<AnimatedDisclosure open><button>detail action</button></AnimatedDisclosure>)
  expect(screen.getByRole('button')).toHaveTextContent('detail action')
  rerender(<AnimatedDisclosure open={false}><button>detail action</button></AnimatedDisclosure>)
  expect(container.querySelector('.animated-disclosure')).toHaveAttribute('data-open', 'false')
  expect(container.querySelector('.animated-disclosure')).toHaveAttribute('inert')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(200))
  expect(screen.queryByText('detail action')).not.toBeInTheDocument()
})

it('reverses a rapid close/open without remounting or a stale close timer', () => {
  const mount = vi.fn(), unmount = vi.fn()
  function Body() { useEffect(() => { mount(); return unmount }, []); return <span>details</span> }
  const { rerender } = render(<AnimatedDisclosure open><Body /></AnimatedDisclosure>)
  const body = screen.getByText('details')
  rerender(<AnimatedDisclosure open={false}><Body /></AnimatedDisclosure>)
  act(() => vi.advanceTimersByTime(80))
  rerender(<AnimatedDisclosure open><Body /></AnimatedDisclosure>)
  act(() => vi.advanceTimersByTime(500))
  expect(screen.getByText('details')).toBe(body)
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).not.toHaveBeenCalled()
})

it('closes immediately when reduced motion is enabled', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  const { rerender } = render(<AnimatedDisclosure open><span>details</span></AnimatedDisclosure>)
  rerender(<AnimatedDisclosure open={false}><span>details</span></AnimatedDisclosure>)
  expect(screen.queryByText('details')).not.toBeInTheDocument()
})
