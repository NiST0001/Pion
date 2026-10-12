import { describe, expect, it } from 'vitest'
import { createHistoryJumpAnimator } from '../../src/renderer/src/utils/historyJumpAnimator'

function fixture(start = 0, destination = 1000) {
  let top = start, target = destination, valid = true, reduced = false, id = 0, settled = 0
  const frames = new Map<number, FrameRequestCallback>()
  const writes: number[] = []
  const controller = createHistoryJumpAnimator({
    position: () => top, target: () => target, valid: () => valid, reducedMotion: () => reduced,
    requestFrame: (callback) => { frames.set(++id, callback); return id },
    cancelFrame: (frame) => { frames.delete(frame) },
    write: (value) => { writes.push(value); top = value }, settled: () => { settled++ }
  })
  const step = (time: number) => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(time))
  }
  return { controller, frames, writes, step, top: () => top, settled: () => settled,
    target: (value: number) => { target = value }, invalidate: () => { valid = false }, reduce: () => { reduced = true } }
}

describe('history jump animator', () => {
  it.each([[0, 1000], [1000, 0]])('moves naturally in both directions (%s → %s) and closes within 480ms', (start, target) => {
    const f = fixture(start, target)
    f.controller.request()
    f.controller.request()
    expect(f.frames.size).toBe(1)
    f.step(0)
    f.step(100)
    expect(f.top()).toBeGreaterThan(Math.min(start, target))
    expect(f.top()).toBeLessThan(Math.max(start, target))
    for (let time = 120; time <= 480; time += 20) f.step(time)
    expect(f.top()).toBe(target)
    expect(f.frames.size).toBe(0)
    expect(f.settled()).toBe(1)
  })

  it('cancels its single slot and rejects captured late frames even after a new request', () => {
    const f = fixture()
    f.controller.request()
    const late = [...f.frames.values()][0]
    f.step(0)
    f.step(100)
    const interrupted = f.top()
    f.controller.cancel()
    expect(f.frames.size).toBe(0)
    f.target(0)
    f.controller.request()
    late(1000)
    expect(f.top()).toBe(interrupted)
    expect(f.frames.size).toBe(1)
    f.step(200)
    f.step(680)
    expect(f.top()).toBe(0)
  })

  it('remeasures changing real target/maximum range without restarting the deadline', () => {
    const f = fixture()
    f.controller.request()
    f.step(0)
    f.step(100)
    const before = f.top()
    f.target(600)
    f.step(120)
    expect(f.top()).toBeGreaterThan(before)
    expect(f.top()).toBeLessThan(600)
    f.target(500)
    f.step(480)
    expect(f.top()).toBe(500)
    expect(f.frames.size).toBe(0)
  })

  it('does not write after scope/target validity expires', () => {
    const f = fixture()
    f.controller.request()
    f.step(0)
    const count = f.writes.length
    f.invalidate()
    f.step(100)
    expect(f.writes).toHaveLength(count)
    expect(f.frames.size).toBe(0)
  })

  it('reduces motion immediately, including when the preference changes mid-flight', () => {
    const f = fixture()
    f.reduce()
    f.controller.request()
    expect(f.top()).toBe(1000)
    expect(f.frames.size).toBe(0)
    const moving = fixture()
    moving.controller.request()
    moving.step(0)
    moving.reduce()
    moving.step(100)
    expect(moving.top()).toBe(1000)
    expect(moving.frames.size).toBe(0)
  })

  it('does not replay an already aligned destination', () => {
    const f = fixture(1000, 1000)
    f.controller.request()
    expect(f.frames.size).toBe(0)
    expect(f.top()).toBe(1000)
  })
})
