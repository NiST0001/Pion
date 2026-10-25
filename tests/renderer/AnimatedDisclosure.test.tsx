// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnimatedDisclosure } from '../../src/renderer/src/features/common/AnimatedDisclosure'
import { DisclosureRevealGate, useDisclosureRevealReady } from '../../src/renderer/src/features/common/DisclosureRevealGate'
import { DISCLOSURE_REVEAL_READY_EVENT } from '../../src/renderer/src/utils/disclosureScroll'
import type { DisclosureRevealRequest } from '../../src/renderer/src/utils/disclosureScroll'

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

function createStatefulBody() {
  const mount = vi.fn(), unmount = vi.fn()
  function Body() {
    const [value, setValue] = useState('initial')
    useEffect(() => { mount(); return unmount }, [])
    return <input aria-label="retained detail" value={value} onChange={(event) => setValue(event.target.value)} />
  }
  return { Body, mount, unmount }
}

it('retains content only after first opening and preserves its DOM and local state across a long close', () => {
  const { Body, mount, unmount } = createStatefulBody()
  const { container, rerender } = render(<AnimatedDisclosure open={false} retainContent><Body /></AnimatedDisclosure>)
  act(() => vi.advanceTimersByTime(500))
  expect(container.querySelector('.animated-disclosure')).toBeNull()
  expect(screen.queryByLabelText('retained detail')).not.toBeInTheDocument()
  expect(mount).not.toHaveBeenCalled()
  expect(unmount).not.toHaveBeenCalled()

  rerender(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  const body = screen.getByRole('textbox', { name: 'retained detail' })
  const shell = container.querySelector('.animated-disclosure')
  fireEvent.change(body, { target: { value: 'edited locally' } })
  expect(body).toHaveValue('edited locally')
  rerender(<AnimatedDisclosure open={false} retainContent><Body /></AnimatedDisclosure>)
  expect(shell).toHaveAttribute('inert')
  expect(shell).toHaveAttribute('aria-hidden', 'true')
  expect(shell).not.toHaveAttribute('hidden')
  act(() => vi.advanceTimersByTime(199))
  expect(shell).not.toHaveAttribute('hidden')
  act(() => vi.advanceTimersByTime(1))
  expect(shell).toHaveAttribute('hidden')
  expect(shell).toHaveStyle({ display: 'none' })
  act(() => vi.advanceTimersByTime(1000))
  expect(container.querySelector('.animated-disclosure')).toBe(shell)
  expect(screen.getByLabelText('retained detail')).toBe(body)
  expect(body).toHaveValue('edited locally')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).not.toHaveBeenCalled()

  rerender(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  expect(container.querySelector('.animated-disclosure')).toBe(shell)
  expect(screen.getByRole('textbox', { name: 'retained detail' })).toBe(body)
  expect(body).toHaveValue('edited locally')
  expect(shell).not.toHaveAttribute('hidden')
  expect(shell).not.toHaveAttribute('inert')
  expect(shell).toHaveAttribute('aria-hidden', 'false')
  expect(shell).not.toHaveStyle({ display: 'none' })
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).not.toHaveBeenCalled()
})

it('immediately hides retained content with reduced motion without releasing its local state', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  const { Body, mount, unmount } = createStatefulBody()
  const { container, rerender } = render(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  const body = screen.getByRole('textbox', { name: 'retained detail' })
  const shell = container.querySelector('.animated-disclosure')
  fireEvent.change(body, { target: { value: 'reduced motion draft' } })
  rerender(<AnimatedDisclosure open={false} retainContent><Body /></AnimatedDisclosure>)
  expect(container.querySelector('.animated-disclosure')).toBe(shell)
  expect(shell).toHaveAttribute('hidden')
  expect(shell).toHaveAttribute('inert')
  expect(shell).toHaveAttribute('aria-hidden', 'true')
  expect(shell).toHaveStyle({ display: 'none' })
  expect(screen.getByLabelText('retained detail')).toBe(body)
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)

  rerender(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  expect(screen.getByRole('textbox', { name: 'retained detail' })).toBe(body)
  expect(body).toHaveValue('reduced motion draft')
  expect(shell).not.toHaveAttribute('hidden')
  expect(shell).not.toHaveAttribute('inert')
  expect(shell).not.toHaveStyle({ display: 'none' })
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).not.toHaveBeenCalled()
})

