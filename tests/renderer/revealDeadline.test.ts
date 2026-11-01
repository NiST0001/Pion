// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeRevealDeadline } from '../../src/renderer/src/utils/revealDeadline'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('shared reveal deadlines', () => {
  it('shares a timer per root and dispatches due callbacks in deadline order', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    const other = document.createElement('div')
    const calls: string[] = []
    const now = performance.now()
    subscribeRevealDeadline(root, now + 100, () => calls.push('later'))
    subscribeRevealDeadline(root, now + 50, () => calls.push('first'))
    subscribeRevealDeadline(root, now + 50, () => calls.push('second'))
    const disposeOther = subscribeRevealDeadline(other, now + 50, () => calls.push('other'))
    expect(vi.getTimerCount()).toBe(2)
    disposeOther()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50)
    expect(calls).toEqual(['first', 'second'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50)
    expect(calls).toEqual(['first', 'second', 'later'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires canceled callbacks, including stale timer invocations and cancellation during dispatch', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    const timer = vi.spyOn(window, 'setTimeout')
    const called = vi.fn()
    const dispose = subscribeRevealDeadline(root, performance.now() + 20, called)
    const stale = timer.mock.calls[0][0] as () => void
    dispose()
    expect(vi.getTimerCount()).toBe(0)
    const newer = vi.fn()
    const cancelNewer = subscribeRevealDeadline(root, performance.now() + 20, newer)
    stale()
    expect(called).not.toHaveBeenCalled()
    expect(newer).not.toHaveBeenCalled()
    cancelNewer()
    let cancelSecond = () => {}
    subscribeRevealDeadline(root, performance.now() + 20, () => cancelSecond())
    cancelSecond = subscribeRevealDeadline(root, performance.now() + 20, called)
    vi.advanceTimersByTime(20)
    expect(called).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks an early timer and schedules a positive delay until the real deadline', () => {
    vi.useFakeTimers()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const called = vi.fn()
    subscribeRevealDeadline(document.createElement('div'), 100.2, called)
    vi.advanceTimersByTime(1)
    expect(called).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    clock.mockReturnValue(100.2)
    vi.advanceTimersByTime(1)
    expect(called).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