it('cancels the retained close timer on rapid reopening so it cannot hide the same body later', () => {
  const { Body, mount, unmount } = createStatefulBody()
  const { container, rerender } = render(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  const body = screen.getByRole('textbox', { name: 'retained detail' })
  const shell = container.querySelector('.animated-disclosure')
  fireEvent.change(body, { target: { value: 'rapid reopen draft' } })
  rerender(<AnimatedDisclosure open={false} retainContent><Body /></AnimatedDisclosure>)
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(80))
  rerender(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  // Only the new opening reveal timer remains; the old close cannot hide the body.
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(500))
  expect(vi.getTimerCount()).toBe(0)
  expect(container.querySelector('.animated-disclosure')).toBe(shell)
  expect(screen.getByRole('textbox', { name: 'retained detail' })).toBe(body)
  expect(body).toHaveValue('rapid reopen draft')
  expect(shell).toHaveAttribute('data-open', 'true')
  expect(shell).not.toHaveAttribute('hidden')
  expect(shell).not.toHaveAttribute('inert')
  expect(shell).not.toHaveStyle({ display: 'none' })
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).not.toHaveBeenCalled()
})

it('clears a pending retained close timer when the disclosure itself unmounts', () => {
  const { Body, mount, unmount } = createStatefulBody()
  const { container, rerender, unmount: unmountDisclosure } = render(<AnimatedDisclosure open retainContent><Body /></AnimatedDisclosure>)
  rerender(<AnimatedDisclosure open={false} retainContent><Body /></AnimatedDisclosure>)
  act(() => vi.advanceTimersByTime(80))
  expect(vi.getTimerCount()).toBe(1)
  expect(unmount).not.toHaveBeenCalled()
  unmountDisclosure()
  expect(vi.getTimerCount()).toBe(0)
  expect(unmount).toHaveBeenCalledTimes(1)
  act(() => vi.advanceTimersByTime(500))
  expect(container).toBeEmptyDOMElement()
  expect(vi.getTimerCount()).toBe(0)
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).toHaveBeenCalledTimes(1)
})

function RevealReadiness({ label = 'reveal readiness' }: { label?: string }) {
  const ready = useDisclosureRevealReady()
  return <span data-testid={label} className="screen-text-reveal-line" data-ready={ready}>reveal text</span>
}

it('defaults to ready outside a gate and waits 200ms inside a disclosure without replacing text DOM', () => {
  const { container, rerender } = render(<RevealReadiness />)
  expect(screen.getByTestId('reveal readiness')).toHaveAttribute('data-ready', 'true')
  rerender(<AnimatedDisclosure open><RevealReadiness /></AnimatedDisclosure>)
  const line = screen.getByTestId('reveal readiness')
  const gate = container.querySelector('.disclosure-reveal-gate')
  expect(gate?.parentElement).toHaveClass('animated-disclosure-inner')
  expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
  expect(line).toHaveAttribute('data-ready', 'false')
  act(() => vi.advanceTimersByTime(199))
  expect(line).toHaveAttribute('data-ready', 'false')
  act(() => vi.advanceTimersByTime(1))
  expect(gate).toHaveAttribute('data-text-reveal-ready', 'true')
  expect(line).toHaveAttribute('data-ready', 'true')
  expect(screen.getByTestId('reveal readiness')).toBe(line)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the reveal barrier after layout until all registered scroll work actually settles', async () => {
  const { container } = render(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  const line = screen.getByTestId('reveal readiness')
  const gate = container.querySelector('.disclosure-reveal-gate')
  let finishScroll!: () => void
  const scroll = new Promise<void>((resolve) => { finishScroll = resolve })
  const request = vi.fn((event: Event) => {
    expect(event.target).toBe(gate)
    const { waitUntil } = (event as CustomEvent<DisclosureRevealRequest>).detail
    waitUntil(scroll)
    waitUntil(Promise.reject(new Error('another follow was cancelled')))
  })
  container.addEventListener(DISCLOSURE_REVEAL_READY_EVENT, request)
  act(() => vi.advanceTimersByTime(199))
  expect(request).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(request).toHaveBeenCalledTimes(1)
  expect(gate).toHaveAttribute('data-text-reveal-open', 'true')
  expect(gate).toHaveAttribute('data-text-reveal-ready', 'false')
  expect(line).toHaveAttribute('data-ready', 'false')
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(1000))
  expect(line).toHaveAttribute('data-ready', 'false')
  await act(async () => { finishScroll() })
  expect(gate).toHaveAttribute('data-text-reveal-ready', 'true')
  expect(line).toHaveAttribute('data-ready', 'true')
  expect(screen.getByTestId('reveal readiness')).toBe(line)
})

it('ignores old scroll completions after closing, reopening or unmounting', async () => {
  const { container, rerender, unmount } = render(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  const completions: Array<() => void> = []
  container.addEventListener(DISCLOSURE_REVEAL_READY_EVENT, (event) => {
    const request = (event as CustomEvent<DisclosureRevealRequest>).detail
    request.waitUntil(new Promise<void>((resolve) => { completions.push(resolve) }))
  })
  const line = screen.getByTestId('reveal readiness')
  act(() => vi.advanceTimersByTime(200))
  rerender(<DisclosureRevealGate open={false}><RevealReadiness /></DisclosureRevealGate>)
  rerender(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  act(() => vi.advanceTimersByTime(200))
  expect(completions).toHaveLength(2)
  await act(async () => { completions[0]() })
  expect(line).toHaveAttribute('data-ready', 'false')
  await act(async () => { completions[1]() })
  expect(line).toHaveAttribute('data-ready', 'true')
  rerender(<DisclosureRevealGate open={false}><RevealReadiness /></DisclosureRevealGate>)
  rerender(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  act(() => vi.advanceTimersByTime(200))
  expect(completions).toHaveLength(3)
  unmount()
  await act(async () => { completions[2]() })
  expect(container).toBeEmptyDOMElement()
  expect(vi.getTimerCount()).toBe(0)
})

it('holds an already settled nested gate until its later opening parent is ready', () => {
  function Nested({ parentOpen }: { parentOpen: boolean }) {
    return <DisclosureRevealGate open={parentOpen}>
      <RevealReadiness label="parent" />
      <DisclosureRevealGate open><RevealReadiness label="child" /></DisclosureRevealGate>
    </DisclosureRevealGate>
  }
  const { rerender } = render(<Nested parentOpen={false} />)
  const child = screen.getByTestId('child')
  act(() => vi.advanceTimersByTime(100))
  rerender(<Nested parentOpen />)
  act(() => vi.advanceTimersByTime(100))
  // Child's own timer is finished, but the parent still has 100ms to go.
  expect(child).toHaveAttribute('data-ready', 'false')
  expect(screen.getByTestId('parent')).toHaveAttribute('data-ready', 'false')
  act(() => vi.advanceTimersByTime(99))
  expect(child).toHaveAttribute('data-ready', 'false')
  act(() => vi.advanceTimersByTime(1))
  expect(child).toHaveAttribute('data-ready', 'true')
  expect(screen.getByTestId('parent')).toHaveAttribute('data-ready', 'true')
  expect(screen.getByTestId('child')).toBe(child)
})

it('opens reduced-motion gates immediately without timers but still obeys closed ancestors', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  function Nested({ open }: { open: boolean }) {
    return <DisclosureRevealGate open={open}>
      <DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>
    </DisclosureRevealGate>
  }
  const { container, rerender } = render(<Nested open />)
  const request = vi.fn()
  container.addEventListener(DISCLOSURE_REVEAL_READY_EVENT, request)
  const line = screen.getByTestId('reveal readiness')
  expect(line).toHaveAttribute('data-ready', 'true')
  expect(vi.getTimerCount()).toBe(0)
  rerender(<Nested open={false} />)
  expect(line).toHaveAttribute('data-ready', 'false')
  rerender(<Nested open />)
  expect(line).toHaveAttribute('data-ready', 'true')
  expect(vi.getTimerCount()).toBe(0)
  expect(request).not.toHaveBeenCalled()
})

it('resets readiness on close and cancels stale opening timers across fast reopening and unmount', () => {
  const { rerender, unmount } = render(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  const line = screen.getByTestId('reveal readiness')
  act(() => vi.advanceTimersByTime(200))
  expect(line).toHaveAttribute('data-ready', 'true')
  rerender(<DisclosureRevealGate open={false}><RevealReadiness /></DisclosureRevealGate>)
  expect(line).toHaveAttribute('data-ready', 'false')
  expect(vi.getTimerCount()).toBe(0)
  rerender(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  act(() => vi.advanceTimersByTime(80))
  rerender(<DisclosureRevealGate open={false}><RevealReadiness /></DisclosureRevealGate>)
  expect(vi.getTimerCount()).toBe(0)
  rerender(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(120))
  // The cancelled opening would finish here; the current opening must still wait.
  expect(line).toHaveAttribute('data-ready', 'false')
  act(() => vi.advanceTimersByTime(80))
  expect(line).toHaveAttribute('data-ready', 'true')
  expect(screen.getByTestId('reveal readiness')).toBe(line)
  rerender(<DisclosureRevealGate open={false}><RevealReadiness /></DisclosureRevealGate>)
  rerender(<DisclosureRevealGate open><RevealReadiness /></DisclosureRevealGate>)
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(500))
  expect(vi.getTimerCount()).toBe(0)
})
